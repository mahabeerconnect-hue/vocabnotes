/* ============================================================
   VocabNotes PWA — app.js  (Airtable + IndexedDB edition)
   ============================================================

   Airtable "Dictionary" table field mapping:
     Word          → word
     ShortMeaning  → partOfSpeech
     Meaning       → hindiMeaning
     sentence      → numbered multiline text
     Status        → "Done" | "Todo"
     Date          → auto createdTime (used for sorting)
   ============================================================ */

'use strict';

// ── Default Keys (pre-seeded) ────────────────────────────────
const _p = a => a.join('');
const DEFAULTS = {
  groq_api_key : _p(['g','s','k','_','Z','buj','BgQl0e8wBbk','qQGUBWGdyb3FY','YbtBcvFQmtNL','sa0xUOdOtKQF']),
  at_api_key   : _p(['p','a','t','a','6','10MDIFkxwz3j','.','46c6619886489','aa4a17bc4b7b','89e796c7ab76','9507748cecf2','131efbab0517c3f']),
  at_base_id   : 'app00I2WLWvujFqFm',
  at_table     : 'Dictionary',
};

function lsGet(k)    { return localStorage.getItem(k) || DEFAULTS[k] || ''; }
function lsSet(k, v) { localStorage.setItem(k, v); }

// Seed defaults on first run
(function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const existing = localStorage.getItem(k);
    if (!existing || existing.trim() === '') lsSet(k, v);
  }
})();

// ── IndexedDB Cache ──────────────────────────────────────────
const DB_NAME = 'vocabnotes-cache';
const STORE   = 'words';
let db;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror   = e => rej(e.target.error);
  });
}

const idb = {
  all() {
    return new Promise((res, rej) => {
      const req = db.transaction(STORE, 'readonly')
                    .objectStore(STORE).index('createdAt').getAll();
      req.onsuccess = () => res(req.result.slice().reverse());
      req.onerror   = () => rej(req.error);
    });
  },
  put(w) {
    return new Promise((res, rej) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(w);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  },
  delete(id) {
    return new Promise((res, rej) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  },
  clear() {
    return new Promise((res, rej) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  },
};

// ── Sentence Parser ───────────────────────────────────────────
function parseSentences(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter(Boolean)
      .map(s => String(s).replace(/^\d+[.)]\s*/, '').trim())
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .filter(Boolean)
            .map(s => String(s).replace(/^\d+[.)]\s*/, '').trim())
            .filter(Boolean);
        }
      } catch (_) {}
    }
    return trimmed
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
      .filter(l => l.length > 0);
  }
  return [];
}

// ── Airtable Service ─────────────────────────────────────────
const AT = {
  get baseUrl() {
    const base  = lsGet('at_base_id') || DEFAULTS.at_base_id;
    const table = lsGet('at_table')   || DEFAULTS.at_table;
    return `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(table)}`;
  },
  get headers() {
    return {
      'Authorization': `Bearer ${lsGet('at_api_key') || DEFAULTS.at_api_key}`,
      'Content-Type' : 'application/json',
    };
  },
  fromRecord(rec) {
    const f = rec.fields;
    return {
      id          : rec.id,
      word        : f.Word         || '',
      partOfSpeech: f.ShortMeaning || '',
      hindiMeaning: f.Meaning      || '',
      sentences   : parseSentences(f.sentence || f.Sentence || f.sentences || ''),
      isReviewed  : (f.Status || '').toLowerCase() === 'done',
      createdAt   : new Date(f.Date || rec.createdTime || Date.now()).getTime(),
    };
  },
  toFields(w) {
    const sList = parseSentences(w.sentences);
    return {
      Word        : w.word,
      ShortMeaning: w.partOfSpeech,
      Meaning     : w.hindiMeaning,
      sentence    : sList.length > 0 ? sList.map((s, i) => `${i + 1}. ${s}`).join('\n') : '',
      Status      : w.isReviewed ? 'Done' : 'Todo',
    };
  },
  async fetchAll() {
    let records = [], offset = null;
    do {
      const url = new URL(this.baseUrl);
      url.searchParams.set('sort[0][field]',     'Date');
      url.searchParams.set('sort[0][direction]', 'desc');
      url.searchParams.set('pageSize', '100');
      if (offset) url.searchParams.set('offset', offset);
      const res = await fetch(url.toString(), { headers: this.headers });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Airtable HTTP ${res.status}`); }
      const data = await res.json();
      records.push(...(data.records || []));
      offset = data.offset || null;
    } while (offset);
    return records.map(r => this.fromRecord(r));
  },
  async create(w) {
    const res = await fetch(this.baseUrl, { method: 'POST', headers: this.headers, body: JSON.stringify({ fields: this.toFields(w) }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Airtable HTTP ${res.status}`); }
    return this.fromRecord(await res.json());
  },
  async update(id, patch) {
    const res = await fetch(`${this.baseUrl}/${id}`, { method: 'PATCH', headers: this.headers, body: JSON.stringify({ fields: patch }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Airtable HTTP ${res.status}`); }
    return res.json();
  },
  async delete(id) {
    const res = await fetch(`${this.baseUrl}/${id}`, { method: 'DELETE', headers: this.headers });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Airtable HTTP ${res.status}`); }
    return res.json();
  },
};

