import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { ANCHOR_FILE, SECRET, openDb } from './db';
import { Pulse } from './pulse';
import { routes } from './routes/routes';

const pulse = new Pulse(openDb(), { secret: SECRET, anchorFile: ANCHOR_FILE });
const app = Fastify({ logger: { level: 'warn' } });
await app.register(cookie, { secret: SECRET });
routes(app, pulse);

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '127.0.0.1' });
console.log(`PULSE API on http://127.0.0.1:${port} (ledger head seq ${pulse.state.seq})`);
