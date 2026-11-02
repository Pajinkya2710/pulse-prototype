import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

export const DB_FILE = process.env.PULSE_DB ?? fileURLToPath(new URL('../pulse.db', import.meta.url));
export const ANCHOR_FILE = process.env.PULSE_ANCHORS ?? fileURLToPath(new URL('../anchors.log', import.meta.url));
export const SECRET = process.env.PULSE_SECRET ?? 'dev-secret-change-me';

export function openDb(file = DB_FILE) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return db;
}
