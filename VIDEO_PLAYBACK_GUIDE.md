# Video Playback System Guide

## Overview
The companion icons now support animated video playback with three states:
- **Idle**: Plays when hovering over menu items or when a persona is selected
- **Speaking**: Plays when the bot is actively speaking/responding

## Video Format Recommendation

**WebM (VP9 codec)** is recommended for best performance:
- **Better compression** than MP4 (typically 30-50% smaller files)
- **Widely supported** in modern browsers
- **Optimized for web** with efficient streaming

The system automatically tries WebM first, then falls back to MP4 if WebM is not available.

## File Structure

Videos are stored in:
- `companions/idle/` - Idle animations (looping)
- `companions/speaking/` - Speaking animations (looping)

Each persona has two videos:
- `{Character}.mp4` (and optionally `{Character}.webm`)
- Example: `Erica.mp4`, `Sarah.mp4`, etc.

## Converting MP4 to WebM

### Windows (PowerShell)
```powershell
.\convert-videos-to-webm.ps1
```

### Mac/Linux (Bash)
```bash
chmod +x convert-videos-to-webm.sh
./convert-videos-to-webm.sh
```

### Requirements
- **ffmpeg** must be installed and in your PATH
  - Windows: `winget install ffmpeg` or download from https://ffmpeg.org/download.html
  - Mac: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt-get install ffmpeg`

### Conversion Settings
The script uses optimized settings for small looping animations:
- **Video Codec**: VP9 (libvpx-vp9)
- **Quality**: CRF 30 (good balance of quality and file size)
- **Audio Codec**: Opus (libopus) at 64k bitrate
- **Multi-threading**: Enabled for faster conversion

## How It Works

### 1. Video Elements
- Each voice selector icon has a `<video>` element with fallback `<img>`
- Videos are set to `loop`, `muted`, `playsinline`, and `preload="metadata"`
- Two `<source>` elements: WebM (preferred) and MP4 (fallback)

### 2. Video States
- **Idle**: Plays when:
  - Hovering over a menu item
  - A persona is selected (main icon)
- **Speaking**: Plays when:
  - The bot is actively speaking (detected via audio track state)

### 3. Detection Methods
The system uses multiple methods to detect when the bot is speaking:
- `remoteAudio.onplay` event
- `remoteAudio.onpause` event
- Periodic check (every 200ms) of audio track state and playback status

### 4. Fallback Behavior
- If video fails to load → shows static image
- If video fails to play → shows static image
- If no video path in profile → shows static image

## Configuration

Video paths are configured in `voiceProfiles.json`:
```json
{
  "erica": {
    "idleVideo": "companions/idle/Erica.mp4",
    "speakingVideo": "companions/speaking/Erica.mp4",
    ...
  }
}
```

## Testing

1. **Hover Test**: Hover over any persona in the voice menu → idle video should play
2. **Selection Test**: Select a persona → main icon should show idle video
3. **Speaking Test**: Start a conversation → main icon should switch to speaking video when bot responds

## Troubleshooting

### Videos not playing
- Check browser console for errors
- Verify video files exist in `companions/idle/` and `companions/speaking/`
- Check that video paths in `voiceProfiles.json` match actual file names
- Ensure videos are in MP4 or WebM format

### Videos too large
- Run the conversion script to create WebM versions (smaller file size)
- Consider reducing video resolution or frame rate if needed

### Videos not switching to speaking
- Check that `remoteAudio` is properly set up
- Verify audio track detection is working (check console logs)
- The periodic check (200ms interval) should catch MediaStream playback

## Performance Notes

- Videos use `preload="metadata"` to reduce initial load time
- Videos are muted and looped for smooth playback
- WebM format provides better compression for web delivery
- Fallback to static images ensures graceful degradation
