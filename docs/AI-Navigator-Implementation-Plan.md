# AI Navigator — Implementation Plan

## Overview
A 3-question intake flow that routes users to the most appropriate AI coaching style. Lives inside the AI coach iframe so it works across all platforms (lightbox, standalone Wix page, iOS/Android app).

## UI Screens (from design mockups)

### Screen 1: Welcome
- Title: "Find your perfect coach"
- Subtitle: "Answer 3 quick questions and we'll match you with the AI coach whose style fits where you are right now."
- Bullet points: ~30 seconds, personalized, skip anytime
- CTA: "Start >" button (teal)
- "X" close button (top-right) — returns to regular coach list

### Screen 2: Question 1 — Immediate Need (Mood)
- Header: "IMMEDIATE NEED" label (teal)
- Title: "What would feel most helpful to you right now?"
- 4 options as cards with ">" chevron:
  - "A place to talk openly without being judged" → tag: OpenToTalk
  - "Help figuring out my next step" → tag: Guidance
  - "A confidence boost" → tag: NeedConfidence
  - "To feel understood" → tag: FeelUnderstood
- Progress bar: 1/3 (teal)
- Back button + X close
- Selected state: teal border highlight on the card

### Screen 3: Question 2 — Readiness
- Header: "READINESS" label
- Title: "Where are you at with this right now?"
- 3 options:
  - "I'm ready to take action" → tag: ReadyToAct
  - "I think it through" → tag: ThinkItThrough
  - "I'm not ready to take action yet" → tag: NotReadyYet
- Progress bar: 2/3

### Screen 4: Question 3 — Clarity
- Header: "CLARITY" label
- Title: "How clear are you about what's going on in your life right now?"
- 3 options:
  - "I'm clear about what's going on" → tag: Clear
  - "I mostly understand it, but need to think it through" → tag: MostlyClear
  - "I'm pretty confused and need help sorting it out" → tag: Confused
- Progress bar: 3/3

### Screen 5: Results
- Header: "✦ Your match" badge (teal)
- Title: "Meet [Coach Name]"
- Explanation: "Based on what you've shared, it sounds like you're ready to take action. We're connecting you with a coach who uses a [Style] coaching style."
- Primary match: highlighted card with coach avatar, name, style badge, description, "Connect >" button (teal, filled)
- "Also a great fit": secondary coach card with "Connect >" (outlined)
- "Browse all coaches": full coach list below with "Retake quiz" link
- Each coach shows: avatar, name, style badge, sound preview icon, info icon, "Connect >"

## Routing Logic Table (36 combinations)

