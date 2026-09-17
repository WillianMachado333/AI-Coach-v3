'use strict';

// Small, durable identity registry for the Admin surface. The registry is the
// source of truth for roles; hosting-provider metadata (including Wix badges)
// is never consulted for authorization.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function normalizeIdentity(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}
function splitIdentities(value) {
    return String(value || '').split(/[;,\n]/).map(normalizeIdentity).filter(Boolean);
}

const DEFAULT_BOOTSTRAP_ADMIN = 'willian.machado@talenttransformation.com';

function now() { return new Date().toISOString(); }

function createUsersStore({ dir = process.env.USER_STORE_DIR || '/data/users', env = process.env } = {}) {
    const file = path.join(dir, 'users.json');

    function ensureDir() { fs.mkdirSync(dir, { recursive: true }); }
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return { version: 1, users: Array.isArray(parsed.users) ? parsed.users : [] };
        } catch (error) {
            if (error.code === 'ENOENT') return { version: 1, users: [] };
            throw new Error(`Unable to read local user registry: ${error.message}`);
        }
    }
    function write(data) {
        ensureDir();
        const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temporary, file);
    }
    function safeUser(user) {
        return { ...user };
    }
    function findIndex(users, identity) {
        const normalized = normalizeIdentity(identity);
        return users.findIndex((user) => user.identity === normalized);
    }
    function bootstrapAdmins() {
        // Environment values are imported only while creating an empty registry
        // to make migration safe. Later changes to those values cannot grant
        // access: roles live solely in users.json.
        const configured = splitIdentities(env.INITIAL_ADMIN_EMAILS || '');
        return [...new Set([DEFAULT_BOOTSTRAP_ADMIN, ...configured])];
    }
    function ensureBootstrapUsers() {
        const data = read();
        if (data.users.length) return data.users.map(safeUser);
        const createdAt = now();
        data.users = bootstrapAdmins().map((identity) => ({
            id: crypto.randomUUID(), identity, role: 'admin', status: 'active',
            createdAt, createdBy: 'bootstrap', lastLoginAt: null, loginCount: 0
        }));
        write(data);
        return data.users.map(safeUser);
    }
    function get(identity) {
        ensureBootstrapUsers();
        const data = read();
        const index = findIndex(data.users, identity);
        return index < 0 ? null : safeUser(data.users[index]);
    }
    function list() {
        ensureBootstrapUsers();
        return read().users.slice().sort((a, b) => a.identity.localeCompare(b.identity)).map(safeUser);
    }
    function recordSuccessfulLogin(identity) {
        ensureBootstrapUsers();
        const normalized = normalizeIdentity(identity);
        if (!normalized) return null;
        const data = read();
        let index = findIndex(data.users, normalized);
        const timestamp = now();
        if (index < 0) {
            data.users.push({ id: crypto.randomUUID(), identity: normalized, role: 'user', status: 'active', createdAt: timestamp, createdBy: 'login', lastLoginAt: timestamp, loginCount: 1 });
            index = data.users.length - 1;
        } else {
            data.users[index].lastLoginAt = timestamp;
            data.users[index].loginCount = Number(data.users[index].loginCount || 0) + 1;
        }
        write(data);
        return safeUser(data.users[index]);
    }
    function setRole(identity, role, actor) {
        if (!['admin', 'user'].includes(role)) throw new Error('Invalid user role');
        ensureBootstrapUsers();
        const data = read();
        const index = findIndex(data.users, identity);
        if (index < 0) throw new Error('User not found');
        if (data.users[index].role === 'admin' && role !== 'admin' && data.users.filter((u) => u.role === 'admin' && u.status === 'active').length <= 1) {
            throw new Error('At least one active administrator is required');
        }
        data.users[index].role = role;
        data.users[index].roleUpdatedAt = now();
        data.users[index].roleUpdatedBy = normalizeIdentity(actor) || 'admin';
        write(data);
        return safeUser(data.users[index]);
    }
    return { ensureBootstrapUsers, get, list, recordSuccessfulLogin, setRole, _internal: { file } };
}

const usersStore = createUsersStore();
module.exports = { createUsersStore, usersStore, DEFAULT_BOOTSTRAP_ADMIN };
