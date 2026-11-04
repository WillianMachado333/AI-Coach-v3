/**
 * lib/wixSite.js — which Wix site answers for a person.
 *
 * A Wix member id only means something on the site that issued it. A person
 * signed in on awav.com (the sandbox) is unknown to talenttransformation.com,
 * which then answers as for a guest: no name, every quiz "not taken", no
 * results — and the coach tells a member who just finished a quiz to go and
 * open the report (Willian, 3 Nov 2026). The coach knows the page it sits on
 * (`context.hostPage`, from the frame's referrer); when that page is one of
 * our Wix sites, that site answers. Anything else gets the configured default.
 */

const WIX_SITES = Object.freeze(['talenttransformation.com', 'awav.com']);

/** The Wix site a page belongs to, or null when it is none of ours. */
function siteOf(pageUrl) {
    if (typeof pageUrl !== 'string' || !pageUrl) return null;
    let host;
    try { host = new URL(pageUrl).hostname.toLowerCase(); } catch (_) { return null; }
    if (host.startsWith('www.')) host = host.slice(4);
    return WIX_SITES.includes(host) ? host : null;
}

/** The host to ask: the page's own Wix site, else the fallback. */
function wixHostFor(pageUrl, fallbackHost) {
    return siteOf(pageUrl) || fallbackHost;
}

module.exports = { WIX_SITES, siteOf, wixHostFor };
