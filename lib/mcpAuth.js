// Coach Studio as an OAuth 2.1 authorization server for its MCP connector (#38).
//
// Claude (custom connector) and ChatGPT (developer mode) both connect the same
// way: they read our metadata, register (DCR) or identify themselves (CIMD),
// send the person to /oauth/authorize, and exchange the code with PKCE. The
// sign-in on our side IS the Studio's: Wix login + the "Coach Studio Admin"
// badge + the allowlist (lib/studioAccess.js). What a person grants is capped
// by their Studio role, and re-checked on every call and every refresh.
//
// Standards each client needs (vendor docs, 2026-10-01): RFC 9728 protected
// resource metadata (and a 401 pointing at it), RFC 8414 authorization server
// metadata, PKCE S256, RFC 7591 DCR or CIMD, RFC 8707 resource → the token's
// audience, RFC 9207 `iss` in the authorization response (ChatGPT's stable
// redirect URI), rotating refresh tokens, form-urlencoded token requests.
//
// Tokens are opaque and stored hashed on the volume, one "family" per grant
// (the access token + its rotating refresh token), per person, revocable
// from the Studio's "Connected AI apps" page.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const studioAccess = require('./studioAccess');
const wixBadges = require('./wixBadges');
const brandIcons = require('./brandIcons');

const ACCESS_TTL_S = 60 * 60;            // 1 h
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 days (Willian, 2026-10-01)
const CODE_TTL_MS = 10 * 60 * 1000;
const SCOPE_INFO = {
    'read:ops': 'See how the coach is doing: visits without names, pipeline, cost, health, configuration',
    'read:people': 'See people: who visited, what was said (when stored), their clipboard',
    'write:content': 'Change Injected Data and bookmark visits (previewed, confirmed, audited)',
    'write:people': 'Change what the coach keeps about people (no tools use this yet)',
};
const SCOPES = Object.keys(SCOPE_INFO);
// Only these clients may register or identify themselves.
const REDIRECT_OK = [
    /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
    /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
    /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/,
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[^\s]*$/, // Claude Code, MCP Inspector
];
const CIMD_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com', 'chatgpt.com', 'openai.com'];

// ---- configuration --------------------------------------------------------

function issuer() {
    const o = process.env.PUBLIC_ORIGIN
        || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + (process.env.PORT || 8002));
    return o.replace(/\/+$/, '');
}
function resourceUrl() { return issuer() + '/mcp'; }
function dataDir() {
    return process.env.MCP_DATA_DIR || path.join(path.dirname(process.env.SESSION_DATA_DIR || '/data/sessions'), 'mcp');
}

function protectedResourceMetadata() {
    return {
        resource: resourceUrl(),
        authorization_servers: [issuer()],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
        resource_name: 'Coach Studio',
    };
}

function authorizationServerMetadata() {
    const i = issuer();
    return {
        issuer: i,
        authorization_endpoint: i + '/oauth/authorize',
        token_endpoint: i + '/oauth/token',
        registration_endpoint: i + '/oauth/register',
        revocation_endpoint: i + '/oauth/revoke',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        scopes_supported: SCOPES.concat(['offline_access']),
    };
}

// The 401 that starts sign-in (Claude requires it to be a 401, with this pointer).
function challenge(extra = '') {
    return `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource", scope="read:ops"${extra}`;
}

// ---- small stores on the volume ---------------------------------------------

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir(), file), 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') console.error('[mcpAuth] ⚠️ ' + file + ' unreadable:', e.message);
        return fallback;
    }
}
function writeJson(file, data) {
    fs.mkdirSync(dataDir(), { recursive: true });
    const p = path.join(dataDir(), file);
    fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 1));
    fs.renameSync(p + '.tmp', p);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const randomToken = (prefix) => prefix + b64u(crypto.randomBytes(32));
const nowS = () => Math.floor(Date.now() / 1000);

let _tokens = null; // { families: { [id]: family } }
function tokens() {
    if (!_tokens) _tokens = readJson('tokens.json', { families: {} });
    return _tokens;
}
function saveTokens() { writeJson('tokens.json', tokens()); }

