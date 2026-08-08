// Use stderr for ALL logging - always unbuffered in Docker (unlike stdout/console.log)
function stderrLog(msg) {
  process.stderr.write('[LND] ' + msg + '\n');
}

// VERSION MARKER - if you don't see this in docker logs, the image wasn't updated
stderrLog('=== LND-DROPPER v2026-07-29-STDERR-LOGGING STARTING ===');
stderrLog('PID: ' + process.pid + ', Platform: ' + process.platform + ', Node: ' + process.version);

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const MulticastDNS = require('multicast-dns');

// ─── Configuration ──────────────────────────────────────────────────────────
const PORT = process.env.LND_PORT || 4200;
const DEBUG = process.env.LND_DEBUG === '1' || process.env.LND_DEBUG === 'true'; // disabled by default
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// ─── Authentication Configuration ───────────────────────────────────────────
const LND_USER = process.env.LND_USER || '';
const LND_PASSWORD = process.env.LND_PASSWORD || '';
const AUTH_ENABLED = !!(LND_USER && LND_PASSWORD);

stderrLog('Auth enabled: ' + (AUTH_ENABLED ? 'YES' : 'NO') +
  ' | LND_USER set: ' + (!!LND_USER) +
  ' | LND_PASSWORD set: ' + (!!LND_PASSWORD));

if (AUTH_ENABLED) {
  stderrLog(`[AUTH] Authentication ENABLED - User: ${LND_USER}`);
} else {
  stderrLog('[AUTH] Authentication DISABLED - Set LND_USER and LND_PASSWORD to enable');
}

// ─── Authentication Middleware ──────────────────────────────────────────────
function authenticate(req, res, next) {
  if (!AUTH_ENABLED) {
    return next();
  }

  // Check for Authorization header (Basic Auth)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const [user, password] = decoded.split(':');
    
    if (user === LND_USER && password === LND_PASSWORD) {
      req.authenticated = true;
      return next();
    }
  }

  // Check for custom auth headers (for API calls from frontend)
  const authUser = req.headers['x-lnd-user'];
  const authPass = req.headers['x-lnd-password'];
  
  if (authUser === LND_USER && authPass === LND_PASSWORD) {
    req.authenticated = true;
    return next();
  }

  // Check for Bearer token (JWT-like simple token)
  const bearerToken = req.headers['x-lnd-token'];
  if (bearerToken) {
    try {
      const decoded = JSON.parse(Buffer.from(bearerToken, 'base64').toString('utf-8'));
      if (decoded.user === LND_USER && decoded.pass === LND_PASSWORD && Date.now() - decoded.ts < 86400000) {
        req.authenticated = true;
        return next();
      }
    } catch (e) {
      // Invalid token, fall through
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="LND Dropper"');
  res.status(401).json({ error: 'Authentication required' });
}

// ─── Public Middleware - expose auth status to frontend ──────────────────────
function authStatusMiddleware(req, res, next) {
  res.setHeader('X-LND-Auth-Required', AUTH_ENABLED ? 'true' : 'false');
  next();
}

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── Device Identity ────────────────────────────────────────────────────────
const deviceId = crypto.randomUUID().slice(0, 8);
const deviceName = `${os.hostname()}-${deviceId}`;

// ─── In-Memory Store ────────────────────────────────────────────────────────
// Shared clipboard buffer
let clipboardBuffer = { text: '', timestamp: 0 };

// Received items queue (text snippets and file metadata)
const itemsQueue = [];

// Connected clients tracking
const connectedClients = new Map(); // WebSocket -> clientInfo

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads - save to memory stream then disk
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${timestamp}-${name}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // Accept all file types
    cb(null, true);
  }
});

// ─── HTTP API Routes ────────────────────────────────────────────────────────

// ─── Auth Endpoints (public) ────────────────────────────────────────────────

// Check if authentication is enabled
app.get('/api/auth/status', (req, res) => {
  res.json({ authRequired: AUTH_ENABLED });
});