```javascript
const ROUTING_TABLE = {
    "OpenToTalk|ReadyToAct|Clear":       { primary: "Empowering",  autonomy: "Exploratory" },
    "OpenToTalk|ReadyToAct|MostlyClear": { primary: "Exploratory", autonomy: "Empowering" },
    "OpenToTalk|ReadyToAct|Confused":    { primary: "Discovery",   autonomy: "Directive" },
    "OpenToTalk|ThinkItThrough|Clear":       { primary: "Exploratory", autonomy: "Empowering" },
    "OpenToTalk|ThinkItThrough|MostlyClear": { primary: "Discovery",   autonomy: "Directive" },
    "OpenToTalk|ThinkItThrough|Confused":    { primary: "Exploratory", autonomy: "Empowering" },
    "OpenToTalk|NotReadyYet|Clear":       { primary: "Supportive",  autonomy: "Empowering" },
    "OpenToTalk|NotReadyYet|MostlyClear": { primary: "Nurturing",   autonomy: "Strengths" },
    "OpenToTalk|NotReadyYet|Confused":    { primary: "Supportive",  autonomy: "Empowering" },

    "Guidance|ReadyToAct|Clear":       { primary: "Directive",   autonomy: "Exploratory" },
    "Guidance|ReadyToAct|MostlyClear": { primary: "Guidance",    autonomy: "Directive" },
    "Guidance|ReadyToAct|Confused":    { primary: "Guidance",    autonomy: "Directive" },
    "Guidance|ThinkItThrough|Clear":       { primary: "Guidance",    autonomy: "Directive" },
    "Guidance|ThinkItThrough|MostlyClear": { primary: "Guidance",    autonomy: "Directive" },
    "Guidance|ThinkItThrough|Confused":    { primary: "Exploratory", autonomy: "Empowering" },
    "Guidance|NotReadyYet|Clear":       { primary: "Supportive",  autonomy: "Empowering" },
    "Guidance|NotReadyYet|MostlyClear": { primary: "Nurturing",   autonomy: "Strengths" },
    "Guidance|NotReadyYet|Confused":    { primary: "Nurturing",   autonomy: "Strengths" },

    "NeedConfidence|ReadyToAct|Clear":       { primary: "Empowering",  autonomy: "Exploratory" },
    "NeedConfidence|ReadyToAct|MostlyClear": { primary: "Empowering",  autonomy: "Exploratory" },
    "NeedConfidence|ReadyToAct|Confused":    { primary: "Strengths",   autonomy: "Empowering" },
    "NeedConfidence|ThinkItThrough|Clear":       { primary: "Strengths",   autonomy: "Empowering" },
    "NeedConfidence|ThinkItThrough|MostlyClear": { primary: "Strengths",   autonomy: "Empowering" },
    "NeedConfidence|ThinkItThrough|Confused":    { primary: "Exploratory", autonomy: "Directive" },
    "NeedConfidence|NotReadyYet|Clear":       { primary: "Strengths",   autonomy: "Empowering" },
    "NeedConfidence|NotReadyYet|MostlyClear": { primary: "Nurturing",   autonomy: "Strengths" },
    "NeedConfidence|NotReadyYet|Confused":    { primary: "Supportive",  autonomy: "Empowering" },

    "FeelUnderstood|ReadyToAct|Clear":       { primary: "Strengths",   autonomy: "Empowering" },
    "FeelUnderstood|ReadyToAct|MostlyClear": { primary: "Nurturing",   autonomy: "Strengths" },
    "FeelUnderstood|ReadyToAct|Confused":    { primary: "Supportive",  autonomy: "Empowering" },
    "FeelUnderstood|ThinkItThrough|Clear":       { primary: "Nurturing",   autonomy: "Strengths" },
    "FeelUnderstood|ThinkItThrough|MostlyClear": { primary: "Nurturing",   autonomy: "Strengths" },
    "FeelUnderstood|ThinkItThrough|Confused":    { primary: "Supportive",  autonomy: "Empowering" },
    "FeelUnderstood|NotReadyYet|Clear":       { primary: "Nurturing",   autonomy: "Strengths" },
    "FeelUnderstood|NotReadyYet|MostlyClear": { primary: "Nurturing",   autonomy: "Strengths" },
    "FeelUnderstood|NotReadyYet|Confused":    { primary: "Supportive",  autonomy: "Empowering" }
};
```

## Architecture Decisions

### Decision 1: Navigator lives inside the iframe
The navigator UI runs inside the AI coach iframe (not on the Wix page). This ensures it works identically in:
- Wix lightbox
- Standalone Wix page
- iOS app (WebView)
- Android app (WebView)

### Decision 2: Separate `navigator.js` with dynamic DOM
- `navigator.js` is a standalone module — owns its own rendering, state, and cleanup
- **No hidden HTML in index.html** — navigator creates/destroys its own DOM dynamically (same pattern as `renderCoachList()`)
- Can be tested independently, moved, or removed without touching app.js
- Single integration point: `onComplete({ primary, autonomy, tags })` callback

### Decision 3: Navigator INFORMS the coach selector, doesn't replace it
- Navigator produces data: `{ primary: "Empowering", autonomy: "Exploratory", tags: { mood, readiness, clarity } }`
- Coach selector reads navigator result and reorders the list:
  - [1] "Your match" — primary coach (highlighted, teal border)
  - [2] "Also a great fit" — autonomy coach
  - [3] "Browse all coaches" — rest of the list + "Retake quiz" link
- If no navigator result (skipped or returning user): regular coach list as-is
- Existing coach selector stays in `uiLayout.js` — only enhanced, not moved

### Decision 4: Local JSON file + Wix API background sync
The routing table lives in two places for resilience and manageability:

**`navigatorRouting.json`** — local static file, ships with the code
- Factory default / offline fallback
- Readable, editable, git-tracked
- Used instantly on first load (zero latency)

**Wix database table** — managed from Wix dashboard (future)
- Eric/team can update routing without a code deploy
- Fetched in background after page load
- Cached in localStorage for subsequent visits

**Sync flow:**
```
First ever visit:    navigatorRouting.json (local file) → instant
                     ↓ background: fetch Wix API → cache in localStorage

Next visit:          localStorage cache (from Wix) → instant
                     ↓ background: fetch Wix API → refresh cache

Wix API down:        localStorage cache → still works
Cache empty + API down: navigatorRouting.json (local fallback) → still works

Eric updates routing: Wix dashboard → next user load → background fetch picks it up
                      → cached → all users get the update. No deploy needed.
```

### Decision 5: Psychometric tags passed to coach via instructions
After navigator completes, tags are injected into `configureSession()` instructions as human-readable context (not raw tag names):

