# 📡 LND - Local Network File & Clip Dropper

> Zero-config local web utility for sharing files, text snippets, and clipboard content across devices on the same network — no cloud services, no logins required.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## ✨ Features

- **📥 Drag & Drop File Sharing** — Drop files from any device onto the web interface to share them with all connected devices
- **📋 Shared Clipboard** — Real-time synchronized clipboard buffer across all connected devices
- **✏️ Text Snippets** — Share links, code snippets, or any text instantly
- **🔍 mDNS Device Discovery** — Auto-discovers other LND instances on the local network via multicast DNS
- **⚡ WebSocket Real-Time Sync** — Instant updates across all connected browser tabs/devices
- **🌙 Dark Theme UI** — Clean, responsive interface that works on desktop and mobile
- **🔒 Local Only** — Everything stays on your local network. No external servers, no tracking

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or run in development mode (auto-reload)
npm run dev
```

The server will display access URLs for all network interfaces:

```
╔══════════════════════════════════════════════════════════╗
║         LND - Local Network File & Clip Dropper          ║
╠══════════════════════════════════════════════════════════╣
║  Device: myhost-a1b2c3d4                                ║
║  Port:   4200                                           ║
╠══════════════════════════════════════════════════════════╣
║  Access URLs:                                           ║
║  http://192.168.1.100:4200                              ║
╚══════════════════════════════════════════════════════════╝
```

Open any of these URLs on devices connected to the same network.

## 📖 Usage

### Sharing Files
1. Open LND in your browser
2. Drag & drop files onto the drop zone, or click "Browse Files"
3. All connected devices receive a notification with download link

### Shared Clipboard
1. Type or paste text in the Clipboard tab
2. Changes auto-sync to all connected devices after ~800ms of inactivity
3. Use the Copy button to copy to your device's system clipboard

### Sharing Text Snippets
1. Switch to the "Share Text" tab
2. Enter an optional title and the text content
3. Click "Share Text" (or press Ctrl+Enter)
4. All connected devices receive the snippet in their Received tab

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `LND_PORT` | `4200` | Port to listen on |

```bash
# Custom port
LND_PORT=8080 npm start
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                    LND Server                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Express  │  │ WebSocket│  │   mDNS Discovery │  │
│  │  HTTP    │  │  Real-   │  │   multicast-dns  │  │
│  │  API     │  │  time    │  │                  │  │
│  └────┬─────┘  └────┬─────┘  └──────────────────┘  │
│       │              │                               │
│  ┌────▼──────────────▼─────┐                        │
│  │    In-Memory Store      │                        │
│  │  • Clipboard Buffer     │                        │
│  │  • Items Queue          │                        │
│  │  • Connected Clients    │                        │
│  └─────────────────────────┘                        │
└─────────────────────────────────────────────────────┘
       ▲              ▲              ▲
       │              │              │
   ┌───┴───┐      ┌───┴───┐     ┌───┴───┐
   │Phone  │      │Desktop│     │ Tablet │
   │Browser│      │Browser│     │ Browser│
   └───────┘      └───────┘     └───────┘
```

### Tech Stack
- **Backend**: Node.js + Express (HTTP API) + `ws` (WebSocket server)
- **Frontend**: Vanilla JavaScript, HTML5, CSS3 (zero build step)
- **Discovery**: `multicast-dns` for mDNS/Zeroconf device discovery
- **File Uploads**: `multer` for multipart form handling

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/info` | Server info, local IPs, client count |
| `GET` | `/api/items` | List last 50 received items |
| `POST` | `/api/items/clear` | Clear all items |
| `DELETE` | `/api/items/:id` | Delete a specific item |
| `GET` | `/api/clipboard` | Get current clipboard content |
| `POST` | `/api/clipboard` | Set clipboard (`{ text: "..." }`) |
| `POST` | `/api/upload` | Upload file (multipart/form-data) |
| `POST` | `/api/text` | Share text snippet (`{ text, title }`) |
| `GET` | `/api/download/:fileName` | Download an uploaded file |
| `GET` | `/api/health` | Health check |

### WebSocket Messages

**Client → Server:**
```json
{ "type": "clipboard_update", "payload": { "text": "hello" } }
{ "type": "text_share", "payload": { "text": "...", "title": "..." } }
{ "type": "ping" }
```

**Server → Client:**
```json
{ "type": "init", "payload": { "clientId", "deviceName", "clipboard", "items", "clientCount" } }
{ "type": "clipboard_update", "payload": { "text", "timestamp" } }
{ "type": "new_item", "payload": { item } }
{ "type": "client_connected", "payload": { "clientId", "deviceName", "clientCount" } }
{ "type": "client_disconnected", "payload": { "clientId", "clientCount" } }
{ "type": "pong", "payload": { "timestamp" } }
```

## 📁 Project Structure

```
LocalNetworkDropper/
├── package.json          # Dependencies and scripts
├── server.js             # Express + WebSocket server
├── public/
│   ├── index.html        # Main UI
│   ├── styles.css        # Dark theme styling
│   └── app.js            # Frontend logic
└── uploads/              # Temporary file storage (auto-cleaned)
```

## 🔒 Security Notes

- All traffic is local-only (no external connections)
- File downloads are protected against directory traversal attacks
- Maximum file size: 100MB per file
- Uploaded files are auto-deleted after 24 hours
- For production use behind a router, consider adding authentication

## 📄 License

MIT