// The on-device speech detector's files (#40 step 2): Silero VAD on
// onnxruntime-web, from the pinned npm packages (no binaries in git),
// served from our origin under /vad/<version>/.
//
// Only the files below, by exact name. The versioned path makes them
// immutable: a browser keeps them for a year and a version bump changes
// the URL. Brotli is done once per file, off the main thread (the wasm is
// 14 MB raw, 2.7 MB brotli), and kept in memory.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function pkgDir(name) {
    return path.join(__dirname, '..', 'node_modules', ...name.split('/'));
}
function pkgVersion(name) {
    try { return JSON.parse(fs.readFileSync(path.join(pkgDir(name), 'package.json'), 'utf8')).version; } catch (_) { return null; }
}

const ORT = 'onnxruntime-web';
const VAD = '@ricky0123/vad-web';
const VERSION = `${pkgVersion(ORT)}-${pkgVersion(VAD)}`;
const BASE = `/vad/${VERSION}/`;

// Published name → [package, file in it, content type]. Names are the ones
// the libraries ask for (ort's wasm loader, vad-web's worklet and model).
const FILES = {
    'ort.min.js': [ORT, 'dist/ort.min.js', 'text/javascript; charset=utf-8'],
    'ort-wasm-simd-threaded.mjs': [ORT, 'dist/ort-wasm-simd-threaded.mjs', 'text/javascript; charset=utf-8'],
    'ort-wasm-simd-threaded.wasm': [ORT, 'dist/ort-wasm-simd-threaded.wasm', 'application/wasm'],
    'bundle.min.js': [VAD, 'dist/bundle.min.js', 'text/javascript; charset=utf-8'],
    'vad.worklet.bundle.min.js': [VAD, 'dist/vad.worklet.bundle.min.js', 'text/javascript; charset=utf-8'],
    'silero_vad_v5.onnx': [VAD, 'dist/silero_vad_v5.onnx', 'application/octet-stream'],
};

const _cache = new Map(); // name -> Promise<{ raw, br }>

function load(name) {
    if (_cache.has(name)) return _cache.get(name);
    const [pkg, rel] = FILES[name];
    const p = fs.promises.readFile(path.join(pkgDir(pkg), ...rel.split('/'))).then((raw) => new Promise((resolve) => {
        zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, (err, br) => {
            if (err) console.error('[vadAssets] ⚠️ brotli failed for', name, '— serving it uncompressed:', err.message);
            resolve({ raw, br: err ? null : br });
        });
    }));
    p.catch(() => _cache.delete(name));
    _cache.set(name, p);
    return p;
}

// GET /vad/<version>/<name>. Returns true when it answered.
async function handle(req, res) {
    const pathOnly = String(req.url || '').split('?')[0];
    if (!pathOnly.startsWith('/vad/')) return false;
    const name = pathOnly.startsWith(BASE) ? pathOnly.slice(BASE.length) : null;
    if (req.method !== 'GET' || !name || !Object.prototype.hasOwnProperty.call(FILES, name)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return true;
    }
    let file;
    try {
        file = await load(name);
    } catch (e) {
        console.error('[vadAssets] ⚠️ cannot read', name, '— the speech gate will be unavailable:', e.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('VAD asset unavailable');
        return true;
    }
    const wantsBr = /\bbr\b/.test(String(req.headers['accept-encoding'] || ''));
    const body = wantsBr && file.br ? file.br : file.raw;
    res.writeHead(200, {
        'Content-Type': FILES[name][2],
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        Vary: 'Accept-Encoding',
        ...(body === file.br ? { 'Content-Encoding': 'br' } : {}),
    });
    res.end(body);
    return true;
}

module.exports = { handle, BASE, VERSION, FILES, available: () => !!pkgVersion(ORT) && !!pkgVersion(VAD) };
