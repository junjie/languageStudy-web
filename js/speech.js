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

const synth = typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null;

/* Some browsers fill the voice list a moment after load. */
let voices = [];
function loadVoices() { voices = synth ? synth.getVoices() : []; }
if (synth) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
}

export function onVoicesChanged(fn) {
  if (synth) synth.addEventListener?.('voiceschanged', fn);
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
  return !!voiceFor(code);
}

/* Speaks text, cutting off anything still being said. Returns false when
   there is no voice for the language. */
export function speak(text, code, { rate = 1, voice: name = '' } = {}) {
  const voice = voiceFor(code, name);
  if (!voice || !text) return false;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(String(text));
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = rate;
  synth.speak(u);
  return true;
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
  const missing = chosen && !list.some((v) => v.name === chosen);
  return [
    `<option value="">Best available${list[0] ? ` (${esc(list[0].name)})` : ''}</option>`,
    ...list.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · online'}</option>`),
    ...(missing ? [`<option value="${esc(chosen)}">${esc(chosen)} · not installed here</option>`] : []),
  ].join('');
}

export function stop() {
  if (synth) synth.cancel();
}
