/* ============================================================================
   EPROSTA — verification harness for job document files
   ----------------------------------------------------------------------------
   Proves what `src/lib/jobfiles.ts` and the WOF checklist now promise:
     1. A file is required, and junk (empty, too big, wrong type) is refused.
     2. The client can only send their own rows; EP needs wof.edit.
     3. Anything sent lands as Submitted, never Approved — new versions too.
     4. Approve and Send back are recorded on the exact version; a send-back
        needs a reason and puts the row back to owed.
     5. Versions are kept, never overwritten, and the job history names files.

   Run:  node job-files-tests.mjs
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const work = mkdtempSync(join(tmpdir(), 'eprosta-jobfiles-'));
const p = (rel) => join(ROOT, rel).replace(/\\/g, '/');
const entry = join(work, 'entry.ts');
const out = join(work, 'bundle.mjs');
writeFileSync(
  entry,
  `export * as JF from '${p('src/lib/jobfiles')}';\nexport * as W from '${p('src/lib/wof')}';\nexport * as R from '${p('src/lib/roles')}';\n`,
);
try {
  execFileSync(
    'npx',
    ['--yes', 'esbuild', entry, '--bundle', '--format=esm', `--outfile=${out}`,
      `--alias:@=${join(ROOT, 'src')}`, '--log-level=error'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
} catch {
  console.error('\nCould not bundle. esbuild is fetched via npx and needs network on first run.\n');
  process.exit(2);
}
const { JF, W, R } = await import(pathToFileURL(out).href);
W.load();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const group = (t) => console.log(`\n${t}`);

function actAs(roleId) {
  const boss = R.superAdmins()[0];
  R.setActing(boss.id);
  if (roleId === 'owner') return;
  const victim = R.members().find((m) => m.id !== boss.id && m.status === 'active');
  R.assignRole(victim.id, roleId);
  R.setActing(victim.id);
}
actAs('owner');

const w = W.all().find(
  (x) => (x.documents || []).some((d) => d.owner === 'Client' && d.status === 'required') &&
    (x.documents || []).some((d) => d.owner !== 'Client' && d.status === 'required'),
);
const clientRow = w.documents.find((d) => d.owner === 'Client' && d.status === 'required');
const epRow = w.documents.find((d) => d.owner !== 'Client' && d.status === 'required');
const client = { by: 'client', name: 'Dana Reilly (Festival Republic Ltd)' };
const pdf = (name = 'site-plan.pdf', body = 'plan') => new File([body], name, { type: 'application/pdf' });
const row = (id) => w.documents.find((d) => d.docId === id);

/* ------------------------------------------------------------------------ */
group('1. A real file, and only a sensible one');
ok('an empty file is refused', !!JF.uploadBlocker({ name: 'a.pdf', size: 0 }));
ok('over 25 MB is refused', !!JF.uploadBlocker({ name: 'a.pdf', size: 26 * 1024 * 1024 }));
ok('an executable is refused', !!JF.uploadBlocker({ name: 'plan.exe', size: 100 }));
ok('a PDF, a Word file, a drawing and a photo are fine', ['a.pdf', 'b.docx', 'c.dwg', 'd.JPG'].every((n) => !JF.uploadBlocker({ name: n, size: 100 })));
const bad = await JF.submit(w, clientRow.docId, new File([''], 'empty.pdf'), { actor: client, side: 'client' });
ok('submitting junk changes nothing', !bad.ok && row(clientRow.docId).status === 'required');

/* ------------------------------------------------------------------------ */
group('2. Who may send what');
const wrong = await JF.submit(w, epRow.docId, pdf('ra.pdf'), { actor: client, side: 'client' });
ok("the client cannot send EP's document", !wrong.ok && row(epRow.docId).status === 'required');
actAs('readonly');
const ro = await JF.submit(w, epRow.docId, pdf('ra.pdf'), { actor: R.actingActor(), side: 'ep' });
ok('a read-only member cannot attach on EP’s side', !ro.ok);
ok('…nor approve', !JF.review(w, epRow.docId, 'approved').ok);
actAs('owner');

