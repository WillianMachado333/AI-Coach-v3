# AgentErica - Native App Bridge Specification

> Communication contract between the AgentErica web app and native iOS/Android host apps.

## Architecture Overview

AgentErica runs inside a WebView (iOS WKWebView / Android WebView). Communication between the web layer and the native host uses two channels:

| Channel | Direction | Mechanism |
|---------|-----------|-----------|
| **Web -> Native** | Outbound | `messageToApp(payload)` -- calls `window.JSInterface.ericaMessage(json)` (Android) or `window.webkit.messageHandlers.ericaMessage.postMessage(payload)` (iOS) |
| **Native -> Web** | Inbound | Call `window.EricaStateBridge.*` methods, or inject JavaScript directly |

All outbound events use a unified JSON payload:

```json
{
  "clevertapEvent": "Event Name",
  "clevertapProperties": {
    "Persona": "Erica",
    ...additional metadata
  }
}
```

The native app receives this payload and forwards it to CleverTap (or any analytics provider) using the native SDK.

---

## CleverTap Events Specification

### Summary Table

| # | Event Name | Trigger | Key Metadata |
|---|-----------|---------|--------------|
| a | `Selected Persona` | User selects a coach/persona | `Persona` |
| b | `Reviewed Persona Info` | User clicks Info button on a persona card | `Persona` |
| c | `Reviewed Persona Voice` | User clicks voice preview button on a persona card | `Persona` |
| d | `Asked AI Coach text` | User sends a text question | `Persona`, `Question`, `TextQuestionCount` |
| e | `Received from AI Coach text` | AI responds in text mode | `Persona`, `Response`, `ResponseLength`, `ResponseCount` |
| f | `Clicked Change Persona Name` | User opens the rename persona option | `Persona` |
| g | `Changed Persona Name` | Persona name is changed | `Persona`, `PersonaBefore`, `PersonaAfter` |
| h | `Changed Persona Voice Speed` | Voice speed is changed | `Persona`, `VoiceSpeedBefore`, `VoiceSpeedAfter` |
| i | `Clicked AI Coach Voice` | User opens voice mode | `Persona` |
| j | `Asked AI Coach Voice` | User asks a question in voice mode | `Persona`, `Question`, `VoiceQuestionCount` |
| k | `Received from AI Coach Voice` | AI responds in voice mode | `Persona`, `Response`, `ResponseLength`, `ResponseCount` |
| l | `Muted AI Voice Speaker` | User mutes the AI speaker | `Persona` |
| m | `Muted AI Voice Mic` | User mutes their mic | `Persona` |
| n | `Stopped AI Voice Mode` | User clicks Stop to exit voice mode | `Persona`, `SessionDuration` |

### Authentication Events

| # | Event Name | Trigger | Key Metadata |
|---|-----------|---------|--------------|
| o | `Shown Sign Up Prompt` | Login modal appears (unauthenticated user tries voice mode) | `Persona` |
| p | `Requested Sign Up` | User taps "Yes, I Want Personalized Guidance" | `Persona`, `Intent` |

> The Yes button also sends a separate `{ action: "ericaRequestLogin" }` payload (no `clevertapEvent`) to both the Wix parent frame and the native app. The native app should use this action to navigate to the sign-up screen.

### Additional Events (system-triggered)

| Event Name | Trigger | Key Metadata |
|-----------|---------|--------------|
| `Voice Muted - Inactivity Timeout` | 30s voice inactivity auto-mute | `Persona`, `sessionDuration`, `lastActivity` |
| `Voice Resumed - After Inactivity` | User resumes after inactivity | `Persona`, `muteDuration` |
| `Cleared Conversation` | User clears conversation history | `Persona` |

---

## Detailed Event Payloads

