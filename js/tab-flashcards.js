/* Flashcards: the deck file, shown as itself.

   The textarea holds exactly what is on disk. There is no form over the top of
   it and no hidden second file — what you read is the storage format, which is
   the point: a deck can be written, pasted or diffed anywhere.

   The deck menu answers two questions at once, and they are deliberately not
   the same control. The tickbox says whether a deck's words may come up in
   practice; the name says which deck this editor is looking at. A plain
   <select> could only ever answer one of them, which is why this is a menu
   built by hand rather than a dropdown. */

import * as store from './store.js';
import { parseDeck, serializeDeck, importWatchlist, stats, SCORE_LABEL } from './deck.js';
import { escapeHtml } from './text.js';

const $ = (id) => document.getElementById(id);

let dirty = false;
let menuOpen = false;

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

  wireDeckMenu();

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

/* ── the deck menu ───────────────────────────────────────────────────── */

function wireDeckMenu() {
  $('deck-toggle').addEventListener('click', () => setMenu(!menuOpen));

  $('deck-menu').addEventListener('change', async (e) => {
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    const on = new Set(store.practiceDecks());
    if (box.checked) on.add(box.value);
    else on.delete(box.value);
    const applied = await store.setPracticeDecks([...on]);
    /* setPracticeDecks refuses an empty selection, so the tick that was just
       taken off the last deck has to go back on. */
    if (!box.checked && applied.includes(box.value)) {
      box.checked = true;
      note('At least one deck has to stay ticked — practice needs somewhere to draw from.', 'is-warn');
    }
    renderDeckList();
  });

  $('deck-menu').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-open]');
    if (!btn) return;
    setMenu(false);
    if (btn.dataset.open === store.state.deckName) return;
    if (!(await confirmDiscard())) return;
    await store.loadDeck(btn.dataset.open);
    load();
  });

  /* A menu that stays open once the pointer has gone elsewhere is a menu you
     have to remember to close. */
  document.addEventListener('click', (e) => {
    if (menuOpen && !e.target.closest('.deck-picker')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen) { setMenu(false); $('deck-toggle').focus(); }
  });
}

function setMenu(open) {
  menuOpen = open && !$('deck-toggle').disabled;
  $('deck-menu').hidden = !menuOpen;
  $('deck-toggle').setAttribute('aria-expanded', String(menuOpen));
}

function renderDeckList() {
  const names = store.state.deckNames.length ? store.state.deckNames : [store.state.deckName];
  const ticked = new Set(store.practiceDecks());
  const menu = $('deck-menu');

  /* The rows are rebuilt only when the decks themselves change, never on a
     tick. Replacing the markup would throw away the very checkbox that was
     just clicked, which costs a keyboard user their place in the menu — and
     leaves anything still holding the old node talking to nothing. */
  /* Deck names are slugs, so a comma cannot occur inside one. */
  const signature = names.join(',');
  if (menu.dataset.names !== signature) {
    menu.dataset.names = signature;
    menu.innerHTML = names.map((n) => `<div class="deck-row" data-deck="${escapeHtml(n)}">
      <input type="checkbox" value="${escapeHtml(n)}" aria-label="Practise ${escapeHtml(n)}">
      <button type="button" class="deck-name" data-open="${escapeHtml(n)}">${escapeHtml(n)}.json</button>
      <span class="deck-count"></span>
    </div>`).join('');
  }

  for (const row of menu.querySelectorAll('.deck-row')) {
    const n = row.dataset.deck;
    const count = (store.state.decks[n] || []).length;
    const open = n === store.state.deckName;
    row.classList.toggle('is-open', open);
    row.querySelector('input').checked = ticked.has(n);
    row.querySelector('.deck-count').textContent =
      `${count} card${count === 1 ? '' : 's'}${open ? ' · open' : ''}`;
  }

  $('deck-toggle-name').textContent = `${store.state.deckName}.json`;
  $('deck-toggle-sub').textContent = ticked.size === names.length && names.length > 1
    ? `all ${names.length} decks in practice`
    : `${ticked.size} of ${names.length} deck${names.length === 1 ? '' : 's'} in practice`;

  const off = !store.state.persistent;
  $('deck-new').disabled = off;
  $('deck-rename').disabled = off;
  $('deck-delete').disabled = off || names.length <= 1;
  $('deck-toggle').disabled = off;
  if (off) setMenu(false);
}

function note(text, cls) {
  const el = $('deck-status');
  el.textContent = text;
  el.className = 'status ' + cls;
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
    store.isPracticeDeck(store.state.deckName) ? 'ticked for practice' : 'not ticked — sits out of practice',
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
