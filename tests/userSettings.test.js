// Coach settings (#35 → Eric's onboarding): one validator for both sides, a
// server-only store — kept per userId, one visit (30 min) per CleverTap id
// for guests, nothing on a guest's device — and the route that only reads or
// writes the caller's own. Plus the first-call voice step (image cards).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-settings-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.USER_SETTINGS_DIR = path.join(tmp, 'user-settings');
const root = path.join(__dirname, '..');
const cs = require('../coachSettings');
const store = require('../lib/userSettings');

test('normalize: exact values only; unknown fields, bad voices and bad ids dropped; names cleaned and capped', () => {
    const n = cs.normalize({ companionId: 'Strengths', voice: 'CEDAR', voiceStepDone: true, extra: 'x', styleRecommended: 'Directive', styleOverride: '../x', customNames: { Strengths: '  Ana  ', 'bad id!': 'Bo', Supportive: '<b>Rô</b>😀' } });
    assert.deepEqual(n, { companionId: 'Strengths', voice: 'cedar', voiceStepDone: true, customNames: { Strengths: 'Ana', Supportive: 'bRôb' }, styleRecommended: 'Directive', styleOverride: null });
    assert.equal(cs.normalize({ voice: 'nova-9' }).voice, null, 'a voice outside the list is dropped');
    assert.equal(cs.cleanName('x'.repeat(60)).length, cs.NAME_MAX);
    assert.equal(cs.cleanName("Mary-Jo O'Neil"), "Mary-Jo O'Neil");
    const many = {}; for (let i = 0; i < 30; i++) many['C' + i] = 'N' + i;
    assert.equal(Object.keys(cs.normalize({ customNames: many }).customNames).length, cs.CUSTOM_NAMES_MAX);
    assert.equal(cs.loadLocal, undefined, 'no device storage at all (Eric: nothing on an anonymous device)');
});

test('merge: fields present replace, names merge per coach, null removes one name, an invalid value is ignored (not a delete)', () => {
    const base = { companionId: 'Supportive', customNames: { Supportive: 'Ana', Strengths: 'Rex' }, voice: 'marin', voiceStepDone: false };
    let r = cs.merge(base, { companionId: 'Strengths', customNames: { Supportive: null }, styleRecommended: 'Directive' });
    assert.deepEqual(r.changed, ['companionId', 'styleRecommended', 'customNames']);
    assert.deepEqual(r.settings.customNames, { Strengths: 'Rex' });
    assert.equal(r.settings.voice, 'marin', 'untouched fields stay');
    r = cs.merge(r.settings, { voice: 'nope', customNames: { Strengths: '!!!' } });
    assert.deepEqual(r.changed, ['voice']);
    assert.equal(r.settings.customNames.Strengths, 'Rex');
    assert.deepEqual(cs.merge(r.settings, { companionId: 'Strengths' }).changed, [], 'no change → nothing to write');
});

test('server store: kept per userId; a guest (CleverTap id) for one visit — 30 min after the last use, then gone', () => {
    const t0 = Date.UTC(2026, 8, 30, 12, 0, 0);
    assert.equal(store.read({ userId: 'member-1' }), null);
    const a = store.update({ userId: 'member-1' }, { companionId: 'Guidance', voice: 'coral', voiceStepDone: true }, { by: 'voice_step', now: t0 });
    assert.deepEqual([a.changed, a.scope], [['companionId', 'voice', 'voiceStepDone'], 'account']);
    assert.equal(store.read({ userId: 'member-1' }, { now: t0 + 365 * 86400000 }).voice, 'coral', 'an account keeps it');
    assert.equal(store.record('member-1').expiresAt, undefined);
    const g = store.update({ objectId: 'ct-guest-1' }, { voiceStepDone: true }, { by: 'voice_step', now: t0 });
    assert.equal(g.scope, 'visit');
    assert.equal(store.read({ objectId: 'ct-guest-1' }, { now: t0 + 20 * 60000 }).voiceStepDone, true, 'a reload 20 min later (Wix page change) finds it');
    assert.equal(store.read({ objectId: 'ct-guest-1' }, { now: t0 + 45 * 60000 }).voiceStepDone, true, 'sliding: the read at 20 min kept the visit alive');
    assert.equal(store.read({ objectId: 'ct-guest-1' }, { now: t0 + 80 * 60000 }), null, '35 min idle: the visit is over');
    assert.ok(!fs.existsSync(path.join(process.env.USER_SETTINGS_DIR, 'ctid-ct-guest-1.json')), 'and the file is gone');
    store.update({ objectId: 'ct-guest-2' }, { voiceStepDone: true }, { now: t0 });
    assert.equal(store.sweepExpiredGuests(t0 + 31 * 60000), 1);
    assert.equal(store.read({ userId: 'member-1' }, { now: t0 + 31 * 60000 }).companionId, 'Guidance', 'the sweep never touches accounts');
    assert.equal(store.read({ userId: 'member-2' }), null, 'another person sees nothing');
    assert.throws(() => store.update({}, { voice: 'ash' }));
});

