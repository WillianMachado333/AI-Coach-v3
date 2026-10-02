"""Bounded browser runs for verification harnesses (#40).

On 2026-09-29 fake-mic Playwright runs that never ended kept GPT-Live
connections open for hours: ~1,760 billed minutes (~$88). Every script that
drives a browser against the coach (staging or local) opens it through this
helper, so it cannot outlive its budget:

    import sys; sys.path.insert(0, 'tests/helpers')   # from the repo root
    from harness import bounded_browser

    async with async_playwright() as p:
        async with bounded_browser(p, label='voice-call', max_seconds=600,
                                   fake_mic='call.wav') as (browser, ctx):
            page = await ctx.new_page()
            ...

- The context and the browser are closed in `finally`, whatever happens.
- A watchdog thread ends the whole process after `max_seconds` (default
  15 min), even if Playwright itself hangs: it says so on stderr and exits
  with code 124. Closing the process closes Playwright's driver and the
  browsers it launched, so a stuck run stops billing at the deadline.
- `fake_mic` (a WAV path) adds Chromium's fake-device flags and grants the
  microphone; the WAV loops for as long as the call is open, so give every
  call its own deadline too (hang up in your script).
"""
import contextlib
import os
import sys
import threading
import time

DEFAULT_MAX_SECONDS = 15 * 60


def _watchdog(label, max_seconds):
    started = time.time()

    def fire():
        sys.stderr.write(
            f"\n[harness] ⛔ '{label}' hit its {max_seconds:.0f} s deadline "
            f"({time.time() - started:.0f} s) — ending the process so no browser "
            "(and no Live connection) outlives it.\n")
        sys.stderr.flush()
        os._exit(124)

    t = threading.Timer(max_seconds, fire)
    t.daemon = True
    t.start()
    return t


def _launch_args(fake_mic, extra_args):
    args = list(extra_args or [])
    if fake_mic:
        args += [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-audio-capture={os.path.abspath(fake_mic)}',
            '--autoplay-policy=no-user-gesture-required',
        ]
    return args


@contextlib.asynccontextmanager
async def bounded_browser(p, label='harness', max_seconds=DEFAULT_MAX_SECONDS, fake_mic=None,
                          headless=True, args=None, context_options=None):
    """Async Playwright: yields (browser, context); always closed; hard deadline."""
    dog = _watchdog(label, max_seconds)
    browser = ctx = None
    try:
        browser = await p.chromium.launch(headless=headless, args=_launch_args(fake_mic, args))
        opts = dict(context_options or {})
        if fake_mic:
            opts.setdefault('permissions', ['microphone'])
        ctx = await browser.new_context(**opts)
        yield browser, ctx
    finally:
        dog.cancel()
        for closer in (ctx, browser):
            if closer is None:
                continue
            try:
                await closer.close()
            except Exception as e:  # noqa: BLE001 — closing must not mask the run's own error
                sys.stderr.write(f"[harness] ⚠️ '{label}': close failed: {e}\n")


@contextlib.contextmanager
def bounded_browser_sync(p, label='harness', max_seconds=DEFAULT_MAX_SECONDS, fake_mic=None,
                         headless=True, args=None, context_options=None):
    """Sync Playwright twin of bounded_browser."""
    dog = _watchdog(label, max_seconds)
    browser = ctx = None
    try:
        browser = p.chromium.launch(headless=headless, args=_launch_args(fake_mic, args))
        opts = dict(context_options or {})
        if fake_mic:
            opts.setdefault('permissions', ['microphone'])
        ctx = browser.new_context(**opts)
        yield browser, ctx
    finally:
        dog.cancel()
        for closer in (ctx, browser):
            if closer is None:
                continue
            try:
                closer.close()
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"[harness] ⚠️ '{label}': close failed: {e}\n")
