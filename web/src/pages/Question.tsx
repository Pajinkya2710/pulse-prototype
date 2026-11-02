import { useEffect, useRef, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, fmt, role, signed } from '../api';

/** With no votes, a lean of 0 would read as "perfectly neutral", so show a dash instead. */
export const leanText = (f: any) => (f.n ? signed(f.lean) : '–');

export function Stats({ f, hideLean = false }: { f: any; hideLean?: boolean }) {
  return (
    <div className="grid">
      {!hideLean && (
        <div className="stat">
          <span className="muted">Lean (−100 No … +100 Yes)</span>
          <b>{leanText(f)}</b>
          {f.suspected > 0 && <span className="muted">{signed(f.leanWithoutSuspected)} without suspected</span>}
        </div>
      )}
      <div className="stat">
        <span className="muted">Agreement (0–1)</span>
        <b>{f.agreement ?? '–'}</b>
        {f.agreement !== null && <span className="muted">low + neutral lean = polarised</span>}
      </div>
      <div className="stat">
        <span className="muted">Participants counted</span>
        <b>n = {f.n}</b>
        <span className="muted">
          Yes {f.counts.Yes} · No {f.counts.No} · Unsure {f.counts.Unsure}
          {f.suspected > 0 && <span className="warn"> · {f.suspected} suspected</span>}
          {f.excluded > 0 && <> · {f.excluded} excluded</>}
        </span>
      </div>
      <div className="stat">
        <span className="muted">Movement, last {f.movement.windowHours}h</span>
        <b>{f.movement.revisions}</b>
        <span className="muted">
          {f.movement.towardYes} toward Yes · {f.movement.towardNo} toward No · {f.movement.changedChoice} changed answer
        </span>
      </div>
    </div>
  );
}

const reason = (what: string) => prompt(`Reason to ${what} (recorded permanently):`)?.trim();