// Login endpoint - returns a token for session-based auth
app.post('/api/auth/login', (req, res) => {
  if (!AUTH_ENABLED) {
    return res.status(405).json({ error: 'Authentication is not enabled' });
  }

  const { user, password } = req.body;

  if (user === LND_USER && password === LND_PASSWORD) {
    // Generate a simple token (base64-encoded JSON with expiry)
    const tokenData = {
      user: LND_USER,
      pass: LND_PASSWORD,
      ts: Date.now()
    };
    const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');

    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ─── Protected API Routes ───────────────────────────────────────────────────

// Apply auth middleware to all /api routes (except auth endpoints above)
app.use('/api', authenticate);

// Get server info and local IP addresses
app.get('/api/info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const localIPs = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIPs.push({ interface: name, address: iface.address });
      }
    }
  }
  
  res.json({
    deviceId,
    deviceName,
    port: PORT,
    localIPs,
    clientCount: connectedClients.size,
    clipboard: clipboardBuffer
  });
});

// Get items queue
app.get('/api/items', (req, res) => {
  res.json(itemsQueue.slice(-50)); // Last 50 items
});

// Clear items queue
app.post('/api/items/clear', (req, res) => {
  itemsQueue.length = 0;
  res.json({ success: true });
});

// Delete a specific item
app.delete('/api/items/:id', (req, res) => {
  const index = itemsQueue.findIndex(item => item.id === req.params.id);
  if (index !== -1) {
    // Remove associated file if exists
    const item = itemsQueue[index];
    if (item.filePath && fs.existsSync(item.filePath)) {
      try { fs.unlinkSync(item.filePath); } catch (e) {}
    }
    itemsQueue.splice(index, 1);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Item not found' });
  }
});

// Set clipboard text
app.post('/api/clipboard', (req, res) => {
  const { text } = req.body;
  if (text !== undefined) {
    clipboardBuffer = { 
      text: String(text).slice(0, 10000), // Max 10K chars
      timestamp: Date.now() 
    };
    // Broadcast to all connected WebSocket clients
    broadcastToAll({
      type: 'clipboard_update',
      payload: clipboardBuffer
    });
  }
  res.json({ success: true, clipboard: clipboardBuffer });
});

// Get clipboard text
app.get('/api/clipboard', (req, res) => {
  res.json({ clipboard: clipboardBuffer });
});

// Upload file endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    type: 'file',
    name: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype,
    filePath: req.file.path,
    fileName: req.file.filename,
    sourceDevice: deviceName,
    timestamp: Date.now()
  };
  
  itemsQueue.push(item);
  
  // Broadcast to all WebSocket clients
  broadcastToAll({
    type: 'new_item',
    payload: { ...item, filePath: undefined }
  });
  
  res.json({ success: true, item });
});

// Upload text snippet
app.post('/api/text', (req, res) => {
  const { text, title } = req.body;
  
  if (!text || String(text).trim().length === 0) {
    return res.status(400).json({ error: 'No text provided' });
  }
  
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    type: 'text',
    title: title || String(text).slice(0, 50),
    content: String(text).slice(0, 50000), // Max 50K chars
    sourceDevice: deviceName,
    timestamp: Date.now()
  };
  
  itemsQueue.push(item);
  
  broadcastToAll({
    type: 'new_item',
    payload: item
  });
  
  res.json({ success: true, item });
});

