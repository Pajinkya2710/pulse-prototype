import type { LedgerEvent, Role } from '../ledger/ledger';

export type Choice = 'Yes' | 'No' | 'Unsure';
export type Decision = 'approve' | 'reject' | 'annotate';

export interface Question {
  id: string;
  slug: string;
  title: string;
  description: string;
  createdSeq: number;
  createdAt: string;
  closedSeq: number | null;
  /** Last event that can change this question's result (snapshots and featuring excluded). */
  lastSeq: number;
}

export interface Vote {
  id: string;
  seq: number;
  at: string;
  questionId: string;
  participantId: string;
  choice: Choice;
  confidence: number;
  supersedes: string | null;
  evidenceVisible: string[];
  device: string;
  suspected: string | null;
}

export interface Review {
  decision: Decision;
  reason: string;
  actorId: string;
  actorRole: Role;
  overrides: number | null;
  seq: number;
  at: string;
}

export interface Evidence {
  id: string;
  seq: number;
  at: string;
  questionId: string;
  title: string;
  url: string;
  summary: string;
  submittedBy: string;
  submittedRole: Role;
  status: 'pending' | 'approved' | 'rejected';
  reviews: Review[];
  /** First approval: when participants could first see it. */
  visibleSeq: number | null;
  visibleAt: string | null;
}

export interface Exclusion {
  voteId: string;
  reason: string;
  actorId: string;
  seq: number;
  at: string;
}

export interface Snapshot {
  eventSeq: number;
  at: string;
  questionId: string;
  asOfSeq: number;
  algorithm: string;
  figures: any;
  inputHash: string;
}

export interface State {
  seq: number;
  at: string;
  questions: Map<string, Question>;
  /** Every vote ever cast, in seq order. Revisions are new entries linked by `supersedes`. */
  votes: Map<string, Vote>;
  /** questionId|participantId -> latest vote id */
  current: Map<string, string>;
  /** questionId|participantId -> exclusion. A duplicate is an identity, so exclusion covers all its votes. */
  excluded: Map<string, Exclusion>;
  evidence: Map<string, Evidence>;
  snapshots: Snapshot[];
  featured: string | null;
}

export const key = (questionId: string, participantId: string) => `${questionId}|${participantId}`;

export const emptyState = (): State => ({
  seq: 0,
  at: '',
  questions: new Map(),
  votes: new Map(),
  current: new Map(),
  excluded: new Map(),
  evidence: new Map(),
  snapshots: [],
  featured: null,
});

/** The only place events turn into state. Pure apart from mutating `s`; same events in, same state out. */
export function apply(s: State, e: LedgerEvent): State {
  const p = e.payload;
  const qid = e.question_id!;
  switch (e.type) {
    case 'QuestionCreated':
      s.questions.set(qid, {
        id: qid,
        slug: p.slug,
        title: p.title,
        description: p.description ?? '',
        createdSeq: e.seq,
        createdAt: e.recorded_at,
        closedSeq: null,
        lastSeq: e.seq,
      });
      break;
    case 'QuestionClosed':
      s.questions.get(qid)!.closedSeq = e.seq;
      break;
    case 'VoteCast':
      s.votes.set(e.id, {
        id: e.id,
        seq: e.seq,
        at: e.recorded_at,
        questionId: qid,
        participantId: p.participant_id,
        choice: p.choice,
        confidence: p.confidence,
        supersedes: p.supersedes,
        evidenceVisible: p.evidence_visible,
        device: p.device,
        suspected: p.suspected,
      });
      s.current.set(key(qid, p.participant_id), e.id);
      break;
    case 'VoteExcluded':
      s.excluded.set(key(qid, p.participant_id), {
        voteId: p.vote_id,
        reason: p.reason,
        actorId: e.actor_id,
        seq: e.seq,
        at: e.recorded_at,
      });
      break;
    case 'EvidenceSubmitted':
      s.evidence.set(e.id, {
        id: e.id,
        seq: e.seq,
        at: e.recorded_at,
        questionId: qid,
        title: p.title,
        url: p.url,
        summary: p.summary,
        submittedBy: e.actor_id,
        submittedRole: e.actor_role,
        status: 'pending',
        reviews: [],
        visibleSeq: null,
        visibleAt: null,
      });
      break;
    case 'EvidenceReviewed': {
      const ev = s.evidence.get(p.evidence_id)!;
      ev.reviews.push({
        decision: p.decision,
        reason: p.reason,
        actorId: e.actor_id,
        actorRole: e.actor_role,
        overrides: p.overrides,
        seq: e.seq,
        at: e.recorded_at,
      });
      if (p.decision === 'approve') ev.status = 'approved';
      if (p.decision === 'reject') ev.status = 'rejected';
      if (ev.status === 'approved' && ev.visibleSeq === null) {
        ev.visibleSeq = e.seq;
        ev.visibleAt = e.recorded_at;
      }
      break;
    }
    case 'ResultPublished':
      s.snapshots.push({
        eventSeq: e.seq,
        at: e.recorded_at,
        questionId: qid,
        asOfSeq: p.as_of_seq,
        algorithm: p.algorithm,
        figures: p.figures,
        inputHash: p.input_hash,
      });
      break;
    case 'RoomFeatured':
      s.featured = qid;
      break;
  }
  const q = s.questions.get(qid);
  if (q && e.type !== 'ResultPublished' && e.type !== 'RoomFeatured') q.lastSeq = e.seq;
  s.seq = e.seq;
  s.at = e.recorded_at;
  return s;
}

export const replay = (events: LedgerEvent[]): State => events.reduce(apply, emptyState());

/** Current votes on a question that count: latest per participant, excluded identities removed. */
export function countedVotes(s: State, questionId: string): Vote[] {
  const out: Vote[] = [];
  for (const [k, voteId] of s.current) {
    if (k.startsWith(questionId + '|') && !s.excluded.has(k)) out.push(s.votes.get(voteId)!);
  }
  return out;
}
