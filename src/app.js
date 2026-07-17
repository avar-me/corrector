/**
 * corrector.avar.me — Аварский корректор
 * Client-side spellcheck using lemma frequency dictionary.
 */

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  DEBOUNCE_MS:      250,
  MAX_SUGGESTIONS:  10,
  DIST2_PENALTY:    50,   // dist=2 candidates weighted at 1/50 vs dist=1
  MIN_INPUT_LEN:    2,
  AUTO_CORRECT_THRESHOLD: 0.60,  // confidence to auto-correct in text mode
};

// ============================================================================
// STATE
// ============================================================================

const state = {
  dict:        null,   // word -> frequency (Object)
  corrections: null,   // normalization rules
  alphabet:    null,   // Set of chars found in dict
  ready:       false,
};

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadData() {
  const [dictRes, corrRes] = await Promise.all([
    fetch('dictionary.json'),
    fetch('corrections.json'),
  ]);
  state.dict = await dictRes.json();
  state.corrections = await corrRes.json();

  const chars = new Set();
  for (const word of Object.keys(state.dict)) {
    for (const ch of word) chars.add(ch);
  }
  state.alphabet = chars;
  state.ready = true;
}

// ============================================================================
// NORMALIZATION
// ============================================================================

function applyRules(text, rules) {
  let out = text;
  for (const rule of rules) {
    out = out.split(rule.pattern).join(rule.replacement);
  }
  return out;
}

function normalizeWord(word) {
  // Правила сначала, lowercase потом: палочка в правилах записана заглавной
  // латинской I (U+0049), а toLowerCase превратил бы её в i и сломал совпадение.
  return applyRules(word, state.corrections.normalize || []).toLowerCase();
}

function applyOCR(text) {
  return applyRules(text, state.corrections.ocr || []);
}

// Обязательные замены — применяются всегда (не только в OCR-режиме) и,
// в отличие от normalize, считаются исправлением и показываются пользователю.
function applyMandatory(word) {
  let out = applyRules(word, state.corrections.letters || []);

  const wordRule = (state.corrections.words || []).find(r => r.pattern === out);
  if (wordRule) out = wordRule.replacement;

  return out;
}

// ============================================================================
// SPELL CHECKER — candidate generation
// ============================================================================

function edits1(word) {
  const result = new Set();
  const chars  = state.alphabet;
  const n = word.length;

  for (let i = 0; i < n; i++)
    result.add(word.slice(0, i) + word.slice(i + 1));           // delete

  for (let i = 0; i < n - 1; i++)
    result.add(word.slice(0, i) + word[i+1] + word[i] + word.slice(i+2)); // transpose

  for (let i = 0; i < n; i++)
    for (const c of chars)
      if (c !== word[i])
        result.add(word.slice(0, i) + c + word.slice(i + 1));   // replace

  for (let i = 0; i <= n; i++)
    for (const c of chars)
      result.add(word.slice(0, i) + c + word.slice(i));         // insert

  return result;
}

function candidateScore(freq, dist) {
  return freq / Math.pow(CONFIG.DIST2_PENALTY, dist - 1);
}

/**
 * Returns { found, word, freq } or { found: false, suggestions: [...] }
 */
function checkWord(raw) {
  if (!state.ready) return null;

  const beforeMandatory = normalizeWord(raw);
  const normalized = applyMandatory(beforeMandatory);
  const forcedFrom = normalized !== beforeMandatory ? beforeMandatory : null;

  if (state.dict[normalized] !== undefined) {
    return { found: true, word: normalized, freq: state.dict[normalized], forcedFrom };
  }

  // Gather candidates
  const cands = new Map(); // word -> {freq, dist}

  for (const e of edits1(normalized)) {
    if (state.dict[e] !== undefined && !cands.has(e)) {
      cands.set(e, { freq: state.dict[e], dist: 1 });
    }
  }

  // dist=2 only when no dist=1 candidates (or too few)
  if (cands.size < 3) {
    for (const e1 of edits1(normalized)) {
      for (const e2 of edits1(e1)) {
        if (state.dict[e2] !== undefined && !cands.has(e2)) {
          cands.set(e2, { freq: state.dict[e2], dist: 2 });
        }
      }
    }
  }

  if (cands.size === 0) {
    return { found: false, suggestions: [] };
  }

  // Score and sort
  let totalScore = 0;
  const scored = [];

  for (const [word, { freq, dist }] of cands) {
    const s = candidateScore(freq, dist);
    scored.push({ word, freq, dist, score: s });
    totalScore += s;
  }

  scored.sort((a, b) => b.score - a.score);

  const suggestions = scored.slice(0, CONFIG.MAX_SUGGESTIONS).map(s => ({
    word:  s.word,
    freq:  s.freq,
    dist:  s.dist,
    prob:  s.score / totalScore,
  }));

  return { found: false, suggestions };
}

