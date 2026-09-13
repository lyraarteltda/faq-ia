/**
 * FAQ IA — Main Application Logic
 *
 * Fluxo: o membro descreve o produto/serviço → a IA (BYOK) escreve as perguntas
 * frequentes num JSON estrito agrupado por categoria → o app monta uma FAQ real
 * (drawer/accordion com busca + categorias) e gera o artefato publicável:
 *   1. Widget HTML self-contained (accordion acessível, fontes de sistema,
 *      cor de marca configurável) pronto para colar em qualquer site.
 *   2. Bloco schema.org FAQPage JSON-LD (elegível a rich results do Google).
 *
 * BYOK: toda geração roda na chave do próprio usuário (OpenRouter/OpenAI),
 * salva apenas no navegador. NENHUMA chave de empresa. Sem Supabase no browser.
 */

const App = (function () {
  // ---- estado ----
  const state = {
    faqs: [],          // [{ category, question, answer }]
    activeCat: '*',    // '*' = todas
    search: '',
    meta: null         // { topic, tone, lang, model, count }
  };

  // ---- helpers ----
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'faq';
  }

  // ================= geração via IA (BYOK) =================
  function buildPrompt(topic, context, count, tone, lang) {
    const langName = { 'pt-BR': 'português do Brasil', 'en': 'inglês', 'es': 'espanhol' }[lang] || 'português do Brasil';
    const sys = 'Você é um redator especialista em criar seções de Perguntas Frequentes (FAQ) claras, ' +
      'úteis e prontas para publicar em sites e páginas de vendas. Você responde SEMPRE com JSON válido, ' +
      'sem markdown, sem comentários, sem texto fora do JSON.';
    let user = 'Gere uma FAQ para o seguinte contexto.\n\n' +
      'PRODUTO/SERVIÇO/TEMA: ' + topic + '\n';
    if (context && context.trim()) user += 'CONTEXTO ADICIONAL:\n' + context.trim() + '\n';
    user += '\nREGRAS:\n' +
      '- Escreva em ' + langName + '.\n' +
      '- Gere EXATAMENTE ' + count + ' perguntas frequentes reais que um cliente faria antes de comprar/usar.\n' +
      '- Tom das respostas: ' + tone + '.\n' +
      '- Agrupe as perguntas em 2 a 5 categorias temáticas coerentes (ex.: "Preço e pagamento", ' +
      '"Como funciona", "Garantia e reembolso", "Acesso e suporte"). Cada pergunta pertence a UMA categoria.\n' +
      '- Perguntas curtas e diretas; respostas de 1 a 3 frases, específicas e sem enrolação.\n' +
      '- Não invente fatos que contrariem o contexto; quando faltar dado, responda de forma útil e genérica.\n\n' +
      'FORMATO DE SAÍDA (JSON estrito, nada além disso):\n' +
      '{"faqs":[{"category":"<categoria>","question":"<pergunta>","answer":"<resposta>"}]}';
    return { sys: sys, user: user };
  }

  function extractJSON(text) {
    if (!text) throw new Error('resposta vazia');
    let t = String(text).trim();
    // remove cercas de código se houver
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('sem JSON na resposta');
    return JSON.parse(t.slice(first, last + 1));
  }

  async function callAI(active, model, prompt) {
    let endpoint, body, headers;
    headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + active.key };

    if (active.service === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'FAQ IA - Maestros da IA';
      body = { model: model, temperature: 0.55, messages: [
        { role: 'system', content: prompt.sys }, { role: 'user', content: prompt.user } ] };
    } else { // openai nativo
      endpoint = 'https://api.openai.com/v1/chat/completions';
      const oaModel = model.indexOf('openai/') === 0 ? model.slice(7) : 'gpt-4o';
      body = { model: oaModel, temperature: 0.55, messages: [
        { role: 'system', content: prompt.sys }, { role: 'user', content: prompt.user } ] };
    }

    const res = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
      if (res.status === 401) throw new Error('Chave de API inválida ou sem permissão. Verifique sua chave.');
      if (res.status === 402) throw new Error('Sua conta não tem créditos suficientes para este modelo.');
      if (res.status === 429) throw new Error('Limite de requisições atingido no provedor. Aguarde um instante.');
      throw new Error(detail || ('Erro do provedor (HTTP ' + res.status + ').'));
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    return content || '';
  }

  function validateFaqs(parsed) {
    if (!parsed || !Array.isArray(parsed.faqs)) throw new Error('formato inesperado');
    const out = [];
    parsed.faqs.forEach(function (f) {
      if (!f) return;
      const q = (f.question || f.q || '').toString().trim();
      const a = (f.answer || f.a || '').toString().trim();
      const c = (f.category || f.categoria || 'Geral').toString().trim() || 'Geral';
      if (q && a) out.push({ category: c, question: q, answer: a });
    });
    if (!out.length) throw new Error('a IA não retornou perguntas válidas');
    return out;
  }

  async function generate() {
    const topic = ($('in-topic').value || '').trim();
    if (!topic) { toast('Descreva o produto, serviço ou tema.'); $('in-topic').focus(); return; }

    const active = window.ApiKeyManager.getActiveKey();
    if (!active) {
      toast('Configure sua chave de API para gerar.');
      if (window.MembershipGate) MembershipGate.showScreen('key-screen');
      return;
    }

    const context = ($('in-context').value || '').trim();
    const count = parseInt(document.querySelector('#count-chips .chip.on').dataset.count, 10) || 8;
    const tone = document.querySelector('#tone-chips .chip.on').dataset.tone || 'Profissional e claro';
    const lang = $('in-lang').value || 'pt-BR';
    const model = window.ApiKeyManager.getModel();

    setLoading(true);
    const btn = $('gen-btn');
    btn.disabled = true;

    try {
      const prompt = buildPrompt(topic, context, count, tone, lang);
      const run = function () { return callAI(active, model, prompt); };
      const raw = window.RateLimiter && window.RateLimiter.executeWithLimit
        ? await window.RateLimiter.executeWithLimit('generate-faq', run)
        : await run();
      const faqs = validateFaqs(extractJSON(raw));
      state.faqs = faqs;
      state.activeCat = '*';
      state.search = '';
      state.meta = { topic: topic, tone: tone, lang: lang, model: model, count: faqs.length };
      $('faq-search').value = '';
      renderAll();
      toast('FAQ gerada: ' + faqs.length + ' perguntas.');
    } catch (err) {
      console.error(err);
      renderError(err.message || 'Não foi possível gerar a FAQ.');
    } finally {
      setLoading(false);
      btn.disabled = false;
    }
  }

  // ================= render (chrome: card catalog) =================
  function setLoading(on) {
    const drawer = $('drawer');
    if (!on) return;
    drawer.innerHTML = '<div class="loading"><div class="spinner"></div>' +
      '<p>Escrevendo suas perguntas na sua própria chave…</p></div>';
  }

  function renderError(msg) {
    $('drawer').innerHTML = '<div class="empty-state"><h3>Não deu certo</h3><p>' + esc(msg) + '</p></div>';
  }

  function categories() {
    const seen = [];
    state.faqs.forEach(function (f) { if (seen.indexOf(f.category) === -1) seen.push(f.category); });
    return seen;
  }

  function filtered() {
    const s = state.search.trim().toLowerCase();
    return state.faqs.filter(function (f) {
      if (state.activeCat !== '*' && f.category !== state.activeCat) return false;
      if (!s) return true;
      return (f.question + ' ' + f.answer).toLowerCase().indexOf(s) !== -1;
    });
  }

  function renderAll() {
    renderDrawer();
    renderMeta();
    renderExports();
    // habilita toolbar
    ['faq-search', 'btn-expand', 'btn-copy', 'btn-html', 'btn-schema'].forEach(function (id) {
      const el = $(id); if (el) el.disabled = false;
    });
    $('out-section').hidden = false;
    $('meta-strip').hidden = false;
  }

  function renderDrawer() {
    const drawer = $('drawer');
    if (!state.faqs.length) { drawer.innerHTML = ''; return; }
    const cats = categories();

    let html = '<div class="cat-tabs" role="tablist">';
    html += '<button class="cat-tab' + (state.activeCat === '*' ? ' on' : '') + '" data-cat="*">Todas (' + state.faqs.length + ')</button>';
    cats.forEach(function (c) {
      const n = state.faqs.filter(function (f) { return f.category === c; }).length;
      html += '<button class="cat-tab' + (state.activeCat === c ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + ' (' + n + ')</button>';
    });
    html += '</div>';

    const items = filtered();
    if (!items.length) {
      html += '<div class="empty-state"><h3>Nada encontrado</h3><p>Nenhuma pergunta corresponde à busca nesta categoria.</p></div>';
      drawer.innerHTML = html;
      wireDrawer();
      return;
    }

    html += '<div class="cards">';
    items.forEach(function (f) {
      const idx = state.faqs.indexOf(f);
      const num = 'FAQ-' + String(idx + 1).padStart(2, '0');
      html += '<div class="card-faq" data-idx="' + idx + '">' +
        '<button class="card-q" aria-expanded="false">' +
        '<span class="card-num">' + num + '</span>' +
        '<span class="card-q-text">' + esc(f.question) + '</span>' +
        '<svg class="card-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
        '</button>' +
        '<div class="card-a" hidden><p>' + esc(f.answer) + '</p></div>' +
        '</div>';
    });
    html += '</div>';
    drawer.innerHTML = html;
    wireDrawer();
  }

  function wireDrawer() {
    const drawer = $('drawer');
    drawer.querySelectorAll('.cat-tab').forEach(function (t) {
      t.addEventListener('click', function () { state.activeCat = t.dataset.cat; renderDrawer(); });
    });
    drawer.querySelectorAll('.card-q').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const card = btn.closest('.card-faq');
        const ans = card.querySelector('.card-a');
        const open = card.classList.toggle('open');
        ans.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
  }

  function renderMeta() {
    const m = state.meta; if (!m) return;
    const modelName = m.model.split('/').pop();
    $('meta-strip').innerHTML =
      '<span><b>' + state.faqs.length + '</b> perguntas</span>' +
      '<span><b>' + categories().length + '</b> categorias</span>' +
      '<span>Tom: <b>' + esc(m.tone) + '</b></span>' +
      '<span>Modelo: <b>' + esc(modelName) + '</b></span>';
  }

  // ================= artefatos publicáveis =================
  function buildJsonLd() {
    const obj = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: state.faqs.map(function (f) {
        return {
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer }
        };
      })
    };
    return JSON.stringify(obj, null, 2);
  }

  // Widget HTML self-contained: accordion acessível (<details>), fontes de sistema,
  // cor de marca via --faq-accent, + o bloco JSON-LD embutido para SEO.
  function buildWidgetHtml() {
    const title = state.meta ? state.meta.topic : 'Perguntas frequentes';
    const cats = categories();
    let body = '';
    cats.forEach(function (c) {
      body += '    <h3 class="faq-cat">' + esc(c) + '</h3>\n';
      state.faqs.filter(function (f) { return f.category === c; }).forEach(function (f) {
        body += '    <details class="faq-item">\n' +
          '      <summary>' + esc(f.question) + '</summary>\n' +
          '      <div class="faq-answer"><p>' + esc(f.answer) + '</p></div>\n' +
          '    </details>\n';
      });
    });

    const jsonld = buildJsonLd();

    return '<!-- FAQ gerada por FAQ IA — Maestros da IA · https://faqia.maestrosdaia.com -->\n' +
      '<!-- Cole este bloco onde quiser exibir a FAQ. Troque a cor da marca em --faq-accent. -->\n' +
      '<section class="faq-ia-widget" aria-label="Perguntas frequentes">\n' +
      '  <style>\n' +
      '    .faq-ia-widget{--faq-accent:#157a6e;--faq-ink:#1a1a1a;--faq-muted:#666;--faq-line:#e5e5e5;--faq-bg:#fff;\n' +
      '      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;\n' +
      '      color:var(--faq-ink);max-width:760px;margin:0 auto;line-height:1.6;}\n' +
      '    .faq-ia-widget .faq-cat{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;\n' +
      '      color:var(--faq-accent);margin:1.6em 0 .5em;font-weight:700;}\n' +
      '    .faq-ia-widget .faq-item{border:1px solid var(--faq-line);border-radius:10px;margin:.5em 0;\n' +
      '      background:var(--faq-bg);overflow:hidden;}\n' +
      '    .faq-ia-widget .faq-item[open]{border-color:var(--faq-accent);}\n' +
      '    .faq-ia-widget summary{cursor:pointer;list-style:none;padding:1em 1.1em;font-weight:600;\n' +
      '      display:flex;justify-content:space-between;gap:1em;align-items:center;}\n' +
      '    .faq-ia-widget summary::-webkit-details-marker{display:none;}\n' +
      '    .faq-ia-widget summary::after{content:"+";color:var(--faq-accent);font-size:1.3em;font-weight:400;\n' +
      '      transition:transform .2s;flex:none;}\n' +
      '    .faq-ia-widget .faq-item[open] summary::after{transform:rotate(45deg);}\n' +
      '    .faq-ia-widget .faq-answer{padding:0 1.1em 1.1em;color:var(--faq-muted);}\n' +
      '    .faq-ia-widget .faq-answer p{margin:0;}\n' +
      '  </style>\n' +
      body +
      '  <script type="application/ld+json">\n' + jsonld + '\n  </' + 'script>\n' +
      '</section>\n';
  }

  let currentOut = 'jsonld';
  function renderExports() {
    const box = $('codebox');
    box.textContent = currentOut === 'jsonld' ? buildJsonLd() : buildWidgetHtml();
  }

  // ================= downloads / cópia =================
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiado para a área de transferência.');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copiado.'); } catch (e2) { toast('Não foi possível copiar.'); }
      document.body.removeChild(ta);
    }
  }

  // ================= wiring =================
  function wireStatic() {
    // chips single-select
    document.querySelectorAll('#count-chips .chip, #tone-chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        const row = chip.parentElement;
        row.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
        chip.classList.add('on');
      });
    });

    $('gen-btn').addEventListener('click', generate);

    $('faq-search').addEventListener('input', function () {
      state.search = this.value || '';
      renderDrawer();
    });

    $('btn-expand').addEventListener('click', function () {
      const cards = $('drawer').querySelectorAll('.card-faq');
      const anyClosed = Array.prototype.some.call(cards, function (c) { return !c.classList.contains('open'); });
      cards.forEach(function (c) {
        const ans = c.querySelector('.card-a'); const btn = c.querySelector('.card-q');
        if (anyClosed) { c.classList.add('open'); ans.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
        else { c.classList.remove('open'); ans.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
      });
      this.textContent = anyClosed ? 'Recolher tudo' : 'Expandir tudo';
    });

    $('btn-copy').addEventListener('click', function () { copyText(buildWidgetHtml()); });
    $('btn-html').addEventListener('click', function () {
      download('faq-' + slug(state.meta && state.meta.topic) + '.html', buildWidgetHtml(), 'text/html;charset=utf-8');
    });
    $('btn-schema').addEventListener('click', function () {
      download('faq-schema-' + slug(state.meta && state.meta.topic) + '.json', buildJsonLd(), 'application/ld+json;charset=utf-8');
    });

    // out tabs
    document.querySelectorAll('.out-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.out-tab').forEach(function (t) { t.classList.remove('on'); });
        tab.classList.add('on');
        currentOut = tab.dataset.out;
        renderExports();
      });
    });
  }

  function init() {
    console.log('FAQ IA initialized');
    const session = MembershipGate.getSession();
    if (session) {
      const nameEl = $('user-name');
      if (nameEl) nameEl.textContent = session.name || 'Maestro';
    }
    // popula o seletor de modelo no rail (agrupado por provedor — Hard Rule #19)
    if (window.ApiKeyManager && window.ApiKeyManager.renderModelPicker) {
      window.ApiKeyManager.renderModelPicker('model-select');
    }
    wireStatic();
  }

  return { init: init };
})();

(function () {
  var _appInitialized = false;
  function tryAppInit() {
    if (_appInitialized) return;
    var session = MembershipGate.getSession();
    if (session) { _appInitialized = true; App.init(); }
  }
  document.addEventListener('maestria:app-ready', tryAppInit);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(tryAppInit, 150); });
})();
