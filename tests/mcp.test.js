// #38 B: the Coach Studio MCP connector, over real HTTP. OAuth as Claude and
// ChatGPT do it (metadata, DCR / CIMD, consent through the Studio sign-in,
// PKCE, iss, rotating refresh), then /mcp with the tools the token's scopes
// allow, capped by the person's Studio role; writes previewed and audited as
// the person via 'mcp'; every call logged; revocation from the Studio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
Object.assign(process.env, {
    SESSION_DATA_DIR: path.join(tmp, 'sessions'), AUDIT_DIR: path.join(tmp, 'audit'), SESSION_BOOKMARKS_FILE: path.join(tmp, 'bookmarks.json'),
    INJECTED_DATA_DIR: path.join(tmp, 'injected'), AGENT_HISTORY_DIR: path.join(tmp, 'ah'), CLIPBOARD_DATA_DIR: path.join(tmp, 'clip'),
    SESSION_SECRET: 'test-secret-mcp', ERICA_STUDIO_OWNERS: 'willian@tt.com', STORE_MESSAGE_TEXT: 'redacted',
});
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(tmp, 'studio-access.json'), JSON.stringify({ users: { 'eric@tt.com': { role: 'admin' }, 'varsha@tt.com': { role: 'people' } } }));
const now = new Date().toISOString();
fs.writeFileSync(path.join(process.env.SESSION_DATA_DIR, 's-vTEST1.ndjson'), [
    { type: 'session_start', t: now, sessionId: 's-vTEST1', idScheme: 'visit', actor: { email: 'ana@example.com', userId: 'u-ana', personKey: 'p-ana' } },
    { type: 'turn', role: 'user', t: now, redacted: true, length: 22, hash: 'abc' },
    { type: 'turn', role: 'bot', t: now, text: 'Hi Ana, what would help today?' },
    { type: 'event', t: now, name: 'silent_call', meta: { reason: 'click' } },
].map((e) => JSON.stringify(e)).join('\n') + '\n');

const wixBadges = require('../lib/wixBadges');
let badgeOk = true;
wixBadges.holdsAdminBadge = async () => ({ ok: badgeOk });
const admin = require('../lib/admin');
const auditLog = require('../lib/audit');
const mcpAuth = require('../lib/mcpAuth');
const mcpServer = require('../lib/mcpServer');

const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const cimdDoc = { client_id: 'https://chatgpt.com/oauth/client.json', client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] };
const fakeFetch = async (url) => ({ ok: url === cimdDoc.client_id, status: 200, text: async () => JSON.stringify(cimdDoc) });

let base;
const server = http.createServer(async (req, res) => {
    if (await mcpAuth.handle(req, res, { identity: admin.studioIdentity, audit: auditLog, fetchImpl: fakeFetch })) return;
    if (await mcpServer.handle(req, res)) return;
    if (await admin.handle(req, res)) return;
    res.writeHead(404); res.end();
});
test.before(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
    process.env.PUBLIC_ORIGIN = base;
});
test.after(() => server.close());

const cookie = (email) => { const t = Math.floor(Date.now() / 1000); return 'admin_session=' + admin.signSession({ sub: 'admin', m: 'm-' + email, e: email, n: email, iat: t, exp: t + 3600 }); };
const pkce = () => { const verifier = crypto.randomBytes(48).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function register(redirect = CLAUDE_CB) {
    const r = await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) });
    return { status: r.status, body: await r.json() };
}

// The whole browser leg: authorize → consent → code; then the token exchange.
async function connect(email, { scopes = [], clientId, redirect = CLAUDE_CB } = {}) {
    clientId = clientId || (await register(redirect)).body.client_id;
    const { verifier, challenge } = pkce();
    const q = { response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-' + email, resource: base + '/mcp', scope: 'read:ops' };
    const page = await fetch(base + '/oauth/authorize?' + form(q), { headers: { cookie: cookie(email) } });
    const html = await page.text();
    const tx = html.match(/name="tx" value="([^"]+)"/)[1];
    const body = new URLSearchParams({ ...q, tx, decision: 'allow' });
    scopes.forEach((s) => body.append('scope', s));
    const r = await fetch(base + '/oauth/authorize', { method: 'POST', headers: { ...FORM, cookie: cookie(email) }, body: body.toString(), redirect: 'manual' });
    const loc = new URL(r.headers.get('location'));
    const tok = await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: base + '/mcp' }) });
    return { clientId, html, loc, token: await tok.json() };
}

