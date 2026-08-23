# 📡 LND - Local Network File & Clip Dropper

> Zero-config local web utility for sharing files, text snippets, and clipboard content across devices on the same network — no cloud services required. Optional authentication for exposed deployments.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## ✨ Features

- **📥 Drag & Drop File Sharing** — Drop files from any device onto the web interface to share them with all connected devices
- **📋 Shared Clipboard** — Real-time synchronized clipboard buffer across all connected devices
- **✏️ Text Snippets** — Share links, code snippets, or any text instantly
- **🔐 Optional Authentication** — Protect your instance with username/password via environment variables
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

Copy `.env.example` to `.env` and adjust settings:

```bash
cp .env.example .env
```

| Environment Variable | Default | Description |
|---|---|---|
| `LND_PORT` | `4200` | Port to listen on |
| `LND_USER` | _(empty)_ | Username for authentication (leave empty to disable) |
| `LND_PASSWORD` | _(empty)_ | Password for authentication (leave empty to disable) |
| `LND_DEBUG` | `false` | Enable verbose debug logging (`true` or `1`) |

> **Authentication is optional.** Both `LND_USER` and `LND_PASSWORD` must be set (non-empty) to enable authentication. If only one is set, auth remains disabled.

```bash
# Without authentication (default)
npm start

# With authentication
LND_USER=admin LND_PASSWORD=supersecret npm start
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

All endpoints (except auth endpoints) require authentication when `LND_USER` and `LND_PASSWORD` are set. Authentication is done via the `X-LND-Token` header (obtained from `/api/auth/login`) or HTTP Basic Auth.

| Method | Path | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/auth/status` | Check if authentication is enabled | No |
| `POST` | `/api/auth/login` | Login and receive a token (`{ user, password }`) | No |
| `POST` | `/api/auth/logout` | Invalidate the current session token | Yes |
| `GET` | `/api/info` | Server info, local IPs, client count | Yes |
| `GET` | `/api/items` | List last 50 received items | Yes |
| `POST` | `/api/items/clear` | Clear all items | Yes |
| `DELETE` | `/api/items/:id` | Delete a specific item | Yes |
| `GET` | `/api/clipboard` | Get current clipboard content | Yes |
| `POST` | `/api/clipboard` | Set clipboard (`{ text: "..." }`) | Yes |
| `POST` | `/api/upload` | Upload file (multipart/form-data) | Yes |
| `POST` | `/api/text` | Share text snippet (`{ text, title }`) | Yes |
| `GET` | `/api/download/:fileName` | Download an uploaded file | Yes |
| `GET` | `/api/health` | Health check | Yes |

### Authentication Flow

```bash
# 1. Check if auth is enabled
curl http://localhost:4200/api/auth/status
# Response: { "authRequired": true }

# 2. Login to get a token
curl -X POST http://localhost:4200/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"user":"admin","password":"supersecret"}'
# Response: { "success": true, "token": "9f2c8a..." }

# 3. Use the token in subsequent requests
curl http://localhost:4200/api/info \
  -H "X-LND-Token: 9f2c8a..."
```

> Tokens are opaque, server-side sessions valid for **24 hours**. The client stores them in `localStorage`. Tokens can be revoked early via `POST /api/auth/logout`.

### WebSocket Messages

When authentication is enabled, append the token as a query parameter: `ws://host:port?token=xxx`

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
├── .env.example          # Environment variables template
├── package.json          # Dependencies and scripts
├── server.js             # Express + WebSocket server (with auth middleware)
├── Dockerfile            # Multi-stage Docker build (builder + runtime)
├── docker-compose.yml    # Bridge network compose config (Portainer-ready)
├── docker-compose.host.yml  # Host network compose config (mDNS)
├── .dockerignore         # Files excluded from Docker context
├── public/
│   ├── index.html        # Main UI (with login overlay)
│   ├── styles.css        # Dark theme styling
│   └── app.js            # Frontend logic (with auth flow)
└── uploads/              # Temporary file storage (auto-cleaned)
```

## 🔒 Security Notes

- All traffic is local-only (no external connections)
- File downloads are protected against directory traversal attacks
- Maximum file size: 100MB per file
- Uploaded files are auto-deleted after 24 hours
- Authentication is optional but recommended when exposing the service outside your LAN
- Tokens are opaque, server-side sessions (the password is never embedded in them), expire after 24 hours, and are stored in browser `localStorage`
- The Docker container runs as a non-root user (`appuser`) for added security

## 🐳 Docker Deployment

### Dockerfile Overview

The project uses a **multi-stage Docker build** for optimized image size and security:

| Stage | Purpose |
|---|---|
| `builder` | Installs production dependencies with layer caching |
| `runtime` | Minimal runtime image running as a **non-root user** (`appuser`) |

The base image is `node:20-alpine`, supporting multi-arch builds (`amd64`, `arm64`, `armv7`).

### Quick Start

```bash
# Build and run with docker-compose (bridge network)
docker compose up -d --build

