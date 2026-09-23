/* Shared state: the settings, every deck, and the API budget.

   Tabs read from here and call save*(); they never touch the folder
   themselves. Subscribers are notified after every change so, for example,
   editing a deck in the Flashcards tab immediately changes what the practice
   tabs draw from.

   Two different questions get asked about decks and they have different
   answers:

     state.deckName / state.cards   the one deck open in the Flashcards editor
     practiceDecks() / practiceCards()
                                    the decks ticked for practice, which the
                                    Typing and Dictation tabs draw from

   Every deck in the folder is held in state.decks, because practice spans
   several of them at once and a card answered in one must be written back to
   its own file — never to whichever deck happens to be open. */

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
  /* name -> cards. The one store of card objects; state.cards is a window
     onto the open deck rather than a second copy of it. */
  decks: { default: STARTER_DECK.map(normalizeCard) },
  manifest: [],
  /* True once a folder is connected: until then everything is in memory and
     is lost on reload, which the UI has to keep saying out loud. */
  persistent: false,

  get cards() { return this.decks[this.deckName] || []; },
  set cards(cards) { this.decks[this.deckName] = cards; },
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

/* Which deck a card came from. Kept beside the cards rather than on them: a
   `deck` key on the card would be written straight into the deck file by the
   next save, and the deck file is something people read and diff. */
const cardDeck = new WeakMap();

function adopt(name, cards) {
  for (const card of cards) cardDeck.set(card, name);
  state.decks[name] = cards;
  return cards;
}

export function deckOf(card) {
  return cardDeck.get(card) || state.deckName;
}

async function readDeckFile(name) {
  const text = await storage.readText(deckPath(name));
  if (text === null) return null;
  const parsed = parseDeck(text);
  if (parsed.error) {
    console.error(`decks/${name}.json: ${parsed.error}`);
    return null;
  }
  return parsed.cards;
}

export async function loadDeck(name) {
  if (!state.persistent) return false;
  const cards = await readDeckFile(name);
  if (!cards) return false;
  adopt(name, cards);
  state.deckName = name;
  storage.localSet('lastDeck', name);
  emit('deck');
  return true;
}

export async function saveDeck(name = state.deckName) {
  if (!state.persistent) { emit('deck'); return true; }
  const ok = await storage.writeText(deckPath(name), serializeDeck(state.decks[name] || []));
  emit('deck');
  return ok;
}

/* Called by the practice tabs after recordResult() has already mutated the
   cards in place. Each card is written back to the deck it came from, which
   in a multi-deck session is rarely the one open in the editor. */
export async function cardAnswered(...cards) {
  const names = new Set(cards.filter(Boolean).map(deckOf));
  if (!names.size) names.add(state.deckName);
  let ok = true;
  for (const name of names) ok = (await saveDeck(name)) && ok;
  return ok;
}

export async function refreshDeckList() {
  state.deckNames = state.persistent ? await storage.listDecks() : [state.deckName];
  for (const name of Object.keys(state.decks)) {
    if (name !== state.deckName && !state.deckNames.includes(name)) delete state.decks[name];
  }
  emit('deck');
  return state.deckNames;
}

export async function createDeck(label, cards) {
  const name = uniqueDeckName(slugify(label));
  adopt(name, (cards || []).map(normalizeCard));
  state.deckName = name;
  await saveDeck(name);
  await refreshDeckList();
  storage.localSet('lastDeck', name);
  /* A deck you just made is one you meant to study, so it starts ticked. */
  await setPracticeDecks([...practiceDecks(), name]);
  emit('deck');
  return name;
}

export async function renameDeck(label) {
  const next = uniqueDeckName(slugify(label));
  const previous = state.deckName;
  if (next === previous) return previous;
  adopt(next, state.decks[previous] || []);
  delete state.decks[previous];
  state.deckName = next;
  await saveDeck(next);
  if (state.persistent) await storage.remove(deckPath(previous));
  await refreshDeckList();
  storage.localSet('lastDeck', next);
  /* The tick follows the deck across the rename; it is the same deck. */
  const ticked = state.settings.practiceDecks || [];
  if (ticked.includes(previous)) {
    await setPracticeDecks(ticked.map((n) => (n === previous ? next : n)));
  }
  return next;
}

