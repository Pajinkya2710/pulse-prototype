import { useEffect, useState } from 'react';
import { fmt, signed } from '../api';
import { Stats } from './Question';

export function RoomPage() {
  const [msg, setMsg] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/room/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource reconnects by itself
    es.onmessage = (e) => setMsg(JSON.parse(e.data));
    return () => es.close();
  }, []);

  const s = msg?.snapshot;
  return (
    <div className="room-screen">
      <div className="room-bar">
        <a href="#/">← Back</a>
        <div className="row">
          {msg?.question && <a href={`#/q/${msg.question.slug}`}>Open question</a>}
          <button onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>⛶ Fullscreen</button>
        </div>
      </div>
      <main className="room">
        {!msg ? (
          <p className="muted">Connecting…</p>
        ) : !msg.question ? (
          <p className="muted">No question is featured. An admin can feature one from the Admin page.</p>
        ) : (
          <>
            <p className="muted" style={{ letterSpacing: '.12em', fontWeight: 600 }}>
              {!connected ? '○ RECONNECTING' : msg.question.closed ? 'FINAL RESULT · VOTING CLOSED' : <span className="ok">● LIVE</span>}
            </p>
            <h1>{msg.question.title}</h1>
            {s.figures.n === 0 ? (
              <div className="big empty">No votes yet</div>
            ) : (
              <>
                <div className="big">{signed(s.figures.lean)}</div>
                <p className="muted">
                  lean, from −100 (confident No) to +100 (confident Yes) · n = {s.figures.n}
                  {s.figures.suspected > 0 && ` · ${signed(s.figures.leanWithoutSuspected)} without suspected votes`}
                </p>
              </>
            )}
            <div className="card">
              <Stats f={s.figures} hideLean />
            </div>
            <p className="muted">
              Showing the ledger as of seq {s.asOfSeq} · snapshot recorded at seq {s.eventSeq}, {fmt(s.at)} · algorithm {s.algorithm}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