# Access at http://<your-ip>:4200
```

### Multi-Architecture Builds

Build for multiple platforms using Docker Buildx:

```bash
# Build for amd64 and arm64
docker buildx build --platform linux/amd64,linux/arm64 -t lnd-dropper:latest .

# Build, tag, and push to a registry
docker buildx build --platform linux/amd64,linux/arm64 \
  -t yourregistry/lnd-dropper:latest \
  --push .

# Build for Raspberry Pi (arm/v7)
docker buildx build --platform linux/arm/v7 \
  -t lnd-dropper:armv7 \
  --load .
```

> **Note:** `--push` requires authentication to the target registry (`docker login`). Use `--load` to load the image into local Docker instead.

### Pulling a Pre-Built Image

If a pre-built image is available in a registry:

```yaml
# In docker-compose.yml, replace build: with image:
services:
  lnd:
    image: yourregistry/lnd-dropper:latest
    # ... rest of config
```

### Host Network Mode (Recommended for mDNS)

mDNS device discovery requires multicast traffic, which may not work through bridge networking. For Hass OS or Raspberry Pi deployments, enable host network mode.

**Option 1:** Use the included `docker-compose.host.yml`:

```bash
# Build and run with host network mode
docker compose -f docker-compose.host.yml up -d --build
```

**Option 2:** Edit `docker-compose.yml` and uncomment `network_mode: host`:

```yaml
services:
  lnd:
    # ... other config ...
    network_mode: host
```

> **Note:** With `network_mode: host`, the container uses the host's network directly. The `ports` mapping is not needed since the container listens on the host port.

### Compose Files Comparison

| File | Network Mode | Use Case |
|---|---|---|
| `docker-compose.yml` | Bridge (default) | Standard deployments, port-mapped access |
| `docker-compose.host.yml` | Host | mDNS discovery, Hass OS, Raspberry Pi |

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LND_PORT` | `4200` | Port to listen on |
| `LND_USER` | _(empty)_ | Username for authentication |
| `LND_PASSWORD` | _(empty)_ | Password for authentication |
| `LND_DEBUG` | `false` | Enable verbose debug logging |

```bash
# With authentication via .env file
echo "LND_USER=admin" >> .env
echo "LND_PASSWORD=your-secure-password" >> .env
docker compose up -d

# Or inline (not recommended for passwords)
LND_USER=admin LND_PASSWORD=secret docker compose up -d
```

### Deploy via Portainer (Git Repository)

You can deploy this stack directly through **Portainer** using the Git repository:

1. Navigate to **Stacks** → **Add stack** in Portainer
2. Select **Repository** as the stack editor
3. Configure:
   - **Name**: `lnd-dropper`
   - **Repository URL**: `https://github.com/cristianbisca/LocalNetworkDropper.git`
   - **Branch**: `main`
   - **Compose file**: `docker-compose.yml`
4. Add environment variables (required for authentication):
   - Click **Add variable** and enter:
     - `LND_USER` → your desired username
     - `LND_PASSWORD` → your desired password
5. Click **Deploy the stack**

Portainer will clone the repository, build the image, and start the container with your credentials configured. The `.env.example` file is included in the repo for reference — Portainer environment variables take precedence over any `.env` file.

> **Tip:** To update to the latest version, go to the stack in Portainer and click **Pull & Restart** to fetch the latest changes from the repository.

### Volume Persistence

Uploaded files are persisted via a Docker named volume `lnd_uploads`. Files are still auto-cleaned after 24 hours by the application.

```yaml
volumes:
  - lnd_uploads:/app/uploads    # Named volume -> Container path
```

### Health Check

The container includes a built-in health check that pings `/api/health` every 30 seconds (supports authenticated mode):

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' lnd-dropper

# View health logs
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' lnd-dropper
```

### Docker Commands Reference

```bash
# Build image only
docker compose build

# Start containers in background
docker compose up -d

# Stop containers
docker compose down

# View logs
docker compose logs -f lnd

# Rebuild and restart (after code changes)
docker compose up -d --build

# Remove containers and volumes (clean slate)
docker compose down -v

# Execute command inside running container
docker exec -it lnd-dropper sh
```

## 📄 License

MIT