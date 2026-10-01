// Coach Studio access: the Wix badge AND the app's own allowlist. Owners come
// from ERICA_STUDIO_OWNERS; owners manage the rest on /admin/access; until the
// variable is set the Studio works as before but says so in red on every page.
// The audit names the person, not the shared 'admin' subject.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-access-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.AUDIT_DIR = path.join(tmp, 'audit');
process.env.SESSION_BOOKMARKS_FILE = path.join(tmp, 'bookmarks.json');
process.env.SESSION_SECRET = 'test-secret-for-studio-access';
delete process.env.ERICA_STUDIO_OWNERS;
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

const wixBadges = require('../lib/wixBadges');
wixBadges.holdsAdminBadge = async () => ({ ok: true, badges: ['Coach Studio Admin'] });
const access = require('../lib/studioAccess');
const admin = require('../lib/admin');
const auditLog = require('../lib/audit');
const root = path.join(__dirname, '..');

function cookieFor(email, m = 'mem-' + email) {
    const now = Math.floor(Date.now() / 1000);
    return 'admin_session=' + admin.signSession({ sub: 'admin', m, e: email, n: email, iat: now, exp: now + 3600 });
}

async function call(method, url, { email, body = '', json = false } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, { method, url, headers: { cookie: email ? cookieFor(email) : '', accept: json ? 'application/json' : 'text/html', 'content-type': 'application/x-www-form-urlencoded', host: 'localhost' } });
    let status = 0; let headers = {}; let out = '';
    const res = { writeHead(s, h) { status = s; headers = h || {}; }, setHeader(k, v) { headers[k] = v; }, end(b) { out += b || ''; } };
    await admin.handle(req, res);
    return { status, headers, body: out };
}
const auditTail = () => auditLog.list({ limit: 50 });

test('the list: owners from ERICA_STUDIO_OWNERS (trimmed, any case, bad entries dropped), roles and their scopes, changes audited with who made them', () => {
    process.env.ERICA_STUDIO_OWNERS = ' Willian@TT.com , not-an-email, eric@tt.com,willian@tt.com ';
    assert.deepEqual(access.envOwners(), ['willian@tt.com', 'eric@tt.com']);
    assert.equal(access.configured(), true);
    assert.equal(access.roleFor('ERIC@tt.com'), 'owner');
    assert.equal(access.roleFor('varsha@tt.com'), null);
    const a = { append: (e) => calls.push(e) }; const calls = [];
    assert.deepEqual(access.set('Varsha@TT.com', 'people', { actor: 'willian@tt.com', audit: a }), { changed: true, email: 'varsha@tt.com', role: 'people', from: null });
    assert.equal(access.roleFor('varsha@tt.com'), 'people');
    access.set('varsha@tt.com', 'admin', { actor: 'eric@tt.com', audit: a });
    assert.deepEqual(calls.map((c) => [c.actor, c.action, c.target, c.meta.role, c.meta.from]), [['willian@tt.com', 'access.add', 'varsha@tt.com', 'people', null], ['eric@tt.com', 'access.role', 'varsha@tt.com', 'admin', 'people']]);
    assert.throws(() => access.set('eric@tt.com', 'admin', { actor: 'willian@tt.com' }), /from ERICA_STUDIO_OWNERS; change it in Railway/);
    assert.throws(() => access.set('varsha@tt.com', 'owner', { actor: 'varsha@tt.com' }), /cannot change your own access/);
    assert.throws(() => access.set('x@tt.com', 'root', { actor: 'willian@tt.com' }), /Unknown role/);
    assert.deepEqual(access.list().rows.map((r) => [r.email, r.role, r.source]), [['willian@tt.com', 'owner', 'env'], ['eric@tt.com', 'owner', 'env'], ['varsha@tt.com', 'admin', 'studio']]);
    assert.deepEqual(access.scopesFor('admin'), ['read:ops', 'write:content']);
    assert.deepEqual(access.scopesFor('people'), ['read:ops', 'write:content', 'read:people', 'write:people']);
    assert.ok(access.scopesFor('owner').includes('manage:access'));
    assert.deepEqual(access.remove('varsha@tt.com', { actor: 'willian@tt.com', audit: a }), { changed: true, email: 'varsha@tt.com', from: 'admin' });
    assert.equal(calls.at(-1).action, 'access.remove');
    assert.equal(access.roleFor('varsha@tt.com'), null);
    // The file lives next to the sessions on the volume, not in the repo.
    assert.equal(access._internal.filePath(), path.join(tmp, 'studio-access.json'));
    // A corrupt file: only the env owners get in, and nothing overwrites it.
    fs.writeFileSync(access._internal.filePath(), '{nope');
    const e0 = console.error; console.error = () => {};
    assert.equal(access.roleFor('willian@tt.com'), 'owner');
    assert.equal(access.check('varsha@tt.com').ok, false);
    assert.throws(() => access.set('varsha@tt.com', 'admin', { actor: 'willian@tt.com' }), /could not be read; not overwriting/);
    assert.equal(access.list().unreadable, true);
    console.error = e0;
    fs.unlinkSync(access._internal.filePath());
});

