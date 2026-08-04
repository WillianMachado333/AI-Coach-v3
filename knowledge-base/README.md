# Knowledge Base

This directory holds source content that gets uploaded into OpenAI Vector Stores at runtime.

## Structure

- `frameworks/` — Coaching frameworks. Committed to git. Uploaded once to a shared
  vector store via `scripts/init-frameworks-store.js`, then referenced by every session.
- `reports/` — User-facing quiz reports. **Not committed.** Fetched from Wix per session
  via `_functions/ericaPreparation` and synced into per-user vector stores.

## How updates flow

**Frameworks** (rare updates):
1. Edit or add a markdown file in `frameworks/`
2. Commit + push
3. Re-run `node scripts/init-frameworks-store.js` — replaces content in the shared store

**User reports** (per session):
1. On session start, server fetches ericaPreparation for the user
2. Extracts the report body, hashes it
3. If hash differs from last upload for that user, uploads to `user-<userId>` store
4. Session's `search_knowledge` tool queries both stores
