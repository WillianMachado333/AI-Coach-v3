// Railway stops the previous deployment with SIGTERM on every deploy. With no
// handler, Node died of the signal, npm logged "command failed / signal
// SIGTERM", and Railway reported "Deployment crashed" for each deploy
// (10 Nov 2026: production 18:55 and 19:06 UTC, staging 12:32, 12:35, 12:44).
// Those alarms looked exactly like a real crash, such as NEW-1. Now a stop
// signal closes the server: no new connections, open requests finish (up to
// graceMs), then exit 0. A "crashed" alert means a crash again.
'use strict';

function installGracefulShutdown(server, opts = {}) {
    const graceMs = Number(opts.graceMs) > 0 ? Number(opts.graceMs) : 5000;
    const exit = typeof opts.exit === 'function' ? opts.exit : (code) => process.exit(code);
    const log = opts.log || console;
    const signals = opts.signals || ['SIGTERM', 'SIGINT'];
    let stopping = false;
    let exited = false;

    const finish = (how) => {
        if (exited) return;
        exited = true;
        log.log(`[SERVER] Stopped cleanly (${how})`);
        exit(0);
    };

    function stop(signal) {
        if (stopping) return;
        stopping = true;
        log.log(`[SERVER] ${signal}: stopping — no new connections, open requests finish (up to ${Math.round(graceMs / 1000)}s)`);
        server.close(() => finish('every open request finished'));
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        const timer = setTimeout(() => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            finish(`grace of ${Math.round(graceMs / 1000)}s over; open connections closed`);
        }, graceMs);
        if (timer.unref) timer.unref();
    }

    const handlers = signals.map((signal) => {
        const handler = () => stop(signal);
        process.on(signal, handler);
        return [signal, handler];
    });
    const uninstall = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
    return { stop, uninstall };
}

module.exports = { installGracefulShutdown };
