// Recreates the brief's illustrative Mars sequence with fixed timestamps, so the timeline means something on first run.
// Participant A, Participant B and evidence E1 and E2 follow the brief exactly. The other participants and evidence
// are additions that exercise the rest of the system: duplicate flagging, a rejected item, and an admin overriding a moderator.
// Wipes the database: stop `npm run dev` before running this.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ANCHOR_FILE, SECRET, openDb } from './server/src/db';
import { Pulse, type Actor } from './server/src/pulse';
import type { Choice } from './server/src/projections/state';

const db = openDb();
// DROP TABLE is not an UPDATE or DELETE, so the append-only triggers do not stop a full reset.
for (const t of ['events', 'current_votes', 'evidence_state', 'question_summary']) db.exec(`DROP TABLE IF EXISTS ${t}`);
writeFileSync(ANCHOR_FILE, '');

let now: Date;
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  now = new Date(Date.UTC(2026, 2, day, h, m)); // Day 1 = 2026-03-01
};
at(1, '09:00');
const pulse = new Pulse(db, { clock: () => now, secret: SECRET, anchorFile: ANCHOR_FILE });

const admin: Actor = { id: 'admin-amara', role: 'admin' };
const mod: Actor = { id: 'mod-kofi', role: 'moderator' };
const people: Record<string, Actor> = Object.fromEntries('ABCDEFGH'.split('').map((l) => [l, { id: randomUUID(), role: 'participant' }]));
const device = (l: string) => (l === 'G' || l === 'H' ? { ip: '10.0.0.77', ua: 'Firefox/140' } : { ip: `10.0.1.${l.charCodeAt(0)}`, ua: 'Chrome/141' });

// Day 1, 09:00: a question is created and its link is shared.
const q = pulse.createQuestion(admin, {
  slug: 'mars-2040',
  title: 'Will humans establish a permanent settlement on Mars before 2040?',
  description: 'Permanent means continuously inhabited. Vote what you believe now and revise as evidence arrives.',
}).question_id!;
pulse.feature(admin, q);

const visible = () => [...pulse.state.evidence.values()].filter((e) => e.questionId === q && e.status === 'approved').map((e) => e.id);
const vote = (l: string, choice: Choice, confidence: number) =>
  pulse.castVote(people[l], q, { id: randomUUID(), choice, confidence, evidenceVisible: visible() }, device(l));
const evidence = (by: Actor, title: string, url: string, summary: string) => pulse.submitEvidence(by, q, { title, url, summary }).id;

// ---- Day 1 ----
// Pseudonyms are assigned in first-vote order, so A and B must vote first to stay the brief's A and B.
at(1, '09:20'); vote('A', 'No', 80); // brief
at(1, '11:05'); vote('B', 'Yes', 55); // brief
at(1, '11:30'); vote('C', 'Unsure', 50);
at(1, '11:50'); vote('D', 'No', 60);
at(1, '12:00'); vote('E', 'Yes', 40);
at(1, '12:30'); vote('F', 'No', 70);
at(1, '18:00'); pulse.publish(q);

// ---- Day 2 ----
at(2, '14:00'); // brief: evidence is added
const e1 = evidence(admin, 'Peer-reviewed study reports progress on long-duration life support',
  'https://example.org/evidence/long-duration-life-support',
  'A closed-loop system recycled air and water for a crew of four for 12 months with no resupply.');
at(2, '14:10'); pulse.reviewEvidence(mod, e1, { decision: 'approve', reason: 'Peer-reviewed; directly relevant' });
at(2, '15:00'); vote('D', 'Unsure', 50);
at(2, '16:30'); vote('A', 'Unsure', 50); // brief
at(2, '17:00'); vote('G', 'Yes', 90);
at(2, '17:02'); vote('H', 'Yes', 90); // same IP and browser as G two minutes earlier: flagged, still counted
at(2, '18:00'); pulse.publish(q);

// ---- Day 3 ----
at(3, '09:00');
const hVote = pulse.state.current.get(`${q}|${people.H.id}`)!;
pulse.excludeVote(admin, hVote, 'Same IP and browser as participant G two minutes apart; treated as one person');

// ---- Day 4 ----
at(4, '10:00'); // brief: evidence is added
const e2 = evidence(admin, 'National space agency announces a revised target date',
  'https://example.org/evidence/revised-target-date',
  'The agency publishes a revised timeline for crewed landings and a first surface habitat.');
at(4, '10:05'); pulse.reviewEvidence(mod, e2, { decision: 'approve', reason: 'Official announcement' });
at(4, '10:30'); pulse.reviewEvidence(mod, e2, { decision: 'annotate', reason: 'A target date is a plan, not a demonstration; read with care' });
at(4, '12:15'); vote('A', 'Yes', 60); // brief
at(4, '12:40'); vote('E', 'Yes', 55);
at(4, '13:30'); vote('F', 'Unsure', 40);
at(4, '15:00');
const e3 = evidence(people.F, 'Video: a Mars colony already exists in secret', 'https://example.org/evidence/secret-colony', 'No sources given.');
at(4, '15:20'); pulse.reviewEvidence(mod, e3, { decision: 'reject', reason: 'Not a credible source; no citations' });
at(4, '16:00');
const e4 = evidence(people.C, 'Heavy-lift rocket test campaign slips by a year',
  'https://example.org/evidence/test-campaign-slips',
  'The launcher needed for cargo flights is delayed, pushing the first uncrewed landing back.');
at(4, '16:10'); pulse.reviewEvidence(mod, e4, { decision: 'reject', reason: 'Off topic: about one rocket, not a settlement' });
at(4, '16:40'); pulse.reviewEvidence(admin, e4, { decision: 'approve', reason: 'Relevant: launch capacity bears directly on a 2040 settlement' });
at(4, '17:30'); vote('C', 'No', 55);
at(4, '18:00'); pulse.publish(q);
// Left open so the demo can vote live from two browsers and watch the Room update.

const v = pulse.verify();
console.log(`seeded ${pulse.state.seq} events; chain ok=${v.ok}, head ${v.head.slice(0, 12)}...`);
console.log('open http://localhost:5173/#/q/mars-2040');
