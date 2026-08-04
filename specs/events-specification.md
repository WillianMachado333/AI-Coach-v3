# AgentErica Events Specification

## Overview

This document defines all analytics events that should be fired by the AgentErica AI Coach system for tracking user behavior and system performance.

## Event Architecture

### Event Flow
All events flow through `trackCoachEvent(eventName, props)` which:
1. Builds payload with base `Persona` field
2. Sends via `iframeMessaging.sendCleverTapEvent()` (iframe/Wix parent)
3. Sends via `messageToApp()` (native iOS/Android host)

### Event Payload Format
```json
{
  "clevertapEvent": "Event Name",
  "clevertapProperties": {
    "Persona": "Erica",
    "...": "additional metadata"
  }
}
```

## User Interaction Events

### Persona Events
| Event | Trigger | Properties |
|-------|---------|------------|
| `Selected Persona` | User selects coach/persona | `Persona` |
| `Reviewed Persona Info` | User clicks Info button | `Persona` |
| `Reviewed Persona Voice` | User clicks voice preview | `Persona` |
| `Clicked Change Persona Name` | User opens rename option | `Persona` |
| `Changed Persona Name` | Persona name changed | `Persona`, `PersonaBefore`, `PersonaAfter` |
| `Changed Persona Voice Speed` | Voice speed changed | `Persona`, `VoiceSpeedBefore`, `VoiceSpeedAfter` |

### Text Interaction Events
| Event | Trigger | Properties |
|-------|---------|------------|
| `Asked AI Coach text` | User sends text question | `Persona`, `Question`, `TextQuestionCount` |
| `Received from AI Coach text` | AI responds in text mode | `Persona`, `Response`, `ResponseLength`, `ResponseCount` |

### Voice Interaction Events
| Event | Trigger | Properties |
|-------|---------|------------|
| `Clicked AI Coach Voice` | User opens voice mode | `Persona` |
| `Asked AI Coach Voice` | User asks question in voice | `Persona`, `Question`, `VoiceQuestionCount` |
| `Received from AI Coach Voice` | AI responds in voice mode | `Persona`, `Response`, `ResponseLength`, `ResponseCount` |
| `Muted AI Voice Speaker` | User mutes AI speaker | `Persona` |
| `Muted AI Voice Mic` | User mutes their mic | `Persona` |
| `Stopped AI Voice Mode` | User exits voice mode | `Persona`, `SessionDuration` |

## Authentication Events

### Sign-Up Events
| Event | Trigger | Properties |
|-------|---------|------------|
| `Shown Sign Up Prompt` | Login modal appears | `Persona` |
| `Requested Sign Up` | User taps sign-up button | `Persona`, `Intent` |

**Note**: Sign-up events also send separate action payload:
```json
{ "action": "ericaRequestLogin" }
```

### Upgrade Events
| Event | Trigger | Properties |
|-------|---------|------------|
| `Shown Upgrade Prompt` | Upgrade modal appears | `Persona` |
| `Requested Upgrade` | User clicks upgrade button | `Persona` |
| `Voice Limit Reached` | Free member hits daily limit | `Persona`, `VoiceQuestionCount`, `DailyLimit` |

**Note**: Upgrade events should also send separate action payload:
```json
{ "action": "ericaRequestUpgrade" }
```

## System Events

### Session Events
| Event | Trigger | Properties |
|-------|---------|------------|
| `Cleared Conversation` | User clears conversation | `Persona` |
| `Session On Hold - Inactivity Timeout` | 30min session inactivity | `Persona` |

### Voice Inactivity Events
| Event | Trigger | Properties |
|-------|---------|------------|
| `Voice Muted - Inactivity Timeout` | 30s voice inactivity auto-mute | `Persona`, `sessionDuration`, `lastActivity` |
| `Voice Resumed - After Inactivity` | User resumes after inactivity | `Persona`, `muteDuration` |

## Limitation Events

### Current Implementation Status

#### ✅ Implemented Events
- All persona events
- All text interaction events  
- All voice interaction events
- Sign-up prompt events
- Session and inactivity events

#### ❌ Missing Events
- `Voice Limit Reached` - Not fired when Free Member hits limit
- `Shown Upgrade Prompt` - Not fired when upgrade modal shown
- `Requested Upgrade` - Not fired when upgrade button clicked
- Sign-up prompt for text interactions (only triggers on voice attempts)

## Event Implementation Details

### Required Event Additions

#### 1. Voice Limit Reached Event
**Location**: `incrementVoiceUsage()` function in `app.js`
**Trigger**: When usage.count >= questionsLimit
**Properties**: `Persona`, `VoiceQuestionCount`, `DailyLimit`

#### 2. Upgrade Prompt Events  
**Location**: `showVoiceLimitUpgradeModal()` and upgrade button handler
**Trigger**: When upgrade modal shown and when upgrade clicked
**Properties**: `Persona`

#### 3. Native Bridge for Upgrade
**Location**: Upgrade button click handler in `uiLayout.js`
**Action**: Add `messageToApp({ action: "ericaRequestUpgrade" })`

#### 4. Text Sign-Up Prompt (Optional)
**Location**: Text message sending for Guest Users
**Trigger**: After N text messages from Guest User
**Properties**: `Persona`, `Intent: "text"`

## Event Priority

### High Priority (Developer Issues)
1. **Voice Limit Reached** - Free members expect this event
2. **Requested Upgrade** - Native app expects this action
3. **Shown Sign Up Prompt (text)** - Guest users need text-based prompts

### Medium Priority
1. **Upgrade Prompt Analytics** - Business intelligence value
2. **Text Sign-Up Prompts** - Improved conversion funnel

### Low Priority
1. **Additional context events** - Nice-to-have analytics

## Testing Events

### Event Verification Methods
1. **Browser Console**: Check `trackCoachEvent` calls
2. **Network Tab**: Monitor CleverTap event requests
3. **Native Bridge**: Verify `messageToApp` calls
4. **Analytics Dashboard**: Confirm event receipt

### Test Scenarios
- Guest User: Text interactions, voice attempts
- Free Member: Voice limit reached, upgrade prompts
- Paying Member: Normal voice usage
- Persona changes: Name, speed, selection
- Session management: Clear, inactivity, resume

## Event Standards

### Naming Conventions
- Use past tense for actions: `Asked`, `Received`, `Clicked`
- Use Title Case for event names
- Include `Persona` property in all user-facing events
- Include counts for recurring actions: `TextQuestionCount`, `VoiceQuestionCount`

### Property Standards
- Use camelCase for property names
- Include relevant counts and durations
- Provide context for user actions
- Maintain consistency across similar events
