# Production Deployment Issues & Solutions

## Critical Issues

### 1. **HTTPS/WSS Required for WebRTC**
**Problem:** WebRTC requires HTTPS in production (except localhost). The current code uses HTTP.

**Solution:**
- Use a reverse proxy (nginx, Apache) with SSL certificates
- Or use Node.js with HTTPS directly
- Update WebRTC connection to use secure context

**Code Changes Needed:**
```javascript
// server.js - Add HTTPS support
const https = require('https');
const fs = require('fs');

const options = {
  key: fs.readFileSync('/path/to/private-key.pem'),
  cert: fs.readFileSync('/path/to/certificate.pem')
};

const server = https.createServer(options, (req, res) => {
  // ... existing code
});
```

### 2. **CORS Configuration**
**Problem:** Current CORS headers use `'*'` which may not be sufficient for production.

**Solution:**
- Configure specific allowed origins
- Add proper CORS headers for all endpoints
- Handle preflight OPTIONS requests

**Code Changes Needed:**
```javascript
// Add CORS middleware function
function setCORSHeaders(res, origin) {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
  const originToUse = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  
  res.setHeader('Access-Control-Allow-Origin', originToUse);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Handle OPTIONS requests
if (req.method === 'OPTIONS') {
  setCORSHeaders(res, req.headers.origin);
  res.writeHead(200);
  res.end();
  return;
}
```

### 3. **Environment Variables**
**Problem:** Hardcoded values (port, passwords, API endpoints) should be in environment variables.

**Solution:**
- Use `.env` file with `dotenv` package
- Store sensitive data in environment variables
- Never commit `.env` to git

**Code Changes Needed:**
```javascript
// Install: npm install dotenv
require('dotenv').config();

const PORT = process.env.PORT || 8000;
const ERICA_KEY_PASSWORD = process.env.ERICA_KEY_PASSWORD || 'ericaKeyPassword';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
```

### 4. **WebRTC STUN/TURN Servers**
**Problem:** Current code only uses Google's public STUN server. May need TURN servers for production (NAT traversal).

**Solution:**
- Add TURN server configuration
- Use services like Twilio, Xirsys, or self-hosted coturn

**Code Changes Needed:**
```javascript
// app.js - establishConnection()
this.pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: process.env.TURN_SERVER_URL || 'turn:your-turn-server.com:3478',
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD
    }
  ]
});
```

### 5. **Static File Serving**
**Problem:** Current simple file server may not be efficient for production.

**Solution:**
- Use nginx/Apache for static files
- Or use Express.js with proper static middleware
- Add caching headers

**Alternative:**
- Deploy static files to CDN (Cloudflare, AWS CloudFront)
- Serve only API endpoints from Node.js server

### 6. **Error Handling & Logging**
**Problem:** Basic error handling may not be sufficient for production.

**Solution:**
- Add proper error logging (Winston, Pino)
- Implement error monitoring (Sentry, Rollbar)
- Add request/response logging
- Handle uncaught exceptions

**Code Changes Needed:**
```javascript
// Add error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Log to monitoring service
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  // Log to monitoring service
});
```

### 7. **Security Headers**
**Problem:** Missing security headers can expose the application to attacks.

**Solution:**
- Add security headers (CSP, X-Frame-Options, etc.)
- Implement rate limiting
- Validate and sanitize inputs

**Code Changes Needed:**
```javascript
// Add security headers middleware
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
}
```

### 8. **Rate Limiting**
**Problem:** No rate limiting - vulnerable to abuse.

**Solution:**
- Implement rate limiting per IP/user
- Use libraries like `express-rate-limit` or `rate-limiter-flexible`

**Code Changes Needed:**
```javascript
// Install: npm install express-rate-limit
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
```

### 9. **Process Management**
**Problem:** Node.js process will crash if uncaught error occurs.

**Solution:**
- Use PM2, Forever, or systemd for process management
- Enable auto-restart on crashes
- Monitor process health

**PM2 Configuration:**
```json
// ecosystem.config.js
{
  "name": "erica-server",
  "script": "server.js",
  "instances": 2,
  "exec_mode": "cluster",
  "env": {
    "NODE_ENV": "production",
    "PORT": 8000
  }
}
```

### 10. **Port Configuration**
**Problem:** Hardcoded port 8000 may conflict or not be accessible.

**Solution:**
- Use environment variable for port
- Configure firewall rules
- Use reverse proxy (nginx) on port 80/443

### 11. **API Key Security**
**Problem:** API keys are passed through headers/URLs - need better security.

**Solution:**
- Use JWT tokens for authentication
- Implement session management
- Store API keys securely (never in client-side code)

### 12. **File Path Issues**
**Problem:** File paths may not work correctly on different OS or deployment environments.

**Solution:**
- Use `path.join()` for all file paths
- Use `__dirname` or `process.cwd()` correctly
- Test on target OS before deployment

### 13. **Memory Leaks**
**Problem:** WebRTC connections and event listeners may cause memory leaks.

**Solution:**
- Properly cleanup connections on disconnect
- Remove event listeners
- Monitor memory usage
- Implement connection timeouts

### 14. **Database/State Management**
**Problem:** In-memory state (openAIKey) will be lost on restart.

**Solution:**
- Use Redis or database for state management
- Implement proper session storage
- Add connection pooling if using database

### 15. **Load Balancing**
**Problem:** Single server instance may not handle high load.

**Solution:**
- Use load balancer (nginx, AWS ALB)
- Implement sticky sessions for WebRTC
- Use Redis for shared state

## Recommended Production Setup

### Architecture:
```
[Client] 
  ↓ HTTPS
[Nginx Reverse Proxy] (SSL termination, static files)
  ↓ HTTP
[Node.js App] (PM2 cluster mode)
  ↓
[Redis] (session/state)
  ↓
[External APIs] (OpenAI, awav.com, etc.)
```

### Checklist:
- [ ] SSL certificate installed (Let's Encrypt, etc.)
- [ ] HTTPS enabled
- [ ] Environment variables configured
- [ ] CORS properly configured
- [ ] Security headers added
- [ ] Rate limiting implemented
- [ ] Error logging/monitoring setup
- [ ] Process manager (PM2) configured
- [ ] Reverse proxy (nginx) configured
- [ ] Firewall rules configured
- [ ] TURN servers configured (if needed)
- [ ] Database/Redis for state (if needed)
- [ ] Backup strategy
- [ ] Health check endpoint
- [ ] Graceful shutdown handling

## Quick Start Production Setup

1. **Install dependencies:**
```bash
npm install dotenv express-rate-limit
```

2. **Create `.env` file:**
```
PORT=8000
NODE_ENV=production
ERICA_KEY_PASSWORD=your_secure_password
ALLOWED_ORIGINS=https://yourdomain.com
TURN_SERVER_URL=turn:your-turn-server.com:3478
TURN_USERNAME=your_username
TURN_PASSWORD=your_password
```

3. **Install PM2:**
```bash
npm install -g pm2
pm2 start server.js --name erica-server
pm2 save
pm2 startup
```

4. **Configure nginx:**
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
