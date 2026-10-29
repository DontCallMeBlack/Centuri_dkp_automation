import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKillDeletedAuditEntries, groupBossAuditComments } from '../lib/bossHistoryAudit.ts';

const attendee = (rowIndex, owner, account, subClass) => ({ rowIndex, owner, account, subClass });

test('kill deletion audit keeps every attendee name before the award roster is cleared', () => {
  const participants = [
    attendee(3, 'Ada', 'Moonblade', 'Ranger'),
    attendee(4, 'Bea', 'Ironroot', 'Druid'),
  ];
  const occurredAt = new Date('2026-10-29T12:30:00.000Z');

  const events = buildKillDeletedAuditEntries(participants, 'request-delete-1', 'Chief', occurredAt);

  assert.equal(events.length, participants.length);
  assert.deepEqual(events.map((event) => event.participant), participants);
  assert.ok(events.every((event) => event.kind === 'kill_deleted'));
  assert.ok(events.every((event) => event.changeId === 'request-delete-1'));
  assert.ok(events.every((event) => event.actor === 'Chief'));
  assert.ok(events.every((event) => event.occurredAt === occurredAt));
});

test('empty attendee deletions still record who deleted the kill', () => {
  const occurredAt = new Date('2026-10-29T12:30:00.000Z');
  const events = buildKillDeletedAuditEntries([], 'request-delete-empty', 'General', occurredAt);

  assert.deepEqual(events, [
    { kind: 'kill_deleted', changeId: 'request-delete-empty', actor: 'General', occurredAt },
  ]);
  const [comment] = groupBossAuditComments(events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })));
  assert.equal(comment.actor, 'General');
  assert.equal(comment.deleted, true);
  assert.deepEqual(comment.deletedParticipants, []);
});

test('comment grouping displays all deleted attendees alongside the deletion actor', () => {
  const moonblade = attendee(3, 'Ada', 'Moonblade', 'Ranger');
  const ironroot = attendee(4, 'Bea', 'Ironroot', 'Druid');
  const comment = groupBossAuditComments([
    { kind: 'participant_added', changeId: 'edit-1', participant: moonblade, actor: 'General', occurredAt: '2026-10-29T12:30:00.000Z' },
    { kind: 'kill_deleted', changeId: 'delete-2', participant: moonblade, actor: 'Chief', occurredAt: '2026-10-29T12:31:00.000Z' },
    { kind: 'kill_deleted', changeId: 'delete-2', participant: ironroot, actor: 'Chief', occurredAt: '2026-10-29T12:31:00.000Z' },
  ]);

  assert.equal(comment.length, 2);
  assert.equal(comment[0].actor, 'Chief');
  assert.equal(comment[0].deleted, true);
  assert.deepEqual(comment[0].deletedParticipants, [moonblade, ironroot]);
  assert.deepEqual(comment[1].added, [moonblade]);
});
