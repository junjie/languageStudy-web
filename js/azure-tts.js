/* Azure AI Speech: Microsoft's neural voices, with the user's own key.

   The device's voices (speech.js) cost nothing and work offline, but what a
   device offers varies a great deal — Safari on a Mac has one compact
   Vietnamese voice, Windows a brisk one. Azure has the same natural-sounding
   neural voices everywhere, and a free tier of half a million characters a
   month, which is many passes through a large deck.

   It is called straight from the page, like Gemini: the text-to-speech
   endpoints answer CORS preflights for the key header from any origin, so
   there is still no server. The key is the user's and lives in localStorage
   beside the Gemini key — never in the data directory, a backup or a bundle.
   The region is not a secret and is an ordinary setting.

   Everything here is plain functions over fetch, so node --test covers it. */

const KEY_STORAGE = 'lsw.azureSpeechKey';

export const DEFAULT_REGION = 'southeastasia';

/* Compressed and small: a word is a few kilobytes, and every card's audio
   is kept for the session. */
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export class AzureError extends Error {}

export function getKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}

export function setKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch (e) { /* private mode; the key just will not be remembered */ }
}

/* A region is a short lowercase id, "southeastasia". Anything else would be
   spliced into a hostname, so it is refused rather than escaped. */
export function cleanRegion(region) {
  const r = String(region || '').trim().toLowerCase().replace(/\s+/g, '');
  return /^[a-z0-9]{2,40}$/.test(r) ? r : '';
}

function base(region) {
  const r = cleanRegion(region);
  if (!r) throw new AzureError('The Azure region is missing or not a region id, such as "southeastasia".');
  return `https://${r}.tts.speech.microsoft.com/cognitiveservices`;
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function ssml(text, voice, locale) {
  return `<speak version="1.0" xml:lang="${xml(locale)}"><voice name="${xml(voice)}">${xml(text)}</voice></speak>`;
}

/* The service's own words, which say more than a status code — a wrong key
   and a spent free tier both come back as something readable. */
async function failure(res) {
  const why = {
    401: 'Azure refused the key. Check it, and that the region matches the one the key was made in.',
    403: 'Azure refused the key for this resource.',
    429: 'Azure says the free allowance or the rate limit is used up for now.',
  }[res.status];
  let detail = '';
  try { detail = (await res.text()).trim().slice(0, 200); } catch (e) { /* none */ }
  return new AzureError(why || `Azure answered ${res.status}${detail ? `: ${detail}` : ''}.`);
}

/* Every voice for a language code ("vi" or "vi-VN"), neural voices only. */
export async function listVoices({ region, key, code, fetchImpl = fetch }) {
  if (!key) throw new AzureError('No Azure key.');
  const res = await fetchImpl(`${base(region)}/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': key } });
  if (!res.ok) throw await failure(res);
  const all = await res.json();
  return filterVoices(all, code);
}

export function filterVoices(all, code) {
  const want = String(code || '').toLowerCase();
  const lang = want.split('-')[0];
  if (!lang) return [];
  return (Array.isArray(all) ? all : [])
    .filter((v) => v && v.ShortName && String(v.Locale || '').toLowerCase().split('-')[0] === lang)
    .filter((v) => !v.VoiceType || v.VoiceType === 'Neural')
    .map((v) => ({ name: v.ShortName, label: v.DisplayName || v.ShortName, locale: v.Locale, gender: v.Gender || '' }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* The text as far as the sound is concerned, for the fingerprint below.
   Text that reads the same must land on the same clip, whatever produced
   it: letters stored one standard way (NFC — "ệ" can arrive as one
   character or as e plus two marks, depending on where it was typed or
   pasted from), case ignored, runs of spaces collapsed and the ends
   trimmed. Accents stay: "biệt" and "biết" are different words. So does
   punctuation, since it changes how a line is read — "đi đâu?" rises. */
export function spokenForm(text) {
  return String(text || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* The file a clip is saved under: the voice, then a fingerprint of the voice
   and the spoken form of the text. The same word in the same voice always
   lands on the same name, so a saved clip is found again without an index,
   and is shared by every card that has that word. */
export async function clipName(voice, text) {
  const bytes = new TextEncoder().encode(`${voice}\n${spokenForm(text)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${voice}_${hex}.mp3`;
}

/* One piece of text, as an mp3 Blob. */
export async function synthesize({ region, key, voice, locale, text, fetchImpl = fetch }) {
  if (!key) throw new AzureError('No Azure key.');
  const res = await fetchImpl(`${base(region)}/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
    },
    body: ssml(text, voice, locale),
  });
  if (!res.ok) throw await failure(res);
  return res.blob();
}
