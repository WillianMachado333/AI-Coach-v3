# AI Coach V3: production runbook

| | Staging | Production (live since 10 Nov 2026, 08:36 UTC) |
|---|---|---|
| Railway | project `869d4706…`, environment `staging`, service `web` | project `ai-coach-v3`, environment `production`, service **`coach`** |
| Deploys from | `main`, on every merge | `release`, on push (first release: `143ae7d`) |
| Address | `https://web-staging-2c7ff.up.railway.app` | **`https://aicoaches.talenttransformation.com`** (domain on port 8080, `PORT=8080`); also `web-production-2c7ff.up.railway.app` |
| `ERICA_GO_LIVE` | off | off (V3 behind `?erica=preview`) |

Production **must never deploy from `main`**.

## 1. Release path

| Branch | Deploys to | Who moves it |
|---|---|---|
| `main` | staging, automatically on merge | every merged PR |
| `release` | production, automatically on push | a person, by promotion, after staging is checked |

**Promote** a commit that has been running on staging and passed the checks in section 5:

```bash
git fetch origin
git push origin <verified-sha>:release
```

The push must be a fast-forward. If git refuses it, `release` has commits that `main` lacks: stop and find out why. Never force-push `release`.

**Set up once (production service `coach`):**
- Railway → `coach` → Settings → Source: branch `release`, auto-deploy on. Done on 10 Nov 2026.
- GitHub → Settings → Branches → protect `release`: no force pushes, no deletion.
- The staging service `web` stays on `main`.

## 2. Environment variables

Copy every variable from staging, then change or create the ones below. Names only: values live in Railway, never in the repo.

### New secrets for production (generate fresh; never reuse staging's)

| Variable | What it is |
|---|---|
| `SESSION_SECRET` | HMAC key for the Coach Studio session cookie. A new random value (`openssl rand -base64 48`). |
| `OPENAI_API_KEY` | OpenAI key. A key in a separate production project keeps production cost and usage apart from staging. If the project changes, the vector stores must be rebuilt (see `FRAMEWORKS_STORE_ID`). |

### Shared secrets (same value as the other side expects)

