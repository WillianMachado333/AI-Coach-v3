const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsersStore, DEFAULT_BOOTSTRAP_ADMIN } = require('../lib/usersStore');

function withStore(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-coach-users-'));
    try { return run(createUsersStore({ dir, env: {} })); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('local user registry bootstraps Willian as administrator', () => withStore((store) => {
    const user = store.get(DEFAULT_BOOTSTRAP_ADMIN);
    assert.equal(user.identity, DEFAULT_BOOTSTRAP_ADMIN);
    assert.equal(user.role, 'admin');
    assert.equal(user.loginCount, 0);
}));

test('successful login creates a local user and records subsequent access', () => withStore((store) => {
    const first = store.recordSuccessfulLogin(' New.User@Example.test ');
    const second = store.recordSuccessfulLogin('new.user@example.test');
    assert.equal(first.role, 'user');
    assert.equal(second.loginCount, 2);
    assert.ok(second.lastLoginAt);
}));

test('roles persist locally and cannot remove the final administrator', () => withStore((store) => {
    assert.throws(() => store.setRole(DEFAULT_BOOTSTRAP_ADMIN, 'user', 'tester'), /At least one active administrator/);
    store.recordSuccessfulLogin('second@example.test');
    const admin = store.setRole('second@example.test', 'admin', DEFAULT_BOOTSTRAP_ADMIN);
    assert.equal(admin.role, 'admin');
    const changed = store.setRole(DEFAULT_BOOTSTRAP_ADMIN, 'user', 'second@example.test');
    assert.equal(changed.role, 'user');
}));
