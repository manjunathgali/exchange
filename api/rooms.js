// Signaling server for peer discovery and WebRTC signaling
// Uses global in-memory store (shared across warm invocations on same instance)
// For production scale, replace with Upstash Redis

const rooms = global.__localdrop_rooms || (global.__localdrop_rooms = new Map());
// Structure: Map<ip, Map<peerId, { name, lastSeen, messages: [] }>>

const STALE_TIMEOUT = 30000; // 30 seconds

function getIP(req) {
  // Vercel provides the real IP in x-forwarded-for or x-real-ip
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || '127.0.0.1';
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

module.exports = function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body - handle both application/json and text/plain (sendBeacon)
  let data = req.body;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  if (!data || !data.action) {
    return res.status(400).json({ error: 'Missing action' });
  }

  const ip = getIP(req);
  const room = getRoom(ip);
  cleanStale(room);

  const { action, peerId, peerName, to, message } = data;

  switch (action) {
    case 'join': {
      if (!peerId || !peerName) {
        return res.status(400).json({ error: 'Missing peerId or peerName' });
      }
      if (!room.has(peerId)) {
        room.set(peerId, { name: peerName, lastSeen: Date.now(), messages: [] });
      } else {
        room.get(peerId).lastSeen = Date.now();
        room.get(peerId).name = peerName;
      }
      return res.status(200).json({ peers: getPeerList(room, peerId) });
    }

    case 'poll': {
      if (!peerId) {
        return res.status(400).json({ error: 'Missing peerId' });
      }
      const peer = room.get(peerId);
      if (!peer) {
        return res.status(200).json({ messages: [], peers: [] });
      }
      peer.lastSeen = Date.now();
      const messages = peer.messages.splice(0); // drain queue
      return res.status(200).json({ messages, peers: getPeerList(room, peerId) });
    }

    case 'signal': {
      if (!peerId || !to || !message) {
        return res.status(400).json({ error: 'Missing peerId, to, or message' });
      }
      const target = room.get(to);
      if (target) {
        target.messages.push({ from: peerId, ...message });
      }
      return res.status(200).json({ ok: true });
    }

    case 'leave': {
      if (peerId) {
        room.delete(peerId);
      }
      // Clean up empty rooms
      if (room.size === 0) {
        rooms.delete(ip);
      }
      return res.status(200).json({ ok: true });
    }

    default:
      return res.status(400).json({ error: 'Unknown action' });
  }
};
