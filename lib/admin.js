/*
 * Coach Studio admin — Phase 0 foundation.
 *
 * Auth pattern copied from the daily-report project: single-password gate +
 * signed HTTP-only cookie. Simple, correct, no dependencies.
 *
 *   ADMIN_PASSWORD   shared secret the operator types on /admin/login
 *   SESSION_SECRET   HMAC key used to sign the session cookie payload
 *
 * Cookie is `admin_session=<base64url(payload)>.<base64url(HMAC)>` with the
 * payload `{ sub: 'admin', iat, exp }`. Verified on every /admin/* request.
 * 4h TTL; expired cookies redirect to /admin/login.
 */

const crypto = require('crypto');
const sessionLog = require('./sessionLog');
const activity = require('./activity');
const vectorStore = require('./vectorStore');
const contentStore = require('./contentStore');
const coursesStore = require('./coursesStore');
const quizzesStore = require('./quizzesStore');
const auditLog = require('./audit');
const metrics = require('./metrics');
const runtimeConfig = require('./runtimeConfig');
const promptBudget = require('./promptBudget');
const sessionBookmarks = require('./sessionBookmarks');

const COOKIE_NAME = 'admin_session';
const TTL_SECONDS = 4 * 60 * 60; // 4h

function b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

function signSession(payload) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET not configured');
    const body = b64urlEncode(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', secret).update(body).digest();
    return body + '.' + b64urlEncode(mac);
}

function verifySession(cookieVal) {
    if (!cookieVal || typeof cookieVal !== 'string') return null;
    const secret = process.env.SESSION_SECRET;
    if (!secret) return null;
    const dot = cookieVal.indexOf('.');
    if (dot < 0) return null;
    const body = cookieVal.slice(0, dot);
    const macIn = cookieVal.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    let received;
    try { received = b64urlDecode(macIn); } catch (_) { return null; }
    if (received.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(received, expected)) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); } catch (_) { return null; }
    if (!payload || payload.sub !== 'admin') return null;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return null;
    return payload;
}

function parseCookie(header) {
    const out = {};
    (header || '').split(/;\s*/).forEach((kv) => {
        const eq = kv.indexOf('=');
        if (eq < 0) return;
        out[kv.slice(0, eq).trim()] = decodeURIComponent(kv.slice(eq + 1).trim());
    });
    return out;
}

function makeSessionCookie() {
    const iat = Math.floor(Date.now() / 1000);
    const value = signSession({ sub: 'admin', iat, exp: iat + TTL_SECONDS });
    // Secure only on https (Railway serves https). HttpOnly so JS can't read
    // it. SameSite=Lax so login POST from /admin/login works but external
    // sites can't forge navigations while carrying the cookie.
    return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}