test('Studio person page shows the settings (and that a guest\'s last one visit)', () => {
    const { _internal } = require('../lib/admin');
    store.update({ userId: 'member-s' }, { companionId: 'Guidance', voice: 'coral', styleRecommended: 'Directive', customNames: { Guidance: 'Ana' } });
    const html = _internal.coachSettingsSection('member-s');
    assert.match(html, /Coach <b>Guidance<\/b>/);
    assert.match(html, /Style <b>Directive \(Navigator\)<\/b>/);
    assert.match(html, /Voice <b>coral<\/b>/);
    assert.match(html, /Calls the coach Ana/);
    store.update({ objectId: 'ct-shown' }, { voiceStepDone: true });
    assert.match(_internal.coachSettingsSection('ct-shown'), /guest, this visit only/);
    assert.equal(_internal.coachSettingsSection('nobody'), '');
});

// --- HTTP ---
function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function post(port, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: '/api/user-settings', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
        });
        req.on('error', reject); req.write(data); req.end();
    });
}

test('HTTP /api/user-settings: own settings only; account vs one-visit guest scope; a signed token wins over the body; a forged one is refused', async () => {
    const SECRET = 'settings-secret-' + 'y'.repeat(32);
    const dir = path.join(tmp, 'http-settings');
    const port = 23000 + Math.floor(Math.random() * 900);
    const { child } = await startServer(port, { USER_SETTINGS_DIR: dir, SESSION_DATA_DIR: path.join(tmp, 'http-sessions'), WIX_IDENTITY_SECRET: SECRET, SESSION_SECRET: 'x' });
    try {
        const w = await post(port, { userId: 'member-H', objectId: 'ct-h', set: { companionId: 'Guidance', voice: 'coral', voiceStepDone: true, junk: 1 }, by: 'voice_step' });
        assert.deepEqual([w.status, w.json.scope, w.json.changed], [200, 'account', ['companionId', 'voice', 'voiceStepDone']]);
        const r = await post(port, { userId: 'member-H' });
        assert.equal(r.json.settings.voice, 'coral');
        const g = await post(port, { objectId: 'ct-guest', set: { voiceStepDone: true } });
        assert.equal(g.json.scope, 'visit');
        const gd = JSON.parse(fs.readFileSync(path.join(dir, 'ctid-ct-guest.json'), 'utf8'));
        assert.ok(Date.parse(gd.expiresAt) - Date.now() <= 30 * 60000 + 5000, 'a guest record expires with the visit');
        assert.deepEqual((await post(port, {})).json, { scope: 'none', settings: null });
        const ident = require('../lib/signedIdentity');
        const tok = ident.mint({ uid: 'member-T' }, SECRET);
        assert.equal((await post(port, { userId: 'member-H', set: { voice: 'ash' } }, { 'X-Erica-Identity': tok })).json.scope, 'account');
        assert.equal((await post(port, { userId: 'member-H' })).json.settings.voice, 'coral', "member-H's voice untouched");
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'user-member-T.json'), 'utf8')).settings.voice, 'ash');
        assert.equal((await post(port, { userId: 'member-H', set: { voice: 'ash' } }, { 'X-Erica-Identity': tok.slice(0, -4) + 'AAAA' })).status, 401);
    } finally {
        child.kill();
    }
});

// --- Client: the voice step ---
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function method(sig) {
    const start = src.indexOf(`    ${sig} {`) >= 0 ? src.indexOf(`    ${sig} {`) : src.indexOf(`    async ${sig} {`);
    assert.ok(start >= 0, 'method not found: ' + sig);
    const open = src.indexOf(') {', start) + 2;
    let depth = 0; let i = open;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const params = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const body = src.slice(open + 1, i);
    // eslint-disable-next-line no-new-func
    return src.slice(start, start + 12).includes('async') ? new Function(params, `return (async () => {${body}})();`) : new Function(params, body);
}