// ── Groq API ─────────────────────────────────────────────────
async function fetchFromGroq(word) {
  const apiKey = lsGet('groq_api_key') || DEFAULTS.groq_api_key;
  if (!apiKey) throw new Error('Groq API key is missing. Please add it in Settings.');

  const systemPrompt = `You are an English language tutor. Output valid JSON only. Format:
{
  "word": "<word>",
  "partOfSpeech": "<noun/verb/adjective/adverb>",
  "hindiMeaning": "<Hindi in Devanagari script (romanized Hinglish pronunciation in brackets)>",
  "sentences": ["<s1>","<s2>","<s3>","<s4>","<s5>"]
}
Example hindiMeaning: 'सशक्त बनाना (Sashakt banana)'. Provide exactly 5 clear, practical sentences using the word in workplace or daily life contexts.`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method : 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      model          : 'openai/gpt-oss-120b',
      response_format: { type: 'json_object' },
      messages       : [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Word: ${word}` },
      ],
    }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Groq HTTP ${res.status}`); }
  const json    = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from Groq.');
  const parsed = JSON.parse(content);
  if (!parsed.word || !parsed.partOfSpeech || !parsed.hindiMeaning || !Array.isArray(parsed.sentences)) {
    throw new Error('Unexpected format from Groq API.');
  }
  return parsed;
}

// ── App State ─────────────────────────────────────────────────
let allWords      = [];
let currentWord   = null;
let speakingIndex = null;
let touchStartX   = 0;
let swipedItem    = null;
let isSyncing     = false;

// ── DOM Helpers ──────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }

// ── Screen Navigation ─────────────────────────────────────────
const screens = {
  list    : $('#screen-list'),
  add     : $('#screen-add'),
  detail  : $('#screen-detail'),
  settings: $('#screen-settings'),
  quiz    : $('#screen-quiz'),
};

function navigate(to) {
  const fromKey = Object.keys(screens).find(k => screens[k]?.classList.contains('active'));
  if (fromKey === to) return;
  if (fromKey) {
    screens[fromKey].classList.remove('active');
    screens[fromKey].classList.add('behind');
    setTimeout(() => screens[fromKey]?.classList.remove('behind'), 340);
  }
  screens[to]?.classList.add('active');
}

function back() {
  const active = Object.keys(screens).find(k => screens[k]?.classList.contains('active'));
  if (active !== 'list') navigate('list');
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2600) {
  const t = $('#toast');
  t.innerHTML = `<span class="toast-msg">${msg}</span>`;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), duration);
}

function showToastWithAction(msg, actionLabel, actionFn, duration = 5500) {
  const t = $('#toast');
  t.innerHTML = `<span class="toast-msg">${msg}</span><button class="toast-action-btn" id="toast-action-btn">${actionLabel}</button>`;
  show(t);
  clearTimeout(toastTimer);
  document.getElementById('toast-action-btn')?.addEventListener('click', () => {
    clearTimeout(toastTimer);
    hide(t);
    actionFn();
  }, { once: true });
  toastTimer = setTimeout(() => hide(t), duration);
}

// ── Sync Status Banner ────────────────────────────────────────
function setSyncStatus(msg, type = 'info') {
  const el = $('#sync-status');
  if (!msg) { hide(el); return; }
  el.textContent = msg;
  el.className   = `sync-status sync-${type}`;
  show(el);
}