```javascript
// In configureSession(), if navigator tags exist:
if (this.navigatorTags) {
    const tagDescriptions = {
        // Mood
        OpenToTalk: "looking for a safe space to talk openly",
        Guidance: "looking for help figuring out their next step",
        NeedConfidence: "looking for a confidence boost",
        FeelUnderstood: "wanting to feel understood",
        // Readiness
        ReadyToAct: "ready to take action",
        ThinkItThrough: "wants to think things through first",
        NotReadyYet: "not ready to take action yet",
        // Clarity
        Clear: "clear about what's going on in their life",
        MostlyClear: "mostly understands their situation but needs to think it through",
        Confused: "feeling confused and needs help sorting things out"
    };

    const mood = tagDescriptions[this.navigatorTags.mood] || this.navigatorTags.mood;
    const readiness = tagDescriptions[this.navigatorTags.readiness] || this.navigatorTags.readiness;
    const clarity = tagDescriptions[this.navigatorTags.clarity] || this.navigatorTags.clarity;

    instructions += `\n\nUSER CONTEXT (from intake assessment):\n` +
        `- The user is ${mood}\n` +
        `- The user is ${readiness}\n` +
        `- The user is ${clarity}\n` +
        `Adapt your coaching approach to match this context. ` +
        `Do not reference these labels directly — naturally adapt your tone, ` +
        `questions, and guidance to match the user's state.`;
}
```

This way the coach naturally adapts without awkwardly saying "I see your tag is NeedConfidence."

## File Structure

```
AgentErica-dev/
├── navigator.js              ← NEW: self-contained module (logic + UI rendering)
├── navigatorRouting.json     ← NEW: routing table (36 routes, readable, git-tracked)
├── app.js                    ← minimal integration: shouldShowNavigator() + onComplete callback
├── uiLayout.js               ← coach selector enhanced: reads navigator result, reorders list
├── styles.css                ← navigator-specific styles added
├── index.html                ← script tag for navigator.js added (NO hidden HTML)
└── ...
```

## Integration Points

### app.js (minimal touch)
```javascript
// When deciding whether to show coach list or navigator:
if (shouldShowNavigator()) {
    navigator.show(companionsList, (result) => {
        // result = { primary: "Empowering", autonomy: "Exploratory", tags: {...} }
        this.navigatorTags = result.tags;
        localStorage.setItem('navigatorResult', JSON.stringify(result));
        // Coach selector reorders based on result
        this.renderCoachList(this.lastCompanions, result);
    });
} else {
    this.renderCoachList(this.lastCompanions);
}
```

### uiLayout.js (coach selector enhancement)
```javascript
// renderCoachList receives optional navigatorResult
function renderCoachList(companions, navigatorResult) {
    if (navigatorResult) {
        // Render: "Your match" header + primary coach (highlighted)
        // Render: "Also a great fit" + autonomy coach
        // Render: "Browse all coaches" + "Retake quiz" link + remaining coaches
    } else {
        // Render: regular coach list (existing behavior)
    }
}
```

## Flow Integration

```
App loads → check if navigator should show
    │
    ├── IF first visit (no coach selected, no savedState, no navigatorResult in localStorage)
    │   └── Show navigator welcome screen
    │       └── User answers 3 questions
    │           └── navigator.js looks up routing table
    │               └── Returns { primary, autonomy, tags } via onComplete callback
    │                   └── Coach selector reorders with recommendation
    │                       └── User clicks "Connect >"
    │                           └── setSelectedVoice(coach) → connect() → opening line
    │
    ├── IF returning user with navigator result (localStorage has navigatorResult)
    │   └── Skip navigator questions, show coach selector with saved recommendation
    │
    ├── IF returning user with saved coach (savedState has coach, no navigatorResult)
    │   └── Skip everything, go straight to coach (existing flow)
    │
    ├── IF "Retake quiz" clicked
    │   └── Clear navigatorResult from localStorage → show navigator question 1
    │
    └── IF "X" / skip clicked during navigator
        └── Show regular coach list (no recommendation highlighting)