// ---- clients: DCR and CIMD ------------------------------------------------------

function validRedirect(u) { return typeof u === 'string' && REDIRECT_OK.some((re) => re.test(u)); }

function registerClient(body) {
    const redirect_uris = Array.isArray(body && body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!redirect_uris.length) return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris required' } };
    const bad = redirect_uris.find((u) => !validRedirect(u));
    if (bad) return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'Only Claude and ChatGPT (or a loopback client) can connect: ' + bad } };
    const store = readJson('clients.json', { clients: {} });
    const client_id = 'cs-' + b64u(crypto.randomBytes(16));
    const rec = {
        client_name: String((body && body.client_name) || 'MCP client').slice(0, 100),
        redirect_uris,
        created_at: nowS(),
    };
    store.clients[client_id] = rec;
    // Claude registers a new client on fresh connections: keep the newest 2000.
    const ids = Object.keys(store.clients);
    if (ids.length > 2000) ids.sort((a, b) => store.clients[a].created_at - store.clients[b].created_at).slice(0, ids.length - 2000).forEach((id) => delete store.clients[id]);
    writeJson('clients.json', store);
    return { status: 201, body: { client_id, client_id_issued_at: rec.created_at, client_name: rec.client_name, redirect_uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } };
}

const _cimdCache = new Map();
async function cimdClient(url, fetchImpl = fetch) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (u.protocol !== 'https:' || !CIMD_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return null;
    const hit = _cimdCache.get(url);
    if (hit && hit.exp > Date.now()) return hit.client;
    const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('client metadata document: HTTP ' + r.status);
    const text = await r.text();
    if (text.length > 64 * 1024) throw new Error('client metadata document too large');
    const doc = JSON.parse(text);
    if (doc.client_id !== url) throw new Error('client metadata document: client_id does not match its URL');
    // The same return addresses as DCR: a document on an allowed host must
    // still not send the code anywhere but Claude, ChatGPT or this computer.
    const listed = (Array.isArray(doc.redirect_uris) ? doc.redirect_uris : []).map(String);
    const redirect_uris = listed.filter(validRedirect);
    if (redirect_uris.length < listed.length) console.warn('[mcpAuth] ⚠️ client metadata document ' + url + ' lists return addresses we refuse (ignored): ' + listed.filter((x) => !validRedirect(x)).join(', '));
    if (!redirect_uris.length) throw new Error('none of its return addresses is Claude, ChatGPT or this computer');
    const client = { client_name: String(doc.client_name || u.hostname).slice(0, 100), redirect_uris, cimd: true };
    _cimdCache.set(url, { client, exp: Date.now() + 24 * 3600 * 1000 });
    return client;
}

async function findClient(client_id, fetchImpl) {
    if (!client_id) return null;
    if (/^https:\/\//.test(client_id)) return cimdClient(client_id, fetchImpl);
    const c = readJson('clients.json', { clients: {} }).clients[client_id];
    return c || null;
}

// Loopback redirects match whatever the port (RFC 8252 7.3, and Claude Code).
function redirectMatches(registered, given) {
    if (registered.includes(given)) return true;
    const strip = (x) => x.replace(/^(http:\/\/(?:localhost|127\.0\.0\.1)):\d+/, '$1');
    return /^http:\/\/(localhost|127\.0\.0\.1)/.test(given) && registered.some((r) => strip(r) === strip(given));
}

// ---- authorization codes and consent -------------------------------------------

const _codes = new Map(); // code -> grant; single use
const _usedCodes = new Map(); // code -> familyId, to revoke on a replay

function txFor(email, p) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET not configured');
    return crypto.createHmac('sha256', secret).update(JSON.stringify([email, p.client_id, p.redirect_uri, p.code_challenge, p.state || '', p.resource || ''])).digest('base64url');
}

function scopesForRole(role) { return studioAccess.scopesFor(role).filter((s) => SCOPES.includes(s)); }

