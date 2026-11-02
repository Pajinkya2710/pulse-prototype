import { useEffect, useState } from 'react';
import { api, fmt, signed } from '../api';

export function AuditPage({ slug }: { slug: string }) {
  const [audit, setAudit] = useState<any>(null);
  const [verify, setVerify] = useState<any>(null);
  const [asOf, setAsOf] = useState('');
  const [error, setError] = useState('');

  const load = () =>
    api(`/api/questions/${slug}/audit${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`).then(
      (a) => (setAudit(a), setError('')),
      (e) => setError(e.message),
    );
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="card">
        <h3>Chain integrity</h3>
        <button className="primary" onClick={() => api('/api/verify').then(setVerify)}>
          Verify hash chain
        </button>
        {verify && (
          <p className={verify.ok && !verify.anchors.mismatches.length ? 'ok' : 'warn'}>
            {verify.ok ? `Intact: ${verify.checked} events, head ${verify.head.slice(0, 16)}…` : `BROKEN at seq ${verify.brokenAt}: ${verify.reason} (${verify.checked - 1} events before it verify)`}
            <br />
            Anchors checked: {verify.anchors.checked}
            {verify.anchors.mismatches.length > 0 && `, mismatched at seq ${verify.anchors.mismatches.join(', ')}`}
          </p>
        )}
      </div>

      <div className="card">
        <div className="row">
          <strong>Audit as of</strong>
          <input type="text" style={{ width: 260 }} placeholder="seq (42) or ISO time, blank = now" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <button onClick={load}>Show</button>
          <a href={`#/q/${slug}`}>back to question</a>
        </div>
        {error && <p className="warn">{error}</p>}
        {audit && (
          <p className="muted">
            {audit.question.title} · seq {audit.asOfSeq} · {fmt(audit.asOfTime)} · lean {signed(audit.result.figures.lean)}, n = {audit.result.figures.n} · input hash{' '}
            {audit.result.inputHash.slice(0, 12)}…
          </p>
        )}
        {audit &&
          (audit.displayed ? (
            <p className="displayed">
              The Room was showing: lean <b>{signed(audit.displayed.figures.lean)}</b>, n = {audit.displayed.figures.n} (snapshot recorded at seq {audit.displayed.eventSeq},
              as of seq {audit.displayed.asOfSeq}, {fmt(audit.displayed.at)}){' '}
              <span className={audit.displayed.matches ? 'ok' : 'warn'}>{audit.displayed.matches ? '✓ recomputes from the ledger' : '✗ does not recompute'}</span>
            </p>
          ) : (
            <p className="muted">Nothing had been shown in the Room for this question by then.</p>
          ))}
      </div>

      {audit && (
        <>
          <div className="card">
            <h3>Published results</h3>
            <p className="muted">Every result shown in the Room, recomputed from the ledger with the algorithm version it was published with.</p>
            <div className="scroll-x"><table>
              <thead>
                <tr>
                  <th>recorded</th>
                  <th>as of seq</th>
                  <th>algorithm</th>
                  <th>lean / n</th>
                  <th>recomputes?</th>
                </tr>
              </thead>
              <tbody>
                {audit.snapshots.map((s: any) => (
                  <tr key={s.eventSeq}>
                    <td>
                      {fmt(s.at)} <span className="muted">seq {s.eventSeq}</span>
                    </td>
                    <td>{s.asOfSeq}</td>
                    <td>{s.algorithm}</td>
                    <td>
                      {signed(s.figures.lean)} / {s.figures.n}
                    </td>
                    <td className={s.matches ? 'ok' : 'warn'}>{s.matches ? '✓ matches' : `✗ ${s.note ?? `recomputed lean ${s.recomputed?.lean}`}`}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>

          <div className="card">
            <h3>Moderation record</h3>
            {audit.evidence.map((e: any) => (
              <div key={e.id} style={{ marginBottom: 8 }}>
                <b>{e.hidden ? <i className="muted">Content hidden from participants</i> : e.title}</b> <span className="muted">submitted by {e.submittedBy}, {fmt(e.at)} · now {e.status}</span>
                {e.reviews.map((r: any) => (
                  <div key={r.seq} className="muted">
                    ↳ seq {r.seq}: {r.decision} by {r.actorRole} {r.actorId}: “{r.reason}”
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="card">
            <h3>Exclusions</h3>
            {audit.participants.filter((p: any) => p.excluded).length === 0 && <p className="muted">None.</p>}
            {audit.participants
              .filter((p: any) => p.excluded)
              .map((p: any) => (
                <p key={p.label}>
                  Participant {p.label}: excluded at seq {p.excluded.seq} by {p.excluded.by}: “{p.excluded.reason}”. Their votes remain in the ledger.
                </p>
              ))}
          </div>
        </>
      )}
    </>
  );
}
