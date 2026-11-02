import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { Ledger, sha256, type LedgerEvent, type NewEvent, type Role } from './ledger/ledger';
import { createProjections, persist } from './projections/store';
import { apply, countedVotes, key, replay, type Choice, type Decision, type Evidence, type State } from './projections/state';
import { checkSnapshots, computeResult, timeline } from './results/results';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Actor {
  id: string;
  role: Role;
}

export interface Client {
  ip: string;
  ua: string;
}

const SUSPECT_WINDOW_MS = 10 * 60 * 1000;
const NEW_PARTICIPANTS_PER_MINUTE = 5;

/** Evidence content a participant may not see: unapproved items submitted by someone else. */
const hiddenFrom = (a: Actor, e: Evidence) => a.role === 'participant' && e.status !== 'approved' && e.submittedBy !== a.id;

const need = (a: Actor, ...roles: Role[]) => {
  if (!roles.includes(a.role)) throw new HttpError(403, `requires role: ${roles.join(' or ')}`);
};

/**
 * Commands validate and append events; reads replay events. Nothing here updates or deletes a recorded event:
 * every correction is a new event with an actor and a reason.
 */
export class Pulse {
  ledger: Ledger;
  state: State;
  private clock: () => Date;
  private secret: string;
  private anchorFile?: string;
  private listeners = new Set<(e: LedgerEvent) => void>();
  // ponytail: in-process rate limit; move to Redis once there is more than one API process.
  private newcomers = new Map<string, number[]>();

  constructor(
    public db: Database,
    opts: { clock?: () => Date; secret?: string; anchorFile?: string } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.secret = opts.secret ?? 'dev-secret';
    this.anchorFile = opts.anchorFile;
    this.ledger = new Ledger(db, this.clock);
    createProjections(db);
    this.state = replay(this.ledger.events());
  }

  onEvent(fn: (e: LedgerEvent) => void) {
    this.listeners.add(fn);
  }

  private commit(e: NewEvent): LedgerEvent {
    let replayed = false;
    let event: LedgerEvent;
    try {
      event = this.db.transaction(() => {
        const r = this.ledger.append(e);
        replayed = r.replayed;
        if (!replayed) {
          apply(this.state, r.event);
          persist(this.db, this.state, r.event);
        }
        return r.event;
      })();
    } catch (err) {
      this.state = replay(this.ledger.events()); // in-memory state may be ahead of a rolled-back write
      throw err;
    }
    if (!replayed) {
      if (this.anchorFile && (event.type === 'ResultPublished' || event.type === 'QuestionClosed')) this.anchor();
      for (const fn of this.listeners) fn(event);
    }
    return event;
  }

  // ---------- reads ----------

  /** asOf is a seq ("42") or an ISO time. Omitted means the live head. */
  stateAt(asOf?: string): State {
    if (!asOf) return this.state;
    let seq: number;
    if (/^\d+$/.test(asOf)) seq = Number(asOf);
    else if (!Number.isNaN(Date.parse(asOf))) seq = this.ledger.seqAtTime(asOf);
    else throw new HttpError(400, 'asOf must be a seq number or an ISO time');
    // ponytail: replays from genesis per historical read; cache states by seq (they never change) if it gets slow.
    return seq >= this.state.seq ? this.state : replay(this.ledger.events(seq));
  }

  question(idOrSlug: string, s = this.state) {
    const q = s.questions.get(idOrSlug) ?? [...s.questions.values()].find((x) => x.slug === idOrSlug);
    if (!q) throw new HttpError(404, 'question not found (at this point in time)');
    return q;
  }

  /** Live reads come from the projection table; historical reads replay. Same shape either way. */
  listQuestions(asOf?: string) {
    if (!asOf) return this.db.prepare('SELECT * FROM question_summary ORDER BY last_seq DESC').all();
    const s = this.stateAt(asOf);
    return [...s.questions.values()]
      .sort((a, b) => b.lastSeq - a.lastSeq)
      .map((q) => ({
        question_id: q.id,
        slug: q.slug,
        title: q.title,
        closed: q.closedSeq ? 1 : 0,
        featured: s.featured === q.id ? 1 : 0,
        votes_counted: countedVotes(s, q.id).length,
        last_seq: q.lastSeq,
      }));
  }

  view(idOrSlug: string, a: Actor, asOf?: string) {
    const s = this.stateAt(asOf);
    const q = this.question(idOrSlug, s);
    // Participants see that unapproved items exist and why they were held back, never their content.
    const evidence = [...s.evidence.values()]
      .filter((e) => e.questionId === q.id)
      .map((e) => ({
        ...e,
        ...(hiddenFrom(a, e) && { title: null, url: null, summary: null, hidden: true }),
        submittedBy: e.submittedRole !== 'participant' ? e.submittedBy : e.submittedBy === a.id ? 'you' : 'a participant',
      }));
    const mine = s.current.get(key(q.id, a.id));
    const v = mine ? s.votes.get(mine)! : null;
    return {
      question: q,
      headSeq: this.state.seq,
      asOfSeq: s.seq,
      asOfTime: s.at,
      featured: s.featured === q.id,
      evidence,
      myVote: v && { id: v.id, choice: v.choice, confidence: v.confidence, seq: v.seq, at: v.at, supersedes: v.supersedes },
      result: computeResult(s, q.id),
    };
  }

