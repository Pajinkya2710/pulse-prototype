import { useEffect, useState } from 'react';
import { api, role } from '../api';

export function AdminPage() {
  const [qs, setQs] = useState<any[]>([]);
  const load = () => api('/api/questions').then(setQs);
  useEffect(() => {
    load();
  }, []);
  const act = (fn: () => Promise<unknown>) => fn().then(load, (e) => alert(e.message));

  if (role() !== 'admin') return <p className="card">Switch the dev role to admin (top right) to use this page.</p>;
  return (
    <>
      <div className="card">
        <h3>Manage questions</h3>
        <p className="muted">Anyone can create a question from the Questions page. Featuring and closing are admin actions.</p>
        <table>
          <tbody>
            {qs.map((q) => (
              <tr key={q.question_id}>
                <td>
                  <a href={`#/q/${q.slug}`}>{q.title}</a>
                  <div className="muted">
                    {q.votes_counted} counted · {q.closed ? 'closed' : 'open'}
                  </div>
                </td>
                <td>
                  <button disabled={!!q.featured} onClick={() => act(() => api('/api/room/feature', { questionId: q.question_id }))}>
                    {q.featured ? 'in the Room' : 'Feature in Room'}
                  </button>{' '}
                  <button disabled={!!q.closed} onClick={() => confirm('Close voting? This is permanent.') && act(() => api(`/api/questions/${q.question_id}/close`, {}))}>
                    Close
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Moderation and duplicate exclusion are on each question page when your role is moderator or admin.</p>
      </div>
    </>
  );
}
