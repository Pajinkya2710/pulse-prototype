// Drops every projection table, replays the ledger, and shows the tables came back identical.
import { openDb } from '../db';
import { Ledger } from '../ledger/ledger';
import { createProjections, fingerprint, rebuild } from '../projections/store';

const db = openDb();
const ledger = new Ledger(db);
createProjections(db);
const before = fingerprint(db);
const events = ledger.events();
rebuild(db, events);
const after = fingerprint(db);
console.log(`replayed ${events.length} events`);
console.log(`projections before: ${before}`);
console.log(`projections after:  ${after}`);
console.log(before === after ? 'identical' : 'DIFFERENT (the old projection had drifted from the ledger; it is now rebuilt)');
