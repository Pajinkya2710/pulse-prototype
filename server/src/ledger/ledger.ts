import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export const GENESIS = '0'.repeat(64);

export type Role = 'participant' | 'moderator' | 'admin' | 'system';
export type EventType =
  | 'QuestionCreated'
  | 'QuestionClosed'
  | 'VoteCast'
  | 'EvidenceSubmitted'
  | 'EvidenceReviewed'
  | 'VoteExcluded'
  | 'ResultPublished'
  | 'RoomFeatured';

export interface NewEvent {
  id?: string;
  question_id: string | null;
  type: EventType;
  actor_id: string;
  actor_role: Role;
  payload: Record<string, unknown>;
}

export interface LedgerEvent {
  seq: number;
  id: string;
  question_id: string | null;
  type: EventType;
  actor_id: string;
  actor_role: Role;
  payload: any;
  recorded_at: string;
  prev_hash: string;
  hash: string;
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  head: string;
  brokenAt?: number;
  reason?: string;
}

// Portable SQL apart from the triggers; the Postgres equivalent is a BEFORE UPDATE OR DELETE trigger
// plus revoking UPDATE/DELETE from the application role.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  question_id TEXT,
  type        TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_question ON events (question_id, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

/** JSON with sorted keys and no undefined fields, so the same data always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** hash = sha256(prev_hash + canonical(row)) */
export function hashEvent(e: Omit<LedgerEvent, 'hash'>): string {
  const { seq, id, question_id, type, actor_id, actor_role, payload, recorded_at, prev_hash } = e;
  return sha256(prev_hash + canonical({ seq, id, question_id, type, actor_id, actor_role, payload, recorded_at }));
}

type Row = Omit<LedgerEvent, 'payload'> & { payload: string };
const parse = (r: Row): LedgerEvent => ({ ...r, payload: JSON.parse(r.payload) });

export class Ledger {
  constructor(
    private db: Database,
    private clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
  }

  head(): { seq: number; hash: string; recorded_at: string } {
    const r = this.db.prepare('SELECT seq, hash, recorded_at FROM events ORDER BY seq DESC LIMIT 1').get();
    return (r as any) ?? { seq: 0, hash: GENESIS, recorded_at: '' };
  }

  get(id: string): LedgerEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return r && parse(r);
  }

  /** Appends one event. Re-sending an id that is already recorded returns the stored event (idempotency). */
  append(e: NewEvent): { event: LedgerEvent; replayed: boolean } {
    return this.db.transaction(() => {
      if (e.id) {
        const existing = this.get(e.id);
        if (existing) return { event: existing, replayed: true };
      }
      const head = this.head();
      const now = this.clock().toISOString();
      const unhashed = {
        seq: head.seq + 1,
        id: e.id ?? randomUUID(),
        question_id: e.question_id,
        type: e.type,
        actor_id: e.actor_id,
        actor_role: e.actor_role,
        payload: JSON.parse(canonical(e.payload)),
        // Never earlier than the previous event, so time order and seq order agree even if the clock steps back.
        recorded_at: now > head.recorded_at ? now : head.recorded_at,
        prev_hash: head.hash,
      };
      const event: LedgerEvent = { ...unhashed, hash: hashEvent(unhashed) };
      this.db
        .prepare(
          `INSERT INTO events (seq, id, question_id, type, actor_id, actor_role, payload, recorded_at, prev_hash, hash)
           VALUES (@seq, @id, @question_id, @type, @actor_id, @actor_role, @payload, @recorded_at, @prev_hash, @hash)`,
        )
        .run({ ...event, payload: canonical(event.payload) });
      return { event, replayed: false };
    })();
  }

  events(uptoSeq = Number.MAX_SAFE_INTEGER): LedgerEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq').all(uptoSeq) as Row[]).map(parse);
  }

  /** The last seq recorded at or before an instant. */
  seqAtTime(iso: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE recorded_at <= ?').get(new Date(iso).toISOString());
    return (r as { seq: number | null }).seq ?? 0;
  }

  hashAt(seq: number): string | undefined {
    return (this.db.prepare('SELECT hash FROM events WHERE seq = ?').get(seq) as { hash: string } | undefined)?.hash;
  }

  /** Walks the chain from genesis and reports the first broken link. */
  verify(): VerifyReport {
    let prev = GENESIS;
    let n = 0;
    for (const r of this.db.prepare('SELECT * FROM events ORDER BY seq').iterate() as IterableIterator<Row>) {
      n++;
      const fail = (reason: string): VerifyReport => ({ ok: false, checked: n, head: prev, brokenAt: r.seq, reason });
      if (r.seq !== n) return fail(`gap in sequence: expected seq ${n}`);
      if (r.prev_hash !== prev) return fail('prev_hash does not match the previous row');
      let payload: unknown;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        return fail('payload is not valid JSON');
      }
      if (hashEvent({ ...r, payload }) !== r.hash) return fail('row contents do not match its hash');
      prev = r.hash;
    }
    return { ok: true, checked: n, head: prev };
  }
}
