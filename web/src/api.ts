export type Role = 'participant' | 'moderator' | 'admin';

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
export const ROLE_IDS: readonly Role[] = ['participant', 'moderator', 'admin'];
/** Only a known role counts; anything else in storage falls back to participant. */
export const role = (): Role => {
  const r = read('role') as Role;
  return ROLE_IDS.includes(r) ? r : 'participant';
};

/** Dev role switcher: the role travels as a header. Not authentication; see DECISIONS.md. */
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-role': role() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export const fmt = (iso: string) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
