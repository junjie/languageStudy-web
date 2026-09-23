/* Typing practice: one side shown, the other typed.

   An answer is right only if the accents are right — that is the whole skill
   being drilled. But "right word, wrong accents" is a different mistake from
   "wrong word", and a learner needs to be told which one they made, so the
   near miss gets its own verdict and the offending characters are marked.
   It also flags the card, and the Accents filter drills just those.

   Meanings are looser than words: there is more than one fair way to say
   something in English. So a meaning is right if it matches the back or any
   of the card's alternatives, and a miss can be accepted on the spot — which
   records it as an alternative and turns the answer right. */

import * as store from './store.js';
import { pickWeighted, inScope, recordResult, amendLastToRight, addAlternative, meanings, stats, SCORE_LABEL } from './deck.js';
import { compareAnswer, accentMarks, escapeHtml, scoreMark } from './text.js';

const $ = (id) => document.getElementById(id);

let scope = 'all';
let current = null;
let shownSide = 'front';
let answered = false;
let previous = null;
/* The answer just checked, kept so it can still be accepted. */
let last = null;
const tally = { total: 0, right: 0, wrong: 0 };

export function init() {
  scope = store.state.settings.typingScope || 'all';
  setSeg('ty-scope', 'scope', scope);
  setSeg('ty-dir', 'dir', store.state.settings.typingDirection);

  $('ty-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('ty-scope', 'scope', scope);
    store.saveSettings({ typingScope: scope });
    next();
  });

  $('ty-dir').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dir]');
    if (!btn) return;
    setSeg('ty-dir', 'dir', btn.dataset.dir);
    store.saveSettings({ typingDirection: btn.dataset.dir });
    next();
  });

  /* A card from a deck that is no longer loaded must not stay on screen: an
     answer to it would be recorded on a card nothing saves. This happens on
     every page load, when the stored deck replaces the starter deck the page
     boots with, and whenever another deck is picked or the deck is edited. */
  store.subscribe('deck', () => {
    renderPool();
    if (!current || !store.state.cards.includes(current)) next();
  });
  next();
}

export function onShow() {
  const input = $('ty-input');
  if (input && !input.disabled) input.focus();
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

function pool() {
  return store.state.cards.filter((c) => inScope(c, scope));
}

function renderPool() {
  const p = pool();
  $('ty-pool').textContent = `${p.length} of ${store.state.cards.length} cards in scope`;
  const slips = store.state.cards.filter((c) => c.accent_slip).length;
  $('ty-scope').querySelector('[data-scope="accents"]').textContent = slips ? `Accents (${slips})` : 'Accents';
}

/* ── the card ────────────────────────────────────────────────────────── */

function next() {
  renderPool();
  const p = pool();
  if (!p.length) {
    current = null;
    $('ty-card').innerHTML = emptyState();
    return;
  }

  current = pickWeighted(p, 1)[0];
  answered = false;
  const dir = store.state.settings.typingDirection;
  /* Accents live on the front, so that is always the side asked for when
     drilling them, whatever the direction setting says. */
  shownSide = scope === 'accents' ? 'back'
    : dir === 'random' ? (Math.random() < 0.5 ? 'front' : 'back') : (dir === 'back-to-front' ? 'back' : 'front');

  const shown = current[shownSide];
  const askFor = shownSide === 'front' ? 'the meaning' : store.state.settings.targetLanguage;
  const { encounters, correct } = stats(current);

  $('ty-card').innerHTML = `
    <div class="card">
      <div class="card-meta">
        <span class="score-chip"><i class="score-dot s-${current.score}"></i>${SCORE_LABEL[current.score]}</span>
        <span>${correct}/${encounters || 0} recent</span>
        ${squares(current.recent)}
        ${current.accent_slip ? '<span class="is-warn">accents slipped last time</span>' : ''}
        <span class="spacer"></span>
        <span>${current.last_seen ? 'last seen ' + current.last_seen : 'new card'}</span>
      </div>
      <div class="card-body">
        <div class="prompt-label">${shownSide === 'front' ? escapeHtml(store.state.settings.targetLanguage) : 'Meaning'}</div>
        <div class="prompt">${escapeHtml(shown)}</div>
        <label class="field" style="margin-top:24px">
          <span>Type ${escapeHtml(askFor)}</span>
          <input type="text" class="answer-input" id="ty-input" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <div class="row" style="margin-top:12px">
          <button class="btn btn--primary" id="ty-check">Check</button>
          <button class="btn btn--primary" id="ty-next" hidden>Next card</button>
          <button class="btn" id="ty-reveal" title="Shows the answer and counts it as a miss">Show answer</button>
          <button class="btn" id="ty-skip" title="Moves on without counting anything">Skip</button>
        </div>
        <div id="ty-feedback" style="margin-top:16px"></div>
      </div>
    </div>`;

  $('ty-check').addEventListener('click', check);
  $('ty-next').addEventListener('click', next);
  $('ty-skip').addEventListener('click', next);
  $('ty-reveal').addEventListener('click', reveal);
  const input = $('ty-input');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (answered) next(); else check();
  });
  input.focus();
  renderPrevious();
}

