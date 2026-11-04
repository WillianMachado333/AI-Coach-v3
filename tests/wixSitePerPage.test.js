// #61: a Wix member id only means something on the site that issued it. A
// member signed in on awav.com (the sandbox) was looked up on
// talenttransformation.com, which answered as for a guest — no name, every
// quiz "not taken" — so the coach asked them to open the report they had just
// finished (Willian, 3 Nov 2026). The person's preparation and history now
// come from the Wix site of the page the coach sits on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { siteOf, wixHostFor } = require('../lib/wixSite');

const root = path.join(__dirname, '..');

test('siteOf: only our Wix sites, with or without www; anything else is none', () => {
    assert.equal(siteOf('https://www.awav.com/'), 'awav.com');
    assert.equal(siteOf('https://awav.com/journeys/x?y=1'), 'awav.com');
    assert.equal(siteOf('https://WWW.TalentTransformation.com/career'), 'talenttransformation.com');
    for (const other of ['https://pages.talenttransformation.com/career-interest/1', 'https://web-staging-2c7ff.up.railway.app/index.html',
        'https://awav.com.evil.example/', 'https://evilawav.com/', 'not a url', '', null, undefined]) {
        assert.equal(siteOf(other), null, String(other));
    }
    assert.equal(wixHostFor('https://www.awav.com/', 'talenttransformation.com'), 'awav.com');
    assert.equal(wixHostFor('https://evil.example/', 'talenttransformation.com'), 'talenttransformation.com');
    assert.equal(wixHostFor(null, 'talenttransformation.com'), 'talenttransformation.com');
});

function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
            cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}

function post(port, route, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.write(data); req.end();
    });
}

const lastWixLine = (out, what) => (out().match(new RegExp(`\\[fake-wix\\] ${what}[^\\n]*`, 'g')) || []).pop() || '';

test('HTTP: a member is looked up on the Wix site of the page they are on; guests and unknown pages keep the configured site', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-wixsite-'));
    const dirs = { SESSION_DATA_DIR: path.join(tmp, 'sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'prompts'), CLIPBOARD_DATA_DIR: path.join(tmp, 'clipboard'),
        AUDIT_DIR: path.join(tmp, 'audit'), ACTIVITY_DATA_DIR: path.join(tmp, 'activity'), INJECTED_DATA_DIR: path.join(tmp, 'injected') };
    const port = 23000 + Math.floor(Math.random() * 900);
    const { child: server, out } = await startServer(port, { ...dirs, SESSION_SECRET: 'x', FAKE_WIX_PREP: '200', ERICA_WIX_API_SECRET: 'test-secret' });
    try {
        // A member on the sandbox: awav.com answers, without the production secret.
        const a = await post(port, '/api/erica-preparation', { userId: 'member-A', caller: 'web', context: { hostPage: 'https://www.awav.com/' } });
        assert.equal(a.status, 200);
        assert.match(a.text, /REAL-PREP for member-A from awav\.com/);
        assert.match(lastWixLine(out, 'prep call'), /host=awav\.com auth=no/);

        // The same id on a talenttransformation.com page: that site answers (with
        // its secret), not the cached sandbox answer.
        const b = await post(port, '/api/erica-preparation', { userId: 'member-A', caller: 'web', context: { hostPage: 'https://www.talenttransformation.com/career' } });
        assert.match(b.text, /REAL-PREP for member-A from talenttransformation\.com/);
        assert.match(lastWixLine(out, 'prep call'), /host=talenttransformation\.com auth=yes/);

        // Back on the sandbox: its own cache entry.
        const c = await post(port, '/api/erica-preparation', { userId: 'member-A', caller: 'web', context: { hostPage: 'https://www.awav.com/' } });
        assert.equal(c.headers['x-cache'], 'HIT');
        assert.match(c.text, /from awav\.com/);

        // A page that is none of our Wix sites: the configured site.
        const d = await post(port, '/api/erica-preparation', { userId: 'member-B', caller: 'web', context: { hostPage: 'https://evil.example/x' } });
        assert.match(d.text, /REAL-PREP for member-B from talenttransformation\.com/);

        // A guest's preparation is generic: the configured site, wherever the page is.
        const g = await post(port, '/api/erica-preparation', { caller: 'web', context: { hostPage: 'https://www.awav.com/' } });
        assert.match(g.text, /REAL-PREP for guest from talenttransformation\.com/);

        // History follows the same rule.
        await post(port, '/api/conversation-history-save', { userId: 'member-A', text: 'User: hi', hostPage: 'https://www.awav.com/journeys' });
        assert.match(lastWixLine(out, 'ericaConversationHistorySave'), /host=awav\.com auth=no/);
        await post(port, '/api/conversation-history-fetch', { userId: 'member-A', hostPage: 'https://www.awav.com/' });
        assert.match(lastWixLine(out, 'ericaConversationHistoryFetch'), /host=awav\.com auth=no/);
        await post(port, '/api/conversation-history-fetch', { userId: 'member-A', hostPage: 'https://www.talenttransformation.com/' });
        assert.match(lastWixLine(out, 'ericaConversationHistoryFetch'), /host=talenttransformation\.com auth=yes/);
        await post(port, '/api/conversation-history-fetch', { userId: 'member-A' });
        assert.match(lastWixLine(out, 'ericaConversationHistoryFetch'), /host=talenttransformation\.com auth=yes/, 'no page: the configured site');
    } finally {
        server.kill();
    }
});

test('the coach tells the server its page on every Wix call: preparation, history fetch and history save', () => {
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert.match(app, /context: \{ hostPage: this\._hostPage\(\) \}/, 'preparation');
    assert.match(app, /JSON\.stringify\(\{ userId, hostPage: this\._hostPage\(\) \}\)/, 'history fetch');
    assert.match(app, /JSON\.stringify\(\{ userId, text: historyText, hostPage: this\._hostPage\(\) \}\)/, 'history save');
    assert.match(app, /_hostPage\(\) \{\s*try \{ const r = new URL\(document\.referrer\); return r\.origin \+ r\.pathname; \}/);
});