function issueCode(grant) {
    const code = 'csc_' + b64u(crypto.randomBytes(24));
    _codes.set(code, { ...grant, exp: Date.now() + CODE_TTL_MS });
    return code;
}

function redirectWith(redirect_uri, params) {
    const u = new URL(redirect_uri);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
    return u.toString();
}

// ---- token families ---------------------------------------------------------

function newFamily(grant) {
    const access = randomToken('csa_');
    const refresh = randomToken('csr_');
    const id = 'f-' + b64u(crypto.randomBytes(9));
    const t = nowS();
    tokens().families[id] = {
        id, email: grant.email, memberId: grant.memberId, name: grant.name || null, clientId: grant.client_id, clientName: grant.clientName,
        scopes: grant.scopes, resource: grant.resource, createdAt: t, lastUsedAt: null, revokedAt: null, revokedBy: null,
        accessHash: sha(access), accessExp: t + ACCESS_TTL_S, refreshHash: sha(refresh), refreshExp: t + REFRESH_TTL_S, usedRefresh: [],
    };
    saveTokens();
    return { id, access, refresh };
}

function tokenResponse(fam, access, refresh) {
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: fam.scopes.join(' ') };
}

function revokeFamily(id, by) {
    const f = tokens().families[id];
    if (!f || f.revokedAt) return false;
    f.revokedAt = nowS();
    f.revokedBy = by || null;
    saveTokens();
    return true;
}

function listFamilies() {
    return Object.values(tokens().families).sort((a, b) => b.createdAt - a.createdAt).map((f) => ({
        id: f.id, email: f.email, clientName: f.clientName, scopes: f.scopes, createdAt: f.createdAt, lastUsedAt: f.lastUsedAt,
        expiresAt: f.refreshExp, revokedAt: f.revokedAt, revokedBy: f.revokedBy, active: !f.revokedAt && f.refreshExp > nowS(),
    }));
}

// Who is calling /mcp, and with which scopes right now: the token's scopes
// capped by the person's current role; badge and allowlist re-checked.
async function verifyBearer(req) {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(\S+)$/i);
    if (!m) return { ok: false, status: 401, error: 'invalid_token', description: 'Sign in to Coach Studio' };
    if (!studioAccess.configured()) return { ok: false, status: 403, error: 'access_denied', description: 'Coach Studio allowlist not configured (ERICA_STUDIO_OWNERS): MCP is off' };
    const hash = sha(m[1]);
    const fam = Object.values(tokens().families).find((f) => f.accessHash === hash);
    if (!fam || fam.revokedAt || fam.accessExp < nowS()) return { ok: false, status: 401, error: 'invalid_token', description: fam && fam.revokedAt ? 'Revoked in the Studio' : 'Expired or unknown token' };
    if (fam.resource !== resourceUrl()) return { ok: false, status: 401, error: 'invalid_token', description: 'Token issued for another resource' };
    const allowed = studioAccess.check(fam.email);
    const badge = allowed.ok ? await wixBadges.holdsAdminBadge(fam.memberId) : { ok: false };
    if (!allowed.ok || !badge.ok) return { ok: false, status: 401, error: 'invalid_token', description: 'No longer allowed in Coach Studio' };
    const scopes = fam.scopes.filter((s) => scopesForRole(allowed.role).includes(s));
    if (!fam.lastUsedAt || nowS() - fam.lastUsedAt > 60) { fam.lastUsedAt = nowS(); saveTokens(); }
    return { ok: true, family: fam.id, email: fam.email, role: allowed.role, client: fam.clientName, scopes };
}

// ---- HTTP --------------------------------------------------------------------

function readBody(req, max = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let n = 0; const chunks = [];
        req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
}
const oauthError = (res, error, description, status = 400) => sendJson(res, status, { error, error_description: description });

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Every OAuth page (consent, errors) carries the Coach Studio mark: in the tab
// and at the top of the card, so the person sees whose sign-in this is.
const BRAND_ROW = '<div class="flex items-center gap-2" data-brand><img src="/studio-assets/coach-studio-96.png" alt="" width="32" height="32"><span class="text-sm font-semibold text-gray-700">Coach Studio</span></div>';
function pageHtml(title, inner) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Coach Studio — ${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${brandIcons.HEAD_LINKS}<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen bg-gray-50 flex items-center justify-center p-4"><div class="w-full max-w-md bg-white rounded-2xl shadow-sm p-6 space-y-4 border border-gray-200">${BRAND_ROW}${inner}</div></body></html>`;
}