  result(idOrSlug: string, asOf?: string) {
    const s = this.stateAt(asOf);
    return computeResult(s, this.question(idOrSlug, s).id);
  }

  timeline(idOrSlug: string, asOf?: string) {
    const s = this.stateAt(asOf);
    return { asOfSeq: s.seq, ...timeline(this.ledger.events(s.seq), this.question(idOrSlug, s).id) };
  }

  /** Who believed what and when, what evidence existed at each step, and whether each published result still recomputes. */
  audit(idOrSlug: string, a: Actor, asOf?: string) {
    const s = this.stateAt(asOf);
    const q = this.question(idOrSlug, s);
    const evidence = [...s.evidence.values()].filter((e) => e.questionId === q.id);
    const labels = new Map<string, string>();
    const participants = new Map<string, any>();
    for (const v of s.votes.values()) {
      if (v.questionId !== q.id) continue;
      if (!labels.has(v.participantId)) {
        const i = labels.size;
        const label = i < 26 ? String.fromCharCode(65 + i) : `P${i + 1}`;
        labels.set(v.participantId, label);
        const ex = s.excluded.get(key(q.id, v.participantId));
        participants.set(v.participantId, { label, excluded: ex ? { reason: ex.reason, seq: ex.seq, by: ex.actorId } : null, steps: [] });
      }
      participants.get(v.participantId).steps.push({
        voteId: v.id,
        seq: v.seq,
        at: v.at,
        choice: v.choice,
        confidence: v.confidence,
        suspected: v.suspected,
        evidenceExisted: evidence.filter((e) => e.seq < v.seq).map((e) => e.id),
        evidenceApproved: evidence.filter((e) => e.visibleSeq !== null && e.visibleSeq < v.seq).map((e) => e.id),
        evidenceVisible: v.evidenceVisible,
      });
    }
    const snapshots = checkSnapshots(this.ledger.events(s.seq), s.snapshots.filter((x) => x.questionId === q.id));
    return {
      question: q,
      asOfSeq: s.seq,
      asOfTime: s.at,
      result: computeResult(s, q.id),
      participants: [...participants.values()],
      evidence: evidence.map((e) => ({
        id: e.id,
        seq: e.seq,
        at: e.at,
        title: hiddenFrom(a, e) ? null : e.title,
        hidden: hiddenFrom(a, e),
        status: e.status,
        submittedBy: e.submittedRole === 'participant' ? labels.get(e.submittedBy) ?? 'participant' : e.submittedBy,
        reviews: e.reviews,
      })),
      snapshots,
      /** What the Room was showing for this question at that moment: the latest snapshot at or before asOf. */
      displayed: snapshots.at(-1) ?? null,
    };
  }

  verify() {
    return { ...this.ledger.verify(), anchors: this.checkAnchors() };
  }

  // ---------- commands ----------

  /** Any user may create a question (brief, scope 01). Its link is unique: a readable slug plus a random suffix. */
  createQuestion(a: Actor, b: { title: string; description: string; slug?: string }) {
    const taken = (s: string) => [...this.state.questions.values()].some((q) => q.slug === s);
    const base = b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'question';
    let slug = b.slug ?? `${base}-${randomUUID().slice(0, 6)}`;
    if (b.slug && taken(slug)) throw new HttpError(409, 'slug already used');
    while (taken(slug)) slug = `${base}-${randomUUID().slice(0, 6)}`;
    return this.commit({ question_id: randomUUID(), type: 'QuestionCreated', actor_id: a.id, actor_role: a.role, payload: { ...b, slug } });
  }

  closeQuestion(a: Actor, idOrSlug: string) {
    need(a, 'admin');
    const q = this.open(idOrSlug);
    return this.commit({ question_id: q.id, type: 'QuestionClosed', actor_id: a.id, actor_role: a.role, payload: {} });
  }

  castVote(a: Actor, idOrSlug: string, b: { id: string; choice: Choice; confidence: number; evidenceVisible: string[] }, client: Client) {
    need(a, 'participant');
    const retry = this.ledger.get(b.id);
    if (retry) {
      if (retry.type !== 'VoteCast' || retry.actor_id !== a.id) throw new HttpError(409, 'id already used');
      return retry; // same submission arriving twice is recorded once
    }
    const q = this.open(idOrSlug);
    const prevId = this.state.current.get(key(q.id, a.id)) ?? null;
    const device = sha256(this.secret + client.ip + '|' + client.ua).slice(0, 16);
    if (!prevId) this.rateLimit(q.id, client.ip);
    const suspected = prevId ? this.state.votes.get(prevId)!.suspected : this.suspect(q.id, a.id, device);
    return this.commit({
      id: b.id,
      question_id: q.id,
      type: 'VoteCast',
      actor_id: a.id,
      actor_role: a.role,
      payload: {
        participant_id: a.id,
        choice: b.choice,
        confidence: b.confidence,
        supersedes: prevId, // decided by the server, never by the client
        // Only items this participant could actually have been shown, so "seen" can never be overstated.
        evidence_visible: b.evidenceVisible.filter((id) => {
          const e = this.state.evidence.get(id);
          return e?.questionId === q.id && !hiddenFrom(a, e);
        }),
        device,
        suspected,
      },
    });
  }

