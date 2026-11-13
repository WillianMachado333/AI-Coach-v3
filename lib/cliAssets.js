// The Coach Studio CLI and its Skill, served by the Studio itself so the
// install command needs nothing else: `curl -fsSL <origin>/cli/install.sh | bash`
// or `irm <origin>/cli/install.ps1 | iex`. Each file carries __ORIGIN__ where
// the Studio's own address goes (mcpAuth.issuer(): PUBLIC_ORIGIN, else the
// Railway domain), so what a person installs from staging talks to staging and
// from production to production. The text the Studio shows to paste into an
// assistant is built here too, so the page and the tests share it.
'use strict';

const fs = require('fs');
const path = require('path');
const mcpAuth = require('./mcpAuth');

const DIR = path.join(__dirname, '..', 'cli');
const FILES = {
    '/cli/coach-studio.mjs': ['coach-studio.mjs', 'text/javascript; charset=utf-8'],
    '/cli/SKILL.md': ['SKILL.md', 'text/markdown; charset=utf-8'],
    '/cli/install.sh': ['install.sh', 'text/x-shellscript; charset=utf-8'],
    '/cli/install.ps1': ['install.ps1', 'text/plain; charset=utf-8'],
};

function render(name, origin = mcpAuth.issuer()) {
    // Always LF: a checkout with Windows line endings must not hand bash a script full of carriage returns.
    return fs.readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n').replace(/__ORIGIN__/g, origin);
}

/** The text to paste into an assistant that has a terminal (Claude Code, Codex, ...). */
function installPrompt(origin = mcpAuth.issuer()) {
    return [
        'Install the Coach Studio CLI and Skill using the command for my operating system:',
        `macOS / Linux: curl -fsSL ${origin}/cli/install.sh | bash`,
        `Windows PowerShell: irm ${origin}/cli/install.ps1 | iex`,
        'After installation, read the Skill and guide me through sign-in and authorization.',
    ].join('\n');
}

// GET /cli/<file>: no-store, so a fix reaches the next install at once.
function handle(req, res) {
    const pathOnly = String(req.url || '').split('?')[0];
    const entry = FILES[pathOnly];
    if (!entry) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
        res.end('GET only');
        return true;
    }
    let body;
    try { body = render(entry[0]); } catch (e) {
        console.error('[cliAssets] 🔴 cannot read ' + entry[0] + ':', e.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('not available');
        return true;
    }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
}

module.exports = { handle, render, installPrompt, FILES };
