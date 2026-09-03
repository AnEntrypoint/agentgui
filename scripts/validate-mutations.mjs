// Live security validation of the confined file-mutation endpoints.
// Run with the server up: node scripts/validate-mutations.mjs
// Portable: ROOT defaults to this repo (an allowed root on both platforms);
// override with VALIDATE_ROOT. A PASSWORD-gated server is handled via the
// PASSWORD env var (Bearer), matching lib/http-handler.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const BASE = process.env.BASE || 'http://localhost:3000';
const ROOT = process.env.VALIDATE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEP = ROOT.includes('\\') ? '\\' : '/';
const WIN = SEP === '\\';
const AUTH = process.env.PASSWORD ? { Authorization: 'Bearer ' + process.env.PASSWORD } : {};
const J = { 'Content-Type': 'application/json', ...AUTH };
const results = [];
async function post(route, body, headers = J) {
  const r = await fetch(BASE + route, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.text() };
}
async function check(name, expected, actual) {
  const ok = actual.status === expected;
  results.push({ name, expected, got: actual.status, ok, body: actual.body.slice(0, 80) });
}
const join = (...parts) => parts.join(SEP);
const OUTSIDE = WIN ? 'C:\\Windows\\Temp\\x.txt' : '/etc/hostname';
const OUTSIDE_DIR = WIN ? 'C:\\Windows' : '/etc';
const TRAVERSAL = join(ROOT, '..', '..', ...(WIN ? ['Windows', 'win.ini'] : ['etc', 'passwd']));
// security cases
await check('rename-traversal', 403, await post('/api/rename', { path: TRAVERSAL, newName: 'x.txt' }));
await check('delete-out-of-roots', 403, await post('/api/delete', { path: OUTSIDE }));
await check('delete-root-refused', 403, await post('/api/delete', { path: ROOT }));
await check('rename-to-secret-403', 403, await post('/api/rename', { path: join(ROOT, 'package.json'), newName: '.env' }));
await check('upload-secret-403', 403, await fetch(BASE + '/api/upload-file?dir=' + encodeURIComponent(ROOT) + '&name=.env', { method: 'PUT', headers: AUTH, body: 'secret' }).then(async r => ({ status: r.status, body: await r.text() })));
await check('mkdir-secret-403', 403, await post('/api/mkdir', { dir: ROOT, name: '.env' }));
await check('mkdir-reserved-name', 400, await post('/api/mkdir', { dir: ROOT, name: 'CON' }));
await check('mkdir-name-with-separator', 400, await post('/api/mkdir', { dir: ROOT, name: 'a/b' }));
await check('mkdir-name-trailing-dot', 400, await post('/api/mkdir', { dir: ROOT, name: 'evil.' }));
await check('mkdir-ads-colon', 400, await post('/api/mkdir', { dir: ROOT, name: 'a:b' }));
// A real cross-site form carries no Authorization header (forms cannot set
// one). On a PASSWORD-gated server the auth wall rejects it first (401);
// open servers hit the CSRF guard (403). Either way the mutation is refused.
await check('csrf-cross-site-form', process.env.PASSWORD ? 401 : 403, await post('/api/delete', 'path=x', { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' }));
// The upload PUT is octet-stream, not a form-postable content-type, but the
// CSRF guard's stated reasoning (rides the same-origin SPA fetch) only holds
// if a cross-site PUT is actually rejected the same way POST/DELETE are.
// Deliberately omits AUTH here (unlike every other case in this file): the
// guard's `authed` bypass is legitimate for a Bearer token an attacker page
// cannot read, but including it here would test the wrong thing (a stolen-
// token scenario, not CSRF) - this asserts the cookie/no-credential path a
// real cross-site attacker is actually limited to.
await check('csrf-cross-site-upload', process.env.PASSWORD ? 401 : 403,
  await fetch(BASE + '/api/upload-file?dir=' + encodeURIComponent(ROOT) + '&name=csrf-probe.txt', {
    method: 'PUT', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: 'x',
  }).then(async r => ({ status: r.status, body: await r.text() })));
// round trip
await check('mkdir-ok', 200, await post('/api/mkdir', { dir: ROOT, name: '_wtest' }));
const up = await fetch(BASE + '/api/upload-file?dir=' + encodeURIComponent(join(ROOT, '_wtest')) + '&name=up.txt', { method: 'PUT', headers: AUTH, body: 'hello upload' });
results.push({ name: 'upload-ok', expected: 200, got: up.status, ok: up.status === 200 });
const up2 = await fetch(BASE + '/api/upload-file?dir=' + encodeURIComponent(join(ROOT, '_wtest')) + '&name=up.txt', { method: 'PUT', headers: AUTH, body: 'x' });
results.push({ name: 'upload-conflict-409', expected: 409, got: up2.status, ok: up2.status === 409 });
await check('rename-ok', 200, await post('/api/rename', { path: join(ROOT, '_wtest', 'up.txt'), newName: 'up2.txt' }));
await check('rename-conflict-409', 409, await post('/api/rename', { path: join(ROOT, '_wtest', 'up2.txt'), newName: 'up2.txt' }));
// move: security cases + round trip (subdir -> back), then self-nesting refusal
await check('move-traversal-src-403', 403, await post('/api/move', { path: TRAVERSAL, destDir: ROOT }));
await check('move-outside-dest-403', 403, await post('/api/move', { path: join(ROOT, '_wtest', 'up2.txt'), destDir: OUTSIDE_DIR }));
await check('move-root-refused-403', 403, await post('/api/move', { path: ROOT, destDir: join(ROOT, '_wtest') }));
await check('mkdir-move-sub-ok', 200, await post('/api/mkdir', { dir: join(ROOT, '_wtest'), name: 'sub' }));
await check('move-ok', 200, await post('/api/move', { path: join(ROOT, '_wtest', 'up2.txt'), destDir: join(ROOT, '_wtest', 'sub') }));
const up3 = await fetch(BASE + '/api/upload-file?dir=' + encodeURIComponent(join(ROOT, '_wtest')) + '&name=up2.txt', { method: 'PUT', headers: AUTH, body: 'collide' });
results.push({ name: 'upload-for-move-conflict', expected: 200, got: up3.status, ok: up3.status === 200 });
await check('move-conflict-409', 409, await post('/api/move', { path: join(ROOT, '_wtest', 'sub', 'up2.txt'), destDir: join(ROOT, '_wtest') }));
await check('move-overwrite-ok', 200, await post('/api/move', { path: join(ROOT, '_wtest', 'sub', 'up2.txt'), destDir: join(ROOT, '_wtest'), overwrite: true }));
await check('move-dir-into-itself-400', 400, await post('/api/move', { path: join(ROOT, '_wtest', 'sub'), destDir: join(ROOT, '_wtest', 'sub') }));
await check('delete-nonempty-no-recursive-409', 409, await post('/api/delete', { path: join(ROOT, '_wtest') }));
await check('delete-recursive-ok', 200, await post('/api/delete', { path: join(ROOT, '_wtest'), recursive: true }));
const st = await fetch(BASE + '/api/stat/' + encodeURIComponent(ROOT), { headers: AUTH });
results.push({ name: 'stat-ok', expected: 200, got: st.status, ok: st.status === 200 });
const st2 = await fetch(BASE + '/api/stat/' + encodeURIComponent(OUTSIDE_DIR), { headers: AUTH });
results.push({ name: 'stat-outside-403', expected: 403, got: st2.status, ok: st2.status === 403 });
let fail = 0;
for (const r of results) { if (!r.ok) fail++; console.log((r.ok ? 'PASS' : 'FAIL') + ' ' + r.name + ' expected=' + r.expected + ' got=' + r.got + (r.ok ? '' : ' body=' + (r.body || ''))); }
process.exit(fail ? 1 : 0);
