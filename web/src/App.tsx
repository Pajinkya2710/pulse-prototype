import { useEffect, useState } from 'react';
import { api, role, type Role } from './api';
import { QuestionPage } from './pages/Question';
import { RoomPage } from './pages/Room';
import { AdminPage } from './pages/Admin';
import { AuditPage } from './pages/Audit';

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: 'participant', label: 'Participant', hint: 'Vote, revise, submit evidence' },
  { id: 'moderator', label: 'Moderator', hint: 'Approve, reject or annotate evidence' },
  { id: 'admin', label: 'Admin', hint: 'Create, close and feature questions; exclude duplicates; override moderation' },
];

const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
  location.reload();
};

function RoleSwitcher() {
  const current = role();
  return (
    <div className="roles" role="radiogroup" aria-label="Dev role">
      <span className="dev-badge" title="Prototype only: the role is sent as a request header. This is not authentication.">
        DEV
      </span>
      {ROLES.map((r) => (
        <button
          key={r.id}
          role="radio"
          aria-checked={current === r.id}
          data-role={r.id}
          className={`role-btn ${current === r.id ? 'on' : ''}`}
          title={r.hint}
          onClick={() => current !== r.id && save('role', r.id)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** Who your actions are recorded as. Same slot for every role, so the header does not jump when you switch. */
function Identity() {
  const current = role();
  if (current === 'participant') {
    return (
      <span className="who" title="Participants are identified by a signed cookie in this browser. Use another browser or a private window to be a second participant.">
        as this browser
      </span>
    );
  }
  return (
    <span className="who" title="Recorded on every moderation or admin action. Fixed per role in this prototype.">
      as <b>{current}-dev</b>
    </span>
  );
}

function Home() {
  const [qs, setQs] = useState<any[] | null>(null);
  useEffect(() => {
    api('/api/questions').then(setQs);
  }, []);
  return (
    <>
    <NewQuestion />
    <div className="card">
      <h2>Questions</h2>
      {qs?.length === 0 && <p className="muted">None yet. Run npm run seed, or ask one above.</p>}
      {qs?.map((q) => (
        <a key={q.question_id} className="qitem" href={`#/q/${q.slug}`}>
          <div>
            <b>{q.title}</b>
            <div className="muted">{q.votes_counted} counted votes</div>
          </div>
          <div className="row">
            {!!q.featured && <span className="chip live">● In the Room</span>}
            <span className="chip">{q.closed ? 'Closed' : 'Open'}</span>
          </div>
        </a>
      ))}
    </div>
    </>
  );
}

/** Any user can ask a question (brief, scope 01). The server returns a unique link and we go straight to it. */
function NewQuestion() {
  const [f, setF] = useState({ title: '', description: '' });
  const [error, setError] = useState('');
  const create = async () => {
    try {
      const e = await api('/api/questions', f);
      location.hash = `#/q/${e.payload.slug}`;
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <div className="card">
      <h2>Ask a question</h2>
      <p className="muted">You get a unique link to share. The wording cannot be edited afterwards, because earlier voters answered the original.</p>
      <p>
        <input type="text" placeholder="Question" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </p>
      <p>
        <textarea placeholder="Description (optional)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </p>
      <div className="row">
        <button className="primary" onClick={create} disabled={f.title.trim().length < 5}>
          Create and get link
        </button>
        {error && <span className="warn">{error}</span>}
      </div>
    </div>
  );
}

function useTheme() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light');
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    setTheme(next);
  };
  return [theme, toggle] as const;
}

export function App() {
  const path = useHash();
  const [theme, toggleTheme] = useTheme();
  const [, page, arg] = path.split('/');
  if (page === 'room') return <RoomPage />; // full-screen display with its own back link
  const active = (p: string) => (p === 'questions' ? page !== 'admin' : page === p) ? 'active' : '';
  return (
    <>
      <header data-role={role()}>
        <a className="brand" href="#/">
          <span className="brand-dot" />
          PULSE
        </a>
        <nav>
          <a href="#/" className={active('questions')}>
            Questions
          </a>
          <a href="#/room">Room</a>
          <a href="#/admin" className={active('admin')}>
            Admin
          </a>
        </nav>
        <RoleSwitcher />
        <Identity />
        <button onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>
      {/* keyed on theme so the chart re-renders with the new palette */}
      <main key={theme}>
        {page === 'q' && arg ? <QuestionPage slug={arg} key={arg} /> : page === 'admin' ? <AdminPage /> : page === 'audit' && arg ? <AuditPage slug={arg} key={arg} /> : <Home />}
      </main>
    </>
  );
}
