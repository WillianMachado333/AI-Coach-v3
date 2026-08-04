# Deployment in Subfolder Guide

## Requirements

### 1. **Node.js Installation**
**YES, you need Node.js installed on your server** because:
- The `server.js` file is a Node.js application
- All `/api/*` routes are handled by this Node.js server
- Without Node.js, the API endpoints won't work

**Installation:**
```bash
# Check if Node.js is installed
node --version

# If not installed, install Node.js (version 14+ recommended)
# On Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# On CentOS/RHEL:
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

### 2. **NPM (Node Package Manager)**
NPM comes with Node.js, but you may need to install dependencies:
```bash
cd /path/to/AgentErica
npm install
```

**Note:** Currently the project doesn't have a `package.json`, so no npm install is needed. But if you add dependencies later, you'll need npm.

## Subfolder Deployment Issues

### Problem
If your app is deployed at `https://example.com/erica/` instead of `https://example.com/`, all the API calls using absolute paths like `/api/search` will try to access `https://example.com/api/search` instead of `https://example.com/erica/api/search`.

### Current Code Issues
All API calls use absolute paths:
- `/api/openai-key`
- `/api/conversation-history-fetch`
- `/api/conversation-history-save`
- `/api/erica-preparation`
- `/api/proxy/realtime`
- `/api/search`

## Solutions

### Option 1: **Use Base Path Detection (Recommended)**
Automatically detect the base path from the current URL.

**Implementation:**
```javascript
// Add to app.js constructor
this.basePath = this.detectBasePath();

detectBasePath() {
    // Get the pathname (e.g., "/erica/" or "/")
    const pathname = window.location.pathname;
    
    // Remove filename if present (e.g., "index.html")
    const basePath = pathname.replace(/\/[^/]*$/, '');
    
    // Ensure it ends with /
    return basePath.endsWith('/') ? basePath : basePath + '/';
}

// Then use it in all fetch calls:
const response = await fetch(`${this.basePath}api/openai-key`);
```

### Option 2: **Configure Base Path via Environment Variable**
Set base path in HTML and use it in JavaScript.

**In index.html:**
```html
<script>
    window.APP_BASE_PATH = '/erica/'; // Set this to your subfolder
</script>
```

**In app.js:**
```javascript
this.basePath = window.APP_BASE_PATH || '/';
```

### Option 3: **Use Relative Paths**
Change all `/api/` to `./api/` or `api/` (relative paths).

**Pros:** Simple
**Cons:** Can break if HTML structure changes

### Option 4: **Reverse Proxy Configuration**
Configure your web server (nginx/Apache) to handle the subfolder routing.

**Nginx Example:**
```nginx
location /erica/ {
    proxy_pass http://localhost:8000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Rewrite paths
    rewrite ^/erica/(.*)$ /$1 break;
}
```

## Recommended Approach

**For subfolder deployment, I recommend:**

1. **Add base path detection** to automatically handle subfolders
2. **Use reverse proxy** (nginx) to route `/erica/api/*` to Node.js server
3. **Keep Node.js running** with PM2 or systemd

## Quick Fix Implementation

I can implement Option 1 (automatic base path detection) which will:
- Automatically detect if the app is in a subfolder
- Adjust all API paths accordingly
- Work in both root and subfolder deployments

Would you like me to implement this?
