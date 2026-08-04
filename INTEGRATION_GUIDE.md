# Integration Guide: AgentErica into Existing Express Server

## Overview

Your existing server uses Express and serves static files from `/client`. To integrate AgentErica, you have two options:

## Option 1: Add Routes to Existing Server (Recommended)

### Step 1: Copy AgentErica Files
Place all AgentErica files in a subfolder:
```
/your-server-root/
  /client/              (existing)
  /agentErica/         (new)
    index.html
    app.js
    styles.css
    agentEricaRoutes.js (new file I created)
```

### Step 2: Add Routes to Your Existing server.js

Add these lines to your existing `server.js`:

```javascript
// At the top with other requires
const agentEricaRoutes = require('./agentEricaRoutes');

// After your existing routes, add:
// AgentErica API routes
app.use('/agentErica/api', agentEricaRoutes);

// Serve AgentErica static files
app.use('/agentErica', express.static(__dirname + '/agentErica'));
```

### Step 3: Update app.js Base Path

The `app.js` already has base path detection, but you may want to set it explicitly:

In `index.html`, add before the script tag:
```html
<script>
    window.APP_BASE_PATH = '/agentErica/';
</script>
```

Or let it auto-detect (it should work automatically).

## Option 2: Run Separate Server (Alternative)

If you prefer to keep them separate:

1. Run AgentErica server on a different port (e.g., 8001)
2. Use reverse proxy in nginx to route `/agentErica/*` to `localhost:8001`

**Nginx config:**
```nginx
location /agentErica/ {
    proxy_pass http://localhost:8001/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # WebSocket support (if needed)
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## File Structure After Integration

```
/your-server-root/
  server.js                    (your existing Express server)
  agentEricaRoutes.js         (new - AgentErica API routes)
  /client/                    (existing)
  /agentErica/                (new)
    index.html
    app.js
    styles.css
```

## Testing

After integration:
1. Access: `https://apps.talenttransformation.com/agentErica/index.html`
2. The app should automatically detect base path as `/agentErica/`
3. All API calls will go to `/agentErica/api/*`
4. Routes will be handled by `agentEricaRoutes.js`

## Important Notes

1. **No npm install needed** - The routes module only uses built-in Node.js modules (https, fs, path) and Express (which you already have)

2. **CORS is already handled** - Your existing server has CORS middleware that will apply to these routes too

3. **Static files** - Express will serve `index.html`, `app.js`, `styles.css` from `/agentErica/` folder

4. **Base path detection** - The `app.js` will automatically detect it's in `/agentErica/` and adjust all API paths

## Quick Integration Steps

1. Create folder: `mkdir agentErica`
2. Copy files: `index.html`, `app.js`, `styles.css` to `agentErica/`
3. Copy `agentEricaRoutes.js` to server root (same level as your `server.js`)
4. Add 2 lines to your `server.js`:
   ```javascript
   const agentEricaRoutes = require('./agentEricaRoutes');
   app.use('/agentErica/api', agentEricaRoutes);
   app.use('/agentErica', express.static(__dirname + '/agentErica'));
   ```
5. Restart your server
6. Test: `https://apps.talenttransformation.com/agentErica/index.html`

That's it! The base path detection in `app.js` will handle the rest automatically.
