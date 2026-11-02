import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, type Actor, type Pulse } from '../pulse';
import { roomHub } from '../room/hub';

const AsOf = z.object({ asOf: z.string().optional() });
// The server generates the slug, so a share link is always unique.
const QuestionBody = z.object({
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().max(2000).default(''),
});
const VoteBody = z.object({
  id: z.string().uuid(), // client-generated; a retried request with the same id is recorded once
  choice: z.enum(['Yes', 'No', 'Unsure']),
  confidence: z.number().int().min(0).max(100),
  evidenceVisible: z.array(z.string()).max(500).default([]),
});
const EvidenceBody = z.object({
  title: z.string().trim().min(3).max(200),
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) links only'),
  summary: z.string().trim().max(2000).default(''),
});
const ReviewBody = z.object({ decision: z.enum(['approve', 'reject', 'annotate']), reason: z.string().trim().min(3).max(1000) });
const ReasonBody = z.object({ reason: z.string().trim().min(3).max(1000) });
const FeatureBody = z.object({ questionId: z.string() });
const RoleHeader = z.enum(['participant', 'moderator', 'admin']).default('participant');

declare module 'fastify' {
  interface FastifyRequest {
    pid: string;
  }
}

export function routes(app: FastifyInstance, pulse: Pulse) {
  const room = roomHub(pulse);

  // Participant identity: a signed, httpOnly cookie issued on first visit.
  app.decorateRequest('pid', '');
  app.addHook('onRequest', async (req, reply) => {
    const raw = req.cookies.pid;
    const signed = raw ? req.unsignCookie(raw) : null;
    req.pid = signed?.valid && signed.value ? signed.value : randomUUID();
    if (!signed?.valid) reply.setCookie('pid', req.pid, { signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 86400 });
  });

  // Prototype only: the role comes from a dev switcher header and must be one of the three known roles.
  // Staff identity is fixed per role (no free-text names). Real auth is listed as an omission in DECISIONS.md.
  const actor = (req: FastifyRequest): Actor => {
    const role = RoleHeader.parse(req.headers['x-role']);
    return { role, id: role === 'participant' ? req.pid : `${role}-dev` };
  };
  const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name];
  const asOf = (req: FastifyRequest) => AsOf.parse(req.query).asOf;

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    req.log.error(err);
    const status = (err as { statusCode?: number }).statusCode;
    return reply.status(status ?? 500).send({ error: status ? (err as Error).message : 'server error' });
  });

  app.get('/api/questions', async (req) => pulse.listQuestions(asOf(req)));
  app.post('/api/questions', async (req, reply) => reply.status(201).send(pulse.createQuestion(actor(req), QuestionBody.parse(req.body))));
  app.get('/api/questions/:id', async (req) => pulse.view(param(req, 'id'), actor(req), asOf(req)));
  app.post('/api/questions/:id/close', async (req) => pulse.closeQuestion(actor(req), param(req, 'id')));
  app.post('/api/questions/:id/votes', async (req, reply) =>
    reply.status(201).send(pulse.castVote(actor(req), param(req, 'id'), VoteBody.parse(req.body), { ip: req.ip, ua: req.headers['user-agent'] ?? '' })),
  );
  app.get('/api/questions/:id/result', async (req) => pulse.result(param(req, 'id'), asOf(req)));
  app.get('/api/questions/:id/timeline', async (req) => pulse.timeline(param(req, 'id'), asOf(req)));
  app.get('/api/questions/:id/audit', async (req) => pulse.audit(param(req, 'id'), actor(req), asOf(req)));
  app.post('/api/questions/:id/evidence', async (req, reply) =>
    reply.status(201).send(pulse.submitEvidence(actor(req), param(req, 'id'), EvidenceBody.parse(req.body))),
  );
  app.post('/api/evidence/:id/review', async (req) => pulse.reviewEvidence(actor(req), param(req, 'id'), ReviewBody.parse(req.body)));
  app.post('/api/votes/:id/exclude', async (req) => pulse.excludeVote(actor(req), param(req, 'id'), ReasonBody.parse(req.body).reason));
  app.get('/api/verify', async () => pulse.verify());
  app.post('/api/room/feature', async (req) => pulse.feature(actor(req), FeatureBody.parse(req.body).questionId));
  app.get('/api/room/stream', (req, reply) => {
    reply.hijack();
    room.add(reply.raw);
  });
}
