# Wix Iframe Integration Fix

## Problem
Getting "permission denied" or "fail to connect" when embedding AgentErica in Wix iframe.

## Root Causes

1. **CORS Headers** - Server not allowing requests from Wix domain
2. **OPTIONS Preflight** - Missing handling for preflight requests
3. **Iframe Permissions** - Missing `allow` attributes for microphone
4. **Security Headers** - X-Frame-Options or CSP blocking iframe

## ✅ Solution Applied

### 1. Enhanced CORS Middleware
The `agentEricaRoutes.js` now includes comprehensive CORS support:
- Handles OPTIONS preflight requests
- Allows all origins (including Wix)
- Includes all necessary headers
- Supports credentials

### 2. Iframe Configuration
Make sure your iframe in Wix has these attributes:

```html
<iframe 
    src="https://apps.talenttransformation.com/agentErica/index.html" 
    width="100%" 
    height="100%"
    allow="microphone; autoplay; fullscreen"
    allowfullscreen
    frameborder="0">
</iframe>
```

**Important attributes:**
- `allow="microphone"` - Required for voice input
- `allow="autoplay"` - May be needed for audio playback
- `allowfullscreen` - For fullscreen mode

### 3. Server Configuration

In your main `server.js`, ensure static files also have proper headers:

```javascript
// Allow iframe embedding for AgentErica static files
app.use('/agentErica', (req, res, next) => {
    const origin = req.headers.origin;
    
    // Remove blocking headers
    res.removeHeader('X-Frame-Options');
    
    // Allow iframe embedding
    res.setHeader('Content-Security-Policy', "frame-ancestors *;");
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Handle OPTIONS
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    next();
});

// Then serve static files
app.use('/agentErica', express.static(__dirname + '/agentErica'));
```

## 🧪 Testing

### Test 1: Check CORS Headers
Open browser DevTools → Network tab → Look for API requests:
- Should see `Access-Control-Allow-Origin` header
- Should see `Access-Control-Allow-Methods` header
- OPTIONS requests should return 200

### Test 2: Check Iframe Loading
1. Open Wix editor
2. Add iframe with the code above
3. Check browser console for errors
4. Should see no CORS errors

### Test 3: Check Microphone Permission
1. Click the microphone button in the iframe
2. Browser should prompt for microphone permission
3. If no prompt, check `allow="microphone"` attribute

## 🔍 Debugging

### If still getting "permission denied":

1. **Check Browser Console:**
   ```javascript
   // Look for these errors:
   - "Failed to fetch"
   - "CORS policy"
   - "X-Frame-Options"
   - "Content-Security-Policy"
   ```

2. **Check Network Tab:**
   - Are OPTIONS requests returning 200?
   - Are API requests getting CORS headers?
   - Any 404 or 403 errors?

3. **Check Server Logs:**
   - Are requests reaching the server?
   - Any errors in server console?

4. **Test Direct Access:**
   - Try accessing `https://apps.talenttransformation.com/agentErica/index.html` directly
   - If it works directly but not in iframe, it's a header issue

### Common Issues:

#### Issue 1: "Refused to display in a frame"
**Solution:** Add to server.js:
```javascript
res.removeHeader('X-Frame-Options');
res.setHeader('Content-Security-Policy', "frame-ancestors *;");
```

#### Issue 2: "CORS policy blocked"
**Solution:** Ensure CORS middleware is before routes:
```javascript
router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    // ... other headers
    next();
});
```

#### Issue 3: "Microphone permission denied"
**Solution:** Add to iframe:
```html
allow="microphone"
```

## 📝 Wix-Specific Notes

Wix may have additional restrictions:
- Some Wix plans may block certain iframe features
- Wix may add its own CSP headers
- Wix may require HTTPS for iframes

**Workaround:** If Wix blocks the iframe, you might need to:
1. Use Wix's custom code feature
2. Contact Wix support to whitelist your domain
3. Use a different embedding method (popup, new window)

## ✅ Verification Checklist

- [ ] CORS headers present in API responses
- [ ] OPTIONS requests return 200
- [ ] Iframe has `allow="microphone"` attribute
- [ ] Server removes X-Frame-Options header
- [ ] Server sets permissive CSP
- [ ] Static files served with CORS headers
- [ ] No console errors in browser
- [ ] Microphone permission prompt appears

## 🚀 Quick Fix

If you need a quick fix, add this to your main `server.js` **before** any other routes:

```javascript
// Global CORS and iframe support
app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Iframe
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors *;");
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    next();
});
```

**Note:** This is very permissive. For production, restrict origins and CSP.
