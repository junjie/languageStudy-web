/* When to remind someone to take a backup.

   Browser storage is only as durable as the browser makes it. Safari deletes
   everything a site has saved after seven days of Safari use without the site
   being opened (webkit.org/blog/10218; the File System storage this app uses
   is covered, webkit.org/blog/14403) — days of use, not calendar days, and
   opening the site resets the count. Any browser also clears it with site
   data. So the risk is not the practice itself but a week away from it, and
   by then nobody is here to read a banner: the reminder comes while they are. A folder on disk has
   no such problem — its files can be copied and are not the browser's to
   delete — so the reminder is for browser storage only.

   It is due when all of these hold:
     - there is practice since the last backup (or since the app started
       counting, if there has never been one): nothing new, nothing to lose;
     - the last backup is at least a week old — a month when the browser has
       promised to keep the data, since then only a deliberate clear loses it;
     - it has not been put off with Later since yesterday.

   Plain functions over plain values, so node --test covers every rule. */

export const DAYS = { unpersisted: 7, persisted: 30, snooze: 1 };

const DAY = 24 * 60 * 60 * 1000;

function time(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
}

/* Whole days from `from` to `now`, rounded down. */
export function daysSince(iso, now = Date.now()) {
  const t = time(iso);
  return t === null ? null : Math.max(0, Math.floor((now - t) / DAY));
}

/* The latest day anything was practised: a card answered, or a banked
   sentence made or played. Dates are YYYY-MM-DD; the result is one too. */
export function lastPractice(cards = [], manifest = []) {
  let latest = '';
  const see = (d) => { if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) && d.slice(0, 10) > latest) latest = d.slice(0, 10); };
  for (const c of cards) see(c && c.last_seen);
  for (const e of manifest) { see(e && e.created); see(e && e.last_practiced); }
  return latest || null;
}

/* The earliest day anything was practised that the decks still show, as an
   ISO time — where counting starts for someone who has used the app for a
   while and never backed up, rather than from the day this reminder arrived.
   last_seen is each card's latest answer, so this is a lower bound. */
export function firstPractice(cards = []) {
  let first = '';
  for (const c of cards) {
    const d = c && c.last_seen;
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) && (!first || d.slice(0, 10) < first)) first = d.slice(0, 10);
  }
  return first ? `${first}T00:00:00.000Z` : null;
}

/* { due, days, never } — days since the last backup (or since counting
   began, when there has been none). */
export function backupDue({ kind, persisted, lastBackup, since, snoozedUntil, practiced, now = Date.now() }) {
  const never = !time(lastBackup);
  const reference = never ? since : lastBackup;
  const days = daysSince(reference, now);
  const result = { due: false, days, never };
  if (kind !== 'browser' || days === null || !practiced) return result;
  /* Practice on the day of the backup, or before it, is in the backup. */
  if (!never && practiced <= new Date(time(lastBackup)).toISOString().slice(0, 10)) return result;
  if (days < (persisted ? DAYS.persisted : DAYS.unpersisted)) return result;
  const snooze = time(snoozedUntil);
  if (snooze !== null && snooze > now) return result;
  return { ...result, due: true };
}

/* "today", "yesterday", "9 days ago". */
export function agoLabel(days) {
  if (days === null || days === undefined) return 'never';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
