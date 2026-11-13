#!/usr/bin/env node
// Coach Studio CLI: lets an AI assistant that has a terminal (Claude Code,
// Codex, ...) read and manage Talent Transformation's AI coach (Erica) through
// Coach Studio, after the person signs in once with a link.
//
//   coach-studio login [--no-wait] [--wait SECONDS] [--check]
//   coach-studio status | tools | call TOOL [JSON | - | --args-file FILE] | logout
//
// Sign-in is the OAuth device flow (RFC 8628): `login` prints a link and a
// short code; the person opens the link in the browser where they are signed
// in to Coach Studio, checks the code and allows; this program then holds a
// token for that person (their Studio role caps what it can do) in
// ~/.coach-studio/credentials.json. Zero dependencies; needs Node 18 or newer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.0.0';
const DEFAULT_SERVER = '__ORIGIN__'; // filled in when this file is served by the Studio
const UNSET = '__' + 'ORIGIN' + '__';
const CLIENT_ID = 'coach-studio-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DIR = process.env.COACH_STUDIO_HOME || path.join(os.homedir(), '.coach-studio');
const CRED_FILE = path.join(DIR, 'credentials.json');
const PENDING_FILE = path.join(DIR, 'pending.json');
const CONFIG_FILE = path.join(DIR, 'config.json');
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error('Coach Studio CLI needs Node.js 18 or newer (this is ' + process.versions.node + '): https://nodejs.org');
    process.exit(1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };

class Fail extends Error { constructor(message, code = 1) { super(message); this.exitCode = code; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJson(file, data, mode = 0o600) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1), { mode });
    fs.renameSync(file + '.tmp', file);
}
function remove(file) { try { fs.unlinkSync(file); } catch (_) { /* not there */ } }

function serverUrl() {
    const s = value('--server') || process.env.COACH_STUDIO_URL || (readJson(CONFIG_FILE) || {}).server || (DEFAULT_SERVER !== UNSET ? DEFAULT_SERVER : null);
    if (!s) throw new Fail('No server address. Run the installer again, or pass --server https://...');
    return String(s).replace(/\/+$/, '');
}

async function post(url, { headers = {}, body }) {
    let r;
    try { r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) }); } catch (e) {
        throw new Fail('Could not reach ' + new URL(url).host + ': ' + (e.cause && e.cause.code || e.message));
    }
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    return { status: r.status, headers: r.headers, json, text };
}

// ---- sign-in -----------------------------------------------------------------

function saveCredentials(server, t) {
    writeJson(CRED_FILE, { server, access_token: t.access_token, refresh_token: t.refresh_token, access_exp: nowS() + (t.expires_in || 3600), scope: t.scope || '', saved_at: nowS() });
}

async function startLogin() {
    const server = serverUrl();
    const r = await post(server + '/oauth/device_authorization', { headers: FORM, body: new URLSearchParams({ client_id: CLIENT_ID, device_name: value('--device-name') || os.hostname() }).toString() });
    if (r.status !== 200 || !r.json || !r.json.device_code) throw new Fail('Could not start the sign-in: ' + ((r.json && (r.json.error_description || r.json.error)) || 'HTTP ' + r.status));
    const j = r.json;
    writeJson(PENDING_FILE, { server, device_code: j.device_code, user_code: j.user_code, link: j.verification_uri_complete, interval: j.interval || 5, expires_at: Date.now() + (j.expires_in || 600) * 1000, last_poll: 0 });
    console.log('Open this link in the browser where you are signed in to Coach Studio:\n');
    console.log('  ' + j.verification_uri_complete + '\n');
    console.log('The page must show the code ' + j.user_code + '. Check it matches, choose the permissions, and click Allow.');
    console.log('The link works for ' + Math.round((j.expires_in || 600) / 60) + ' minutes.');
}

// One check of the device code: 'connected' | 'waiting' | 'denied' | 'expired'.
async function pollOnce(p) {
    const wait = p.last_poll + p.interval * 1000 + 500 - Date.now();
    if (wait > 0) await sleep(wait);
    const r = await post(p.server + '/oauth/token', { headers: FORM, body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: p.device_code, client_id: CLIENT_ID }).toString() });
    p.last_poll = Date.now();
    if (r.status === 200 && r.json && r.json.access_token) {
        saveCredentials(p.server, r.json);
        remove(PENDING_FILE);
        return { state: 'connected', scope: r.json.scope };
    }
    const err = r.json && r.json.error;
    if (err === 'slow_down') p.interval += 5;
    if (err === 'authorization_pending' || err === 'slow_down') { writeJson(PENDING_FILE, p); return { state: 'waiting' }; }
    remove(PENDING_FILE);
    if (err === 'access_denied') return { state: 'denied' };
    return { state: 'expired' };
}

function report(res) {
    if (res.state === 'connected') { console.log('STATUS: connected'); console.log('Permissions: ' + (res.scope || 'read:ops')); return 0; }
    if (res.state === 'denied') { console.log('STATUS: denied'); console.log('The person denied it. Nothing was connected.'); return 1; }
    if (res.state === 'expired') { console.log('STATUS: expired'); console.log('The code expired or was already used. Run `login` again.'); return 1; }
    console.log('STATUS: waiting');
    console.log('Not allowed yet. Keep waiting with `login --wait 120`, or `login --check` for one check.');
    return 2;
}

