// The voice models this deployment runs, read once from the environment.
// server.js uses them for the proxies and /api/voice-mode; the Studio's
// `health` tool (lib/studioTools.js) reports the same values. The reasoning
// behind each default is in server.js next to where they are used.
'use strict';

const REALTIME_MODEL =
    process.env.ERICA_REALTIME_MODEL ||
    process.env.REALTIME_MODEL ||
    'gpt-realtime';

const VOICE_API = (process.env.ERICA_VOICE_API || 'realtime').toLowerCase() === 'live'
    ? 'live'
    : 'realtime';

const LIVE_BACKEND_MODEL = process.env.ERICA_LIVE_BACKEND_MODEL || 'gpt-5.6-terra';

module.exports = { REALTIME_MODEL, VOICE_API, LIVE_BACKEND_MODEL, LIVE_MODEL: 'gpt-live-1' };
