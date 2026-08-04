# AgentErica Feature Requirements

## User Types

- **Free Member**: Registered user without active paid subscription
- **Guest User**: Non-registered user accessing without account/login
- **Paying Member**: Registered user with active paid subscription
- **Registered User**: Free member or Paying Member
- **User**: Any of the above (Guest, Free, or Paying)

## Interaction Modes

### Text-Based Interactions
- Allow users to engage in ongoing conversations **without response-count limitations**
- Available to all user types (Guest, Free, Paying)
- No daily limits on text messages

### Voice-Based Interactions  
- Provide natural, conversational experience
- **Subject to daily response limits** by user status and membership level
- Guest Users **do not have access** to voice interactions
- Free Members have system-configured daily voice usage limits
- Paying Members have configurable daily limit (initially 250 responses)

## Core Features

### Guest User Access
**Requirement**: As a Guest User, I should be able to start an AI Coach interaction without registering, so that I can receive immediate guidance.

**Acceptance Criteria**:
- Guest User can initiate AI Coach interaction without creating account
- Guest User must select coaching persona before interaction begins
- Guest User can engage in text-based conversations immediately

### Sign-Up Prompt for Guest Users
**Requirement**: As a Guest User, I should be encouraged to sign up, so that the AI Coach can provide more personalized and continuous guidance.

**Acceptance Criteria**:
- Sign-up prompt should appear at appropriate points in user journey
- Prompt should emphasize benefits of personalized guidance
- Prompt should not block immediate text access

### Persona Selection
**Requirement**: As a User, I should be able to select a coaching persona, so that I can receive guidance in a style that matches my preferences.

**Acceptance Criteria**:
- User must select persona before interaction begins
- Multiple persona options available with distinct coaching styles
- Persona selection persists during session
- User can switch personas during interaction

### Text-Based Interaction
**Requirement**: As a User, I should be able to interact via text, so that I can receive written guidance and maintain a conversation history.

**Acceptance Criteria**:
- Real-time text messaging with AI Coach
- No response-count limitations for text
- Conversation history maintained for registered users
- Real-time transcription of all interactions

### Guest User Voice Interaction Restrictions
**Requirement**: As a Guest User attempting voice interaction, I should be informed that voice features require registration, so that I understand the value of signing up.

**Acceptance Criteria**:
- Voice features blocked for Guest Users
- Clear messaging about voice requiring registration
- Sign-up prompt when Guest attempts voice access
- Seamless transition to text mode

### Voice-Based Interaction (Members)
**Requirement**: As a Registered Member, I should be able to interact via voice, so that I can have natural, conversational experiences with the AI Coach.

**Acceptance Criteria**:
- Voice interaction available for registered users only
- Real-time voice conversation with AI
- User interruption capabilities
- Defined listening timeouts
- Real-time transcription during voice sessions

### Voice Usage Limits
**Requirement**: As a Free Member, I should be subject to daily voice usage limits, so that platform resources are managed fairly.

**Acceptance Criteria**:
- System-configured daily voice limits for Free Members
- Clear tracking of voice usage
- Limit reset functionality (daily)
- Upgrade prompt when limit reached

### Upgrade Prompts
**Requirement**: As a Free Member reaching voice limits, I should be prompted to upgrade, so that I can continue voice interactions.

**Acceptance Criteria**:
- Upgrade prompt appears when voice limit reached
- Clear benefits of upgrading explained
- Seamless upgrade flow
- Option to continue with text interaction

## Architectural Requirements

### Persistent Conversational Memory
- Available only to registered users
- Maintains context across sessions
- References quiz results and prior conversations
- Enables continuous rather than isolated interactions

### Cross-Platform Consistency
- Single shared interface in iframe (web) and WebView (native)
- Consistent behavior across desktop browsers, mobile browsers, and My Talents app
- Minimal divergence between web and app implementations

### Behavioral Controls
- Real-time transcription for accessibility
- User interruption capabilities
- Defined listening timeouts
- Predictable and respectful audio experience
