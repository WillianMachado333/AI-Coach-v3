// Test-only preload (`node -r`): a scripted Wix upstream for
// /api/erica-preparation, so the server's non-200 and network-error branches
// run for real without touching the network.
//
// FAKE_WIX_PREP = comma list consumed one entry per upstream call: an HTTP
// status (429, 200, …) or "error" (the request fails). The last entry repeats.
// Any other https.request fails too: the test never leaves the machine.
const https = require('https');
const { EventEmitter } = require('events');

const script = String(process.env.FAKE_WIX_PREP || '200').split(',').map((s) => s.trim());
const prepPath = process.env.PREP_PATH || '/_functions/ericaPreparation';
let calls = 0;

https.request = function fakeRequest(options, cb) {
    const req = new EventEmitter();
    const chunks = [];
    req.write = (c) => { chunks.push(Buffer.from(c)); return true; };
    req.setTimeout = () => req;
    req.destroy = () => req;
    req.end = (c) => {
        if (c) chunks.push(Buffer.from(c));
        setImmediate(() => {
            if (!options || options.path !== prepPath) { req.emit('error', new Error('network disabled in test')); return; }
            const step = script[Math.min(calls, script.length - 1)];
            calls++;
            process.stdout.write(`[fake-wix] prep call ${calls}: ${step}\n`);
            if (step === 'error') { req.emit('error', new Error('ECONNRESET (fake)')); return; }
            const res = new EventEmitter();
            res.statusCode = Number(step);
            res.headers = { 'content-type': 'application/json' };
            cb(res);
            if (res.statusCode === 200) {
                let sent = {};
                try { sent = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (_) { /* keep {} */ }
                res.emit('data', JSON.stringify({ message: 'REAL-PREP for ' + (sent.userId || 'guest') }));
            }
            res.emit('end');
        });
    };
    return req;
};
