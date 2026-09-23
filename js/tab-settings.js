/* Settings: where data is saved, the key, the language, the models, the
   budget, the prompts and the voices. */

import * as storage from './storage.js';
import * as store from './store.js';
import { VOICES, DEFAULT_SENTENCE_PROMPT, DEFAULT_SPEECH_PROMPT } from './defaults.js';
import { fillTemplate, sentenceVars, formatWait, GeminiError, QuotaError } from './gemini.js';
import { serializeDeck } from './deck.js';
import { serializeBundle, parseBundle, describeBundle, bundleFilename } from './bundle.js';
import { makeZip, readZip } from './zip.js';
import * as speech from './speech.js';

const $ = (id) => document.getElementById(id);

/* One handle kept aside when a folder is remembered but its permission has
   lapsed — requestPermission() is only allowed from a click. */
let pendingHandle = null;

/* A file that has been read and understood but not yet written anywhere:
   either {kind:'bundle'} or {kind:'restore'}. Both can change every deck at
   once, so the file is described first and nothing happens until that has been
   confirmed. */
let pending = null;

const SAMPLE_TERMS = [
  { front: 'cải tiến', back: 'to improve' },
  { front: 'tận hưởng', back: 'to enjoy' },
  { front: 'rành', back: 'to know well' },
];

export function init() {
  wireStore();
  wireKey();
  wireFields();
  wirePrompts();
  wireVoices();
  wireSpeech();

  store.subscribe('settings', render);
  store.subscribe('folder', renderStore);
  store.subscribe('quota', renderQuota);
  store.subscribe('deck', renderStore);
  render();
  renderStore();
  renderQuota();
  setInterval(renderQuota, 1000);
}

/* ── where data is saved ─────────────────────────────────────────────── */