function emptyState() {
  const total = store.state.cards.length;
  if (!total) {
    return `<div class="gate"><h3>No cards yet</h3>
      <p>Add some in the Flashcards tab — it is a plain JSON list, and there is a three-card example already in it to copy the shape from.</p></div>`;
  }
  if (scope === 'accents') {
    return `<div class="gate"><h3>No accent slips</h3>
      <p>A word lands here when you type it with the wrong accents, and leaves once you type it exactly. Nothing is waiting right now.</p></div>`;
  }
  return `<div class="gate"><h3>Nothing in scope</h3>
    <p>All ${total} cards are stronger than this filter allows. Widen it to <strong>All</strong>, or practise more to move cards down.</p></div>`;
}

function squares(recent) {
  const list = Array.isArray(recent) ? recent : [];
  const pad = Array(Math.max(0, 8 - list.length)).fill(null);
  return '<span class="sq-row">' + [...pad, ...list]
    .map((r) => `<i class="sq ${r === null ? 'sq--empty' : r ? 'sq--hit' : 'sq--miss'}"></i>`)
    .join('') + '</span>';
}

/* ── checking ────────────────────────────────────────────────────────── */

function check() {
  if (answered || !current) return;
  const input = $('ty-input');
  const typed = input.value.trim();
  if (!typed) { input.focus(); return; }

  answered = true;
  const expected = shownSide === 'front' ? current.back : current.front;
  const verdict = shownSide === 'front'
    ? bestVerdict(typed, meanings(current))
    : compareAnswer(typed, expected);
  const ok = verdict === 'exact';

  /* Only a slip in the language being learnt counts: an accent missed while
     typing the meaning is not what this list is for. */
  const accentSlip = verdict === 'accent' && shownSide === 'back';
  const move = recordResult(current, ok, { accentSlip, typedFront: shownSide === 'back' });
  tally.total++;
  if (ok) tally.right++; else tally.wrong++;
  $('ty-total').textContent = tally.total;
  $('ty-right').textContent = tally.right;
  $('ty-wrong').textContent = tally.wrong;

  settle(ok);

  $('ty-feedback').innerHTML = feedback(verdict, typed, expected, move);
  last = { typed, expected, before: move.before };
  const accept = $('ty-accept');
  if (accept) accept.addEventListener('click', acceptAnswer);
  previous = { shown: current[shownSide], expected, typed, verdict, notes: current.notes };
  renderPrevious();
  store.cardAnswered();
}

/* Not knowing is a miss — it is recorded like any wrong answer, so the card
   keeps coming back. Skip is the way past a card without a verdict. */
function reveal() {
  if (answered || !current) return;
  answered = true;
  const expected = shownSide === 'front' ? current.back : current.front;
  const move = recordResult(current, false, { typedFront: shownSide === 'back' });
  tally.total++;
  tally.wrong++;
  $('ty-total').textContent = tally.total;
  $('ty-wrong').textContent = tally.wrong;
  settle(false);
  $('ty-feedback').innerHTML = feedback('revealed', '', expected, move);
  last = null;
  previous = { shown: current[shownSide], expected, typed: '', verdict: 'revealed', notes: current.notes };
  renderPrevious();
  store.cardAnswered();
}

/* Lock the card once it has a verdict, and hand the keyboard to Next. */
function settle(ok) {
  const input = $('ty-input');
  input.disabled = true;
  input.className = 'answer-input ' + (ok ? 'is-ok' : 'is-bad');
  $('ty-check').hidden = true;
  $('ty-reveal').hidden = true;
  $('ty-skip').hidden = true;
  const nextBtn = $('ty-next');
  nextBtn.hidden = false;
  nextBtn.focus();
}

