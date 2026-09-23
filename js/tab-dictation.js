/* Dictation: hear a sentence, type it back.

   A sentence is written by the text model around two or three of your weakest
   cards, then spoken by the speech model. What comes back is diffed word by
   word, and only the target words move a score — everything else is shown but
   not judged, because the sentence around them was not something you were
   asked to know.

   The target words stay masked until you submit. They are the answer: they are
   the exact strings matched against what you type. Showing them first would
   turn the exercise into copying. */

import * as store from './store.js';
import * as storage from './storage.js';
import { isDictatable, inScope, pickWeighted, recordResult, SCORE_LABEL } from './deck.js';
import { words, contains, containsLoosely, diff, escapeHtml, scoreMark } from './text.js';
import { sidecarText, formatWait, QuotaError } from './gemini.js';
import { describe } from './tab-settings.js';

const $ = (id) => document.getElementById(id);

let scope = 'all';
let rate = 1;
let current = null;
let audio = null;
let audioUrl = null;
let answered = false;
let busy = false;
const heard = new Set();
let ticker = null;

export function init() {
  $('dc-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('dc-scope', 'scope', scope);
    store.saveSettings({ dictationScope: scope });
    renderBankInfo();
  });

  $('dc-rate').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-rate]');
    if (!btn) return;
    rate = Number(btn.dataset.rate);
    setSeg('dc-rate', 'rate', String(rate));
    if (audio) audio.playbackRate = rate;
  });

  $('dc-play').addEventListener('click', play);
  $('dc-new').addEventListener('click', generate);
  $('dc-bank-btn').addEventListener('click', fromBank);
  $('dc-check').addEventListener('click', check);
  $('dc-next').addEventListener('click', advance);
  $('dc-download').addEventListener('click', downloadAudio);

  $('dc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
    else if (e.key === 'Enter' && answered) { e.preventDefault(); advance(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!isActive()) return;
    if (e.key === ' ' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      play();
    }
  });

  scope = store.state.settings.dictationScope || 'all';
  setSeg('dc-scope', 'scope', scope);
  setSeg('dc-rate', 'rate', '1');

  store.subscribe('deck', renderBankInfo);
  store.subscribe('folder', () => { gate(); renderBankInfo(); });
  store.subscribe('settings', renderQuota);
  ticker = setInterval(renderQuota, 1000);
  gate();
}

export function onShow() {
  gate();
  renderBankInfo();
  if (!current && canRun()) {
    if (store.state.manifest.length) fromBank();
    else idle('Nothing in the bank yet. Write the first sentence — it costs one call to each model.');
  }
}