function clearSessionCookie() {
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// SVG favicon matching the "CS" brand mark (teal→blue gradient rounded square,
// white "CS" text). Data URI so no separate request + no CSP issue.
// %23 is URL-encoded "#" — safe inside an SVG data URI's utf8 payload.
const FAVICON_HREF = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%230d9488'/><stop offset='1' stop-color='%233987e5'/></linearGradient></defs><rect width='32' height='32' rx='7' fill='url(%23g)'/><text x='16' y='22' font-family='system-ui,sans-serif' font-size='15' font-weight='700' fill='white' text-anchor='middle' letter-spacing='-1'>CS</text></svg>";

function loginPage({ error } = {}) {
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Coach Studio — Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gray-50 flex items-center justify-center p-4">
  <form method="POST" action="/admin/login" class="w-full max-w-sm bg-white rounded-2xl shadow-sm p-6 space-y-4 border border-gray-200">
    <div>
      <div class="text-lg font-semibold text-gray-900">Coach Studio</div>
      <div class="text-xs text-gray-500 mt-1">Admin login</div>
    </div>
    <label class="block">
      <span class="text-sm text-gray-700">Password</span>
      <input type="password" name="password" autofocus required class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-teal-400 focus:border-teal-400">
    </label>
    ${error ? `<div class="text-sm text-red-600">${error}</div>` : ''}
    <button type="submit" class="w-full bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg py-2">Sign in</button>
  </form>
</body></html>`;
}

// ---- Observatory pages -------------------------------------------------

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shellChrome(title, body) {
    // 2-column layout adapted from daily-report/src/public/dashboard.html.
    // Left column = the Studio agent (persistent, page-aware co-worker).
    // Right column = the current route's content. All routes share this shell.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Coach Studio</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
<!-- Tailwind kept transitionally so existing page bodies still render while
     we refactor them page-by-page to the palette below. New surfaces should
     use the palette classes (.painel, .cards, .grafico, etc.). -->
<script src="https://cdn.tailwindcss.com"></script>
<style>
  /* Palette from daily-report (validated light+dark+CVD), extended with
     depth + accent gradient for the studio surface. */
  :root { color-scheme: light dark;
    --bg:#f6f5f1; --card:#ffffff; --soft:#efeee8;
    --ink:#0b0b0b; --ink2:#4a4946; --muted:#8b8983;
    --line:#e4e2da; --axis:#c3c2b7; --ring:rgba(11,11,11,.08); --ring-hi:rgba(11,11,11,.14);
    --s1:#0d9488; --s2:#eb6834; --s3:#3987e5;
    --accent:#0d9488; --accent-hi:#14b8a6; --accent-tint:rgba(13,148,136,.09);
    --good:#0ca30c; --good-text:#006300; --warn:#f59e0b; --crit:#d03b3b;
    --grad: linear-gradient(135deg, var(--s1) 0%, var(--s3) 100%);
    --grad-warm: linear-gradient(135deg, var(--s2) 0%, #f59e0b 100%);
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0b0b0b; --card:#171716; --soft:#1f1f1d;
    --ink:#f7f7f4; --ink2:#c3c2b7; --muted:#8b8983;
    --line:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,.06); --ring-hi:rgba(255,255,255,.12);
    --s1:#14b8a6; --s2:#d95926; --s3:#5b9be8;
    --accent:#14b8a6; --accent-hi:#2dd4bf; --accent-tint:rgba(20,184,166,.14);
    --good:#22c55e; --good-text:#22c55e; --warn:#fab219; --crit:#f87171; } }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; }
  body { height:100vh; overflow:hidden; background:var(--bg); color:var(--ink);
    font:400 15px/1.55 "Inter",-apple-system,"Segoe UI",Roboto,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  a { color: var(--accent); text-decoration: none; transition: color .12s ease; }
  a:hover { color: var(--accent-hi); text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 2px; }
  code, pre { font: 400 12.5px/1.5 "JetBrains Mono",ui-monospace,Consolas,monospace; }
  h1,h2,h3,h4 { letter-spacing:-.015em; }
  .layout { display:grid; grid-template-columns: minmax(340px, 34%) 1fr; height:100vh; position:relative; }
  @media (max-width:900px) { body { overflow:auto; height:auto; } .layout { grid-template-columns: 1fr; height:auto; } }

  /* -- agent panel -- */
  .agente { display:flex; flex-direction:column; border-right:1px solid var(--line);
    background: linear-gradient(180deg, var(--card) 0%, var(--card) 60%, var(--soft) 100%);
    min-height:0; position:relative; }
  .agente::before { content:""; position:absolute; top:0; left:0; right:0; height:2px; background:var(--grad); opacity:.9; }
  .agente header { padding:16px 18px 14px; border-bottom:1px solid var(--line);
    display:flex; align-items:center; gap:11px; }
  .brand { width:32px; height:32px; border-radius:9px; background:var(--grad);
    display:flex; align-items:center; justify-content:center; color:#fff; font-weight:700;
    font-size:15px; letter-spacing:-.02em; box-shadow:0 4px 12px -3px var(--accent-tint), 0 1px 3px var(--ring); flex:none; }
  .agente header .who { display:flex; flex-direction:column; line-height:1.25; }
  .agente header h1 { font-size:14.5px; margin:0; font-weight:650; }
  .agente header .who small { font-size:11.5px; color:var(--muted); letter-spacing:.01em; }
  .status-dot { width:7px; height:7px; border-radius:50%; background:var(--good); margin-left:auto; box-shadow:0 0 0 3px rgba(12,163,12,.15); }
  .chat { flex:1; overflow-y:auto; padding:16px 18px; display:flex; flex-direction:column; gap:14px; min-height:240px;
    scrollbar-width:thin; scrollbar-color: var(--line) transparent; }
  .chat::-webkit-scrollbar { width:8px; }
  .chat::-webkit-scrollbar-thumb { background: var(--line); border-radius:4px; }
  .msg { max-width:92%; animation:msgIn .18s ease-out; }
  @keyframes msgIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  .msg.user { align-self:flex-end; background:var(--grad); color:#fff; padding:10px 14px;
    border-radius:16px 16px 4px 16px; font-size:14.5px; box-shadow:0 2px 8px -2px var(--accent-tint); }
  .msg.assistant { align-self:flex-start; width:100%; }
  .msg.assistant .corpo { white-space:pre-wrap; font-size:14.5px; }
  .msg.erro { color:var(--crit); font-size:14px; padding:8px 12px; background:rgba(208,59,59,.08); border-radius:8px; }
  .tarefas { list-style:none; margin:0 0 8px; padding:0; font-size:12.5px; }
  .tarefas li { display:flex; align-items:baseline; gap:8px; padding:3px 0; color:var(--ink2); transition: opacity .2s; }
  .tarefas li.done { color:var(--muted); }
  .tarefas li.error { color:var(--crit); }
  .tarefas li em { font-style:normal; color:var(--muted); font-size:11.5px; margin-left:auto; padding-left:10px; white-space:nowrap; }
  .tarefas .marca { color:var(--good); font-weight:700; width:12px; flex:none; }
  .tarefas .marca.falhou { color:var(--crit); }
  .tarefas .giro { width:10px; height:10px; flex:none; border-radius:50%; align-self:center;
    border:1.5px solid var(--line); border-top-color:var(--accent); animation:gira .7s linear infinite; }
  @keyframes gira { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .tarefas .giro { animation-duration: 2.4s; } .msg { animation:none; } }
  .passos { margin-top:8px; font-size:12px; color:var(--muted); }
  .passos summary { cursor:pointer; opacity:.7; list-style:none; }
  .passos summary::before { content:"▸ "; }
  .passos[open] summary::before { content:"▾ "; }
  .passos > div { border-left:2px solid var(--line); padding-left:10px; margin-top:6px; }
  .sugestoes { display:flex; flex-wrap:wrap; gap:7px; margin-top:12px; }
  .sugestoes button { font:inherit; font-size:13px; line-height:1.35; text-align:left;
    padding:7px 12px; color:var(--accent); background:var(--card);
    border:1px solid var(--line); border-radius:16px; cursor:pointer;
    transition: all .15s ease; box-shadow: 0 1px 2px var(--ring); }
  .sugestoes button:hover { border-color:var(--accent); background:var(--accent-tint); transform:translateY(-1px); box-shadow:0 3px 8px -2px var(--ring-hi); }
  .vazio { color:var(--muted); font-size:14px; padding:8px 0; }
  .vazio p { margin:0 0 12px; color:var(--ink2); }
  .vazio ul { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:6px; }
  .vazio li { margin:0; }
  .vazio button { background:var(--card); border:1px solid var(--line); border-radius:10px;
    color:var(--ink); font:inherit; font-size:13.5px; text-align:left; padding:10px 13px;
    cursor:pointer; width:100%; transition: all .15s ease; box-shadow:0 1px 2px var(--ring); }
  .vazio button:hover { border-color:var(--accent); background:var(--accent-tint); transform:translateY(-1px); box-shadow:0 3px 8px -2px var(--ring-hi); }
  .composer { border-top:1px solid var(--line); padding:12px 14px 14px; display:flex; gap:8px; align-items:flex-end;
    background: var(--card); }
  .composer textarea { flex:1; resize:none; font:inherit; font-size:14.5px; color:var(--ink); background:var(--bg);
    border:1px solid var(--line); border-radius:10px; padding:10px 12px; max-height:140px;
    transition: border-color .15s ease, box-shadow .15s ease; }
  .composer textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-tint); }
  .icone { width:38px; height:38px; flex:none; border:1px solid var(--line); border-radius:10px;
    background:var(--card); color:var(--ink2); cursor:pointer; font-size:15px; line-height:1;
    transition: all .15s ease; display:flex; align-items:center; justify-content:center; }
  .icone:hover { color:var(--ink); border-color:var(--ink2); }
  .enviar { background:var(--grad); color:#fff; border-color:transparent; font-weight:700;
    box-shadow:0 3px 10px -2px var(--accent-tint); }
  .enviar:hover { filter:brightness(1.06); color:#fff; transform:translateY(-1px); }

  /* -- content panel -- */
  .relatorio { overflow-y:auto; padding:22px 28px 60px; min-height:0;
    scrollbar-width:thin; scrollbar-color: var(--line) transparent; }
  .relatorio::-webkit-scrollbar { width:10px; }
  .relatorio::-webkit-scrollbar-thumb { background: var(--line); border-radius:5px; }
  .topo { display:flex; flex-wrap:wrap; gap:14px; align-items:center; justify-content:space-between;
    margin-bottom:22px; padding-bottom:14px; border-bottom:1px solid var(--line); }
  .topo h2 { font-size:17px; margin:0; }
  .topo nav { display:flex; gap:4px; font-size:13.5px; align-items:center; }
  .topo nav a { color:var(--ink2); padding:6px 12px; border-radius:8px; font-weight:500;
    transition: all .12s ease; text-decoration:none; }
  .topo nav a:hover { color:var(--ink); background:var(--soft); text-decoration:none; }
  .topo nav a.active { color:var(--accent); background:var(--accent-tint); font-weight:600; }
  .topo nav .nav-sep { color:var(--line); font-weight:400; margin:0 2px; }
  .topo nav .nav-group { position:relative; color:var(--ink2); padding:6px 12px; border-radius:8px;
    font-weight:500; cursor:default; user-select:none; }
  .topo nav .nav-group:hover, .topo nav .nav-group:focus-within { color:var(--ink); background:var(--soft); }
  .topo nav .nav-group.active-group { color:var(--accent); background:var(--accent-tint); font-weight:600; }
  .topo nav .nav-group .nav-menu { display:none; position:absolute; top:100%; left:0; z-index:20;
    background:var(--card); border:1px solid var(--line); border-radius:10px;
    box-shadow:0 8px 24px -6px var(--ring); padding:6px; min-width:150px; margin-top:4px; }
  .topo nav .nav-group:hover .nav-menu, .topo nav .nav-group:focus-within .nav-menu { display:flex; flex-direction:column; }
  .topo nav .nav-menu a { padding:6px 10px; font-size:13px; }
  .topo .acoes { display:flex; gap:8px; align-items:center; }
  .botao { font:inherit; font-size:13px; padding:7px 12px; color:var(--ink2); background:var(--card);
    border:1px solid var(--line); border-radius:8px; cursor:pointer; text-decoration:none;
    display:inline-block; transition: all .12s ease; }
  .botao:hover { color:var(--ink); border-color:var(--ink2); text-decoration:none; }

  /* -- cards / tiles -- */
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:14px; margin-bottom:22px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px;
    box-shadow:0 1px 3px var(--ring); display:flex; flex-direction:column; gap:4px;
    transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; position:relative; overflow:hidden; }
  .card:hover { transform:translateY(-2px); box-shadow:0 6px 20px -6px var(--ring-hi); border-color:var(--ring-hi); }
  .card .rot { font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--muted);
    display:flex; align-items:center; gap:6px; }
  .card .rot .ico { width:14px; height:14px; display:inline-block; color:var(--accent); opacity:.8; }
  .card .val { font-size:30px; font-weight:700; letter-spacing:-.025em; line-height:1.1; margin-top:2px; }
  .card .var { font-size:12.5px; color:var(--muted); }
  .card.hero { grid-column: span 2; background: linear-gradient(135deg, var(--card) 0%, var(--accent-tint) 100%);
    border-color: transparent; box-shadow:0 4px 20px -8px var(--accent-tint), 0 1px 3px var(--ring); }
  .card.hero::after { content:""; position:absolute; top:-40%; right:-20%; width:200px; height:200px;
    background: radial-gradient(closest-side, var(--accent) 0%, transparent 70%); opacity:.14; pointer-events:none; }
  .card.hero .val { font-size:38px; }
  .card.warn { border-left:3px solid var(--warn); }
  .card.crit { border-left:3px solid var(--crit); }
  @media (max-width:900px) { .card.hero { grid-column: span 1; } }

  .grafico { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:16px 18px 12px; box-shadow:0 1px 3px var(--ring); min-width:0; }
  .grafico h3 { font-size:13px; margin:0 0 6px; font-weight:650; }
  .grafico svg { display:block; overflow:visible; max-width:100%; }
  .painel { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:16px 18px; box-shadow:0 1px 3px var(--ring); margin-bottom:16px; }
  .painel > h3 { font-size:13px; margin:0 0 12px; font-weight:650; display:flex; align-items:center; gap:8px;
    color:var(--ink); text-transform:uppercase; letter-spacing:.05em; font-size:11.5px; }
  .painel > h3::before { content:""; width:3px; height:12px; background:var(--accent); border-radius:2px; }
  .painel .foot { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); font-size:13px; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; }
  th, td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--line); }
  tr:last-child td { border-bottom:0; }
  tbody tr { transition: background .1s ease; }
  tbody tr:hover { background: var(--soft); }
  th { font-weight:600; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  td { color:var(--ink2); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  input, textarea, select { font:inherit; color:var(--ink); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:7px 10px;
    transition: border-color .15s ease, box-shadow .15s ease; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-tint); }
  .titulo { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:16px; gap:12px; flex-wrap:wrap; }
  .titulo h2 { font-size:20px; margin:0; font-weight:650; letter-spacing:-.02em; }
  .titulo .meta { font-size:12.5px; color:var(--muted); }
  /* Floating marker button: appears near a text selection in the right pane. */
  #marcar { position:fixed; z-index:40; display:none; font:600 12px/1 inherit;
    padding:7px 11px; color:#fff; background:var(--accent); border:0; border-radius:6px;
    cursor:pointer; box-shadow:0 2px 8px var(--ring); }
  #marcar:hover { filter: brightness(1.08); }
  /* Attached marker strip above composer. */
  .marcador { margin:0 12px; padding:8px 11px; background:var(--soft);
    border-left:3px solid var(--accent); border-radius:0 6px 6px 0; font-size:13px;
    display:flex; gap:8px; align-items:flex-start; }
  .marcador .rot { font-weight:600; color:var(--accent); flex:none; font-size:11px;
    text-transform:uppercase; letter-spacing:.05em; padding-top:2px; }
  .marcador .txt { flex:1; color:var(--ink2); overflow:hidden; text-overflow:ellipsis;
    display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
  .marcador .x { flex:none; background:none; border:0; color:var(--muted); cursor:pointer;
    font-size:15px; line-height:1; padding:0 2px; }
  .marcador .x:hover { color:var(--crit); }
  .retomada { align-self:center; font-size:11px; color:var(--muted); letter-spacing:.04em; margin:10px 0; }
  /* Pasted-image strip above the composer. */
  .anexos { display:flex; gap:8px; padding:6px 12px 0; flex-wrap:wrap; }
  .anexos .thumb { position:relative; width:52px; height:52px; border-radius:6px; overflow:hidden;
    border:1px solid var(--line); background:var(--soft); flex:none; }
  .anexos .thumb img { width:100%; height:100%; object-fit:cover; display:block; cursor:zoom-in; }
  .anexos .thumb button.x { position:absolute; top:2px; right:2px; width:18px; height:18px; border-radius:50%;
    background:rgba(0,0,0,.55); color:#fff; border:0; font-size:12px; line-height:1; padding:0; cursor:pointer; }
  .anexos .thumb button.edit { position:absolute; bottom:2px; right:2px; padding:1px 5px; font-size:10px;
    border-radius:4px; background:rgba(0,0,0,.7); color:#fff; border:0; cursor:pointer; }
  .anexos .status { align-self:center; font-size:12px; color:var(--muted); }

  /* Marker + thumbnail strip INSIDE a sent user bubble. */
  .msg.user .marca-turno { background:rgba(255,255,255,.18); padding:5px 9px; border-radius:8px;
    margin-bottom:6px; font-size:12px; display:flex; gap:6px; align-items:baseline; }
  .msg.user .marca-turno .rot { font-size:10px; font-weight:700; letter-spacing:.06em; opacity:.85; flex:none; }
  .msg.user .marca-turno .txt { opacity:.95; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .msg.user .imgs-turno { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:6px; }
  .msg.user .imgs-turno img { max-width:170px; max-height:130px; border-radius:6px; border:1px solid rgba(255,255,255,.35); cursor:zoom-in; display:block; }

  /* Lightbox: click any bubble/attachment thumb to view full size. */
  #lupa { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.78); display:none;
    align-items:center; justify-content:center; padding:24px; cursor:zoom-out; }
  #lupa.aberta { display:flex; }
  #lupa img { max-width:100%; max-height:100%; border-radius:8px; box-shadow:0 20px 60px rgba(0,0,0,.4); }

  /* Image annotation editor: fullscreen modal, canvas with pen tool. */
  #editor { position:fixed; inset:0; z-index:70; background:rgba(0,0,0,.82); display:none;
    align-items:center; justify-content:center; padding:22px; }
  #editor.aberto { display:flex; }
  #editor .caixa { background:var(--card); border:1px solid var(--line); border-radius:12px;
    padding:12px; max-width:96vw; max-height:94vh; display:flex; flex-direction:column; gap:10px; }
  #editor .tela { position:relative; overflow:auto; background:#fff; border-radius:8px; }
  #editor canvas { display:block; touch-action:none; cursor:crosshair; }
  #editor .barra { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  #editor .barra button { font:inherit; font-size:13px; padding:5px 11px; border-radius:7px;
    border:1px solid var(--line); background:var(--bg); color:var(--ink); cursor:pointer; }
  #editor .barra button.principal { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  #editor .barra .cor { width:22px; height:22px; border-radius:50%; border:2px solid transparent; cursor:pointer; padding:0; }
  #editor .barra .cor[aria-pressed="true"] { border-color:var(--ink); }
  #editor .barra .espaco { flex:1; }
  #editor .dica { font-size:12px; color:var(--muted); }

  /* Draggable divider — absolutely positioned so it lives ON TOP of the
     grid boundary without becoming a grid item and pushing content around. */
  #splitter { position:absolute; top:0; bottom:0; width:8px; margin-left:-4px;
    cursor:col-resize; background:transparent; z-index:20; }
  #splitter::after { content:""; position:absolute; left:3px; right:3px; top:0; bottom:0;
    background:var(--line); transition:background .12s ease; border-radius:1px; }
  #splitter:hover::after, #splitter.dragging::after { background:var(--accent); }
  @media (max-width:900px) { #splitter { display:none; } }
</style>
</head>
<body>
<div class="layout">
  <section class="agente">
    <header>
      <div class="brand" aria-hidden="true">CS</div>
      <div class="who"><h1>Coach Studio</h1><small>your co-worker · reads the logs first</small></div>
      <span class="status-dot" title="Live"></span>
    </header>
    <div class="chat" id="chat">
      <div class="vazio" id="vazio">
        <p>Ask about sessions, personas, quality signals — I read the data before answering.</p>
        <ul>
          <li><button data-p="What sessions happened today?">🗓 What happened today?</button></li>
          <li><button data-p="Which tool is Erica calling the most, and are any of them failing?">🔧 Which tools are firing (or failing)?</button></li>
          <li><button data-p="Show me the persona for Supportive.">🎭 Show me the Supportive persona</button></li>
          <li><button data-p="What is user willian.jorge.machado@gmail.com doing on the platform?">👤 Lookup Willian's activity</button></li>
        </ul>
      </div>
    </div>
    <div class="composer">
      <textarea id="composerText" rows="1" placeholder="Ask about this page or anything else…"></textarea>
      <button class="icone" id="composerClear" title="Clear conversation">✕</button>
      <button class="icone enviar" id="composerSend" title="Send (Enter)">↑</button>
    </div>
  </section>
  <div id="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panels" title="Drag to resize"></div>
  <button id="marcar" title="Ask agent about this">Ask agent about this →</button>
  <div id="lupa"><img alt="Attached image"></div>
  <div id="editor" role="dialog" aria-label="Mark on the image" aria-modal="true">
    <div class="caixa">
      <div class="barra">
        <button class="cor" data-cor="#e11d48" style="background:#e11d48" aria-pressed="true" title="Red"></button>
        <button class="cor" data-cor="#2a78d6" style="background:#2a78d6" aria-pressed="false" title="Blue"></button>
        <button class="cor" data-cor="#111111" style="background:#111111" aria-pressed="false" title="Black"></button>
        <span class="dica">Draw on what you want to point at</span>
        <span class="espaco"></span>
        <button id="editorDesfazer" type="button">Undo</button>
        <button id="editorLimpar" type="button">Clear</button>
        <button id="editorCancelar" type="button">Cancel</button>
        <button id="editorSalvar" class="principal" type="button">Done</button>
      </div>
      <div class="tela"><canvas id="telaEditor"></canvas></div>
    </div>
  </div>
  <section class="relatorio">
    <div class="topo">
      <nav data-title="${escapeHtml(title)}">
        <a href="/admin/" data-match="Home">Home</a>
        <span class="nav-sep">·</span>
        <a href="/admin/semantic-store" data-match="Semantic Store,Course,Quiz">Semantic Store</a>
        <a href="/admin/injected-data" data-match="Injected Data,Persona">Injected Data</a>
        <a href="/admin/realtime" data-match="Real Time">Real Time</a>
        <a href="/admin/simulator" data-match="Simulator">Simulator</a>
        <span class="nav-sep">·</span>
        <span class="nav-group" tabindex="0" data-match="Sessions,Session ,User lookup,User ,Metrics,Audit">
          Observatory ▾
          <div class="nav-menu">
            <a href="/admin/sessions" data-match="Sessions,Session ">Sessions</a>
            <a href="/admin/users" data-match="User lookup,User ">Users</a>
            <a href="/admin/metrics" data-match="Metrics">Metrics</a>
            <a href="/admin/audit" data-match="Audit">Audit</a>
          </div>
        </span>
      </nav>
      <div class="acoes">
        <form method="POST" action="/admin/logout"><button class="botao">Sign out</button></form>
      </div>
    </div>
    <div id="page-body"><!--PAGE-BODY-START-->
${body}
<!--PAGE-BODY-END--></div>
  </section>
</div>
<script>
  (function () {
    // ---- Mark active nav based on current page title ----
    function markActiveNav(title) {
      const nav = document.querySelector('.topo nav');
      if (!nav) return;
      nav.dataset.title = title || '';
      // Both real <a> links AND the .nav-group span (Observatory ▾) may carry
      // a comma-separated data-match. The span uses .active-group so its own
      // CSS treats it differently from a hovered link.
      nav.querySelectorAll('[data-match]').forEach((el) => {
        const matches = String(el.dataset.match || '').split(',').map(s => s.trim()).filter(Boolean);
        const t = title || '';
        const hit = matches.some((m) => t.startsWith(m));
        if (el.tagName === 'A') {
          el.classList.toggle('active', hit);
        } else {
          el.classList.toggle('active-group', hit);
        }
      });
    }
    try { markActiveNav(document.querySelector('.topo nav')?.dataset.title || ''); } catch (_) {}

    // ---- AJAX right-pane navigation ----
    // Left agent panel is persistent. Nav clicks fetch the new page as a
    // fragment (X-Fragment: 1 -> server returns only the inner body-content
    // with X-Page-Title header) and swap #page-body in place. The agent's
    // SSE stream and pending attachments survive because nothing on the left
    // is touched. History API keeps URLs honest.
    async function loadFragment(href, pushHistory) {
      const container = document.getElementById('page-body');
      if (!container) { location.href = href; return; }
      container.style.opacity = '0.55';
      try {
        const r = await fetch(href, { credentials: 'include', headers: { 'X-Fragment': '1' } });
        if (!r.ok && r.status !== 404) {
          // 401 or 5xx: hard-nav so login redirect / real error surface properly
          location.href = href; return;
        }
        const html = await r.text();
        const title = r.headers.get('X-Page-Title') || '';
        // Extract inline scripts so they actually run after innerHTML swap
        // (innerHTML does not execute scripts).
        const tmp = document.createElement('template');
        tmp.innerHTML = html;
        const scripts = Array.from(tmp.content.querySelectorAll('script'));
        scripts.forEach((s) => s.remove());
        container.innerHTML = tmp.innerHTML;
        // Re-run inline scripts in order.
        for (const s of scripts) {
          const clone = document.createElement('script');
          Array.from(s.attributes).forEach((a) => clone.setAttribute(a.name, a.value));
          clone.textContent = s.textContent;
          container.appendChild(clone);
        }
        document.title = (title ? title + ' — ' : '') + 'Coach Studio';
        markActiveNav(title);
        if (pushHistory) history.pushState({ href }, '', href);
        container.scrollTop = 0;
      } catch (err) {
        // Network fail: fall back to full nav.
        location.href = href;
      } finally {
        container.style.opacity = '';
      }
    }

    // Delegated click handler on nav + any internal /admin/ anchor.
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const href = a.getAttribute('href') || '';
      // Only same-origin /admin/* GET links, and never external target=_blank / download.
      if (!href.startsWith('/admin')) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      // File-download exports still need real navigation.
      if (a.getAttribute('href').startsWith('/api/')) return;
      e.preventDefault();
      loadFragment(href, true);
    });
    window.addEventListener('popstate', () => { loadFragment(location.pathname + location.search, false); });
    const chat = document.getElementById('chat');
    const vazio = document.getElementById('vazio');
    const ta = document.getElementById('composerText');
    const send = document.getElementById('composerSend');
    const clearBtn = document.getElementById('composerClear');
    const marcarBtn = document.getElementById('marcar');
    // NOTE: history lives on the server (see /api/admin/agent/history).
    // Client never assembles the context array — it just posts messages.
    let currentMarker = null; // { text, source: url, type }
    let pendingAttachments = []; // [{ id, contentType, dataUrl (preview only) }]

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    // Parse fenced code blocks (chart / table) from the done text and
    // render them inline. Caps: 3 charts + 3 tables per answer.
    function renderRichBlocks(wrap, bodyEl) {
      const raw = bodyEl.textContent || '';
      const re = /\`\`\`(chart|table)\\n([\\s\\S]*?)\\n\`\`\`/g;
      const found = [];
      let m; let stripped = raw;
      while ((m = re.exec(raw)) !== null) {
        try {
          const spec = JSON.parse(m[2]);
          found.push({ kind: m[1], spec });
        } catch (_) { /* skip malformed block */ }
      }
      if (found.length === 0) return;
      // Remove all matched fenced blocks from the prose display.
      stripped = raw.replace(re, '').replace(/\\n{3,}/g, '\\n\\n').trim();
      bodyEl.textContent = stripped;
      const charts = found.filter((f) => f.kind === 'chart').slice(0, 3);
      const tables = found.filter((f) => f.kind === 'table').slice(0, 3);
      charts.forEach((c) => wrap.appendChild(buildChart(c.spec)));
      tables.forEach((t) => wrap.appendChild(buildTable(t.spec)));
    }
    function buildChart(spec) {
      const box = el('div', 'grafico-analista');
      if (spec.title) { const cap = el('figcaption'); cap.textContent = spec.title; box.appendChild(cap); }
      const svgNS = 'http://www.w3.org/2000/svg';
      const W = 340, H = 160, padL = 34, padR = 12, padT = 8, padB = 28;
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(H));
      const labels = Array.isArray(spec.xAxis) ? spec.xAxis : [];
      const series = Array.isArray(spec.series) ? spec.series.slice(0, 4) : [];
      // PADROES 2.18: null / '' / undefined MUST NOT become 0 — that would
      // draw a false dip. Recuse the missing point at read time.
      function safeNum(v) {
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      const allValues = series.flatMap((s) => (s.values || []).map(safeNum).filter((v) => v != null));
      if (allValues.length === 0) {
        // No usable data — degrade gracefully instead of drawing a flat line at 0.
        const cap = el('div');
        cap.style.fontSize = '11px'; cap.style.color = 'var(--muted)'; cap.style.padding = '6px 0';
        cap.textContent = '(chart omitted: no numeric data)';
        box.appendChild(cap);
        return box;
      }
      const max = Math.max(1, ...allValues);
      const bandW = (W - padL - padR) / Math.max(1, labels.length);
      const innerH = H - padT - padB;
      const colors = ['#0d9488', '#eb6834', '#3987e5', '#fab219'];
      // Baseline
      const base = document.createElementNS(svgNS, 'line');
      base.setAttribute('x1', padL); base.setAttribute('y1', padT + innerH);
      base.setAttribute('x2', W - padR); base.setAttribute('y2', padT + innerH);
      base.setAttribute('stroke', 'var(--axis)');
      svg.appendChild(base);
      if (spec.type === 'line') {
        series.forEach((s, si) => {
          // Group contiguous defined points into segments; a null breaks the line.
          const segments = [];
          let cur = [];
          (s.values || []).forEach((raw, i) => {
            const v = safeNum(raw);
            if (v == null) { if (cur.length) { segments.push(cur); cur = []; } return; }
            const x = padL + i * bandW + bandW / 2;
            const y = padT + innerH - (v / max) * innerH;
            cur.push(x + ',' + y);
          });
          if (cur.length) segments.push(cur);
          segments.forEach((seg) => {
            const poly = document.createElementNS(svgNS, 'polyline');
            poly.setAttribute('points', seg.join(' '));
            poly.setAttribute('fill', 'none');
            poly.setAttribute('stroke', colors[si % colors.length]);
            poly.setAttribute('stroke-width', '2');
            svg.appendChild(poly);
          });
        });
      } else {
        series.forEach((s, si) => {
          const barW = bandW / series.length * 0.7;
          (s.values || []).forEach((raw, i) => {
            const v = safeNum(raw);
            if (v == null) return; // no bar drawn — do not fake a zero
            const h = (v / max) * innerH;
            const x = padL + i * bandW + (bandW - barW * series.length) / 2 + si * barW;
            const y = padT + innerH - h;
            const rect = document.createElementNS(svgNS, 'rect');
            rect.setAttribute('x', x); rect.setAttribute('y', y);
            rect.setAttribute('width', Math.max(2, barW - 1));
            rect.setAttribute('height', Math.max(1, h));
            rect.setAttribute('fill', colors[si % colors.length]);
            rect.setAttribute('rx', '2');
            svg.appendChild(rect);
          });
        });
      }
      labels.forEach((lb, i) => {
        const t = document.createElementNS(svgNS, 'text');
        t.setAttribute('x', padL + i * bandW + bandW / 2);
        t.setAttribute('y', padT + innerH + 14);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'eixo');
        t.textContent = String(lb).slice(0, 12);
        svg.appendChild(t);
      });
      box.appendChild(svg);
      if (series.length > 1) {
        const leg = el('div', 'legenda-analista');
        series.forEach((s, si) => {
          const item = el('span');
          const dot = el('i'); dot.style.background = colors[si % colors.length]; dot.style.display = 'inline-block'; dot.style.width = '9px'; dot.style.height = '9px'; dot.style.borderRadius = '2px'; dot.style.marginRight = '4px';
          item.appendChild(dot); item.appendChild(document.createTextNode(s.name || 'series ' + (si + 1)));
          leg.appendChild(item);
        });
        box.appendChild(leg);
      }
      return box;
    }
    async function renderSuggestions(wrap) {
      try {
        const r = await fetch('/api/admin/agent/suggestions', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await r.json();
        const items = (data.suggestions || []).slice(0, 3);
        if (items.length === 0) return;
        const box = el('div', 'sugestoes');
        items.forEach((s) => {
          const b = el('button', null, s);
          b.addEventListener('click', () => { ask(s); box.remove(); });
          box.appendChild(b);
        });
        wrap.appendChild(box);
      } catch (_) { /* non-fatal */ }
    }
    function buildTable(spec) {
      const box = el('div', 'tabela-analista');
      if (spec.title) { const cap = el('figcaption'); cap.textContent = spec.title; box.appendChild(cap); }
      const roll = el('div', 'rolagem');
      const tbl = el('table');
      const thead = el('thead'); const trh = el('tr');
      (spec.headers || []).slice(0, 8).forEach((h) => { const th = el('th', null, h); trh.appendChild(th); });
      thead.appendChild(trh); tbl.appendChild(thead);
      const tbody = el('tbody');
      (spec.rows || []).slice(0, 30).forEach((r) => {
        const tr = el('tr');
        (r || []).slice(0, 8).forEach((cell, ci) => {
          const td = el('td', /^-?\\d+(\\.\\d+)?$/.test(String(cell)) ? 'num' : null, cell == null ? '' : String(cell));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      roll.appendChild(tbl);
      box.appendChild(roll);
      return box;
    }
    function scrollBottom() { chat.scrollTop = chat.scrollHeight; }
    function appendUser(text, extras) {
      if (vazio && vazio.parentElement) vazio.remove();
      const w = el('div', 'msg user');
      // Marker strip (if any): compact quoted block above the text so the
      // reader knows what context was included with this turn.
      if (extras && extras.marker && extras.marker.text) {
        const m = el('div', 'marca-turno');
        const rot = el('span', 'rot', (extras.marker.type || 'text').toUpperCase());
        const txt = el('span', 'txt', extras.marker.text.slice(0, 220));
        m.appendChild(rot); m.appendChild(txt);
        w.appendChild(m);
      }
      // Attachment thumbnails (if any). Click a thumb to open in lightbox.
      if (extras && Array.isArray(extras.attachmentIds) && extras.attachmentIds.length) {
        const strip = el('div', 'imgs-turno');
        extras.attachmentIds.forEach((id) => {
          const img = document.createElement('img');
          img.src = '/api/admin/attachments/' + encodeURIComponent(id);
          img.alt = 'Attached image';
          img.dataset.zoom = '1';
          strip.appendChild(img);
        });
        w.appendChild(strip);
      }
      const body = el('div');
      body.textContent = text;
      w.appendChild(body);
      chat.appendChild(w); scrollBottom();
    }
    function appendAssistant(text, meta) {
      const w = el('div', 'msg assistant');
      const body = el('div', 'corpo'); body.textContent = text || '';
      w.appendChild(body);
      if (meta) { const m = el('div', 'passos'); m.textContent = meta; w.appendChild(m); }
      chat.appendChild(w); scrollBottom();
      return { w, body };
    }
    function appendThinking() {
      const w = el('div', 'msg assistant');
      const ul = el('ul', 'tarefas');
      const li = el('li'); li.appendChild(el('span', 'giro')); li.appendChild(el('span', null, 'thinking…'));
      ul.appendChild(li); w.appendChild(ul);
      chat.appendChild(w); scrollBottom();
      return w;
    }
    async function ask(text) {
      // Snapshot marker + attachments BEFORE we clear them so the bubble
      // matches what the model actually receives.
      const markerSnapshot = currentMarker ? { text: currentMarker.text, type: currentMarker.type } : null;
      const attachmentSnapshot = pendingAttachments.map((a) => a.id);
      appendUser(text, { marker: markerSnapshot, attachmentIds: attachmentSnapshot });
      // Live agent turn: task list + streamed answer text. Backed by
      // /api/admin/agent (SSE), same event schema as daily-report:
      //   task  { id, label, status, transient?, detail? }
      //   delta { delta }
      //   done  { text, history }
      //   error { message }
      const wrap = el('div', 'msg assistant');
      // Task list is visible during streaming (so the reader sees "working…"),
      // then collapsed into a <details> when 'done' fires so numbers/prose
      // read cleanly. Following PADROES 1B.5: procedence accessible but not in the way.
      const trace = document.createElement('details');
      trace.className = 'passos';
      const summary = document.createElement('summary');
      summary.textContent = 'working…';
      trace.appendChild(summary);
      const tasks = el('ul', 'tarefas');
      trace.appendChild(tasks);
      trace.open = true; // stay open while running
      const body = el('div', 'corpo');
      wrap.appendChild(trace); wrap.appendChild(body);
      chat.appendChild(wrap); scrollBottom();
      let checkCount = 0;
      let queryCount = 0;
      const taskById = new Map();
      const bumpTask = (evt) => {
        const li = taskById.get(evt.id) || (() => {
          const n = el('li');
          n.appendChild(el('span', 'giro'));
          n.appendChild(el('span', 'txt', evt.label || ''));
          n.appendChild(el('em', null, ''));
          tasks.appendChild(n);
          taskById.set(evt.id, n);
          return n;
        })();
        if (evt.status === 'running' && evt.label) li.querySelector('.txt').textContent = evt.label;
        if (evt.status === 'done') {
          li.classList.add('done');
          const mark = el('span', 'marca', '✓');
          li.replaceChild(mark, li.firstChild);
          if (evt.transient) { li.remove(); taskById.delete(evt.id); return; }
          if (evt.detail) li.querySelector('em').textContent = evt.detail;
          // Count "queries" (tool calls that hit data) vs generic "thinking"
          // labels for the collapsed summary.
          if (evt.id && String(evt.id).startsWith('tool-')) queryCount++;
          else checkCount++;
        }
        if (evt.status === 'error') {
          li.classList.add('error');
          const mark = el('span', 'marca falhou', '×');
          li.replaceChild(mark, li.firstChild);
          if (evt.detail) li.querySelector('em').textContent = evt.detail;
        }
        scrollBottom();
      };
      try {
        const markerToSend = currentMarker;
        currentMarker = null;
        const strip = document.querySelector('.marcador'); if (strip) strip.remove();
        const attachmentIds = pendingAttachments.map((a) => a.id);
        pendingAttachments = [];
        renderAttachmentsStrip();
        const r = await fetch('/api/admin/agent', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            page: location.pathname + location.search,
            marker: markerToSend,
            attachments: attachmentIds
          })
        });
        if (!r.ok || !r.body) {
          const errText = await r.text().catch(() => '');
          body.textContent = 'error: ' + (errText || r.status);
          return;
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Split on SSE record boundary (blank line).
          let idx;
          while ((idx = buf.indexOf('\\n\\n')) !== -1) {
            const record = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            if (!record.startsWith('data:')) continue;
            const jsonStr = record.slice(5).trim();
            let evt;
            try { evt = JSON.parse(jsonStr); } catch (_) { continue; }
            if (evt.type === 'task') bumpTask(evt);
            else if (evt.type === 'delta') { body.textContent += (evt.delta || ''); scrollBottom(); }
            else if (evt.type === 'done') {
              if (evt.text) body.textContent = evt.text;
              // After streaming finishes, extract fenced code blocks
              // (chart / table) and render them inline, stripping from prose.
              renderRichBlocks(wrap, body);
              // Then fetch follow-up suggestions and render as chips below
              // this answer (only the LAST answer keeps its chips).
              document.querySelectorAll('.sugestoes').forEach((s) => s.remove());
              renderSuggestions(wrap);
              // Collapse the trace and label it: "N checks, N queries" — PADROES 1B.5.
              trace.open = false;
              const parts = [];
              if (checkCount) parts.push(checkCount + (checkCount === 1 ? ' check' : ' checks'));
              if (queryCount) parts.push(queryCount + (queryCount === 1 ? ' query' : ' queries'));
              summary.textContent = parts.length ? parts.join(', ') : 'reasoning trace';
              scrollBottom();
            }
            else if (evt.type === 'error') { const e = el('div', 'msg erro'); e.textContent = 'error: ' + (evt.message || '?'); chat.appendChild(e); scrollBottom(); }
          }
        }
      } catch (err) {
        body.textContent = 'network error: ' + err.message;
      }
    }
    // Marker: user selects any text inside .relatorio, a floating button
    // appears; click attaches selection as marker for the next question.
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { marcarBtn.style.display = 'none'; return; }
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const relatorio = document.querySelector('.relatorio');
      if (!relatorio || !relatorio.contains(container.nodeType === 3 ? container.parentNode : container)) { marcarBtn.style.display = 'none'; return; }
      const rect = range.getBoundingClientRect();
      if (!rect || rect.width === 0) { marcarBtn.style.display = 'none'; return; }
      marcarBtn.style.display = 'block';
      marcarBtn.style.left = Math.min(window.innerWidth - 200, rect.right + 8) + 'px';
      marcarBtn.style.top = Math.max(8, rect.top - 4) + 'px';
    });
    marcarBtn.addEventListener('mousedown', (e) => { e.preventDefault(); }); // don't lose selection
    // Classify the selection into one of the marker types the server prompt
    // knows how to handle: chart | model_sentence | number | quote | text.
    // Heuristics only — the server prompt's per-type rules are what makes
    // it work; type just tells the server which rules to apply.
    function classifyMarker(text, range) {
      const t = (text || '').trim();
      // Pure number (or currency / percent) — single token
      if (/^-?[\d.,]+%?$/.test(t) || /^\$[\d.,]+$/.test(t)) return 'number';
      // Text is contained inside a chart panel (.grafico or an SVG)
      try {
        const node = range?.commonAncestorContainer;
        const anc = node?.nodeType === 3 ? node.parentNode : node;
        if (anc?.closest?.('.grafico, svg, .grafico-analista')) return 'chart';
      } catch (_) { /* nope */ }
      // Text is inside an assistant message body — most likely a model claim
      try {
        const node = range?.commonAncestorContainer;
        const anc = node?.nodeType === 3 ? node.parentNode : node;
        if (anc?.closest?.('.msg.assistant .corpo')) return 'model_sentence';
      } catch (_) { /* nope */ }
      // Quoted text with matching quotes on both sides
      if (/^["“].*["”]$/.test(t) || /^['‘].*['’]$/.test(t)) return 'quote';
      return 'text';
    }
    marcarBtn.addEventListener('click', () => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim().slice(0, 800) : '';
      if (!text) return;
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const type = classifyMarker(text, range);
      currentMarker = { text, source: location.pathname, type };
      renderMarkerStrip();
      marcarBtn.style.display = 'none';
      window.getSelection().removeAllRanges();
    });
    function renderMarkerStrip() {
      const existing = document.querySelector('.marcador');
      if (existing) existing.remove();
      if (!currentMarker) return;
      const strip = el('div', 'marcador');
      strip.appendChild(el('span', 'rot', 'Marked'));
      strip.appendChild(el('span', 'txt', currentMarker.text));
      const x = el('button', 'x', '×');
      x.addEventListener('click', () => { currentMarker = null; strip.remove(); });
      strip.appendChild(x);
      const composer = document.querySelector('.composer');
      composer.parentElement.insertBefore(strip, composer);
    }

    // On page load, replay persisted turns so chat is continuous across
    // navigations and reloads. Server owns history — client just fetches.
    (async () => {
      try {
        const r = await fetch('/api/admin/agent/history', { credentials: 'include' });
        if (!r.ok) return;
        const data = await r.json();
        const items = data.items || [];
        if (items.length === 0) return;
        if (vazio && vazio.parentElement) vazio.remove();
        for (const it of items) {
          if (it.question) {
            appendUser(it.question, {
              marker: it.marker || null,
              attachmentIds: Array.isArray(it.attachments) ? it.attachments : []
            });
          }
          if (it.answer) {
            const w = el('div', 'msg assistant');
            const b = el('div', 'corpo'); b.textContent = it.answer;
            w.appendChild(b); chat.appendChild(w);
            // Re-render fenced chart / table blocks on replay — otherwise
            // they show as raw JSON after a reload (was AFAZERES #4).
            try { renderRichBlocks(w, b); } catch (_) { /* non-fatal */ }
          }
        }
        const sep = el('div', 'retomada'); sep.textContent = '— resumed from earlier —';
        chat.appendChild(sep);
        scrollBottom();
      } catch (_) { /* non-fatal */ }
    })();

    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear this conversation? Server-side history will also be removed.')) return;
      try { await fetch('/api/admin/agent/history', { method: 'DELETE', credentials: 'include' }); } catch (_) {}
      chat.innerHTML = '';
      chat.appendChild(vazio ? vazio : (function () { const v = el('div', 'vazio'); v.textContent = 'Cleared. Ask anything.'; return v; })());
    });
    send.addEventListener('click', () => {
      const v = ta.value.trim();
      // Allow send with just attachments and no text — model gets images alone.
      if (!v && pendingAttachments.length === 0) return;
      ta.value = ''; ta.style.height = '';
      ask(v || '(image only)');
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
    // Image paste: user hits Ctrl-V with an image on the clipboard. Read the
    // first image item, upload it, and add a thumbnail. Text pastes fall
    // through to normal textarea behaviour.
    ta.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items || [];
      const images = [];
      for (const it of items) {
        if (it.kind === 'file' && String(it.type).startsWith('image/')) {
          const blob = it.getAsFile();
          if (blob) images.push(blob);
        }
      }
      if (images.length === 0) return; // let text paste proceed
      e.preventDefault();
      for (const blob of images.slice(0, 3 - pendingAttachments.length)) {
        try {
          const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => rej(r.error || new Error('read failed'));
            r.readAsDataURL(blob);
          });
          const resp = await fetch('/api/admin/attachments', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl })
          });
          if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            renderAttachmentsStrip('upload failed: ' + (err || resp.status));
            continue;
          }
          const rec = await resp.json();
          pendingAttachments.push({ id: rec.id, contentType: rec.contentType, dataUrl });
          renderAttachmentsStrip();
        } catch (err) {
          renderAttachmentsStrip('upload error: ' + err.message);
        }
      }
    });
    function renderAttachmentsStrip(errorMsg) {
      const existing = document.querySelector('.anexos');
      if (existing) existing.remove();
      if (pendingAttachments.length === 0 && !errorMsg) return;
      const strip = el('div', 'anexos');
      pendingAttachments.forEach((a, i) => {
        const t = el('div', 'thumb');
        const img = document.createElement('img');
        img.src = a.dataUrl; img.alt = 'attachment ' + (i + 1);
        img.addEventListener('click', () => abrirEditor(i));
        img.title = 'Click to draw on this image';
        const x = el('button', 'x', '×');
        x.title = 'Remove';
        x.addEventListener('click', (e) => { e.stopPropagation(); pendingAttachments.splice(i, 1); renderAttachmentsStrip(); });
        const editBtn = el('button', 'edit', '✎ mark');
        editBtn.title = 'Open editor';
        editBtn.addEventListener('click', (e) => { e.stopPropagation(); abrirEditor(i); });
        t.appendChild(img); t.appendChild(x); t.appendChild(editBtn);
        strip.appendChild(t);
      });
      if (errorMsg) {
        const s = el('span', 'status', errorMsg);
        s.style.color = 'var(--crit)';
        strip.appendChild(s);
      }
      const composer = document.querySelector('.composer');
      composer.parentElement.insertBefore(strip, composer);
    }

    // ---- Draggable divider between agent panel and content panel ----
    (function initSplitter() {
      const layout = document.querySelector('.layout');
      const splitter = document.getElementById('splitter');
      if (!layout || !splitter) return;
      const STORAGE_KEY = 'coach-studio-left-fraction';
      const MIN_LEFT_PX = 300;
      const MIN_RIGHT_PX = 420;
      let currentLeftPx = 0;
      function applyLeftPx(px) {
        const cw = layout.clientWidth;
        if (cw < 900) return; // mobile stacked layout takes over
        const clamped = Math.max(MIN_LEFT_PX, Math.min(cw - MIN_RIGHT_PX, px));
        currentLeftPx = clamped;
        layout.style.gridTemplateColumns = clamped + 'px 1fr';
        splitter.style.left = clamped + 'px';
      }
      function measureCurrentLeftPx() {
        const agente = layout.querySelector('.agente');
        return agente ? agente.getBoundingClientRect().width : 0;
      }
      // Initial placement — from saved fraction or from the current default column width.
      const saved = parseFloat(localStorage.getItem(STORAGE_KEY) || '');
      if (Number.isFinite(saved) && saved > 0.15 && saved < 0.7 && layout.clientWidth >= 900) {
        applyLeftPx(saved * layout.clientWidth);
      } else {
        splitter.style.left = measureCurrentLeftPx() + 'px';
      }
      // Keep splitter glued to the boundary on window resize.
      window.addEventListener('resize', () => {
        splitter.style.left = (currentLeftPx || measureCurrentLeftPx()) + 'px';
      });
      let dragging = false;
      splitter.addEventListener('pointerdown', (e) => {
        dragging = true;
        splitter.classList.add('dragging');
        document.body.style.userSelect = 'none';
        try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
      });
      splitter.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const rect = layout.getBoundingClientRect();
        applyLeftPx(e.clientX - rect.left);
      });
      const stop = (e) => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        document.body.style.userSelect = '';
        try { splitter.releasePointerCapture(e.pointerId); } catch (_) {}
        const cw = layout.clientWidth;
        if (cw && currentLeftPx) localStorage.setItem(STORAGE_KEY, String(currentLeftPx / cw));
      };
      splitter.addEventListener('pointerup', stop);
      splitter.addEventListener('pointercancel', stop);
      splitter.addEventListener('dblclick', () => {
        localStorage.removeItem(STORAGE_KEY);
        layout.style.gridTemplateColumns = '';
        // Force reflow, THEN measure — rAF was flaky (would sometimes drop).
        void layout.offsetWidth;
        const px = measureCurrentLeftPx();
        currentLeftPx = px;
        splitter.style.left = px + 'px';
      });
    })();

    // ---- Lightbox for attached images ----
    (function initLupa() {
      const lupa = document.getElementById('lupa');
      if (!lupa) return;
      lupa.addEventListener('click', () => lupa.classList.remove('aberta'));
      // Click any zoomable image in the chat area opens the lightbox.
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.tagName === 'IMG' && (t.closest('.imgs-turno') || t.dataset.zoom === '1')) {
          lupa.querySelector('img').src = t.src;
          lupa.classList.add('aberta');
        }
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lupa.classList.remove('aberta'); });
    })();

    // ---- Image annotation editor (port from daily-report) ----
    // A single-purpose canvas modal where the user drags a red/blue/black pen
    // over an already-uploaded thumbnail. Save re-uploads the composite as a
    // NEW attachment and swaps it in place — original stays on the volume.
    const editor = { aberto: false, indice: null, imagem: null, tracos: [], atual: null, cor: '#e11d48', grossura: 6 };
    function abrirEditor(indice) {
      const anexo = pendingAttachments[indice];
      if (!anexo?.dataUrl) return;
      const img = new Image();
      img.onload = () => {
        editor.aberto = true; editor.indice = indice; editor.imagem = img; editor.tracos = []; editor.atual = null;
        const tela = document.getElementById('telaEditor');
        tela.width = img.naturalWidth; tela.height = img.naturalHeight;
        const escala = Math.min(1, (window.innerWidth * 0.88) / img.naturalWidth, (window.innerHeight * 0.7) / img.naturalHeight);
        tela.style.width = Math.round(img.naturalWidth * escala) + 'px';
        tela.style.height = Math.round(img.naturalHeight * escala) + 'px';
        redesenharEditor();
        document.getElementById('editor').classList.add('aberto');
      };
      img.src = anexo.dataUrl;
    }
    function fecharEditor() {
      editor.aberto = false;
      document.getElementById('editor').classList.remove('aberto');
    }
    function redesenharEditor() {
      const tela = document.getElementById('telaEditor');
      const g = tela.getContext('2d');
      g.clearRect(0, 0, tela.width, tela.height);
      g.drawImage(editor.imagem, 0, 0);
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const traco of [...editor.tracos, editor.atual].filter(Boolean)) {
        if (traco.pontos.length < 2) continue;
        g.strokeStyle = traco.cor;
        g.lineWidth = traco.grossura * Math.max(1, tela.width / 900);
        g.beginPath();
        g.moveTo(traco.pontos[0].x, traco.pontos[0].y);
        for (const p of traco.pontos.slice(1)) g.lineTo(p.x, p.y);
        g.stroke();
      }
    }
    function pontoNaTela(evento) {
      const tela = document.getElementById('telaEditor');
      const r = tela.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: (evento.clientX - r.left) * (tela.width / r.width), y: (evento.clientY - r.top) * (tela.height / r.height) };
    }
    async function salvarEditor() {
      const tela = document.getElementById('telaEditor');
      const indice = editor.indice;
      const anexo = pendingAttachments[indice];
      if (!anexo) return fecharEditor();
      const dataUrl = tela.toDataURL('image/png');
      fecharEditor();
      // Re-upload — the original stays on the volume unchanged; the ANNOTATED
      // version becomes the one that goes to the model.
      try {
        const resp = await fetch('/api/admin/attachments', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl })
        });
        if (!resp.ok) throw new Error('upload failed');
        const rec = await resp.json();
        anexo.id = rec.id;
        anexo.contentType = rec.contentType;
        anexo.dataUrl = dataUrl;
      } catch (err) {
        renderAttachmentsStrip('save failed: ' + err.message); return;
      }
      renderAttachmentsStrip();
    }
    (function initEditor() {
      const tela = document.getElementById('telaEditor');
      if (!tela) return;
      tela.addEventListener('pointerdown', (e) => {
        const p = pontoNaTela(e); if (!p) return;
        try { tela.setPointerCapture(e.pointerId); } catch (_) {}
        editor.atual = { cor: editor.cor, grossura: editor.grossura, pontos: [p] };
      });
      tela.addEventListener('pointermove', (e) => {
        if (!editor.atual) return;
        const p = pontoNaTela(e); if (!p) return;
        editor.atual.pontos.push(p);
        redesenharEditor();
      });
      const encerrar = () => {
        if (!editor.atual) return;
        if (editor.atual.pontos.length > 1) editor.tracos.push(editor.atual);
        editor.atual = null;
        redesenharEditor();
      };
      tela.addEventListener('pointerup', encerrar);
      tela.addEventListener('pointercancel', encerrar);
      tela.addEventListener('pointerleave', encerrar);
      document.getElementById('editorDesfazer')?.addEventListener('click', () => { editor.tracos.pop(); redesenharEditor(); });
      document.getElementById('editorLimpar')?.addEventListener('click', () => { editor.tracos = []; redesenharEditor(); });
      document.getElementById('editorCancelar')?.addEventListener('click', fecharEditor);
      document.getElementById('editorSalvar')?.addEventListener('click', salvarEditor);
      for (const b of document.querySelectorAll('#editor .cor')) {
        b.addEventListener('click', () => {
          editor.cor = b.dataset.cor;
          for (const o of document.querySelectorAll('#editor .cor')) o.setAttribute('aria-pressed', String(o === b));
        });
      }
      document.addEventListener('keydown', (e) => {
        if (!editor.aberto) return;
        if (e.key === 'Escape') fecharEditor();
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); editor.tracos.pop(); redesenharEditor(); }
      });
    })();
    if (vazio) vazio.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      ta.value = b.dataset.p; send.click();
    });
    // Mark current nav link active.
    document.querySelectorAll('.topo nav a').forEach((a) => {
      if (a.getAttribute('href') === location.pathname) a.classList.add('active');
    });
  })();
</script>
</body>
</html>`;
}

function sessionsPage({ items, tester, limit, bookmarkFilter, bookmarks }) {
    // bookmarkFilter: '' (all) | 'any' | 'exemplar' | 'problem'
    // bookmarks: { sessionId -> {kind, note, actor, updatedAt} }
    const shown = (items || []).filter((s) => {
        if (!bookmarkFilter) return true;
        const bk = bookmarks[s.sessionId];
        if (bookmarkFilter === 'any') return !!bk;
        return bk && bk.kind === bookmarkFilter;
    });
    const bookmarkCell = (s) => {
        const bk = bookmarks[s.sessionId] || null;
        const kind = bk ? bk.kind : '';
        const note = bk ? bk.note : '';
        // Form triggers cycle: no → exemplar → problem → clear
        // But easier UX: two buttons and a small note field.
        return `<td class="bk-cell">
          <form method="POST" action="/admin/sessions/${encodeURIComponent(s.sessionId)}/bookmark" class="bk-form">
            <input type="hidden" name="return" value="${escapeHtml('/admin/sessions?' + new URLSearchParams({ tester, limit: String(limit), bk: bookmarkFilter || '' }).toString())}">
            <button type="submit" name="kind" value="${kind === 'exemplar' ? '' : 'exemplar'}"
              class="bk-btn ${kind === 'exemplar' ? 'active exemplar' : ''}"
              title="${kind === 'exemplar' ? 'Clear exemplar' : 'Mark as exemplar'}">⭐</button>
            <button type="submit" name="kind" value="${kind === 'problem' ? '' : 'problem'}"
              class="bk-btn ${kind === 'problem' ? 'active problem' : ''}"
              title="${kind === 'problem' ? 'Clear problem' : 'Mark as problem'}">⚠️</button>
            <input type="text" name="note" value="${escapeHtml(note || '')}" maxlength="200"
              placeholder="${kind ? 'note…' : ''}"
              class="bk-note ${kind ? 'has-kind' : ''}"
              onchange="this.form.submit()"
              onblur="if (this.dataset.orig !== this.value) this.form.submit()"
              data-orig="${escapeHtml(note || '')}">
          </form>
        </td>`;
    };

    const rows = shown.length ? shown.map((s) => `
    <tr class="bk-row">
      <td class="px-3 py-2 text-xs"><a class="font-mono text-teal-700 hover:underline" href="/admin/sessions/${encodeURIComponent(s.sessionId)}">${escapeHtml(s.sessionId)}</a></td>
      <td class="px-3 py-2 text-xs">${escapeHtml((s.actor?.email) || (s.actor?.userId) || (s.actor?.objectId) || 'guest')}</td>
      <td class="px-3 py-2 text-xs">${s.actor?.tester ? '<span class="text-amber-700">tester</span>' : ''}</td>
      <td class="px-3 py-2 text-xs">${escapeHtml(s.startedAt)}</td>
      <td class="px-3 py-2 text-xs">${escapeHtml(s.lastAt)}</td>
      <td class="px-3 py-2 text-xs text-right">${s.turns}</td>
      ${bookmarkCell(s)}
    </tr>
    `).join('') : `<tr><td colspan="7" class="px-3 py-8 text-sm text-gray-500 text-center">No sessions match.</td></tr>`;

    const totalMarked = Object.keys(bookmarks || {}).length;
    const bkTabs = ['', 'any', 'exemplar', 'problem'].map((v) => {
        const active = (bookmarkFilter || '') === v;
        const label = v === '' ? 'All' : v === 'any' ? 'Marked' : v === 'exemplar' ? '⭐ Exemplars' : '⚠️ Problems';
        const qs = new URLSearchParams({ tester, limit: String(limit), bk: v }).toString();
        return `<a href="/admin/sessions?${qs}" class="bk-tab ${active ? 'active' : ''}">${label}</a>`;
    }).join('');

    const body = `
    <style>
      .bk-toolbar { display:flex; gap:14px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line);
        flex-wrap:wrap; background:var(--card); }
      .bk-toolbar .title { font-size:14.5px; font-weight:600; color:var(--ink); }
      .bk-tabs { display:flex; gap:4px; margin-left:12px; }
      .bk-tab { font-size:12px; padding:5px 10px; border-radius:999px; color:var(--ink2);
        text-decoration:none; border:1px solid var(--line); background:var(--card); }
      .bk-tab:hover { color:var(--ink); border-color:var(--accent); text-decoration:none; }
      .bk-tab.active { background:var(--accent-tint); color:var(--accent); border-color:transparent; font-weight:600; }
      .bk-form-row { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); }
      .bk-form-row select, .bk-form-row input { font:12px inherit; padding:4px 8px; border:1px solid var(--line);
        border-radius:6px; background:var(--card); color:var(--ink); }
      .bk-count { margin-left:auto; font-size:11.5px; color:var(--muted); }
      table.bk-table { width:100%; border-collapse: collapse; font-size:13px; }
      table.bk-table thead { background:var(--soft); }
      table.bk-table thead th { padding:8px 10px; text-align:left; font-size:11px; text-transform:uppercase;
        letter-spacing:.06em; color:var(--muted); }
      table.bk-table tr.bk-row { border-bottom:1px solid var(--line); }
      table.bk-table tr.bk-row:hover { background:var(--accent-tint); }
      table.bk-table td { padding:8px 10px; vertical-align:middle; }
      .bk-cell { min-width:250px; padding:6px 10px; }
      .bk-form { display:inline-flex; align-items:center; gap:6px; margin:0; }
      .bk-btn { background:none; border:0; padding:3px 6px; font-size:16px; cursor:pointer; border-radius:6px;
        opacity:.35; transition: opacity .15s ease, background .15s ease; }
      .bk-btn:hover { opacity: 1; background:var(--soft); }
      .bk-btn.active { opacity: 1; background: rgba(20, 184, 166, 0.12); }
      .bk-btn.active.problem { background: rgba(180, 83, 9, 0.14); }
      .bk-note { flex:1; min-width:80px; padding:4px 8px; font:12px inherit; border:1px solid transparent;
        border-radius:6px; background:transparent; color:var(--ink); }
      .bk-note:hover, .bk-note:focus { border-color:var(--line); background:var(--card); outline:none; }
      .bk-note.has-kind { border-color:var(--line); background:var(--card); }
    </style>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm" style="border:1px solid var(--line);border-radius:14px;background:var(--card);overflow:hidden">
      <div class="bk-toolbar">
        <div class="title">Sessions</div>
        <div class="bk-tabs">${bkTabs}</div>
        <form method="GET" action="/admin/sessions" class="bk-form-row">
          <input type="hidden" name="bk" value="${escapeHtml(bookmarkFilter || '')}">
          <label>Testers</label>
          <select name="tester">
            <option value="exclude"${tester==='exclude'?' selected':''}>exclude</option>
            <option value="only"${tester==='only'?' selected':''}>only</option>
            <option value="all"${tester==='all'?' selected':''}>all</option>
          </select>
          <label>Limit</label>
          <input type="number" min="1" max="500" name="limit" value="${limit}" style="width:70px">
          <button class="botao" style="padding:4px 10px">Apply</button>
        </form>
        <div class="bk-count">${shown.length} shown · ${totalMarked} marked total</div>
      </div>
      <table class="bk-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Actor</th>
            <th>Flag</th>
            <th>Started</th>
            <th>Last</th>
            <th style="text-align:right">Turns</th>
            <th>Bookmark · note</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    `;
    return shellChrome('Sessions', body);
}

function sessionDetailPage(sessionId, data) {
    if (!data) {
        return shellChrome('Session', `<section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6"><div class="text-sm text-gray-500">Session <code>${escapeHtml(sessionId)}</code> not found.</div></section>`);
    }
    const start = data.entries.find((e) => e.type === 'session_start') || {};
    const promptRefs = new Set();
    const rows = data.entries.map((e) => {
        if (e.type === 'session_start') return '';
        if (e.type === 'turn') {
            const side = e.role === 'bot' ? 'right' : 'left';
            const bg = e.role === 'bot' ? 'bg-teal-50' : 'bg-white';
            let text;
            if (e.text && typeof e.text === 'object' && e.text.redacted) {
                text = `<span class="text-gray-500 italic">[redacted, ${e.text.length} chars, hash ${e.text.hash}]</span>`;
            } else {
                text = escapeHtml(e.text || '');
            }
            let prompt = '';
            if (e.prompt_hash) {
                promptRefs.add(e.prompt_hash);
                prompt = `<div class="text-[10px] text-gray-400 mt-1">prompt <a class="underline" href="/admin/prompts/${encodeURIComponent(e.prompt_hash)}">${e.prompt_hash.slice(0,12)}…</a></div>`;
            }
            return `<div class="w-full flex justify-${side}"><div class="max-w-[80%] ${bg} border border-gray-200 rounded-2xl px-3 py-2 text-sm"><div>${text}</div>${prompt}<div class="text-[10px] text-gray-400 mt-1">${escapeHtml(e.t)} · ${escapeHtml(e.role)}</div></div></div>`;
        }
        if (e.type === 'tool_call') {
            const err = e.error ? ` <span class="text-red-600">${escapeHtml(e.error)}</span>` : '';
            return `<div class="w-full flex justify-center"><div class="w-[92%] bg-gray-100 border border-gray-200 rounded-lg px-3 py-2 text-xs"><span class="font-mono text-gray-700">tool</span> <span class="font-semibold">${escapeHtml(e.name)}</span>${err} <span class="text-gray-500">· ${escapeHtml(e.t)}</span><details class="mt-1"><summary class="cursor-pointer text-gray-600">args &amp; result</summary><pre class="whitespace-pre-wrap mt-1 text-[11px]">${escapeHtml(JSON.stringify(e.args, null, 2))}
—
${escapeHtml(typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2))}</pre></details></div></div>`;
        }
        if (e.type === 'event' && e.name === 'reasoning_summary') {
            const m = e.meta || {};
            const summary = String(m.summary || '');
            const source = m.source || 'unknown';
            const model = m.model || '?';
            const chars = m.chars || summary.length;
            return `<div class="w-full flex justify-center"><div class="w-[92%] bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs"><div class="flex items-center gap-2 text-amber-900"><span>🧠</span><span class="font-semibold">Reasoning</span><span class="text-amber-700 text-[10px] uppercase tracking-wide">${escapeHtml(source)}</span><span class="text-gray-500 text-[10px]">${escapeHtml(model)} · ${chars} chars</span><span class="text-gray-400 text-[10px] ml-auto">${escapeHtml(e.t || '')}</span></div><details class="mt-1"><summary class="cursor-pointer text-amber-700">show summary</summary><pre class="whitespace-pre-wrap mt-1 text-[11px] text-amber-900">${escapeHtml(summary)}</pre>${m.queryPreview ? `<div class="text-[10px] text-gray-500 mt-1">query: ${escapeHtml(m.queryPreview)}</div>` : ''}</details></div></div>`;
        }
        return `<div class="w-full flex justify-center"><div class="w-[92%] bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600"><span class="font-mono">${escapeHtml(e.type)}</span> ${escapeHtml(e.name || '')} <span class="text-gray-400 float-right">${escapeHtml(e.t || '')}</span></div></div>`;
    }).join('\n');
    const meta = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-sm">
      <div><span class="text-gray-500">Session:</span> <code class="font-mono">${escapeHtml(sessionId)}</code></div>
      <div><span class="text-gray-500">Actor:</span> ${escapeHtml(start.actor?.email || start.actor?.userId || start.actor?.objectId || 'guest')} ${start.actor?.tester ? '<span class="text-amber-700 text-xs ml-2">tester</span>' : ''}</div>
      <div><span class="text-gray-500">Started:</span> <code>${escapeHtml(start.t)}</code></div>
      <div><span class="text-gray-500">Entries:</span> ${data.entries.length} · Prompt snapshots referenced: ${promptRefs.size}</div>
    </section>`;
    return shellChrome('Session ' + sessionId, meta + '<section class="space-y-2">' + rows + '</section>');
}

function userLookupPage(input) {
    const body = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
      <form method="GET" action="/admin/users" class="flex items-center gap-3">
        <label class="text-sm text-gray-700">User ID or objectId</label>
        <input name="q" value="${escapeHtml(input || '')}" class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm w-96" placeholder="willian.jorge.machado@gmail.com OR a0074a28…">
        <button class="rounded-lg bg-gray-800 text-white text-sm px-3 py-1.5">Look up</button>
      </form>
      <p class="text-xs text-gray-500 mt-2">Reuses the diagnostic bundle (activity + vector store files) exposed via <code>/api/debug/user</code>.</p>
    </section>`;
    return shellChrome('User lookup', body);
}
function userDetailPage(id, snap) {
    const rowsAct = (snap?.activity?.events || []).slice(0, 40).map((e) => {
        const last = new Date(e.ts || 0).toISOString().slice(0, 10);
        return `<tr><td class="px-2 py-1">${escapeHtml(e.name)}</td><td class="px-2 py-1 text-right">${e.count}</td><td class="px-2 py-1">${last}</td></tr>`;
    }).join('');
    const rowsFiles = (snap?.vectorStore?.files || []).map((f) => `<tr><td class="px-2 py-1 font-mono text-xs">${escapeHtml(f.filename || f.id)}</td><td class="px-2 py-1 text-xs">${f.bytes ?? ''}</td><td class="px-2 py-1 text-xs">${escapeHtml(f.status || '')}</td><td class="px-2 py-1 text-xs">${escapeHtml(f.createdAt || '')}</td></tr>`).join('');
    const body = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-2 text-sm">
      <div><span class="text-gray-500">User:</span> <code>${escapeHtml(id)}</code> (${escapeHtml(snap?.identifierType || '?')})</div>
      <div><span class="text-gray-500">Vector store:</span> <code>${escapeHtml(snap?.vectorStore?.storeId || '(none)')}</code></div>
    </section>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm">
      <div class="px-4 py-2 border-b border-gray-200 text-sm font-semibold">Activity events (${snap?.activity?.eventsCount || 0})</div>
      <table class="w-full text-sm"><thead class="bg-gray-50 text-xs uppercase text-gray-600"><tr><th class="px-2 py-1 text-left">Event</th><th class="px-2 py-1 text-right">Count</th><th class="px-2 py-1 text-left">Last</th></tr></thead><tbody>${rowsAct || '<tr><td colspan="3" class="px-2 py-4 text-center text-xs text-gray-500">no events</td></tr>'}</tbody></table>
    </section>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm">
      <div class="px-4 py-2 border-b border-gray-200 text-sm font-semibold">Vector store files</div>
      <table class="w-full text-sm"><thead class="bg-gray-50 text-xs uppercase text-gray-600"><tr><th class="px-2 py-1 text-left">File</th><th class="px-2 py-1 text-left">Bytes</th><th class="px-2 py-1 text-left">Status</th><th class="px-2 py-1 text-left">Created</th></tr></thead><tbody>${rowsFiles || '<tr><td colspan="4" class="px-2 py-4 text-center text-xs text-gray-500">no files</td></tr>'}</tbody></table>
    </section>`;
    return shellChrome('User ' + id, body);
}

function promptDetailPage(hash, snap) {
    if (!snap) return shellChrome('Prompt', `<section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-sm text-gray-500">Prompt snapshot not found.</section>`);
    return shellChrome('Prompt ' + hash, `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-sm space-y-2">
      <div><span class="text-gray-500">Hash:</span> <code class="font-mono">${escapeHtml(snap.hash)}</code></div>
      <div><span class="text-gray-500">Length:</span> ${snap.length} chars · <span class="text-gray-500">First seen:</span> ${escapeHtml(snap.first_seen)}</div>
    </section>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
      <pre class="text-xs whitespace-pre-wrap font-mono">${escapeHtml(snap.text)}</pre>
    </section>`);
}

function metricsPage(m) {
    const fmtMs = (ms) => ms == null ? '—' : (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

    // ---- SVG helpers (server-side, no client script needed) ----
    const svgVBarChart = (data, opts = {}) => {
        // data: [{label, value, errValue?}]
        const W = opts.width || 700, H = opts.height || 180, padL = 30, padR = 12, padT = 10, padB = 32;
        const innerW = W - padL - padR;
        const innerH = H - padT - padB;
        const vals = data.map(d => Number(d.value) || 0);
        const errs = data.map(d => Number(d.errValue) || 0);
        const max = Math.max(1, ...vals);
        const bandW = innerW / Math.max(1, data.length);
        const barW = Math.max(4, bandW * 0.68);
        const parts = [];
        parts.push(`<line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--axis)" />`);
        // gridlines at 50% + 100% of max
        for (const frac of [0.5, 1]) {
            const y = padT + innerH - innerH * frac;
            parts.push(`<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-dasharray="3,3" />`);
            parts.push(`<text x="${padL - 4}" y="${y + 4}" font-size="10" fill="var(--muted)" text-anchor="end">${Math.round(max * frac)}</text>`);
        }
        data.forEach((d, i) => {
            const v = Number(d.value) || 0;
            const h = (v / max) * innerH;
            const x = padL + i * bandW + (bandW - barW) / 2;
            const y = padT + innerH - h;
            parts.push(`<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(1, h)}" fill="var(--s1)" rx="3" />`);
            if (d.errValue) {
                const errH = (Number(d.errValue) / max) * innerH;
                parts.push(`<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(1, errH)}" fill="var(--crit)" opacity="0.85" rx="3" />`);
            }
            // Value label above bar when non-zero and there's space.
            if (v > 0 && h > 14) {
                parts.push(`<text x="${x + barW / 2}" y="${y + 12}" font-size="10" fill="#fff" text-anchor="middle">${v}</text>`);
            } else if (v > 0) {
                parts.push(`<text x="${x + barW / 2}" y="${y - 3}" font-size="10" fill="var(--ink2)" text-anchor="middle">${v}</text>`);
            }
            // x-axis label
            parts.push(`<text x="${x + barW / 2}" y="${padT + innerH + 14}" font-size="10" fill="var(--muted)" text-anchor="middle">${escapeHtml(String(d.label).slice(0, 10))}</text>`);
        });
        return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:100%;height:${H}px" role="img">${parts.join('')}</svg>`;
    };
    const svgHBarChart = (data, opts = {}) => {
        // data: [{label, value, sub?}]
        const barH = 22, gap = 8, padL = 200, padR = 40, padT = 6;
        const H = data.length * (barH + gap) + padT + 4;
        const W = opts.width || 600;
        const innerW = W - padL - padR;
        const max = Math.max(1, ...data.map(d => Number(d.value) || 0));
        const parts = [];
        data.forEach((d, i) => {
            const v = Number(d.value) || 0;
            const w = Math.max(2, (v / max) * innerW);
            const y = padT + i * (barH + gap);
            parts.push(`<rect x="${padL}" y="${y}" width="${w}" height="${barH}" fill="var(--s1)" rx="4" />`);
            if (d.sub) {
                const subV = Number(d.sub) || 0;
                const subW = (subV / max) * innerW;
                parts.push(`<rect x="${padL}" y="${y}" width="${Math.max(2, subW)}" height="${barH}" fill="var(--crit)" opacity="0.85" rx="4" />`);
            }
            parts.push(`<text x="${padL - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="12" fill="var(--ink2)">${escapeHtml(String(d.label))}</text>`);
            parts.push(`<text x="${padL + w + 6}" y="${y + barH / 2 + 4}" font-size="12" fill="var(--muted)">${v}${d.sub ? ' · <tspan fill="var(--crit)">' + d.sub + ' err</tspan>' : ''}</text>`);
        });
        return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:100%;height:${H}px" role="img">${parts.join('')}</svg>`;
    };

    // Daily volume for last 14 days (30 is too dense for the panel width).
    const daily14 = (m.daily || []).slice(-14);
    const daysChart = svgVBarChart(daily14.map(d => ({ label: d.date.slice(5), value: d.sessions })));
    // Tool usage top 10.
    const toolTop = (m.toolUsage || []).slice(0, 10).map(([name, count]) => {
        const errCount = (m.toolErrors || []).find(([n]) => n === name)?.[1] || 0;
        return { label: name, value: count, sub: errCount };
    });
    const toolsChart = toolTop.length ? svgHBarChart(toolTop) : '<div style="color:var(--muted);font-size:12px;padding:20px 0">No tool calls recorded yet.</div>';

    const body = `
    <div class="titulo"><h2>Metrics</h2><span class="meta">Computed at ${escapeHtml(m.computedAt)} · ${m.sessionsSeen} sessions in scope · testers ${m.includeTesters ? 'included' : 'excluded'}.</span></div>

    <div class="cards">
      <div class="card hero">
        <div class="rot">Last 24h</div>
        <div class="val">${m.volume.last24h.sessions}</div>
        <div class="var">${m.volume.last24h.turns} turns · ${m.volume.last24h.tools} tool calls</div>
      </div>
      <div class="card"><div class="rot">Last 7d</div><div class="val">${m.volume.last7d.sessions}</div><div class="var">${m.volume.last7d.turns} turns · ${m.volume.last7d.tools} tools</div></div>
      <div class="card"><div class="rot">Last 30d</div><div class="val">${m.volume.last30d.sessions}</div><div class="var">${m.volume.last30d.turns} turns · ${m.volume.last30d.tools} tools</div></div>
      <div class="card ${m.qualitySignals.rageClose > 0 ? 'warn' : ''}"><div class="rot">Rage close</div><div class="val"${m.qualitySignals.rageClose > 0 ? ' style="color:var(--warn)"' : ''}>${m.qualitySignals.rageClose}</div><div class="var">short session ending on user</div></div>
      <div class="card ${m.qualitySignals.longSilenceCount > 5 ? 'warn' : ''}"><div class="rot">Long silence</div><div class="val"${m.qualitySignals.longSilenceCount > 5 ? ' style="color:var(--warn)"' : ''}>${m.qualitySignals.longSilenceCount}</div><div class="var">gap &gt; 90s</div></div>
      <div class="card ${m.qualitySignals.toolFailureCount > 0 ? 'crit' : ''}"><div class="rot">Tool failures</div><div class="val"${m.qualitySignals.toolFailureCount > 0 ? ' style="color:var(--crit)"' : ''}>${m.qualitySignals.toolFailureCount}</div><div class="var">≥ 1 tool error</div></div>
      <div class="card"><div class="rot">🧠 Reasoning captured</div><div class="val">${(m.reasoning && m.reasoning.pctSessionsWithReasoning) || 0}%</div><div class="var">${(m.reasoning && m.reasoning.sessionsWithReasoning) || 0} of ${(m.reasoning && m.reasoning.sessionsSeen) || 0} sessions</div></div>
      <div class="card"><div class="rot">🧠 Avg summary length</div><div class="val">${(m.reasoning && m.reasoning.avgSummaryLength) || 0}</div><div class="var">chars · n=${(m.reasoning && m.reasoning.summarySamples) || 0}</div></div>
    </div>

    <div class="painel">
      <h3>Sessions per day (last 14)</h3>
      ${daysChart}
      <div class="foot">Bar = new sessions started that day. Bucketed by session start time (UTC).</div>
    </div>

    <div class="painel">
      <h3>Tool usage — top 10 (all-time)</h3>
      ${toolsChart}
      <div class="foot">Green = successful calls. Red overlay = failures (typically timeouts or model-side errors). PADROES 2.7: a plausible tool failure count is more damaging than a spike — investigate any red band.</div>
    </div>

    <div class="painel">
      <h3>Latency percentiles</h3>
      <table>
        <thead><tr><th>Metric</th><th class="num">p50</th><th class="num">p90</th><th class="num">p99</th></tr></thead>
        <tbody>
          <tr><td>Time to first bot turn</td><td class="num">${fmtMs(m.timeToFirstBotMs.p50)}</td><td class="num">${fmtMs(m.timeToFirstBotMs.p90)}</td><td class="num">${fmtMs(m.timeToFirstBotMs.p99)}</td></tr>
          <tr><td>Turn-to-turn gap</td><td class="num">${fmtMs(m.turnGapsMs.p50)}</td><td class="num">${fmtMs(m.turnGapsMs.p90)}</td><td class="num">${fmtMs(m.turnGapsMs.p99)}</td></tr>
          <tr><td>Session length</td><td class="num">${fmtMs(m.sessionLengthsMs.p50)}</td><td class="num">${fmtMs(m.sessionLengthsMs.p90)}</td><td class="num">${fmtMs(m.sessionLengthsMs.p99)}</td></tr>
        </tbody>
      </table>
      <div class="foot">Long tail matters: p99 tells you how bad the worst 1% of users have it.</div>
    </div>`;
    return shellChrome('Metrics', body);
}

function hubTile({ title, href, count, blurb, planned }) {
    // Planned tiles render as a static <div> — no navigation, muted visual.
    // Fixes the "fade + no move" bug where 'planned' items pointed at their
    // own page and read as broken clicks.
    if (planned) {
        return `<div class="hub-tile hub-tile-planned" aria-disabled="true">
          <div class="hub-title">${escapeHtml(title)}${count != null && count > 0 ? ` <span class="hub-count">${count}</span>` : ''} <span class="hub-planned-chip">planned</span></div>
          <div class="hub-blurb">${escapeHtml(blurb)}</div>
        </div>`;
    }
    return `<a class="hub-tile" href="${href}">
      <div class="hub-title">${escapeHtml(title)}${count != null && count > 0 ? ` <span class="hub-count">${count}</span>` : ''}</div>
      <div class="hub-blurb">${escapeHtml(blurb)}</div>
    </a>`;
}

function hubCss() {
    return `<style>
      .hub-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-top:14px; }
      .hub-tile { display:block; background:var(--card); border:1px solid var(--line); border-radius:14px;
        padding:16px 18px; text-decoration:none; color:var(--ink); box-shadow:0 1px 3px var(--ring);
        transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; }
      .hub-tile:hover { transform:translateY(-2px); box-shadow:0 6px 20px -6px var(--ring-hi); border-color:var(--ring-hi); text-decoration:none; }
      .hub-tile-planned { opacity:.7; cursor:default; }
      .hub-tile-planned:hover { transform:none; box-shadow:0 1px 3px var(--ring); border-color:var(--line); }
      .hub-planned-chip { font-size:10px; text-transform:uppercase; letter-spacing:.08em; padding:1px 6px;
        border-radius:999px; background:var(--soft); color:var(--muted); margin-left:6px; vertical-align:middle; }
      .hub-title { font-size:15px; font-weight:600; color:var(--ink); }
      .hub-count { color:var(--muted); font-weight:500; font-size:13px; margin-left:6px; }
      .hub-blurb { font-size:12.5px; color:var(--muted); margin-top:6px; line-height:1.45; }
      .rt-table { width:100%; border-collapse:collapse; font-size:13px; margin-top:12px; }
      .rt-table th, .rt-table td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
      .rt-table th { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
      .rt-table code { font-size:12px; background:var(--soft); padding:1px 5px; border-radius:4px; }
      .rt-stage { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; padding:2px 7px;
        border-radius:999px; background:var(--soft); color:var(--muted); }
      .rt-stage.boot { background:#e0f2fe; color:#075985; }
      .rt-stage.runtime { background:#fef3c7; color:#92400e; }
      .rt-stage.on-demand { background:#dcfce7; color:#166534; }
      .rt-toggle { display:inline-flex; align-items:center; gap:8px; font-size:12px; }
      .rt-toggle input { width:34px; height:20px; appearance:none; background:var(--line); border-radius:10px;
        position:relative; cursor:pointer; transition: background .15s ease; }
      .rt-toggle input:checked { background:var(--accent); }
      .rt-toggle input:disabled { opacity:.4; cursor:not-allowed; }
      .rt-toggle input::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px;
        background:#fff; border-radius:50%; transition: transform .15s ease; }
      .rt-toggle input:checked::after { transform:translateX(14px); }
    </style>`;
}

function semanticStorePage() {
    const courses = coursesStore.listCourses();
    const quizzes = quizzesStore.listQuizzes();
    const body = `
    ${hubCss()}
    <div class="titulo"><h2>Semantic Store</h2><span class="meta">Long-form, semantic content — indexed in the vector store. Erica pulls this on demand via <code>search_knowledge</code>.</span></div>
    <div class="hub-grid">
      ${hubTile({ title: 'Courses', href: '/admin/courses', count: courses.length, blurb: 'Pedagogical text + competency frameworks per course. Two artifacts per course, upload-friendly.' })}
      ${hubTile({ title: 'Quizzes', href: '/admin/quizzes', count: quizzes.length, blurb: 'Semantic description of each quiz — what it measures, dimensions, sample coaching moves. URL/ID stay on the Wix side.' })}
    </div>
    <div class="painel" style="margin-top:18px">
      <h3>What belongs here</h3>
      <ul style="margin:6px 0 0 18px;color:var(--ink2);font-size:13px;line-height:1.6">
        <li>Anything <em>long</em> and <em>semantic</em>: framework theory, course lessons, quiz descriptions, blog / article content.</li>
        <li>URLs, IDs, and canonical names go in <a href="/admin/injected-data">Injected Data</a> instead — the vector store must never leak a link to hallucinate against.</li>
      </ul>
    </div>`;
    return shellChrome('Semantic Store', body);
}

function injectedDataPage() {
    const frameworks = contentStore.listFrameworks();
    const body = `
    ${hubCss()}
    <div class="titulo"><h2>Injected Data</h2><span class="meta">Short, canonical content — injected verbatim into Erica's system prompt on every turn. Every word costs context.</span></div>
    <div class="hub-grid">
      ${hubTile({ title: 'Personas', href: '/admin/frameworks', count: frameworks.length, blurb: 'Coach voices (Erica, directive coaches). Name, tone, guardrails.' })}
      ${hubTile({ title: 'Canonical courses', planned: true, blurb: 'Canonical course names + Wix URLs Erica may cite. Coming soon — today this comes from the Wix preparation payload.' })}
      ${hubTile({ title: 'Canonical quizzes', planned: true, blurb: 'Canonical quiz names + Wix URLs. Coming soon — same source today.' })}
      ${hubTile({ title: 'Safety / refusal rules', planned: true, blurb: 'Anchor phrases and refusal rules. Currently baked into the coach system prompt.' })}
    </div>
    <div class="painel" style="margin-top:18px">
      <h3>What belongs here</h3>
      <ul style="margin:6px 0 0 18px;color:var(--ink2);font-size:13px;line-height:1.6">
        <li>Anything <em>short</em>, <em>rigorous</em>, and <em>canonical</em> — persona voice, guardrails, sanctioned URLs, safety rules.</li>
        <li>Long semantic content belongs in the <a href="/admin/semantic-store">Semantic Store</a>.</li>
      </ul>
    </div>`;
    return shellChrome('Injected Data', body);
}

function realtimeConfigPage(channels, message) {
    const bootCount = channels.filter((c) => c.stage === 'boot').length;
    const rtCount = channels.filter((c) => c.stage === 'runtime').length;
    const odCount = channels.filter((c) => c.stage === 'on-demand').length;
    const rows = channels.map((ch) => {
        const disabled = !ch.controllable;
        const checked = ch.enabled ? 'checked' : '';
        const label = ch.controllable
            ? (ch.enabled ? 'On' : 'Off')
            : 'Always on';
        return `<tr>
          <td><div style="font-weight:600;color:var(--ink)">${escapeHtml(ch.name)}</div>
              <div style="font-size:11.5px;color:var(--muted);margin-top:3px">${escapeHtml(ch.purpose)}</div></td>
          <td><span class="rt-stage ${escapeHtml(ch.stage)}">${escapeHtml(ch.stage)}</span></td>
          <td><code>${escapeHtml(ch.source)}</code>
              <div style="font-size:11px;color:var(--muted);margin-top:4px">${escapeHtml(ch.fields)}</div></td>
          <td>
            <form method="POST" action="/admin/realtime/${encodeURIComponent(ch.id)}/toggle" class="rt-toggle">
              <input type="checkbox" name="enabled" value="1" ${checked} ${disabled ? 'disabled' : ''}
                onchange="this.form.submit()"/>
              <span style="color:var(--muted)">${label}</span>
            </form>
          </td>
        </tr>`;
    }).join('');
    const banner = message
        ? `<div class="painel" style="background:var(--accent-tint);border-color:transparent;color:var(--accent)"><strong>${escapeHtml(message)}</strong></div>`
        : '';
    const body = `
    ${hubCss()}
    <div class="titulo"><h2>Real Time</h2><span class="meta">Every dynamic data source Erica receives at runtime. Toggle to control over-fetching or debug what she should have seen.</span></div>
    ${banner}
    <div class="cards">
      <div class="card"><div class="rot">Boot channels</div><div class="val">${bootCount}</div><div class="var">fetched at session start</div></div>
      <div class="card"><div class="rot">Runtime channels</div><div class="val">${rtCount}</div><div class="var">postMessage / DOM-driven</div></div>
      <div class="card"><div class="rot">On-demand channels</div><div class="val">${odCount}</div><div class="var">Erica tool-calls when needed</div></div>
    </div>
    <div class="painel">
      <h3>Channels</h3>
      <table class="rt-table">
        <thead><tr><th>Channel</th><th>Stage</th><th>Source · fields</th><th>Toggle</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="foot" style="margin-top:12px">
        Boot channels fire on session start. Runtime channels arrive via <code>bridge.js</code> postMessage from the parent page.
        On-demand channels are function calls Erica makes when the moment calls for them.
        Toggling here writes to <code>/data/runtime-config.json</code>; each toggle is audited.
      </div>
    </div>`;
    return shellChrome('Real Time', body);
}

function frameworksListPage() {
    const names = contentStore.listFrameworks();
    const rows = names.map((n) => {
        const r = contentStore.readFramework(n);
        const src = r?.source === 'overlay'
            ? '<span style="color:var(--accent);font-weight:600">edited</span>'
            : '<span style="color:var(--muted)">default</span>';
        return `<tr>
          <td><a href="/admin/frameworks/${encodeURIComponent(n)}">${escapeHtml(n)}</a></td>
          <td>${src}</td>
          <td style="font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted)">${escapeHtml(r?.hash?.slice(0,10) || '')}</td>
          <td class="num">${r?.text?.length || 0} chars</td>
        </tr>`;
    }).join('');
    const body = `
    <div class="titulo"><h2>Coach personas</h2><span class="meta">The coaching styles Erica can adopt (Supportive, Directive, Discovery, etc). Each persona is a markdown file that shapes her voice.</span></div>
    <div class="painel">
      <h3>All personas</h3>
      <table>
        <thead><tr><th>Name</th><th>Source</th><th>Hash</th><th class="num">Size</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:16px 0">No personas found.</td></tr>'}</tbody>
      </table>
      <div class="foot">Editing writes to the persistent volume overlay (<code>/data/frameworks/</code>) — repo defaults stay intact. Every write is audited.</div>
    </div>`;
    return shellChrome('Personas', body);
}

function frameworkEditPage(name, cur, { savedMessage = null } = {}) {
    if (!cur) return shellChrome('Persona', `<div class="painel"><p style="color:var(--muted)">Persona <code>${escapeHtml(name)}</code> not found.</p></div>`);

    const banner = savedMessage
        ? `<div style="padding:10px 14px;background:var(--accent-tint);border-left:3px solid var(--accent);border-radius:8px;margin-bottom:12px;font-size:13.5px">${escapeHtml(savedMessage)}</div>`
        : '';

    // Compute diff between current overlay (if any) and the repo default so
    // the operator can see what the overlay actually changed.
    let diffPanel = '';
    if (cur.source === 'overlay') {
        // Read default directly by bypassing overlay lookup.
        const fs = require('fs');
        const path = require('path');
        const defaultsDir = contentStore._paths?.DEFAULTS_DIR;
        let defaultText = null;
        try {
            if (defaultsDir) defaultText = fs.readFileSync(path.join(defaultsDir, cur.name + '.md'), 'utf8');
        } catch (_) { /* no default */ }
        if (defaultText != null) {
            const diff = contentStore.lineDiff(defaultText, cur.text);
            if (diff.changed && diff.hunks.length) {
                const h = diff.hunks[0];
                const rows = [];
                const maxRows = Math.max(h.aLines.length, h.bLines.length);
                for (let i = 0; i < maxRows; i++) {
                    const a = h.aLines[i] != null ? escapeHtml(h.aLines[i]) : '';
                    const b = h.bLines[i] != null ? escapeHtml(h.bLines[i]) : '';
                    const same = a === b;
                    rows.push(`<tr>
                      <td style="color:var(--muted);font-family:ui-monospace,Consolas,monospace;font-size:11px;text-align:right;padding-right:6px">${h.aStart + i + 1}</td>
                      <td style="background:${same ? 'transparent' : 'rgba(208,59,59,.08)'};font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:2px 6px;white-space:pre">${a}</td>
                      <td style="background:${same ? 'transparent' : 'var(--accent-tint)'};font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:2px 6px;white-space:pre">${b}</td>
                    </tr>`);
                }
                diffPanel = `<div class="painel">
                  <h3>Overlay vs default (first divergent hunk)</h3>
                  <div style="overflow-x:auto;border:1px solid var(--line);border-radius:8px">
                    <table style="width:100%;border-collapse:collapse">
                      <thead><tr>
                        <th style="text-align:right;padding:6px;background:var(--soft);font-size:11px">line</th>
                        <th style="text-align:left;padding:6px;background:rgba(208,59,59,.06);font-size:11px;color:var(--crit)">default</th>
                        <th style="text-align:left;padding:6px;background:var(--accent-tint);font-size:11px;color:var(--accent)">overlay (current)</th>
                      </tr></thead>
                      <tbody>${rows.join('')}</tbody>
                    </table>
                  </div>
                  <div class="foot">Shows the first block of lines that differ, ±2 lines of context. If more than one hunk exists, only the first is displayed.</div>
                </div>`;
            }
        }
    }

    // Recent revisions of THIS framework, pulled from the audit log so the
    // operator can see who changed what and when — the closest thing to undo
    // without a full VCS.
    const auditModule = require('./audit');
    const recentEntries = auditModule.list({ limit: 500 })
        .filter((e) => e.target === 'framework/' + cur.name && (e.action === 'framework.write' || e.action === 'framework.reset'))
        .slice(0, 8);
    const history = recentEntries.length
        ? '<div class="painel"><h3>Recent revisions</h3><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Before → after</th><th>Reason</th></tr></thead><tbody>'
        + recentEntries.map((e) => `<tr>
            <td style="font-family:ui-monospace,Consolas,monospace;font-size:11px">${escapeHtml((e.t || '').replace('T', ' ').slice(0, 19))}</td>
            <td>${escapeHtml(e.actor)}</td>
            <td>${escapeHtml(e.action)}</td>
            <td style="font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted)">${escapeHtml((e.meta?.beforeHash || '').slice(0, 8) || '—')} → ${escapeHtml((e.meta?.afterHash || '').slice(0, 8) || '—')}</td>
            <td style="font-size:12px;color:var(--ink2)">${escapeHtml(e.meta?.reason || '')}</td>
          </tr>`).join('')
        + '</tbody></table><div class="foot">Full history in <a href="/admin/audit">Audit trail →</a></div></div>'
        : '';

    const body = `
    <div class="titulo">
      <h2>${escapeHtml(cur.name)}</h2>
      <div>
        <span class="meta" style="margin-right:12px">source: ${cur.source === 'overlay' ? '<span style="color:var(--accent);font-weight:600">overlay</span>' : '<span style="color:var(--muted)">default</span>'} · <code style="font-size:11px">${escapeHtml(cur.hash.slice(0, 12))}…</code></span>
        <a class="botao" href="/admin/frameworks">← All personas</a>
      </div>
    </div>
    ${banner}
    ${diffPanel}
    <div class="painel">
      <h3>Edit</h3>
      <form method="POST" action="/admin/frameworks/${encodeURIComponent(cur.name)}" style="display:flex;flex-direction:column;gap:10px" id="fwForm">
        <textarea name="text" id="fwText" rows="26" style="font:12.5px ui-monospace,Consolas,monospace">${escapeHtml(cur.text)}</textarea>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">
          Reason (audit meta)
          <input name="reason" placeholder="e.g. Varsha: soften 'always_do' language in Supportive">
        </label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Save (writes overlay)</button>
          ${cur.source === 'overlay' ? `<button formaction="/admin/frameworks/${encodeURIComponent(cur.name)}/reset" formmethod="POST" onclick="return confirm('Remove overlay and revert to the repo default? The audit log preserves this change.')" class="botao" style="color:var(--crit);border-color:var(--crit)">↩ Reset to default (undo overlay)</button>` : ''}
          <span style="font-size:12px;color:var(--muted)">Writes go to <code>/data/frameworks/${escapeHtml(cur.name)}.md</code>. Every save is audited (procedence).</span>
        </div>
      </form>
    </div>
    ${history}`;
    return shellChrome('Persona · ' + name, body);
}

function coursesListPage(courses, message = null) {
    const banner = message ? `<div style="padding:10px 14px;background:var(--accent-tint);border-left:3px solid var(--accent);border-radius:8px;margin-bottom:12px;font-size:13.5px">${escapeHtml(message)}</div>` : '';
    const parts = [];
    parts.push(`<div class="titulo"><h2>Courses</h2><span class="meta">Each course has three artifacts: pedagogical content, competency framework, and a quiz index. Overlay edits persist without redeploy.</span></div>`);
    parts.push(banner);
    parts.push(`<div class="painel">
      <h3>Vector store · re-index</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 10px">Erica searches these artifacts via <code>search_knowledge</code> with <code>scope='courses'</code>. Re-index after edits so the vector store matches disk.</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600" id="reindexBtn">Re-index all courses</button>
        <span id="reindexStatus" style="font-size:12px;color:var(--muted)"></span>
      </div>
    </div>`);

    if (courses.length === 0) {
        parts.push(`<div class="painel" style="text-align:center;color:var(--muted);padding:32px 20px">No courses configured yet.</div>`);
    }
    for (const c of courses) {
        const meta = c.meta || { title: c.course_id, description: '' };
        // Pull each artifact's source + size so admin can see edit status at a glance.
        const artifactRows = coursesStore.ARTIFACT_KEYS.map((k) => {
            const a = coursesStore.readArtifact(c.course_id, k);
            if (!a) return { key: k, label: coursesStore.ARTIFACT_LABELS[k], missing: true };
            return {
                key: k, label: a.label, source: a.source, chars: a.chars,
                hash: a.hash.slice(0, 10), missing: false,
                empty: coursesStore.isArtifactEmpty(a)
            };
        });
        const artifactCards = artifactRows.map((a) => {
            let badge;
            let info;
            if (a.missing) {
                badge = '<span style="color:var(--muted);font-size:11px">no file</span>';
                info = '';
            } else {
                if (a.empty) {
                    badge = '<span style="color:var(--warn,#c07000);font-size:11px;font-weight:700">not started</span>';
                    info = `<div style="font-size:11px;color:var(--muted);margin-top:2px">placeholder · click to add content</div>`;
                } else if (a.source === 'overlay') {
                    badge = '<span style="color:var(--accent);font-size:11px;font-weight:700">edited</span>';
                    info = `<div style="font-size:11px;color:var(--muted);margin-top:2px">${a.chars.toLocaleString()} chars · <code style="font-size:10.5px">${a.hash}…</code></div>`;
                } else {
                    badge = '<span style="color:var(--muted);font-size:11px">default</span>';
                    info = `<div style="font-size:11px;color:var(--muted);margin-top:2px">${a.chars.toLocaleString()} chars · <code style="font-size:10.5px">${a.hash}…</code></div>`;
                }
            }
            // Link goes to the detail page with the tab pre-selected via hash.
            return `<a class="artifact-card" href="/admin/courses/${encodeURIComponent(c.course_id)}#tab-${encodeURIComponent(a.key)}"
                     style="display:flex;flex-direction:column;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);text-decoration:none;color:inherit;transition:all .12s ease;flex:1;min-width:0">
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
                  <span style="font-weight:650;font-size:13px">${escapeHtml(a.label)}</span>
                  ${badge}
                </div>
                ${info}
            </a>`;
        }).join('');
        parts.push(`<div class="painel">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:6px">
            <div>
              <h3 style="margin:0">${escapeHtml(meta.title || c.course_id)}</h3>
              <div style="font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:2px">course_id: ${escapeHtml(c.course_id)}</div>
            </div>
            <a href="/admin/courses/${encodeURIComponent(c.course_id)}" style="font-size:12.5px">Open detail →</a>
          </div>
          ${meta.description ? `<p style="font-size:13.5px;color:var(--ink2);margin:6px 0 12px">${escapeHtml(meta.description)}</p>` : ''}
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${artifactCards}</div>
        </div>`);
    }
    parts.push(`
    <div class="painel">
      <h3>Add a new course</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 10px">Creates the shell — you edit content next. course_id must be lowercase letters, digits, dashes, up to 63 chars.</p>
      <form method="POST" action="/admin/courses" style="display:grid;grid-template-columns:minmax(180px,1fr) minmax(240px,2fr) auto;gap:8px;align-items:end">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">
          course_id
          <input name="course_id" required pattern="[a-z0-9][a-z0-9_-]{0,62}" placeholder="e.g. new-hospitality-course">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">
          Title
          <input name="title" required placeholder="e.g. Advanced Hospitality Service">
        </label>
        <button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Create course</button>
      </form>
    </div>`);
    parts.push(`<style>.artifact-card:hover { border-color:var(--accent) !important; transform:translateY(-1px); box-shadow:0 3px 8px -2px var(--ring-hi); }</style>`);
    parts.push(`<script>
      (function () {
        const btn = document.getElementById('reindexBtn');
        const st = document.getElementById('reindexStatus');
        btn?.addEventListener('click', async () => {
          btn.disabled = true; st.textContent = 'starting…';
          try {
            const r = await fetch('/api/admin/dev/init-courses-store', { method: 'POST', credentials: 'include' });
            if (!r.ok || !r.body) { st.textContent = 'error ' + r.status; return; }
            const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let i = 0, total = 0;
            while (true) {
              const { value, done } = await reader.read(); if (done) break;
              buf += dec.decode(value, { stream: true }); let idx;
              while ((idx = buf.indexOf('\\n\\n')) !== -1) {
                const rec = buf.slice(0, idx).trim(); buf = buf.slice(idx + 2);
                if (!rec.startsWith('data:')) continue;
                let evt; try { evt = JSON.parse(rec.slice(5).trim()); } catch (_) { continue; }
                if (evt.type === 'start') { total = evt.count; st.textContent = 'uploading 0/' + total; }
                else if (evt.type === 'file') { i = evt.i; st.textContent = 'uploading ' + i + '/' + total + ' — ' + evt.relative; }
                else if (evt.type === 'indexed') { st.textContent = 'indexed: ' + evt.completed + ' ok, ' + (evt.failed || 0) + ' failed'; }
                else if (evt.type === 'done') { st.textContent = 'done · store ' + (evt.storeId || '') + ' — set COURSES_STORE_ID and it takes effect on next restart'; }
                else if (evt.type === 'error') { st.textContent = 'error: ' + evt.message; }
              }
            }
          } catch (err) { st.textContent = 'network error: ' + err.message; }
          finally { btn.disabled = false; }
        });
      })();
    </script>`);
    return shellChrome('Courses', parts.join('\n'));
}

function courseDetailPage(courseId, savedMessage = null) {
    const meta = coursesStore.readMeta(courseId);
    if (!meta) return shellChrome('Course', `<div class="painel"><p style="color:var(--muted)">Course <code>${escapeHtml(courseId)}</code> not found.</p></div>`);
    const artifacts = coursesStore.ARTIFACT_KEYS.map((k) => coursesStore.readArtifact(courseId, k) || {
        key: k, label: coursesStore.ARTIFACT_LABELS[k], missing: true, chars: 0, text: ''
    });
    const banner = savedMessage ? `<div style="padding:10px 14px;background:var(--accent-tint);border-left:3px solid var(--accent);border-radius:8px;margin-bottom:12px;font-size:13.5px">${escapeHtml(savedMessage)}</div>` : '';
    const body = `
    <div class="titulo">
      <div>
        <h2>${escapeHtml(meta.title || courseId)}</h2>
        <div style="font-size:11.5px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:2px">course_id: ${escapeHtml(courseId)}</div>
      </div>
      <a href="/admin/courses" class="botao">← All courses</a>
    </div>
    ${banner}
    <div class="painel">
      <h3>Metadata</h3>
      <form method="POST" action="/admin/courses/${encodeURIComponent(courseId)}/meta" style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Title
          <input name="title" value="${escapeHtml(meta.title || '')}">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Description (shown on the courses list and in Erica's context hints)
          <textarea name="description" rows="3">${escapeHtml(meta.description || '')}</textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Reason (audit)
          <input name="reason" placeholder="e.g. Eric: shorter description for the courses gallery">
        </label>
        <div><button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Save metadata</button></div>
      </form>
    </div>

    <div class="painel">
      <h3>Artifacts</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 12px">Each course is split into three editable pieces. Click a tab to view or edit.</p>
      <div class="artifact-tabs" style="display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:14px">
        ${artifacts.map((a, i) => `<button type="button" class="artifact-tab ${i === 0 ? 'active' : ''}" data-tab="${a.key}"
          style="font:inherit;font-size:13px;padding:8px 14px;border:0;background:transparent;color:var(--ink2);cursor:pointer;border-bottom:2px solid transparent">${escapeHtml(a.label)}</button>`).join('')}
      </div>
      ${artifacts.map((a, i) => `
        <section class="artifact-pane" data-pane="${a.key}" style="display:${i === 0 ? 'block' : 'none'}">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <div style="font-size:12.5px;color:var(--muted)">
              Source: ${a.missing ? '<span>none — will be created on save</span>' : (a.source === 'overlay' ? '<span style="color:var(--accent);font-weight:600">overlay</span> · ' + a.chars.toLocaleString() + ' chars · <code style="font-size:11px">' + escapeHtml((a.hash || '').slice(0, 12)) + '…</code>' : '<span style="color:var(--muted)">default</span> · ' + a.chars.toLocaleString() + ' chars')}
            </div>
            ${(!a.missing && a.source === 'overlay') ? `<form method="POST" action="/admin/courses/${encodeURIComponent(courseId)}/${encodeURIComponent(a.key)}/reset" onsubmit="return confirm('Remove overlay and revert to default?')" style="margin:0"><button class="botao" style="font-size:12px;color:var(--crit);border-color:var(--crit)">Reset to default</button></form>` : ''}
          </div>
          <form method="POST" action="/admin/courses/${encodeURIComponent(courseId)}/${encodeURIComponent(a.key)}" style="display:flex;flex-direction:column;gap:10px">
            <textarea name="text" rows="26" style="font:12.5px ui-monospace,Consolas,monospace;width:100%;box-sizing:border-box">${escapeHtml(a.text || '')}</textarea>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Reason (audit)
              <input name="reason" placeholder="e.g. Eric: fix typo in section 3">
            </label>
            <div><button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Save ${escapeHtml(a.label)}</button>
              <span style="font-size:12px;color:var(--muted);margin-left:8px">Then re-index on the Courses page so Erica sees the change.</span>
            </div>
          </form>
        </section>
      `).join('')}
    </div>

    <div class="painel" style="border-color:rgba(208,59,59,.4)">
      <h3 style="color:var(--crit)">Danger zone</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 10px">Delete this course entirely. Removes the overlay directory on the volume; anything in the repo-baked defaults for this id stays until removed via source control. Every artifact write for this course is preserved in the audit log.</p>
      <form method="POST" action="/admin/courses/${encodeURIComponent(courseId)}/delete" data-danger-title="${escapeHtml(meta.title || courseId)}">
        <input type="hidden" name="confirm" value="1">
        <button class="botao" style="color:var(--crit);border-color:var(--crit)">Delete course</button>
      </form>
      <script>
        (function () {
          // Confirm dialog attaches after DOM so the title is read from a
          // data-* attribute — that avoids the double-decode XSS the naive
          // onsubmit=confirm('...' + escapeHtml(title) + '...') pattern has
          // (HTML entities decode BEFORE the JS parser runs, so a title
          // containing "'-alert(1)-'" would break out of the JS string).
          document.querySelectorAll('form[data-danger-title]').forEach(function (f) {
            f.addEventListener('submit', function (e) {
              var t = f.getAttribute('data-danger-title') || 'this course';
              if (!confirm('Delete course "' + t + '"? This cannot be undone through the UI.')) {
                e.preventDefault();
              }
            });
          });
        })();
      </script>
    </div>

    <style>
      .artifact-tab.active { color:var(--ink) !important; font-weight:600; border-bottom-color:var(--accent) !important; }
      .artifact-tab:hover { color:var(--ink); }
    </style>
    <script>
      (function () {
        const tabs = document.querySelectorAll('.artifact-tab');
        const panes = document.querySelectorAll('.artifact-pane');
        function activate(key) {
          tabs.forEach((x) => x.classList.toggle('active', x.dataset.tab === key));
          panes.forEach((p) => { p.style.display = p.dataset.pane === key ? 'block' : 'none'; });
        }
        tabs.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
        // Honour ?tab=... OR #tab-... from the URL so links from the course
        // list can jump straight into the right artifact editor. The wanted
        // value is checked against the DOM tab set (safe list of known keys)
        // rather than fed into a CSS selector — a hash like "#tab-quote"
        // would otherwise throw a SyntaxError and break the whole tab init.
        function fromUrl() {
          const h = location.hash || '';
          if (h.startsWith('#tab-')) return h.slice(5);
          const q = new URLSearchParams(location.search);
          return q.get('tab');
        }
        const validTabs = Array.from(tabs).map((t) => t.dataset.tab);
        function safeActivate(w) {
          if (w && validTabs.indexOf(w) !== -1) activate(w);
        }
        safeActivate(fromUrl());
        window.addEventListener('hashchange', () => safeActivate(fromUrl()));
      })();
    </script>`;
    return shellChrome('Course · ' + (meta.title || courseId), body);
}

// ---------- Quizzes admin ----------

function quizzesListPage(quizzes, message = null) {
    const banner = message ? `<div style="padding:10px 14px;background:var(--accent-tint);border-left:3px solid var(--accent);border-radius:8px;margin-bottom:12px;font-size:13.5px">${escapeHtml(message)}</div>` : '';
    const rows = quizzes.map((q) => {
        const m = q.meta || {};
        const c = quizzesStore.readContent(q.quiz_id);
        const src = c?.source === 'overlay'
            ? '<span style="color:var(--accent);font-weight:600">edited</span>'
            : (c ? '<span style="color:var(--muted)">default</span>' : '<span style="color:var(--muted)">empty</span>');
        return `<tr>
          <td><a href="/admin/quizzes/${encodeURIComponent(q.quiz_id)}">${escapeHtml(m.title || q.quiz_id)}</a>
            <div style="font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase">${escapeHtml(q.quiz_id)}</div>
          </td>
          <td style="font-size:13px;color:var(--ink2)">${escapeHtml((m.description || '').slice(0, 140))}</td>
          <td style="font-size:12px">${src}</td>
          <td class="num">${c?.chars || 0}</td>
        </tr>`;
    }).join('');
    const body = `
    <div class="titulo"><h2>Quizzes</h2><span class="meta">Standalone assessments on the platform (Emotional Intelligence, etc). Independent of courses — a course may reference quizzes, but each quiz is managed here.</span></div>
    ${banner}
    <div class="painel">
      <h3>Vector store · re-index</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 10px">Quizzes ship to Erica in the courses vector store (scope='courses'). Re-index on the Courses page after edits so the vector store matches disk.</p>
      <div><a class="botao" href="/admin/courses">Go to Courses → Re-index</a></div>
    </div>
    <div class="painel">
      <h3>All quizzes</h3>
      <table>
        <thead><tr><th>Title</th><th>Description</th><th>Source</th><th class="num">Chars</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px 0">No quizzes yet. Add the first one below.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="painel">
      <h3>Add a new quiz</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 10px">Creates a new quiz with an empty content template. You can edit title, description, purpose, source URL, and content on the next page.</p>
      <form method="POST" action="/admin/quizzes" style="display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:end">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">
          quiz_id (lowercase, dash/underscore)
          <input name="quiz_id" required pattern="[a-z0-9][a-z0-9_-]{0,32}" placeholder="e.g. ei">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">
          Title
          <input name="title" required placeholder="e.g. Emotional Intelligence">
        </label>
        <button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Create quiz</button>
      </form>
    </div>`;
    return shellChrome('Quizzes', body);
}

function quizDetailPage(quizId, savedMessage = null) {
    const q = quizzesStore.readQuiz(quizId);
    if (!q) return shellChrome('Quiz', `<div class="painel"><p style="color:var(--muted)">Quiz <code>${escapeHtml(quizId)}</code> not found.</p></div>`);
    const banner = savedMessage ? `<div style="padding:10px 14px;background:var(--accent-tint);border-left:3px solid var(--accent);border-radius:8px;margin-bottom:12px;font-size:13.5px">${escapeHtml(savedMessage)}</div>` : '';
    const content = q.content;
    const body = `
    <div class="titulo">
      <div>
        <h2>${escapeHtml(q.title || quizId)}</h2>
        <div style="font-size:11.5px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:2px">quiz_id: ${escapeHtml(quizId)}</div>
      </div>
      <a href="/admin/quizzes" class="botao">← All quizzes</a>
    </div>
    ${banner}
    <div class="painel">
      <h3>Metadata</h3>
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 10px">Semantic only. URLs, question wording, exact scores stay on the Wix side and reach Erica via <code>preparation</code>. This admin captures what the quiz <em>means</em>.</p>
      <form method="POST" action="/admin/quizzes/${encodeURIComponent(quizId)}/meta" style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Title
          <input name="title" value="${escapeHtml(q.title || '')}">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Description (short teaser, shown on the quiz list)
          <textarea name="description" rows="2">${escapeHtml(q.description || '')}</textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Purpose (what this quiz measures — used by Erica when a learner asks about it)
          <textarea name="purpose" rows="3">${escapeHtml(q.purpose || '')}</textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Reason (audit)
          <input name="reason" placeholder="e.g. Eric: tighten description for gallery">
        </label>
        <div><button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Save metadata</button></div>
      </form>
    </div>
    <div class="painel">
      <h3>Semantic content</h3>
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 10px">What the quiz treats · what it looks at · what it does NOT try to do · common misconceptions. This is what Erica retrieves to coach a learner about the quiz. <strong>No URLs, no question text, no scoring tables here</strong> — those live in the Wix preparation payload.</p>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <div style="font-size:12.5px;color:var(--muted)">
          Source: ${content ? (content.source === 'overlay' ? '<span style="color:var(--accent);font-weight:600">overlay</span> · ' + content.chars.toLocaleString() + ' chars · <code style="font-size:11px">' + escapeHtml((content.hash || '').slice(0, 12)) + '…</code>' : '<span style="color:var(--muted)">default</span> · ' + content.chars.toLocaleString() + ' chars') : '<span>none — will be created on save</span>'}
        </div>
        ${(content && content.source === 'overlay') ? `<form method="POST" action="/admin/quizzes/${encodeURIComponent(quizId)}/content/reset" onsubmit="return confirm('Remove overlay and revert to default?')" style="margin:0"><button class="botao" style="font-size:12px;color:var(--crit);border-color:var(--crit)">Reset to default</button></form>` : ''}
      </div>
      <form method="POST" action="/admin/quizzes/${encodeURIComponent(quizId)}/content" style="display:flex;flex-direction:column;gap:10px">
        <textarea name="text" rows="26" style="font:12.5px ui-monospace,Consolas,monospace">${escapeHtml(content?.text || '')}</textarea>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Reason (audit)
          <input name="reason" placeholder="e.g. Eric: expand 'what it does NOT measure' with new example">
        </label>
        <div><button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Save content</button>
          <span style="font-size:12px;color:var(--muted);margin-left:8px">Then re-index on the Courses page so Erica sees the change.</span>
        </div>
      </form>
    </div>`;
    return shellChrome('Quiz · ' + (q.title || quizId), body);
}

function auditPage(entries, verified) {
    const rows = entries.map((e, i) => {
        const meta = e.meta ? escapeHtml(JSON.stringify(e.meta).slice(0, 200)) : '';
        return `<tr class="border-b border-gray-100"><td class="px-2 py-2 text-xs font-mono">${escapeHtml(e.t)}</td><td class="px-2 py-2 text-xs">${escapeHtml(e.actor)}</td><td class="px-2 py-2 text-xs font-semibold">${escapeHtml(e.action)}</td><td class="px-2 py-2 text-xs">${escapeHtml(e.target || '')}</td><td class="px-2 py-2 text-[10px] text-gray-600 font-mono">${meta}</td><td class="px-2 py-2 text-[10px] font-mono text-gray-500" title="${escapeHtml(e.hash)}">${escapeHtml(e.hash?.slice(0,10) || '')}</td></tr>`;
    }).join('');
    const banner = verified?.ok
        ? '<div class="rounded-lg bg-teal-50 border border-teal-200 text-teal-800 text-sm px-3 py-2">Chain verified · ' + (verified.count || 0) + ' entries.</div>'
        : `<div class="rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2">Chain BROKEN at index ${verified?.brokenAt} · ${escapeHtml(verified?.reason || verified?.error || 'unknown')}</div>`;
    const body = `
    ${banner}
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Audit trail (newest first)</div>
      <table class="w-full text-sm"><thead class="bg-gray-50 text-xs uppercase text-gray-600"><tr><th class="px-2 py-2 text-left">When</th><th class="px-2 py-2 text-left">Actor</th><th class="px-2 py-2 text-left">Action</th><th class="px-2 py-2 text-left">Target</th><th class="px-2 py-2 text-left">Meta</th><th class="px-2 py-2 text-left">Hash</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="px-2 py-6 text-center text-xs text-gray-500">No audit entries yet.</td></tr>'}</tbody></table>
    </section>`;
    return shellChrome('Audit', body);
}

function simulatorPage(prefill = {}) {
    const escVal = (s) => escapeHtml(s || '');
    const defaultGuardrails = prefill.guardrails || '';
    const defaultUserPersona = prefill.userPersona
        || 'You are a mid-career professional feeling stuck in your current role. Considering a startup offer, alternating between excitement and second-guessing.';
    const defaultSeed = prefill.seedMessage
        || 'I got an offer from a startup that would double my responsibility but half my stability. I have been going in circles for a week.';
    const body = `
    <style>
      /* --- Live iframe simulator (primary mode) --- */
      .sim-mode-tabs { display:flex; gap:6px; margin-bottom:12px; }
      .sim-mode-tabs button { font:inherit; font-size:13px; padding:8px 14px; border-radius:8px 8px 0 0;
        border:1px solid var(--line); border-bottom:0; background:var(--soft); color:var(--ink2); cursor:pointer; }
      .sim-mode-tabs button.active { background:var(--card); color:var(--ink); font-weight:600; border-color:var(--line); position:relative; }
      .sim-mode-tabs button.active::after { content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px; background:var(--card); }
      .sim-tab { display:none; }
      .sim-tab.active { display:block; }
      .live-bar { display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--card);
        border:1px solid var(--line); border-radius:10px 10px 0 0; border-bottom:0; }
      .live-bar .badge { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
        color:#fff; background:var(--grad); padding:4px 10px; border-radius:999px; }
      .live-bar .grow { flex:1; }
      .live-bar select, .live-bar input { font:13px inherit; padding:6px 8px; border-radius:7px;
        border:1px solid var(--line); background:var(--bg); color:var(--ink); }
      .live-frame { width:100%; height:calc(100vh - 260px); min-height:520px; border:1px solid var(--line);
        border-radius:0 0 10px 10px; background:var(--bg); box-shadow:0 1px 3px var(--ring); }
      .live-help { margin-top:10px; font-size:12.5px; color:var(--muted); }
      .live-help code { background:var(--soft); padding:1px 5px; border-radius:4px; font-size:11.5px; }
      /* --- Persona mock simulator (secondary mode) --- */
      .sim-setup { display:grid; grid-template-columns: minmax(240px, 1fr) minmax(380px, 1.8fr) minmax(240px, 1fr); gap:12px; align-items:stretch; }
      .sim-setup .col { display:flex; flex-direction:column; gap:8px; padding:12px; background:var(--soft);
        border:1px solid var(--line); border-radius:10px; }
      .sim-setup .col h4 { font:600 11px/1 -apple-system,"Segoe UI",Roboto,sans-serif; margin:0 0 2px;
        text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
      .sim-setup label { display:flex; flex-direction:column; gap:3px; font-size:11.5px; color:var(--muted); }
      .sim-setup input, .sim-setup textarea, .sim-setup select { font:13px inherit; }
      .sim-setup textarea { font:12px ui-monospace,Consolas,monospace; resize:vertical; }
      .sim-bar { display:flex; align-items:center; gap:10px; margin-top:12px; padding:10px 14px;
        background:var(--card); border:1px solid var(--line); border-radius:10px;
        box-shadow:0 1px 3px var(--ring); position:sticky; top:0; z-index:5; }
      .sim-bar .grow { flex:1; }
      .sim-bar #convStatus { font-size:12px; color:var(--muted); }
      .sim-bar .primary { background:var(--grad); color:#fff; border-color:transparent; font-weight:700;
        padding:8px 16px; box-shadow:0 3px 10px -2px var(--accent-tint); }
      .sim-bar .stop { background:var(--crit); color:#fff; border-color:transparent; font-weight:600; padding:8px 14px; }
      .turno { padding:11px 14px; border-radius:10px; border:1px solid var(--line); position:relative;
        animation: msgIn .2s ease-out; }
      .turno.user { background:var(--soft); }
      .turno.coach { background:var(--accent-tint); border-color:transparent; }
      .turno .rot { font:600 10.5px/1 inherit; text-transform:uppercase; letter-spacing:.07em; margin-bottom:4px; }
      .turno.user .rot { color:var(--muted); }
      .turno.coach .rot { color:var(--accent); }
      .turno .body { font-size:14px; white-space:pre-wrap; color:var(--ink); }
      .turno .meta { display:flex; gap:8px; align-items:center; font-size:10.5px; color:var(--muted); margin-top:5px; }
      .turno .acao { position:absolute; top:8px; right:8px; display:flex; gap:6px; opacity:0; transition:opacity .15s ease; }
      .turno:hover .acao { opacity:1; }
      .turno .acao button { font:11px inherit; padding:3px 8px; border-radius:6px; border:1px solid var(--line);
        background:var(--card); color:var(--ink2); cursor:pointer; }
      .turno .acao button:hover { color:var(--ink); border-color:var(--accent); }
      .seed-row { display:flex; gap:6px; align-items:center; margin-bottom:6px; }
      .seed-row select { flex:1; font-size:12px; padding:4px 6px; }
      .transcript-empty { padding:24px; text-align:center; color:var(--muted); font-size:13px;
        border:1px dashed var(--line); border-radius:10px; margin-top:12px; }
    </style>

    <div class="titulo">
      <h2>Simulator</h2>
      <span class="meta">Interact with the real coach in an isolated iframe — pills, animations, latency, everything. CleverTap events are suppressed so testing does not pollute v2.</span>
    </div>

    <div class="sim-mode-tabs">
      <button type="button" class="active" data-tab="live">Live coach (iframe)</button>
      <button type="button" data-tab="persona">Persona mock (auto-generated conversation)</button>
    </div>

    <section class="sim-tab active" data-tab="live">
      <div class="live-bar">
        <span class="badge">Simulator · CleverTap OFF</span>
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px">Scenario
          <select id="liveScenario">
            <option value="/simulator-host/quiz-report.html?erica=preview&simulator=1">Quiz report (EI scores)</option>
            <option value="/simulator-host/course.html?erica=preview&simulator=1">Course lesson (Trait Awareness)</option>
            <option value="/simulator-host/index.html?erica=preview&simulator=1">Homepage (dashboard)</option>
            <option value="/index.html?simulator=1&caller=admin-simulator">Coach only (no host page)</option>
          </select>
        </label>
        <span class="grow"></span>
        <button type="button" class="botao" id="liveReload" title="Force a fresh coach session">↻ Restart</button>
        <button type="button" class="botao" id="liveOpenNew" title="Open in a new tab">↗ New tab</button>
      </div>
      <iframe id="liveFrame" class="live-frame" src=""
        allow="microphone; autoplay; clipboard-read; clipboard-write"
        title="Coach v3 (simulator mode)"></iframe>
      <p class="live-help">
        Full site-embeds-coach loop. Host pages under <code>/simulator-host/</code> match Wix's DOM layout and load the
        same <code>bridge.js</code> production uses — the coach sees the report/course content via <code>REQUEST_PAGE_CONTEXT</code>
        and coaches contextually. Session is tagged <code>caller=admin-simulator</code>, marked <code>tester=true</code>,
        <code>syncActivityForSession</code> skipped, and <code>trackCoachEvent</code> suppressed client-side — nothing
        leaks to CleverTap or the v2 dashboards.
      </p>
    </section>

    <section class="sim-tab" data-tab="persona">

    <form id="convForm">
      <div class="sim-setup">
        <div class="col">
          <h4>Coach</h4>
          <label>Preset (from frameworks library)
            <select name="preset" id="presetSel"><option value="">— none / custom —</option></select>
          </label>
          <label>Name
            <input name="coachName" value="${escVal(prefill.coachName || 'Erica')}">
          </label>
          <label>Extra directive
            <input name="extraDirective" value="${escVal(prefill.extraDirective || '')}" placeholder="'Push harder' / 'Be softer'">
          </label>
          <label>Max turns (user + coach)
            <input name="maxTurns" type="number" min="2" max="20" step="2" value="${escVal(prefill.maxTurns || '8')}">
          </label>
        </div>
        <div class="col">
          <h4>Guardrails / persona rules</h4>
          <label style="flex:1">
            <textarea name="guardrails" id="guardrails" rows="14" placeholder="Select a preset above, or paste your own coach system rules here.">${escVal(defaultGuardrails)}</textarea>
          </label>
        </div>
        <div class="col">
          <h4>User (fake)</h4>
          <label>Seed from a real session
            <div class="seed-row">
              <select id="seedSel"><option value="">— none —</option></select>
              <button type="button" class="botao" id="seedApply" style="font-size:11px;padding:3px 8px">Apply</button>
            </div>
          </label>
          <label>Persona
            <textarea name="userPersona" rows="5">${escVal(defaultUserPersona)}</textarea>
          </label>
          <label style="flex:1">Seed message (first user turn)
            <textarea name="seedMessage" id="seedMessage" rows="4">${escVal(defaultSeed)}</textarea>
          </label>
        </div>
      </div>
      <div class="sim-bar">
        <button class="botao primary" id="convRun" type="submit">▶ Run conversation</button>
        <button class="botao stop" id="convStop" type="button" style="display:none">■ Stop</button>
        <span id="convStatus"></span>
        <span class="grow"></span>
        <button type="button" class="botao" id="convClear" title="Clear the transcript below">Clear transcript</button>
      </div>
    </form>

    <div id="convTranscript" style="margin-top:14px;display:flex;flex-direction:column;gap:10px"></div>
    <div id="transcriptEmpty" class="transcript-empty">Transcript will appear here as turns stream in. Each coach turn gets a 🔄 regenerate button on hover.</div>

    </section>

    <details style="margin-top:16px">
      <summary style="cursor:pointer;padding:8px 0;color:var(--muted);font-size:12.5px">Single-turn (legacy — one user message → one reply)</summary>
      <div class="painel" style="margin-top:8px">
        <form id="simForm" style="display:flex;flex-direction:column;gap:8px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <label style="font-size:12px;color:var(--muted)">Persona name
              <input name="personaName" value="${escVal(prefill.personaName || 'Erica')}" style="margin-top:3px">
            </label>
            <label style="font-size:12px;color:var(--muted)">Extra directive
              <input name="extraDirective" style="margin-top:3px">
            </label>
          </div>
          <label style="font-size:12px;color:var(--muted)">Guardrails
            <textarea name="guardrails" rows="4" style="font:12px ui-monospace,Consolas,monospace;margin-top:3px">${escVal(defaultGuardrails)}</textarea>
          </label>
          <label style="font-size:12px;color:var(--muted)">User message
            <textarea name="userMessage" rows="3" style="margin-top:3px">${escVal(prefill.userMessage || 'I feel stuck. I have a big decision to make.')}</textarea>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:var(--muted)">
            <label>Replay session id
              <input name="replaySessionId" placeholder="s-…" style="margin-top:3px;font:12px ui-monospace,Consolas,monospace">
            </label>
            <label>Replay turn index
              <input name="replayTurnIndex" type="number" min="0" style="margin-top:3px">
            </label>
          </div>
          <button class="botao" style="background:var(--accent);color:#fff;border-color:transparent;font-weight:600">Simulate one turn</button>
        </form>
        <div id="results" style="margin-top:10px;display:none">
          <div id="original-block" style="display:none;margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Original coach response</div>
            <div id="original" style="margin-top:3px;font-size:13.5px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:9px;white-space:pre-wrap"></div>
          </div>
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:.05em">Simulated</div>
            <div id="simulated" style="margin-top:3px;font-size:13.5px;background:var(--accent-tint);border:1px solid var(--line);border-radius:8px;padding:9px;white-space:pre-wrap"></div>
            <div id="meta" style="margin-top:3px;font-size:11px;color:var(--muted)"></div>
          </div>
          <details style="margin-top:6px">
            <summary style="cursor:pointer;font-size:12px;color:var(--muted)">Instructions used</summary>
            <pre id="instr" style="margin-top:5px;font-size:11px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:7px;white-space:pre-wrap"></pre>
          </details>
        </div>
      </div>
    </details>

    <script>
      (function () {
        // ---- Tab switcher: live iframe vs persona mock ----
        const tabs = document.querySelectorAll('.sim-mode-tabs button');
        const panels = document.querySelectorAll('.sim-tab');
        tabs.forEach((btn) => btn.addEventListener('click', () => {
          const t = btn.dataset.tab;
          tabs.forEach((b) => b.classList.toggle('active', b === btn));
          panels.forEach((p) => p.classList.toggle('active', p.dataset.tab === t));
        }));

        // ---- Live iframe simulator: host page embeds the coach ----
        const liveFrame = document.getElementById('liveFrame');
        const liveScenario = document.getElementById('liveScenario');
        const liveReload = document.getElementById('liveReload');
        const liveOpenNew = document.getElementById('liveOpenNew');
        function buildLiveUrl() {
          const base = liveScenario.value;
          // Cache-bust so restarting always lands on a fresh session id.
          const sep = base.includes('?') ? '&' : '?';
          return base + sep + '_v=sim' + Date.now().toString(36);
        }
        function loadLive() { liveFrame.src = buildLiveUrl(); }
        liveScenario.addEventListener('change', loadLive);
        liveReload.addEventListener('click', loadLive);
        liveOpenNew.addEventListener('click', () => { window.open(buildLiveUrl(), '_blank'); });
        loadLive();

        // ---- Persona mock simulator (secondary mode) ----
        // Local runtime state — the transcript is a plain JS array of turn
        // objects so we can regenerate/fork by trimming and re-sending.
        const transcript = [];
        let running = false;
        let abortController = null;

        function el(tag, cls, text) {
          const n = document.createElement(tag);
          if (cls) n.className = cls;
          if (text != null) n.textContent = text;
          return n;
        }
        const convForm = document.getElementById('convForm');
        const convTranscript = document.getElementById('convTranscript');
        const convStatus = document.getElementById('convStatus');
        const convRun = document.getElementById('convRun');
        const convStop = document.getElementById('convStop');
        const convClear = document.getElementById('convClear');
        const presetSel = document.getElementById('presetSel');
        const seedSel = document.getElementById('seedSel');
        const seedApply = document.getElementById('seedApply');
        const seedMessage = document.getElementById('seedMessage');
        const guardrails = document.getElementById('guardrails');
        const transcriptEmpty = document.getElementById('transcriptEmpty');

        // ---- Load presets from the frameworks library ----
        (async () => {
          try {
            const r = await fetch('/api/admin/simulator/presets', { credentials: 'include' });
            if (!r.ok) return;
            const { presets } = await r.json();
            for (const p of (presets || [])) {
              const o = document.createElement('option');
              o.value = p.id; o.textContent = p.name + (p.source === 'overlay' ? ' (edited)' : '');
              o.dataset.guardrails = p.guardrails || '';
              presetSel.appendChild(o);
            }
          } catch (_) { /* non-fatal */ }
        })();
        presetSel?.addEventListener('change', () => {
          const opt = presetSel.selectedOptions[0];
          if (!opt || !opt.dataset.guardrails) return;
          guardrails.value = opt.dataset.guardrails;
          // Bump coach name to the preset name unless the user changed it.
          const nameInput = convForm.querySelector('input[name="coachName"]');
          if (nameInput && (!nameInput.value || nameInput.value === 'Erica')) nameInput.value = opt.value;
        });

        // ---- Load seed candidates from real sessions ----
        (async () => {
          try {
            const r = await fetch('/api/admin/simulator/seeds?limit=12', { credentials: 'include' });
            if (!r.ok) return;
            const { seeds } = await r.json();
            for (const s of (seeds || [])) {
              const o = document.createElement('option');
              o.value = s.sessionId;
              const label = s.actor + ' · ' + (s.turns || 0) + ' turns · ' + (s.seed.slice(0, 60));
              o.textContent = label;
              o.dataset.seed = s.seed;
              seedSel.appendChild(o);
            }
            if (!seeds?.length) {
              const o = document.createElement('option');
              o.disabled = true; o.textContent = '(no non-redacted sessions available)';
              seedSel.appendChild(o);
            }
          } catch (_) {}
        })();
        seedApply?.addEventListener('click', () => {
          const opt = seedSel.selectedOptions[0];
          if (!opt || !opt.dataset.seed) return;
          seedMessage.value = opt.dataset.seed;
        });

        // ---- Turn rendering ----
        function turnCard(idx, role, text, meta) {
          const card = el('div', 'turno ' + role);
          card.dataset.idx = String(idx);
          const rot = el('div', 'rot', role === 'coach' ? 'Coach' : 'User');
          const body = el('div', 'body'); body.textContent = text;
          card.appendChild(rot); card.appendChild(body);
          if (meta && (meta.ms || meta.model || meta.replay)) {
            const m = el('div', 'meta');
            if (meta.replay) m.appendChild(el('span', null, '↻ from prior'));
            if (meta.model) m.appendChild(el('span', null, meta.model));
            if (meta.ms) m.appendChild(el('span', null, meta.ms + 'ms'));
            card.appendChild(m);
          }
          // Regenerate button appears only on the LATEST coach turn.
          if (role === 'coach') {
            const acao = el('div', 'acao');
            const reg = el('button', null, '🔄 regenerate');
            reg.title = 'Discard from this coach turn and re-run';
            reg.addEventListener('click', () => regenerateFrom(idx));
            acao.appendChild(reg);
            card.appendChild(acao);
          }
          return card;
        }
        function refreshTranscript() {
          convTranscript.innerHTML = '';
          transcript.forEach((t, i) => convTranscript.appendChild(turnCard(i, t.role, t.text, t)));
          transcriptEmpty.style.display = transcript.length ? 'none' : '';
        }

        // ---- Run a simulation ----
        async function runSimulation({ priorTranscript, seedOverride }) {
          if (running) return;
          running = true;
          convRun.style.display = 'none';
          convStop.style.display = '';
          const fd = new FormData(convForm);
          const payload = {
            coachName: fd.get('coachName'),
            guardrails: fd.get('guardrails'),
            extraDirective: fd.get('extraDirective'),
            userPersona: fd.get('userPersona'),
            seedMessage: seedOverride != null ? seedOverride : fd.get('seedMessage'),
            maxTurns: parseInt(fd.get('maxTurns'), 10) || 8,
            priorTranscript: priorTranscript || []
          };
          // If we are continuing from a prior transcript, DO NOT reset our
          // local state — the SSE re-emits the prior turns with replay:true
          // and we ignore those.
          const priorLen = (priorTranscript || []).length;
          if (priorLen === 0) { transcript.length = 0; refreshTranscript(); }
          convStatus.textContent = priorLen ? 'regenerating from turn ' + priorLen + '…' : 'starting…';
          abortController = new AbortController();
          let coachTurns = 0;
          try {
            const r = await fetch('/api/admin/simulate-conversation', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: abortController.signal
            });
            if (!r.ok || !r.body) { convStatus.textContent = 'error ' + r.status; return; }
            const reader = r.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let idx;
              while ((idx = buf.indexOf('\\n\\n')) !== -1) {
                const record = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 2);
                if (!record.startsWith('data:')) continue;
                let evt; try { evt = JSON.parse(record.slice(5).trim()); } catch (_) { continue; }
                if (evt.type === 'start') { /* header */ }
                else if (evt.type === 'user_turn' || evt.type === 'coach_turn') {
                  const role = evt.type === 'user_turn' ? 'user' : 'coach';
                  if (evt.replay) continue; // replay of prior, already in state
                  transcript.push({ role, text: evt.text, ms: evt.ms, model: evt.model });
                  refreshTranscript();
                  const last = convTranscript.lastElementChild;
                  if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
                  if (role === 'coach') { coachTurns++; convStatus.textContent = 'running · ' + coachTurns + ' new coach turn(s)'; }
                } else if (evt.type === 'done') {
                  convStatus.textContent = 'done · ' + transcript.length + ' total turns';
                } else if (evt.type === 'error') {
                  convStatus.textContent = 'error: ' + evt.message;
                }
              }
            }
          } catch (err) {
            if (err.name === 'AbortError') convStatus.textContent = 'stopped';
            else convStatus.textContent = 'network error: ' + err.message;
          } finally {
            running = false; abortController = null;
            convRun.style.display = ''; convStop.style.display = 'none';
          }
        }
        convForm.addEventListener('submit', (e) => { e.preventDefault(); runSimulation({}); });
        convStop.addEventListener('click', () => { if (abortController) abortController.abort(); });
        convClear.addEventListener('click', () => { transcript.length = 0; refreshTranscript(); convStatus.textContent = ''; });
        function regenerateFrom(idx) {
          if (running) return;
          const trimmed = transcript.slice(0, idx);
          transcript.length = 0;
          for (const t of trimmed) transcript.push(t);
          refreshTranscript();
          const prior = trimmed.map((t) => ({ role: t.role, text: t.text }));
          runSimulation({ priorTranscript: prior });
        }

        // Legacy single-turn form.
        const simForm = document.getElementById('simForm');
        simForm?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(simForm);
          const payload = {
            personaName: fd.get('personaName'),
            guardrails: fd.get('guardrails'),
            extraDirective: fd.get('extraDirective'),
            userMessage: fd.get('userMessage')
          };
          const sid = (fd.get('replaySessionId') || '').trim();
          const idxRaw = (fd.get('replayTurnIndex') || '').trim();
          if (sid && idxRaw !== '') { payload.replaySessionId = sid; payload.replayTurnIndex = Number(idxRaw); }
          const results = document.getElementById('results');
          results.style.display = '';
          document.getElementById('simulated').textContent = 'thinking…';
          document.getElementById('meta').textContent = '';
          document.getElementById('original-block').style.display = 'none';
          try {
            const r = await fetch('/api/admin/simulate', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await r.json();
            if (data.error) { document.getElementById('simulated').textContent = 'error: ' + data.error; return; }
            document.getElementById('simulated').textContent = data.simulated?.text || '';
            document.getElementById('meta').textContent = 'model ' + (data.simulated?.model || '?') + ' · ' + (data.simulated?.ms || '?') + 'ms';
            document.getElementById('instr').textContent = data.simulated?.instructionsPreview || '';
            if (data.originalResponse) {
              document.getElementById('original').textContent = data.originalResponse;
              document.getElementById('original-block').style.display = '';
            }
          } catch (err) {
            document.getElementById('simulated').textContent = 'network error: ' + err.message;
          }
        });
      })();
    </script>`;
    return shellChrome('Simulator', body);
}

function studioPage() {
    const body = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
      <h2 class="text-sm font-semibold text-gray-900 mb-1">Studio agent</h2>
      <p class="text-xs text-gray-600 mb-4">Ask questions about what Erica did — the agent has read-only access to session logs, prompt snapshots, coaching frameworks and CleverTap activity. It cannot change anything yet (that's Phase 4).</p>
      <div id="chat" class="space-y-3 max-h-[60vh] overflow-y-auto border border-gray-200 rounded-xl p-3 bg-gray-50"></div>
      <form id="msgForm" class="flex items-end gap-2 mt-3">
        <textarea id="msg" rows="2" class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm resize-y" placeholder="Ex.: 'liste as 5 sessões mais recentes de hoje', 'na sessão X, por que Erica não chamou get_page_context?'"></textarea>
        <button class="rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm px-4 py-2 self-stretch">Ask</button>
      </form>
    </section>
    <script>
      const chat = document.getElementById('chat');
      let history = [];
      function append(role, text) {
        const wrap = document.createElement('div');
        wrap.className = role === 'user' ? 'text-right' : 'text-left';
        const bubble = document.createElement('div');
        bubble.className = 'inline-block max-w-[92%] rounded-xl px-3 py-2 text-sm ' +
          (role === 'user' ? 'bg-teal-600 text-white' : 'bg-white border border-gray-200 text-gray-800');
        bubble.textContent = text;
        wrap.appendChild(bubble);
        chat.appendChild(wrap);
        chat.scrollTop = chat.scrollHeight;
      }
      document.getElementById('msgForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const ta = document.getElementById('msg');
        const message = ta.value.trim();
        if (!message) return;
        append('user', message);
        ta.value = '';
        const busy = document.createElement('div');
        busy.className = 'text-left';
        busy.innerHTML = '<div class="inline-block text-xs text-gray-500 italic">thinking…</div>';
        chat.appendChild(busy);
        try {
          const r = await fetch('/api/admin/studio-chat', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history, message })
          });
          const data = await r.json();
          chat.removeChild(busy);
          if (data.error) { append('bot', 'error: ' + data.error); return; }
          history = data.history || history;
          append('bot', data.text || '(no response)');
        } catch (err) {
          chat.removeChild(busy);
          append('bot', 'network error: ' + err.message);
        }
      });
    </script>`;
    return shellChrome('Studio', body);
}

// ---------- Coach identity card (home hero) ----------
// Shows in one row: who Erica is (persona), what she's built from (context
// budget stacked bar), what feeds her at runtime (channel chips), and the
// scope of the semantic corpus behind her. Numbers labelled "measured" /
// "reported" / "estimated" so operators know the confidence level.
function renderCoachIdentityCard(budget, { coursesCount, quizzesCount, frameworksCount }) {
    const persona = budget.persona || 'unknown';
    const personaId = budget.personaId || persona;
    // Compose the stacked bar. Skip zero-length blocks (channel off).
    const blocks = (budget.blocks || []).filter((b) => b.chars > 0);
    const totalNonZero = blocks.reduce((s, b) => s + b.chars, 0) || 1;
    const palette = ['#0d9488', '#38bdf8', '#f59e0b', '#a78bfa', '#f472b6', '#22c55e', '#94a3b8', '#f87171'];
    const bar = blocks.map((b, i) => {
        const pct = (b.chars / totalNonZero) * 100;
        return `<div class="ci-seg" style="width:${pct.toFixed(2)}%;background:${palette[i % palette.length]}" title="${escapeHtml(b.name)}: ${b.chars} chars"></div>`;
    }).join('');
    const legend = blocks.map((b, i) => `<div class="ci-legend-row">
      <span class="ci-swatch" style="background:${palette[i % palette.length]}"></span>
      <span class="ci-legend-name">${escapeHtml(b.name)}</span>
      <span class="ci-legend-chars">${b.chars.toLocaleString('en-US')}<span class="ci-legend-unit"> chars</span></span>
      <span class="ci-src ci-src-${escapeHtml(b.source)}">${escapeHtml(b.source)}</span>
    </div>`).join('');

    // Real Time chips.
    const chips = (budget.channelsList || []).map((ch) => {
        const on = !!ch.enabled;
        return `<span class="ci-chip ${on ? 'on' : 'off'}" title="${escapeHtml(ch.purpose || '')}">${escapeHtml(ch.name)}</span>`;
    }).join('');

    const overCap = budget.total > budget.budget;
    const pctBar = Math.min(100, budget.percentUsed);
    const pctTone = overCap ? 'crit' : budget.percentUsed > 80 ? 'warn' : 'ok';

    const lastSess = budget.lastRealSession
        ? `<a href="/admin/sessions/${encodeURIComponent(budget.lastRealSession.sessionId)}" class="ci-last-link">${escapeHtml(budget.lastRealSession.sessionId.slice(0, 14))}…</a>
           <span class="ci-last-at">${escapeHtml((budget.lastRealSession.at || '').slice(11, 19))} UTC</span>`
        : `<span class="ci-last-empty">— waiting for the first live session to report</span>`;

    return `<style>
      .ci-hero { background:linear-gradient(135deg, var(--card) 0%, var(--accent-tint) 100%);
        border:1px solid transparent; border-radius:16px; padding:22px 24px;
        margin: 6px 0 22px; box-shadow: 0 4px 24px -12px var(--accent-tint), 0 1px 3px var(--ring); }
      .ci-hero-title { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:6px; }
      .ci-hero-title h3 { font-size:15.5px; font-weight:600; margin:0; color:var(--ink); }
      .ci-persona-tag { font:600 10.5px/1 -apple-system,"Segoe UI",Roboto,sans-serif; text-transform:uppercase;
        letter-spacing:.09em; padding:4px 10px; border-radius:999px; background:var(--card);
        color:var(--accent); border:1px solid var(--line); }
      .ci-persona-tag a { color:inherit; text-decoration:none; }
      .ci-persona-tag a:hover { text-decoration:underline; }
      .ci-hero-tag { font-size:11.5px; color:var(--muted); }
      .ci-grid { display:grid; grid-template-columns: minmax(320px, 1.4fr) minmax(240px, 1fr); gap: 22px; margin-top: 12px; }
      @media (max-width:820px) { .ci-grid { grid-template-columns: 1fr; } }
      .ci-col-title { font:600 10.5px/1 inherit; text-transform:uppercase; letter-spacing:.08em;
        color:var(--muted); margin-bottom:8px; display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
      .ci-col-title .ci-hint { text-transform:none; letter-spacing:normal; font-weight:400; font-size:11px; color:var(--muted); }
      .ci-bar-track { height:16px; border-radius:8px; background:var(--soft); overflow:hidden; display:flex;
        border:1px solid var(--line); }
      .ci-seg { height:100%; }
      .ci-bar-meta { display:flex; justify-content:space-between; margin-top:6px; font-size:12px; color:var(--muted); }
      .ci-bar-meta .ci-total { color:var(--ink2); font-weight:600; font-variant-numeric: tabular-nums; }
      .ci-bar-meta .ci-total.crit { color: var(--crit); }
      .ci-bar-meta .ci-total.warn { color: var(--warn); }
      .ci-legend { margin-top:10px; display:flex; flex-direction:column; gap:4px; }
      .ci-legend-row { display:grid; grid-template-columns: 12px 1fr auto auto; gap:8px; align-items:center;
        font-size:12px; padding:2px 0; }
      .ci-swatch { width:10px; height:10px; border-radius:3px; }
      .ci-legend-name { color:var(--ink2); }
      .ci-legend-chars { color:var(--muted); font-variant-numeric: tabular-nums; }
      .ci-legend-unit { color:var(--muted); opacity:.7; }
      .ci-src { font:600 9.5px/1 inherit; text-transform:uppercase; letter-spacing:.07em;
        padding:2px 6px; border-radius:6px; }
      .ci-src-measured { background:rgba(20, 184, 166, 0.10); color:var(--accent); }
      .ci-src-reported { background:rgba(20, 184, 166, 0.10); color:var(--accent); }
      .ci-src-estimated { background:rgba(180, 83, 9, 0.10); color:#b45309; }
      .ci-src-off { background:var(--soft); color:var(--muted); }
      .ci-src-missing { background:rgba(208, 59, 59, 0.10); color:var(--crit); }
      .ci-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
      .ci-chip { font:500 11.5px/1 inherit; padding:5px 10px; border-radius:999px;
        border:1px solid var(--line); background:var(--card); cursor:default; }
      .ci-chip.on { color:var(--accent); border-color:rgba(20,184,166,.35); background:rgba(20,184,166,.06); }
      .ci-chip.off { color:var(--muted); background:var(--soft); border-color:transparent; opacity:.65; }
      .ci-corpus { display:flex; gap:14px; margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); }
      .ci-corpus a { color:var(--ink2); font-size:12.5px; text-decoration:none; }
      .ci-corpus a:hover { color:var(--accent); text-decoration:underline; }
      .ci-corpus .n { font-weight:600; color:var(--ink); font-variant-numeric: tabular-nums; }
      .ci-last { font-size:11.5px; color:var(--muted); margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); }
      .ci-last-link { color:var(--accent); text-decoration:none; font-family:ui-monospace,Consolas,monospace; }
      .ci-last-empty { color:var(--muted); font-style:italic; }
      .ci-actions { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
      .ci-actions a { font-size:12.5px; padding:6px 12px; border-radius:8px; border:1px solid var(--line);
        color:var(--ink2); background:var(--card); text-decoration:none; }
      .ci-actions a:hover { color:var(--ink); border-color:var(--accent); }
    </style>
    <div class="ci-hero">
      <div class="ci-hero-title">
        <h3>Erica in production now</h3>
        <span class="ci-persona-tag"><a href="/admin/frameworks/${encodeURIComponent(personaId)}">${escapeHtml(persona)}</a></span>
        <span class="ci-hero-tag">what the coach is built from — read at a glance</span>
      </div>
      <div class="ci-grid">
        <div>
          <div class="ci-col-title">
            <span>System prompt budget</span>
            <span class="ci-hint">measured / reported / estimated</span>
          </div>
          <div class="ci-bar-track">${bar}</div>
          <div class="ci-bar-meta">
            <span>${budget.total.toLocaleString('en-US')} chars · ~${budget.approxTokens.toLocaleString('en-US')} tokens</span>
            <span class="ci-total ${pctTone === 'ok' ? '' : pctTone}">${pctBar}% of ${budget.budget.toLocaleString('en-US')} cap</span>
          </div>
          <div class="ci-legend">${legend}</div>
        </div>
        <div>
          <div class="ci-col-title">
            <span>Real Time channels</span>
            <a href="/admin/realtime" class="ci-hint" style="color:var(--muted)">manage →</a>
          </div>
          <div class="ci-chips">${chips}</div>
          <div class="ci-corpus">
            <a href="/admin/semantic-store"><span class="n">${coursesCount}</span> courses</a>
            <a href="/admin/quizzes"><span class="n">${quizzesCount}</span> quizzes</a>
            <a href="/admin/frameworks"><span class="n">${frameworksCount}</span> personas</a>
          </div>
          <div class="ci-last">
            Last real session: ${lastSess}
          </div>
          <div class="ci-actions">
            <a href="/admin/simulator">Open simulator →</a>
            <a href="/admin/frameworks/${encodeURIComponent(personaId)}">Edit persona →</a>
          </div>
        </div>
      </div>
    </div>`;
}

function indexPage(session) {
    // Compact dashboard: volume tiles + quality signals + recent sessions +
    // recent audit + framework overlay count. All the "co-worker at a glance"
    // signals — the persistent left agent handles the follow-up questions.
    const m = metrics.compute({ includeTesters: false });
    const recent = sessionLog.listSessions({ tester: 'exclude', limit: 6 });
    const audit = auditLog.list({ limit: 5 });
    const frameworks = contentStore.listFrameworks();
    const overlaid = frameworks.filter((n) => {
        const r = contentStore.readFramework(n);
        return r && r.source === 'overlay';
    });

    const ICO = {
      clock: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
      week:  '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="3.5" width="12" height="10" rx="1.5"/><path d="M2 6.5h12M6 3v-1M10 3v-1"/></svg>',
      month: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="4" width="12" height="9" rx="1.5"/><path d="M2 7.5h12"/></svg>',
      rage:  '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.5L14 12h-12L8 1.5z"/><path d="M8 6v3M8 10.5v.1"/></svg>',
      silence:'<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M5 8h6"/></svg>',
      tool:  '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2l3.5 3.5-2 2-1-1-2 2 2 2-3 3-5-5 3-3 2 2 2-2-1-1z"/></svg>'
    };
    const tile = (rot, val, sub, icoKey, hero) => `<div class="card${hero ? ' hero' : ''}"><div class="rot">${ICO[icoKey] || ''}${escapeHtml(rot)}</div><div class="val">${escapeHtml(String(val))}</div><div class="var">${escapeHtml(sub || '')}</div></div>`;
    const signal = (rot, val, hint, tone, icoKey) => `<div class="card${tone === 'crit' ? ' crit' : tone === 'warn' ? ' warn' : ''}"><div class="rot">${ICO[icoKey] || ''}${escapeHtml(rot)}</div><div class="val"${tone ? ` style="color:var(--${tone})"` : ''}>${escapeHtml(String(val))}</div><div class="var">${escapeHtml(hint || '')}</div></div>`;

    const recentRows = recent.length
        ? recent.map((s) => `<tr><td><a href="/admin/sessions/${encodeURIComponent(s.sessionId)}" style="font-family:ui-monospace,Consolas,monospace">${escapeHtml(s.sessionId.slice(0,26))}…</a></td><td>${escapeHtml(s.actor?.email || s.actor?.userId || s.actor?.objectId || 'guest')}</td><td class="num">${s.turns}</td><td>${escapeHtml((s.lastAt || '').slice(11, 19))}</td></tr>`).join('')
        : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:18px 0">no sessions yet — trigger one from the coach to populate.</td></tr>';

    const auditRows = audit.length
        ? audit.map((e) => `<tr><td>${escapeHtml((e.t || '').slice(11, 19))}</td><td>${escapeHtml(e.action)}</td><td style="color:var(--muted);font-family:ui-monospace,Consolas,monospace">${escapeHtml((e.target || '').slice(0, 40))}</td></tr>`).join('')
        : '<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:18px 0">no audit entries yet.</td></tr>';

    const now = new Date();
    const hour = now.getUTCHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    // Coach identity card — quem é a Erica agora, quanto contexto ela recebe,
    // canais Real Time ligados, contagens do Semantic Store. Feito para o
    // stakeholder abrir o Studio e entender em 5 segundos "o admin realmente
    // administra a coach".
    const budget = promptBudget.compute();
    const quizzesCount = quizzesStore.listQuizzes().length;
    const coursesCount = coursesStore.listCourses().length;
    const budgetCard = renderCoachIdentityCard(budget, { coursesCount, quizzesCount, frameworksCount: frameworks.length });

    const body = `
    <div class="titulo">
      <div><h2>${greet}, ${escapeHtml(session.sub)}</h2>
        <span class="meta">${escapeHtml(now.toISOString().slice(0,10))} · ${m.volume.last7d.sessions} sessions this week</span>
      </div>
      <span class="meta">last sync ${now.toISOString().slice(11,16)} UTC</span>
    </div>

    ${budgetCard}

    <div class="cards">
      ${tile('Last 24h', m.volume.last24h.sessions, m.volume.last24h.turns + ' turns · ' + m.volume.last24h.tools + ' tools', 'clock', true)}
      ${tile('Last 7 days', m.volume.last7d.sessions, m.volume.last7d.turns + ' turns · ' + m.volume.last7d.tools + ' tools', 'week')}
      ${tile('Last 30 days', m.volume.last30d.sessions, m.volume.last30d.turns + ' turns · ' + m.volume.last30d.tools + ' tools', 'month')}
      ${signal('Rage close', m.qualitySignals.rageClose, 'short sessions ending on user', m.qualitySignals.rageClose > 0 ? 'warn' : null, 'rage')}
      ${signal('Long silence', m.qualitySignals.longSilenceCount, 'gaps > 90s', m.qualitySignals.longSilenceCount > 5 ? 'warn' : null, 'silence')}
      ${signal('Tool failures', m.qualitySignals.toolFailureCount, 'sessions with ≥ 1 error', m.qualitySignals.toolFailureCount > 0 ? 'crit' : null, 'tool')}
    </div>

    <div class="painel">
      <h3>Recent sessions</h3>
      <table><thead><tr><th>Id</th><th>Actor</th><th class="num">Turns</th><th>Last</th></tr></thead><tbody>${recentRows}</tbody></table>
      <div style="margin-top:8px"><a href="/admin/sessions">All sessions →</a></div>
    </div>

    <div class="painel">
      <h3>Recent audit</h3>
      <table><thead><tr><th>Time</th><th>Action</th><th>Target</th></tr></thead><tbody>${auditRows}</tbody></table>
      <div style="margin-top:8px"><a href="/admin/audit">Full audit trail →</a></div>
    </div>

    ${(function () {
      const marks = sessionBookmarks.list({ limit: 8 });
      if (!marks.length) return '';
      const icon = (k) => k === 'exemplar' ? '⭐' : k === 'problem' ? '⚠️' : '·';
      const rowsBk = marks.map((b) => `
        <tr>
          <td style="width:26px;text-align:center;font-size:15px">${icon(b.kind)}</td>
          <td><a href="/admin/sessions/${encodeURIComponent(b.sessionId)}" style="font-family:ui-monospace,Consolas,monospace;font-size:12.5px">${escapeHtml(b.sessionId.slice(0, 24))}…</a></td>
          <td style="font-size:12.5px;color:var(--ink2)">${escapeHtml(b.note || '')}</td>
          <td style="font-size:11px;color:var(--muted);text-align:right">${escapeHtml((b.updatedAt || '').slice(0, 10))}</td>
        </tr>
      `).join('');
      return `
      <div class="painel">
        <h3>Session bookmarks <span style="font-weight:400;color:var(--muted);font-size:12px;margin-left:6px">${marks.length} marked</span></h3>
        <table>
          <thead><tr><th></th><th>Session</th><th>Note</th><th style="text-align:right">Marked</th></tr></thead>
          <tbody>${rowsBk}</tbody>
        </table>
        <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px">
          <a href="/admin/sessions?bk=exemplar">⭐ Only exemplars →</a>
          <a href="/admin/sessions?bk=problem">⚠️ Only problems →</a>
          <a href="/admin/sessions?bk=any">All marked →</a>
        </div>
      </div>`;
    })()}

    <div class="painel">
      <h3>Frameworks</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 8px">${frameworks.length} coaching frameworks · ${overlaid.length} with admin overlay ${overlaid.length ? '(' + overlaid.map(escapeHtml).join(', ') + ')' : ''}</p>
      <a href="/admin/frameworks">Manage frameworks →</a>
    </div>

    <div class="painel">
      <h3>Export for another AI</h3>
      <p style="font-size:13px;color:var(--ink2);margin:0 0 10px">
        Downloads a plain-text bundle you can paste into ChatGPT/Claude/etc. Starts with the
        <em>known pitfalls</em> of this data (redaction, tester filter, unit mismatch, synthetic vs real)
        so the receiving model inherits the caveats. PADROES 1B.7.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="botao" href="/api/admin/export?days=1">Download 24h .txt</a>
        <a class="botao" href="/api/admin/export?days=7">Download 7d .txt</a>
        <a class="botao" href="/api/admin/export?days=30">Download 30d .txt</a>
        <a class="botao" href="/api/admin/export?days=7&include_testers=1" style="opacity:.75">7d incl. testers</a>
      </div>
    </div>`;
    return shellChrome('Home', body);
}

// Small router. Returns true if it handled the request.
// Send an admin page — respects the AJAX right-pane nav. If the caller
// sent `X-Fragment: 1` (or `?fragment=1`), slice out just the inner
// body-content (between the PAGE-BODY markers shellChrome emits) and
// return that so the client can swap `.relatorio > #page-body`
// without unmounting the left agent panel. Otherwise return the full
// shellChrome-wrapped HTML.
function sendPage(req, res, html, status = 200) {
    const url = req.url || '';
    const q = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    const isFragment = req.headers['x-fragment'] === '1' || q.includes('fragment=1');
    if (isFragment) {
        // Slice inside the markers. Fallback to full HTML on parse failure.
        const startTok = '<!--PAGE-BODY-START-->';
        const endTok = '<!--PAGE-BODY-END-->';
        const a = html.indexOf(startTok);
        const b = html.indexOf(endTok);
        if (a >= 0 && b > a) {
            const inner = html.slice(a + startTok.length, b).trim();
            // Also grab the <title> so the client can set document.title
            const t = html.match(/<title>([^<]*)<\/title>/);
            res.writeHead(status, {
                'Content-Type': 'text/html; charset=utf-8',
                'X-Page-Title': (t ? t[1] : '').replace(/ — Coach Studio$/, '')
            });
            res.end(inner);
            return;
        }
    }
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

async function handle(req, res) {
    const url = req.url || '';
    if (!url.startsWith('/admin')) return false;

    // Parse cookies once.
    const cookies = parseCookie(req.headers.cookie);
    const session = verifySession(cookies[COOKIE_NAME]);

    // Login form (GET) — public.
    if (req.method === 'GET' && (url === '/admin/login' || url.startsWith('/admin/login?'))) {
        const params = new URL(url, 'http://x').searchParams;
        const err = params.get('e');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPage({ error: err }));
        return true;
    }

    // Login submit — public.
    if (req.method === 'POST' && url === '/admin/login') {
        const body = await readBody(req);
        const password = extractField(body, 'password');
        const expected = process.env.ADMIN_PASSWORD;
        if (!expected) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Admin auth not configured (ADMIN_PASSWORD missing)');
            return true;
        }
        if (!password || !timingSafeEqualStr(password, expected)) {
            res.writeHead(302, {
                'Set-Cookie': clearSessionCookie(),
                Location: '/admin/login?e=' + encodeURIComponent('Invalid password')
            });
            res.end();
            return true;
        }
        res.writeHead(302, { 'Set-Cookie': makeSessionCookie(), Location: '/admin/' });
        res.end();
        return true;
    }

    // Logout — public but must POST to avoid CSRF via <img>-style GETs.
    if (req.method === 'POST' && url === '/admin/logout') {
        res.writeHead(302, { 'Set-Cookie': clearSessionCookie(), Location: '/admin/login' });
        res.end();
        return true;
    }

    // Everything else under /admin/* is protected.
    if (!session) {
        // JSON endpoints get 401, HTML endpoints redirect.
        if (url.startsWith('/admin/ping') || req.headers.accept?.includes('application/json')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
        } else {
            res.writeHead(302, { Location: '/admin/login' });
            res.end();
        }
        return true;
    }

    // Protected: landing page.
    if (req.method === 'GET' && (url === '/admin' || url === '/admin/' || url.startsWith('/admin/?'))) {
        sendPage(req, res, indexPage(session));
        return true;
    }

    // Protected: ping.
    if (req.method === 'GET' && url === '/admin/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            actor: session.sub,
            issuedAt: session.iat,
            expiresAt: session.exp
        }));
        return true;
    }

    // Protected: sessions list.
    if (req.method === 'GET' && (url === '/admin/sessions' || url.startsWith('/admin/sessions?'))) {
        const params = new URL(url, 'http://x').searchParams;
        const tester = ['exclude', 'only', 'all'].includes(params.get('tester')) ? params.get('tester') : 'exclude';
        const limit = Math.min(500, Math.max(1, parseInt(params.get('limit') || '100', 10) || 100));
        const bookmarkFilter = ['any', 'exemplar', 'problem'].includes(params.get('bk')) ? params.get('bk') : '';
        const items = sessionLog.listSessions({ tester, limit });
        const bookmarks = sessionBookmarks.getMany(items.map((i) => i.sessionId));
        sendPage(req, res, sessionsPage({ items, tester, limit, bookmarkFilter, bookmarks }));
        return true;
    }

    // Protected: set / clear a session bookmark.
    if (req.method === 'POST' && url.match(/^\/admin\/sessions\/[^/]+\/bookmark$/)) {
        const sid = decodeURIComponent(url.split('?')[0].slice('/admin/sessions/'.length).replace(/\/bookmark$/, ''));
        const body = await readBody(req);
        const kind = extractField(body, 'kind') || '';
        const note = extractField(body, 'note') || '';
        const back = extractField(body, 'return') || '/admin/sessions';
        try {
            sessionBookmarks.set(sid, { kind, note, actor: session.sub });
        } catch (e) {
            console.warn('[admin] bookmark set failed:', e?.message || e);
        }
        // Always redirect back to the caller's origin URL so filters persist.
        const safeBack = back.startsWith('/admin/') ? back : '/admin/sessions';
        res.writeHead(302, { Location: safeBack });
        res.end();
        return true;
    }

    // Protected: session detail.
    if (req.method === 'GET' && url.startsWith('/admin/sessions/')) {
        const id = decodeURIComponent(url.slice('/admin/sessions/'.length).split('?')[0]);
        const data = sessionLog.readSession(id);
        sendPage(req, res, sessionDetailPage(id, data), data ? 200 : 404);
        return true;
    }

    // Protected: prompt snapshot detail.
    if (req.method === 'GET' && url.startsWith('/admin/prompts/')) {
        const hash = decodeURIComponent(url.slice('/admin/prompts/'.length).split('?')[0]);
        const snap = sessionLog.readPromptSnapshot(hash);
        sendPage(req, res, promptDetailPage(hash, snap), snap ? 200 : 404);
        return true;
    }

    // Legacy /admin/studio route — the agent lives in the left panel of
    // every page now, so this tab is redundant. Redirect to landing.
    if (req.method === 'GET' && (url === '/admin/studio' || url.startsWith('/admin/studio?'))) {
        res.writeHead(302, { Location: '/admin/' });
        res.end();
        return true;
    }

    // Protected: simulator page. Chat traffic goes to /api/admin/simulate.
    if (req.method === 'GET' && (url === '/admin/simulator' || url.startsWith('/admin/simulator?'))) {
        const params = new URL(url, 'http://x').searchParams;
        const prefill = {
            replaySessionId: params.get('session') || '',
            replayTurnIndex: params.get('turn') || ''
        };
        sendPage(req, res, simulatorPage(prefill));
        return true;
    }

    // Protected: Semantic Store hub.
    if (req.method === 'GET' && (url === '/admin/semantic-store' || url.startsWith('/admin/semantic-store?'))) {
        sendPage(req, res, semanticStorePage());
        return true;
    }

    // Protected: Injected Data hub.
    if (req.method === 'GET' && (url === '/admin/injected-data' || url.startsWith('/admin/injected-data?'))) {
        sendPage(req, res, injectedDataPage());
        return true;
    }

    // Protected: Real Time channels page.
    if (req.method === 'GET' && (url === '/admin/realtime' || url.startsWith('/admin/realtime?'))) {
        const p = new URL(url, 'http://x').searchParams;
        const msg = p.get('msg') || null;
        sendPage(req, res, realtimeConfigPage(runtimeConfig.listChannels(), msg));
        return true;
    }

    // Protected: toggle a real-time channel. POST-redirect-GET so the URL
    // bar stays clean and a browser refresh doesn't resubmit the toggle.
    if (req.method === 'POST' && url.match(/^\/admin\/realtime\/[^/]+\/toggle$/)) {
        const channelId = decodeURIComponent(url.split('?')[0].slice('/admin/realtime/'.length).replace(/\/toggle$/, ''));
        const body = await readBody(req);
        const enabled = extractField(body, 'enabled') === '1';
        let msg;
        try {
            runtimeConfig.setEnabled(channelId, enabled, { actor: session.sub, reason: 'admin toggle' });
            msg = `Channel "${channelId}" set to ${enabled ? 'ON' : 'OFF'}.`;
        } catch (e) {
            msg = 'Toggle failed: ' + (e?.message || e);
        }
        res.writeHead(302, { Location: '/admin/realtime?msg=' + encodeURIComponent(msg) });
        res.end();
        return true;
    }

    // Protected: frameworks list.
    if (req.method === 'GET' && url === '/admin/frameworks') {
        sendPage(req, res, frameworksListPage());
        return true;
    }

    // Protected: framework editor.
    if (req.method === 'GET' && url.startsWith('/admin/frameworks/')) {
        const rest = url.slice('/admin/frameworks/'.length).split('?')[0];
        const name = decodeURIComponent(rest);
        const cur = contentStore.readFramework(name);
        sendPage(req, res, frameworkEditPage(name, cur), cur ? 200 : 404);
        return true;
    }

    // Protected: framework write.
    if (req.method === 'POST' && url.startsWith('/admin/frameworks/') && !url.endsWith('/reset')) {
        const rest = url.slice('/admin/frameworks/'.length).split('?')[0];
        const name = decodeURIComponent(rest);
        const body = await readBody(req);
        const text = extractField(body, 'text');
        const reason = extractField(body, 'reason');
        try {
            const r = contentStore.writeFramework(name, text || '', { actor: session.sub, reason });
            const cur = contentStore.readFramework(name);
            const msg = r.changed ? `Saved. New hash ${r.hash.slice(0,12)}…` : 'No change (content identical).';
            sendPage(req, res, frameworkEditPage(name, cur, { savedMessage: msg }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Save failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: framework reset.
    if (req.method === 'POST' && url.startsWith('/admin/frameworks/') && url.endsWith('/reset')) {
        const rest = url.slice('/admin/frameworks/'.length).split('?')[0];
        const name = decodeURIComponent(rest.replace(/\/reset$/, ''));
        try {
            const r = contentStore.resetFramework(name, { actor: session.sub, reason: 'admin reset' });
            const cur = contentStore.readFramework(name);
            const msg = r.existed ? 'Overlay removed. Framework now serves the repo default.' : 'No overlay existed — nothing to reset.';
            sendPage(req, res, frameworkEditPage(name, cur, { savedMessage: msg }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Reset failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: courses list.
    if (req.method === 'GET' && url === '/admin/courses') {
        const courses = coursesStore.listCourses();
        sendPage(req, res, coursesListPage(courses));
        return true;
    }

    // Protected: create a new course.
    if (req.method === 'POST' && url === '/admin/courses') {
        const body = await readBody(req);
        const courseId = (extractField(body, 'course_id') || '').toLowerCase();
        const title = extractField(body, 'title') || courseId;
        try {
            coursesStore.createCourse(courseId, { title }, { actor: session.sub, reason: 'admin create' });
            res.writeHead(302, { Location: '/admin/courses/' + encodeURIComponent(courseId) });
            res.end();
        } catch (e) {
            const courses = coursesStore.listCourses();
            sendPage(req, res, coursesListPage(courses, 'Create failed: ' + (e?.message || e)));
        }
        return true;
    }

    // Protected: delete a course.
    if (req.method === 'POST' && url.match(/^\/admin\/courses\/[^/]+\/delete$/)) {
        const courseId = decodeURIComponent(url.split('?')[0].slice('/admin/courses/'.length).replace(/\/delete$/, ''));
        try {
            coursesStore.deleteCourse(courseId, { actor: session.sub, reason: 'admin delete' });
            res.writeHead(302, { Location: '/admin/courses' });
            res.end();
        } catch (e) {
            sendPage(req, res, courseDetailPage(courseId, 'Delete failed: ' + (e?.message || e)));
        }
        return true;
    }

    // Protected: course detail page (all artifacts in tabs).
    if (req.method === 'GET' && url.match(/^\/admin\/courses\/[^/]+$/)) {
        const courseId = decodeURIComponent(url.split('?')[0].slice('/admin/courses/'.length));
        const exists = !!coursesStore.readMeta(courseId);
        sendPage(req, res, courseDetailPage(courseId), exists ? 200 : 404);
        return true;
    }

    // Protected: course metadata write.
    if (req.method === 'POST' && url.match(/^\/admin\/courses\/[^/]+\/meta$/)) {
        const courseId = decodeURIComponent(url.split('?')[0].slice('/admin/courses/'.length).replace(/\/meta$/, ''));
        const body = await readBody(req);
        const title = extractField(body, 'title') || courseId;
        const description = extractField(body, 'description') || '';
        const reason = extractField(body, 'reason');
        try {
            coursesStore.writeMeta(courseId, { title, description }, { actor: session.sub, reason });
            sendPage(req, res, courseDetailPage(courseId, 'Metadata saved.'));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Save failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: artifact write (course-content / competency-framework / quizzes-list).
    if (req.method === 'POST' && url.match(/^\/admin\/courses\/[^/]+\/[^/]+$/) && !url.endsWith('/reset') && !url.endsWith('/meta')) {
        const p = url.split('?')[0].split('/');
        const courseId = decodeURIComponent(p[3]);
        const artifactKey = decodeURIComponent(p[4]);
        if (!coursesStore.isValidArtifactKey(artifactKey)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Unknown artifact key');
            return true;
        }
        const body = await readBody(req);
        const text = extractField(body, 'text') || '';
        const reason = extractField(body, 'reason');
        try {
            const r = coursesStore.writeArtifact(courseId, artifactKey, text, { actor: session.sub, reason });
            const msg = r.changed ? `Saved. New hash ${r.hash.slice(0,12)}…  ·  Remember to re-index for Erica to see the change.` : 'No change (content identical).';
            sendPage(req, res, courseDetailPage(courseId, msg));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Save failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: artifact reset (drop overlay, fall back to default).
    if (req.method === 'POST' && url.match(/^\/admin\/courses\/[^/]+\/[^/]+\/reset$/)) {
        const p = url.split('?')[0].split('/');
        const courseId = decodeURIComponent(p[3]);
        const artifactKey = decodeURIComponent(p[4]);
        try {
            const r = coursesStore.resetArtifact(courseId, artifactKey, { actor: session.sub, reason: 'admin reset' });
            const msg = r.existed ? 'Overlay removed. Falling back to the repo default.' : 'No overlay to reset.';
            sendPage(req, res, courseDetailPage(courseId, msg));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Reset failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: quizzes list.
    if (req.method === 'GET' && url === '/admin/quizzes') {
        const quizzes = quizzesStore.listQuizzes();
        sendPage(req, res, quizzesListPage(quizzes));
        return true;
    }

    // Protected: create a new quiz.
    if (req.method === 'POST' && url === '/admin/quizzes') {
        const body = await readBody(req);
        const quizId = (extractField(body, 'quiz_id') || '').toLowerCase();
        const title = extractField(body, 'title') || quizId;
        try {
            quizzesStore.createQuiz(quizId, { title }, { actor: session.sub, reason: 'admin create' });
            res.writeHead(302, { Location: '/admin/quizzes/' + encodeURIComponent(quizId) });
            res.end();
        } catch (e) {
            const quizzes = quizzesStore.listQuizzes();
            sendPage(req, res, quizzesListPage(quizzes, 'Create failed: ' + (e?.message || e)));
        }
        return true;
    }

    // Protected: quiz detail.
    if (req.method === 'GET' && url.match(/^\/admin\/quizzes\/[^/]+$/)) {
        const quizId = decodeURIComponent(url.split('?')[0].slice('/admin/quizzes/'.length));
        const exists = !!quizzesStore.readMeta(quizId);
        sendPage(req, res, quizDetailPage(quizId), exists ? 200 : 404);
        return true;
    }

    // Protected: quiz metadata write.
    if (req.method === 'POST' && url.match(/^\/admin\/quizzes\/[^/]+\/meta$/)) {
        const quizId = decodeURIComponent(url.split('?')[0].slice('/admin/quizzes/'.length).replace(/\/meta$/, ''));
        const body = await readBody(req);
        const meta = {
            title: extractField(body, 'title') || quizId,
            description: extractField(body, 'description') || '',
            purpose: extractField(body, 'purpose') || ''
        };
        const reason = extractField(body, 'reason');
        try {
            quizzesStore.writeMeta(quizId, meta, { actor: session.sub, reason });
            sendPage(req, res, quizDetailPage(quizId, 'Metadata saved.'));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Save failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: quiz content write.
    if (req.method === 'POST' && url.match(/^\/admin\/quizzes\/[^/]+\/content$/)) {
        const quizId = decodeURIComponent(url.split('?')[0].slice('/admin/quizzes/'.length).replace(/\/content$/, ''));
        const body = await readBody(req);
        const text = extractField(body, 'text') || '';
        const reason = extractField(body, 'reason');
        try {
            const r = quizzesStore.writeContent(quizId, text, { actor: session.sub, reason });
            const msg = r.changed ? `Saved. New hash ${r.hash.slice(0,12)}…  ·  Remember to re-index for Erica to see the change.` : 'No change (content identical).';
            sendPage(req, res, quizDetailPage(quizId, msg));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Save failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: quiz content reset.
    if (req.method === 'POST' && url.match(/^\/admin\/quizzes\/[^/]+\/content\/reset$/)) {
        const quizId = decodeURIComponent(url.split('?')[0].slice('/admin/quizzes/'.length).replace(/\/content\/reset$/, ''));
        try {
            const r = quizzesStore.resetContent(quizId, { actor: session.sub, reason: 'admin reset' });
            const msg = r.existed ? 'Overlay removed. Falling back to default (if it exists).' : 'No overlay to reset.';
            sendPage(req, res, quizDetailPage(quizId, msg));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Reset failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: metrics dashboard.
    if (req.method === 'GET' && (url === '/admin/metrics' || url.startsWith('/admin/metrics?'))) {
        const m = metrics.compute({ includeTesters: false });
        sendPage(req, res, metricsPage(m));
        return true;
    }

    // Protected: audit trail.
    if (req.method === 'GET' && url === '/admin/audit') {
        const entries = auditLog.list({ limit: 200 });
        const verified = auditLog.verify();
        sendPage(req, res, auditPage(entries, verified));
        return true;
    }

    // Protected: user lookup.
    if (req.method === 'GET' && (url === '/admin/users' || url.startsWith('/admin/users?'))) {
        const params = new URL(url, 'http://x').searchParams;
        const q = params.get('q');
        if (!q) {
            sendPage(req, res, userLookupPage(''));
            return true;
        }
        try {
            const isEmail = q.includes('@');
            const identifierType = isEmail ? 'userId' : (/^[a-f0-9]{24,}$/i.test(q) ? 'objectId' : 'userId');
            const [act, storeInfo] = await Promise.all([
                activity.getActivityHistory({ identifier: q, identifierType }).catch(() => null),
                (async () => {
                    try {
                        const storeKey = identifierType === 'objectId' ? `guest-${q}` : q;
                        const storeId = await vectorStore.getUserVectorStoreId(storeKey);
                        if (!storeId) return { storeKey, storeId: null, files: [] };
                        const files = await vectorStore.listUserStoreFiles(storeId).catch(() => []);
                        return { storeKey, storeId, files };
                    } catch (_) { return null; }
                })()
            ]);
            const snap = {
                identifierType,
                activity: act && act.events ? { eventsCount: act.events.length, events: act.events } : null,
                vectorStore: storeInfo
            };
            sendPage(req, res, userDetailPage(q, snap));
            return true;
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Lookup error: ' + (e?.message || e));
            return true;
        }
    }

    // Anything else under /admin/*: 404 (still authenticated).
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
}

function readBody(req) {
    return new Promise((resolve) => {
        let buf = '';
        req.on('data', (c) => { buf += c.toString(); });
        req.on('end', () => resolve(buf));
        req.on('error', () => resolve(''));
    });
}
function extractField(body, name) {
    // Assumes application/x-www-form-urlencoded from the login form.
    const parts = String(body || '').split('&');
    for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        const key = decodeURIComponent(p.slice(0, eq).replace(/\+/g, ' '));
        if (key === name) return decodeURIComponent(p.slice(eq + 1).replace(/\+/g, ' '));
    }
    return null;
}

/**
 * For API routes outside the /admin/* namespace that still need admin
 * auth, parse the request's cookies and return the verified session (or
 * null). Returning null means "reject with 401".
 */
function requireAdminSession(req) {
    const cookies = parseCookie(req.headers.cookie);
    return verifySession(cookies[COOKIE_NAME]);
}

module.exports = { handle, signSession, verifySession, requireAdminSession };
