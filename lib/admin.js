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

function loginPage({ error } = {}) {
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Coach Studio — Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
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
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Coach Studio</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gray-50 text-gray-800">
  <header class="border-b border-gray-200 bg-white sticky top-0 z-10">
    <div class="max-w-6xl mx-auto flex items-center gap-6 px-4 py-3">
      <a href="/admin/" class="font-semibold text-gray-900">Coach Studio</a>
      <nav class="flex items-center gap-4 text-sm">
        <a href="/admin/sessions" class="text-gray-700 hover:text-gray-900">Sessions</a>
        <a href="/admin/users" class="text-gray-700 hover:text-gray-900">User lookup</a>
        <a href="/admin/studio" class="text-gray-700 hover:text-gray-900">Studio agent</a>
        <a href="/admin/simulator" class="text-gray-700 hover:text-gray-900">Simulator</a>
        <a href="/admin/frameworks" class="text-gray-700 hover:text-gray-900">Frameworks</a>
        <a href="/admin/audit" class="text-gray-700 hover:text-gray-900">Audit</a>
        <a href="/admin/metrics" class="text-gray-700 hover:text-gray-900">Metrics</a>
      </nav>
      <div class="ml-auto">
        <form method="POST" action="/admin/logout"><button class="text-sm text-gray-600 hover:text-gray-900 underline">Sign out</button></form>
      </div>
    </div>
  </header>
  <main class="max-w-6xl mx-auto p-4 space-y-6">
    ${body}
  </main>
</body></html>`;
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
    const iso = new Date((session.iat || 0) * 1000).toISOString();
    const recent = sessionLog.listSessions({ tester: 'exclude', limit: 5 });
    const recentList = recent.length ? recent.map((s) => `<li class="text-xs"><a class="font-mono text-teal-700 hover:underline" href="/admin/sessions/${encodeURIComponent(s.sessionId)}">${escapeHtml(s.sessionId)}</a> <span class="text-gray-500">— ${escapeHtml(s.actor?.email || s.actor?.userId || s.actor?.objectId || 'guest')} · ${s.turns} turns · ${escapeHtml(s.lastAt)}</span></li>`).join('') : '<li class="text-xs text-gray-500">No sessions logged yet — trigger one and refresh.</li>';
    const body = `
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div class="text-sm text-gray-700">Signed in as <span class="font-semibold">admin</span>. Session issued <code class="text-xs">${iso}</code>.</div>
    </section>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-3">
      <h2 class="text-sm font-semibold text-gray-900">Recent sessions</h2>
      <ul class="space-y-1">${recentList}</ul>
      <a href="/admin/sessions" class="inline-block text-sm text-teal-700 hover:underline">All sessions →</a>
    </section>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 class="text-sm font-semibold text-gray-900 mb-2">Look up a user</h2>
      <p class="text-sm text-gray-700 mb-2">Fetch the same diagnostic bundle used by <code>/api/debug/user</code>: activity, vector store contents.</p>
      <a href="/admin/users" class="inline-block rounded-lg bg-gray-800 text-white text-sm px-3 py-1.5">Open user lookup</a>
    </section>`;
    return shellChrome('Home', body);
}

// Small router. Returns true if it handled the request.
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(indexPage(session));
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(sessionsPage({ items, tester, limit }));
        return true;
    }

    // Protected: session detail.
    if (req.method === 'GET' && url.startsWith('/admin/sessions/')) {
        const id = decodeURIComponent(url.slice('/admin/sessions/'.length).split('?')[0]);
        const data = sessionLog.readSession(id);
        res.writeHead(data ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(sessionDetailPage(id, data));
        return true;
    }

    // Protected: prompt snapshot detail.
    if (req.method === 'GET' && url.startsWith('/admin/prompts/')) {
        const hash = decodeURIComponent(url.slice('/admin/prompts/'.length).split('?')[0]);
        const snap = sessionLog.readPromptSnapshot(hash);
        res.writeHead(snap ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(promptDetailPage(hash, snap));
        return true;
    }

    // Protected: studio agent chat UI. Actual chat traffic goes to
    // /api/admin/studio-chat (in server.js) which uses requireAdminSession.
    if (req.method === 'GET' && (url === '/admin/studio' || url.startsWith('/admin/studio?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(studioPage());
        return true;
    }

    // Protected: simulator page. Chat traffic goes to /api/admin/simulate.
    if (req.method === 'GET' && (url === '/admin/simulator' || url.startsWith('/admin/simulator?'))) {
        const params = new URL(url, 'http://x').searchParams;
        const prefill = {
            replaySessionId: params.get('session') || '',
            replayTurnIndex: params.get('turn') || ''
        };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(simulatorPage(prefill));
        return true;
    }

    // Protected: frameworks list.
    if (req.method === 'GET' && url === '/admin/frameworks') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(frameworksListPage());
        return true;
    }

    // Protected: framework editor.
    if (req.method === 'GET' && url.startsWith('/admin/frameworks/')) {
        const rest = url.slice('/admin/frameworks/'.length).split('?')[0];
        const name = decodeURIComponent(rest);
        const cur = contentStore.readFramework(name);
        res.writeHead(cur ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(frameworkEditPage(name, cur));
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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(frameworkEditPage(name, cur, { savedMessage: msg }));
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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(frameworkEditPage(name, cur, { savedMessage: msg }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Reset failed: ' + (e?.message || e));
        }
        return true;
    }

    // Protected: metrics dashboard.
    if (req.method === 'GET' && (url === '/admin/metrics' || url.startsWith('/admin/metrics?'))) {
        const m = metrics.compute({ includeTesters: false });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(metricsPage(m));
        return true;
    }

    // Protected: audit trail.
    if (req.method === 'GET' && url === '/admin/audit') {
        const entries = auditLog.list({ limit: 200 });
        const verified = auditLog.verify();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(auditPage(entries, verified));
        return true;
    }

    // Protected: user lookup.
    if (req.method === 'GET' && (url === '/admin/users' || url.startsWith('/admin/users?'))) {
        const params = new URL(url, 'http://x').searchParams;
        const q = params.get('q');
        if (!q) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(userLookupPage(''));
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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(userDetailPage(q, snap));
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