function isActive() {
  return !document.getElementById('panel-dictation').hidden;
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

/* ── gating ──────────────────────────────────────────────────────────── */

function canRun() {
  return !!storage.getApiKey() || store.state.manifest.length > 0;
}

function gate() {
  const key = storage.getApiKey();
  const banked = store.state.manifest.length;
  const el = $('dc-gate');

  if (!key && !banked) {
    el.innerHTML = `<div class="gate">
      <h3>Add a Gemini API key first</h3>
      <p>Dictation writes and speaks each sentence through the Gemini API, using your own key. Paste one into the Settings tab and this tab comes to life. Sentences you have already made stay playable for free, forever, without a key.</p>
      </div>`;
    $('dc-stage').hidden = true;
    return;
  }

  const where = storage.where();
  el.innerHTML = where === 'lost'
    ? `<div class="banner is-warn">Lost access to the data folder — a sentence you make now plays, but is not kept and its score is not saved. Choose the folder again in Settings.</div>`
    : store.state.settled && !store.state.persistent
    ? `<div class="banner is-warn">This browser is not letting the page store anything (a private window?) — a sentence you make plays now but is gone on reload. Use <strong>Download audio</strong> on the card, or <strong>Download backup</strong> in Settings, to keep what you make.</div>`
    : '';
  $('dc-stage').hidden = false;
  renderQuota();
}

/* ── pool ────────────────────────────────────────────────────────────── */

function pool() {
  return store.state.cards.filter((c) => isDictatable(c) && inScope(c, scope));
}

function renderBankInfo() {
  const slips = store.state.cards.filter((c) => c.accent_slip && isDictatable(c)).length;
  $('dc-scope').querySelector('[data-scope="accents"]').textContent = slips ? `Accents (${slips})` : 'Accents';
  const dictatable = store.state.cards.filter(isDictatable).length;
  const p = pool().length;
  $('dc-bank').textContent =
    `${store.state.manifest.length} in bank · ${p} of ${dictatable} usable cards in scope`;
}

/* ── the budget readout ──────────────────────────────────────────────── */

function renderQuota() {
  if (!isActive() && !ticker) return;
  const q = store.quotaReport();
  const el = $('dc-quota');
  if (!el) return;

  const usage = `text ${q.text.usedDay}/${q.text.rpd || '∞'} · speech ${q.tts.usedDay}/${q.tts.rpd || '∞'} in 24h`;
  if (q.retryAfter > 0) {
    el.textContent = `waiting ${formatWait(q.retryAfter)} · ${usage}`;
    el.className = 'quota is-bad';
  } else {
    const left = q.cardsLeftToday;
    el.textContent = (left === null ? 'unlimited' : `${left} new card${left === 1 ? '' : 's'} left`) + ' · ' + usage;
    el.className = 'quota ' + (left !== null && left <= 2 ? 'is-bad' : 'is-ok');
  }
  /* Replays are free, so only the paid button is ever disabled. */
  $('dc-new').disabled = busy || q.retryAfter > 0 || !storage.getApiKey();
  $('dc-bank-btn').disabled = busy || !store.state.manifest.length;
}

/* ── generating ──────────────────────────────────────────────────────── */

async function generate() {
  if (busy) return;
  const p = pool();
  if (!p.length && scope === 'accents') {
    showError('No accent slips to build a sentence around. A word lands in Accents when you get it right with the wrong accents, and leaves once you type it exactly.');
    return;
  }
  if (!p.length) {
    showError(store.state.cards.length
      ? 'No cards in this scope can be used for dictation. Widen the filter, or check the Flashcards tab — entries like "X vs Y" or "verb + noun" have no single phrase to listen for, so they are skipped.'
      : 'Add some cards in the Flashcards tab first.');
    return;
  }

  const n = Math.min(store.state.settings.termsPerSentence, p.length);
  const terms = pickWeighted(p, n);

  busy = true;
  showError('');
  const btn = $('dc-new');
  btn.innerHTML = '<span class="spinner"></span>Writing &amp; speaking';
  btn.disabled = true;
  $('dc-bank-btn').disabled = true;
  idle(`Writing a sentence around ${terms.length} of your weakest words, then reading it aloud…`);

  try {
    const { entry, wav, sidecar } = await store.client.generateCard(terms, store.state.manifest);
    const kept = store.state.persistent
      && await storage.writeBlob(entry.file, wav)
      && await storage.writeText(entry.text_file, sidecar);
    /* Nowhere to keep it, or the write was refused: playable, and
       downloadable, for this session only. */
    if (!kept) entry.blobUrl = URL.createObjectURL(wav);
    store.state.manifest.push(entry);
    await store.saveManifest();
    heard.add(entry.id);
    renderBankInfo();
    await loadCard(entry);
  } catch (e) {
    console.error(e);
    showError(describe(e));
    if (e instanceof QuotaError) idle('Out of budget for now — pull one from the bank instead, replays are free.');
    else idle('');
  } finally {
    busy = false;
    btn.textContent = 'New sentence';
    renderQuota();
  }
}

function fromBank() {
  const bank = store.state.manifest;
  if (!bank.length) { idle('The bank is empty. Write the first sentence above.'); return; }

  const wanted = new Set(pool().map((c) => c.front));
  const scoped = bank.filter((e) => (e.terms || []).some((t) => wanted.has(t)));
  /* Any old sentence is fine for the wider filters, but Accents means these
     words — better to say none are banked than to play something else. */
  if (scope === 'accents' && !scoped.length) {
    idle(wanted.size
      ? 'No banked sentence uses your accent-slip words yet. Write a new one to drill them.'
      : 'No accent slips right now — nothing to drill.');
    return;
  }
  let candidates = (scoped.length ? scoped : bank).filter((e) => !heard.has(e.id));
  if (!candidates.length) {
    /* Been through everything in scope this session; start over rather than
       refusing. */
    heard.clear();
    candidates = scoped.length ? scoped : bank;
  }
  const entry = candidates[Math.floor(Math.random() * candidates.length)];
  heard.add(entry.id);
  loadCard(entry);
}

function advance() {
  if (store.state.manifest.length > 1 || !storage.getApiKey()) fromBank();
  else generate();
}

/* ── the card ────────────────────────────────────────────────────────── */

async function loadCard(entry) {
  current = entry;
  answered = false;
  showError('');
  $('dc-idle').hidden = true;
  $('dc-card').hidden = false;

  /* Stop the last sentence before its URL goes, or a load still in flight
     fails against a revoked blob. */
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  /* With no server there is no URL to point at — the wav has to be pulled out
     of the folder and turned into a blob URL each time. */
  const src = entry.blobUrl || await storage.readBlobUrl(entry.file);
  if (!entry.blobUrl) audioUrl = src;
  audio = src ? new Audio(src) : null;
  if (audio) audio.playbackRate = rate;
  $('dc-play').disabled = !audio;
  $('dc-download').disabled = !audio;

  const count = (entry.terms || []).length;
  const wordCount = words(entry.sentence).length;
  $('dc-meta').innerHTML = [
    escapeHtml(entry.id),
    `${wordCount} words`,
    entry.voice ? `voice ${escapeHtml(entry.voice)}` : '',
    entry.language ? escapeHtml(entry.language) : '',
    `played ${entry.times_practiced || 0}×`,
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join('');

  $('dc-terms').innerHTML = count
    ? Array(count).fill('<span class="chip chip--masked">•••</span>').join('')
      + `<span class="chip-count">${count} word${count === 1 ? '' : 's'} graded</span>`
    : '<span class="chip-count">no target words on this card</span>';

  const input = $('dc-input');
  input.value = '';
  input.disabled = false;
  $('dc-check').hidden = false;
  $('dc-check').disabled = false;
  $('dc-next').hidden = true;
  $('dc-result').hidden = true;
  input.focus();

  if (!audio) showError('The audio file for this sentence is missing from the folder.');
  else play();
}

/* The sentence's audio as a file, named by its bank id. The transcript is
   not bundled: it is the answer, and is on screen once you have checked. */
async function downloadAudio() {
  if (!current) return;
  const blob = current.blobUrl
    ? await fetch(current.blobUrl).then((r) => r.blob()).catch(() => null)
    : await storage.readBlob(current.file);
  if (!blob) { showError('The audio for this sentence could not be read.'); return; }
  storage.download(`${current.id}.wav`, blob);
}

function play() {
  if (!audio) return;
  audio.currentTime = 0;
  audio.playbackRate = rate;
  audio.play().catch(() => { /* autoplay refused until the user clicks */ });
}

/* ── checking ────────────────────────────────────────────────────────── */

function check() {
  if (answered || !current) return;
  const typed = $('dc-input').value.trim();
  if (!typed) { $('dc-input').focus(); return; }
  answered = true;

  const refWords = words(current.sentence);
  const usrWords = words(typed);
  const d = diff(refWords, usrWords);

  $('dc-input').disabled = true;
  $('dc-check').hidden = true;
  $('dc-next').hidden = false;
  $('dc-next').focus();

  const scored = scoreTerms(usrWords);

  let verdictClass = 'is-bad';
  let verdictText;
  if (!d.accent && !d.missing && !d.extra) {
    verdictClass = 'is-ok';
    verdictText = 'Word perfect';
  } else if (!d.missing && !d.extra) {
    verdictClass = 'is-warn';
    verdictText = `Every word heard, ${d.accent} with the wrong accents`;
  } else {
    const bits = [];
    if (d.accent) bits.push(`${d.accent} wrong accents`);
    if (d.missing) bits.push(`${d.missing} missed`);
    if (d.extra) bits.push(`${d.extra} extra`);
    verdictText = `${d.ok}/${refWords.length} words exact — ${bits.join(', ')}`;
  }

  $('dc-result').hidden = false;
  $('dc-result').innerHTML = `
    <div class="verdict ${verdictClass}">${verdictText}</div>
    <div class="diff" style="margin-top:10px">${d.tokens.map(token).join(' ')}</div>
    <div class="legend" style="margin-top:8px">
      <span><i class="w w-accent">word</i> wrong accent</span>
      <span><i class="w w-missing">word</i> not typed</span>
      <span><i class="w w-extra">word</i> not in the sentence</span>
    </div>
    <div class="notes-box" style="margin-top:12px">
      <div>${escapeHtml(current.sentence)}</div>
      ${current.english ? `<div style="margin-top:6px;color:var(--fg-dim)">${escapeHtml(current.english)}</div>` : ''}
    </div>
    ${scored}`;

  markPractised();
}

function token({ kind, text }) {
  const cls = { ok: '', accent: 'w-accent', missing: 'w-missing', extra: 'w-extra' }[kind];
  return `<span class="w ${cls}">${escapeHtml(text)}</span>`;
}

/* Per-term, not per-sentence. A target word counts only if it appears exactly
   as written, accents and all. A word the sentence writer silently dropped is
   skipped — scoring it wrong would punish the learner for the model. */
function scoreTerms(usrWords) {
  const refWords = words(current.sentence);
  const chips = [];
  const rows = [];
  let changed = false;

  for (const termText of current.terms || []) {
    const card = store.state.cards.find((c) => c.front === termText);
    if (!card) {
      chips.push(`<span class="chip">${escapeHtml(termText)}</span>`);
      rows.push(`<div>${escapeHtml(termText)} — no longer in the deck, not scored</div>`);
      continue;
    }
    if (!contains(refWords, card.front)) {
      chips.push(`<span class="chip">${escapeHtml(card.front)}</span>`);
      rows.push(`<div>${escapeHtml(card.front)} — the sentence never used it, not scored</div>`);
      continue;
    }

    const ok = contains(usrWords, card.front);
    const accentSlip = !ok && containsLoosely(usrWords, card.front);
    chips.push(`<span class="chip ${ok ? 'chip--ok' : 'chip--bad'}">${escapeHtml(card.front)}</span>`);
    const move = recordResult(card, ok, { accentSlip });
    changed = true;
    const moved = move.before !== move.after
      ? ` ${scoreMark(move.before)} → ${scoreMark(move.after, SCORE_LABEL[move.after].toLowerCase())}` : '';
    rows.push(`<div>${ok ? '✓' : '✗'} ${escapeHtml(card.front)}${accentSlip ? ' — right word, wrong accents' : ''} (${move.correct}/${move.encounters})${moved}</div>`);
  }

  $('dc-terms').innerHTML = chips.join('');
  if (changed) store.cardAnswered();

  return rows.length
    ? `<div class="notes-box" style="margin-top:12px"><strong>Scored</strong>${rows.join('')}</div>`
    : '';
}

async function markPractised() {
  current.times_practiced = (current.times_practiced || 0) + 1;
  current.last_practiced = new Date().toISOString().slice(0, 10);
  await store.saveManifest();
}

/* ── small helpers ───────────────────────────────────────────────────── */

function showError(text) {
  const el = $('dc-error');
  el.innerHTML = text ? `<div class="banner is-bad">${escapeHtml(text)}</div>` : '';
}

function idle(text) {
  const el = $('dc-idle');
  if (!text) { el.hidden = true; return; }
  $('dc-card').hidden = true;
  el.hidden = false;
  el.innerHTML = `<p>${escapeHtml(text)}</p>`;
}