| Variable | Shared with | Notes |
|---|---|---|
| `WIX_CLIENT_ID`, `WIX_CLIENT_SECRET` | Wix Headless OAuth app (Studio sign-in) | Same app, plus the production callback added in Wix (section 4). |
| `ERICA_WIX_API_SECRET` | Wix HTTP functions | Bearer sent to the configured Wix host only. |
| `WIX_IDENTITY_SECRET` | Wix (signed member identity, #28) | Only once the Wix side mints signed tokens. |
| `CLEVERTAP_ACCOUNT_ID`, `CLEVERTAP_PASSCODE`, `CLEVERTAP_REGION` | CleverTap | Activity timeline. |

### Production-specific settings

| Variable | Production value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Studio cookies get the `Secure` flag. |
| `PUBLIC_ORIGIN` | `https://aicoaches.talenttransformation.com` | Builds the Studio OAuth callback (`/auth/callback`) and the MCP origin. No trailing slash. |
| `PORT` | `8080` | The custom domain points at port 8080. |
| `ERICA_GO_LIVE` | `off` on the first deploy, `on` to launch | Shows V3 on talenttransformation.com and hides V2's "Ask Erica". Off = preview only. The rollback switch. |
| `ERICA_API_HOST` | unset (defaults to `talenttransformation.com`) | Wix site for guests. A signed-in person is looked up on the Wix site of the page they are on (#61). |
| `ERICA_REQUIRE_SIGNED_IDENTITY` | `off` until Wix mints tokens | Turning it on early refuses every member. |
| `ERICA_RATE_LIMIT_MAX` | unset (30 per minute per IP) | Preparation and history (#64). Raise it if many people share one IP (schools, offices). |
| `ERICA_HISTORY_BINDING_TTL_MS` | unset (30 min, sliding) | An unsigned history may be read or saved only from the IP that prepared it (#64). |
| `ERICA_DAILY_SPEND_ALERT_USD` | set | Daily spend alert. |
| `STORE_MESSAGE_TEXT` | **not set** (decided: conversation text is redacted in production) | Keeps conversation text on disk. A personal-data decision: never set it by copying from staging. |
| `DEPLOY_TRIGGER` | not needed | A staging trick for manual redeploys. |

### Unchanged from staging (copy as is)

Models and voice: `ERICA_VOICE_API`, `ERICA_LIVE_BACKEND_MODEL`, `DEEP_THINK_MODEL`, `KNOWLEDGE_SEARCH_MODEL`, `NAVIGATOR_MODEL`, `SUGGESTIONS_MODEL`, `ERICA_WEBSEARCH_MODEL`, the `ERICA_LIVE_*` limits, `ERICA_SPEECH_GATE`.

Knowledge: `FRAMEWORKS_STORE_ID`, `COURSES_STORE_ID`. These are OpenAI vector stores and belong to the OpenAI project of the key that created them. With a new project key, rebuild them with `npm run init:frameworks` and `npm run init:courses`, then set the printed ids.

Studio: `ERICA_STUDIO_OWNERS`.

## 3. Persistent data (`/data` volume)

Production needs a Railway volume mounted at `/data`. Every data path defaults under it. Copy the Studio's curated content from the staging volume, and **leave out everything that belongs to testers**.

**Done on 10 Nov 2026.** Only four curated files existed on staging, and all four were copied: `canonical-courses`, `canonical-quizzes`, `safety-rules` (empty, `[]`) and `studio-access.json`. Nothing from the "no" rows was copied.

| Path on staging | Copy? | What it is |
|---|---|---|
| `/data/injected/` | **yes** | Canonical blocks injected into every preparation (course and quiz names and URLs, safety rules). |
| `/data/courses/`, `/data/quizzes/`, `/data/frameworks/` | **yes** | Studio edits over the repo's course, quiz and framework content. |
| `/data/company/`, `/data/site/` | **yes**, if present | Semantic extras (company info, site content). |
| `/data/runtime-config.json` | **yes, then review** | Channel toggles (activity timeline, page context, user report sync…). |
| `/data/studio-access.json` | **yes, then review** | Who may open the Studio. |
| `/data/sessions/`, `/data/prompts/` | **no** | Session logs: testers' conversations (personal data). |
| `/data/user-settings/`, `/data/clipboard/` | **no** | Per-person coach settings and clipboard of testers. |
| `/data/agent-history/`, `/data/admin-attachments/` | **no** | Studio agent chats and uploads. |
| `/data/audit/` | **no** | Staging's audit trail. |
| `/data/activity/`, TTS preview cache | **no** | Caches. They rebuild themselves. |
| `/data/session-bookmarks.json`, `/data/prompt-budget-last.json` | **no** | Staging-only Studio state. |
| `/data/mcp/` | **no** | MCP connector registrations. Re-register them against the production domain. |

## 4. Wix

- **Studio sign-in:** in the Wix Headless OAuth app, add `https://aicoaches.talenttransformation.com/auth/callback` to the allowed redirect URIs. It must match `PUBLIC_ORIGIN` exactly, or sign-in fails after the password with no message. ⏳ **Still pending** (10 Nov 2026): until it is added, the production Studio (`/admin`) cannot sign in.
- **Bridge tag:** site-wide Custom Code on talenttransformation.com loads `https://web-production-2c7ff.up.railway.app/bridge.js`. Since 10 Nov 2026 that host is the production service `coach`, so the tag that was dangling (404) is now ours. The bridge opens the coach served by the same host (#62). If the tag is ever moved to `https://aicoaches.talenttransformation.com/bridge.js`, nothing else changes. Keep the `web-production-2c7ff` domain on `coach` while any tag still points at it.
- **The My Talents app** opens pages with `?minimal=yes`, so V3 never shows there and the app stays on V2.
- **Sign-up and upgrade from the coach:** the coach's "Yes, I Want Personalized Guidance" and "Yep, upgrade me" press the site's own buttons, found by what they say: "Login" / "Log In" (then "Sign Up") and "Upgrade Membership" (#67, #68). Without an upgrade button the bridge opens `/plans-pricing`. If the Wix header is renamed or changes language, these labels must follow.

## 4b. Voice limit (V2 production's rules, #66)

No variable: the limits come from the Wix preparation (`questionsLimit`).

| Who | Voice | Text |
|---|---|---|
| Guest | refused, with the sign-up prompt | free |
| Member, free plan | `questionsLimit` voice answers per UTC day (Wix sends 25) | free |
| Member, paid plan | effectively unlimited (Wix sends 200000) | free |

Reaching the limit mid-call ends the call like a hang-up and shows V2's limit message; the next tap shows the upgrade prompt. ⚠️ While Wix is down, the fallback preparation carries `questionsLimit: 25`, so a paid member is capped until Wix answers again, as in V2.

## 5. Checks: after each production deploy, and before promoting

| Check | Expect |
|---|---|
| `GET /api/health` | `{"status":"ok", …, "goLive": <the flag>}` |
| Deploy log, startup lines | `Voice API: live …`, `Go-live (ERICA_GO_LIVE): …`, `Identity: …`, `History guard: …`, and no 🔴 lines |
| `GET /bridge.js` with `Accept-Encoding: gzip` | 200, `Content-Encoding: gzip`, the expected `VERSION = '…'` |
| A talenttransformation.com page, flag off | no V3 icon, V2 "Ask Erica" visible |
| The same page with `?erica=preview` (flag off) | V3 icon and V2 hidden, exactly as at launch (#70) |
| The same page, flag on | V3 icon, V2 hidden |
| The V3 icon at rest | green ring and "Your AI coach is available" on hover. While the page loads only `bridge.js` and the icon image come from the coach host; the idle clip follows after the page's `load`; the coach loads on hover or click |
| The page with `?minimal=yes` | no V3 |
| Hover, then click the icon | the coach loads and opens; a typed message gets an answer |
| Signed in as a member, from the home page | the coach knows the member's name and summarizes a quiz report |
| A guest taps the call button | the sign-up prompt; "Yes" opens Wix's login; text chat still works |
| "Is this conversation private?" | the privacy answer, with a Privacy Policy link that opens |
| `/admin` | Wix sign-in works and the Studio loads (production: needs the OAuth callback, section 4) |
| `POST /api/conversation-history-fetch` for an id never prepared | 403 |

## 6. Rollback

Pick the first one that fits.

1. **V3 misbehaves for visitors:** set `ERICA_GO_LIVE` to `off`. Railway redeploys in about a minute; `bridge.js` revalidates on the next page load, V3 disappears from talenttransformation.com and V2's "Ask Erica" comes back.
2. **A bad build:** Railway → `ai-coach-v3` → `production` → `coach` → Deployments → the previous good deployment → Redeploy. Then revert the bad commit on `main`, check staging, and promote again (section 1). `release` itself is never rewound.
3. **The production service is down:** pages still load (the tag is `async` and fails quietly). `bridge.js` does not load, so its rule that hides V2 is never added and V2's "Ask Erica" shows by itself. Nothing to do on Wix; bring the service back, then check section 5.