function wireStore() {
  $('store-choose').addEventListener('click', async () => {
    let moved = 0;
    try {
      if (pendingHandle) {
        const ok = await storage.regrant(pendingHandle);
        if (!ok) { setStoreStatus('Permission refused — the folder is still not being written to.', 'is-warn'); return; }
        pendingHandle = null;
      } else {
        await storage.connect();
        /* Everything saved in this browser so far goes with you. Refused if
           the folder already holds a setup of its own — see copyFromBrowser. */
        moved = await storage.copyFromBrowser();
      }
      await store.adoptFolder();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error(e);
      setStoreStatus('Could not open that folder: ' + e.message, 'is-bad');
      return;
    }
    /* After adoptFolder(), because it emits and every emit rewrites this line. */
    if (moved) {
      setStoreStatus(`Saving to "${storage.label()}" — ${plural(moved, 'file')} moved across from this browser's storage.`, 'is-ok');
    }
  });

  $('store-disconnect').addEventListener('click', async () => {
    const was = storage.label();
    const landed = await storage.disconnect();
    if (landed) {
      await store.adoptFolder();
      setStoreStatus(`Disconnected from "${was}". Everything in it was copied back into this browser's storage, which is what is being saved to now.`, 'is-ok');
    } else {
      store.releaseFolder();
      setStoreStatus(`Disconnected from "${was}". This browser has nowhere else to save, so nothing is being saved.`, 'is-warn');
    }
  });

  $('store-export').addEventListener('click', () => {
    storage.download(`${store.state.deckName}.json`, serializeDeck(store.state.cards));
  });

  $('store-export-all').addEventListener('click', () => {
    const bundle = store.exportBundle();
    const name = bundleFilename();
    storage.download(name, serializeBundle(bundle));
    setStoreStatus(`Exported ${describeBundle(readBack(bundle))} to ${name}.`, 'is-ok');
  });

  $('backup-download').addEventListener('click', async () => {
    if (!store.state.persistent) {
      setStoreStatus('Nothing is being saved, so there is nothing to back up. Use Export everything for the decks held in memory.', 'is-warn');
      return;
    }
    const files = await storage.allFiles();
    if (!files.length) {
      setStoreStatus('The store is empty — there is nothing to back up yet.', 'is-warn');
      return;
    }
    const name = backupFilename();
    const zip = await makeZip(files);
    storage.download(name, zip);
    setStoreStatus(`Backed up ${plural(files.length, 'file')} (${size(zip.size)}) to ${name}.`, 'is-ok');
  });

  $('backup-restore').addEventListener('click', () => {
    if (!store.state.persistent) {
      setStoreStatus('There is nowhere to restore to. This browser is saving nothing at the moment.', 'is-warn');
      return;
    }
    $('backup-restore-file').click();
  });

  $('backup-restore-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    showImport(null);
    let entries;
    try {
      entries = await readZip(file);
    } catch (err) {
      setStoreStatus(`${file.name} could not be read: ${err.message}`, 'is-bad');
      return;
    }
    /* Anything outside the data layout is dropped here, before the file is
       described — so what the preview promises is exactly what gets written. */
    const files = [];
    for (const { path, bytes } of entries) {
      const safe = storage.dataPath(path);
      if (safe) files.push({ path: safe, data: new Blob([bytes]) });
    }
    if (!files.length) {
      setStoreStatus(`${file.name} holds no data files this app recognises — a backup has settings.json, decks/ and audio/ in it.`, 'is-bad');
      return;
    }
    pending = { kind: 'restore', name: file.name, files };
    showImport(`${file.name} holds ${describeFiles(files)}. Restoring writes them straight into ${storage.label()}, overwriting any file of the same name. Decks you have that the backup does not are left alone.`);
  });

  $('store-import').addEventListener('click', () => {
    if (!store.state.persistent) {
      setStoreStatus('There is nowhere to import to yet. Choose a folder first, so the decks have somewhere to land.', 'is-warn');
      return;
    }
    $('store-import-file').click();
  });

  $('store-import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    /* Cleared so that picking the same file again still counts as a change. */
    e.target.value = '';
    if (!file) return;
    showImport(null);
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      setStoreStatus(`Could not read ${file.name}: ${err.message}`, 'is-bad');
      return;
    }
    const parsed = parseBundle(text);
    if (parsed.error) {
      setStoreStatus(`${file.name} cannot be imported — ${parsed.error}`, 'is-bad');
      return;
    }
    pending = { kind: 'bundle', bundle: parsed.bundle };
    showImport(`${file.name} holds ${describeBundle(parsed.bundle)}. Importing adds these decks alongside the ones you have — nothing is replaced or overwritten, and a name already in use gets a free one.`);
  });

  $('import-confirm').addEventListener('click', async () => {
    const action = pending;
    pending = null;
    showImport(null);
    if (!action) return;
    if (action.kind === 'restore') { await runRestore(action); return; }
    const bundle = action.bundle;
    let added = [];
    try {
      added = await store.importBundle(bundle);
    } catch (err) {
      setStoreStatus(`Import failed: ${err.message}`, 'is-bad');
      return;
    }
    /* After the import, because it emits and every emit rewrites this line. */
    const renamed = added.filter((a) => a.name !== a.from);
    const bits = [`Imported ${added.length} deck${added.length === 1 ? '' : 's'}`];
    if (renamed.length) {
      bits.push(`renamed to avoid a clash: ${renamed.map((r) => `"${r.from}" → "${r.name}"`).join(', ')}`);
    }
    if (bundle.settings) bits.push('settings applied');
    setStoreStatus(bits.join(' · ') + '.', 'is-ok');
  });

  $('import-cancel').addEventListener('click', () => {
    pending = null;
    showImport(null);
    setStoreStatus('Cancelled — nothing was changed.', '');
  });
}

/* Writes a checked backup into the live store and rereads everything, since a
   restore can replace the settings and every deck in one go. */
async function runRestore(action) {
  let written = 0;
  try {
    written = await storage.writeDataFiles(action.files);
  } catch (err) {
    setStoreStatus(`Restore failed: ${err.message}`, 'is-bad');
    return;
  }
  await store.adoptFolder();
  setStoreStatus(`Restored ${plural(written, 'file')} from ${action.name}.`, 'is-ok');
}

