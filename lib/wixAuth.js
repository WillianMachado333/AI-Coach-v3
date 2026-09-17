'use strict';

// Wix Headless OAuth with PKCE. Wix/Talent Transformation owns credentials;
// this service receives only a verified identity after the code exchange.
const crypto = require('crypto');

const API = 'https://www.wixapis.com';

function b64url(value) { return Buffer.from(value).toString('base64url'); }
function callbackUri(env = process.env) {
    const origin = env.AI_COACH_ORIGIN
        || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT || 3000}`);
    return `${origin.replace(/\/$/, '')}/admin/auth/callback`;
}
function newPkce() {
    const verifier = b64url(crypto.randomBytes(32));
    return {
        verifier,
        state: b64url(crypto.randomBytes(24)),
        challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    };
}
async function token(body) {
    const response = await fetch(`${API}/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Wix token request failed (${response.status})`);
    return response.json();
}
async function beginWixLogin(env = process.env) {
    const clientId = env.WIX_CLIENT_ID;
    if (!clientId) throw new Error('WIX_CLIENT_ID is not configured');
    const visitor = await token({ clientId, grantType: 'anonymous' });
    if (!visitor.access_token) throw new Error('Wix did not return a visitor token');
    const pkce = newPkce();
    const response = await fetch(`${API}/_api/redirects-api/v1/redirect-session`, {
        method: 'POST',
        headers: { authorization: visitor.access_token, 'content-type': 'application/json' },
        body: JSON.stringify({ auth: { authRequest: {
            redirectUri: callbackUri(env), clientId, codeChallenge: pkce.challenge,
            codeChallengeMethod: 'S256', responseMode: 'fragment', responseType: 'code',
            scope: 'offline_access', state: pkce.state,
        } } }),
    });
    if (!response.ok) throw new Error(`Wix could not start sign-in (${response.status})`);
    const url = (await response.json())?.redirectSession?.fullUrl;
    if (!url) throw new Error('Wix did not return a sign-in URL');
    return { url, pkce: { verifier: pkce.verifier, state: pkce.state } };
}
async function completeWixLogin({ code, state, pkce }, env = process.env) {
    const clientId = env.WIX_CLIENT_ID;
    if (!clientId || !pkce || !code || !state || pkce.state !== state) throw new Error('Wix sign-in could not be verified');
    const granted = await token({ clientId, grantType: 'authorization_code', redirectUri: callbackUri(env), code, codeVerifier: pkce.verifier });
    if (!granted.access_token) throw new Error('Wix did not return a member token');
    const response = await fetch(`${API}/members/v1/members/my?fieldSet=EXTENDED`, { headers: { Authorization: granted.access_token } });
    if (!response.ok) throw new Error(`Wix could not identify the member (${response.status})`);
    const member = (await response.json())?.member;
    if (!member?.loginEmail || !member?.id) throw new Error('Wix did not provide a member email');
    const name = `${member.contact?.firstName || ''} ${member.contact?.lastName || ''}`.trim() || member.profile?.nickname || member.loginEmail;
    return { email: member.loginEmail, fullName: name, memberId: member.id };
}

module.exports = { callbackUri, newPkce, beginWixLogin, completeWixLogin };
