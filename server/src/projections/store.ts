import type { Database } from 'better-sqlite3';
import { canonical, sha256, type LedgerEvent } from '../ledger/ledger';
import { apply, countedVotes, emptyState, key, type State } from './state';

// Read-model tables. Disposable: `npm run rebuild` drops them and replays the ledger.
// The primary key on current_votes is what enforces one current vote per participant per question.
const TABLES = ['current_votes', 'evidence_state', 'question_summary'];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS current_votes (
  question_id TEXT NOT NULL, participant_id TEXT NOT NULL, vote_id TEXT NOT NULL,
  choice TEXT NOT NULL, confidence INTEGER NOT NULL, suspected TEXT, excluded INTEGER NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (question_id, participant_id)
);
CREATE TABLE IF NOT EXISTS evidence_state (
  evidence_id TEXT PRIMARY KEY, question_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  last_decision_by TEXT, last_reason TEXT, seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS question_summary (
  question_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  closed INTEGER NOT NULL, featured INTEGER NOT NULL, votes_counted INTEGER NOT NULL, last_seq INTEGER NOT NULL
);`;

export const createProjections = (db: Database) => db.exec(SCHEMA);

/** Writes the rows an event touched. Delete-then-insert keeps the SQL portable (no SQLite upsert dialect). */
export function persist(db: Database, s: State, e: LedgerEvent) {
  const qid = e.question_id;
  if (!qid) return;
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

  if (e.type === 'VoteCast' || e.type === 'VoteExcluded') {
    const pid = e.payload.participant_id;
    const v = s.votes.get(s.current.get(key(qid, pid))!)!;
    run('DELETE FROM current_votes WHERE question_id = ? AND participant_id = ?', qid, pid);
    run(
      'INSERT INTO current_votes VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      qid, pid, v.id, v.choice, v.confidence, v.suspected, s.excluded.has(key(qid, pid)) ? 1 : 0, v.seq,
    );
  }
  if (e.type === 'EvidenceSubmitted' || e.type === 'EvidenceReviewed') {
    const ev = s.evidence.get(e.type === 'EvidenceSubmitted' ? e.id : e.payload.evidence_id)!;
    const last = ev.reviews.at(-1);
    run('DELETE FROM evidence_state WHERE evidence_id = ?', ev.id);
    run(
      'INSERT INTO evidence_state VALUES (?, ?, ?, ?, ?, ?, ?)',
      ev.id, qid, ev.title, ev.status, last?.actorRole ?? null, last?.reason ?? null, last?.seq ?? ev.seq,
    );
  }
  if (e.type === 'RoomFeatured') {
    run('UPDATE question_summary SET featured = CASE WHEN question_id = ? THEN 1 ELSE 0 END', qid);
  } else if (e.type !== 'ResultPublished') {
    const q = s.questions.get(qid)!;
    run('DELETE FROM question_summary WHERE question_id = ?', qid);
    run(
      'INSERT INTO question_summary VALUES (?, ?, ?, ?, ?, ?, ?)',
      q.id, q.slug, q.title, q.closedSeq ? 1 : 0, s.featured === qid ? 1 : 0, countedVotes(s, qid).length, q.lastSeq,
    );
  }
}

/** Drops every projection table and rebuilds it by replaying the ledger from genesis. */
export function rebuild(db: Database, events: LedgerEvent[]): State {
  return db.transaction(() => {
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    createProjections(db);
    const s = emptyState();
    for (const e of events) {
      apply(s, e);
      persist(db, s, e);
    }
    return s;
  })();
}

/** One hash over all projection rows, to show a rebuild produced identical tables. */
export function fingerprint(db: Database): string {
  const rows = TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());
  return sha256(canonical(rows));
}