export async function deleteDeck() {
  const gone = state.deckName;
  if (state.persistent) await storage.remove(deckPath(gone));
  delete state.decks[gone];
  await refreshDeckList();
  const next = state.deckNames.find((n) => n !== gone);
  if (next) await loadDeck(next);
  else await createDeck('default', STARTER_DECK);
  await setPracticeDecks((state.settings.practiceDecks || []).filter((n) => n !== gone));
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
  adopt(state.deckName, cards);
  emit('deck');
}

/* ── which decks practice draws from ─────────────────────────────────── */

/* Derived, never stored as truth: the saved list is filtered through the decks
   that actually exist, so a deck deleted or renamed behind the app's back
   cannot leave practice pointing at nothing. The result is never empty — with
   no valid tick left, the open deck stands in, because "no decks selected"
   is a state with no useful behaviour behind it. */
export function practiceDecks() {
  const names = state.deckNames.length ? state.deckNames : [state.deckName];
  const wanted = state.settings.practiceDecks || [];
  const kept = names.filter((n) => wanted.includes(n));
  if (kept.length) return kept;
  return [names.includes(state.deckName) ? state.deckName : names[0]];
}

export function isPracticeDeck(name) {
  return practiceDecks().includes(name);
}

/* Refuses to leave the selection empty — the caller gets back what is actually
   in force, so a UI that tried to untick the last deck can put the tick back. */
export async function setPracticeDecks(names) {
  const list = (state.deckNames.length ? state.deckNames : [state.deckName])
    .filter((n) => names.includes(n));
  if (!list.length) return practiceDecks();
  await saveSettings({ practiceDecks: list });
  emit('deck');
  return practiceDecks();
}

/* Every card practice may draw from, in deck order. */
export function practiceCards() {
  const out = [];
  for (const name of practiceDecks()) out.push(...(state.decks[name] || []));
  return out;
}

/* The same, split by deck — for the one exercise that must not mix decks. */
export function practiceGroups() {
  return practiceDecks()
    .map((name) => ({ name, cards: state.decks[name] || [] }))
    .filter((g) => g.cards.length);
}

/* Find a card by its front text. The deck it was recorded against is tried
   first, so two decks that share a word still score the right card. */
export function findCard(front, preferred) {
  for (const name of [preferred, ...practiceDecks()]) {
    if (!name) continue;
    const hit = (state.decks[name] || []).find((c) => c.front === front);
    if (hit) return { card: hit, deck: name };
  }
  return null;
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

  /* Every deck, not just the open one: practice spans whichever are ticked,
     and a deck cannot be drawn from until its cards are in hand. */
  state.decks = {};
  for (const name of names) adopt(name, (await readDeckFile(name)) || []);

  const preferred = storage.localGet('lastDeck', null);
  const pick = names.includes(preferred) ? preferred : names[0];
  state.deckName = pick;
  storage.localSet('lastDeck', pick);

  emit('settings');
  emit('deck');
  emit('folder');
  emit('quota');
}

export function releaseFolder() {
  const open = state.cards;
  state.persistent = false;
  state.manifest = [];
  state.deckNames = [state.deckName];
  /* Only the open deck is still in memory, so it is the only thing practice
     can honestly be said to draw from. */
  state.decks = {};
  adopt(state.deckName, open);
  emit('folder');
  emit('deck');
}

/* Boot with whatever can be had without a folder, so the page is usable the
   moment it loads: the starter deck, defaults, and any settings remembered
   from a previous in-memory session. */
export function bootLocal() {
  state.settings = withDefaults(storage.localGet('settings', null));
  limiter.setState(storage.localGet('quota', null));
  state.deckName = 'default';
  state.decks = {};
  adopt('default', STARTER_DECK.map(normalizeCard));
  state.deckNames = ['default'];
  emit('settings');
  emit('deck');
  emit('quota');
}

export { DEFAULT_SETTINGS };
