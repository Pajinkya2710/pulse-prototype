// Demo only: simulates someone with raw database access flipping a recorded vote.
// The trigger blocks UPDATE, so this drops it, edits the row, and puts it back, as an attacker would.
// Usage: npm run tamper [-- <seq>]   (default: the first VoteCast). Re-run `npm run seed` to restore.
import { openDb } from '../db';
import { Ledger } from '../ledger/ledger';

const db = openDb();
const arg = process.argv[2];
const row = (
  arg
    ? db.prepare("SELECT seq, payload FROM events WHERE seq = ? AND type = 'VoteCast'").get(Number(arg))
    : db.prepare("SELECT seq, payload FROM events WHERE type = 'VoteCast' ORDER BY seq LIMIT 1").get()
) as { seq: number; payload: string } | undefined;
if (!row) throw new Error('no VoteCast event found at that seq');

const payload = JSON.parse(row.payload);
const flipped = payload.choice === 'Yes' ? 'No' : 'Yes';
db.exec('DROP TRIGGER events_no_update');
db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify({ ...payload, choice: flipped }), row.seq);
new Ledger(db); // recreates the trigger
console.log(`seq ${row.seq}: choice ${payload.choice} -> ${flipped}. Now run: npm run verify`);