test('not configured (no ERICA_STUDIO_OWNERS): the Studio works as before for badge holders, and every page says so in red', async () => {
    delete process.env.ERICA_STUDIO_OWNERS;
    const r = await call('GET', '/admin/audit', { email: 'someone@tt.com' });
    assert.equal(r.status, 200);
    assert.match(r.body, /data-studio-alert="allowlist">⚠️ Allowlist not configured: anyone holding the Wix “Coach Studio Admin” badge can use the Studio\. Set <code>ERICA_STUDIO_OWNERS<\/code> in Railway/);
    assert.match(r.body, /<a href="\/admin\/access" title="Coach Studio access">someone@tt\.com<\/a>/, 'the header names the person');
    const page = await call('GET', '/admin/access', { email: 'someone@tt.com' });
    assert.match(page.body, /Not enforced yet\./);
    assert.ok(!/action="\/admin\/access\/set"/.test(page.body), 'nobody can manage the list yet');
});

test('configured: the badge alone gets a 403 "not on the allowlist" (audited once per 10 min); listed people get in; only owners change the list; the audit names the person', async () => {
    process.env.ERICA_STUDIO_OWNERS = 'willian@tt.com';
    access._internal.resetDenials();
    const denied = await call('GET', '/admin/sessions', { email: 'wixdev@tt.com' });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /Not on the Coach Studio allowlist/);
    assert.match(denied.body, /a Coach Studio owner has to add this email on the Access page/);
    await call('GET', '/admin/', { email: 'wixdev@tt.com' });
    const deniedLines = auditTail().filter((e) => e.action === 'access.denied' && e.target === 'wixdev@tt.com');
    assert.equal(deniedLines.length, 1, 'audited once, not on every page load');
    assert.deepEqual(deniedLines[0].meta, { reason: 'not_allowlisted', via: 'studio' });
    const json = await call('GET', '/admin/ping', { email: 'wixdev@tt.com', json: true });
    assert.deepEqual([json.status, JSON.parse(json.body)], [403, { error: 'forbidden', reason: 'not_allowlisted' }]);
    // The owner gets in, with no red banner, and adds Varsha as an admin.
    const home = await call('GET', '/admin/audit', { email: 'Willian@TT.com' });
    assert.equal(home.status, 200);
    assert.ok(!/data-studio-alert/.test(home.body));
    assert.match(home.body, /willian@tt\.com<\/a> <span class="app-role">owner<\/span>/);
    const add = await call('POST', '/admin/access/set', { email: 'willian@tt.com', body: 'email=varsha%40tt.com&role=admin' });
    assert.equal(add.status, 303);
    assert.match(decodeURIComponent(add.headers.Location), /varsha@tt\.com: added as admin/);
    const added = auditTail().find((e) => e.action === 'access.add');
    assert.deepEqual([added.actor, added.target, added.meta.role], ['willian@tt.com', 'varsha@tt.com', 'admin']);
    // Varsha gets in; she cannot change the list.
    assert.equal((await call('GET', '/admin/sessions', { email: 'varsha@tt.com' })).status, 200);
    const tryAdd = await call('POST', '/admin/access/set', { email: 'varsha@tt.com', body: 'email=friend%40tt.com&role=owner' });
    assert.equal(tryAdd.status, 403);
    assert.equal(access.roleFor('friend@tt.com'), null);
    const ping = JSON.parse((await call('GET', '/admin/ping', { email: 'varsha@tt.com', json: true })).body);
    assert.deepEqual([ping.actor, ping.role], ['varsha@tt.com', 'admin']);
    // A Studio write is audited as the person, not 'admin'.
    const bm = await call('POST', '/admin/sessions/s-vX1/bookmark', { email: 'varsha@tt.com', body: 'kind=problem&note=check&return=%2Fadmin%2Fsessions' });
    assert.ok([302, 303].includes(bm.status));
    const mark = auditTail().find((e) => e.action === 'session.bookmark.set');
    assert.equal(mark.actor, 'varsha@tt.com');
    // The owner removes her: she is out at once.
    await call('POST', '/admin/access/remove', { email: 'willian@tt.com', body: 'email=varsha%40tt.com' });
    assert.equal((await call('GET', '/admin/sessions', { email: 'varsha@tt.com' })).status, 403);
    assert.ok(auditTail().some((e) => e.action === 'access.remove' && e.actor === 'willian@tt.com' && e.target === 'varsha@tt.com'));
});

test('the JSON API gate (requireAdminSession) applies the same allowlist and gives the role', async () => {
    process.env.ERICA_STUDIO_OWNERS = 'willian@tt.com';
    access._internal.resetDenials();
    const req = (email) => ({ headers: { cookie: cookieFor(email) } });
    assert.equal(await admin.requireAdminSession(req('wixdev@tt.com')), null);
    assert.ok(auditTail().some((e) => e.action === 'access.denied' && e.meta && e.meta.via === 'api'));
    const s = await admin.requireAdminSession(req('willian@tt.com'));
    assert.deepEqual([s.role, s.actor], ['owner', 'willian@tt.com']);
    delete process.env.ERICA_STUDIO_OWNERS;
    const before = await admin.requireAdminSession(req('wixdev@tt.com'));
    assert.equal(before.role, null, 'not configured: as before');
});

test('wiring: no Studio write is audited as the shared "admin" subject any more', () => {
    const src = fs.readFileSync(path.join(root, 'lib/admin.js'), 'utf8');
    assert.ok(!/actor: session\.sub/.test(src));
    assert.ok((src.match(/actor: actorOf\(session\)/g) || []).length >= 20);
    assert.ok(!fs.existsSync(path.join(root, 'studio-access.json')), 'the list is never in the repo');
});
