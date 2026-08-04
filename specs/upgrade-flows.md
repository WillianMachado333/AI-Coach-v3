# Upgrade Flows Specification

## Overview

This document defines the upgrade flows and membership conversion processes for the AgentErica AI Coach system.

## Upgrade Triggers

### 1. Voice Limit Reached (Free Members)
**Trigger**: Free Member exhausts daily voice limit
**User State**: Engaged user wanting more voice access
**Timing**: Peak motivation for voice features

**Flow**:
```
Voice Limit Reached → 
Show Limit Modal → 
Show Upgrade Modal → 
User Decision
```

### 2. Guest Voice Attempt (Guest Users)
**Trigger**: Guest User attempts to use voice features
**User State**: Curious about premium features
**Timing**: Feature discovery moment

**Flow**:
```
Guest Clicks Microphone → 
Show Sign-Up Prompt → 
Explain Voice Benefits → 
User Decision
```

### 3. Text Engagement (Guest Users - Optional)
**Trigger**: After N text messages from Guest User
**User State**: Satisfied with text, ready for more
**Timing**: Value demonstration complete

**Flow**:
```
N Text Messages Sent → 
Show Sign-Up Suggestion → 
Highlight Personalization Benefits → 
User Decision
```

## Upgrade Modal Specifications

### Voice Limit Modal (Free Members)

#### Content
- **Headline**: "Want more voice time?"
- **Body**: "You've reached your daily voice limit. Upgrade to continue talking."
- **Benefits**: 
  - Unlimited voice conversations
  - Personalized guidance
  - Conversation memory
- **CTA**: "Yep, upgrade me"
- **Alternative**: "Maybe later" (continues text access)

#### Technical Requirements
- Modal appears when `voiceUsage >= voiceLimit`
- Block further voice interactions
- Continue allowing text conversations
- Fire analytics events

#### Events to Fire
```javascript
trackCoachEvent('Voice Limit Reached', {
  Persona: currentPersona,
  VoiceQuestionCount: usageCount,
  DailyLimit: questionsLimit
});

trackCoachEvent('Shown Upgrade Prompt', {
  Persona: currentPersona
});
```

### Sign-Up Modal (Guest Users)

#### Content
- **Headline**: "Yes, I Want Personalized Guidance"
- **Body**: "Sign up to get voice conversations, personalized coaching, and conversation memory."
- **Benefits**:
  - Voice interactions with AI Coach
  - Personalized guidance based on your goals
  - Conversation history across sessions
- **CTA**: "Sign Up Now"
- **Alternative**: "Continue with Text" (remains as guest)

#### Technical Requirements
- Modal appears when guest attempts voice
- Block voice access for guests
- Continue text access
- Fire analytics events

#### Events to Fire
```javascript
trackCoachEvent('Shown Sign Up Prompt', {
  Persona: currentPersona
});

trackCoachEvent('Requested Sign Up', {
  Persona: currentPersona,
  Intent: 'voice' // or 'text' for text-based prompts
});
```

## Action Payloads

### Native App Integration

#### Sign-Up Action
```javascript
// Sent to both iframe parent and native app
sendToHost({ action: "ericaRequestLogin" });
messageToApp({ action: "ericaRequestLogin" });
```

#### Upgrade Action
```javascript
// Currently only sent to iframe parent - NEEDS NATIVE SUPPORT
sendToHost({ action: "ericaRequestUpgrade" });
// MISSING: messageToApp({ action: "ericaRequestUpgrade" });
```

### Required Fix
Add native bridge support for upgrade action:
```javascript
// In uiLayout.js upgrade button handler
if (typeof messageToApp === 'function') {
  messageToApp({ action: "ericaRequestUpgrade" });
}
```

## Conversion Tracking

### Funnel Events
1. **Trigger Event**: Limit reached or feature attempt
2. **Modal Shown**: Upgrade/sign-up modal displayed
3. **User Action**: Click upgrade/sign-up or dismiss
4. **Navigation**: Redirect to registration/upgrade flow
5. **Conversion**: Successful registration/upgrade