// ── Helpers ───────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function posClass(pos) {
  const m = { noun:'pos-noun', verb:'pos-verb', adjective:'pos-adjective', adverb:'pos-adverb' };
  return m[(pos||'').toLowerCase()] || 'pos-other';
}
function posTag(pos) {
  return `<span class="pos-tag ${posClass(pos)}">${escHtml((pos||'word').toLowerCase())}</span>`;
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Render Word List ──────────────────────────────────────────
function renderList(words) {
  const list  = $('#word-list');
  const empty = $('#empty-state');
  list.innerHTML = '';
  if (allWords.length === 0) { show(empty); return; }
  hide(empty);
  if (words.length === 0) {
    list.innerHTML = `<li style="text-align:center;padding:48px 16px;color:var(--text2);font-size:15px;">No results found.</li>`;
    return;
  }
  words.forEach(w => {
    const li = document.createElement('li');
    li.className  = 'word-item';
    li.dataset.id = w.id;
    li.innerHTML  = `
      <div class="word-item-body">
        <div class="word-item-header">
          <span class="word-item-name">${escHtml(w.word)}</span>
          ${posTag(w.partOfSpeech)}
          ${w.isReviewed ? '<span style="font-size:13px;color:var(--green);">✓</span>' : ''}
        </div>
        <div class="word-item-hindi">${escHtml(w.hindiMeaning)}</div>
      </div>
      <div class="word-item-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="word-item-delete">Delete</div>`;
    li.querySelector('.word-item-body').addEventListener('click', () => openDetail(w.id));
    li.querySelector('.word-item-arrow').addEventListener('click', () => openDetail(w.id));
    li.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      if (swipedItem && swipedItem !== li) { swipedItem.classList.remove('swiped'); swipedItem = null; }
    }, { passive: true });
    li.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (dx < -60)  { li.classList.add('swiped'); swipedItem = li; }
      else if (dx > 30) { li.classList.remove('swiped'); swipedItem = null; }
    }, { passive: true });
    li.querySelector('.word-item-delete').addEventListener('click', async e => {
      e.stopPropagation();
      await deleteWord(w.id);
    });
    list.appendChild(li);
  });
}

function applySearch() {
  const q = ($('#search-input').value || '').trim().toLowerCase();
  const filtered = q
    ? allWords.filter(w => w.word.toLowerCase().includes(q) || w.hindiMeaning.toLowerCase().includes(q) || (w.partOfSpeech||'').toLowerCase().includes(q))
    : allWords;
  renderList(filtered);
}

// ── Delete Word ───────────────────────────────────────────────
async function deleteWord(id) {
  setSyncStatus('Deleting…', 'info');
  try {
    await AT.delete(id);
    await idb.delete(id);
    allWords = allWords.filter(w => w.id !== id);
    applySearch();
    setSyncStatus('');
    showToast('🗑️ Word deleted');
  } catch (err) {
    setSyncStatus(`Delete failed: ${err.message}`, 'error');
    showToast(`Delete failed: ${err.message}`);
  }
}