  submitEvidence(a: Actor, idOrSlug: string, b: { title: string; url: string; summary: string }) {
    need(a, 'participant', 'admin');
    const q = this.open(idOrSlug);
    return this.commit({ question_id: q.id, type: 'EvidenceSubmitted', actor_id: a.id, actor_role: a.role, payload: b });
  }

  /** Precedence by role: a moderator cannot reverse an administrator's decision; an administrator can reverse anyone's. */
  reviewEvidence(a: Actor, evidenceId: string, b: { decision: Decision; reason: string }) {
    need(a, 'moderator', 'admin');
    const ev = this.state.evidence.get(evidenceId);
    if (!ev) throw new HttpError(404, 'evidence not found');
    const last = ev.reviews.findLast((r) => r.decision !== 'annotate');
    if (b.decision !== 'annotate' && a.role === 'moderator' && last?.actorRole === 'admin') {
      throw new HttpError(403, 'an administrator decided this; only an administrator can change it');
    }
    const overrides = b.decision !== 'annotate' && last && last.actorRole !== a.role ? last.seq : null;
    return this.commit({
      question_id: ev.questionId,
      type: 'EvidenceReviewed',
      actor_id: a.id,
      actor_role: a.role,
      payload: { evidence_id: ev.id, decision: b.decision, reason: b.reason, overrides },
    });
  }

  excludeVote(a: Actor, voteId: string, reason: string) {
    need(a, 'admin');
    const v = this.state.votes.get(voteId);
    if (!v) throw new HttpError(404, 'vote not found');
    if (this.state.excluded.has(key(v.questionId, v.participantId))) throw new HttpError(409, 'already excluded');
    return this.commit({
      question_id: v.questionId,
      type: 'VoteExcluded',
      actor_id: a.id,
      actor_role: a.role,
      payload: { vote_id: v.id, participant_id: v.participantId, reason },
    });
  }

  feature(a: Actor, idOrSlug: string) {
    need(a, 'admin');
    const q = this.question(idOrSlug);
    return this.commit({ question_id: q.id, type: 'RoomFeatured', actor_id: a.id, actor_role: a.role, payload: {} });
  }

  /** Records what is about to be displayed. Reuses the last snapshot if nothing that affects the result has happened since. */
  publish(idOrSlug: string) {
    const q = this.question(idOrSlug);
    const last = this.state.snapshots.findLast((x) => x.questionId === q.id);
    if (last && last.asOfSeq >= q.lastSeq) return last;
    const r = computeResult(this.state, q.id);
    this.commit({
      question_id: q.id,
      type: 'ResultPublished',
      actor_id: 'system',
      actor_role: 'system',
      payload: { as_of_seq: r.asOfSeq, algorithm: r.algorithm, figures: r.figures, input_hash: r.inputHash },
    });
    return this.state.snapshots.at(-1)!;
  }

  // ---------- helpers ----------

  private open(idOrSlug: string) {
    const q = this.question(idOrSlug);
    if (q.closedSeq) throw new HttpError(409, 'question is closed');
    return q;
  }

  private rateLimit(questionId: string, ip: string) {
    const k = `${questionId}|${ip}`;
    const now = this.clock().getTime();
    const hits = (this.newcomers.get(k) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= NEW_PARTICIPANTS_PER_MINUTE) throw new HttpError(429, 'too many new participants from this address; try again in a minute');
    hits.push(now);
    this.newcomers.set(k, hits);
  }

  /** Flags, never blocks: a new participant on a device another participant used on this question moments ago. */
  private suspect(questionId: string, participantId: string, device: string): string | null {
    const since = new Date(this.clock().getTime() - SUSPECT_WINDOW_MS).toISOString();
    for (const v of this.state.votes.values()) {
      if (v.questionId === questionId && v.device === device && v.participantId !== participantId && v.at >= since) {
        return 'same IP and browser as another new participant within 10 minutes';
      }
    }
    return null;
  }

  // Prototype anchoring: the head hash goes to a local file. The real version publishes it somewhere the operator cannot rewrite.
  anchor() {
    const h = this.ledger.head();
    appendFileSync(this.anchorFile!, JSON.stringify({ seq: h.seq, hash: h.hash, at: h.recorded_at }) + '\n');
  }

  private checkAnchors() {
    if (!this.anchorFile || !existsSync(this.anchorFile)) return { checked: 0, mismatches: [] };
    const lines = readFileSync(this.anchorFile, 'utf8').split('\n').filter(Boolean);
    const mismatches = lines
      .map((l) => JSON.parse(l) as { seq: number; hash: string })
      .filter((x) => this.ledger.hashAt(x.seq) !== x.hash)
      .map((x) => x.seq);
    return { checked: lines.length, mismatches };
  }
}
