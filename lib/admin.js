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
const auditLog = require('./audit');
const metrics = require('./metrics');

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
  .layout { display:grid; grid-template-columns: minmax(340px, 34%) 1fr; height:100vh; }
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
  .anexos .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .anexos .thumb button { position:absolute; top:2px; right:2px; width:18px; height:18px; border-radius:50%;
    background:rgba(0,0,0,.55); color:#fff; border:0; font-size:12px; line-height:1; padding:0; cursor:pointer; }
  .anexos .status { align-self:center; font-size:12px; color:var(--muted); }
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
  <button id="marcar" title="Ask agent about this">Ask agent about this →</button>
  <section class="relatorio">
    <div class="topo">
      <nav data-title="${escapeHtml(title)}">
        <a href="/admin/" data-match="Home">Home</a>
        <a href="/admin/sessions" data-match="Sessions">Sessions</a>
        <a href="/admin/users" data-match="User lookup">User lookup</a>
        <a href="/admin/simulator" data-match="Simulator">Simulator</a>
        <a href="/admin/frameworks" data-match="Framework">Frameworks</a>
        <a href="/admin/audit" data-match="Audit">Audit</a>
        <a href="/admin/metrics" data-match="Metrics">Metrics</a>
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
      nav.querySelectorAll('a[data-match]').forEach((a) => {
        a.classList.toggle('active', (title || '').startsWith(a.dataset.match));
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
    function appendUser(text) {
      if (vazio && vazio.parentElement) vazio.remove();
      const w = el('div', 'msg user'); w.textContent = text;
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
      appendUser(text);
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
          if (it.question) { const u = el('div', 'msg user'); u.textContent = it.question; chat.appendChild(u); }
          if (it.answer) {
            const w = el('div', 'msg assistant');
            const b = el('div', 'corpo'); b.textContent = it.answer;
            w.appendChild(b); chat.appendChild(w);
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
        const x = el('button', null, '×');
        x.title = 'Remove';
        x.addEventListener('click', () => { pendingAttachments.splice(i, 1); renderAttachmentsStrip(); });
        t.appendChild(img); t.appendChild(x);
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

function sessionsPage({ items, tester, limit }) {
    const rows = items.length ? items.map((s) => `
    <tr class="border-b border-gray-100 hover:bg-teal-50/40">
      <td class="px-3 py-2 text-xs"><a class="font-mono text-teal-700 hover:underline" href="/admin/sessions/${encodeURIComponent(s.sessionId)}">${escapeHtml(s.sessionId)}</a></td>
      <td class="px-3 py-2 text-xs">${escapeHtml((s.actor?.email) || (s.actor?.userId) || (s.actor?.objectId) || 'guest')}</td>
      <td class="px-3 py-2 text-xs">${s.actor?.tester ? '<span class="text-amber-700">tester</span>' : ''}</td>
      <td class="px-3 py-2 text-xs">${escapeHtml(s.startedAt)}</td>
      <td class="px-3 py-2 text-xs">${escapeHtml(s.lastAt)}</td>
      <td class="px-3 py-2 text-xs text-right">${s.turns}</td>
      <td class="px-3 py-2 text-xs text-right">${s.size}</td>
    </tr>
    `).join('') : `<tr><td colspan="7" class="px-3 py-8 text-sm text-gray-500 text-center">No sessions recorded yet.</td></tr>`;
    const body = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm">
      <div class="px-4 py-3 flex items-center gap-4 border-b border-gray-200">
        <div class="text-sm font-semibold">Sessions</div>
        <form method="GET" action="/admin/sessions" class="flex items-center gap-2 text-xs">
          <label class="text-gray-600">Tester filter</label>
          <select name="tester" class="rounded-lg border border-gray-300 px-2 py-1">
            <option value="exclude"${tester==='exclude'?' selected':''}>Exclude testers</option>
            <option value="only"${tester==='only'?' selected':''}>Testers only</option>
            <option value="all"${tester==='all'?' selected':''}>All</option>
          </select>
          <label class="text-gray-600 ml-2">Limit</label>
          <input type="number" min="1" max="500" name="limit" value="${limit}" class="w-20 rounded-lg border border-gray-300 px-2 py-1">
          <button class="rounded-lg bg-gray-800 text-white px-3 py-1">Apply</button>
        </form>
        <div class="ml-auto text-xs text-gray-500">${items.length} shown</div>
      </div>
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-600 text-xs uppercase">
          <tr>
            <th class="px-3 py-2 text-left">Session</th>
            <th class="px-3 py-2 text-left">Actor</th>
            <th class="px-3 py-2 text-left">Flag</th>
            <th class="px-3 py-2 text-left">Started</th>
            <th class="px-3 py-2 text-left">Last</th>
            <th class="px-3 py-2 text-right">Turns</th>
            <th class="px-3 py-2 text-right">Bytes</th>
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
    const bucket = (b, label) => `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
      <div class="text-xs text-gray-500 uppercase tracking-wide">${label}</div>
      <div class="mt-1 text-2xl font-semibold">${b.sessions} <span class="text-sm text-gray-500 font-normal">sessions</span></div>
      <div class="text-xs text-gray-600 mt-1">${b.turns} turns · ${b.tools} tool calls</div>
    </div>`;

    // Simple SVG bar chart for tool usage (reuses the pattern the coach herself uses).
    const toolTop = m.toolUsage.slice(0, 8);
    const maxTool = Math.max(1, ...toolTop.map((r) => r[1]));
    const barW = 320, barH = 22, gap = 8;
    const svgH = toolTop.length * (barH + gap) + 20;
    const bars = toolTop.map((row, i) => {
        const [name, count] = row;
        const w = Math.max(2, (count / maxTool) * barW);
        const y = i * (barH + gap) + 10;
        const errCount = (m.toolErrors.find(([n]) => n === name) || [0, 0])[1];
        const label = escapeHtml(name) + (errCount ? ` <tspan fill="#dc2626">(${errCount} err)</tspan>` : '');
        return `<g>
          <rect x="150" y="${y}" width="${w}" height="${barH}" fill="#14b8a6" rx="4"></rect>
          <text x="144" y="${y + barH / 2 + 4}" text-anchor="end" font-size="12" fill="#374151">${label}</text>
          <text x="${150 + w + 6}" y="${y + barH / 2 + 4}" font-size="12" fill="#4b5563">${count}</text>
        </g>`;
    }).join('');
    const svg = `<svg viewBox="0 0 500 ${svgH}" width="100%" height="${svgH}" role="img" aria-label="Tool usage">${bars || '<text x="10" y="20" fill="#9ca3af" font-size="12">No tool calls recorded yet.</text>'}</svg>`;

    const body = `
    <section class="grid grid-cols-3 gap-4">
      ${bucket(m.volume.last24h, 'Last 24h')}
      ${bucket(m.volume.last7d, 'Last 7 days')}
      ${bucket(m.volume.last30d, 'Last 30 days')}
    </section>

    <section class="grid grid-cols-2 gap-4">
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
        <div class="text-sm font-semibold text-gray-900 mb-2">Tool usage (top 8, all-time)</div>
        ${svg}
      </div>
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
        <div class="text-sm font-semibold text-gray-900 mb-3">Latency percentiles</div>
        <table class="w-full text-sm">
          <thead class="text-xs uppercase text-gray-500"><tr><th class="text-left py-1">Metric</th><th class="text-right py-1">p50</th><th class="text-right py-1">p90</th><th class="text-right py-1">p99</th></tr></thead>
          <tbody>
            <tr class="border-t border-gray-100"><td class="py-1">Time to first bot turn</td><td class="text-right">${fmtMs(m.timeToFirstBotMs.p50)}</td><td class="text-right">${fmtMs(m.timeToFirstBotMs.p90)}</td><td class="text-right">${fmtMs(m.timeToFirstBotMs.p99)}</td></tr>
            <tr class="border-t border-gray-100"><td class="py-1">Turn-to-turn gap</td><td class="text-right">${fmtMs(m.turnGapsMs.p50)}</td><td class="text-right">${fmtMs(m.turnGapsMs.p90)}</td><td class="text-right">${fmtMs(m.turnGapsMs.p99)}</td></tr>
            <tr class="border-t border-gray-100"><td class="py-1">Session length</td><td class="text-right">${fmtMs(m.sessionLengthsMs.p50)}</td><td class="text-right">${fmtMs(m.sessionLengthsMs.p90)}</td><td class="text-right">${fmtMs(m.sessionLengthsMs.p99)}</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
      <div class="text-sm font-semibold text-gray-900 mb-3">Quality signals</div>
      <div class="grid grid-cols-3 gap-3 text-sm">
        <div class="rounded-xl border border-gray-200 p-3">
          <div class="text-xs text-gray-500 uppercase">Rage close</div>
          <div class="text-xl font-semibold">${m.qualitySignals.rageClose}</div>
          <div class="text-[10px] text-gray-500 mt-1">sessions &lt; 3 turns AND &lt; 30s AND ending on user turn</div>
        </div>
        <div class="rounded-xl border border-gray-200 p-3">
          <div class="text-xs text-gray-500 uppercase">Long silence</div>
          <div class="text-xl font-semibold">${m.qualitySignals.longSilenceCount}</div>
          <div class="text-[10px] text-gray-500 mt-1">any turn-to-turn gap &gt; 90s</div>
        </div>
        <div class="rounded-xl border border-gray-200 p-3">
          <div class="text-xs text-gray-500 uppercase">Tool failures</div>
          <div class="text-xl font-semibold">${m.qualitySignals.toolFailureCount}</div>
          <div class="text-[10px] text-gray-500 mt-1">sessions with ≥ 1 failing tool call</div>
        </div>
      </div>
    </section>

    <p class="text-xs text-gray-500">Computed at ${escapeHtml(m.computedAt)} · ${m.sessionsSeen} sessions in scope (testers ${m.includeTesters ? 'INCLUDED' : 'excluded'}).</p>`;
    return shellChrome('Metrics', body);
}

function frameworksListPage() {
    const names = contentStore.listFrameworks();
    const rows = names.map((n) => {
        const r = contentStore.readFramework(n);
        const src = r?.source === 'overlay' ? '<span class="text-teal-700">edited</span>' : '<span class="text-gray-500">default</span>';
        return `<tr class="border-b border-gray-100"><td class="px-3 py-2 text-sm"><a class="text-teal-700 hover:underline" href="/admin/frameworks/${encodeURIComponent(n)}">${escapeHtml(n)}</a></td><td class="px-3 py-2 text-xs">${src}</td><td class="px-3 py-2 text-xs text-gray-500 font-mono">${r?.hash?.slice(0,10) || ''}</td><td class="px-3 py-2 text-xs">${r?.text?.length || 0} chars</td></tr>`;
    }).join('');
    const body = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Coaching frameworks</div>
      <table class="w-full text-sm"><thead class="bg-gray-50 text-xs uppercase text-gray-600"><tr><th class="px-3 py-2 text-left">Name</th><th class="px-3 py-2 text-left">Source</th><th class="px-3 py-2 text-left">Hash</th><th class="px-3 py-2 text-left">Size</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="px-3 py-8 text-center text-xs text-gray-500">No frameworks found.</td></tr>'}</tbody></table>
    </section>
    <p class="text-xs text-gray-500">Editing writes to the persistent volume overlay (<code>/data/frameworks/</code>) — repo defaults stay intact. Every write is audited.</p>`;
    return shellChrome('Frameworks', body);
}

function frameworkEditPage(name, cur, { savedMessage = null } = {}) {
    if (!cur) return shellChrome('Framework', `<section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-sm text-gray-500">Framework <code>${escapeHtml(name)}</code> not found.</section>`);
    const banner = savedMessage
        ? `<div class="rounded-lg bg-teal-50 border border-teal-200 text-teal-800 text-sm px-3 py-2">${escapeHtml(savedMessage)}</div>`
        : '';
    const body = `
    ${banner}
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-3">
      <div class="flex items-baseline justify-between">
        <div class="text-sm"><span class="text-gray-500">Framework:</span> <span class="font-semibold">${escapeHtml(cur.name)}</span> <span class="ml-3 text-xs ${cur.source==='overlay'?'text-teal-700':'text-gray-500'}">${cur.source}</span> <span class="ml-3 text-xs font-mono text-gray-500">${cur.hash.slice(0,12)}…</span></div>
        <a href="/admin/frameworks" class="text-xs text-teal-700 hover:underline">All frameworks</a>
      </div>
      <form method="POST" action="/admin/frameworks/${encodeURIComponent(cur.name)}" class="space-y-3">
        <textarea name="text" rows="24" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono">${escapeHtml(cur.text)}</textarea>
        <label class="block text-xs text-gray-600">Reason (audit meta)
          <input name="reason" class="mt-1 w-full border border-gray-300 rounded-lg px-2 py-1 text-sm" placeholder="e.g. Sandra: soften 'always_do' language in Supportive">
        </label>
        <div class="flex items-center gap-3">
          <button class="rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm px-4 py-2">Save (creates overlay)</button>
          ${cur.source === 'overlay' ? `<button formaction="/admin/frameworks/${encodeURIComponent(cur.name)}/reset" formmethod="POST" class="rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm px-4 py-2">Reset to default</button>` : ''}
          <span class="text-xs text-gray-500">Writes go to <code>/data/frameworks/${escapeHtml(cur.name)}.md</code> on the persistent volume.</span>
        </div>
      </form>
    </section>`;
    return shellChrome('Framework · ' + name, body);
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
    const body = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-3">
      <h2 class="text-sm font-semibold text-gray-900">Simulator</h2>
      <p class="text-xs text-gray-600">Compose an alternative persona/guardrails and see what Erica would say to a given user message. Optionally load a real user turn from a recorded session (only when STORE_MESSAGE_TEXT was 'raw' at record time — otherwise the user text is redacted).</p>
      <form id="simForm" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs text-gray-600">Persona name</span>
            <input name="personaName" value="${escVal(prefill.personaName || 'Erica')}" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </label>
          <label class="block">
            <span class="text-xs text-gray-600">Extra directive (optional)</span>
            <input name="extraDirective" value="${escVal(prefill.extraDirective || '')}" placeholder="e.g. 'Be much more direct'" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </label>
        </div>
        <label class="block">
          <span class="text-xs text-gray-600">Guardrails / persona rules</span>
          <textarea name="guardrails" rows="8" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono">${escVal(prefill.guardrails || '- Lead with emotional validation.\\n- Offer small next steps.\\n- Avoid urgency language.')}</textarea>
        </label>
        <label class="block">
          <span class="text-xs text-gray-600">User message</span>
          <textarea name="userMessage" rows="3" class="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">${escVal(prefill.userMessage || 'I feel stuck. I have a big decision to make.')}</textarea>
        </label>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <label class="block">
            <span class="text-gray-600">Replay session id (optional)</span>
            <input name="replaySessionId" value="${escVal(prefill.replaySessionId || '')}" placeholder="s-…" class="mt-1 w-full border border-gray-300 rounded-lg px-2 py-1 font-mono">
          </label>
          <label class="block">
            <span class="text-gray-600">Replay turn index (optional)</span>
            <input name="replayTurnIndex" type="number" min="0" value="${escVal(prefill.replayTurnIndex || '')}" class="mt-1 w-full border border-gray-300 rounded-lg px-2 py-1 font-mono">
          </label>
        </div>
        <button class="rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm px-4 py-2">Simulate</button>
      </form>
    </section>

    <section id="results" class="hidden bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-3">
      <h3 class="text-sm font-semibold text-gray-900">Result</h3>
      <div id="original-block" class="hidden">
        <div class="text-xs font-semibold text-gray-500 uppercase tracking-wide">Original coach response</div>
        <div id="original" class="mt-1 text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 whitespace-pre-wrap"></div>
      </div>
      <div>
        <div class="text-xs font-semibold text-teal-700 uppercase tracking-wide">Simulated response</div>
        <div id="simulated" class="mt-1 text-sm bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 whitespace-pre-wrap"></div>
        <div id="meta" class="mt-1 text-[10px] text-gray-500"></div>
      </div>
      <details>
        <summary class="text-xs text-gray-500 cursor-pointer">Instructions used</summary>
        <pre id="instr" class="mt-2 text-[11px] whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-2"></pre>
      </details>
    </section>

    <script>
      document.getElementById('simForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
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
        results.classList.remove('hidden');
        document.getElementById('simulated').textContent = 'thinking…';
        document.getElementById('meta').textContent = '';
        document.getElementById('original-block').classList.add('hidden');
        try {
          const r = await fetch('/api/admin/simulate', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await r.json();
          if (data.error) {
            document.getElementById('simulated').textContent = 'error: ' + data.error;
            return;
          }
          document.getElementById('simulated').textContent = data.simulated?.text || '';
          document.getElementById('meta').textContent = 'model ' + (data.simulated?.model || '?') + ' · ' + (data.simulated?.ms || '?') + 'ms';
          document.getElementById('instr').textContent = data.simulated?.instructionsPreview || '';
          if (data.originalResponse) {
            document.getElementById('original').textContent = data.originalResponse;
            document.getElementById('original-block').classList.remove('hidden');
          }
        } catch (err) {
          document.getElementById('simulated').textContent = 'network error: ' + err.message;
        }
      });
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
    const body = `
    <div class="titulo">
      <div><h2>${greet}, ${escapeHtml(session.sub)}</h2>
        <span class="meta">${escapeHtml(now.toISOString().slice(0,10))} · ${m.volume.last7d.sessions} sessions this week</span>
      </div>
      <span class="meta">last sync ${now.toISOString().slice(11,16)} UTC</span>
    </div>

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
        const items = sessionLog.listSessions({ tester, limit });
        sendPage(req, res, sessionsPage({ items, tester, limit }));
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
