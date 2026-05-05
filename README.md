# 📡 LocalDrop

Instant peer-to-peer file sharing — like Pairdrop/Snapdrop. No accounts, no uploads, no installs.

Files transfer directly between devices via **WebRTC**. The server only handles discovery (finding peers on the same network). Nothing is stored.

## How it works

1. Open the app on two devices connected to the same network
2. Devices discover each other automatically (matched by public IP)
3. Tap a device → pick a file → the other device accepts → transfer starts
4. Files go directly between browsers via WebRTC (peer-to-peer)

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000` on multiple devices/tabs.

## Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

The app uses HTTP polling for signaling (Vercel-compatible) and WebRTC for actual file transfer.

## Architecture

- **`/public`** — Static frontend (HTML, CSS, JS)
- **`/api/rooms.js`** — Vercel serverless function for peer discovery & signaling
- **`/server.js`** — Local dev server (serves static files + API)

## Tech Stack

- Vanilla JS (no frameworks, no build step)
- WebRTC DataChannel for file transfer
- HTTP polling for signaling (Vercel-compatible)
- STUN servers for NAT traversal

## Limitations

- Vercel serverless functions are stateless — peer discovery relies on in-memory state within a single instance. For production with many users, add **Upstash Redis** or similar for shared state.
- Both devices must be on the same public IP (same Wi-Fi/network) for auto-discovery.
- Very large files (>1GB) may be slow depending on WebRTC connection quality.