```

## Analytics Events
- `Navigator Started` — user clicks "Start"
- `Navigator Question Answered` — { questionNumber, questionLabel, tag }
- `Navigator Completed` — { mood, readiness, clarity, primaryCoach, autonomyCoach }
- `Navigator Coach Selected` — { coach, wasRecommended: true/false }
- `Navigator Skipped` — user clicked X or "Skip"

All events use existing `trackCoachEvent()` → fires to CleverTap + iframe postMessage + native bridge.

## Storage
- `localStorage['navigatorResult']` — `{ primary, autonomy, tags, timestamp }`
- Used to skip navigator on return visits and to restore recommendation in coach selector
- "Retake quiz" clears this key
- Tags also stored in `this.navigatorTags` in memory for `configureSession()` injection

## Decision 6: Weighted Scoring (not flat lookup table)

### Problem
The current spec defines a flat 36-row routing table (4 × 3 × 3). If marketing adds one option or one question, the combinations explode and the table becomes unmanageable:

| Change | Combinations |
|---|---|
| Current (4 × 3 × 3) | 36 |
| Add 1 option to Q1 (5 × 3 × 3) | 45 (+9 new routes) |
| Add Q4 with 3 options (4 × 3 × 3 × 3) | 108 (+72 new routes) |

### Solution: Weighted scoring per option
Each answer option carries weights per coaching style. After all questions, sum the weights and rank. Top score = primary, second = autonomy.

```json
{
  "text": "A confidence boost",
  "tag": "NeedConfidence",
  "weights": { "Empowering": 3, "Strengths": 2, "Supportive": 1 }
}
```

### Why this is better
- **Add a question:** just add an entry with weighted options — scoring auto-incorporates it
- **Add an option:** just define its weights — no table explosion
- **Remove a question:** delete it — scoring still works with remaining questions
- **Rebalance:** adjust weights in JSON — immediate effect, no code change
- Marketing manages a single JSON file, not a combinatorial matrix

### Scoring logic (~10 lines)
```javascript
function computeMatch(answers, questions) {
    const scores = {};
    for (const answer of answers) {
        const weights = answer.selectedOption.weights || {};
        for (const [style, weight] of Object.entries(weights)) {
            scores[style] = (scores[style] || 0) + weight;
        }
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    return {
        primary: ranked[0]?.[0] || null,
        autonomy: ranked[1]?.[0] || null,
        scores
    };
}
```

### Data format (questions + weights in one file)
```json
{
  "version": "1.0",
  "lastUpdated": "2026-02-24",
  "questions": [
    {
      "id": "mood",
      "label": "IMMEDIATE NEED",
      "title": "What would feel most helpful to you right now?",
      "options": [
        { "text": "A place to talk openly without being judged", "tag": "OpenToTalk", "weights": { "Supportive": 3, "Nurturing": 2, "Exploratory": 1 } },
        { "text": "Help figuring out my next step", "tag": "Guidance", "weights": { "Directive": 3, "Guidance": 2, "Exploratory": 1 } },
        { "text": "A confidence boost", "tag": "NeedConfidence", "weights": { "Empowering": 3, "Strengths": 2 } },
        { "text": "To feel understood", "tag": "FeelUnderstood", "weights": { "Nurturing": 3, "Supportive": 2, "Strengths": 1 } }
      ]
    },
    {
      "id": "readiness",
      "label": "READINESS",
      "title": "Where are you at with this right now?",
      "options": [
        { "text": "I'm ready to take action", "tag": "ReadyToAct", "weights": { "..." } },
        { "text": "I think it through", "tag": "ThinkItThrough", "weights": { "..." } },
        { "text": "I'm not ready to take action yet", "tag": "NotReadyYet", "weights": { "..." } }
      ]
    },
    {
      "id": "clarity",
      "label": "CLARITY",
      "title": "How clear are you about what's going on in your life right now?",
      "options": [
        { "text": "I'm clear about what's going on", "tag": "Clear", "weights": { "..." } },
        { "text": "I mostly understand it, but need to think it through", "tag": "MostlyClear", "weights": { "..." } },
        { "text": "I'm pretty confused and need help sorting it out", "tag": "Confused", "weights": { "..." } }
      ]
    }
  ]
}
```

### Reverse-engineering weights from the existing 36-row table
The current flat table must be analyzed to derive weights that reproduce the same primary/autonomy results for all 36 combinations. Approach:
1. For each coaching style, count how often it appears as primary vs autonomy across the 36 rows
2. Identify which mood/readiness/clarity tags strongly correlate with each coaching style
3. Assign weights (1-3 scale) that when summed reproduce the same ranking
4. Validate: run all 36 input combinations through the weighted scorer and compare against the flat table
5. If any mismatches, adjust weights and re-validate until 100% match

**This must produce identical results to the current table before going live.**
The flat table stays in the doc as the source of truth for validation.

## Open Questions
1. Should the navigator show on every fresh visit, or only once per user?
2. Does the "X" close go to the regular coach list, or close the coach entirely?
3. Should navigator results be sent to the server (for analytics beyond CleverTap) or kept client-side only?
4. Does the "Retake quiz" link reset the current coach connection, or just show new recommendations?
5. Should the psychometric tags be visible to the user (e.g., "Your profile: Open to talk, Ready to act, Mostly clear")?
6. TTL for navigator result — should the recommendation expire after X days, prompting retake?
