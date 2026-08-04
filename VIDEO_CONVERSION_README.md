# Video Playback Implementation

## Overview
The companion icons now support video playback:
- **Idle videos** play when hovering over menu items or when a persona is selected
- **Speaking videos** play when the bot is actively speaking
- Videos automatically fall back to static images if video files are missing or fail to load

## Video Format Recommendation

**WebM (VP9 codec)** is recommended for best performance:
- Better compression than MP4 (typically 30-50% smaller files)
- Widely supported in modern browsers
- Optimized for small looping animations

The code automatically tries WebM first, then falls back to MP4 if WebM is not available.

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
  - Windows: Download from https://ffmpeg.org/download.html or use `winget install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt-get install ffmpeg`

### What the Script Does
1. Converts all `.mp4` files in `companions/idle/` to `.webm`
2. Converts all `.mp4` files in `companions/speaking/` to `.webm`
3. Uses VP9 codec with optimized settings for small file sizes
4. Preserves original MP4 files as fallback

### Conversion Settings
- **Video Codec**: VP9 (libvpx-vp9)
- **Quality**: CRF 30 (good balance between quality and file size)
- **Audio Codec**: Opus (libopus) at 64k bitrate
- **Multi-threading**: Enabled for faster conversion

## File Structure

After conversion, your folders should contain:
```
companions/
├── idle/
│   ├── Erica.mp4 (original)
│   ├── Erica.webm (converted)
│   ├── Sarah.mp4
│   ├── Sarah.webm
│   └── ...
└── speaking/
    ├── Erica.mp4 (original)
    ├── Erica.webm (converted)
    ├── Sarah.mp4
    ├── Sarah.webm
    └── ...
```

## How It Works

1. **Hover on Menu Item**: Plays idle video for that persona
2. **Select a Persona**: Plays idle video continuously
3. **Bot Starts Speaking**: Switches to speaking video
4. **Bot Stops Speaking**: Returns to idle video
5. **Video Fails**: Automatically falls back to static image

## Testing

1. Hover over different personas in the voice menu - you should see idle videos
2. Select a persona - the main icon should show idle video
3. Start a conversation - when the bot speaks, it should switch to speaking video
4. If videos don't load, static images will be shown automatically

## Troubleshooting

- **Videos not playing**: Check browser console for errors
- **Videos not converting**: Ensure ffmpeg is installed and in PATH
- **Large file sizes**: Re-run conversion with higher CRF value (e.g., 35) for smaller files
- **Poor quality**: Lower CRF value (e.g., 25) for better quality but larger files
