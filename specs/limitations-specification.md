# AgentErica Limitations Specification

## Overview

This document defines the usage limitations and access controls for different user types in the AgentErica AI Coach system.

## User Type Limitations

### Guest Users
- **Text Access**: ✅ **Unlimited** - No response-count limitations
- **Voice Access**: ❌ **Blocked** - Voice features require registration
- **Conversation Memory**: ❌ **Not available** - Session-only persistence
- **Persona Customization**: ❌ **Not available** - Default personas only

### Free Members
- **Text Access**: ✅ **Unlimited** - No response-count limitations  
- **Voice Access**: ✅ **Limited** - System-configured daily limits
- **Conversation Memory**: ✅ **Available** - Persistent conversation history
- **Persona Customization**: ✅ **Available** - Name and voice speed customization

### Paying Members
- **Text Access**: ✅ **Unlimited** - No response-count limitations
- **Voice Access**: ✅ **Extended** - Higher daily limits (initially 250 responses)
- **Conversation Memory**: ✅ **Available** - Persistent conversation history
- **Persona Customization**: ✅ **Available** - Name and voice speed customization

## Voice Limit Implementation

### Daily Limits
- **Free Members**: Configurable limit (e.g., 25 responses per day)
- **Paying Members**: Higher configurable limit (e.g., 250 responses per day)
- **Guest Users**: Zero - voice access completely blocked

### Limit Enforcement Points
1. **Voice Session Start**: Check remaining voice allowance
2. **Voice Response Count**: Increment with each AI response during voice mode
3. **Limit Reached**: Block further voice interactions, show upgrade prompt

### Reset Behavior
- **Frequency**: Daily reset at midnight (user's timezone)
- **Counter Reset**: Voice usage count returns to zero
- **User Notification**: Inform user of reset via UI

## Text Access Philosophy

**Design Decision**: Text-based interactions are intentionally unlimited for all user types.

### Rationale
1. **Accessibility**: Ensure immediate help is always available
2. **Onboarding**: Allow users to experience value before registration
3. **Inclusivity**: Remove barriers to text-based guidance
4. **Conversion**: Use unlimited text as upgrade incentive for voice features

### Implementation
- No textQuestionsLimit field in preparation response
- No limit checking in sendTextMessage() function
- No text usage tracking or limit events

## Upgrade Triggers

### Free Member Voice Limit Events
When Free Member reaches daily voice limit:
1. **Show Upgrade Modal**: Display benefits of upgrading
2. **Block Voice**: Prevent further voice interactions
3. **Allow Text**: Continue unlimited text access
4. **Track Event**: Fire "Voice Limit Reached" analytics event

### Guest User Voice Attempt Events
When Guest User attempts voice interaction:
1. **Show Sign-Up Modal**: Explain voice requires registration
2. **Block Voice**: Prevent voice access
3. **Allow Text**: Continue unlimited text access  
4. **Track Event**: Fire "Requested Sign Up" analytics event

## System Protection Controls

### Fair Use Policies
- Paying Members subject to "fair use" despite higher limits
- System can implement additional protection controls
- Abuse detection and prevention mechanisms

### Resource Management
- Voice interactions consume more server resources
- Limits help manage infrastructure costs
- Text interactions have minimal resource impact

## Configuration

### System Configurable Limits
- Voice limits set via preparation API response
- Limits can be adjusted without code deployment
- Different limits per membership tier supported

### Preparation Response Fields
```json
{
  "questionsLimit": 25,        // Voice limit for current user
  "userType": "free",          // User's membership level
  "hasVoiceAccess": true       // Whether voice is enabled
}
```

## Analytics Events

### Limitation-Related Events
- `"Voice Limit Reached"` - When Free Member hits daily limit
- `"Requested Sign Up"` - When Guest attempts voice access
- `"Voice Usage Incremented"` - Each voice response consumed

### Upgrade Events  
- `"Upgrade Prompt Shown"` - When upgrade modal displayed
- `"Upgrade Requested"` - When user clicks upgrade button
- `"Sign Up Requested"` - When user clicks sign-up button

## Future Considerations

### Potential Text Limitations
If business requirements change, text limits could be added:
- Add `textQuestionsLimit` to preparation response
- Implement limit checking in `sendTextMessage()`
- Add text limit events and upgrade prompts
- Update UI to show text usage and limits

### Tier-Based Limitations
- Multiple membership tiers with different limits
- Graduated access to features
- Custom limits for special user segments