// Download file endpoint
app.get('/api/download/:fileName', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.fileName);
  
  // Prevent directory traversal
  if (!filePath.startsWith(UPLOAD_DIR)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.download(filePath, (err) => {
    // Optionally clean up after download
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── HTTP Server & WebSocket ────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastToAll(message, excludeClient = null) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function broadcastWithSender(message, senderClient) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client !== senderClient && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── WebSocket Authentication Helper ────────────────────────────────────────
function authenticateWebSocket(req) {
  if (!AUTH_ENABLED) return true;

  // Check query parameter token: ws?token=xxx
  const urlParams = new URL(req.url, `http://localhost:${PORT}`);
  const token = urlParams.searchParams.get('token');
  
  if (token) {
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
      if (decoded.user === LND_USER && decoded.pass === LND_PASSWORD && Date.now() - decoded.ts < 86400000) {
        return true;
      }
    } catch (e) {
      // Invalid token
    }
  }

  return false;
}

wss.on('connection', (ws, req) => {
  // Authenticate WebSocket connection
  if (!authenticateWebSocket(req)) {
    if (AUTH_ENABLED) {
      stderrLog('[WS] Rejected unauthenticated WebSocket connection');
      ws.close(401, 'Authentication required');
    }
    return;
  }

  const clientInfo = {
    id: crypto.randomUUID().slice(0, 8),
    userAgent: req.headers['user-agent'] || 'unknown',
    connectedAt: Date.now()
  };
  
  if (DEBUG) {
    stderrLog(`[WS] Client connected: ${clientInfo.id} (total: ${connectedClients.size + 1})`);
    stderrLog(`[WS] User-Agent: ${clientInfo.userAgent}`);
  }
  
  connectedClients.set(ws, clientInfo);
  
  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    payload: {
      clientId: clientInfo.id,
      deviceName,
      debug: DEBUG,
      clipboard: clipboardBuffer,
      items: itemsQueue.slice(-50),
      clientCount: connectedClients.size
    }
  }));
  
  // Broadcast new client connected
  broadcastWithSender({
    type: 'client_connected',
    payload: {
      clientId: clientInfo.id,
      deviceName,
      clientCount: connectedClients.size
    }
  }, ws);
  
  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (e) {
      console.error('Invalid WebSocket message:', data.toString());
      return;
    }
    
    switch (message.type) {
      case 'clipboard_update': {
        const clientInfoId = connectedClients.get(ws)?.id || 'unknown';
        clipboardBuffer = {
          text: String(message.payload.text || '').slice(0, 10000),
          timestamp: Date.now()
        };
        if (DEBUG) {
          stderrLog(`[WS] clipboard_update from ${clientInfoId}: "${clipboardBuffer.text.slice(0,50)}" (len=${clipboardBuffer.text.length})`);
        }

        // Broadcast to ALL clients including sender - the client-side handles echo prevention via content-diff
        broadcastToAll({
          type: 'clipboard_update',
          payload: clipboardBuffer
        });

        if (DEBUG) {
          stderrLog(`[WS] Broadcast clipboard_update to ${wss.clients.size} total clients`);
        }
        break;
      }
      
      case 'text_share': {
        const item = {
          id: crypto.randomUUID().slice(0, 8),
          type: 'text',
          title: message.payload.title || String(message.payload.text || '').slice(0, 50),
          content: String(message.payload.text || '').slice(0, 50000),
          sourceDevice: `${deviceName}-${clientInfo.id}`,
          timestamp: Date.now()
        };
        itemsQueue.push(item);
        broadcastWithSender({
          type: 'new_item',
          payload: item
        }, ws);
        break;
      }
      
      case 'file_metadata': {
        // Client is announcing a file (for direct P2P transfer)
        broadcastWithSender({
          type: 'file_announced',
          payload: {
            ...message.payload,
            sourceClientId: clientInfo.id,
            sourceDevice: deviceName
          }
        }, ws);
        break;
      }
      
      case 'request_file': {
        // Send file transfer request to specific client
        const targetWs = findClientByWs(message.payload.clientId);
        if (targetWs) {
          targetWs.send(JSON.stringify({
            type: 'file_requested',
            payload: {
              fileName: message.payload.fileName,
              requesterClientId: clientInfo.id,
              requesterDevice: deviceName
            }
          }));
        }
        break;
      }
      
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', payload: { timestamp: Date.now() } }));
        break;
      }
    }
  });
  
  ws.on('close', () => {
    if (DEBUG) {
      stderrLog(`[WS] Client disconnected: ${clientInfo.id} (total: ${connectedClients.size - 1})`);
    }
    connectedClients.delete(ws);
    
    broadcastToAll({
      type: 'client_disconnected',
      payload: {
        clientId: clientInfo.id,
        clientCount: connectedClients.size
      }
    });
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    connectedClients.delete(ws);
  });
});

function findClientByWs(clientId) {
  for (const [clientWs, info] of connectedClients.entries()) {
    if (info.id === clientId) return clientWs;
  }
  return null;
}

