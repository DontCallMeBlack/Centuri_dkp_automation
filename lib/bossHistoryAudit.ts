import type { IBossAwardAuditEntry, IBossAwardParticipant } from './models/BossAward.ts';

export interface BossAuditEvent {
  kind: IBossAwardAuditEntry['kind'];
  changeId?: string;
  participant?: IBossAwardParticipant;
  reason?: IBossAwardAuditEntry['reason'];
  actor: string;
  occurredAt: string;
}

export interface BossAuditComment {
  id: string;
  actor: string;
  occurredAt: string;
  added: IBossAwardParticipant[];
  removed: Array<{ participant?: IBossAwardParticipant; reason?: IBossAwardAuditEntry['reason'] }>;
  deletedParticipants: IBossAwardParticipant[];
  deleted: boolean;
}

/** Keep the attendee snapshot inside the deletion audit before the award is cleared. */
export function buildKillDeletedAuditEntries(
  participants: readonly IBossAwardParticipant[],
  changeId: string,
  actor: string,
  occurredAt: Date,
): IBossAwardAuditEntry[] {
  if (participants.length === 0) return [{ kind: 'kill_deleted', changeId, actor, occurredAt }];
  return participants.map((participant) => ({ kind: 'kill_deleted', changeId, participant, actor, occurredAt }));
}

export function groupBossAuditComments(events: readonly BossAuditEvent[]): BossAuditComment[] {
  const groups = new Map<string, BossAuditComment>();
  for (const event of events) {
    const id = event.changeId || `${event.actor}:${event.occurredAt}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, actor: event.actor, occurredAt: event.occurredAt, added: [], removed: [], deletedParticipants: [], deleted: false };
      groups.set(id, group);
    }
    if (event.kind === 'participant_added' && event.participant) group.added.push(event.participant);
    else if (event.kind === 'participant_removed') group.removed.push({ participant: event.participant, reason: event.reason });
    else if (event.kind === 'kill_deleted') {
      group.deleted = true;
      if (event.participant) group.deletedParticipants.push(event.participant);
    }
  }
  return [...groups.values()].reverse();
}
