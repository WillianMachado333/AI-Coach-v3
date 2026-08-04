# Voice Profiles System

## Overview

Each persona (character) now has a detailed voice profile that conditions the AI's voice generation style. The profiles are stored in `voiceProfiles.json` and automatically loaded when the app starts.

## File Structure

- **`voiceProfiles.json`**: Contains all persona profiles with:
  - Character name and role
  - OpenAI voice model mapping
  - Backstory and quirk
  - Detailed voice profile (affect, tone, pacing, emotion, pronunciation, pauses)

## How It Works

1. **On App Load**: `loadVoiceProfiles()` fetches `voiceProfiles.json` and loads all profiles
2. **Default Profile**: Erica (Marin voice) is set as default
3. **Voice Selection**: When a user selects a voice:
   - `setSelectedVoice()` updates the voice
   - `updateVoiceProfile()` finds and sets the matching persona profile
4. **Session Configuration**: When connecting to OpenAI:
   - `configureSession()` builds instructions including:
     - Persona backstory and quirk
     - Detailed voice style guidelines
     - Custom instructions (if any)

## Voice Mappings

| Character | Role | OpenAI Voice | Key in JSON |
|-----------|------|--------------|-------------|
| Erica | Leader | Marin | `erica` |
| Albert | Mentor | Ash | `albert` |
| Flora | Nature | Coral | `flora` |
| Arthur | Tank | Echo | `arthur` |
| Jasmine | Analyst | Alloy | `jasmine` |
| Hiro | Rookie | Verse | `hiro` |
| Jade | Creative | Sage | `jade` |
| Omar | Strategist | Ballad | `omar` |

## Voice Profile Structure

Each profile includes:

```json
{
  "character": "Character Name",
  "role": "Role Title",
  "openaiVoice": "openai-voice-model",
  "thumb": "path/to/thumbnail.png",
  "backstory": "Character backstory...",
  "quirk": "Character quirk...",
  "voiceProfile": {
    "affect": "Voice affect description",
    "tone": "Tone description",
    "pacing": "Pacing description",
    "emotion": "Emotion description",
    "pronunciation": "Pronunciation description",
    "pauses": "Pauses description"
  }
}
```

## Future: API Integration

Currently, profiles are loaded from a local JSON file. In the future, you can:

1. Create an API endpoint (e.g., `/api/voice-profiles`)
2. Replace `loadVoiceProfiles()` to fetch from API instead
3. Optionally cache profiles locally for offline use

Example API integration:

```javascript
async loadVoiceProfiles() {
    try {
        // Try API first
        const response = await fetch(this.apiUrl('/api/voice-profiles'));
        if (response.ok) {
            this.voiceProfiles = await response.json();
            return;
        }
    } catch (error) {
        console.warn('[Erica] API fetch failed, using local file');
    }
    
    // Fallback to local file
    try {
        const response = await fetch(this.apiUrl('voiceProfiles.json'));
        if (response.ok) {
            this.voiceProfiles = await response.json();
        }
    } catch (error) {
        console.error('[Erica] Error loading voice profiles:', error);
    }
}
```

## Instructions Sent to OpenAI

When a persona is selected, the instructions sent to OpenAI include:

1. **Persona Introduction**: "You are [Character], [Role] at Talent Transformation..."
2. **Backstory**: Character's background story
3. **Quirk**: Character's unique quirk
4. **Voice Style Guidelines**: Detailed instructions on:
   - Voice Affect
   - Tone
   - Pacing
   - Emotion
   - Pronunciation
   - Pauses
5. **Custom Instructions**: Any additional instructions from the API (if available)

This ensures the AI model embodies the selected persona's voice style in all responses.