test('client voice step: shown on the first call only; Skip or the same voice starts the call at once (no reconnect); a new card switches the session while previewing; Skip after a preview goes back; the style stays when the face changes', async () => {
    global.performance = global.performance || { now: () => Date.now() };
    global.window = { location: { search: '' } };
    const cards = JSON.parse(fs.readFileSync(path.join(root, 'voiceCards.json'), 'utf8')).cards;
    const erica = cards.find((c) => c.id === 'Supportive');
    const jasmine = cards.find((c) => c.id === 'Guidance');
    const make = (settings, { connected = true } = {}) => {
        const log = [];
        const app = {
            _voiceCards: cards, _coachSettings: { scope: 'account', settings }, selectedCompanionId: 'Supportive', selectedVoice: 'marin', _sessionVoice: 'marin', isConnected: connected,
            _voiceStepOriginal: erica,
            styleOverride: { styleId: 'Directive', label: 'Directive, clear, actionable', coachingStyle: { primaryObjective: 'Clarity' } },
            getEffectiveVoiceProfile: () => ({ companionId: 'Supportive' }),
            _updateCoachChip: () => {},
            _saveCoachSettings: (set, by) => log.push(['save', set, by]),
            _logSessionEvent: (n, m) => log.push(['event', n, m]),
            toggleMicTrack: () => log.push(['call']),
            reconnectWithNewVoice: async (o) => { log.push(['reconnect', app.selectedVoice, o]); await new Promise((r) => setTimeout(r, 5)); app._sessionVoice = app.selectedVoice; },
            setSelectedVoice: (voice, thumb, name, id) => { app.selectedVoice = voice; app.selectedCompanionId = id; log.push(['persona', id, voice]); },
        };
        app._urlCoachGiven = method('_urlCoachGiven()').bind(app);
        app._voiceStepNeeded = method('_voiceStepNeeded()').bind(app);
        app._applyCard = method('_applyCard(card)').bind(app);
        app._switchVoiceTo = method('_switchVoiceTo(card)').bind(app);
        app._waitConnected = async () => true;
        app._finishVoiceStep = method('_finishVoiceStep(card)').bind(app);
        return { app, log };
    };
    assert.equal(make(null).app._voiceStepNeeded(), true, 'first call, nothing chosen yet');
    assert.equal(make({ voiceStepDone: true }).app._voiceStepNeeded(), false, 'chosen or skipped before (this account / this visit)');
    window.location.search = '?aic=Strengths';
    assert.equal(make(null).app._voiceStepNeeded(), false, 'the host named a coach');
    window.location.search = '';

    const skip = make(null);
    await skip.app._finishVoiceStep(null);
    assert.deepEqual(skip.log.map((l) => l[0] === 'event' ? l[1] : l[0]), ['save', 'voice_step_skipped', 'call'], 'Skip: save, then the call, nothing else');
    assert.equal(skip.app._voiceStepNeeded(), false, 'never again on this page');

    const same = make(null);
    await same.app._finishVoiceStep(erica);
    assert.ok(!same.log.some((l) => l[0] === 'reconnect'), 'the open session already has this voice');
    assert.deepEqual(same.log.at(-1), ['call']);

    // Tap Jasmine (the switch starts during the preview), then "Use this voice".
    const pre = make(null);
    const switching = pre.app._switchVoiceTo(jasmine);
    await switching;
    await pre.app._finishVoiceStep(jasmine);
    assert.equal(pre.log.filter((l) => l[0] === 'reconnect').length, 1, 'one reconnect, done while previewing');
    const sel = pre.log.find((l) => l[1] === 'voice_selected')[2];
    assert.deepEqual([sel.card, sel.voice, sel.changed, sel.prewarmed], ['Guidance', 'coral', true, true]);
    assert.equal(pre.app._sessionVoice, 'coral');
    assert.equal(pre.app.styleOverride.styleId, 'Directive', "Jasmine's face and voice, the coaching style stays");
    assert.deepEqual(pre.log.at(-1), ['call']);

    // Tap Jasmine, then Michael, then Jasmine: the latest wins, no pile of reconnects.
    const many = make(null);
    many.app._switchVoiceTo(jasmine);
    many.app._switchVoiceTo(cards.find((c) => c.id === 'Empowering'));
    await many.app._switchVoiceTo(jasmine);
    assert.ok(many.log.filter((l) => l[0] === 'reconnect').length <= 2);
    assert.equal(many.app._sessionVoice, 'coral');

    // Tap Jasmine, then Skip: back to Erica's voice before the call.
    const back = make(null);
    await back.app._switchVoiceTo(jasmine);
    await back.app._finishVoiceStep(null);
    assert.equal(back.app._sessionVoice, 'marin');
    assert.equal(back.app.selectedCompanionId, 'Supportive');
    assert.deepEqual(back.log.at(-1), ['call']);

    // Cold (no session yet): the card applies and the call opens with its voice; no reconnect.
    const cold = make(null, { connected: false });
    await cold.app._finishVoiceStep(jasmine);
    assert.ok(!cold.log.some((l) => l[0] === 'reconnect'));
    assert.equal(cold.app.selectedVoice, 'coral');
});

