// End-to-end test: the installed Edge or Chrome, the real API, a real SQLite file, every role.
// Runs isolated from your data (own DB file, API on :3101, web on :5174). Run: npm run e2e
// Screenshots land in e2e/out/.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const OUT = fileURLToPath(new URL('./out/', import.meta.url));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.PULSE_DB = OUT + 'e2e.db';
process.env.PULSE_ANCHORS = OUT + 'anchors.log';
process.env.PORT = '3101';
process.env.PULSE_API = 'http://127.0.0.1:3101';
const WEB = 'http://localhost:5174';

await import('../seed');
await import('../server/src/index');
const { createServer } = await import('vite');
const vite = await createServer({ root: fileURLToPath(new URL('../web/', import.meta.url)), server: { port: 5174, strictPort: true }, logLevel: 'warn' });
await vite.listen();
// Warm up: make Vite compile the app before the first timed check.
await fetch(`${WEB}/src/main.tsx`).then((r) => r.text());

async function launch(): Promise<Browser> {
  for (const channel of [process.env.E2E_BROWSER, 'msedge', 'chrome'].filter(Boolean) as string[]) {
    try {
      return await chromium.launch({ channel });
    } catch {}
  }
  throw new Error('No browser found: install Edge or Chrome, or set E2E_BROWSER');
}
const browser = await launch();

// Every console error or uncaught exception fails the run, except HTTP errors a step deliberately provokes.
const errors: string[] = [];
let expectHttpError = false;
const pages: Record<string, Page> = {};

async function open(name: string, role?: 'participant' | 'moderator' | 'admin', viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  ctx.setDefaultTimeout(30_000);
  ctx.setDefaultNavigationTimeout(60_000); // Vite compiles on first request; slow machines need headroom
  if (role) await ctx.addInitScript((r) => localStorage.setItem('role', r), role);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !(expectHttpError && /status of 4\d\d/.test(m.text()))) errors.push(`${name}: ${m.text()}`);
  });
  pages[name] = page;
  return page;
}

const setRange = (page: Page, selector: string, value: number) =>
  page.$eval(
    selector,
    (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
const trajectory = (page: Page, label: string) =>
  page.locator('tr').filter({ has: page.locator('td:first-child b', { hasText: new RegExp(`^${label}$`) }) });
const evidenceRow = (page: Page, label: string) => page.locator('.row').filter({ has: page.locator('.chip', { hasText: new RegExp(`^${label}$`) }) });
const evidenceCard = (page: Page) => page.locator('.card').filter({ has: page.locator('h3', { hasText: /^Evidence$/ }) });
const roomSeq = async (room: Page) => Number((await room.locator('.room > p.muted').last().innerText()).match(/as of seq (\d+)/)![1]);
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
const openQuestion = async (page: Page, slug = 'mars-2040') => {
  await page.goto(`${WEB}/#/q/${slug}`);
  await page.reload(); // a same-URL hash goto does not refetch
  await page.getByText('Participant trajectories').waitFor();
};

let n = 0;
async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`${String(++n).padStart(2)}. ${name} ... `);
  await fn();
  console.log('ok');
}