let rpcId = 0;
async function rpc(token, method, params, extraHeaders = {}) {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}
const toolText = (r) => JSON.parse(r.body.result.content[0].text);
const audits = () => auditLog.list({ limit: 200 });

test('discovery: protected-resource and authorization-server metadata as Claude and ChatGPT read them; /mcp answers 401 with the pointer', async () => {
    const prm = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
    assert.deepEqual([prm.resource, prm.authorization_servers], [base + '/mcp', [base]]);
    assert.deepEqual(prm.scopes_supported, ['read:ops', 'read:people', 'write:content', 'write:people']);
    assert.deepEqual(await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json(), prm);
    const as = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(as.client_id_metadata_document_supported, true, 'Claude uses CIMD only with this and "none"');
    assert.equal(as.authorization_response_iss_parameter_supported, true, "ChatGPT's stable redirect");
    assert.equal(as.registration_endpoint, base + '/oauth/register');
    const r = await rpc(null, 'initialize', {});
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="read:ops"`);
    const bad = await rpc('csa_nope', 'initialize', {});
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
});

test('registration: Claude and ChatGPT redirect URIs (and loopback) only', async () => {
    assert.equal((await register()).status, 201);
    assert.equal((await register('https://chatgpt.com/connector/oauth/abc123')).status, 201);
    assert.equal((await register('http://localhost:6274/oauth/callback')).status, 201);
    const evil = await register('https://evil.example/cb');
    assert.deepEqual([evil.status, evil.body.error], [400, 'invalid_redirect_uri']);
});

test('authorize: not signed in → the Studio login (and back); badge-only → refused; consent offers only what the role allows; deny and bad forms', async () => {
    const { body: { client_id } } = await register();
    const { challenge } = pkce();
    const q = form({ response_type: 'code', client_id, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });
    const anon = await fetch(base + '/oauth/authorize?' + q, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/admin/login?next=' + encodeURIComponent('/oauth/authorize?' + q));
    const login = await fetch(base + anon.headers.get('location'));
    assert.match(login.headers.get('set-cookie'), /^cs_next=%2Foauth%2Fauthorize%3F/, 'remembered for after the Wix sign-in');
    const stranger = await fetch(base + '/oauth/authorize?' + q, { headers: { cookie: cookie('wixdev@tt.com') } });
    assert.equal(stranger.status, 403);
    assert.match(await stranger.text(), /not on the Coach Studio allowlist/);
    const ericPage = await (await fetch(base + '/oauth/authorize?' + q, { headers: { cookie: cookie('eric@tt.com') } })).text();
    assert.match(ericPage, /Connect Claude to Coach Studio/);
    assert.match(ericPage, /it will send you back to <b>claude\.ai<\/b>/);
    assert.ok(ericPage.includes('value="write:content"') && !ericPage.includes('value="read:people"'), 'an admin is not offered people scopes');
    assert.ok(/value="read:ops" checked disabled/.test(ericPage), 'read:ops is the default');
    const ownerPage = await (await fetch(base + '/oauth/authorize?' + q, { headers: { cookie: cookie('willian@tt.com') } })).text();
    assert.ok(ownerPage.includes('value="read:people"') && ownerPage.includes('value="write:people"'));
    const forged = await fetch(base + '/oauth/authorize', { method: 'POST', headers: { ...FORM, cookie: cookie('willian@tt.com') }, body: q + '&tx=forged&decision=allow', redirect: 'manual' });
    assert.equal(forged.status, 400);
    const tx = ownerPage.match(/name="tx" value="([^"]+)"/)[1];
    const deny = await fetch(base + '/oauth/authorize', { method: 'POST', headers: { ...FORM, cookie: cookie('willian@tt.com') }, body: q + '&tx=' + tx + '&decision=deny', redirect: 'manual' });
    const dl = new URL(deny.headers.get('location'));
    assert.deepEqual([dl.origin + dl.pathname, dl.searchParams.get('error'), dl.searchParams.get('state'), dl.searchParams.get('iss')], [CLAUDE_CB, 'access_denied', 's1', base]);
    const wrongCb = await fetch(base + '/oauth/authorize?' + q.replace(encodeURIComponent(CLAUDE_CB), encodeURIComponent('https://chatgpt.com/connector_platform_oauth_redirect')), { headers: { cookie: cookie('willian@tt.com') } });
    assert.equal(wrongCb.status, 400, 'a redirect the client did not register');
    const noPkce = await fetch(base + '/oauth/authorize?' + q.replace('code_challenge_method=S256', 'code_challenge_method=plain'), { headers: { cookie: cookie('willian@tt.com') }, redirect: 'manual' });
    assert.match(noPkce.headers.get('location'), /error=invalid_request/);
});

test('code exchange: PKCE checked, iss in the redirect, the code works once (a replay revokes what it issued); ChatGPT through CIMD', async () => {
    const c = await connect('willian@tt.com', { scopes: ['read:people'] });
    assert.equal(c.loc.searchParams.get('iss'), base);
    assert.equal(c.loc.searchParams.get('state'), 'st-willian@tt.com');
    assert.deepEqual([c.token.token_type, c.token.expires_in, c.token.scope], ['Bearer', 3600, 'read:ops read:people']);
    assert.match(c.token.access_token, /^csa_/);
    assert.match(c.token.refresh_token, /^csr_/);
    // Wrong verifier, then replay.
    const { body: { client_id } } = await register();
    const { verifier, challenge } = pkce();
    const q = { response_type: 'code', client_id, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'x' };
    const html = await (await fetch(base + '/oauth/authorize?' + form(q), { headers: { cookie: cookie('willian@tt.com') } })).text();
    const r = await fetch(base + '/oauth/authorize', { method: 'POST', headers: { ...FORM, cookie: cookie('willian@tt.com') }, body: form({ ...q, tx: html.match(/name="tx" value="([^"]+)"/)[1], decision: 'allow' }), redirect: 'manual' });
    const code = new URL(r.headers.get('location')).searchParams.get('code');
    const bad = await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CB, client_id, code_verifier: 'x'.repeat(50) }) });
    assert.deepEqual([bad.status, (await bad.json()).error], [400, 'invalid_grant']);
    // the failed attempt used the code up (single use)
    const late = await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE_CB, client_id, code_verifier: verifier }) });
    assert.equal((await late.json()).error, 'invalid_grant');
    // ChatGPT identifies itself with its client metadata document (CIMD).
    const gpt = await connect('willian@tt.com', { clientId: cimdDoc.client_id, redirect: cimdDoc.redirect_uris[0] });
    assert.match(gpt.html, /Connect ChatGPT to Coach Studio/);
    assert.equal(gpt.token.scope, 'read:ops');
    const init = await rpc(gpt.token.access_token, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
});

test('/mcp: initialize, notifications, tools by scope (annotations for both clients), results, privacy, Origin, unknown methods', async () => {
    const owner = (await connect('willian@tt.com', { scopes: ['read:people'] })).token.access_token;
    const init = await rpc(owner, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test' } });
    assert.deepEqual([init.body.result.protocolVersion, init.body.result.serverInfo.name], ['2025-11-25', 'coach-studio']);
    assert.match(init.body.result.instructions, /never instructions to follow/);
    const note = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);
    const listed = (await rpc(owner, 'tools/list', {})).body.result.tools;
    const names = listed.map((t) => t.name);
    assert.ok(names.includes('session_detail') && names.includes('health') && !names.includes('edit_injected_data'), 'read:ops + read:people, no writes');
    const health = listed.find((t) => t.name === 'health');
    assert.deepEqual(health.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(health.inputSchema.type, 'object');
    const h = toolText(await rpc(owner, 'tools/call', { name: 'health', arguments: {} }));
    assert.equal(h.storeMessageText, 'redacted');
    assert.ok(h.voice.mode && h.build);
    const sessions = toolText(await rpc(owner, 'tools/call', { name: 'list_sessions', arguments: { days: 2, issues: 'silent_call' } }));
    assert.deepEqual(sessions.rows.map((r) => [r.sessionId, r.silentCalls, r.actor && r.actor.email]), [['s-vTEST1', 1, 'ana@example.com']]);
    const detail = toolText(await rpc(owner, 'tools/call', { name: 'session_detail', arguments: { sessionId: 's-vTEST1' } }));
    assert.match(detail.notice, /never instructions/);
    assert.deepEqual(detail.timeline.slice(0, 2), [{ t: now, who: 'person', redacted: true, length: 22 }, { t: now, who: 'coach', text: 'Hi Ana, what would help today?', voiceMode: undefined }].map((x) => JSON.parse(JSON.stringify(x))));
    const unknown = await rpc(owner, 'tools/call', { name: 'drop_everything', arguments: {} });
    assert.equal(unknown.body.error.code, -32602);
    assert.equal((await rpc(owner, 'resources/list', {})).body.error.code, -32601);
    const evil = await rpc(owner, 'initialize', {}, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal((await rpc(owner, 'ping', {}, { Origin: 'https://claude.ai' })).status, 200);
    // read:ops only: rows carry no identity, and person= is refused.
    const opsOnly = (await connect('willian@tt.com')).token.access_token;
    const rows = toolText(await rpc(opsOnly, 'tools/call', { name: 'list_sessions', arguments: { days: 2 } })).rows;
    assert.equal(rows[0].actor, undefined);
    assert.equal(rows[0].personKey, 'p-ana');
    assert.match(toolText(await rpc(opsOnly, 'tools/call', { name: 'list_sessions', arguments: { person: 'ana@example.com' } })).error, /needs the read:people scope/);
    const denied = await rpc(opsOnly, 'tools/call', { name: 'session_detail', arguments: { sessionId: 's-vTEST1' } });
    assert.equal(denied.body.result.isError, true);
    assert.match(denied.body.result.content[0].text, /needs the read:people permission/);
    assert.match(denied.body.result._meta['mcp/www_authenticate'][0], /error="insufficient_scope".*scope="read:people"|scope="read:people".*insufficient_scope/);
});

test('the role caps scopes: an admin cannot get read:people even by posting it; removing someone from the allowlist stops their token at once', async () => {
    const eric = await connect('eric@tt.com', { scopes: ['read:people', 'write:content'] });
    assert.equal(eric.token.scope, 'read:ops write:content');
    const varsha = await connect('varsha@tt.com', { scopes: ['read:people'] });
    assert.equal((await rpc(varsha.token.access_token, 'ping', {})).status, 200);
    const access = require('../lib/studioAccess');
    access.remove('varsha@tt.com', { actor: 'willian@tt.com' });
    assert.equal((await rpc(varsha.token.access_token, 'ping', {})).status, 401);
    const refresh = await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: varsha.token.refresh_token, client_id: varsha.clientId }) });
    assert.equal((await refresh.json()).error, 'invalid_grant');
    access.set('varsha@tt.com', 'people', { actor: 'willian@tt.com' });
    // The badge is re-checked too.
    badgeOk = false;
    assert.equal((await rpc(eric.token.access_token, 'ping', {})).status, 401);
    badgeOk = true;
});

test('writes: Injected Data needs a preview of the exact change (then the client approves); audited as the person via mcp with the row before; bookmarks too', async () => {
    const t = (await connect('willian@tt.com', { scopes: ['write:content'] })).token.access_token;
    const tools = (await rpc(t, 'tools/list', {})).body.result.tools;
    const edit = tools.find((x) => x.name === 'edit_injected_data');
    assert.deepEqual([edit.annotations.readOnlyHint, edit.annotations.destructiveHint], [false, true], 'ChatGPT asks to confirm; Claude prompts');
    assert.equal(tools.find((x) => x.name === 'preview_injected_data_edit').annotations.readOnlyHint, true);
    const row = { course_id: 'tsb', name: 'Thriving Self Beliefs', url: 'https://tt.com/tsb', one_line: 'Beliefs that help' };
    const call = (name, args) => rpc(t, 'tools/call', { name, arguments: args });
    assert.match(toolText(await call('edit_injected_data', { kind: 'canonical-courses', op: 'upsert', row, preview_id: 'pv-nope' })).error, /call preview_injected_data_edit first/);
    const pv = toolText(await call('preview_injected_data_edit', { kind: 'canonical-courses', op: 'upsert', row }));
    assert.deepEqual([pv.before, pv.after.name], [null, 'Thriving Self Beliefs']);
    assert.match(toolText(await call('edit_injected_data', { kind: 'canonical-courses', op: 'upsert', row: { ...row, url: 'https://evil.example' }, preview_id: pv.preview_id })).error, /not the one that was previewed/);
    const done = toolText(await call('edit_injected_data', { kind: 'canonical-courses', op: 'upsert', row, reason: 'new course', preview_id: pv.preview_id }));
    assert.deepEqual([done.applied, done.after.url], [true, 'https://tt.com/tsb']);
    assert.match(toolText(await call('edit_injected_data', { kind: 'canonical-courses', op: 'upsert', row, preview_id: pv.preview_id })).error, /No valid preview/, 'a preview works once');
    const a = audits().find((e) => e.action === 'injected.canonical-courses.create');
    assert.deepEqual([a.actor, a.via, a.meta.reason, a.meta.before], ['willian@tt.com', 'mcp', 'new course', null]);
    // Change it: the audit keeps the row as it was.
    const pv2 = toolText(await call('preview_injected_data_edit', { kind: 'canonical-courses', op: 'upsert', row: { ...row, one_line: 'Updated' } }));
    toolText(await call('edit_injected_data', { kind: 'canonical-courses', op: 'upsert', row: { ...row, one_line: 'Updated' }, preview_id: pv2.preview_id }));
    assert.equal(audits().find((e) => e.action === 'injected.canonical-courses.update').meta.before.one_line, 'Beliefs that help');
    const bm = toolText(await call('bookmark_session', { sessionId: 's-vTEST1', kind: 'problem', note: 'silent call at start' }));
    assert.equal(bm.after.kind, 'problem');
    const b = audits().find((e) => e.action === 'session.bookmark.set');
    assert.deepEqual([b.actor, b.via], ['willian@tt.com', 'mcp']);
    assert.equal(auditLog.verify().ok, true, 'the chain verifies with via in it');
    // Every call is logged; free text hashed.
    const calls = mcpServer.recentCalls(500);
    const logged = calls.find((c) => c.tool === 'edit_injected_data' && c.status === 'ok' && c.args.reason);
    assert.equal(logged.email, 'willian@tt.com');
    assert.match(logged.args.reason, /^sha:[0-9a-f]{12}$/);
    assert.deepEqual(logged.args.row, { keys: ['course_id', 'name', 'url', 'one_line'] });
    assert.ok(calls.some((c) => c.status === 'insufficient_scope'));
});

test('refresh rotates; reusing an old refresh token revokes the whole connection; revoking in the Studio stops the next call; no allowlist = MCP off', async () => {
    const c = await connect('willian@tt.com');
    const r1 = await (await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: c.token.refresh_token, client_id: c.clientId }) })).json();
    assert.ok(r1.access_token && r1.refresh_token !== c.token.refresh_token);
    assert.equal((await rpc(r1.access_token, 'ping', {})).status, 200);
    assert.equal((await rpc(c.token.access_token, 'ping', {})).status, 401, 'the old access token is gone');
    const reuse = await (await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: c.token.refresh_token, client_id: c.clientId }) })).json();
    assert.equal(reuse.error, 'invalid_grant');
    assert.equal((await rpc(r1.access_token, 'ping', {})).status, 401, 'reuse revoked the family');
    // Studio revoke.
    const d = await connect('willian@tt.com');
    assert.equal((await rpc(d.token.access_token, 'ping', {})).status, 200);
    const page = await (await fetch(base + '/admin/connected-apps', { headers: { cookie: cookie('willian@tt.com') } })).text();
    assert.match(page, /AI apps connected to Coach Studio/);
    const fam = mcpAuth.listFamilies().find((f) => f.active);
    const rv = await fetch(base + '/admin/connected-apps/revoke', { method: 'POST', headers: { ...FORM, cookie: cookie('willian@tt.com') }, body: form({ all: 'mine' }), redirect: 'manual' });
    assert.equal(rv.status, 303);
    assert.equal((await rpc(d.token.access_token, 'ping', {})).status, 401);
    assert.ok(audits().some((e) => e.action === 'mcp.token.revoke' && e.via === 'studio' && e.actor === 'willian@tt.com'));
    assert.ok(fam);
    // Eric (admin) only sees his own connections.
    const ericPage = await (await fetch(base + '/admin/connected-apps', { headers: { cookie: cookie('eric@tt.com') } })).text();
    assert.ok(!ericPage.includes('willian@tt.com</div>'));
    // No allowlist → MCP is off.
    const e = await connect('willian@tt.com');
    delete process.env.ERICA_STUDIO_OWNERS;
    const off = await rpc(e.token.access_token, 'ping', {});
    assert.equal(off.status, 403);
    assert.match(off.body.error_description, /allowlist not configured/);
    process.env.ERICA_STUDIO_OWNERS = 'willian@tt.com';
});
