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

function indexPage(session) {
    const iso = new Date((session.iat || 0) * 1000).toISOString();
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Coach Studio</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gray-50 text-gray-800">
  <header class="border-b border-gray-200 bg-white">
    <div class="max-w-5xl mx-auto flex items-center justify-between px-4 py-3">
      <div class="font-semibold text-gray-900">Coach Studio <span class="text-xs font-normal text-teal-600 ml-2">Phase 0 smoke</span></div>
      <form method="POST" action="/admin/logout"><button class="text-sm text-gray-600 hover:text-gray-900 underline">Sign out</button></form>
    </div>
  </header>
  <main class="max-w-5xl mx-auto p-4 space-y-6">
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div class="text-sm text-gray-700">
        Signed in as <span class="font-semibold">admin</span>. Session issued <code class="text-xs">${iso}</code>.
      </div>
    </section>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 class="text-sm font-semibold text-gray-900 mb-3">Auth loop smoke test</h2>
      <ul class="text-sm text-gray-700 list-disc pl-5 space-y-1">
        <li>You can read this page — protected middleware accepts your cookie.</li>
        <li>Ping endpoint at <code>/admin/ping</code> returns JSON.</li>
        <li>Logging out clears the cookie and returns you to <code>/admin/login</code>.</li>
      </ul>
      <button id="pingBtn" class="mt-4 text-sm rounded-lg bg-gray-800 text-white px-3 py-2 hover:bg-gray-900">Ping</button>
      <pre id="pingOut" class="mt-3 text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap hidden"></pre>
    </section>
    <section class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 opacity-60">
      <h2 class="text-sm font-semibold text-gray-900 mb-1">Coming next</h2>
      <p class="text-sm text-gray-700">Session logger + observatory + Coach Studio agent — Phase 1 &amp; up.</p>
    </section>
  </main>
  <script>
    document.getElementById('pingBtn').addEventListener('click', async () => {
      const out = document.getElementById('pingOut');
      out.classList.remove('hidden');
      out.textContent = 'Fetching…';
      try {
        const r = await fetch('/admin/ping', { credentials: 'include' });
        const text = await r.text();
        out.textContent = 'HTTP ' + r.status + '\\n\\n' + text;
      } catch (e) { out.textContent = 'error: ' + e.message; }
    });
  </script>
</body></html>`;
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

module.exports = { handle, signSession, verifySession };
