import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupDue, lastPractice, firstPractice, daysSince, agoLabel, DAYS } from '../js/backup-due.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const base = { kind: 'browser', persisted: false, since: ago(40), practiced: '2026-09-29', now: NOW };

test('due after a week of practice with no backup since', () => {
  assert.equal(backupDue({ ...base, lastBackup: ago(8) }).due, true);
  assert.equal(backupDue({ ...base, lastBackup: ago(6) }).due, false, 'not yet a week');
  assert.equal(backupDue({ ...base, lastBackup: ago(8) }).days, 8);
});

test('a month when the browser has promised to keep the data', () => {
  assert.equal(backupDue({ ...base, persisted: true, lastBackup: ago(8) }).due, false);
  assert.equal(backupDue({ ...base, persisted: true, lastBackup: ago(DAYS.persisted) }).due, true);
});

test('nothing practised since the backup: nothing to lose, no reminder', () => {
  assert.equal(backupDue({ ...base, lastBackup: ago(20), practiced: ago(21).slice(0, 10) }).due, false);
  assert.equal(backupDue({ ...base, lastBackup: ago(20), practiced: ago(20).slice(0, 10) }).due, false, 'same day is in the backup');
  assert.equal(backupDue({ ...base, lastBackup: ago(20), practiced: null }).due, false);
});

test('never backed up counts from when counting began', () => {
  const r = backupDue({ ...base, lastBackup: null, since: ago(9) });
  assert.deepEqual([r.due, r.never, r.days], [true, true, 9]);
  assert.equal(backupDue({ ...base, lastBackup: null, since: ago(3) }).due, false);
});

test('a folder never needs the reminder; Later puts it off', () => {
  assert.equal(backupDue({ ...base, kind: 'folder', lastBackup: ago(90) }).due, false);
  assert.equal(backupDue({ ...base, kind: null, lastBackup: ago(90) }).due, false);
  assert.equal(backupDue({ ...base, lastBackup: ago(9), snoozedUntil: new Date(NOW + 86400000).toISOString() }).due, false);
  assert.equal(backupDue({ ...base, lastBackup: ago(9), snoozedUntil: ago(1) }).due, true, 'a snooze that has run out');
  assert.equal(DAYS.snooze, 1, 'Later means tomorrow');
});

test('last practice is the latest card or banked sentence', () => {
  assert.equal(lastPractice([{ last_seen: '2026-09-01' }, { last_seen: '2026-09-12' }, {}], [{ created: '2026-09-10', last_practiced: '2026-09-20' }]), '2026-09-20');
  assert.equal(lastPractice([], []), null);
});

test('labels', () => {
  assert.equal(agoLabel(null), 'never');
  assert.equal(agoLabel(0), 'today');
  assert.equal(agoLabel(1), 'yesterday');
  assert.equal(agoLabel(9), '9 days ago');
  assert.equal(daysSince('not a date', NOW), null);
});

test('counting starts from the earliest practice the decks show', () => {
  assert.equal(firstPractice([{ last_seen: '2026-09-12' }, { last_seen: '2026-07-01' }, {}]), '2026-07-01T00:00:00.000Z');
  assert.equal(firstPractice([{}]), null);
});