function backupFilename(now = new Date()) {
  return `language-study-backup-${now.toISOString().slice(0, 10)}.zip`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* What a backup holds, counted the way someone thinks about it. */
function describeFiles(files) {
  const decks = files.filter((f) => f.path.startsWith('decks/')).length;
  const audio = files.filter((f) => /^audio[/].+[.]wav$/.test(f.path)).length;
  const bits = [];
  if (decks) bits.push(plural(decks, 'deck'));
  if (audio) bits.push(plural(audio, 'banked sentence'));
  if (files.some((f) => f.path === 'settings.json')) bits.push('settings');
  return bits.length ? bits.join(', ') : plural(files.length, 'file');
}

/* Show the pending bundle, or hide the whole block when there is none. */
function showImport(text) {
  const box = $('import-preview');
  $('import-note').textContent = text || '';
  box.hidden = !text;
}

/* describeBundle() speaks about a parsed bundle, so an exported one is read
   back through the same parser to be described by the same code. */
function readBack(bundle) {
  const parsed = parseBundle(serializeBundle(bundle));
  return parsed.bundle || { decks: [], settings: bundle.settings || null, exported: bundle.exported || null };
}

export async function restoreStore() {
  const result = await storage.restore();
  if (result.state === 'folder' || result.state === 'browser') {
    await store.adoptFolder();
    return;
  }
  if (result.state === 'needs-permission') {
    pendingHandle = result.handle;
    $('store-choose').textContent = `Reconnect "${result.name}"`;
    setStoreStatus(`"${result.name}" is remembered but the browser needs you to allow it again.`, 'is-warn');
    return;
  }
  if (result.state === 'unsupported') {
    setStoreStatus('This browser can save nothing: it has neither a folder picker nor writable browser storage. Use Export everything to keep your work, or open this page in a current Chrome, Edge, Firefox or Safari.', 'is-warn');
  }
}

function renderStore() {
  const kind = storage.backend();
  const where = storage.label();
  const decks = store.state.deckNames.length;
  const banked = store.state.manifest.length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /* Choosing a folder is only offered where folders exist. Elsewhere browser
     storage is already live and there is nothing to choose between. */
  $('store-choose').hidden = kind === 'folder' || !storage.SUPPORTS_FOLDER;
  $('store-disconnect').hidden = kind !== 'folder';
  $('store-export').hidden = !store.state.cards.length;
  $('store-hint').textContent = where || 'nothing is being saved';

  if (kind === 'folder') {
    setStoreStatus(`Saving to "${where}" — ${plural(decks, 'deck')}, ${plural(banked, 'banked sentence')}.`, 'is-ok');
  } else if (kind === 'browser') {
    /* Said every time, because these files are ones the user cannot go and
       copy: the only warning they will get is this line. */
    const risk = storage.isPersisted()
      ? 'Clearing site data for this page deletes it.'
      : 'The browser has not promised to keep it: clearing site data, or weeks without opening this page, deletes it.';
    setStoreStatus(`Saving in this browser — ${plural(decks, 'deck')}, ${plural(banked, 'banked sentence')}. ${risk}`, 'is-ok');
  } else if (storage.lostFolder()) {
    /* Different from never having chosen one: the data is still in that
       folder, and the way back is to point at it again. */
    setStoreStatus('Lost access to the data folder — it may have been moved, renamed, or its permission withdrawn. Nothing is being saved until you choose it again.', 'is-bad');
  } else if (!pendingHandle) {
    setStoreStatus('Nothing is being saved. The app still works, but a reload loses it.', '');
  }
  updateBar();
}

function setStoreStatus(text, cls) {
  const el = $('store-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

export function updateBar() {
  const el = $('bar-status');
  const where = storage.label();
  const s = store.state.settings;
  const bits = [s.targetLanguage || '—', where ? `saving to ${where}` : 'not saving'];
  if (!storage.getApiKey()) bits.push('no API key');
  el.textContent = bits.join('  ·  ');
  el.className = 'bar-status ' + (where ? 'is-live' : 'is-off');
}

/* ── key ─────────────────────────────────────────────────────────────── */

function wireKey() {
  const input = $('api-key');
  input.value = storage.getApiKey();
  input.addEventListener('input', () => {
    storage.setApiKey(input.value.trim());
    updateBar();
  });

  $('key-test').addEventListener('click', async () => {
    const btn = $('key-test');
    const note = $('key-test-note');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Testing';
    note.textContent = '';
    try {
      const reply = await store.client.testKey();
      note.textContent = `Working — ${store.state.settings.textModel} replied "${reply}".`;
      note.style.color = 'var(--ok)';
    } catch (e) {
      note.textContent = describe(e);
      note.style.color = 'var(--bad)';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test key';
      renderQuota();
    }
  });
}

export function describe(e) {
  if (e instanceof QuotaError) return `${e.message}`;
  if (e instanceof GeminiError) return e.message;
  return (e && e.message) || String(e);
}

/* ── plain fields ────────────────────────────────────────────────────── */

const FIELDS = [
  ['set-language', 'targetLanguage', 'text'],
  ['set-level', 'learnerLevel', 'text'],
  ['set-note', 'languageNote', 'text'],
  ['set-textmodel', 'textModel', 'text'],
  ['set-ttsmodel', 'ttsModel', 'text'],
  ['set-wmin', 'sentenceWords.min', 'int'],
  ['set-wmax', 'sentenceWords.max', 'int'],
  ['set-terms', 'termsPerSentence', 'int'],
  ['set-trpm', 'limits.textRpm', 'int'],
  ['set-trpd', 'limits.textRpd', 'int'],
  ['set-srpm', 'limits.ttsRpm', 'int'],
  ['set-srpd', 'limits.ttsRpd', 'int'],
];

function wireFields() {
  for (const [id, path, kind] of FIELDS) {
    $(id).addEventListener('change', () => {
      const raw = $(id).value;
      const value = kind === 'int' ? Math.max(0, Math.round(Number(raw) || 0)) : raw.trim();
      store.saveSettings(setPath(store.state.settings, path, value));
      renderPreview();
    });
  }
  $('quota-reset').addEventListener('click', () => { store.resetQuota(); renderQuota(); });
}

function setPath(settings, path, value) {
  const [head, tail] = path.split('.');
  if (!tail) return { [head]: value };
  return { [head]: { ...settings[head], [tail]: value } };
}

function getPath(settings, path) {
  const [head, tail] = path.split('.');
  return tail ? settings[head][tail] : settings[head];
}

function render() {
  const s = store.state.settings;
  for (const [id, path] of FIELDS) {
    const el = $(id);
    if (document.activeElement !== el) el.value = getPath(s, path);
  }
  const sp = $('set-prompt-sentence');
  const pp = $('set-prompt-speech');
  if (document.activeElement !== sp) sp.value = s.prompts.sentence;
  if (document.activeElement !== pp) pp.value = s.prompts.speech;
  renderVoices();
  renderPreview();
  updateBar();
}

/* ── prompts ─────────────────────────────────────────────────────────── */

function wirePrompts() {
  const sp = $('set-prompt-sentence');
  const pp = $('set-prompt-speech');
  sp.addEventListener('input', renderPreview);
  pp.addEventListener('input', renderPreview);
  sp.addEventListener('change', () => store.saveSettings({ prompts: { ...store.state.settings.prompts, sentence: sp.value } }));
  pp.addEventListener('change', () => store.saveSettings({ prompts: { ...store.state.settings.prompts, speech: pp.value } }));

  $('prompt-sentence-reset').addEventListener('click', () => {
    sp.value = DEFAULT_SENTENCE_PROMPT;
    store.saveSettings({ prompts: { ...store.state.settings.prompts, sentence: DEFAULT_SENTENCE_PROMPT } });
    renderPreview();
  });
  $('prompt-speech-reset').addEventListener('click', () => {
    pp.value = DEFAULT_SPEECH_PROMPT;
    store.saveSettings({ prompts: { ...store.state.settings.prompts, speech: DEFAULT_SPEECH_PROMPT } });
    renderPreview();
  });
}

function renderPreview() {
  const draft = draftSettings();
  const terms = store.state.cards.slice(0, 3).map((c) => ({ front: c.front, back: c.back }));
  const sample = terms.length ? terms : SAMPLE_TERMS;
  const sentence = fillTemplate(draft.prompts.sentence, sentenceVars(draft, sample));
  const spoken = fillTemplate(draft.prompts.speech, { sentence: '<the sentence it just wrote>' });

  const warnings = [];
  if (!draft.prompts.sentence.includes('{terms}')) {
    warnings.push('! The sentence prompt has no {terms} placeholder, so the model is never told which words to use.');
  }
  if (!draft.prompts.speech.includes('{sentence}')) {
    warnings.push('! The speech prompt has no {sentence} placeholder, so it will not read the sentence.');
  }

  $('prompt-preview').value = [
    ...(warnings.length ? [...warnings, ''] : []),
    `── to ${draft.textModel} ──`,
    sentence,
    '',
    `── to ${draft.ttsModel} ──`,
    spoken,
  ].join('\n');
}

/* The preview follows what is typed, before it is committed on blur. */
function draftSettings() {
  const s = store.state.settings;
  return {
    ...s,
    targetLanguage: $('set-language').value.trim() || s.targetLanguage,
    learnerLevel: $('set-level').value.trim() || s.learnerLevel,
    languageNote: $('set-note').value,
    textModel: $('set-textmodel').value.trim() || s.textModel,
    ttsModel: $('set-ttsmodel').value.trim() || s.ttsModel,
    sentenceWords: {
      min: Number($('set-wmin').value) || s.sentenceWords.min,
      max: Number($('set-wmax').value) || s.sentenceWords.max,
    },
    prompts: {
      sentence: $('set-prompt-sentence').value,
      speech: $('set-prompt-speech').value,
    },
  };
}

/* ── budget ──────────────────────────────────────────────────────────── */

function renderQuota() {
  const q = store.quotaReport();
  const s = store.state.settings;
  const line = (label, u) =>
    `${label} ${u.usedDay}/${u.rpd || '∞'} today, ${u.usedMinute}/${u.rpm || '∞'} this minute`;
  const parts = [line('text', q.text), line('speech', q.tts)];
  if (q.retryAfter > 0) parts.push(`blocked for ${formatWait(q.retryAfter)}`);

  const el = $('quota-status');
  el.textContent = parts.join('  ·  ');
  el.className = 'status ' + (q.retryAfter > 0 ? 'is-bad' : 'is-ok');
  $('quota-hint').textContent = q.cardsLeftToday === null
    ? 'unlimited'
    : `${q.cardsLeftToday} new card${q.cardsLeftToday === 1 ? '' : 's'} left`;
  void s;
}

/* ── the read-aloud voice ────────────────────────────────────────────── */

/* The browser's own voices, used by the Typing tab. Nothing here touches
   Gemini or the API budget — see speech.js. */
function wireSpeech() {
  $('set-speech-voice').addEventListener('change', (e) => {
    store.saveSettings({ speechVoice: e.target.value });
  });
  $('speech-sample').addEventListener('click', () => {
    /* A word from the deck being learnt says more than a stock phrase. */
    const card = store.practiceCards().find((c) => c.front) || null;
    const text = card ? card.front.replace(/\([^)]*\)/g, ' ') : 'Xin chào';
    speech.speak(text, speech.languageCode(store.state.settings.targetLanguage), { voice: store.state.settings.speechVoice });
  });
  store.subscribe('settings', renderSpeech);
  speech.onVoicesChanged(renderSpeech);
  renderSpeech();
}

function renderSpeech() {
  const s = store.state.settings;
  const code = speech.languageCode(s.targetLanguage);
  const list = speech.voicesFor(code);
  const sel = $('set-speech-voice');
  const chosen = s.speechVoice || '';
  const missing = chosen && !list.some((v) => v.name === chosen);
  sel.innerHTML = [
    `<option value="">Best available${list[0] ? ` (${escapeAttr(list[0].name)})` : ''}</option>`,
    ...list.map((v) => `<option value="${escapeAttr(v.name)}">${escapeAttr(v.name)} · ${escapeAttr(v.lang)}${v.localService ? '' : ' · online'}</option>`),
    ...(missing ? [`<option value="${escapeAttr(chosen)}">${escapeAttr(chosen)} · not installed here</option>`] : []),
  ].join('');
  sel.value = chosen;
  sel.disabled = !list.length;
  $('speech-sample').disabled = !list.length;

  const el = $('speech-status');
  if (!code) {
    el.textContent = `"${s.targetLanguage}" is not a language name this app knows a code for — try its English name, or a code such as "vi".`;
    el.className = 'status is-warn';
  } else if (!list.length) {
    el.textContent = `No ${s.targetLanguage} voice is installed on this device, so nothing is read aloud.`;
    el.className = 'status is-warn';
  } else if (missing) {
    el.textContent = `"${chosen}" is not installed on this device, so ${list[0].name} is used instead.`;
    el.className = 'status is-warn';
  } else {
    el.textContent = `${list.length} ${s.targetLanguage} voice${list.length === 1 ? '' : 's'} installed.`;
    el.className = 'status is-ok';
  }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ── the dictation voices ────────────────────────────────────────────── */

function wireVoices() {
  $('voice-grid').addEventListener('change', (e) => {
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    const on = new Set(store.state.settings.voices);
    if (box.checked) on.add(box.value);
    else {
      /* Something has to read the sentence out. */
      if (on.size <= 1) { box.checked = true; return; }
      on.delete(box.value);
    }
    store.saveSettings({ voices: [...on] });
  });

  $('voice-all').addEventListener('click', () => store.saveSettings({ voices: VOICES.map(([n]) => n) }));
  $('voice-none').addEventListener('click', () => store.saveSettings({ voices: [store.state.settings.fallbackVoice] }));
}

function renderVoices() {
  const on = new Set(store.state.settings.voices);
  const grid = $('voice-grid');
  if (!grid.childElementCount) {
    grid.innerHTML = VOICES.map(([name, style]) =>
      `<label class="voice"><input type="checkbox" value="${name}"><span>${name}</span><em>${style}</em></label>`).join('');
  }
  for (const box of grid.querySelectorAll('input')) box.checked = on.has(box.value);
  $('voice-hint').textContent = on.size === 1
    ? `only ${[...on][0]} — every sentence sounds the same`
    : `${on.size} of ${VOICES.length} in rotation`;
}