async function login() {
    if (has('--check')) {
        const p = readJson(PENDING_FILE);
        if (!p) { console.log('STATUS: expired'); console.log('No sign-in is waiting. Run `login`.'); return 1; }
        if (p.expires_at < Date.now()) { remove(PENDING_FILE); return report({ state: 'expired' }); }
        return report(await pollOnce(p));
    }
    if (has('--wait') && !value('--wait')) throw new Fail('--wait needs a number of seconds');
    const explicitWait = value('--wait');
    let p = readJson(PENDING_FILE);
    const resuming = !!explicitWait && !has('--new') && p && p.expires_at > Date.now();
    if (!resuming) { await startLogin(); p = readJson(PENDING_FILE); }
    if (has('--no-wait')) { console.log('STATUS: waiting'); console.log('Then run `login --wait 120` (or `login --check`).'); return 2; }
    const deadline = Math.min(Date.now() + (Number(explicitWait) || 120) * 1000, p.expires_at);
    for (;;) {
        const res = await pollOnce(p);
        if (res.state !== 'waiting') return report(res);
        if (Date.now() + p.interval * 1000 > deadline) return report(res);
    }
}

// ---- calling Coach Studio ----------------------------------------------------

async function refresh(c) {
    const r = await post(c.server + '/oauth/token', { headers: FORM, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: CLIENT_ID }).toString() });
    if (r.status !== 200 || !r.json || !r.json.access_token) return null;
    saveCredentials(c.server, r.json);
    return readJson(CRED_FILE);
}
async function credentials() {
    let c = readJson(CRED_FILE);
    if (!c) throw new Fail('STATUS: not connected\nRun `login` first.');
    if (c.access_exp - 60 < nowS()) {
        c = await refresh(c);
        if (!c) throw new Fail('STATUS: signed out\nThe sign-in expired or was revoked. Run `login` again.');
    }
    return c;
}
let rpcId = 0;
async function mcp(method, params) {
    let c = await credentials();
    const send = () => post(c.server + '/mcp', { headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + c.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    let r = await send();
    if (r.status === 401) {
        c = await refresh(c);
        if (!c) throw new Fail('STATUS: signed out\nThe sign-in expired or was revoked. Run `login` again.');
        r = await send();
    }
    if (r.status === 429) throw new Fail('Too many calls: wait ' + (r.headers.get('retry-after') || 30) + ' seconds and try again.');
    if (r.status !== 200 || !r.json) throw new Fail('Coach Studio answered HTTP ' + r.status + (r.json && r.json.error_description ? ': ' + r.json.error_description : ''));
    if (r.json.error) throw new Fail('Coach Studio: ' + r.json.error.message);
    return r.json.result;
}

async function status() {
    const c = await credentials();
    const tools = (await mcp('tools/list', {})).tools || [];
    console.log('STATUS: connected');
    console.log('Server: ' + new URL(c.server).host);
    console.log('Permissions: ' + (c.scope || 'read:ops'));
    console.log('Tools available: ' + tools.length);
    return 0;
}

async function tools() {
    for (const t of (await mcp('tools/list', {})).tools || []) {
        const kind = t.annotations && t.annotations.readOnlyHint ? 'read' : 'WRITE';
        console.log(`${t.name}  [${kind}]  ${String(t.description || '').split(/(?<=\.)\s/)[0].slice(0, 160)}`);
    }
    return 0;
}

function readStdin() {
    return new Promise((resolve, reject) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); process.stdin.on('error', reject); });
}

async function call() {
    const name = argv[1];
    if (!name || name.startsWith('--')) throw new Fail('Usage: call TOOL [JSON | - | --args-file FILE]');
    let raw = '{}';
    const file = value('--args-file');
    if (file) raw = fs.readFileSync(file, 'utf8');
    else if (argv[2] === '-') raw = await readStdin();
    else if (argv[2] && !argv[2].startsWith('--')) raw = argv[2];
    let args;
    try { args = JSON.parse(raw.trim() || '{}'); } catch (_) {
        throw new Fail('The arguments are not valid JSON. In PowerShell, quotes inside a command-line argument get lost: use --args-file FILE, or pipe the JSON in with `-`.');
    }
    const result = await mcp('tools/call', { name, arguments: args });
    const text = (result.content || []).map((x) => x.text || '').join('\n');
    let out = text;
    try { out = JSON.stringify(JSON.parse(text), null, 2); } catch (_) { /* plain text */ }
    console.log(out);
    return result.isError ? 1 : 0;
}

async function logout() {
    const c = readJson(CRED_FILE);
    if (c) await post(c.server + '/oauth/revoke', { headers: FORM, body: new URLSearchParams({ token: c.refresh_token }).toString() }).catch(() => null);
    remove(CRED_FILE); remove(PENDING_FILE);
    console.log('STATUS: signed out');
    return 0;
}

function help() {
    console.log(`coach-studio ${VERSION}: read and manage Erica through Coach Studio.

  login [--no-wait] [--wait SECONDS] [--check]   sign in: prints a link and a code for the person to allow
  status                                          is it connected, with which permissions
  tools                                           the tools available ([read] or [WRITE])
  call TOOL [JSON | - | --args-file FILE]         run one tool; JSON on the command line, from a file, or from stdin (-)
  logout                                          revoke this sign-in and forget it

Lines starting with "STATUS:" say where things stand: connected, waiting, denied, expired, signed out, not connected.`);
    return 0;
}

try {
    const handlers = { login, status, tools, call, logout, help, '--help': help, '-h': help, '--version': () => { console.log(VERSION); return 0; } };
    const run = handlers[cmd || 'help'];
    if (!run) throw new Fail('Unknown command: ' + cmd + '. Run `help`.');
    process.exitCode = await run();
} catch (e) {
    console.error(e instanceof Fail ? e.message : 'Unexpected error: ' + (e && e.stack || e));
    process.exitCode = e instanceof Fail ? e.exitCode : 1;
}
