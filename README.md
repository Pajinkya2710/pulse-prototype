# PULSE

A prototype for collective belief tracking. Its single source of truth is an append-only, hash-chained event ledger. Current votes, results and the Room are all projections, which can be rebuilt from that ledger at any point in its history.

## Run it

Requires Node 20 or later. Nothing else: the database is a SQLite file.

```
npm install
npm run seed     # recreates the Mars example with fixed timestamps (wipes the database; stop dev first)
npm run dev      # API on :3001, web on http://localhost:5173
```

## Where to click

- **http://localhost:5173/#/q/mars-2040** is the brief's example question ("Will humans establish a permanent settlement on Mars before 2040?"). It shows the result, the timeline with evidence markers (E1…), the evidence list and each participant's trajectory. Participant A follows the brief: No 80 → Unsure 50 (Day 2, 16:30) → Yes 60 (Day 4, 12:15).
- Drag the **Time travel** slider to redraw the whole page as it stood at that point. Click a trajectory step to see which evidence existed, which was approved and which the participant was shown.
- **Ask a question** (home page, any role) creates a question and takes you to its unique link. **Copy share link** is on every question page.
- **http://localhost:5173/#/room** is the big screen. It shows the featured question live over Server-Sent Events, at most one update per second, and each update states the ledger seq it reflects.
- **Audit** (link on the question page) has a button to verify the chain, a recompute check for every published result, the moderation record and the exclusions.
- **Admin** features a question in the Room and closes questions. Moderation and duplicate exclusion are on each question page for moderators and admins.

**Roles.** Use the *dev role* switcher at the top right. It sets an `x-role` header. **This is not authentication:** anyone can choose any role. Participants are identified by a signed, httpOnly cookie, so to act as two participants use two browsers, or one normal window and one private window.

## Integrity demo

```
npm run verify     # walks the hash chain and checks the anchor log
npm run tamper     # simulates raw DB access: drops the trigger, flips a recorded vote, restores the trigger
npm run verify     # reports the first broken link (seq and reason)
npm run rebuild    # drops the projection tables, replays the ledger, and prints before/after fingerprints
npm run seed       # restore
```

`npm run e2e` drives your installed Edge or Chrome through every role in 21 checks. It covers creating and sharing a question, voting, revision, time travel, Room updates, moderation precedence, duplicate exclusion, audit, tamper detection, dark mode and phone width. It uses its own database and ports (3101 and 5174), so your seeded data is untouched. Screenshots land in `e2e/out/`.

`npm test` runs the ledger and replay tests: append-only enforcement, tamper detection, deterministic replay and rebuild, revisions, idempotent retries, unique question links for any user, role precedence in moderation, snapshot recompute, duplicate flagging, evidence redaction for participants, and the audit naming what the Room displayed.

Every read endpoint accepts `?asOf=<seq>` or `?asOf=<ISO time>`, for example
`/api/questions/mars-2040/audit?asOf=2026-03-02T17:00:00Z`, which shows participant A at Unsure 50 with only E1 in existence.

## Layout

```
server/src/ledger/       append, hash chain, verify
server/src/projections/  pure event reducer (state.ts) and rebuildable SQL tables (store.ts)
server/src/results/      algorithm v1, timeline, snapshot recompute
server/src/room/         SSE hub with throttle
server/src/routes/       HTTP handlers and request validation (zod)
server/src/pulse.ts      commands (role checks) and reads
web/src/pages/           Question, Room, Admin, Audit
docs/DECISIONS.md        design decisions and what was left out
docs/diagram.svg         data lineage
seed.ts                  the Mars example
```