// Who the code goes to, by the return address (on the allowlist above): the
// app's own client_name is self-asserted, so it is only shown beside it.
function returnTo(redirect_uri) {
    const u = new URL(redirect_uri);
    if (u.hostname === 'claude.ai') return { app: 'Claude', host: u.host, local: false };
    if (u.hostname === 'chatgpt.com') return { app: 'ChatGPT', host: u.host, local: false };
    return { app: 'an app on this computer', host: u.host, local: true };
}

function consentPage(p, who, client) {
    const allowed = scopesForRole(who.role);
    const to = returnTo(p.redirect_uri);
    const calls = client.client_name && client.client_name.toLowerCase() !== to.app.toLowerCase() ? ` <span class="text-sm font-normal text-gray-500">(calls itself “${esc(client.client_name)}”)</span>` : '';
    const rows = allowed.map((s) => `<label class="flex gap-2 items-start text-sm"><input type="checkbox" name="scope" value="${s}" ${s === 'read:ops' ? 'checked disabled' : ''} class="mt-1"><span><b class="font-mono text-xs">${s}</b><br><span class="text-gray-600">${esc(SCOPE_INFO[s])}</span></span></label>`).join('');
    const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource'].map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] || '')}">`).join('');
    return pageHtml('Connect an AI app', `
  <div><div class="text-lg font-semibold text-gray-900">Connect ${esc(to.app)} to Coach Studio${calls}</div>
  <div class="text-xs text-gray-500 mt-1">as <span class="font-mono">${esc(who.email)}</span> (${esc(who.role || 'no role')})</div></div>
  <div class="rounded-lg border ${to.local ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'} px-3 py-2" data-return-to="${esc(to.host)}">
    <div class="text-sm text-gray-900">After you allow, you go back to <b class="font-mono text-base">${esc(to.host)}</b></div>
    <div class="text-xs text-gray-600 mt-0.5">Only continue if you started connecting from ${esc(to.app)} yourself.</div>
  </div>
  <form method="POST" action="/oauth/authorize" class="space-y-3" data-consent>
    ${hidden}<input type="hidden" name="tx" value="${esc(txFor(who.email, p))}">
    <input type="hidden" name="scope" value="read:ops">
    <div class="space-y-2">${rows}</div>
    <p class="text-xs text-gray-500">Only what you tick. Your Studio role caps it, and you can revoke it any time on the Studio's Connected AI apps page.</p>
    <div class="flex gap-2 pt-1"><button name="decision" value="allow" class="px-3 py-1.5 rounded bg-teal-700 text-white text-sm">Allow</button>
    <button name="decision" value="deny" class="px-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100">Deny</button></div>
  </form>`);
}

