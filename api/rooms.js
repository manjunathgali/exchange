// Signaling API - uses Upstash Redis if available, falls back to in-memory
// For Vercel deployment, set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN

let redis = null;
let useRedis = false;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  useRedis = true;
}

// ============================================================
// IN-MEMORY FALLBACK (for local dev or when Redis not configured)
// ============================================================
const memRooms = global.__localdrop_rooms || (global.__localdrop_rooms = new Map());
const PEER_TTL = 30;

function getIP(req) {
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return '127.0.0.1';
}

// ============================================================
// REDIS IMPLEMENTATION
// ============================================================
async function redisJoin(roomKey, peerId, peerName) {
  const peerKey = `${roomKey}:peer:${peerId}`;
  await redis.set(peerKey, JSON.stringify({ id: peerId, name: peerName }), { ex: PEER_TTL });
  await redis.sadd(roomKey, peerId);
  await redis.expire(roomKey, PEER_TTL * 2);

  const peerIds = await redis.smembers(roomKey);
  const peers = [];
  for (const pid of peerIds) {
    if (pid === peerId) continue;
    const pData = await redis.get(`${roomKey}:peer:${pid}`);
    if (pData) {
      peers.push(typeof pData === 'string' ? JSON.parse(pData) : pData);
    } else {
      await redis.srem(roomKey, pid);
    }
  }
  return { peers };
}

async function redisPoll(roomKey, peerId) {
  const peerKey = `${roomKey}:peer:${peerId}`;
  const exists = await redis.exists(peerKey);
  if (!exists) return { messages: [], peers: [] };

  await redis.expire(peerKey, PEER_TTL);

  // Get and clear messages atomically
  const msgKey = `${roomKey}:msg:${peerId}`;
  const rawMessages = await redis.lrange(msgKey, 0, -1);
  if (rawMessages.length > 0) {
    await redis.del(msgKey);
  }
  const messages = rawMessages.map(m => typeof m === 'string' ? JSON.parse(m) : m);

  // Get peers
  const peerIds = await redis.smembers(roomKey);
  const peers = [];
  for (const pid of peerIds) {
    if (pid === peerId) continue;
    const pd = await redis.get(`${roomKey}:peer:${pid}`);
    if (pd) {
      peers.push(typeof pd === 'string' ? JSON.parse(pd) : pd);
    } else {
      await redis.srem(roomKey, pid);
    }
  }
  return { messages, peers };
}

async function redisSignal(roomKey, peerId, to, message) {
  const msgKey = `${roomKey}:msg:${to}`;
  await redis.rpush(msgKey, JSON.stringify({ from: peerId, ...message }));
  await redis.expire(msgKey, PEER_TTL);
  return { ok: true };
}

async function redisLeave(roomKey, peerId) {
  await redis.srem(roomKey, peerId);
  await redis.del(`${roomKey}:peer:${peerId}`);
  await redis.del(`${roomKey}:msg:${peerId}`);
  return { ok: true };
}

// ============================================================
// IN-MEMORY IMPLEMENTATION
// ============================================================
function memCleanStale(room) {
  const now = Date.now();
  for (const [id, peer] of room) {
    if (now - peer.lastSeen > PEER_TTL * 1000) {
      room.delete(id);
    }
  }
}

function memJoin(ip, peerId, peerName) {
  if (!memRooms.has(ip)) memRooms.set(ip, new Map());
  const room = memRooms.get(ip);
  memCleanStale(room);

  if (!room.has(peerId)) {
    room.set(peerId, { name: peerName, lastSeen: Date.now(), messages: [] });
  } else {
    const p = room.get(peerId);
    p.lastSeen = Date.now();
    p.name = peerName;
  }

  const peers = [];
  room.forEach((p, id) => {
    if (id !== peerId) peers.push({ id, name: p.name });
  });
  return { peers };
}

function memPoll(ip, peerId) {
  if (!memRooms.has(ip)) return { messages: [], peers: [] };
  const room = memRooms.get(ip);
  memCleanStale(room);

  const peer = room.get(peerId);
  if (!peer) return { messages: [], peers: [] };
  peer.lastSeen = Date.now();

  const messages = peer.messages.splice(0);
  const peers = [];
  room.forEach((p, id) => {
    if (id !== peerId) peers.push({ id, name: p.name });
  });
  return { messages, peers };
}

function memSignal(ip, peerId, to, message) {
  if (!memRooms.has(ip)) return { ok: true };
  const room = memRooms.get(ip);
  const target = room.get(to);
  if (target) {
    target.messages.push({ from: peerId, ...message });
  }
  return { ok: true };
}

function memLeave(ip, peerId) {
  if (!memRooms.has(ip)) return { ok: true };
  const room = memRooms.get(ip);
  room.delete(peerId);
  if (room.size === 0) memRooms.delete(ip);
  return { ok: true };
}

// ============================================================
// HANDLER
// ============================================================
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  if (!data || !data.action) {
    return res.status(400).json({ error: 'Missing action' });
  }

  const ip = getIP(req);
  const roomKey = `room:${ip}`;
  const { action, peerId, peerName, to, message } = data;

  try {
    let result;

    switch (action) {
      case 'join':
        if (!peerId || !peerName) return res.status(400).json({ error: 'Missing fields' });
        result = useRedis ? await redisJoin(roomKey, peerId, peerName) : memJoin(ip, peerId, peerName);
        break;

      case 'poll':
        if (!peerId) return res.status(400).json({ error: 'Missing peerId' });
        result = useRedis ? await redisPoll(roomKey, peerId) : memPoll(ip, peerId);
        break;

      case 'signal':
        if (!peerId || !to || !message) return res.status(400).json({ error: 'Missing fields' });
        result = useRedis ? await redisSignal(roomKey, peerId, to, message) : memSignal(ip, peerId, to, message);
        break;

      case 'leave':
        result = useRedis ? await redisLeave(roomKey, peerId) : memLeave(ip, peerId);
        break;

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('API error:', err.message || err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