### Success Metrics
- **Conversion Rate**: % of users who upgrade after prompt
- **Prompt Effectiveness**: Which triggers work best
- **Timing Analysis**: When users are most likely to convert
- **Feature Value**: Which features drive conversions

## User Experience Considerations

### Non-Blocking Design
- **Never Block Text**: Users can always continue text conversations
- **Graceful Degradation**: Limit access without breaking experience
- **Clear Value Proposition**: Explain benefits of upgrading

### Progressive Disclosure
- **Feature Discovery**: Introduce premium features naturally
- **Value Demonstration**: Show benefits before asking for upgrade
- **Timing Optimization**: Prompt at moments of peak motivation

### Frictionless Conversion
- **Single Click**: Minimize steps to upgrade
- **Context Preservation**: Maintain conversation context during upgrade
- **Seamless Transition**: Smooth handoff to registration/upgrade flow

## Technical Implementation

### Modal State Management
```javascript
// Track modal states
this.activeModal = null; // 'signup', 'upgrade', 'limit'
this.modalContext = {};  // Trigger context, user data

// Show modal with context
showUpgradeModal(context = {}) {
  this.modalContext = context;
  this.activeModal = 'upgrade';
  // Fire analytics
  trackCoachEvent('Shown Upgrade Prompt', {
    Persona: this.currentPersona,
    Trigger: context.trigger,
    VoiceUsage: context.voiceUsage
  });
}
```

### Limit Checking Logic
```javascript
// Enhanced limit checking
checkVoiceLimit() {
  if (!this.questionsLimit) return true;
  
  const usage = this._loadVoiceUsage();
  const isLimitReached = usage.count >= this.questionsLimit;
  
  if (isLimitReached) {
    // Fire limit reached event
    this.trackCoachEvent('Voice Limit Reached', {
      Persona: this.currentPersona,
      VoiceQuestionCount: usage.count,
      DailyLimit: this.questionsLimit
    });
    
    // Show upgrade modal
    this.showUpgradeModal({
      trigger: 'limit_reached',
      voiceUsage: usage.count
    });
    
    return false;
  }
  
  return true;
}
```

### Guest Voice Blocking
```javascript
// Enhanced guest voice blocking
handleMicrophoneButtonClick() {
  const userId = this.getUserIdFromURL();
  
  if (!userId) {
    // Fire sign-up prompt event
    this.trackCoachEvent('Shown Sign Up Prompt', {
      Persona: this.currentPersona,
      Intent: 'voice'
    });
    
    // Show sign-up modal
    this.showLoginPrompt();
    return;
  }
  
  // Check voice limits for registered users
  if (!this.checkVoiceLimit()) {
    return; // Limit modal shown by checkVoiceLimit
  }
  
  // Proceed with voice
  this.startRecording();
}
```

## A/B Testing Opportunities

### Modal Content Variations
- **Benefit Ordering**: Test different benefit sequences
- **Messaging Tone**: Casual vs professional language
- **CTA Text**: Different button text variations
- **Visual Design**: Different modal layouts and imagery

### Trigger Timing
- **Voice Limit Threshold**: Prompt at 80% vs 100% of limit
- **Guest Text Prompts**: After 3, 5, or 10 text messages
- **Session Timing**: Prompt based on session duration

### Flow Variations
- **Single Step vs Multi-Step**: Direct upgrade vs benefits explanation
- **Immediate vs Delayed**: Prompt immediately vs after delay
- **Contextual vs Generic**: Personalized vs standard messaging

## Analytics and Reporting

### Conversion Dashboard Metrics
- **Upgrade Funnel**: View conversion rates at each step
- **Revenue Impact**: Track upgrade revenue generated
- **User Behavior**: How users interact with prompts
- **Feature Adoption**: Which features drive upgrades

### Event Correlation
- **Voice Usage**: Does higher voice usage lead to upgrades?
- **Text Engagement**: Does text engagement predict conversion?
- **Session Patterns**: Time-based conversion patterns

### Segmentation Analysis
- **User Type**: Guest vs Free Member conversion rates
- **Persona Preference**: Do certain personas convert better?
- **Usage Patterns**: Heavy vs light user conversion behavior
