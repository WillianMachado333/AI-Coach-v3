# Quick Integration Checklist

## ✅ Step 1: Verify Files Are in Place

Make sure you have:
- `agentEricaRoutes.js` in the server root (same folder as your `server.js`)
- `agentErica/` folder with:
  - `index.html`
  - `app.js` (updated with the fix)
  - `styles.css`

## ✅ Step 2: Add Routes to Your server.js

Add these 3 lines to your existing `server.js`:

```javascript
// At the top with other requires:
const agentEricaRoutes = require('./agentEricaRoutes');

// After your existing routes (but before app.listen):
app.use('/agentErica/api', agentEricaRoutes);
app.use('/agentErica', express.static(__dirname + '/agentErica'));
```

**Important:** Make sure these lines are added BEFORE `app.listen()` or `server.listen()`.

## ✅ Step 3: Restart Your Server

After adding the routes, you MUST restart your Node.js server for the changes to take effect.

## ✅ Step 4: Test the Routes

After restarting, test these URLs:

1. **Static file:** `https://apps.talenttransformation.com/agentErica/index.html`
   - Should load the HTML page

2. **API route:** `https://apps.talenttransformation.com/agentErica/api/openai-key`
   - Should return JSON with `{openAIkey: "sk-proj-..."}`

3. **Main app:** `https://apps.talenttransformation.com/agentErica/index.html?email=test@example.com`
   - Should auto-connect and work

## 🔍 Troubleshooting

### If you get 404 errors:

1. **Check server logs** - Look for `[AgentErica]` messages when you access the routes
2. **Verify route order** - Make sure `/agentErica/api` routes are added BEFORE any catch-all routes
3. **Check folder structure** - Ensure `agentErica/` folder exists and has the files
4. **Verify Express static** - The static middleware should serve files from `__dirname + '/agentErica'`

### If routes work but app doesn't:

1. **Check browser console** - Look for errors about base path detection
2. **Verify basePath** - The app should detect `/agentErica/` automatically
3. **Check API calls** - All should go to `/agentErica/api/*`

## 📝 Example server.js Integration

Here's where to add the lines in your existing server.js:

```javascript
// ... your existing code ...

// Serve static files from the client directory
app.use(express.static(__dirname + '/client'));

// ===== ADD THESE 3 LINES HERE =====
const agentEricaRoutes = require('./agentEricaRoutes');
app.use('/agentErica/api', agentEricaRoutes);
app.use('/agentErica', express.static(__dirname + '/agentErica'));
// ===================================

// ... rest of your routes ...

app.listen(process.env.PORT || 3000, () => {
    console.log("Server listening on port", process.env.PORT || 3000);
});
```
