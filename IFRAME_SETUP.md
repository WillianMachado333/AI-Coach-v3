# Iframe Setup Guide

## ✅ What's Been Done

1. **Created `test-iframe.html`** - A local test file to test the iframe embedding
2. **Added iframe support in routes** - The API routes now allow iframe embedding
3. **Added meta tag in index.html** - Allows iframe embedding at HTML level

## 🔧 Server Configuration

### For Static Files (index.html, app.js, styles.css)

You need to ensure your Express server serves static files with headers that allow iframe embedding **and CORS**. Add this to your main `server.js` **before** the static middleware:

```javascript
// Allow iframe embedding and CORS for AgentErica static files
app.use('/agentErica', (req, res, next) => {
    const origin = req.headers.origin;
    
    // Remove X-Frame-Options if set
    res.removeHeader('X-Frame-Options');
    
    // Allow iframe embedding
    res.setHeader('Content-Security-Policy', "frame-ancestors *;");
    
    // CORS headers (required for Wix and other iframe hosts)
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    next();
});

// Then serve static files
app.use('/agentErica', express.static(__dirname + '/agentErica'));
```

**OR** if you want to be more specific and only allow certain domains:

```javascript
app.use('/agentErica', (req, res, next) => {
    res.removeHeader('X-Frame-Options');
    // Only allow from your domain
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://apps.talenttransformation.com https://talenttransformation.com;");
    next();
});
```

### For API Routes

The `agentEricaRoutes.js` already includes middleware to allow iframe embedding for API responses.

## 🧪 Testing

1. **Open `test-iframe.html`** in your browser
2. The iframe should load `https://apps.talenttransformation.com/agentErica/index.html`
3. You should see:
   - Only the green connection indicator (no header)
   - Full chat interface
   - All controls working

## 🔒 Security Considerations

For production, you might want to restrict which domains can embed the iframe:

```javascript
// Only allow specific domains
res.setHeader('Content-Security-Policy', "frame-ancestors https://apps.talenttransformation.com https://talenttransformation.com;");
```

Instead of allowing all domains with `frame-ancestors *;`

## 📝 Complete Integration Example

Here's how your `server.js` should look:

```javascript
const express = require('express');
const app = express();
const agentEricaRoutes = require('./agentEricaRoutes');

// ... your existing middleware ...

// Allow iframe embedding for AgentErica
app.use('/agentErica', (req, res, next) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors *;"); // or restrict to specific domains
    next();
});

// AgentErica API routes
app.use('/agentErica/api', agentEricaRoutes);

// AgentErica static files
app.use('/agentErica', express.static(__dirname + '/agentErica'));

// ... rest of your routes ...
```

## ✅ Verification

After setup, test with:

```html
<iframe 
    src="https://apps.talenttransformation.com/agentErica/index.html" 
    width="100%" 
    height="600px"
    allow="microphone">
</iframe>
```

If you see the app loading in the iframe, it's working! 🎉