/* ------------------------------------------------------------------------ */
group('3. Sent means Submitted');
const s1 = await JF.submit(w, clientRow.docId, pdf('site-plan.pdf'), { note: 'Draft for now', actor: client, side: 'client' });
ok('the client can send their own document', s1.ok);
ok('…it lands as Submitted, not Approved', row(clientRow.docId).status === 'submitted');
ok('…the version is recorded with who sent it', JF.latest(w.id, clientRow.docId)?.uploadedBy === client.name && JF.latest(w.id, clientRow.docId)?.side === 'client');
ok('…and the job history names the file', w.history.at(-1).note.includes('site-plan.pdf'));
ok('…signed by the client', w.history.at(-1).byName === client.name);

/* ------------------------------------------------------------------------ */
group('4. Approve and send back');
ok('a send-back needs a reason', !JF.review(w, clientRow.docId, 'returned', '  ').ok && row(clientRow.docId).status === 'submitted');
const back = JF.review(w, clientRow.docId, 'returned', 'It does not show the north car park.');
ok('sending back works with a reason', back.ok);
ok('…the row is owed again', row(clientRow.docId).status === 'required');
ok('…and the reason is on it for the client to read', row(clientRow.docId).note === 'Sent back: It does not show the north car park.');
ok('…and on the exact version it was about', JF.latest(w.id, clientRow.docId).review?.decision === 'returned');
ok('a required row cannot be approved or sent back', !JF.review(w, clientRow.docId, 'approved').ok);

const s2 = await JF.submit(w, clientRow.docId, pdf('site-plan-v2.pdf'), { actor: client, side: 'client' });
ok('a new version goes back to Submitted', s2.ok && row(clientRow.docId).status === 'submitted');
ok('both versions are kept, newest first', JF.versions(w.id, clientRow.docId).map((f) => f.name).join() === 'site-plan-v2.pdf,site-plan.pdf');
ok('the earlier one keeps its send-back', JF.versions(w.id, clientRow.docId)[1].review?.decision === 'returned');
ok('…and the note no longer says sent back', !row(clientRow.docId).note.startsWith('Sent back'));
ok('approving works', JF.review(w, clientRow.docId, 'approved').ok && row(clientRow.docId).status === 'approved');
ok('…recorded on the version, with who approved it', JF.latest(w.id, clientRow.docId).review?.decision === 'approved' && JF.latest(w.id, clientRow.docId).review?.by === R.acting().name);
ok('the roll-up counts it as approved', W.docState(w).docs.find((d) => d.docId === clientRow.docId).status === 'approved');

const s3 = await JF.submit(w, clientRow.docId, pdf('site-plan-v3.pdf'), { actor: client, side: 'client' });
ok('replacing an approved document needs checking again', s3.ok && row(clientRow.docId).status === 'submitted');

/* ------------------------------------------------------------------------ */
group('5. EP attaching');
const e1 = await JF.submit(w, epRow.docId, pdf('risk-assessment.pdf'), { actor: R.actingActor(), side: 'ep' });
ok('EP can attach its own document', e1.ok && row(epRow.docId).status === 'submitted');
const other = w.documents.find((d) => d.owner === 'Client' && d.status === 'required');
if (other) {
  const e2 = await JF.submit(w, other.docId, pdf('emailed.pdf'), { note: 'Came in by email', actor: R.actingActor(), side: 'ep' });
  ok('EP can attach a client document that arrived by email', e2.ok && JF.latest(w.id, other.docId).side === 'ep');
}
ok('files on other jobs are untouched', W.all().filter((x) => x.id !== w.id).every((x) => (x.documents || []).every((d) => JF.versions(x.id, d.docId).length === 0)));

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
