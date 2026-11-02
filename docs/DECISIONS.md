# DECISIONS

## 1. What did you build?

PULSE records what a group believes, how confident it is, how that changes, and what evidence existed at each change. Anyone can ask a question and share its unique link. Participants vote Yes, No or Unsure with a confidence from 0 to 100, and can revise. Evidence can be submitted at any time and is moderated. The **Room** shows one featured question to everyone, pushed over Server-Sent Events at most once a second.

A result is four figures, each shown with n:
- **Lean:** the mean of choice × confidence (Yes +1, No −1, Unsure 0), from −100 to +100. It separates a confident split from a lukewarm one.
- **Agreement:** 1 − stddev/100. Low agreement with a neutral lean means polarised, not undecided.
- **Movement:** revisions in the last 24h, by direction.
- **After evidence:** revisions in the 24h after each item appeared.

**What they conceal:** confidence is self-reported and uncalibrated, small groups swing, and timing is correlation, not cause. I decided that for Unsure, confidence means "how sure I am this is open", so Unsure scores 0. Every view takes `?asOf=` and redraws the question as it stood then.

## 2. What did you deliberately leave out, and why?

| Left out | Why, and what would replace it |
|---|---|
| Real sign-in | A dev role switcher sets a header, stated plainly. Later: magic link or OAuth, roles server-side |
| Language model | No gain worth the risk to a trust-focused record. If added: a summary citing evidence ids, labelled, never feeding a result |
| Editing question text | Earlier voters answered the original wording. Later: a new question linked to the old one |
| External anchoring | Needs a third party. Later: publish the chain head to a transparency log |
| Deployment, polish, several Rooms | Not assessed |

## 3. What were your three most important design decisions?

1. **One append-only, hash-chained event ledger is the only authoritative record.** Votes, evidence status, results and the Room are projections. One pure reducer serves the live view, every historical read and `npm run rebuild`, so a past view cannot disagree with the present.
2. **Votes and evidence share one sequence number.** "Evidence that existed when this vote was cast" is evidence with a lower seq, whatever order they arrived in. Each vote also records what the participant was shown, so *existed* and *seen* stay separate.
3. **Every result shown in the Room is recorded first.** A `ResultPublished` event holds the seq it reflects, the algorithm version, the figures and a hash of the input votes, so a disputed figure can be recomputed and compared. A new algorithm becomes `v2`, never an edit to `v1`.

## 4. What does your data model treat as permanent, and what may change?

**Permanent:** every event, including its seq, content, actor, role and server timestamp. Database triggers abort UPDATE and DELETE on `events`. Each hash covers the previous one, so an edit made behind the app's back breaks the chain at that row; `npm run verify` names it.

**Changes happen only by appending an event with an actor and a reason:**

| Role | May | May not |
|---|---|---|
| Participant | create questions; vote and revise their own vote; submit evidence | alter any past vote; see others' identities or others' unapproved evidence |
| Moderator | approve, reject or annotate evidence | edit evidence; touch votes; reverse an administrator |
| Administrator | close and feature questions; exclude a duplicate; override a moderator | alter, delete or backdate any event |

**Conflicts:** role precedence decides, and both decisions stay visible ("rejected by moderator, approved by admin: reason"). The SQL projection tables are disposable and rebuilt from the ledger.

## 5. How do you preserve the history of an opinion?

A revision is a new `VoteCast` whose `supersedes` points at the previous vote. The server sets that field, never the client. Nothing is overwritten. The current vote is the latest in the chain, and the chain is the history. A client-generated id makes a retried submission count once.

**Duplicates** are one person with two identities, not a revision. The defences:
- a signed cookie per participant;
- at most 5 newcomers per IP per question per minute;
- a newcomer on the same IP and browser within 10 minutes is flagged *suspected* but still counted, with the lean also shown without them;
- an admin can exclude an identity, and its votes stay on record.

A private window, a second device or a VPN defeats all of this.

## 6. How do you relate evidence to opinions held at different times?

Through the shared seq. For each vote, the audit lists the evidence that **existed**, was **approved**, and was **shown** to that participant. The server only accepts "shown" ids the participant could actually see. In the brief's example, A moved to Unsure 50 at Day 2 16:30 when only the life-support study existed, and to Yes 60 on Day 4 after the agency announcement.

Time windows are measured against the ledger state being viewed, not the wall clock, so every figure is a pure function of the record and can be recomputed. For bursty questions the timeline defaults to event order, because "over time" says little when most votes arrive in one hour.

## 7. What fails at one hundred users?

- **Roles.** Anyone can pick admin, so real use needs sign-in.
- **Shared networks.** Behind one NAT, everyone has the same IP: the rate limit blocks the sixth newcomer in a minute, and same-browser users get flagged as suspected.
- **The question page isn't live.** Only the Room is pushed.

The data side copes: replay-from-genesis reads and the O(events × votes) timeline are fine at this size.

## 8. What fails at one hundred thousand concurrent users?

- **Fails first:** the single write path. SQLite has one writer, the global chain serialises every vote, and each Room push recomputes from scratch. SSE connections on one Node process come next.
- **Change vs keep:** keep the ledger, the idempotency keys and the versioned algorithms. Change the write path to validate, enqueue durably, and batch-append to Postgres, with a chain per question so ordering is no longer global.
- **No vote lost, none twice:** acknowledge only after the queue accepts the vote. Delivery is at-least-once and the vote id is unique, so a redelivery is a no-op.
- **Live results:** incremental counters pushed on a fixed 1–2s tick, each stating its seq and the queued backlog.
- **Caching helps** for question pages, evidence and any snapshot keyed by `as_of_seq`, which never changes.
- **Caching misleads** when a TTL-cached "current result" shows figures matching no recorded snapshot. Never cache duplicate checks or rate limits.

## 9. What would change before production?

Real sign-in; Postgres with UPDATE and DELETE revoked from the app role; the chain head published externally; `trustProxy` behind a load balancer; rate limits on creating questions and evidence; security headers, backups and monitoring; historical states cached by seq; and a ledger export with hashed participant ids so a disputing party can verify independently.

## 10. With one more day, what would you redesign first?

Move personal and free-text content out of the hashed rows into a content store, keeping only its hash in the event. Today a legal or privacy removal would break the chain; after the change it leaves a recorded gap. This is the decision that gets most expensive once real data is in the ledger.

---

**AI tools used.** Claude Code (Anthropic) generated most of the code and the first draft of these documents from my build plan. I reviewed, ran and tested it, and can explain every part.