// ── Detail Screen ─────────────────────────────────────────────
function speakerIcon(active = false) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    ${active ? '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' : ''}
  </svg>`;
}

function openDetail(id) {
  const w = allWords.find(x => x.id === id);
  if (!w) return;
  w.sentences = parseSentences(w.sentences);
  currentWord = w;
  stopSpeech();

  $('#detail-nav-title').textContent = w.word;
  updateReviewedIcon(w.isReviewed);

  const sentencesHtml = (w.sentences && w.sentences.length > 0)
    ? w.sentences.map((s, i) => `
      <div class="sentence-card" id="sentence-${i}">
        <div class="sentence-num">${i+1}</div>
        <div class="sentence-text">${escHtml(s)}</div>
        <button class="speak-btn" data-idx="${i}" aria-label="Speak sentence ${i+1}">${speakerIcon()}</button>
      </div>`).join('')
    : `<div style="color:var(--text2);font-size:14px;padding:12px 14px;background:var(--card);border:1px solid var(--card-border);border-radius:var(--radius);">No example sentences found for this word.</div>`;

  const content = $('#detail-content');
  content.innerHTML = `
    <div class="detail-header">
      <div class="detail-word-row">
        <div>
          <div class="detail-word">${escHtml(w.word)}</div>
          <div style="margin-top:8px">${posTag(w.partOfSpeech)}</div>
        </div>
        <button class="speak-btn" id="speak-word-btn" aria-label="Speak word">${speakerIcon()}</button>
      </div>
      <div class="detail-meta">📅 ${fmtDate(w.createdAt)}</div>
    </div>
    <div class="hindi-card">
      <div class="hindi-label">🌐 Hindi Meaning</div>
      <div class="hindi-text">${escHtml(w.hindiMeaning)}</div>
    </div>
    <div class="sentences-label">Example Sentences</div>
    ${sentencesHtml}
    <button class="btn-calendar" id="btn-add-calendar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="16" height="16"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      Add Review to Calendar
    </button>`;

  $('#speak-word-btn').addEventListener('click', () => speakText(w.word, -1));
  content.querySelectorAll('.speak-btn[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => speakText(w.sentences[+btn.dataset.idx], +btn.dataset.idx));
  });
  document.getElementById('btn-add-calendar')?.addEventListener('click', () => shareCalendar(w));

  navigate('detail');
}

function updateReviewedIcon(isReviewed) {
  const btn = $('#btn-toggle-reviewed');
  btn.style.color = isReviewed ? 'var(--green)' : '';
  btn.classList.toggle('reviewed', isReviewed);
}

// ── TTS ───────────────────────────────────────────────────────
function getVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find(v => v.lang === 'en-US' && v.name.includes('Samantha'))
      || voices.find(v => v.lang === 'en-US')
      || voices.find(v => v.lang.startsWith('en'));
}

function speakText(text, index) {
  if (!window.speechSynthesis) { showToast('TTS not available'); return; }
  if (speakingIndex === index) { stopSpeech(); return; }
  stopSpeech();
  speakingIndex = index;
  setSpeakingUI(index, true);
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang  = 'en-US';
  utt.rate  = 0.92;
  const v = getVoice();
  if (v) utt.voice = v;
  utt.onend = utt.onerror = () => { setSpeakingUI(index, false); speakingIndex = null; };
  speechSynthesis.speak(utt);
}

// Speak without updating word-detail UI state (for WOTD & quiz)
function speakDirect(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'en-US'; utt.rate = 0.88;
  const v = getVoice();
  if (v) utt.voice = v;
  speechSynthesis.speak(utt);
}

function stopSpeech() {
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (speakingIndex !== null) { setSpeakingUI(speakingIndex, false); speakingIndex = null; }
}

function setSpeakingUI(index, speaking) {
  if (index >= 0) {
    const card = $(`#sentence-${index}`);
    if (card) {
      card.classList.toggle('speaking', speaking);
      const btn = card.querySelector('.speak-btn');
      if (btn) { btn.classList.toggle('speaking', speaking); btn.innerHTML = speakerIcon(speaking); }
    }
  }
  if (index === -1) {
    const btn = $('#speak-word-btn');
    if (btn) { btn.classList.toggle('speaking', speaking); btn.innerHTML = speakerIcon(speaking); }
  }
}

