/* The browser's own text-to-speech, and the language codes it needs.

   This is not Gemini. Typing practice reads every card aloud, many times a
   session, and that must cost nothing and start instantly — which the
   browser's built-in voices do, offline. Gemini's voices are kept for
   dictation, where a fresh sentence is worth a call.

   Voices come from the operating system. macOS and iOS ship a Vietnamese one
   (Linh), and most languages have at least one; where none is installed the
   caller is told, and nothing is spoken. */

/* English names people type into Settings, to BCP 47 codes. A code typed
   directly ("vi", "pt-BR") is used as it is. */
const CODES = {
  arabic: 'ar', cantonese: 'zh-HK', chinese: 'zh', czech: 'cs', danish: 'da',
  dutch: 'nl', english: 'en', filipino: 'fil', finnish: 'fi', french: 'fr',
  german: 'de', greek: 'el', hebrew: 'he', hindi: 'hi', hungarian: 'hu',
  indonesian: 'id', italian: 'it', japanese: 'ja', korean: 'ko', malay: 'ms',
  mandarin: 'zh-CN', norwegian: 'nb', polish: 'pl', portuguese: 'pt',
  romanian: 'ro', russian: 'ru', spanish: 'es', swedish: 'sv', tagalog: 'fil',
  thai: 'th', turkish: 'tr', ukrainian: 'uk', vietnamese: 'vi',
};

export function languageCode(name) {
  const s = String(name || '').trim();
  const known = CODES[s.toLowerCase()];
  if (known) return known;
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(s) ? s : '';
}

import * as azure from './azure-tts.js';

const synth = typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null;

/* Some browsers fill the voice list a moment after load. */
let voices = [];
function loadVoices() { voices = synth ? synth.getVoices() : []; }
if (synth) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
}

/* Told when either list of voices changes: the device's, or Azure's. */
const voiceListeners = new Set();
export function onVoicesChanged(fn) {
  voiceListeners.add(fn);
  if (synth) synth.addEventListener?.('voiceschanged', fn);
}
function voicesChanged() {
  for (const fn of voiceListeners) { try { fn(); } catch (e) { console.error(e); } }
}

/* ── Azure neural voices, when the user has given a key ─────────────────

   A chosen Azure voice is stored as "azure:<ShortName>", beside the device
   voice names, so one setting says which voice reads. */

export const AZURE_PREFIX = 'azure:';
const azureState = { region: azure.DEFAULT_REGION, code: '', voices: [], problem: '' };

export function azureStatus() {
  return { ...azureState, key: !!azure.getKey() };
}

/* Fetches the Azure voices for a language. Called at boot and whenever the
   key, region or language changes; with no key it just empties the list. */
export async function loadAzure(region, code) {
  azureState.region = azure.cleanRegion(region) || azure.DEFAULT_REGION;
  azureState.code = code;
  azureState.problem = '';
  const key = azure.getKey();
  if (!key || !code) {
    azureState.voices = [];
    voicesChanged();
    return azureState;
  }
  try {
    azureState.voices = await azure.listVoices({ region: azureState.region, key, code });
  } catch (e) {
    azureState.voices = [];
    azureState.problem = e.message;
  }
  voicesChanged();
  return azureState;
}

function azureVoicesFor(code) {
  const lang = String(code || '').toLowerCase().split('-')[0];
  return azureState.voices.filter((v) => v.locale.toLowerCase().split('-')[0] === lang);
}

/* Every installed voice for a code, best first: an exact region match before
   the rest of the language, and within those a downloaded higher-quality voice
   ("Linh (Enhanced)") before the compact default, on-device before remote. */
