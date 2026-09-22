/* Flashcards: the deck file, shown as itself.

   The textarea holds exactly what is on disk. There is no form over the top of
   it and no hidden second file — what you read is the storage format, which is
   the point: a deck can be written, pasted or diffed anywhere. */

import * as store from './store.js';
import { parseDeck, serializeDeck, importWatchlist, stats, SCORE_LABEL } from './deck.js';

const $ = (id) => document.getElementById(id);

let dirty = false;

export function init() {
  const editor = $('deck-editor');

  editor.addEventListener('input', () => { dirty = true; validate(); });
  editor.addEventListener('keydown', (e) => {
    /* Tab indents rather than leaving the field — this is a code editor for
       as long as the user is in it. */
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = editor;
      editor.value = value.slice(0, a) + '  ' + value.slice(b);
      editor.selectionStart = editor.selectionEnd = a + 2;
      dirty = true;
      validate();
    }
  });

  $('deck-save').addEventListener('click', save);
  $('deck-revert').addEventListener('click', () => { load(); });
  $('deck-format').addEventListener('click', () => {
    const parsed = parseDeck(editor.value);
    if (parsed.error) { validate(); return; }
    editor.value = serializeDeck(parsed.cards);
    validate();
  });

  $('deck-select').addEventListener('change', async (e) => {
    if (!(await confirmDiscard())) { e.target.value = store.state.deckName; return; }
    await store.loadDeck(e.target.value);
    load();
  });

  $('deck-new').addEventListener('click', async () => {
    if (!(await confirmDiscard())) return;
    const label = prompt('Name for the new deck:', 'new deck');
    if (!label) return;
    await store.createDeck(label, []);
    load();
  });

  $('deck-rename').addEventListener('click', async () => {
    const label = prompt('Rename this deck to:', store.state.deckName);
    if (!label) return;
    await store.renameDeck(label);
    load();
  });

  $('deck-delete').addEventListener('click', async () => {
    if (!confirm(`Delete the deck "${store.state.deckName}" and everything in it?`)) return;
    await store.deleteDeck();
    dirty = false;
    load();
  });

  $('deck-import').addEventListener('click', doImport);

  store.subscribe('deck', () => { renderDeckList(); if (!dirty) load(); });
  renderDeckList();
  load();
}

function renderDeckList() {
  const sel = $('deck-select');
  const names = store.state.deckNames.length ? store.state.deckNames : [store.state.deckName];
  sel.innerHTML = names.map((n) =>
    `<option value="${n}"${n === store.state.deckName ? ' selected' : ''}>${n}.json</option>`).join('');
  const off = !store.state.persistent;
  $('deck-new').disabled = off;
  $('deck-rename').disabled = off;
  $('deck-delete').disabled = off || names.length <= 1;
  sel.disabled = off;
}

function load() {
  $('deck-editor').value = serializeDeck(store.state.cards);
  dirty = false;
  validate();
}

/* Parse on every keystroke so Save is only offered when it would work, and the
   problem is named while it is still on screen. */
function validate() {
  const parsed = parseDeck($('deck-editor').value);
  const el = $('deck-status');
  const save = $('deck-save');

  if (parsed.error) {
    el.textContent = parsed.error;
    el.className = 'status is-bad';
    save.disabled = true;
    return null;
  }

  const cards = parsed.cards;
  const practised = cards.filter((c) => stats(c).encounters > 0).length;
  const spread = [1, 2, 3, 4, 5]
    .map((n) => [n, cards.filter((c) => c.score === n).length])
    .filter(([, count]) => count)
    .map(([n, count]) => `${SCORE_LABEL[n].toLowerCase()} ${count}`)
    .join(', ');

  el.textContent = [
    `${cards.length} card${cards.length === 1 ? '' : 's'}`,
    practised ? `${practised} practised` : 'none practised yet',
    spread,
    dirty ? 'unsaved changes' : (store.state.persistent ? 'saved' : 'in memory only'),
  ].filter(Boolean).join('  ·  ');
  el.className = 'status ' + (dirty ? 'is-warn' : 'is-ok');
  save.disabled = !dirty;
  return cards;
}

async function save() {
  const cards = validate();
  if (!cards) return;
  store.setCards(cards);
  const ok = await store.saveDeck();
  dirty = false;
  validate();
  if (!ok && store.state.persistent) {
    $('deck-status').textContent = 'Could not write the deck file — reconnect the folder in Settings.';
    $('deck-status').className = 'status is-bad';
  }
}

function confirmDiscard() {
  if (!dirty) return Promise.resolve(true);
  return Promise.resolve(confirm('This deck has unsaved changes. Discard them?'));
}

/* Bring a watchlist.json from the CLI study system across. Pure text in,
   cards out — nothing is read off the disk. */
async function doImport() {
  const text = prompt('Paste the contents of watchlist.json:');
  if (!text) return;
  const result = importWatchlist(text);
  const el = $('deck-status');
  if (result.error) {
    el.textContent = 'Import failed: ' + result.error;
    el.className = 'status is-bad';
    return;
  }
  if (store.state.persistent) await store.createDeck('imported', result.cards);
  else store.setCards(result.cards);
  load();
  el.textContent = `Imported ${result.cards.length} cards.`;
  el.className = 'status is-ok';
}
