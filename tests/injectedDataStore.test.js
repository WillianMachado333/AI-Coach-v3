// Injected Data store, without HTTP: which safety rules enter the prompt,
// what planUpsert accepts for enabled and null, and that a save which changes
// nothing writes nothing. The MCP and Studio paths over HTTP are in
// mcp.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'injected-'));
process.env.INJECTED_DATA_DIR = path.join(tmp, 'injected');
process.env.AUDIT_DIR = path.join(tmp, 'audit');
const store = require('../lib/injectedDataStore');

const file = (kind) => path.join(process.env.INJECTED_DATA_DIR, store.kindMeta(kind).file);
const auditCount = () => { try { return fs.readFileSync(path.join(process.env.AUDIT_DIR, 'audit.ndjson'), 'utf8').split('\n').filter((l) => l.trim()).length; } catch (_) { return 0; } };

test('a safety rule enters the prompt only when enabled is exactly true (a stored "false" string, 1 or junk never counts as on)', () => {
    const stored = [true, 'true', 'false', 1, 'yes', {}, [true], null, undefined, false];
    const rows = stored.map((enabled, i) => ({ rule_id: 'r' + i, trigger_hint: 'hint' + i, prescribed_response: 'resp' + i, ...(enabled === undefined ? {} : { enabled }) }));
    fs.writeFileSync(file('safety-rules'), JSON.stringify(rows));
    const block = store.computeSystemPromptBlock('safety-rules');
    assert.deepEqual(block.split('\n').filter((l) => l.startsWith('- IF')), ['- IF the user says something like [hint0] THEN resp0']);
    assert.deepEqual(rows.map((r) => store.isEnabled(r)), stored.map((v) => v === true));
    fs.writeFileSync(file('safety-rules'), JSON.stringify(rows.slice(1)));
    assert.equal(store.computeSystemPromptBlock('safety-rules'), '', 'no rule on: no block at all');
    fs.rmSync(file('safety-rules'));
});

test('planUpsert: enabled is true / false or the strings "true" / "false" in any case; anything else is refused, not read as off; null is refused for any field', () => {
    const rule = { rule_id: 'r', trigger_hint: 'h', prescribed_response: 'p' };
    for (const [v, want] of [[true, true], [false, false], ['true', true], ['FALSE', false], [' True ', true]]) {
        assert.equal(store.planUpsert('safety-rules', { ...rule, enabled: v }).row.enabled, want, JSON.stringify(v));
    }
    for (const v of [1, 0, 'yes', 'on', '1', '', null, {}, [], [true]]) {
        assert.throws(() => store.planUpsert('safety-rules', { ...rule, enabled: v }), /enabled must be true or false \(got /, JSON.stringify(v));
    }
    assert.throws(() => store.planUpsert('safety-rules', { ...rule, enabled: 1 }), /\(got 1\)/);
    assert.throws(() => store.planUpsert('safety-rules', { ...rule, enabled: true, trigger_hint: null }), /^Error: trigger_hint is null: leave a field out to keep its value, or send "" to empty it$/);
    assert.throws(() => store.planUpsert('canonical-courses', { course_id: 'c', name: 'C', url: null, one_line: null }), /url, one_line are null/);
    assert.throws(() => store.planUpsert('canonical-courses', { course_id: null, name: 'C' }), /course_id is required/);
    assert.equal(store.planUpsert('canonical-courses', { course_id: 'c', name: 'C', url: '' }).row.url, '', '"" empties a text field');
});

test('upsertRow: a save that changes nothing does not rewrite the file nor append an audit entry; a real change does both', () => {
    const course = { course_id: 'c1', name: 'Course One', url: 'https://tt.com/c1', one_line: 'First' };
    const created = store.upsertRow('canonical-courses', course);
    assert.deepEqual([created.written, created.isNew, created.row], [true, true, course]);
    const compact = JSON.stringify(store.readAll('canonical-courses'));
    fs.writeFileSync(file('canonical-courses'), compact); // a rewrite would pretty-print it
    const n = auditCount();
    const same = store.upsertRow('canonical-courses', { course_id: 'c1', name: 'Course One' });
    assert.deepEqual([same.written, same.isNew, same.changed, same.row], [false, false, [], course]);
    assert.equal(fs.readFileSync(file('canonical-courses'), 'utf8'), compact, 'not rewritten');
    assert.equal(auditCount(), n, 'not audited');
    const changed = store.upsertRow('canonical-courses', { course_id: 'c1', name: 'Course 1' });
    assert.deepEqual([changed.written, changed.changed, changed.row.name], [true, ['name'], 'Course 1']);
    assert.notEqual(fs.readFileSync(file('canonical-courses'), 'utf8'), compact);
    assert.equal(auditCount(), n + 1);
});
