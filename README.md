# AgentErica - Voice Chat Bot

A browser-based voice chatbot using OpenAI's Realtime API with WebRTC.

## Features

- Real-time voice conversation with AI
- WebRTC-based audio streaming
- Modern, responsive UI
- Text transcript display

## Setup

### Option 1: Using Node.js Server (Recommended)

1. Make sure you have Node.js installed
2. Open a terminal in the project directory
3. Run: `node server.js` or `npm start`
4. Open your browser and go to: `http://localhost:8000`
5. Enter your OpenAI API key in the input field
6. Click "Connect" to establish the connection
7. Click the microphone button to start/stop talking

### Option 2: Using Python Server

1. Open a terminal in the project directory
2. Run: `python -m http.server 8000` (Python 3) or `python -m SimpleHTTPServer 8000` (Python 2)
3. Open your browser and go to: `http://localhost:8000`
4. Enter your OpenAI API key in the input field
5. Click "Connect" to establish the connection
6. Click the microphone button to start/stop talking

### Option 3: Using VS Code Live Server

1. Install the "Live Server" extension in VS Code
2. Right-click on `index.html` and select "Open with Live Server"
3. Enter your OpenAI API key in the input field
4. Click "Connect" to establish the connection
5. Click the microphone button to start/stop talking

**Important:** You must use a local HTTP server. Opening `index.html` directly from the file system (file://) will cause CORS errors.

## Requirements

- Modern browser with WebRTC support
- OpenAI API key with access to Realtime API
- Microphone permissions

## Current Status

This is the initial implementation with basic voice chat functionality. Future features will include:
- Conversation history saving
- Function calling/API integration
- Voice customization
- Avatar and profile controls

## Notes

- The API key is stored in browser memory only (not sent to any server)
- Make sure you have microphone permissions enabled in your browser
- The connection uses WebRTC for optimal browser performance

## Troubleshooting

- If connection fails, verify your API key has Realtime API access
- Check browser console for detailed error messages
- Ensure microphone permissions are granted
