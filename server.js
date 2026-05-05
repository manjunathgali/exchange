const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ============================================================
// IN-MEMORY ROOMS (same logic as api/rooms.js)
// ============================================================
const rooms = new Map();
const STALE_TIMEOUT = 30000;

function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

function cleanStale(room) {
  const now = Date.now();
  for (const [id, peer] of room) {
    if (now - peer.lastSeen > STALE_TIMEOUT) {
      room.delete(id);
    }
  }
}

function getRoom(ip) {
  if (!rooms.has(ip)) rooms.set(ip, new Map());
  return rooms.get(ip);
}

function getPeerList(room, excludeId) {
  const peers = [];
  room.forEach((p, id) => {
    if (id !== excludeId) peers.push({ id, name: p.name });
  });
  return peers;
}

function handleAPI(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return respond(res, 400, { error: 'Invalid JSON' });
    }

    if (!data || !data.action) {
      return respond(res, 400, { error: 'Missing action' });
    }

    const ip = getIP(req);
    const room = getRoom(ip);
    cleanStale(room);

    const { action, peerId, peerName, to, message } = data;

    switch (action) {
      case 'join': {
        if (!peerId || !peerName) return respond(res, 400, { error: 'Missing peerId or peerName' });
        if (!room.has(peerId)) {
          room.set(peerId, { name: peerName, lastSeen: Date.now(), messages: [] });
        } else {
          const p = room.get(peerId);
          p.lastSeen = Date.now();
          p.name = peerName;
        }
        return respond(res, 200, { peers: getPeerList(room, peerId) });
      }

      case 'poll': {
        if (!peerId) return respond(res, 400, { error: 'Missing peerId' });
        const peer = room.get(peerId);
        if (!peer) return respond(res, 200, { messages: [], peers: [] });
        peer.lastSeen = Date.now();
        const messages = peer.messages.splice(0);
        return respond(res, 200, { messages, peers: getPeerList(room, peerId) });
      }

      case 'signal': {
        if (!peerId || !to || !message) return respond(res, 400, { error: 'Missing fields' });
        const target = room.get(to);
        if (target) {
          target.messages.push({ from: peerId, ...message });
        }
        return respond(res, 200, { ok: true });
      }

      case 'leave': {
        if (peerId) room.delete(peerId);
        if (room.size === 0) rooms.delete(ip);
        return respond(res, 200, { ok: true });
      }

      default:
        return respond(res, 400, { error: 'Unknown action' });
    }
  });
}

function respond(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// ============================================================
// HTTP SERVER
// ============================================================
const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // API endpoint
  if (req.url === '/api/rooms' && req.method === 'POST') {
    return handleAPI(req, res);
  }

  // Static files
  let urlPath = req.url.split('?')[0]; // strip query params
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, 'public', urlPath);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try index.html for SPA-like behavior
      if (ext === '') {
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data2);
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  📡 LocalDrop is running!');
  console.log('');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log('');
  console.log('  Open this URL on another device on the same Wi-Fi to share files.');
  console.log('');
});