// opts: { identity(req) → admin.studioIdentity, audit, fetchImpl }
async function handle(req, res, opts = {}) {
    const url = req.url || '';
    const pathOnly = url.split('?')[0];
    const audit = opts.audit;

    if (req.method === 'GET' && (pathOnly === '/.well-known/oauth-protected-resource' || pathOnly === '/.well-known/oauth-protected-resource/mcp')) {
        sendJson(res, 200, protectedResourceMetadata(), { 'Access-Control-Allow-Origin': '*' });
        return true;
    }
    if (req.method === 'GET' && (pathOnly === '/.well-known/oauth-authorization-server' || pathOnly === '/.well-known/oauth-authorization-server/mcp')) {
        sendJson(res, 200, authorizationServerMetadata(), { 'Access-Control-Allow-Origin': '*' });
        return true;
    }

    if (req.method === 'POST' && pathOnly === '/oauth/register') {
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { return oauthError(res, 'invalid_client_metadata', 'JSON body required'), true; }
        const r = registerClient(body);
        sendJson(res, r.status, r.body);
        return true;
    }

    if (pathOnly === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
        const p = req.method === 'GET' ? Object.fromEntries(new URL(url, 'http://x').searchParams) : {};
        let form = null;
        if (req.method === 'POST') {
            form = new URLSearchParams(await readBody(req));
            for (const k of ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource']) p[k] = form.get(k) || '';
        }
        const page = (status, title, msg) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(pageHtml(title, `<div class="text-lg font-semibold">${esc(title)}</div><p class="text-sm text-gray-700">${esc(msg)}</p>`)); return true; };
        let client;
        try { client = await findClient(p.client_id, opts.fetchImpl); } catch (e) { return page(400, 'Unknown app', 'Could not read this app\'s client document: ' + e.message); }
        if (!client) return page(400, 'Unknown app', 'This app is not registered with Coach Studio.');
        if (!p.redirect_uri || !validRedirect(p.redirect_uri) || !redirectMatches(client.redirect_uris, p.redirect_uri)) return page(400, 'Wrong return address', 'The app asked to return to an address it did not register, or one that is not Claude, ChatGPT or this computer.');
        // From here errors go back to the app, with iss (RFC 9207).
        const back = (params) => { res.writeHead(302, { Location: redirectWith(p.redirect_uri, { ...params, state: p.state, iss: issuer() }), 'Cache-Control': 'no-store' }); res.end(); return true; };
        if (p.response_type !== 'code') return back({ error: 'unsupported_response_type' });
        if (!p.code_challenge || p.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE S256 required' });
        if (p.resource && p.resource !== resourceUrl()) return back({ error: 'invalid_target', error_description: 'Unknown resource' });
        if (!studioAccess.configured()) return page(403, 'MCP is off', 'Coach Studio\'s allowlist is not configured (ERICA_STUDIO_OWNERS), so no AI app can connect yet.');
        const who = await opts.identity(req);
        if (who.status === 'none') {
            res.writeHead(302, { Location: '/admin/login?next=' + encodeURIComponent(url.startsWith('/oauth/authorize?') ? url : '/oauth/authorize?' + new URLSearchParams(p)), 'Cache-Control': 'no-store' });
            res.end();
            return true;
        }
        if (who.status !== 'ok') return page(403, 'Not allowed', `${who.email || 'This account'}: ${who.reason}.`);
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
            res.end(consentPage(p, who, client));
            return true;
        }
        const tx = form.get('tx') || '';
        const want = txFor(who.email, p);
        if (tx.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tx), Buffer.from(want))) return page(400, 'Expired form', 'Start connecting again from the app.');
        if (form.get('decision') !== 'allow') {
            if (audit) audit.append({ actor: who.email, via: 'mcp', action: 'mcp.consent.deny', target: client.client_name });
            return back({ error: 'access_denied' });
        }
        const allowed = scopesForRole(who.role);
        const scopes = SCOPES.filter((s) => (s === 'read:ops' || form.getAll('scope').includes(s)) && allowed.includes(s));
        const code = issueCode({ client_id: p.client_id, clientName: client.client_name, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, resource: resourceUrl(), scopes, email: who.email, memberId: who.memberId, name: who.name });
        if (audit) audit.append({ actor: who.email, via: 'mcp', action: 'mcp.consent.allow', target: client.client_name, meta: { scopes } });
        return back({ code });
    }

    if (req.method === 'POST' && pathOnly === '/oauth/token') {
        const f = new URLSearchParams(await readBody(req));
        const grantType = f.get('grant_type');
        if (grantType === 'authorization_code') {
            const code = f.get('code') || '';
            const g = _codes.get(code);
            if (!g) {
                const fam = _usedCodes.get(code);
                if (fam) revokeFamily(fam, 'code replay');
                return oauthError(res, 'invalid_grant', 'Unknown, expired or used code'), true;
            }
            _codes.delete(code);
            if (g.exp < Date.now()) return oauthError(res, 'invalid_grant', 'Code expired'), true;
            if (f.get('client_id') !== g.client_id || f.get('redirect_uri') !== g.redirect_uri) return oauthError(res, 'invalid_grant', 'Client or redirect_uri mismatch'), true;
            const verifier = f.get('code_verifier') || '';
            if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64u(crypto.createHash('sha256').update(verifier).digest()) !== g.code_challenge) return oauthError(res, 'invalid_grant', 'PKCE verification failed'), true;
            if (f.get('resource') && f.get('resource') !== g.resource) return oauthError(res, 'invalid_target', 'Unknown resource'), true;
            const { id, access, refresh } = newFamily(g);
            _usedCodes.set(code, id);
            if (_usedCodes.size > 1000) _usedCodes.delete(_usedCodes.keys().next().value);
            if (audit) audit.append({ actor: g.email, via: 'mcp', action: 'mcp.token.issue', target: g.clientName, meta: { family: id, scopes: g.scopes } });
            sendJson(res, 200, tokenResponse(tokens().families[id], access, refresh), { Pragma: 'no-cache' });
            return true;
        }
        if (grantType === 'refresh_token') {
            const h = sha(f.get('refresh_token') || '');
            const all = Object.values(tokens().families);
            const fam = all.find((x) => x.refreshHash === h);
            if (!fam) {
                const reused = all.find((x) => x.usedRefresh.includes(h));
                if (reused) { revokeFamily(reused.id, 'refresh token reuse'); if (audit) audit.append({ actor: reused.email, via: 'mcp', action: 'mcp.token.reuse', target: reused.clientName, meta: { family: reused.id } }); }
                return oauthError(res, 'invalid_grant', 'Unknown or already used refresh token'), true;
            }
            if (fam.revokedAt || fam.refreshExp < nowS()) return oauthError(res, 'invalid_grant', fam.revokedAt ? 'Revoked' : 'Expired'), true;
            if (f.get('client_id') && f.get('client_id') !== fam.clientId) return oauthError(res, 'invalid_grant', 'Client mismatch'), true;
            const allowed = studioAccess.check(fam.email);
            const badge = allowed.ok ? await wixBadges.holdsAdminBadge(fam.memberId) : { ok: false };
            if (!allowed.ok || !badge.ok) { revokeFamily(fam.id, 'access removed'); return oauthError(res, 'invalid_grant', 'No longer allowed in Coach Studio'), true; }
            const access = randomToken('csa_');
            const refresh = randomToken('csr_');
            fam.usedRefresh = fam.usedRefresh.concat([fam.refreshHash]).slice(-20);
            fam.scopes = fam.scopes.filter((s) => scopesForRole(allowed.role).includes(s));
            fam.accessHash = sha(access); fam.accessExp = nowS() + ACCESS_TTL_S;
            fam.refreshHash = sha(refresh);
            saveTokens();
            sendJson(res, 200, tokenResponse(fam, access, refresh), { Pragma: 'no-cache' });
            return true;
        }
        return oauthError(res, 'unsupported_grant_type', 'authorization_code or refresh_token'), true;
    }

    if (req.method === 'POST' && pathOnly === '/oauth/revoke') {
        const f = new URLSearchParams(await readBody(req));
        const h = sha(f.get('token') || '');
        const fam = Object.values(tokens().families).find((x) => x.accessHash === h || x.refreshHash === h);
        if (fam && revokeFamily(fam.id, 'client') && audit) audit.append({ actor: fam.email, via: 'mcp', action: 'mcp.token.revoke', target: fam.clientName, meta: { family: fam.id, by: 'client' } });
        res.writeHead(200, { 'Cache-Control': 'no-store' });
        res.end();
        return true;
    }
    return false;
}

module.exports = {
    SCOPES, SCOPE_INFO, issuer, resourceUrl, challenge, protectedResourceMetadata, authorizationServerMetadata,
    handle, verifyBearer, revokeFamily, listFamilies, scopesForRole,
    _internal: { reset: () => { _tokens = null; _codes.clear(); _usedCodes.clear(); _cimdCache.clear(); }, dataDir, redirectMatches, validRedirect },
};