export function voicesFor(code) {
  if (!synth || !code) return [];
  if (!voices.length) loadVoices();
  const want = code.toLowerCase();
  const lang = want.split('-')[0];
  const norm = (v) => String(v.lang || '').toLowerCase().replace('_', '-');
  const rank = (v) => (norm(v) === want ? 4 : 0)
    + (/enhanced|premium/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return voices
    .filter((v) => norm(v).split('-')[0] === lang)
    .sort((a, b) => rank(b) - rank(a));
}

/* The chosen voice if it is still installed, else the best there is. */
export function voiceFor(code, name = '') {
  const list = voicesFor(code);
  return (name && list.find((v) => v.name === name)) || list[0] || null;
}

export function canSpeak(code) {
  return !!voiceFor(code) || azureVoicesFor(code).length > 0;
}

/* Speaks text, cutting off anything still being said. Returns false when
   there is no voice for the language. An Azure voice is used when one is
   chosen and a key is set — or when the device has no voice for the
   language at all. */
export function speak(text, code, { rate = 1, voice: name = '' } = {}) {
  if (!text) return false;
  const azureVoices = azureVoicesFor(code);
  const wanted = name.startsWith(AZURE_PREFIX) ? name.slice(AZURE_PREFIX.length) : '';
  const pick = (wanted && azureVoices.find((v) => v.name === wanted))
    || (!voiceFor(code) && azureVoices[0]) || null;
  if (pick && azure.getKey()) {
    speakAzure(String(text), pick, rate, code);
    return true;
  }
  return speakDevice(text, code, rate, name);
}

function speakDevice(text, code, rate, name) {
  const voice = voiceFor(code, name.startsWith(AZURE_PREFIX) ? '' : name);
  if (!voice) return false;
  stop();
  const u = new SpeechSynthesisUtterance(String(text));
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = rate;
  synth.speak(u);
  return true;
}

/* Each text is fetched once per session and replayed from memory after
   that, so Listen again and a card coming round again cost nothing. */
const azureCache = new Map();
let player = null;
let latest = 0;

async function speakAzure(text, voice, rate, code) {
  stop();
  const ticket = ++latest;
  const cacheKey = `${voice.name}\n${text}`;
  try {
    if (!azureCache.has(cacheKey)) {
      const fetching = azure.synthesize({
        region: azureState.region, key: azure.getKey(), voice: voice.name, locale: voice.locale, text,
      }).then((blob) => URL.createObjectURL(blob));
      azureCache.set(cacheKey, fetching);
      fetching.catch(() => azureCache.delete(cacheKey));
    }
    const url = await azureCache.get(cacheKey);
    /* Something else was asked for while this one was on its way. */
    if (ticket !== latest) return;
    player = new Audio(url);
    player.playbackRate = rate;
    await player.play();
    azureState.problem = '';
  } catch (e) {
    if (e && e.name === 'NotAllowedError') return;   // autoplay refused: Listen again will play it
    /* Fall back to the device's voice, and say why in Settings. */
    azureState.problem = e.message || String(e);
    voicesChanged();
    if (ticket === latest) speakDevice(text, code, rate, '');
  }
}

/* Speaking speed. 1 is the voice's own pace, which on some systems —
   Windows voices in Chrome and Edge especially — is brisk for a learner. */
export const RATE = { min: 0.5, max: 1.5, step: 0.05, default: 1 };

export function clampRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return RATE.default;
  const stepped = Math.round(r / RATE.step) * RATE.step;
  /* Two decimals, so 0.85 is 0.85 and not 0.8500000000000001. */
  return Math.min(RATE.max, Math.max(RATE.min, Number(stepped.toFixed(2))));
}

export function rateLabel(rate) {
  return `${Number(clampRate(rate).toFixed(2))}×`;
}

/* The <option>s for a voice picker: "Best available" first, then every
   installed voice for the language, and the chosen one kept on the list
   even when this device lacks it, so picking on one machine is not undone
   by opening the app on another. */
export function voiceOptions(code, chosen = '') {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const list = voicesFor(code);
  const cloud = azure.getKey() ? azureVoicesFor(code) : [];
  const known = [...list.map((v) => v.name), ...cloud.map((v) => AZURE_PREFIX + v.name)];
  const missing = chosen && !known.includes(chosen);
  const best = list[0] ? list[0].name : cloud[0] ? `${cloud[0].label} · Azure` : '';
  const device = list.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · online'}</option>`);
  const neural = cloud.map((v) => `<option value="${esc(AZURE_PREFIX + v.name)}">${esc(v.label)} · ${esc(v.locale)}${v.gender ? ` · ${esc(v.gender.toLowerCase())}` : ''}</option>`);
  return [
    `<option value="">Best available${best ? ` (${esc(best)})` : ''}</option>`,
    ...(neural.length ? [`<optgroup label="This device">`, ...device, '</optgroup>', `<optgroup label="Azure neural voices (your key)">`, ...neural, '</optgroup>'] : device),
    ...(missing ? [`<option value="${esc(chosen)}">${esc(chosen.replace(AZURE_PREFIX, ''))} · ${chosen.startsWith(AZURE_PREFIX) ? 'needs your Azure key' : 'not installed here'}</option>`] : []),
  ].join('');
}

/* Silences whatever is speaking, and anything still being fetched. */
export function stop() {
  latest++;
  if (synth) synth.cancel();
  if (player) { player.pause(); player = null; }
}
