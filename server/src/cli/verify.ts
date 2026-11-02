import { ANCHOR_FILE, openDb } from '../db';
import { Pulse } from '../pulse';

const report = new Pulse(openDb(), { anchorFile: ANCHOR_FILE }).verify();
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok && report.anchors.mismatches.length === 0 ? 0 : 1);
