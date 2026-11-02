import { canonical, sha256, type LedgerEvent } from '../ledger/ledger';
import { apply, countedVotes, emptyState, key, type Snapshot, type State, type Vote } from '../projections/state';

const SIGN = { Yes: 1, No: -1, Unsure: 0 } as const;
const DAY = 24 * 3600 * 1000;

/** Signed belief, -100..100. Unsure scores 0 whatever its confidence: there, confidence means "this is genuinely open". */
export const score = (v: Vote) => SIGN[v.choice] * v.confidence;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places;
const iso = (ms: number) => new Date(ms).toISOString();

/** Lean, agreement and plain Yes share for a set of votes. Shared by results and the timeline. */
export function basic(votes: Vote[]) {
  const scores = votes.map(score);
  const m = mean(scores);
  const spread = Math.sqrt(mean(scores.map((x) => (x - m) ** 2))); // max 100 on a -100..100 scale
  return {
    n: votes.length,
    lean: round(m),
    agreement: votes.length ? round(1 - spread / 100, 2) : null,
    yesShare: votes.length ? round((votes.filter((v) => v.choice === 'Yes').length / votes.length) * 100) : null,
  };
}

/** Revisions recorded in (from, to], with their direction. Excluded identities are left out. */
function shifts(s: State, questionId: string, from: string, to: string) {
  const out = { revisions: 0, towardYes: 0, towardNo: 0, changedChoice: 0 };
  for (const v of s.votes.values()) {
    if (v.questionId !== questionId || !v.supersedes || v.at <= from || v.at > to) continue;
    if (s.excluded.has(key(questionId, v.participantId))) continue;
    const prev = s.votes.get(v.supersedes)!;
    const d = score(v) - score(prev);
    out.revisions++;
    if (d > 0) out.towardYes++;
    if (d < 0) out.towardNo++;
    if (v.choice !== prev.choice) out.changedChoice++;
  }
  return out;
}

function v1(s: State, questionId: string) {
  const votes = countedVotes(s, questionId);
  const now = Date.parse(s.at);
  const count = (c: Vote['choice']) => votes.filter((v) => v.choice === c).length;
  return {
    ...basic(votes),
    counts: { Yes: count('Yes'), No: count('No'), Unsure: count('Unsure') },
    suspected: votes.filter((v) => v.suspected).length,
    leanWithoutSuspected: basic(votes.filter((v) => !v.suspected)).lean,
    excluded: [...s.excluded.keys()].filter((k) => k.startsWith(questionId + '|')).length,
    movement: { windowHours: 24, ...shifts(s, questionId, iso(now - DAY), s.at) },
    afterEvidence: [...s.evidence.values()]
      .filter((e) => e.questionId === questionId && e.status === 'approved' && e.visibleAt)
      .map((e) => {
        const end = Math.min(Date.parse(e.visibleAt!) + DAY, now);
        return { evidenceId: e.id, title: e.title, visibleAt: e.visibleAt, ...shifts(s, questionId, e.visibleAt!, iso(end)) };
      }),
  };
}

/** Old snapshots keep their algorithm; a v2 is added here, never by changing v1. */
export const ALGORITHMS: Record<string, (s: State, questionId: string) => unknown> = { v1 };
export const CURRENT_ALGORITHM = 'v1';

export function computeResult(s: State, questionId: string, algorithm = CURRENT_ALGORITHM) {
  const inputs = countedVotes(s, questionId)
    .map((v) => `${v.id}:${v.choice}:${v.confidence}`)
    .sort();
  return {
    questionId,
    asOfSeq: s.seq,
    asOfTime: s.at,
    algorithm,
    figures: ALGORITHMS[algorithm](s, questionId) as ReturnType<typeof v1>,
    inputHash: sha256(canonical(inputs)),
  };
}

// ponytail: recomputes from scratch after each vote, O(events x votes); incremental counters if questions get big.
export function timeline(events: LedgerEvent[], questionId: string) {
  const s = emptyState();
  const points = [];
  for (const e of events) {
    apply(s, e);
    if (e.question_id === questionId && (e.type === 'VoteCast' || e.type === 'VoteExcluded')) {
      points.push({ seq: e.seq, at: e.recorded_at, ...basic(countedVotes(s, questionId)) });
    }
  }
  const markers = [...s.evidence.values()]
    .filter((ev) => ev.questionId === questionId && ev.status === 'approved')
    .map((ev) => ({ id: ev.id, title: ev.title, seq: ev.visibleSeq!, at: ev.visibleAt! }));
  return { points, markers };
}

/** Replays the ledger once and recomputes every snapshot at its own seq with its own algorithm version. */
export function checkSnapshots(events: LedgerEvent[], snapshots: Snapshot[]) {
  const s = emptyState();
  let i = 0;
  return [...snapshots]
    .sort((a, b) => a.asOfSeq - b.asOfSeq)
    .map((snap) => {
      while (i < events.length && events[i].seq <= snap.asOfSeq) apply(s, events[i++]);
      if (!ALGORITHMS[snap.algorithm]) return { ...snap, matches: false, note: `unknown algorithm ${snap.algorithm}` };
      const re = computeResult(s, snap.questionId, snap.algorithm);
      const matches = canonical(re.figures) === canonical(snap.figures) && re.inputHash === snap.inputHash;
      return { ...snap, matches, recomputed: matches ? undefined : re.figures };
    })
    .sort((a, b) => a.eventSeq - b.eventSeq);
}