// ============================================================================
// TEXT CORRECTION
// ============================================================================

const TOKEN_RE = /([^\p{L}\p{M}'-]+)/u;  // split on non-word chars

function correctText(text, useOCR) {
  const input = useOCR ? applyOCR(text) : text;
  const tokens = input.split(TOKEN_RE);
  const changes = [];
  const parts   = [];

  for (const token of tokens) {
    // Separator token
    if (TOKEN_RE.test(token) && token.length > 0) {
      parts.push({ type: 'sep', text: token });
      continue;
    }
    if (!token) continue;

    const res = checkWord(token);
    if (!res) { parts.push({ type: 'word', text: token }); continue; }

    if (res.found) {
      if (res.forcedFrom) {
        // Обязательная замена буквы/слова (например пӏ → б, дий → дие):
        // показываем как исправление, в отличие от тихой палочка-нормализации.
        changes.push({ from: token, to: res.word, type: 'forced' });
        parts.push({ type: 'changed', original: token, corrected: res.word, forced: true });
        continue;
      }
      const normalized = normalizeWord(token);
      // Палочка-нормализация (I/1/l → ӏ) применяется молча: правим в выводе,
      // но не считаем ошибкой и не показываем как исправление.
      parts.push({ type: 'word', text: normalized !== token.toLowerCase() ? normalized : token });
      continue;
    }

    if (res.suggestions.length > 0 && res.suggestions[0].prob >= CONFIG.AUTO_CORRECT_THRESHOLD) {
      const best = res.suggestions[0];
      changes.push({ from: token, to: best.word, prob: best.prob, dist: best.dist, type: 'spell' });
      parts.push({ type: 'changed', original: token, corrected: best.word, prob: best.prob, dist: best.dist });
    } else {
      parts.push({ type: 'unknown', text: token, suggestions: res.suggestions.slice(0, 2) });
    }
  }

  return { parts, changes };
}

// ============================================================================
// UI — WORD TAB
// ============================================================================

function renderWordResult(raw, res) {
  const el = document.getElementById('wordResult');
  if (!res) { el.innerHTML = ''; return; }

  if (res.found) {
    const forcedNote = res.forcedFrom
      ? `<span class="status-forced">обязательная замена: ${esc(res.forcedFrom)} → ${esc(res.word)}</span>`
      : '';
    el.innerHTML = `
      <div class="word-status found">
        <span class="status-icon">✓</span>
        <span class="status-word">${esc(res.word)}</span>
        <span class="status-freq">freq ${res.freq.toLocaleString()}</span>
        ${forcedNote}
      </div>`;
    return;
  }

  const header = `
    <div class="word-status not-found">
      <span class="status-icon">✗</span>
      <span>'${esc(raw)}' не найдено</span>
    </div>`;

  if (res.suggestions.length === 0) {
    el.innerHTML = header + `<div class="word-status" style="color:var(--text-muted)">Нет вариантов</div>`;
    return;
  }

  const rows = res.suggestions.map(s => {
    const pct = (s.prob * 100).toFixed(1);
    const barW = Math.round(s.prob * 100);
    return `
      <div class="suggestion-row">
        <div class="sug-prob">
          <div class="prob-bar-wrap">
            <div class="prob-bar-bg"><div class="prob-bar-fill" style="width:${barW}%"></div></div>
          </div>
          <div style="text-align:right;margin-top:2px">${pct}%</div>
        </div>
        <span class="sug-word">${esc(s.word)}</span>
        <span class="sug-dist">dist=${s.dist}</span>
        <span class="sug-freq">freq ${s.freq.toLocaleString()}</span>
      </div>`;
  }).join('');

  el.innerHTML = header + `
    <div class="suggestions-card">
      <div class="suggestions-title">Варианты</div>
      ${rows}
    </div>`;
}

// ============================================================================
// UI — TEXT TAB
// ============================================================================

function renderTextResult(result) {
  const el = document.getElementById('textResult');

  // Build annotated text
  const textParts = result.parts.map(p => {
    if (p.type === 'changed') {
      const title = p.forced
        ? `${esc(p.original)} → ${esc(p.corrected)} (обязательная замена)`
        : `${esc(p.original)} → ${esc(p.corrected)} (${(p.prob * 100).toFixed(0)}%, dist=${p.dist})`;
      return `<mark class="changed" title="${title}">${esc(p.corrected)}</mark>`;
    }
    if (p.type === 'sep')     return esc(p.text).replace(/\n/g, '<br>');
    if (p.type === 'unknown') return `<mark class="unknown" title="Нет в словаре, замена не найдена">${esc(p.text)}</mark>`;
    return esc(p.text);
  }).join('');

  const unknownCount = result.parts.filter(p => p.type === 'unknown').length;

  // Plain corrected text (for copy)
  const plainText = result.parts.map(p =>
    p.type === 'changed' ? p.corrected :
    p.type === 'sep'     ? p.text :
    p.text || ''
  ).join('');

  let changesHtml = '';
  if (result.changes.length > 0) {
    const rows = result.changes.map(c => `
      <div class="change-row">
        <span class="change-from">${esc(c.from)}</span>
        <span class="change-arrow">→</span>
        <span class="change-to">${esc(c.to)}</span>
        ${c.type === 'forced'
          ? '<span class="change-meta forced-badge">обязательная замена</span>'
          : `<span class="change-meta">${(c.prob * 100).toFixed(0)}%</span><span class="change-meta">dist=${c.dist}</span>`}
      </div>`).join('');
    changesHtml += `
      <div class="changes-card">
        <div class="changes-title">Исправления (${result.changes.length})</div>
        ${rows}
      </div>`;
  }

  if (unknownCount > 0) {
    const unknownRows = result.parts.filter(p => p.type === 'unknown').map(p => {
      const variants = p.suggestions.length > 0
        ? p.suggestions.map(s =>
            `<span class="variant-word">${esc(s.word)}</span><span class="change-meta">${(s.prob * 100).toFixed(0)}%</span>`
          ).join('<span class="change-arrow">/</span>')
        : '<span class="no-variants">нет вариантов</span>';
      return `
        <div class="change-row unknown-row">
          <span class="change-from">${esc(p.text)}</span>
          <span class="change-arrow">→</span>
          <span class="unknown-variants">${variants}</span>
        </div>`;
    }).join('');
    changesHtml += `
      <div class="changes-card">
        <div class="changes-title"><span class="unknown-dot">⚠</span> Не найдено в словаре (${unknownCount})</div>
        ${unknownRows}
      </div>`;
  }

  if (!changesHtml) {
    changesHtml = `
      <div class="changes-card">
        <div class="no-changes">✓ Исправлений нет</div>
      </div>`;
  }

  el.innerHTML = `
    <div class="text-result-card">
      <div class="text-result-header">
        <span class="text-result-label">Результат</span>
        <button class="copy-btn" onclick="copyText(${JSON.stringify(plainText)})">Копировать</button>
      </div>
      <div class="text-result-body">${textParts}</div>
    </div>
    ${changesHtml}`;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('.copy-btn');
    if (btn) { btn.textContent = 'Скопировано!'; setTimeout(() => btn.textContent = 'Копировать', 1500); }
  });
}
window.copyText = copyText;

