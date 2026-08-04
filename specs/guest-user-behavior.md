# Guest User Behavior Specification

## Overview

This document defines the specific behavior and limitations for Guest Users (non-registered users) in the AgentErica AI Coach system.

## Guest User Access Rights

### ✅ Available Features
- **Text-Based Conversations**: Unlimited access to text chat with AI Coach
- **Persona Selection**: Choose from available coaching personas
- **Immediate Access**: No registration required to start
- **Real-Time Transcription**: See conversation history during session

### ❌ Restricted Features  
- **Voice Interactions**: Completely blocked - voice requires registration
- **Conversation Memory**: Session-only - no persistence across sessions
- **Persona Customization**: Cannot customize names or voice speed
- **Persistent History**: Conversations lost when session ends

## Guest User Journey

### 1. Initial Access
```
Guest User lands on AI Coach → 
Select Persona → 
Begin Text Conversation
```

**Key Points**:
- No login/registration required
- Immediate text access available
- Persona selection mandatory before chat starts

### 2. Text Interaction Flow
```
Type Message → 
Send to AI → 
Receive Response → 
Continue Conversation
```

**Behavior**:
- Unlimited text messages
- Real-time conversation
- Session memory only (no persistence)

### 3. Voice Attempt Flow
```
Click Microphone → 
Show Sign-Up Prompt → 
Choose: Sign Up or Continue with Text
```

**Expected Behavior**:
- Voice access blocked
- Clear sign-up prompt explaining voice benefits
- Option to continue with text (always available)

## Sign-Up Prompt Strategy

### Current Implementation
- **Trigger**: Only when Guest User attempts voice interaction
- **Message**: "Voice features require registration"
- **Options**: "Sign Up" or "Continue with Text"

### Recommended Enhancement
- **Additional Trigger**: After N text messages (e.g., 5-10 messages)
- **Message**: "Sign up for personalized guidance and voice features"
- **Benefits Highlight**: Personalization, conversation memory, voice access

## Technical Implementation

### Guest User Detection
```javascript
// In app.js
const userId = this.getUserIdFromURL();
const isGuest = !userId; // true for guest users
```

### Access Control Logic
```javascript
// Text access - always allowed for guests
sendTextMessage() {
  // No limit checking for guests
  // Immediate access granted
}

// Voice access - blocked for guests  
handleMicrophoneButtonClick() {
  if (!userId) {
    showLoginPrompt(); // Require registration
    return;
  }
  // Proceed with voice for registered users
}
```

### Session Management
```javascript
// Guest sessions use temporary storage
const cacheKey = '__guest__'; // Guest cache key
// No persistent conversation history
// Session-only memory
```

## User Experience Considerations

### Frictionless Onboarding
- **Goal**: Immediate value without registration barriers
- **Method**: Unlimited text access as hook
- **Conversion**: Use voice features as upgrade incentive

### Clear Communication
- **Voice Limitation**: Explain why voice requires registration
- **Value Proposition**: Highlight benefits of signing up
- **Alternative**: Always provide text option as fallback

### Progressive Engagement
- **Initial Experience**: Focus on text value
- **Feature Discovery**: Introduce voice benefits naturally
- **Conversion Timing**: Prompt at optimal engagement points

## Analytics Events for Guest Users

### Current Events
- `Asked AI Coach text` - Each text question
- `Received from AI Coach text` - Each AI response
- `Shown Sign Up Prompt` - When voice attempted
- `Requested Sign Up` - When sign-up clicked

### Recommended Additional Events
- `Guest Text Threshold Reached` - After N text messages
- `Shown Sign Up Prompt (text)` - Text-based sign-up prompt
- `Guest Session Started` - Beginning of guest session
- `Guest Session Duration` - Length of guest engagement

## Conversion Strategy

### Voice as Premium Feature
- **Positioning**: Voice as premium/personalized experience
- **Barrier**: Registration required for voice access
- **Value**: Natural conversation, deeper engagement

### Text as Free Sample
- **Purpose**: Demonstrate AI Coach value
- **Quality**: Same AI quality as paid users
- **Limitation**: Only text, no persistence

### Sign-Up Triggers
1. **Voice Attempt**: Natural trigger when user wants voice
2. **Text Engagement**: After meaningful text interaction
3. **Session Duration**: After extended engagement period
4. **Feature Discovery**: When user learns about voice benefits

## Technical Constraints

### No User Identification
- **No userId**: Cannot track across sessions
- **No Email**: Cannot send follow-up communications
- **No Profile**: Cannot personalize experience

### Limited Personalization
- **Fixed Personas**: Cannot adapt to user preferences
- **No Memory**: Cannot reference past conversations
- **No Quiz Integration**: Cannot access user assessment data

### Resource Management
- **Session Storage**: Use memory-efficient session storage
- **Cleanup**: Clear guest data when session ends
- **Limits**: Implement reasonable session timeouts

## Future Enhancements

### Progressive Registration
- **Partial Accounts**: Capture email without full registration
- **Guest Persistence**: Save some guest data across sessions
- **Gradual Onboarding**: Request more data over time

### Smart Sign-Up Timing
- **Behavioral Triggers**: Prompt based on engagement patterns
- **Contextual Prompts**: Relevant to current conversation
- **Value-Based Timing**: When user most needs premium features

### Guest Analytics
- **Anonymous Tracking**: Session-level analytics without PII
- **Conversion Funnels**: Track guest to member conversion
- **Engagement Metrics**: Understand guest behavior patterns