// ─── mDNS / DNS-SD Service Discovery ──────────────────────────────────────
function setupMDNS() {
  const localIPs = [];
  const interfaces = os.networkInterfaces();
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIPs.push(iface.address);
      }
    }
  }
  
  const primaryIP = localIPs[0] || '127.0.0.1';
  
  try {
    const mdns = new MulticastDNS();
    
    // Track discovered devices to avoid duplicates
    const discoveredDevices = new Map(); // name -> { address, lastSeen }
    const DISCOVERY_TIMEOUT = 60000; // 60 seconds
    
    // Listen for queries/responses from other LND instances
    mdns.on('response', (packet) => {
      const now = Date.now();
      
      // Look for LND services in answers
      for (const answer of packet.answers || []) {
        if (answer.name && answer.name.endsWith('.lnd.local') && answer.type === 'A') {
          // Skip our own device
          if (answer.name.includes(deviceId)) continue;
          
          const existing = discoveredDevices.get(answer.name);
          
          if (!existing) {
            // New device discovered
            console.log(`[mDNS] Device discovered: ${answer.name} at ${answer.data}`);
            broadcastToAll({
              type: 'device_discovered',
              payload: {
                name: answer.name.replace('.lnd.local', ''),
                address: answer.data,
                port: PORT
              }
            });
            discoveredDevices.set(answer.name, { address: answer.data, lastSeen: now });
          } else {
            // Update last seen time
            existing.lastSeen = now;
          }
        }
      }
      
      // Clean up stale entries periodically
      for (const [name, info] of discoveredDevices.entries()) {
        if (now - info.lastSeen > DISCOVERY_TIMEOUT) {
          console.log(`[mDNS] Device left: ${name}`);
          broadcastToAll({
            type: 'device_left',
            payload: { name: name.replace('.lnd.local', '') }
          });
          discoveredDevices.delete(name);
        }
      }
    });
    
    // Announce this service by responding to queries from OTHER devices only
    mdns.on('query', (packet) => {
      for (const question of packet.questions || []) {
        if (question.name && question.name.endsWith('.lnd.local')) {
          mdns.respond([{
            name: `lnd-${deviceId}.lnd.local`,
            type: 'A',
            ttl: 120,
            data: primaryIP
          }]);
        }
      }
    });
    
    // Periodically announce our presence (every 30s)
    const announceInterval = setInterval(() => {
      mdns.query('lnd.lnd.local');
    }, 30000);
    
    process.on('SIGINT', () => clearInterval(announceInterval));
    
    console.log(`[mDNS] Advertising as "lnd-${deviceId}.lnd.local" on ${primaryIP}:${PORT}`);
  } catch (err) {
    console.warn('[mDNS] Failed to setup mDNS:', err.message);
    console.warn('[mDNS] Device discovery will not be available.');
  }
}

// ─── Cleanup old uploads periodically ──────────────────────────────────────
function cleanupOldUploads() {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  try {
    if (fs.existsSync(UPLOAD_DIR)) {
      const files = fs.readdirSync(UPLOAD_DIR);
      const now = Date.now();
      
      for (const file of files) {
        const filePath = path.join(UPLOAD_DIR, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          console.log(`[Cleanup] Removed old upload: ${file}`);
        }
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error cleaning uploads:', err.message);
  }
}

// Clean up every hour
setInterval(cleanupOldUploads, 60 * 60 * 1000);

// ─── Start Server ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const interfaces = os.networkInterfaces();
  const localIPs = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIPs.push(`  http://${iface.address}:${PORT}`);
      }
    }
  }
  
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         LND - Local Network File & Clip Dropper          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Device: ${deviceName.padEnd(41)}║`);
  console.log(`║  Port:   ${String(PORT).padEnd(41)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Access URLs:                                           ║');
  localIPs.forEach(ip => {
    console.log(`║${ip.padEnd(47)}║`);
  });
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Open any of these URLs on devices on the same network   ║');
  console.log('║  to share files, text, and clipboard instantly!          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Setup mDNS discovery
  setupMDNS();
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Closing server...');
  wss.clients.forEach(ws => ws.close());
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('[Shutdown] Server terminated.');
  wss.clients.forEach(ws => ws.close());
  server.close(() => process.exit(0));
});

module.exports = app;