export function QuestionPage({ slug }: { slug: string }) {
  const [asOf, setAsOf] = useState<number | null>(null);
  const [view, setView] = useState<any>(null);
  const [tl, setTl] = useState<any>(null);
  const [audit, setAudit] = useState<any>(null);
  const [xChoice, setXMode] = useState<'time' | 'seq' | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = async (at = asOf) => {
    const req = ++latest.current;
    const qs = at === null ? '' : `?asOf=${at}`;
    try {
      const [v, t, a] = await Promise.all([api(`/api/questions/${slug}${qs}`), api(`/api/questions/${slug}/timeline${qs}`), api(`/api/questions/${slug}/audit${qs}`)]);
      if (req !== latest.current) return; // a newer slider position won
      setView(v);
      setTl(t);
      setAudit(a);
      setError('');
    } catch (e: any) {
      if (req === latest.current) setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, [asOf]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (!view) return <p className="muted">{error || 'Loading…'}</p>;
  const q = view.question;
  const past = asOf !== null;
  const staff = role() !== 'participant';
  const labels = new Map<string, string>(audit.evidence.map((e: any, i: number) => [e.id, `E${i + 1}`]));
  // Bursty history (one gap longer than everything else combined) squashes a time axis, so default to event order.
  const times = tl.points.map((p: any) => Date.parse(p.at));
  const maxGap = Math.max(0, ...times.slice(1).map((t: number, i: number) => t - times[i]));
  const xMode = xChoice ?? (maxGap > (times.at(-1) - times[0]) / 2 ? 'seq' : 'time');
  const x = (p: { at: string; seq: number }) => (xMode === 'time' ? Date.parse(p.at) : p.seq);
  const asOfX = xMode === 'time' ? Date.parse(view.asOfTime) : view.asOfSeq;
  const pending = view.evidence.filter((e: any) => e.status === 'pending').length;
  const C =
    document.documentElement.dataset.theme === 'dark'
      ? { lean: '#818cf8', yes: '#4ade80', marker: '#fb923c', grid: '#2a3140', zero: '#3b4456', tick: '#9ca3af' }
      : { lean: '#4f46e5', yes: '#15803d', marker: '#c2410c', grid: '#eeeeee', zero: '#cccccc', tick: '#6b7280' };

  return (
    <>
      <div className={`card ${past ? 'past' : ''}`}>
        <h2 style={{ margin: 0 }}>{q.title}</h2>
        <p className="muted">
          {q.description} {q.closedSeq && <b>Closed.</b>} {view.featured && <span className="chip live">● in the Room</span>}{' '}
          {staff && pending > 0 && <span className="chip warn">{pending} awaiting review</span>} <ShareLink slug={q.slug} /> <a href={`#/audit/${q.slug}`}>audit</a>
        </p>
        <div className="row">
          <strong>Time travel</strong>
          <input
            type="range"
            style={{ flex: 1 }}
            min={q.createdSeq}
            max={view.headSeq}
            value={asOf ?? view.headSeq}
            onChange={(e) => {
              const v = Number(e.target.value);
              setAsOf(v >= view.headSeq ? null : v);
            }}
          />
          <button onClick={() => setAsOf(null)} disabled={!past}>
            Live
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {past ? 'Showing the record as it stood at ' : 'Live: '} seq {view.asOfSeq} · {fmt(view.asOfTime)} · algorithm {view.result.algorithm}
        </p>
      </div>

      <div className="card">
        <Stats f={view.result.figures} />
        {view.result.figures.afterEvidence.length > 0 && (
          <p className="muted">
            After evidence (24h after each item became visible; correlation, not cause):{' '}
            {view.result.figures.afterEvidence.map((a: any) => (
              <span key={a.evidenceId} className="chip" title={a.title}>
                {labels.get(a.evidenceId)}: {a.revisions} revised · {a.towardYes} toward Yes · {a.towardNo} toward No
              </span>
            ))}
          </p>
        )}
      </div>

      <div className="card">
        <div className="row">
          <strong>Timeline</strong>
          <span className="muted">x-axis:</span>
          {(['time', 'seq'] as const).map((m) => (
            <button key={m} className={xMode === m ? 'primary' : ''} aria-pressed={xMode === m} onClick={() => setXMode(m)}>
              {m === 'time' ? 'time' : 'event order'}
            </button>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={tl.points.map((p: any) => ({ ...p, x: x(p) }))} margin={{ top: 16, right: 16, bottom: 0, left: -10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v) => (xMode === 'time' ? fmt(new Date(v).toISOString()) : `#${v}`)} fontSize={12} tick={{ fill: C.tick }} />
            <YAxis domain={[-100, 100]} fontSize={12} tick={{ fill: C.tick }} />
            <Tooltip
              contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8 }}
              labelFormatter={(v) => (xMode === 'time' ? fmt(new Date(v as number).toISOString()) : `seq ${v}`)}
            />
            <Legend />
            <ReferenceLine y={0} stroke={C.zero} />
            {tl.markers.map((m: any) => (
              <ReferenceLine key={m.id} x={x(m)} stroke={C.marker} strokeDasharray="4 3" label={{ value: labels.get(m.id), position: 'top', fontSize: 12, fill: C.marker }} />
            ))}
            {past && <ReferenceLine x={asOfX} stroke={C.lean} label={{ value: 'as of', position: 'insideTopRight', fontSize: 12, fill: C.lean }} />}
            <Line type="stepAfter" dataKey="lean" name="Lean" stroke={C.lean} dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="yesShare" name="Yes share %" stroke={C.yes} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {!staff && <VoteForm view={view} disabled={past || !!q.closedSeq} onDone={load} />}

      <div className="card">
        <h3>Evidence</h3>
        {view.evidence.length === 0 && <p className="muted">None at this point.</p>}
        {view.evidence.map((e: any) => (
          <div key={e.id} style={{ marginBottom: 12 }}>
            <div className="row">
              <span className="chip">{labels.get(e.id)}</span>
              {e.hidden ? (
                <i className="muted">{e.status === 'pending' ? 'Awaiting moderation' : 'Content hidden from participants'}</i>
              ) : (
                <a href={e.url} target="_blank" rel="noreferrer noopener">
                  {e.title}
                </a>
              )}
              <span className={e.status === 'approved' ? 'ok' : e.status === 'rejected' ? 'warn' : 'muted'}>{e.status}</span>
              {staff && !past && (
                <>
                  {(['approve', 'reject', 'annotate'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => {
                        const r = reason(d);
                        if (r) act(() => api(`/api/evidence/${e.id}/review`, { decision: d, reason: r }));
                      }}
                    >
                      {d}
                    </button>
                  ))}
                </>
              )}
            </div>
            <div className="muted">
              {e.summary && `${e.summary} · `}submitted by {e.submittedBy}, {fmt(e.at)}
            </div>
            {e.reviews.map((r: any) => (
              <div key={r.seq} className="muted">
                ↳ {r.decision} by {r.actorRole} {r.actorId}
                {r.overrides ? ` (overrides seq ${r.overrides})` : ''}: “{r.reason}” · {fmt(r.at)}
              </div>
            ))}
          </div>
        ))}
        {!past && !q.closedSeq && role() !== 'moderator' && <EvidenceForm slug={slug} onDone={load} />}
      </div>

      <div className="card">
        <h3>Participant trajectories</h3>
        <p className="muted">Pseudonymised. Select a step to see the evidence that existed, was approved, and was shown to that participant when they voted.</p>
        <StepDetail audit={audit} voteId={step} labels={labels} />
        <div className="scroll-x"><table>
          <tbody>
            {audit.participants.map((p: any) => (
              <tr key={p.label}>
                <td>
                  <b>{p.label}</b>
                </td>
                <td style={{ textDecoration: p.excluded ? 'line-through' : undefined }}>
                  {p.steps.map((s: any, i: number) => (
                    <span key={s.voteId}>
                      {i > 0 && ' → '}
                      <button
                        className={`chip step ${step === s.voteId ? 'on' : ''}`}
                        aria-pressed={step === s.voteId}
                        aria-label={`${p.label}: ${s.choice} ${s.confidence} at seq ${s.seq}`}
                        onClick={() => setStep(step === s.voteId ? null : s.voteId)}
                      >
                        {s.choice} {s.confidence}
                      </button>
                    </span>
                  ))}
                </td>
                <td className="muted">
                  {p.excluded ? (
                    <>excluded: {p.excluded.reason}</>
                  ) : (
                    p.steps.at(-1).suspected && <span className="warn">suspected: {p.steps.at(-1).suspected}</span>
                  )}
                </td>
                <td>
                  {role() === 'admin' && !past && !p.excluded && (
                    <button
                      onClick={() => {
                        const r = reason('exclude this participant as a duplicate');
                        if (r) act(() => api(`/api/votes/${p.steps.at(-1).voteId}/exclude`, { reason: r }));
                      }}
                    >
                      exclude
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

function ShareLink({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}${location.pathname}#/q/${slug}`;
  return (
    <button
      className="chip"
      title={url}
      onClick={() =>
        navigator.clipboard.writeText(url).then(
          () => setCopied(true),
          () => prompt('Copy this link:', url),
        )
      }
    >
      {copied ? '✓ link copied' : '🔗 copy share link'}
    </button>
  );
}

/** The selected trajectory step: what existed, what was approved, and what this participant was shown. */
function StepDetail({ audit, voteId, labels }: { audit: any; voteId: string | null; labels: Map<string, string> }) {
  const p = audit.participants.find((x: any) => x.steps.some((s: any) => s.voteId === voteId));
  if (!p) return null; // nothing selected, or the step is not in this point in time
  const s = p.steps.find((x: any) => x.voteId === voteId);
  const title = new Map<string, string | null>(audit.evidence.map((e: any) => [e.id, e.title]));
  const list = (ids: string[]) => (ids.length ? ids.map((id) => `${labels.get(id)}${title.get(id) ? ` (${title.get(id)})` : ''}`).join(', ') : 'none');
  return (
    <div className="step-detail" role="status">
      <b>
        {p.label}: {s.choice} {s.confidence}
      </b>{' '}
      <span className="muted">
        seq {s.seq} · {fmt(s.at)}
      </span>
      <div>Evidence that existed: {list(s.evidenceExisted)}</div>
      <div>Approved by then: {list(s.evidenceApproved)}</div>
      <div>Shown to {p.label} when voting: {list(s.evidenceVisible)}</div>
    </div>
  );
}

function VoteForm({ view, disabled, onDone }: { view: any; disabled: boolean; onDone: () => void }) {
  const mine = view.myVote;
  const [choice, setChoice] = useState<string>(mine?.choice ?? 'Unsure');
  const [confidence, setConfidence] = useState<number>(mine?.confidence ?? 50);
  const [busy, setBusy] = useState(false);
  const pendingId = useRef<string | null>(null); // kept across retries so a resent vote is recorded once

  const submit = async () => {
    pendingId.current ??= crypto.randomUUID();
    setBusy(true);
    try {
      const evidenceVisible = view.evidence.filter((e: any) => e.status === 'approved').map((e: any) => e.id);
      await api(`/api/questions/${view.question.id}/votes`, { id: pendingId.current, choice, confidence, evidenceVisible });
      pendingId.current = null;
      onDone();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>{mine ? 'Revise your vote' : 'Your vote'}</h3>
      {mine && (
        <p className="muted">
          Current: {mine.choice} {mine.confidence} ({fmt(mine.at)}). A revision is added; your earlier votes stay on record.
        </p>
      )}
      <div className="row">
        {['Yes', 'No', 'Unsure'].map((c) => (
          <label key={c}>
            <input type="radio" name="choice" checked={choice === c} onChange={() => setChoice(c)} disabled={disabled} /> {c}
          </label>
        ))}
      </div>
      <div className="row">
        <label htmlFor="conf">{choice === 'Unsure' ? 'How sure that it is genuinely open' : 'Confidence'}</label>
        <input id="conf" type="range" min={0} max={100} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} disabled={disabled} />
        <b>{confidence}</b>
        <button className="primary" onClick={submit} disabled={disabled || busy}>
          {mine ? 'Revise' : 'Vote'}
        </button>
      </div>
    </div>
  );
}

function EvidenceForm({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [f, setF] = useState({ title: '', url: '', summary: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <details>
      <summary>Submit evidence for review</summary>
      <p>
        <input type="text" placeholder="Title" value={f.title} onChange={set('title')} />
      </p>
      <p>
        <input type="url" placeholder="https://…" value={f.url} onChange={set('url')} />
      </p>
      <p>
        <textarea placeholder="Summary" value={f.summary} onChange={set('summary')} />
      </p>
      <button
        onClick={async () => {
          try {
            await api(`/api/questions/${slug}/evidence`, f);
            setF({ title: '', url: '', summary: '' });
            onDone();
          } catch (e: any) {
            alert(e.message);
          }
        }}
      >
        Submit
      </button>
    </details>
  );
}