All events include a base `Persona` field automatically (the currently selected coach's character name).

### a. Selected Persona

```json
{
  "clevertapEvent": "Selected Persona",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** User taps a coach card in the selection modal.

---

### b. Reviewed Persona Info

```json
{
  "clevertapEvent": "Reviewed Persona Info",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** User clicks the (i) info toggle on a persona card, expanding the details panel.

---

### c. Reviewed Persona Voice

```json
{
  "clevertapEvent": "Reviewed Persona Voice",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** User clicks the speaker/audio preview button on a persona card.

---

### d. Asked AI Coach text

```json
{
  "clevertapEvent": "Asked AI Coach text",
  "clevertapProperties": {
    "Persona": "Erica",
    "Question": "What should I focus on today?",
    "TextQuestionCount": 3
  }
}
```

**Trigger:** User submits a text message in chat mode.

---

### e. Received from AI Coach text

```json
{
  "clevertapEvent": "Received from AI Coach text",
  "clevertapProperties": {
    "Persona": "Erica",
    "Response": "Here are three things to focus on...",
    "ResponseLength": 142,
    "ResponseCount": 3
  }
}
```

**Trigger:** AI completes a text response (includes text-only and text+audio in chat mode).

---

### f. Clicked Change Persona Name

```json
{
  "clevertapEvent": "Clicked Change Persona Name",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** User clicks the rename/edit option in the persona settings menu.

---

### g. Changed Persona Name

```json
{
  "clevertapEvent": "Changed Persona Name",
  "clevertapProperties": {
    "Persona": "MyCoach",
    "PersonaBefore": "Erica",
    "PersonaAfter": "MyCoach"
  }
}
```

**Trigger:** Fires immediately after the persona name is successfully changed. `Persona` reflects the new name.

---

### h. Changed Persona Voice Speed

```json
{
  "clevertapEvent": "Changed Persona Voice Speed",
  "clevertapProperties": {
    "Persona": "Erica",
    "VoiceSpeedBefore": "normal",
    "VoiceSpeedAfter": "fast"
  }
}
```

**Trigger:** Fires immediately after the voice speed setting is changed. Values: `slow`, `normal`, `fast`.

---

### i. Clicked AI Coach Voice

```json
{
  "clevertapEvent": "Clicked AI Coach Voice",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** User clicks the microphone/call button to enter voice mode.

---

### j. Asked AI Coach Voice

```json
{
  "clevertapEvent": "Asked AI Coach Voice",
  "clevertapProperties": {
    "Persona": "Erica",
    "Question": "Tell me about my strengths",
    "VoiceQuestionCount": 2
  }
}
```

**Trigger:** User's voice input is transcribed and sent to the AI in voice mode.

---

### k. Received from AI Coach Voice

```json
{
  "clevertapEvent": "Received from AI Coach Voice",
  "clevertapProperties": {
    "Persona": "Erica",
    "Response": "Based on your profile, your top strengths are...",
    "ResponseLength": 230,
    "ResponseCount": 2
  }
}
```

**Trigger:** AI completes a voice response (audio transcript received).

---

### l. Muted AI Voice Speaker

```json
{
  "clevertapEvent": "Muted AI Voice Speaker",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** User toggles the speaker off (mutes AI audio output). Only fires on mute, not on unmute.

---

### m. Muted AI Voice Mic

```json
{
  "clevertapEvent": "Muted AI Voice Mic",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** User toggles their microphone off. Only fires on mute, not on unmute.

---

### n. Stopped AI Voice Mode

```json
{
  "clevertapEvent": "Stopped AI Voice Mode",
  "clevertapProperties": {
    "Persona": "Erica",
    "SessionDuration": 145
  }
}
```

**Trigger:** User clicks Stop/End to exit voice mode. `SessionDuration` is in seconds.

### o. Shown Sign Up Prompt

```json
{
  "clevertapEvent": "Shown Sign Up Prompt",
  "clevertapProperties": {
    "Persona": "Erica"
  }
}
```

**Trigger:** The login prompt modal is displayed -- happens when an unauthenticated user tries to enter voice mode.

---

### p. Requested Sign Up

```json
{
  "clevertapEvent": "Requested Sign Up",
  "clevertapProperties": {
    "Persona": "Erica",
    "Intent": "voice"
  }
}
```

**Trigger:** User taps "Yes, I Want Personalized Guidance" in the login prompt modal. `Intent` is always `"voice"` as this prompt only appears when the user tries to start a voice session.

Additionally, a separate navigation action is sent immediately after:

```json
{ "action": "ericaRequestLogin" }
```

The native app should handle this action to navigate the user to the sign-up/login screen.

---

## Implementation Details

### Outbound: Web -> Native

All events flow through a single function `trackCoachEvent(eventName, props)` in `app.js`, which:

1. Builds the payload with base `Persona` field
2. Sends via `iframeMessaging.sendCleverTapEvent()` (for iframe/Wix parent)
3. Sends via `messageToApp()` (for native iOS/Android host)

The `messageToApp()` function in `index.html` handles platform detection:

```javascript
function messageToApp(payload) {
  var message = (typeof payload === 'string') ? payload : JSON.stringify(payload);

  // Android WebView
  if (window.JSInterface && typeof window.JSInterface.ericaMessage === 'function') {
    window.JSInterface.ericaMessage(message);
  }

  // iOS WKWebView
  if (window.webkit?.messageHandlers?.ericaMessage) {
    window.webkit.messageHandlers.ericaMessage.postMessage(payload);
  }
}
```

### Inbound: Native -> Web

Native apps can interact with state via `window.EricaStateBridge`:

| Method | Description |
|--------|-------------|
| `saveState(state)` | Persist session state |
| `loadState()` | Retrieve current session state |
| `clearState()` | Clear session state |
| `getPlatform()` | Returns detected platform string |
| `isAvailable()` | Returns whether localStorage is available |

### Native Integration Requirements

**Android** must register a JavaScript interface:
```kotlin
webView.addJavascriptInterface(EricaBridgeInterface(), "JSInterface")

class EricaBridgeInterface {
    @JavascriptInterface
    fun ericaMessage(json: String) {
        // Parse JSON, extract clevertapEvent + clevertapProperties
        // Forward to CleverTap SDK
    }
}
```

**iOS** must register a WKScriptMessageHandler:
```swift
webView.configuration.userContentController.add(self, name: "ericaMessage")

func userContentController(_ controller: WKUserContentController,
                           didReceive message: WKScriptMessage) {
    // message.body contains the payload dictionary
    // Extract clevertapEvent + clevertapProperties
    // Forward to CleverTap SDK
}
```

---

## Implementation Status

| # | Event | iframe (Wix) | Native (iOS/Android) |
|---|-------|:---:|:---:|
| a | Selected Persona | Done | Done |
| b | Reviewed Persona Info | Done | Done |
| c | Reviewed Persona Voice | Done | Done |
| d | Asked AI Coach text | Done | Done |
| e | Received from AI Coach text | Done | Done |
| f | Clicked Change Persona Name | Done | Done |
| g | Changed Persona Name | Done | Done |
| h | Changed Persona Voice Speed | Done | Done |
| i | Clicked AI Coach Voice | Done | Done |
| j | Asked AI Coach Voice | Done | Done |
| k | Received from AI Coach Voice | Done | Done |
| l | Muted AI Voice Speaker | Done | Done |
| m | Muted AI Voice Mic | Done | Done |
| n | Stopped AI Voice Mode | Done | Done |
| o | Shown Sign Up Prompt | Done | Done |
| p | Requested Sign Up | Done | Done |

> All events flow through `trackCoachEvent()` which sends to both channels.
> Events o and p also send `{ action: "ericaRequestLogin" }` separately for native navigation.