test('client wiring: the step gates the first call; settings apply before the session opens; a guest\'s coach is not kept on the device', () => {
    assert.match(src, /toggleMicTrack\(\) \{\s*\/\/ First voice-mode entry[^\n]*\n[^\n]*\n\s*if \(!this\.isRecording && !this\._voiceStepChecked\) \{ this\._voiceStepChecked = true; this\._voiceStepGate\(\); return; \}/);
    assert.match(src, /if \(this\._voiceStepNeeded\(\)\) this\._showVoiceStep\(\);\s*else this\.toggleMicTrack\(\);/, 'the gate shows the step or starts the call');
    assert.ok(src.indexOf('await this._applyStoredCoachSettings();') < src.indexOf('const reportCtx = await this.requestReportContextFromParent();'));
    assert.match(src, /selectedCoach: signedIn \? \{/);
    assert.match(src, /if \(state\.selectedCoach && \(state\.selectedCoach\.companionId \|\| state\.selectedCoach\.voice\)\) \{/);
    assert.match(src, /if \(reason === 'navigator'\) this\._saveCoachSettings\(\{ styleRecommended: styleId \}, 'navigator'\);/);
    const ui = fs.readFileSync(path.join(root, 'uiLayout.js'), 'utf8');
    assert.match(ui, /app\._saveCoachSettings\(\{ companionId: companionId \|\| null, voice: voice \|\| null, styleOverride: companionId \|\| null \}, 'picker'\);/);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /id="voiceStep" class="voice-step hidden"/);
    for (const c of JSON.parse(fs.readFileSync(path.join(root, 'voiceCards.json'), 'utf8')).cards) {
        assert.ok(fs.existsSync(path.join(root, c.thumb)), 'card image exists: ' + c.thumb);
        assert.ok(cs.VOICES.includes(c.voice), 'card voice is a known voice: ' + c.voice);
    }
});

test('Studio timeline: the voice step, what was chosen and what it cost, and settings restored at a visit start', () => {
    const { _internal } = require('../lib/admin');
    const t = new Date().toISOString();
    const html = _internal.sessionDetailPage('s-vVoice', { entries: [
        { type: 'session_start', t, sessionId: 's-vVoice', actor: { objectId: 'x' } },
        { type: 'event', t, name: 'voice_step_viewed', meta: { cards: ['Supportive', 'Guidance', 'Empowering', 'Discovery'], preselected: 'Supportive' } },
        { type: 'event', t, name: 'voice_previewed', meta: { card: 'Guidance', voice: 'coral' } },
        { type: 'event', t, name: 'voice_selected', meta: { card: 'Guidance', voice: 'coral', changed: true, reconnectMs: 2310, decideMs: 4200 } },
        { type: 'event', t, name: 'voice_step_skipped', meta: { decideMs: 900 } },
        { type: 'event', t, name: 'coach_restored', meta: { card: 'Guidance', voice: 'coral', style: 'Directive', scope: 'account' } },
    ] });
    assert.match(html, /🎙️ <b>Voice step shown<\/b> — cards Supportive, Guidance, Empowering, Discovery · preselected Supportive/);
    assert.match(html, /🎙️ Voice previewed — Guidance \(coral\)/);
    assert.match(html, /🎙️ <b>Voice chosen<\/b> — Guidance \(coral\) · reconnect · 2\.3 s · decided in · 4\.2 s/);
    assert.match(html, /🎙️ <b>Voice step skipped<\/b> · after · 0\.9 s/);
    assert.match(html, /🎙️ Settings restored \(account\) — card Guidance \(coral\) style Directive/);
});
