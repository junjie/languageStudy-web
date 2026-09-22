/* Shared state: the settings, the open deck, and the API budget.

   Tabs read from here and call save*(); they never touch the folder
   themselves. Subscribers are notified after every change so, for example,
   editing a deck in the Flashcards tab immediately changes what the practice
   tabs draw from. */

import * as storage from './storage.js';
import { withDefaults, STARTER_DECK, DEFAULT_SETTINGS } from './defaults.js';
import { parseDeck, serializeDeck, normalizeCard, slugify } from './deck.js';
import { RateLimiter, createClient } from './gemini.js';

const SETTINGS_FILE = 'settings.json';
const QUOTA_FILE = 'audio/quota.json';
const MANIFEST_FILE = 'audio/manifest.json';

export const state = {
  settings: withDefaults(null),
  deckName: 'default',
  deckNames: [],
  cards: STARTER_DECK.map(normalizeCard),
  manifest: [],
  /* True once a folder is connected: until then everything is in memory and
     is lost on reload, which the UI has to keep saying out loud. */
  persistent: false,
};

const subs = { settings: new Set(), deck: new Set(), folder: new Set(), quota: new Set() };

export function subscribe(topic, fn) {
  subs[topic].add(fn);
  return () => subs[topic].delete(fn);
}

function emit(topic) {
  for (const fn of subs[topic]) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

/* ── the API budget ──────────────────────────────────────────────────── */

export const limiter = new RateLimiter({
  save: (s) => {
    if (state.persistent) storage.writeJson(QUOTA_FILE, s);
    else storage.localSet('quota', s);
    emit('quota');
  },
});

export const client = createClient({
  getSettings: () => state.settings,
  getApiKey: storage.getApiKey,
  limiter,
});

export function quotaReport() {
  return limiter.report(state.settings);
}

export function resetQuota() {
  limiter.reset();
  emit('quota');
}

/* ── settings ────────────────────────────────────────────────────────── */

export async function saveSettings(patch) {
  state.settings = withDefaults({ ...state.settings, ...patch });
  if (state.persistent) await storage.writeJson(SETTINGS_FILE, state.settings);
  else storage.localSet('settings', state.settings);
  emit('settings');
}

/* ── decks ───────────────────────────────────────────────────────────── */

function deckPath(name) {
  return `decks/${name}.json`;
}

export async function loadDeck(name) {
  if (!state.persistent) return false;
  const text = await storage.readText(deckPath(name));
  if (text === null) return false;
  const parsed = parseDeck(text);
  if (parsed.error) {
    console.error(`decks/${name}.json: ${parsed.error}`);
    return false;
  }
  state.deckName = name;
  state.cards = parsed.cards;
  storage.localSet('lastDeck', name);
  emit('deck');
  return true;
}

export async function saveDeck() {
  if (!state.persistent) { emit('deck'); return true; }
  const ok = await storage.writeText(deckPath(state.deckName), serializeDeck(state.cards));
  emit('deck');
  return ok;
}

/* Called by the practice tabs after recordResult() has already mutated the
   card in place. */
export function cardAnswered() {
  return saveDeck();
}

export async function refreshDeckList() {
  state.deckNames = state.persistent ? await storage.listDecks() : [state.deckName];
  emit('deck');
  return state.deckNames;
}

export async function createDeck(label, cards) {
  const name = uniqueDeckName(slugify(label));
  state.deckName = name;
  state.cards = (cards || []).map(normalizeCard);
  await saveDeck();
  await refreshDeckList();
  storage.localSet('lastDeck', name);
  emit('deck');
  return name;
}

export async function renameDeck(label) {
  const next = uniqueDeckName(slugify(label));
  const previous = state.deckName;
  state.deckName = next;
  await saveDeck();
  if (state.persistent && previous !== next) await storage.remove(deckPath(previous));
  await refreshDeckList();
  storage.localSet('lastDeck', next);
  return next;
}

export async function deleteDeck() {
  const gone = state.deckName;
  if (state.persistent) await storage.remove(deckPath(gone));
  await refreshDeckList();
  const next = state.deckNames.find((n) => n !== gone);
  if (next) await loadDeck(next);
  else await createDeck('default', STARTER_DECK);
  return state.deckName;
}

function uniqueDeckName(base) {
  const taken = new Set(state.deckNames.filter((n) => n !== state.deckName));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function setCards(cards) {
  state.cards = cards;
  emit('deck');
}

/* ── the dictation bank ──────────────────────────────────────────────── */

export async function saveManifest() {
  if (state.persistent) await storage.writeJson(MANIFEST_FILE, state.manifest);
}

/* ── connecting ──────────────────────────────────────────────────────── */

/* Read everything the folder holds, creating what a fresh folder lacks.
   A folder is adopted exactly as it is found: this never overwrites a deck or
   a settings file that is already there. */
export async function adoptFolder() {
  state.persistent = true;
  await storage.ensureSubdirs();

  const loadedSettings = await storage.readJson(SETTINGS_FILE);
  state.settings = withDefaults(loadedSettings || storage.localGet('settings', null));
  if (!loadedSettings) await storage.writeJson(SETTINGS_FILE, state.settings);

  const quota = await storage.readJson(QUOTA_FILE);
  limiter.setState(quota || storage.localGet('quota', null));

  state.manifest = (await storage.readJson(MANIFEST_FILE)) || [];
  if (!Array.isArray(state.manifest)) state.manifest = [];

  let names = await storage.listDecks();
  if (!names.length) {
    await storage.writeText(deckPath('default'), serializeDeck(STARTER_DECK.map(normalizeCard)));
    names = ['default'];
  }
  state.deckNames = names;

  const preferred = storage.localGet('lastDeck', null);
  const pick = names.includes(preferred) ? preferred : names[0];
  if (!(await loadDeck(pick))) {
    state.deckName = pick;
    state.cards = STARTER_DECK.map(normalizeCard);
  }

  emit('settings');
  emit('deck');
  emit('folder');
  emit('quota');
}

export function releaseFolder() {
  state.persistent = false;
  state.manifest = [];
  state.deckNames = [state.deckName];
  emit('folder');
  emit('deck');
}

/* Boot with whatever can be had without a folder, so the page is usable the
   moment it loads: the starter deck, defaults, and any settings remembered
   from a previous in-memory session. */
export function bootLocal() {
  state.settings = withDefaults(storage.localGet('settings', null));
  limiter.setState(storage.localGet('quota', null));
  state.cards = STARTER_DECK.map(normalizeCard);
  state.deckNames = ['default'];
  emit('settings');
  emit('deck');
  emit('quota');
}

export { DEFAULT_SETTINGS };
