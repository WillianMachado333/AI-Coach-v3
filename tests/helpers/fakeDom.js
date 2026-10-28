// Just enough DOM for app.js / uiLayout.js code under test in a vm context:
// elements with children, attributes, classes, text and click listeners,
// and a document that finds them by id. No layout, no HTML parsing.
class FakeClassList {
    constructor() { this.set = new Set(); }
    add(...c) { c.forEach((x) => this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, force) {
        const on = force === undefined ? !this.set.has(c) : !!force;
        if (on) this.set.add(c); else this.set.delete(c);
        return on;
    }
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FakeElement {
    constructor(tag, doc) {
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.style = {};
        this.dataset = {};
        this.classList = new FakeClassList();
        this._text = '';
        this.listeners = {};
        this.scrollTop = 0;
    }
    get className() { return [...this.classList.set].join(' '); }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get id() { return this.attributes.id || ''; }
    set id(v) { this.attributes.id = String(v); }
    setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') this.className = v;
        if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
    }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    insertBefore(c, ref) {
        if (!ref) return this.appendChild(c);
        if (c.parentNode) c.parentNode.removeChild(c);
        const i = this.children.indexOf(ref);
        c.parentNode = this;
        this.children.splice(i < 0 ? this.children.length : i, 0, c);
        return c;
    }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    get previousElementSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.children.indexOf(this);
        return i > 0 ? this.parentNode.children[i - 1] : null;
    }
    get nextElementSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.children.indexOf(this);
        return this.parentNode.children[i + 1] || null;
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) {
        this.children.forEach((c) => { c.parentNode = null; });
        this.children = [];
        this._text = String(v);
    }
    set innerHTML(v) { this.textContent = ''; this._html = String(v); }
    get innerHTML() { return this._html || ''; }
    get scrollHeight() { return 0; }
    scrollTo() {}
    scrollIntoView() {}
    focus() {}
    // <audio>
    pause() {}
    play() { return Promise.resolve(); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    click() {
        const ev = { type: 'click', target: this, preventDefault() {}, stopPropagation() {} };
        (this.listeners.click || []).forEach((fn) => fn(ev));
        if (typeof this.onclick === 'function') this.onclick(ev);
    }
    matches(sel) {
        if (sel.startsWith('#')) return this.id === sel.slice(1);
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
        const attr = sel.match(/^\[([\w-]+)\]$/);
        if (attr) return this.hasAttribute(attr[1]);
        return this.tagName === sel.toUpperCase();
    }
    querySelectorAll(sel) {
        const out = [];
        const walk = (el) => el.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); });
        walk(this);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    // Visible = attached to the document and nothing up the tree hidden.
    get visible() {
        for (let el = this; el; el = el.parentNode) {
            if (el.classList.contains('hidden') || el.style.display === 'none') return false;
            if (el.tagName === 'BODY') return true;
        }
        return false;
    }
}

function createDocument() {
    const doc = {
        listeners: {},
        createElement: (tag) => new FakeElement(tag, doc),
        createTextNode: (text) => { const n = new FakeElement('#text', doc); n._text = String(text); return n; },
        addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
        removeEventListener() {},
        getElementById: (id) => (doc.body.id === id ? doc.body : doc.body.querySelector('#' + id)),
        querySelector: (sel) => doc.body.querySelector(sel),
        querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
        visibilityState: 'visible',
    };
    doc.body = new FakeElement('body', doc);
    doc.documentElement = doc.body;
    return doc;
}

module.exports = { createDocument, FakeElement };
