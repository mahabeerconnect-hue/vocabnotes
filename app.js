/* ============================================================
   VocabNotes PWA — app.js  (Airtable + IndexedDB edition)
   ============================================================

   Airtable "Dictionary" table field mapping:
     Word          → word
     ShortMeaning  → partOfSpeech
     Meaning       → hindiMeaning
     sentence      → JSON.stringify(sentences[])
     Status        → "Reviewed" | "New"
     Date          → auto createdTime (used for sorting)
   ============================================================ */

'use strict';

// ── Default Keys (pre-seeded; user can override in Settings) ─
const DEFAULTS = {
  groq_api_key : '',   // Enter in Settings → Groq API Key
  at_api_key   : '',   // Enter in Settings → Airtable API Key
  at_base_id   : '',   // Enter in Settings → Base ID
  at_table     : 'Dictionary',
};

function lsGet(k)    { return localStorage.getItem(k) || ''; }
function lsSet(k, v) { localStorage.setItem(k, v); }

// Seed defaults on very first launch
(function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!localStorage.getItem(k)) lsSet(k, v);
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

// ── Airtable Service ─────────────────────────────────────────
const AT = {
  get baseUrl() {
    const base  = lsGet('at_base_id')  || DEFAULTS.at_base_id;
    const table = lsGet('at_table')    || DEFAULTS.at_table;
    return `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(table)}`;
  },
  get headers() {
    return {
      'Authorization': `Bearer ${lsGet('at_api_key') || DEFAULTS.at_api_key}`,
      'Content-Type' : 'application/json',
    };
  },

  // Convert Airtable record → local VocabWord object
  fromRecord(rec) {
    const f = rec.fields;
    let sentences = [];
    try { sentences = JSON.parse(f.sentence || '[]'); } catch { sentences = []; }
    return {
      id          : rec.id,                          // Airtable recXXX id
      word        : f.Word        || '',
      partOfSpeech: f.ShortMeaning|| '',
      hindiMeaning: f.Meaning     || '',
      sentences,
      isReviewed  : (f.Status     || '').toLowerCase() === 'done',
      createdAt   : new Date(f.Date || rec.createdTime || Date.now()).getTime(),
    };
  },

  // Convert local VocabWord → Airtable fields object
  toFields(w) {
    return {
      Word        : w.word,
      ShortMeaning: w.partOfSpeech,
      Meaning     : w.hindiMeaning,
      sentence    : JSON.stringify(w.sentences),
      Status      : w.isReviewed ? 'Done' : 'Todo',
    };
  },

  // GET all records (handles pagination)
  async fetchAll() {
    let records = [];
    let offset  = null;
    do {
      const url = new URL(this.baseUrl);
      url.searchParams.set('sort[0][field]',     'Date');
      url.searchParams.set('sort[0][direction]', 'desc');
      url.searchParams.set('pageSize', '100');
      if (offset) url.searchParams.set('offset', offset);

      const res = await fetch(url.toString(), { headers: this.headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Airtable HTTP ${res.status}`);
      }
      const data = await res.json();
      records.push(...(data.records || []));
      offset = data.offset || null;
    } while (offset);

    return records.map(r => this.fromRecord(r));
  },

  // POST create record → returns saved VocabWord with Airtable id
  async create(w) {
    const res = await fetch(this.baseUrl, {
      method : 'POST',
      headers: this.headers,
      body   : JSON.stringify({ fields: this.toFields(w) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Airtable HTTP ${res.status}`);
    }
    const data = await res.json();
    return this.fromRecord(data);
  },

  // PATCH update record
  async update(id, patch) {
    const res = await fetch(`${this.baseUrl}/${id}`, {
      method : 'PATCH',
      headers: this.headers,
      body   : JSON.stringify({ fields: patch }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Airtable HTTP ${res.status}`);
    }
    return res.json();
  },

  // DELETE record
  async delete(id) {
    const res = await fetch(`${this.baseUrl}/${id}`, {
      method : 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Airtable HTTP ${res.status}`);
    }
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

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq HTTP ${res.status}`);
  }

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
function hide(el) { el?.classList.add('hidden');    }

// ── Screen Navigation ─────────────────────────────────────────
const screens = { list: $('#screen-list'), add: $('#screen-add'), detail: $('#screen-detail'), settings: $('#screen-settings') };

function navigate(to) {
  const fromKey = Object.keys(screens).find(k => screens[k].classList.contains('active'));
  if (fromKey === to) return;
  if (fromKey) {
    screens[fromKey].classList.remove('active');
    screens[fromKey].classList.add('behind');
    setTimeout(() => screens[fromKey].classList.remove('behind'), 340);
  }
  screens[to].classList.add('active');
}

function back() {
  const active = Object.keys(screens).find(k => screens[k].classList.contains('active'));
  if (active !== 'list') navigate('list');
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toastTimer);
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

    // Swipe-to-delete reveal
    li.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      if (swipedItem && swipedItem !== li) { swipedItem.classList.remove('swiped'); swipedItem = null; }
    }, { passive: true });

    li.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (dx < -60)  { li.classList.add('swiped'); swipedItem = li; }
      else if (dx > 30) { li.classList.remove('swiped'); swipedItem = null; }
    }, { passive: true });

    // Delete button
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
    ? allWords.filter(w =>
        w.word.toLowerCase().includes(q) ||
        w.hindiMeaning.toLowerCase().includes(q) ||
        (w.partOfSpeech||'').toLowerCase().includes(q))
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
function openDetail(id) {
  const w = allWords.find(x => x.id === id);
  if (!w) return;
  currentWord = w;
  stopSpeech();

  $('#detail-nav-title').textContent = w.word;
  updateReviewedIcon(w.isReviewed);

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
    ${w.sentences.map((s, i) => `
      <div class="sentence-card" id="sentence-${i}">
        <div class="sentence-num">${i+1}</div>
        <div class="sentence-text">${escHtml(s)}</div>
        <button class="speak-btn" data-idx="${i}" aria-label="Speak sentence ${i+1}">${speakerIcon()}</button>
      </div>`).join('')}`;

  $('#speak-word-btn').addEventListener('click', () => speakText(w.word, -1));
  content.querySelectorAll('.speak-btn[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => speakText(w.sentences[+btn.dataset.idx], +btn.dataset.idx));
  });

  navigate('detail');
}

function updateReviewedIcon(isReviewed) {
  const btn = $('#btn-toggle-reviewed');
  btn.style.color = isReviewed ? 'var(--green)' : '';
  btn.classList.toggle('reviewed', isReviewed);
}

function speakerIcon(active = false) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    ${active ? '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' : ''}
  </svg>`;
}

// ── TTS ───────────────────────────────────────────────────────
function speakText(text, index) {
  if (!window.speechSynthesis) { showToast('TTS not available'); return; }
  if (speakingIndex === index) { stopSpeech(); return; }
  stopSpeech();
  speakingIndex = index;
  setSpeakingUI(index, true);

  const utt = new SpeechSynthesisUtterance(text);
  utt.lang  = 'en-US';
  utt.rate  = 0.92;
  const voices = speechSynthesis.getVoices();
  const v = voices.find(v => v.lang === 'en-US' && v.name.includes('Samantha'))
         || voices.find(v => v.lang === 'en-US')
         || voices.find(v => v.lang.startsWith('en'));
  if (v) utt.voice = v;

  utt.onend = utt.onerror = () => { setSpeakingUI(index, false); speakingIndex = null; };
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
      // 1. Fetch from Groq
      setSyncStatus('🤖 Asking AI…', 'info');
      const def = await fetchFromGroq(word);

      // 2. Build word object (no id yet — Airtable will assign one)
      const draft = {
        word        : def.word || word,
        partOfSpeech: def.partOfSpeech,
        hindiMeaning: def.hindiMeaning,
        sentences   : def.sentences,
        isReviewed  : false,
        createdAt   : Date.now(),
      };

      // 3. Save to Airtable → get back record with Airtable id
      setSyncStatus('☁️ Saving to Airtable…', 'info');
      const saved = await AT.create(draft);

      // 4. Cache locally
      await idb.put(saved);
      allWords.unshift(saved);
      applySearch();

      input.value = '';
      hide(clearBtn);
      setSyncStatus('');
      navigate('list');
      showToast(`✅ "${saved.word}" saved to Airtable!`);
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
    // Replace local cache with Airtable truth
    await idb.clear();
    for (const w of remote) await idb.put(w);
    allWords = remote;
    applySearch();
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
  // Populate fields from localStorage
  const groqInput  = $('#groq-key-input');
  const atKeyInput = $('#at-key-input');
  const atBaseInput= $('#at-base-input');
  const atTable    = $('#at-table-input');
  const groqStatus = $('#groq-status');
  const atStatus   = $('#at-config-status');

  function loadFields() {
    groqInput.value   = lsGet('groq_api_key')  || DEFAULTS.groq_api_key;
    atKeyInput.value  = lsGet('at_api_key')    || DEFAULTS.at_api_key;
    atBaseInput.value = lsGet('at_base_id')    || DEFAULTS.at_base_id;
    atTable.value     = lsGet('at_table')      || DEFAULTS.at_table;
    groqInput.value ? show(groqStatus) : hide(groqStatus);
  }
  loadFields();

  groqInput.addEventListener('input', () => {
    lsSet('groq_api_key', groqInput.value.trim());
    groqInput.value ? show(groqStatus) : hide(groqStatus);
  });

  // Toggle Groq visibility
  $('#toggle-groq-visibility').addEventListener('click', () => {
    groqInput.type = groqInput.type === 'password' ? 'text' : 'password';
  });

  // Toggle Airtable key visibility
  $('#toggle-at-visibility').addEventListener('click', () => {
    atKeyInput.type = atKeyInput.type === 'password' ? 'text' : 'password';
  });

  // Clear Groq key
  $('#btn-clear-groq').addEventListener('click', () => {
    groqInput.value = '';
    localStorage.removeItem('groq_api_key');
    hide(groqStatus);
    showToast('Groq key cleared');
  });

  // Save Airtable config
  $('#btn-save-airtable').addEventListener('click', () => {
    lsSet('at_api_key', atKeyInput.value.trim());
    lsSet('at_base_id', atBaseInput.value.trim());
    lsSet('at_table',   atTable.value.trim());
    atStatus.textContent = '✅ Airtable config saved.';
    atStatus.style.color = 'var(--green)';
    showToast('Airtable config saved');
  });

  // Sync Now
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
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  await openDB();

  // 1. Show cached words immediately for fast start
  allWords = await idb.all();
  applySearch();

  // 2. Wire up UI
  wireNavigation();
  setupAddScreen();
  setupSettings();

  // 3. Sync from Airtable in background
  syncFromAirtable(allWords.length > 0); // silent if we already have cache

  // Preload TTS voices
  if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices());
  }
}

init();
