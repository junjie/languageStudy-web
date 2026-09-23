/* Settings: where data is saved, the key, the language, the models, the
   budget, the prompts and the voices. */

import * as storage from './storage.js';
import * as store from './store.js';
import { VOICES, DEFAULT_SENTENCE_PROMPT, DEFAULT_SPEECH_PROMPT } from './defaults.js';
import { fillTemplate, sentenceVars, formatWait, GeminiError, QuotaError } from './gemini.js';
import { serializeDeck } from './deck.js';
import { serializeBundle, parseBundle, describeBundle, bundleFilename } from './bundle.js';

const $ = (id) => document.getElementById(id);

/* One handle kept aside when a folder is remembered but its permission has
   lapsed — requestPermission() is only allowed from a click. */
let pendingHandle = null;

/* A bundle that has been read and understood but not yet written anywhere.
   Importing is the one action here that can change every deck at once, so the
   file is described first and nothing happens until that is confirmed. */
let pendingBundle = null;

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
    try {
      if (pendingHandle) {
        const ok = await storage.regrant(pendingHandle);
        if (!ok) { setStoreStatus('Permission refused — nothing is being saved.', 'is-warn'); return; }
        pendingHandle = null;
      } else {
        await storage.connect();
      }
      await store.adoptFolder();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error(e);
      setStoreStatus('Could not open that folder: ' + e.message, 'is-bad');
    }
  });

  $('store-disconnect').addEventListener('click', async () => {
    await storage.disconnect();
    store.releaseFolder();
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
    pendingBundle = parsed.bundle;
    showImport(`${file.name} holds ${describeBundle(parsed.bundle)}. Importing adds these decks alongside the ones you have — nothing is replaced or overwritten, and a name already in use gets a free one.`);
  });

  $('import-confirm').addEventListener('click', async () => {
    const bundle = pendingBundle;
    pendingBundle = null;
    showImport(null);
    if (!bundle) return;
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
    pendingBundle = null;
    showImport(null);
    setStoreStatus('Import cancelled — nothing was changed.', '');
  });
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
    setStoreStatus('This browser can save nothing: it has neither a folder picker nor writable browser storage. Use the deck download button, or a current Chrome, Edge, Firefox or Safari.', 'is-warn');
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

/* ── voices ──────────────────────────────────────────────────────────── */

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