/* The best of the verdicts against every accepted meaning. */
function bestVerdict(typed, options) {
  const verdicts = options.map((m) => compareAnswer(typed, m));
  return verdicts.includes('exact') ? 'exact' : verdicts.includes('accent') ? 'accent' : 'wrong';
}

function acceptAnswer() {
  if (!last || !current) return;
  addAlternative(current, last.typed, (a, b) => compareAnswer(a, b) === 'exact');
  const move = { ...amendLastToRight(current), before: last.before };
  tally.right++;
  tally.wrong--;
  $('ty-right').textContent = tally.right;
  $('ty-wrong').textContent = tally.wrong;
  $('ty-input').className = 'answer-input is-ok';
  $('ty-feedback').innerHTML = feedback('accepted', last.typed, last.expected, move);
  previous.verdict = 'exact';
  last = null;
  $('ty-next').focus();
  store.cardAnswered();
}

function feedback(verdict, typed, expected, move) {
  const moved = move.before !== move.after
    ? ` <span class="typed-back">${scoreMark(move.before)} → ${scoreMark(move.after, SCORE_LABEL[move.after].toLowerCase())}</span>`
    : '';

  const alts = shownSide === 'front' && (current.alternatives || []).length
    ? `<div class="typed-back" style="margin-top:6px">also accepted: ${current.alternatives.map(escapeHtml).join(' · ')}</div>` : '';
  /* Only a meaning can be accepted: the word itself has one right spelling. */
  const acceptBtn = shownSide === 'front'
    ? `<div class="row" style="margin-top:10px"><button class="btn btn--sm" id="ty-accept">Accept my answer</button>
       <span class="note">Counts it as right, and saves it as another meaning of this card.</span></div>` : '';

  let head;
  if (verdict === 'revealed') {
    const others = shownSide === 'front' && (current.alternatives || []).length
      ? `<div class="typed-back" style="margin-top:6px">also accepted: ${current.alternatives.map(escapeHtml).join(' · ')}</div>` : '';
    head = `<div class="verdict is-bad">Answer <span class="reveal">${escapeHtml(expected)}</span>${moved}</div>${others}`;
  } else if (verdict === 'accepted') {
    head = `<div class="verdict is-ok">Accepted${moved}</div>
      <div class="typed-back" style="margin-top:6px">“${escapeHtml(typed)}” is now saved as another meaning, beside <strong>${escapeHtml(expected)}</strong></div>`;
  } else if (verdict === 'exact') {
    head = `<div class="verdict is-ok">Correct${moved}</div>`;
  } else if (verdict === 'accent') {
    /* The word was there. Show precisely which marks went astray. */
    const marked = accentMarks(typed, expected)
      .map(({ ch, bad }) => (bad ? `<span class="ch-bad">${escapeHtml(ch)}</span>` : escapeHtml(ch)))
      .join('');
    head = `<div class="verdict is-warn">Right word, wrong accents
      <span class="reveal">${escapeHtml(expected)}</span>${moved}</div>
      <div class="typed-back" style="margin-top:6px">you typed ${marked}</div>${alts}${acceptBtn}`;
  } else {
    head = `<div class="verdict is-bad">Not quite
      <span class="reveal">${escapeHtml(expected)}</span>${moved}</div>
      <div class="typed-back" style="margin-top:6px">you typed <s>${escapeHtml(typed)}</s></div>${alts}${acceptBtn}`;
  }

  const notes = current.notes
    ? `<div class="notes-box" style="margin-top:12px">${escapeHtml(current.notes)}</div>` : '';
  return head + notes;
}

function renderPrevious() {
  const el = $('ty-prev');
  if (!previous) { el.innerHTML = ''; return; }
  const cls = previous.verdict === 'exact' ? 'is-ok' : 'is-bad';
  const typed = previous.verdict === 'exact' || previous.verdict === 'revealed' ? '' :
    `<div class="typed-back" style="margin-top:4px">you typed <s>${escapeHtml(previous.typed)}</s></div>`;
  el.innerHTML = `
    <div class="prev ${cls}">
      <h3>Last card</h3>
      <div>${escapeHtml(previous.shown)} → <strong>${escapeHtml(previous.expected)}</strong></div>
      ${typed}
      ${previous.notes ? `<div style="margin-top:6px">${escapeHtml(previous.notes)}</div>` : ''}
    </div>`;
}