// ============================================================================
// UTILITIES
// ============================================================================

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ============================================================================
// BOOT
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  const loadingEl = document.getElementById('loading');
  const tabsEl    = document.getElementById('tabs');
  const wordPanel = document.getElementById('panel-word');
  const textPanel = document.getElementById('panel-text');

  // Load data
  loadData().then(() => {
    loadingEl.style.display = 'none';
    tabsEl.style.display    = 'flex';
    wordPanel.style.display = 'block';

    initWordTab();
    initTextTab();
    initTabs();
  }).catch(err => {
    loadingEl.innerHTML = `<div class="error-msg">Ошибка загрузки: ${esc(err.message)}</div>`;
  });
});

function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.getElementById('panel-word').style.display = tab === 'word' ? 'block' : 'none';
      document.getElementById('panel-text').style.display = tab === 'text' ? 'block' : 'none';
    });
  });
}

function initWordTab() {
  const input    = document.getElementById('wordInput');
  const clearBtn = document.getElementById('wordClear');

  const check = debounce((val) => {
    const v = val.trim();
    if (v.length < CONFIG.MIN_INPUT_LEN) {
      document.getElementById('wordResult').innerHTML = '';
      return;
    }
    renderWordResult(v, checkWord(v));
  }, CONFIG.DEBOUNCE_MS);

  input.addEventListener('input', () => {
    clearBtn.classList.toggle('visible', input.value.length > 0);
    check(input.value);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.remove('visible');
    document.getElementById('wordResult').innerHTML = '';
    input.focus();
  });
}

function initTextTab() {
  const btn = document.getElementById('textCheck');
  btn.addEventListener('click', () => {
    const text = document.getElementById('textInput').value.trim();
    if (!text) return;
    const useOCR = document.getElementById('ocrMode').checked;
    renderTextResult(correctText(text, useOCR));
  });

  document.getElementById('textInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      btn.click();
    }
  });
}
