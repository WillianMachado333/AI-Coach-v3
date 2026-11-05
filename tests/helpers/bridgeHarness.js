// Runs the real bridge.js against a fake DOM, storage and clock.
//
// runBridge({
//   entry,          // the Wix member entry in localStorage (null: a guest)
//   location,       // { hostname, search, pathname, href } of the host page
//   currentScript,  // src of document.currentScript (null: not set)
//   scripts,        // srcs of document.scripts
//   source,         // bridge.js text (default: the file, as served unchanged)
//   session,        // initial sessionStorage entries
//   elements,       // ids of host-page elements that exist (e.g. 'askEricaMain')
// })
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createDocument } = require('./fakeDom');

const BRIDGE_PATH = path.join(__dirname, '..', '..', 'bridge.js');
const WIX_KEY = '__wix_member_state';

function storage(initial) {
    const store = new Map(Object.entries(initial || {}));
    return {
        store,
        get length() { return store.size; },
        key: (i) => [...store.keys()][i] ?? null,
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
}

function runBridge(opts = {}) {
    const {
        entry = null,
        location = { hostname: 'www.awav.com', search: '', pathname: '/', href: 'https://www.awav.com/' },
        currentScript = null,
        scripts = [],
        source = fs.readFileSync(BRIDGE_PATH, 'utf8'),
        session = {},
        elements = [],
    } = opts;
    const doc = createDocument();
    doc.currentScript = currentScript ? { src: currentScript } : null;
    doc.scripts = scripts.map((src) => ({ src }));
    for (const id of elements) {
        const el = doc.createElement('div');
        el.id = id;
        doc.body.appendChild(el);
    }
    const local = storage(entry ? { [WIX_KEY]: JSON.stringify(entry), unrelated: '{"x":1}' } : { unrelated: '{"x":1}' });
    const sessionStorage = storage(session);
    const logs = [];
    let now = 0;
    const timers = [];
    const win = {
        document: doc, localStorage: local, sessionStorage, URL,
        console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error() {} },
        location, navigator: { userAgent: 'node' }, innerWidth: 1280, innerHeight: 800,
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        addEventListener() {}, removeEventListener() {},
        setTimeout: (fn, ms = 0) => { timers.push({ fn, at: now + ms }); return timers.length; },
        setInterval: (fn, ms = 0) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
        clearTimeout() {}, clearInterval() {},
    };
    win.window = win; win.self = win; win.top = win;
    vm.runInContext(source, vm.createContext(win));
    const advance = (ms) => {
        const end = now + ms;
        for (;;) {
            const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            now = due.at;
            if (due.every) due.at += due.every; else timers.splice(timers.indexOf(due), 1);
            try { due.fn(); } catch (_) { /* UI helpers the fake DOM lacks */ }
        }
        now = end;
    };
    const byId = (id) => doc.getElementById(id);
    const iframe = () => byId('ct-bridge-iframe');
    const icon = () => byId('ct-bridge-icon');
    const setEntry = (e) => (e ? local.store.set(WIX_KEY, JSON.stringify(e)) : local.store.delete(WIX_KEY));
    return { advance, iframe, icon, byId, doc, win, logs, setEntry, session: sessionStorage.store };
}

module.exports = { runBridge, BRIDGE_PATH };
