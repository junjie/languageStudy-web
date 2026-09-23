/* One file that holds everything: the bundle.

   A folder can be copied. Browser storage cannot — no file manager shows it,
   and clearing site data takes it. So there has to be one artefact that carries
   a whole setup out of the app and back in: to another machine, to a Drive
   folder, or just to safety before Safari decides the page has not been opened
   in a while.

   It is a JSON object, and a readable one, because that is the promise the deck
   files already make:

     {
       "app": "language-study-web",
       "bundle": 1,
       "exported": "2026-09-23T09:15:00.000Z",
       "settings": { ... },
       "decks": { "default": [ {card}, ... ], "verbs": [ ... ] }
     }

   Each deck is exactly the array its own file holds, so a bundle can be taken
   apart with a text editor and a deck lifted straight out of it.

   Two things are deliberately left out:

     the API key      it is not app state, it is a credential, and a bundle is
                      the kind of file people mail to themselves
     the audio bank   the audio files are the bulk of a setup by an order of
                      magnitude, and base64 inside a JSON document is the wrong
                      place for them. The manifest goes with them rather than
                      being imported as an index of sentences whose audio is
                      missing; the bank is a cache the dictation tab refills.

   Nothing here touches the browser, so it is all testable in node. */

import { parseDeck, serializeDeck, normalizeCard } from './deck.js';

export const BUNDLE_VERSION = 1;
const APP = 'language-study-web';

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ── out ─────────────────────────────────────────────────────────────── */

/* decks is [[name, cards], ...] in the order they should appear. */
export function makeBundle({ settings, decks, now = new Date() }) {
  const out = {
    app: APP,
    bundle: BUNDLE_VERSION,
    exported: now.toISOString(),
    note: 'Decks and settings. The API key and the dictation audio bank are not included.',
    decks: {},
  };
  if (settings) out.settings = settings;
  for (const [name, cards] of decks) {
    /* Through serializeDeck so the cards are written exactly as their own file
       would write them — same keys, same order, one place deciding it. */
    out.decks[name] = JSON.parse(serializeDeck(cards));
  }
  return out;
}

/* The same fold serializeDeck applies: a card's history is eight booleans and
   is worth one line, not eight. */
export function serializeBundle(bundle) {
  return JSON.stringify(bundle, null, 2)
    .replace(/"recent": \[[^\]]*\]/g, (m) => m.replace(/\s+/g, ' ').replace('[ ', '[').replace(' ]', ']'))
    + '\n';
}

export function bundleFilename(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  return `language-study-${stamp}.json`;
}

/* ── in ──────────────────────────────────────────────────────────────── */

/* Returns {bundle} or {error}, never throws. The bundle it returns holds decks
   as [[name, cards], ...]: order is worth keeping, and a plain array cannot
   collide with a deck called "constructor".

   Every error names what the file actually looks like, because the one mistake
   worth expecting is picking the wrong JSON — this app hands out single deck
   files too. */
export function parseBundle(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: 'it is not valid JSON.' };
  }
  if (Array.isArray(data)) {
    return { error: 'it is a single deck, not a bundle. Open the Flashcards tab and paste it into the deck editor instead.' };
  }
  if (!data || typeof data !== 'object') {
    return { error: 'a bundle is a JSON object, and this is not one.' };
  }
  const version = Number(data.bundle);
  if (Number.isFinite(version) && version > BUNDLE_VERSION) {
    return { error: `it was written by a newer version of this app (format ${version}; this one reads ${BUNDLE_VERSION}).` };
  }
  if (data.decks !== undefined && (!data.decks || typeof data.decks !== 'object' || Array.isArray(data.decks))) {
    return { error: 'its "decks" is not a set of named decks.' };
  }
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    return { error: 'its "settings" is not an object.' };
  }

  const decks = [];
  for (const [name, cards] of Object.entries(data.decks || {})) {
    if (!Array.isArray(cards)) return { error: `deck "${name}" is not a list of cards.` };
    /* Back through the deck parser, so a bundle is held to exactly the standard
       a deck file is and says the same thing when a card is malformed. */
    const parsed = parseDeck(JSON.stringify(cards));
    if (parsed.error) return { error: `deck "${name}" ${lower(parsed.error)}` };
    decks.push([name, parsed.cards]);
  }

  if (!decks.length && !data.settings) {
    return { error: 'it holds no decks and no settings.' };
  }

  return {
    bundle: {
      version: Number.isFinite(version) ? version : null,
      exported: typeof data.exported === 'string' ? data.exported : null,
      settings: data.settings || null,
      decks,
    },
  };
}

function lower(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/* What the user is about to import, in one line, shown before anything is
   written. */
export function describeBundle(bundle) {
  const cards = bundle.decks.reduce((n, [, list]) => n + list.length, 0);
  const bits = [];
  if (bundle.decks.length) bits.push(`${plural(bundle.decks.length, 'deck')} (${plural(cards, 'card')})`);
  if (bundle.settings) {
    const language = String(bundle.settings.targetLanguage || '').trim();
    bits.push(language ? `settings for ${language}` : 'settings');
  }
  if (bundle.exported) bits.push(`exported ${bundle.exported.slice(0, 10)}`);
  return bits.join(', ');
}

/* Cards straight from a bundle, normalized the way a deck file's would be. */
export function bundleCards(cards) {
  return cards.map(normalizeCard);
}