try {
  const p1 = await open('participant-1', 'participant');
  const room = await open('room');

  await step('home lists the seeded question, marked as in the Room', async () => {
    await p1.goto(`${WEB}/#/`);
    const item = p1.locator('.qitem', { hasText: 'Will humans establish a permanent settlement on Mars before 2040?' });
    await item.waitFor();
    assert.match(await item.innerText(), /In the Room/);
  });

  await step('question page: figures, contiguous evidence labels, rejected content hidden from participants', async () => {
    await openQuestion(p1);
    await p1.getByText('n = 7').waitFor();
    const ev = await evidenceCard(p1).innerText();
    for (const l of ['E1', 'E2', 'E3', 'E4']) assert.ok(ev.includes(l), `missing ${l}`);
    assert.ok(ev.includes('Content hidden from participants'));
    assert.ok(!ev.includes('colony already exists'), 'rejected title leaked to a participant');
    // the brief's two named participants keep their letters
    assert.match(await trajectory(p1, 'A').innerText(), /No 80[\s\S]*Unsure 50[\s\S]*Yes 60/);
    assert.match(await trajectory(p1, 'B').innerText(), /^B\s+Yes 55/);
    await shot(p1, 'question-participant');
  });

  await step('time travel to seq 13 (Day 2, 16:30, the brief) shows A as No 80 -> Unsure 50 and locks voting', async () => {
    await setRange(p1, '.card input[type=range]:not(#conf)', 13);
    await p1.getByText('Showing the record as it stood at').waitFor();
    assert.match(await p1.locator('.past').innerText(), /seq 13/);
    const a = await trajectory(p1, 'A').innerText();
    assert.match(a, /No 80[\s\S]*Unsure 50/);
    assert.doesNotMatch(a, /Yes 60/);
    await trajectory(p1, 'A').getByRole('button', { name: /^A: Unsure 50/ }).click();
    const detail = await p1.locator('.step-detail').innerText();
    // brief: at Day 2 16:30 only the life-support study (E1) existed; the agency announcement (E2) came on Day 4
    assert.match(detail, /Evidence that existed: E1 \(Peer-reviewed study[^)]*\)/);
    assert.doesNotMatch(detail, /E2/);
    assert.match(detail, /Shown to A when voting: E1/);
    assert.ok(await p1.getByRole('button', { name: 'Vote', exact: true }).isDisabled());
    await shot(p1, 'question-time-travel');
    await p1.getByRole('button', { name: 'Live' }).click();
    await p1.getByText(/^Live:/).waitFor();
  });

  await step('Room shows the featured question live', async () => {
    await room.goto(`${WEB}/#/room`);
    await room.getByText('LIVE').waitFor();
    assert.match(await room.locator('h1').innerText(), /settlement on Mars/);
    assert.match(await room.locator('.big').innerText(), /^[+-]?\d/);
    assert.equal(await room.locator('.stat').count(), 3, 'lean must not be repeated as a tile under the big number');
    await shot(room, 'room-before-vote');
  });

  await step('participant votes; the Room updates within the throttle window', async () => {
    const before = await roomSeq(room);
    await p1.getByLabel('Yes', { exact: true }).check();
    await setRange(p1, '#conf', 70);
    await p1.getByRole('button', { name: 'Vote', exact: true }).click();
    await p1.getByText('Revise your vote').waitFor();
    await p1.getByText('n = 8').waitFor();
    await room.waitForFunction(
      (s) => Number([...document.querySelectorAll('.room > p.muted')].pop()?.textContent?.match(/as of seq (\d+)/)?.[1]) > s,
      before,
      { timeout: 5000 },
    );
    await room.getByText('n = 8').first().waitFor();
    await shot(room, 'room-after-vote');
  });

  const p2 = await open('participant-2', 'participant');
  await step('a second participant on the same IP and browser is counted but flagged suspected', async () => {
    await openQuestion(p2);
    await p2.getByLabel('No', { exact: true }).check();
    await setRange(p2, '#conf', 40);
    await p2.getByRole('button', { name: 'Vote', exact: true }).click();
    await p2.getByText('n = 9').waitFor();
    await p2.getByText('1 suspected').waitFor();
    assert.match(await trajectory(p2, 'J').innerText(), /suspected/);
  });

  await step('a revision supersedes: n unchanged, history kept', async () => {
    await p1.getByLabel('Unsure', { exact: true }).check();
    await setRange(p1, '#conf', 60);
    await p1.getByRole('button', { name: 'Revise', exact: true }).click();
    await trajectory(p1, 'I').getByText('Unsure 60').waitFor();
    assert.match(await trajectory(p1, 'I').innerText(), /Yes 70[\s\S]*Unsure 60/);
    await p1.getByText('n = 9').waitFor();
  });

  await step('participant submits evidence: the author sees it, others see a pending placeholder', async () => {
    await p2.getByText('Submit evidence for review').click();
    await p2.getByPlaceholder('Title').fill('ESA ExoMars drill plans');
    await p2.getByPlaceholder('https://…').fill('https://www.esa.int/Science_Exploration/Human_and_Robotic_Exploration/Exploration/ExoMars');
    await p2.getByPlaceholder('Summary').fill('Rosalind Franklin rover will drill 2 m below the surface.');
    await p2.getByRole('button', { name: 'Submit', exact: true }).click();
    await evidenceRow(p2, 'E5').getByText('ESA ExoMars drill plans').waitFor();
    await openQuestion(p1);
    await evidenceRow(p1, 'E5').getByText('Awaiting moderation').waitFor();
  });

  const mod = await open('moderator', 'moderator');
  const dialogs: string[] = [];
  mod.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.accept(d.type() === 'prompt' ? 'e2e: checked the source' : undefined);
  });

  await step('moderator sees all evidence, the review queue, no vote form; approves E5', async () => {
    await openQuestion(mod);
    assert.ok((await evidenceCard(mod).innerText()).includes('colony already exists'));
    await mod.getByText('1 awaiting review').waitFor();
    assert.equal(await mod.getByText('Your vote').count(), 0);
    await evidenceRow(mod, 'E5').getByRole('button', { name: 'approve' }).click();
    await evidenceRow(mod, 'E5').getByText('approved').waitFor();
    await openQuestion(p1);
    await evidenceRow(p1, 'E5').getByText('ESA ExoMars drill plans').waitFor();
  });

  await step("moderator cannot reverse the admin's decision on E4", async () => {
    expectHttpError = true;
    await evidenceRow(mod, 'E4').getByRole('button', { name: 'reject' }).click();
    await mod.waitForFunction(() => true); // let the alert fire
    await new Promise((r) => setTimeout(r, 500));
    expectHttpError = false;
    assert.ok(dialogs.some((m) => /only an administrator/.test(m)), `dialogs: ${dialogs.join(' | ')}`);
    assert.match(await evidenceRow(mod, 'E4').innerText(), /approved/);
  });

  const admin = await open('admin', 'admin');
  admin.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'e2e: same device as participant I' : undefined));

  await step('admin excludes the suspected participant: n drops, votes stay on record', async () => {
    await openQuestion(admin);
    await trajectory(admin, 'J').getByRole('button', { name: 'exclude' }).click();
    await trajectory(admin, 'J').getByText(/excluded:/).waitFor();
    await admin.getByText('n = 8').waitFor();
    assert.match(await trajectory(admin, 'J').innerText(), /No 40/);
  });

  await step('audit: chain verifies, every published snapshot recomputes', async () => {
    await admin.goto(`${WEB}/#/audit/mars-2040`);
    await admin.getByRole('button', { name: 'Verify hash chain' }).click();
    await admin.getByText(/^Intact:/).waitFor();
    const rows = admin.locator('.card', { hasText: 'Published results' }).locator('tbody tr');
    assert.ok((await rows.count()) >= 4, 'expected seeded plus live snapshots');
    for (const t of await rows.allInnerTexts()) assert.match(t, /matches/);
    await admin.getByText('The Room was showing').waitFor();
    assert.match(await admin.locator('.displayed').innerText(), /recomputes from the ledger/);
    // as of Day 3 08:00 the Room was showing the Day 2 18:00 snapshot
    await admin.getByPlaceholder(/seq \(42\)/).fill('2026-03-03T08:00:00Z');
    await admin.getByRole('button', { name: 'Show' }).click();
    await admin.getByText(/The Room was showing: lean \+25\.6, n = 8/).waitFor();
    await shot(admin, 'audit');
  });

  let e2eSlug = '';
  await step('a participant creates a question and lands on its unique share link', async () => {
    await p1.goto(`${WEB}/#/`);
    await p1.getByPlaceholder('Question').fill('Is the end-to-end test passing?');
    await p1.getByRole('button', { name: 'Create and get link' }).click();
    await p1.waitForFunction(() => location.hash.startsWith('#/q/is-the-end-to-end-test-passing-'));
    e2eSlug = new URL(p1.url()).hash.slice('#/q/'.length);
    assert.match(e2eSlug, /^is-the-end-to-end-test-passing-[0-9a-f]{6}$/);
    await p1.getByText('Participant trajectories').waitFor();
    assert.equal(await p1.getByRole('button', { name: /copy share link/ }).getAttribute('title'), `${WEB}/#/q/${e2eSlug}`);
  });

  await step('admin features it, the Room switches; closing shows on the Room', async () => {
    await admin.goto(`${WEB}/#/admin`);
    await admin.reload(); // a hash-only goto does not refetch the list
    const row = admin.locator('tr', { hasText: 'Is the end-to-end test passing?' });
    await row.getByRole('button', { name: 'Feature in Room' }).click();
    await room.getByRole('heading', { name: 'Is the end-to-end test passing?' }).waitFor({ timeout: 5000 });
    assert.equal(await room.locator('.big').innerText(), 'No votes yet', 'an empty question must not show a lean of 0');
    await row.getByRole('button', { name: 'Close' }).click();
    await room.getByText('FINAL RESULT · VOTING CLOSED').waitFor({ timeout: 5000 });
    assert.equal(await room.getByText('LIVE', { exact: true }).count(), 0);
    await shot(room, 'room-new-question-closed');
    await admin.goto(`${WEB}/#/admin`);
    await admin.reload(); // a hash-only goto does not refetch the list
    await admin.locator('tr', { hasText: 'settlement on Mars' }).getByRole('button', { name: 'Feature in Room' }).click();
    await room.getByRole('heading', { name: /settlement on Mars/ }).waitFor({ timeout: 5000 });
  });

  await step('a closed question refuses votes in the UI', async () => {
    await openQuestion(p1, e2eSlug);
    assert.ok(await p1.getByRole('button', { name: 'Vote', exact: true }).isDisabled());
  });

  await step('role switcher changes role, colour and controls', async () => {
    const fresh = await open('switcher');
    await openQuestion(fresh);
    assert.equal(await fresh.locator('header').getAttribute('data-role'), 'participant');
    await fresh.getByText('as this browser').waitFor();
    const widthAsParticipant = (await fresh.locator('.roles').boundingBox())!.width;
    await fresh.getByRole('radio', { name: 'Moderator' }).click();
    await fresh.waitForFunction(() => document.querySelector('header')?.getAttribute('data-role') === 'moderator');
    await fresh.getByText('Participant trajectories').waitFor();
    assert.equal(await fresh.getByText('Your vote').count(), 0);
    assert.equal((await fresh.locator('.roles').boundingBox())!.width, widthAsParticipant, 'switcher must not change size between roles');
    await fresh.getByText('as moderator-dev').waitFor();
    assert.equal(await fresh.locator('header input').count(), 0, 'nothing to type in the header');
    assert.equal(await fresh.locator('header .who').evaluate((e) => e.tagName), 'SPAN', 'identity is not editable');
    // an unknown role in storage falls back to participant instead of breaking every request
    await fresh.evaluate(() => localStorage.setItem('role', 'superuser'));
    await fresh.reload();
    await fresh.getByText('as this browser').waitFor();
    assert.equal(await fresh.locator('header').getAttribute('data-role'), 'participant');
    // the API only knows three roles, and ignores any staff name it is sent
    const bad = await fresh.request.get(`${WEB}/api/questions/mars-2040`, { headers: { 'x-role': 'superuser' } });
    assert.equal(bad.status(), 400);
    const ev = (await (await fresh.request.get(`${WEB}/api/questions/mars-2040`, { headers: { 'x-role': 'moderator' } })).json()).evidence[0].id;
    const r = await fresh.request.post(`${WEB}/api/evidence/${ev}/review`, {
      headers: { 'x-role': 'moderator', 'x-actor': 'someone-else' },
      data: { decision: 'annotate', reason: 'e2e: identity check' },
    });
    assert.equal((await r.json()).actor_id, 'moderator-dev');
    await fresh.evaluate(() => localStorage.setItem('role', 'participant'));
    await fresh.reload();
    await fresh.getByText('Participant trajectories').waitFor();
    await fresh.getByRole('radio', { name: 'Admin' }).click();
    await fresh.waitForFunction(() => document.querySelector('header')?.getAttribute('data-role') === 'admin');
    await shot(fresh, 'role-admin');
  });

  await step('dark theme toggles, persists across reload, redraws the chart', async () => {
    await openQuestion(p1);
    await p1.getByRole('button', { name: 'Switch to dark theme' }).click();
    assert.equal(await p1.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await p1.reload();
    await p1.getByText('Participant trajectories').waitFor();
    assert.equal(await p1.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await p1.locator('.recharts-line-curve').first().getAttribute('stroke'), '#818cf8');
    // bursty history (March seed + live votes today) defaults the axis to event order, and the toggle shows it
    assert.equal(await p1.getByRole('button', { name: 'event order' }).getAttribute('aria-pressed'), 'true');
    await shot(p1, 'question-dark');
    await p1.goto(`${WEB}/#/room`);
    await p1.getByText('LIVE').waitFor();
    await shot(p1, 'room-dark-theme');
  });

  await step('Room back link returns to the app', async () => {
    await room.getByRole('link', { name: '← Back' }).click();
    await room.locator('header').waitFor();
    assert.equal(new URL(room.url()).hash, '#/');
  });

  await step('phone width (390px): no sideways scroll on question, Room, admin and audit', async () => {
    const phone = await open('phone', 'admin', { width: 390, height: 844 });
    await openQuestion(phone);
    assert.ok(await noSideScroll(phone), 'question page scrolls sideways');
    await shot(phone, 'phone-question');
    for (const path of ['/#/room', '/#/admin', '/#/audit/mars-2040']) {
      await phone.goto(WEB + path);
      await phone.waitForLoadState('networkidle').catch(() => {}); // the Room's stream never goes idle
      await new Promise((r) => setTimeout(r, 800));
      assert.ok(await noSideScroll(phone), `${path} scrolls sideways`);
      await shot(phone, `phone-${path.split('/')[2]}`);
    }
  });

  await step('raw database edit is caught by Verify, at the edited seq', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(process.env.PULSE_DB!);
    db.exec('DROP TRIGGER events_no_update');
    db.prepare("UPDATE events SET payload = replace(payload, '\"No\"', '\"Yes\"') WHERE seq = 3").run();
    db.close();
    await admin.goto(`${WEB}/#/audit/mars-2040`);
    await admin.getByRole('button', { name: 'Verify hash chain' }).click();
    await admin.getByText(/BROKEN at seq 3/).waitFor();
  });

  await step('no console errors or uncaught exceptions on any page', async () => {
    assert.deepEqual(errors, []);
  });

  console.log(`\nAll ${n} end-to-end checks passed. Screenshots: ${OUT}`);
  await browser.close();
  await vite.close();
  process.exit(0);
} catch (err) {
  console.log('FAILED');
  console.error(err);
  if (errors.length) console.error('console errors:', errors);
  for (const [name, page] of Object.entries(pages)) await page.screenshot({ path: `${OUT}failure-${name}.png`, fullPage: true }).catch(() => {});
  await browser.close();
  process.exit(1);
}
