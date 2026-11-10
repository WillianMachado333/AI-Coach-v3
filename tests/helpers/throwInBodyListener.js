// Test-only preload (node -r). For a request carrying the header
// x-test-throw-in-end: sync | async, it adds one more 'end' listener that
// throws or rejects, the way a bug in a route's body handler would. It is
// added after server.js's own request handler ran, so it goes through
// whatever guard that handler installed on the request.
'use strict';
const http = require('node:http');

const originalCreateServer = http.createServer;
http.createServer = function createServerWithThrowingListener(...args) {
    const handler = args.find((a) => typeof a === 'function');
    if (!handler) return originalCreateServer.apply(this, args);
    const wrapped = (req, res) => {
        handler(req, res);
        const mode = req.headers['x-test-throw-in-end'];
        if (mode === 'sync') req.on('end', () => { throw new Error('test: sync throw in an end listener'); });
        if (mode === 'async') req.on('end', async () => { throw new Error('test: async throw in an end listener'); });
    };
    return originalCreateServer.apply(this, args.map((a) => (a === handler ? wrapped : a)));
};
