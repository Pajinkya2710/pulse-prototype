import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ledger, canonical } from '../src/ledger/ledger';
import { Pulse, type Actor } from '../src/pulse';
import { fingerprint, rebuild } from '../src/projections/store';
import { countedVotes, replay } from '../src/projections/state';
import { computeResult } from '../src/results/results';

const admin: Actor = { id: 'admin', role: 'admin' };
const mod: Actor = { id: 'mod', role: 'moderator' };
const client = { ip: '1.1.1.1', ua: 'test' };

function setup() {
  let t = Date.UTC(2026, 0, 1);
  const pulse = new Pulse(new Database(':memory:'), { clock: () => new Date((t += 60_000)) });
  const q = pulse.createQuestion(admin, { slug: 'q-one', title: 'Is this a question?', description: '' }).question_id!;
  const vote = (a: Actor, choice: 'Yes' | 'No' | 'Unsure', confidence: number, id = randomUUID()) =>
    pulse.castVote(a, q, { id, choice, confidence, evidenceVisible: [] }, client);
  return { pulse, q, vote };
}
const participant = (): Actor => ({ id: randomUUID(), role: 'participant' });

describe('ledger', () => {
  it('rejects UPDATE and DELETE at the database level', () => {
    const { pulse } = setup();
    expect(() => pulse.db.prepare("UPDATE events SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => pulse.db.prepare('DELETE FROM events').run()).toThrow(/append-only/);
  });

  it('detects a row edited behind its back, at the first broken link', () => {
    const { pulse, vote } = setup();
    const a = participant();
    vote(a, 'No', 80);
    vote(a, 'Yes', 60);
    expect(pulse.verify().ok).toBe(true);
    pulse.db.exec('DROP TRIGGER events_no_update');
    pulse.db.prepare("UPDATE events SET payload = replace(payload, '\"No\"', '\"Yes\"') WHERE seq = 2").run();
    const r = pulse.verify();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(2);
  });

  it('replay is deterministic and a rebuild yields identical projections', () => {
    const { pulse, q, vote } = setup();
    for (let i = 0; i < 5; i++) vote(participant(), i % 2 ? 'Yes' : 'No', 20 * i);
    const live = computeResult(pulse.state, q);
    const replayed = computeResult(replay(pulse.ledger.events()), q);
    expect(canonical(replayed)).toBe(canonical(live));
    const before = fingerprint(pulse.db);
    rebuild(pulse.db, pulse.ledger.events());
    expect(fingerprint(pulse.db)).toBe(before);
    // the SQL projection and a replay at the head agree
    expect(pulse.listQuestions(String(pulse.state.seq))).toEqual(pulse.listQuestions());
  });

  it('a revision supersedes, never overwrites', () => {
    const { pulse, q, vote } = setup();
    const a = participant();
    const first = vote(a, 'No', 80);
    const second = vote(a, 'Unsure', 50);
    expect(second.payload.supersedes).toBe(first.id);
    expect(countedVotes(pulse.state, q)).toHaveLength(1);
    expect(pulse.state.votes.size).toBe(2);
    expect(computeResult(pulse.stateAt(String(first.seq)), q).figures.lean).toBe(-80); // the past is still there
  });

  it('a retried submission is recorded once', () => {
    const { pulse, vote } = setup();
    const a = participant();
    const id = randomUUID();
    vote(a, 'Yes', 70, id);
    const head = pulse.state.seq;
    vote(a, 'Yes', 70, id);
    expect(pulse.state.seq).toBe(head);
  });

  it('a moderator cannot reverse an administrator, and both decisions stay on record', () => {
    const { pulse, q } = setup();
    const ev = pulse.submitEvidence(admin, q, { title: 'A source', url: 'https://example.com', summary: '' }).id;
    pulse.reviewEvidence(mod, ev, { decision: 'reject', reason: 'off topic' });
    pulse.reviewEvidence(admin, ev, { decision: 'approve', reason: 'relevant' });
    expect(() => pulse.reviewEvidence(mod, ev, { decision: 'reject', reason: 'still off topic' })).toThrow(/administrator/);
    const e = pulse.state.evidence.get(ev)!;
    expect(e.status).toBe('approved');
    expect(e.reviews.map((r) => r.decision)).toEqual(['reject', 'approve']);
  });

  it('published snapshots recompute from the ledger', () => {
    const { pulse, q, vote } = setup();
    vote(participant(), 'Yes', 90);
    pulse.publish(q);
    vote(participant(), 'No', 30);
    pulse.publish(q);
    expect(pulse.audit(q, admin).snapshots.every((s) => s.matches)).toBe(true);
  });

  it('participants see that rejected evidence exists and why, but not its content', () => {
    const { pulse, q } = setup();
    const author = participant();
    const ev = pulse.submitEvidence(author, q, { title: 'Bad source', url: 'https://example.com/x', summary: '' }).id;
    pulse.reviewEvidence(mod, ev, { decision: 'reject', reason: 'no citations' });
    const other = participant();
    const seen = pulse.view(q, other).evidence[0];
    expect(seen).toMatchObject({ hidden: true, title: null, url: null, status: 'rejected' });
    expect(seen.reviews[0].reason).toBe('no citations');
    expect(pulse.audit(q, other).evidence[0].title).toBeNull();
    expect(pulse.view(q, author).evidence[0].title).toBe('Bad source'); // the author still sees their own
    expect(pulse.view(q, mod).evidence[0].title).toBe('Bad source');
    // a participant cannot claim to have been shown evidence they could not see
    const v = pulse.castVote(other, q, { id: randomUUID(), choice: 'Yes', confidence: 50, evidenceVisible: [ev] }, client);
    expect(v.payload.evidence_visible).toEqual([]);
  });

  it('audit names the result the Room was showing at that moment', () => {
    const { pulse, q, vote } = setup();
    vote(participant(), 'Yes', 90);
    const first = pulse.publish(q);
    const mid = pulse.state.seq;
    vote(participant(), 'No', 30);
    pulse.publish(q);
    expect(pulse.audit(q, admin, String(mid)).displayed).toMatchObject({ eventSeq: first.eventSeq, matches: true });
  });

  it('flags a second new participant on the same device, without dropping the vote', () => {
    const { pulse, q, vote } = setup();
    vote(participant(), 'Yes', 100);
    const dup = vote(participant(), 'Yes', 100);
    expect(dup.payload.suspected).toBeTruthy();
    expect(computeResult(pulse.state, q).figures).toMatchObject({ n: 2, suspected: 1 });
  });

  it('any user can create a question, and each gets a unique link', () => {
    const { pulse } = setup();
    const a = pulse.createQuestion(participant(), { title: 'Same title twice?', description: '' }).payload.slug;
    const b = pulse.createQuestion(participant(), { title: 'Same title twice?', description: '' }).payload.slug;
    expect(a).toMatch(/^same-title-twice-[0-9a-f]{6}$/);
    expect(b).not.toBe(a);
  });

  it('a fresh Ledger on the same file keeps chaining from the stored head', () => {
    const db = new Database(':memory:');
    new Ledger(db).append({ question_id: null, type: 'QuestionCreated', actor_id: 'a', actor_role: 'admin', payload: {} });
    new Ledger(db).append({ question_id: null, type: 'QuestionCreated', actor_id: 'a', actor_role: 'admin', payload: {} });
    expect(new Ledger(db).verify()).toMatchObject({ ok: true, checked: 2 });
  });
});