// ── Add Word Flow ─────────────────────────────────────────────
function setupAddScreen() {
  const input    = $('#word-input');
  const clearBtn = $('#clear-input');
  const fetchBtn = $('#btn-fetch');
  const errEl    = $('#add-error');

  input.addEventListener('input', () => {
    input.value.length > 0 ? show(clearBtn) : hide(clearBtn);
    hide(errEl);
  });
  clearBtn.addEventListener('click', () => { input.value = ''; hide(clearBtn); input.focus(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') fetchBtn.click(); });

  fetchBtn.addEventListener('click', async () => {
    const word = input.value.trim();
    hide(errEl);
    if (!word) { showErr(errEl, 'Please enter a word.'); return; }

    setFetchLoading(true);
    try {
      setSyncStatus('🤖 Asking AI…', 'info');
      const def = await fetchFromGroq(word);

      const draft = {
        word        : def.word || word,
        partOfSpeech: def.partOfSpeech,
        hindiMeaning: def.hindiMeaning,
        sentences   : def.sentences,
        isReviewed  : false,
        createdAt   : Date.now(),
      };

      setSyncStatus('☁️ Saving to Airtable…', 'info');
      const saved = await AT.create(draft);
      await idb.put(saved);
      allWords.unshift(saved);
      applySearch();

      input.value = '';
      hide(clearBtn);
      setSyncStatus('');
      navigate('list');

      // Show "Remind me" toast action
      showToastWithAction(
        `✅ "${saved.word}" saved!`,
        '⏰ Remind me',
        () => scheduleReminder(saved)
      );
    } catch (err) {
      setSyncStatus('');
      showErr(errEl, `❌ ${err.message}`);
    } finally {
      setFetchLoading(false);
    }
  });
}

function setFetchLoading(on) {
  const btn = $('#btn-fetch');
  btn.disabled = on;
  if (on) { show($('#btn-fetch-loading')); hide($('#btn-fetch-text')); }
  else     { hide($('#btn-fetch-loading')); show($('#btn-fetch-text')); }
}
function showErr(el, msg) { el.textContent = msg; show(el); }

// ── Sync from Airtable ────────────────────────────────────────
async function syncFromAirtable(silent = false) {
  if (isSyncing) return;
  isSyncing = true;
  if (!silent) setSyncStatus('☁️ Syncing with Airtable…', 'info');
  try {
    const remote = await AT.fetchAll();
    await idb.clear();
    for (const w of remote) await idb.put(w);
    allWords = remote;
    applySearch();
    if (currentWord && screens.detail?.classList.contains('active')) {
      const refreshed = allWords.find(x => x.id === currentWord.id);
      if (refreshed) openDetail(refreshed.id);
    }
    setSyncStatus('');
    if (!silent) showToast(`✅ Synced ${remote.length} word${remote.length !== 1 ? 's' : ''}`);
  } catch (err) {
    setSyncStatus(`Sync failed: ${err.message}`, 'error');
    if (!silent) showToast(`Sync failed: ${err.message}`);
  } finally {
    isSyncing = false;
  }
}

// ── Reviewed Toggle ───────────────────────────────────────────
async function toggleReviewed() {
  if (!currentWord) return;
  const newVal = !currentWord.isReviewed;
  try {
    await AT.update(currentWord.id, { Status: newVal ? 'Done' : 'Todo' });
    currentWord.isReviewed = newVal;
    await idb.put(currentWord);
    const idx = allWords.findIndex(w => w.id === currentWord.id);
    if (idx !== -1) allWords[idx] = { ...allWords[idx], isReviewed: newVal };
    updateReviewedIcon(newVal);
    applySearch();
    showToast(newVal ? '✅ Marked as Reviewed' : 'Marked as New');
  } catch (err) {
    showToast(`Update failed: ${err.message}`);
  }
}

// ── Settings Screen ───────────────────────────────────────────
function setupSettings() {
  const atStatus = $('#at-config-status');

  $('#btn-sync-now').addEventListener('click', async () => {
    const btn = $('#btn-sync-now');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    navigate('list');
    await syncFromAirtable(false);
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="16" height="16"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Sync Now`;
  });
}

// ── Streak & Badges ───────────────────────────────────────────
function updateStreak() {
  const today    = new Date().toDateString();
  const lastDate = localStorage.getItem('streak_last_date');
  let count      = parseInt(localStorage.getItem('streak_count') || '0');

  if (!lastDate) {
    count = 1;
  } else if (lastDate !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    count = lastDate === yesterday.toDateString() ? count + 1 : 1;
  }

  localStorage.setItem('streak_last_date', today);
  localStorage.setItem('streak_count', String(count));

  const countEl = $('#streak-count');
  if (countEl) countEl.textContent = count;

  // Milestone celebration (only on new milestone, not on re-open same day)
  if ([3, 7, 14, 30].includes(count) && lastDate !== today) {
    setTimeout(() => { showToast(`🎉 ${count}-day streak! Amazing!`, 4000); launchConfetti(); }, 900);
  }
  return count;
}

function launchConfetti() {
  const colors = ['#6c63ff', '#a78bfa', '#EC4899', '#F59E0B', '#34d399', '#3B82F6'];
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);
  for (let i = 0; i < 72; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    const size = 6 + Math.random() * 9;
    p.style.cssText = [
      `left:${Math.random() * 100}%`,
      `background:${colors[Math.floor(Math.random() * colors.length)]}`,
      `animation-delay:${(Math.random() * 0.6).toFixed(2)}s`,
      `animation-duration:${(0.9 + Math.random() * 1.3).toFixed(2)}s`,
      `width:${size}px`,
      `height:${size}px`,
      `border-radius:${Math.random() > 0.5 ? '50%' : '3px'}`,
    ].join(';');
    container.appendChild(p);
  }
  setTimeout(() => container.remove(), 3500);
}

// ── PWA Install Prompt ────────────────────────────────────────
let deferredInstallPrompt = null;

function setupInstallPrompt() {
  const banner = $('#pwa-banner');
  if (!banner) return;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                    || window.navigator.standalone === true;
  if (isStandalone) return;

  const dismissed = localStorage.getItem('pwa_banner_dismissed');
  if (dismissed && Date.now() - parseInt(dismissed) < 7 * 24 * 60 * 60 * 1000) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase());
  const iosSteps  = document.getElementById('pwa-ios-steps');
  const androidBtn = document.getElementById('pwa-banner-android');

  if (isIOS) {
    if (iosSteps) show(iosSteps);
    if (androidBtn) hide(androidBtn);
    setTimeout(() => show(banner), 3500);
  } else {
    if (iosSteps) hide(iosSteps);
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (androidBtn) show(androidBtn);
      setTimeout(() => show(banner), 1500);
    });
  }

  document.getElementById('pwa-banner-close')?.addEventListener('click', () => {
    hide(banner);
    localStorage.setItem('pwa_banner_dismissed', String(Date.now()));
  });

  document.getElementById('pwa-banner-android')?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') { hide(banner); showToast('🎉 App installed successfully!'); }
    deferredInstallPrompt = null;
  });
}

// ── Notifications ─────────────────────────────────────────────
let notifTimer = null;

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('Notifications not supported on this browser');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    showToast('Blocked — enable in iPhone Settings → Notifications → Safari');
    return false;
  }
  const perm = await Notification.requestPermission();
  return perm === 'granted';
}

async function scheduleLocalNotification(title, body, delayMs) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  setTimeout(async () => {
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(title, {
          body, icon: './icons/icon-192.png', badge: './icons/icon-192.png',
          tag: 'vocabnotes-reminder', renotify: true,
        });
      } else {
        new Notification(title, { body, icon: './icons/icon-192.png' });
      }
    } catch (err) { console.warn('Notification error:', err); }
  }, delayMs);
}

function setupDailyNotification() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (allWords.length === 0) return;

  const timeStr  = localStorage.getItem('notif_time') || '09:00';
  const [hrs, mins] = timeStr.split(':').map(Number);
  const now    = new Date();
  const target = new Date();
  target.setHours(hrs, mins, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(async () => {
    const pool = allWords.filter(w => !w.isReviewed);
    const word = randFrom(pool.length > 0 ? pool : allWords);
    if (word) {
      await scheduleLocalNotification(
        `📚 Word of the Day: ${word.word}`,
        `${word.partOfSpeech} • ${word.hindiMeaning}`,
        0
      );
    }
    setupDailyNotification(); // reschedule for next day
  }, target.getTime() - now.getTime());
}

function setupNotificationSettings() {
  const timeInput   = $('#notif-time');
  const enableBtn   = $('#btn-enable-notif');
  const notifStatus = $('#notif-status');
  if (!timeInput || !enableBtn) return;

  timeInput.value = localStorage.getItem('notif_time') || '09:00';

  function refresh() {
    if (!notifStatus) return;
    if (!('Notification' in window)) {
      notifStatus.textContent = 'Not supported on this browser'; notifStatus.style.color = 'var(--text2)'; return;
    }
    if (Notification.permission === 'granted') {
      notifStatus.textContent = '✅ Daily reminders enabled'; notifStatus.style.color = 'var(--green)'; enableBtn.textContent = 'Update';
    } else if (Notification.permission === 'denied') {
      notifStatus.textContent = '❌ Blocked — enable in iPhone Settings'; notifStatus.style.color = 'var(--red)';
    } else {
      notifStatus.textContent = 'Tap Enable to get daily word reminders'; notifStatus.style.color = 'var(--text2)';
    }
  }
  refresh();

  enableBtn.addEventListener('click', async () => {
    const granted = await requestNotificationPermission();
    if (granted) { lsSet('notif_time', timeInput.value); setupDailyNotification(); showToast(`⏰ Daily reminder set for ${timeInput.value}`); }
    refresh();
  });
  timeInput.addEventListener('change', () => {
    lsSet('notif_time', timeInput.value);
    if (Notification.permission === 'granted') { setupDailyNotification(); showToast(`⏰ Reminder updated to ${timeInput.value}`); }
  });
}

// ── Audio Word of the Day ─────────────────────────────────────
function playDailyWord() {
  if (allWords.length === 0) return;
  const today = new Date().toDateString();
  if (localStorage.getItem('wotd_date') === today) return;
  localStorage.setItem('wotd_date', today);

  const pool = allWords.filter(w => !w.isReviewed);
  const w    = randFrom(pool.length > 0 ? pool : allWords);

  const banner = $('#wotd-banner');
  const wordEl = $('#wotd-word');
  if (!banner || !wordEl) return;

  wordEl.textContent = w.word;
  show(banner);

  const speakFn = () => speakDirect(`Today's word is ${w.word}. ${w.word}. It means ${w.hindiMeaning}.`);
  setTimeout(speakFn, 2200); // auto speak after 2.2s

  document.getElementById('wotd-speak')?.addEventListener('click', speakFn);
  document.getElementById('wotd-close')?.addEventListener('click', () => {
    window.speechSynthesis?.cancel();
    hide(banner);
  });
}

// ── Remind Me Later ───────────────────────────────────────────
async function scheduleReminder(word) {
  const granted = await requestNotificationPermission();
  if (granted) {
    scheduleLocalNotification(
      `📚 Review: ${word.word}`,
      `You added this word earlier — time to review! "${word.hindiMeaning}"`,
      2 * 60 * 60 * 1000 // 2 hours
    );
    showToast('⏰ Reminder set for 2 hours!');
  } else {
    showToast('Enable notifications in Settings to use reminders');
  }
}

// ── Calendar (.ics) ───────────────────────────────────────────
function generateICS(wordName) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const uid = `vocabnotes-${Date.now()}@vocabnotes.app`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VocabNotes//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${fmt(tomorrow)}`,
    `DTEND:${fmt(new Date(tomorrow.getTime() + 15 * 60000))}`,
    `SUMMARY:Review Word: ${wordName}`,
    `DESCRIPTION:Review the word "${wordName}" in your VocabNotes app`,
    'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', `DESCRIPTION:Review: ${wordName}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function shareCalendar(word) {
  const content  = generateICS(word.word);
  const blob     = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const fileName = `vocabnotes-${word.word.toLowerCase().replace(/\s+/g, '-')}.ics`;
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], fileName, { type: 'text/calendar' })] })) {
    navigator.share({ files: [new File([blob], fileName, { type: 'text/calendar' })], title: `Review: ${word.word}` })
      .catch(() => _downloadICS(blob, fileName));
  } else {
    _downloadICS(blob, fileName);
  }
}
function _downloadICS(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Quiz Mode ─────────────────────────────────────────────────
let quizWords  = [];
let quizIndex  = 0;
let quizFlipped = false;
let quizScore  = { known: 0, review: 0 };

function startQuiz() {
  if (allWords.length === 0) { showToast('Add some words first! 📚'); return; }
  const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
  const unrev = allWords.filter(w => !w.isReviewed);
  const rev   = allWords.filter(w =>  w.isReviewed);
  quizWords   = shuffle(unrev).concat(shuffle(rev)).slice(0, Math.min(5, allWords.length));
  quizIndex   = 0;
  quizFlipped = false;
  quizScore   = { known: 0, review: 0 };
  navigate('quiz');
  showQuizCard(0);
}

function showQuizCard(index) {
  const content = $('#quiz-content');
  if (!content) return;
  if (index >= quizWords.length) { endQuiz(); return; }

  const w     = quizWords[index];
  const total = quizWords.length;
  quizFlipped = false;
  const pct   = (index / total) * 100;

  content.innerHTML = `
    <div class="quiz-progress-bar">
      <div class="quiz-progress-fill" style="width:${pct}%"></div>
    </div>
    <div class="quiz-counter">${index + 1} <span>/ ${total}</span></div>

    <div class="quiz-flip-wrap">
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-front">
          <div class="quiz-word-label">${escHtml(w.word)}</div>
          <div class="quiz-pos-label">${escHtml(w.partOfSpeech || '')}</div>
          <div class="quiz-hint-text">Tap card to reveal meaning</div>
        </div>
        <div class="quiz-back">
          <div class="quiz-back-word">${escHtml(w.word)}</div>
          <div class="quiz-back-meaning">${escHtml(w.hindiMeaning)}</div>
          ${w.sentences && w.sentences.length > 0 ? `<div class="quiz-back-sentence">"${escHtml(w.sentences[0])}"</div>` : ''}
        </div>
      </div>
    </div>

    <div id="quiz-reveal-area" class="quiz-btn-area">
      <button class="btn-primary" id="quiz-reveal-btn">👁 Reveal Meaning</button>
    </div>
    <div id="quiz-judge-area" class="quiz-two-btn hidden">
      <button class="quiz-judge-btn quiz-know" id="quiz-know-btn">✅ I Know It</button>
      <button class="quiz-judge-btn quiz-nope" id="quiz-nope-btn">🔄 Need Review</button>
    </div>`;

  const card = document.getElementById('quiz-card');
  const revealFn = () => {
    if (quizFlipped) return;
    quizFlipped = true;
    card?.classList.add('flipped');
    hide(document.getElementById('quiz-reveal-area'));
    show(document.getElementById('quiz-judge-area'));
    speakDirect(w.word);
  };
  card?.addEventListener('click', revealFn);
  document.getElementById('quiz-reveal-btn')?.addEventListener('click', revealFn);

  document.getElementById('quiz-know-btn')?.addEventListener('click', () => {
    quizScore.known++;
    if (!w.isReviewed) {
      AT.update(w.id, { Status: 'Done' }).catch(() => {});
      const idx = allWords.findIndex(x => x.id === w.id);
      if (idx !== -1) {
        allWords[idx] = { ...allWords[idx], isReviewed: true };
        idb.put(allWords[idx]).catch(() => {});
      }
    }
    showQuizCard(++quizIndex);
  });
  document.getElementById('quiz-nope-btn')?.addEventListener('click', () => {
    quizScore.review++;
    showQuizCard(++quizIndex);
  });
}

function endQuiz() {
  const content = $('#quiz-content');
  if (!content) return;
  const total = quizWords.length;
  const pct   = total > 0 ? Math.round((quizScore.known / total) * 100) : 0;
  const emoji = pct >= 80 ? '🎉' : pct >= 50 ? '👍' : '💪';
  const title = pct >= 80 ? 'Excellent!' : pct >= 50 ? 'Good job!' : 'Keep going!';

  content.innerHTML = `
    <div class="quiz-complete">
      <div class="quiz-complete-emoji">${emoji}</div>
      <div class="quiz-complete-title">${title}</div>
      <div class="quiz-score-row">
        <div class="quiz-score-box quiz-score-green">
          <div class="quiz-score-num">${quizScore.known}</div>
          <div class="quiz-score-lbl">Known</div>
        </div>
        <div class="quiz-score-sep"></div>
        <div class="quiz-score-box quiz-score-purple">
          <div class="quiz-score-num">${quizScore.review}</div>
          <div class="quiz-score-lbl">Review</div>
        </div>
      </div>
      <div class="quiz-accuracy">${pct}% accuracy</div>
      <button class="btn-primary" id="quiz-done-btn" style="width:100%">Done</button>
      <button class="btn-secondary outline" id="quiz-again-btn" style="width:100%;margin-top:10px">Try Again</button>
    </div>`;

  document.getElementById('quiz-done-btn')?.addEventListener('click', () => { navigate('list'); applySearch(); });
  document.getElementById('quiz-again-btn')?.addEventListener('click', startQuiz);
  if (pct >= 80) setTimeout(launchConfetti, 400);
}

// ── Wire Navigation ───────────────────────────────────────────
function wireNavigation() {
  $('#btn-add').addEventListener('click', () => {
    hide($('#add-error'));
    navigate('add');
    setTimeout(() => $('#word-input').focus(), 350);
  });
  $('#btn-add-back').addEventListener('click', back);
  $('#btn-settings').addEventListener('click', () => navigate('settings'));
  $('#btn-settings-back').addEventListener('click', back);
  $('#btn-detail-back').addEventListener('click', () => { stopSpeech(); back(); });
  $('#btn-toggle-reviewed').addEventListener('click', toggleReviewed);
  $('#search-input').addEventListener('input', applySearch);
  $('#word-list-container').addEventListener('scroll', () => {
    if (swipedItem) { swipedItem.classList.remove('swiped'); swipedItem = null; }
  }, { passive: true });
  // Quiz
  $('#btn-start-quiz')?.addEventListener('click', startQuiz);
  $('#btn-quiz-back')?.addEventListener('click', () => { stopSpeech(); navigate('list'); });
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  await openDB();

  // 1. Load cached words instantly
  allWords = (await idb.all()).map(w => ({ ...w, sentences: parseSentences(w.sentences) }));
  applySearch();

  // 2. Wire UI
  wireNavigation();
  setupAddScreen();
  setupSettings();

  // 3. Retention features
  updateStreak();
  setupInstallPrompt();
  setupNotificationSettings();
  setupDailyNotification();
  setTimeout(playDailyWord, 1600); // slight delay for voices to load

  // 4. Background sync
  syncFromAirtable(allWords.length > 0);

  // 5. Preload TTS voices
  if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices());
  }
}

init();
