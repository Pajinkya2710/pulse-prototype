import type { ServerResponse } from 'node:http';
import type { Pulse } from '../pulse';

const MIN_INTERVAL_MS = 1000;

/**
 * Pushes the featured question's result to every Room screen, at most once a second.
 * Each push is recorded as a ResultPublished snapshot first, so the ledger holds exactly what the screen showed.
 */
export function roomHub(pulse: Pulse) {
  const clients = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | null = null;
  let lastSent = 0;

  const message = () => {
    const qid = pulse.state.featured;
    if (!qid) return { question: null, snapshot: null };
    const q = pulse.state.questions.get(qid)!;
    return { question: { id: q.id, slug: q.slug, title: q.title, closed: !!q.closedSeq }, snapshot: pulse.publish(qid) };
  };
  const write = (res: ServerResponse, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const broadcast = () => {
    timer = null;
    lastSent = Date.now();
    const data = message();
    for (const c of clients) write(c, data);
  };

  pulse.onEvent((e) => {
    if (!clients.size || e.type === 'ResultPublished') return;
    if (e.type !== 'RoomFeatured' && e.question_id !== pulse.state.featured) return;
    timer ??= setTimeout(broadcast, Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastSent)));
  });

  setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 25_000).unref();

  return {
    add(res: ServerResponse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      res.on('close', () => clients.delete(res));
      write(res, message());
    },
  };
}
