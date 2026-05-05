// Signaling API - supports both same-network auto-discovery and cross-network room codes
// Uses Upstash Redis for persistent state across serverless invocations

let redis = null;
let useRedis = false;

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (redisUrl && redisToken) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: redisUrl, token: redisToken });
  useRedis = true;
}

const memRooms = global.__localdrop_rooms || (global.__localdrop_rooms = new Map());
const PEER_TTL = 90; // 90 seconds

function getIP(req) {
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return '127.0.0.1';
}

// Determine the room key:
// - If client provides a roomCode, use that (cross-network)
// - Otherwise, use IP (same-network auto-discovery)
function getRoomKey(ip, roomCode) {
  if (roomCode) {
    return `room:code:${roomCode.toLowerCase().trim()}`;
  }
  return `room:ip:${ip}`;
}

// ============================================================
// REDIS IMPLEMENTATION
// ============================================================
async function redisJoin(roomKey, peerId, peerName, peerMeta) {
  const peerKey = `${roomKey}:peer:${peerId}`;
  const peerData = { id: peerId, name: peerName };
  if (peerMeta) peerData.meta = peerMeta; // { lat, lng, device }
  await redis.set(peerKey, JSON.stringify(peerData), { ex: PEER_TTL });
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
  if (!exists) {
    return { messages: [], peers: [], expired: true };
  }

  await redis.expire(peerKey, PEER_TTL);
  await redis.expire(roomKey, PEER_TTL * 2);

  const msgKey = `${roomKey}:msg:${peerId}`;
  const rawMessages = await redis.lrange(msgKey, 0, -1);
  if (rawMessages.length > 0) {
    await redis.del(msgKey);
  }
  const messages = rawMessages.map(m => typeof m === 'string' ? JSON.parse(m) : m);

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
// IN-MEMORY IMPLEMENTATION (local dev)
// ============================================================
function memCleanStale(room) {
  const now = Date.now();
  for (const [id, peer] of room) {
    if (now - peer.lastSeen > PEER_TTL * 1000) {
      room.delete(id);
    }
  }
}

function memJoin(roomKey, peerId, peerName, peerMeta) {
  if (!memRooms.has(roomKey)) memRooms.set(roomKey, new Map());
  const room = memRooms.get(roomKey);
  memCleanStale(room);

  const peerData = { name: peerName, lastSeen: Date.now(), messages: [], meta: peerMeta || null };
  if (!room.has(peerId)) {
    room.set(peerId, peerData);
  } else {
    const p = room.get(peerId);
    p.lastSeen = Date.now();
    p.name = peerName;
    if (peerMeta) p.meta = peerMeta;
  }

  const peers = [];
  room.forEach((p, id) => {
    if (id !== peerId) {
      const entry = { id, name: p.name };
      if (p.meta) entry.meta = p.meta;
      peers.push(entry);
    }
  });
  return { peers };
}

function memPoll(roomKey, peerId) {
  if (!memRooms.has(roomKey)) return { messages: [], peers: [], expired: true };
  const room = memRooms.get(roomKey);
  memCleanStale(room);

  const peer = room.get(peerId);
  if (!peer) return { messages: [], peers: [], expired: true };
  peer.lastSeen = Date.now();

  const messages = peer.messages.splice(0);
  const peers = [];
  room.forEach((p, id) => {
    if (id !== peerId) {
      const entry = { id, name: p.name };
      if (p.meta) entry.meta = p.meta;
      peers.push(entry);
    }
  });
  return { messages, peers };
}

function memSignal(roomKey, peerId, to, message) {
  if (!memRooms.has(roomKey)) return { ok: false };
  const room = memRooms.get(roomKey);
  const target = room.get(to);
  if (target) {
    target.messages.push({ from: peerId, ...message });
  }
  return { ok: true };
}

function memLeave(roomKey, peerId) {
  if (!memRooms.has(roomKey)) return { ok: true };
  const room = memRooms.get(roomKey);
  room.delete(peerId);
  if (room.size === 0) memRooms.delete(roomKey);
  return { ok: true };
}

// ============================================================
// HANDLER
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  if (!data || !data.action) return res.status(400).json({ error: 'Missing action' });

  const ip = getIP(req);
  const roomKey = getRoomKey(ip, data.roomCode);
  const { action, peerId, peerName, peerMeta, to, message } = data;

  try {
    let result;

    switch (action) {
      case 'join':
        if (!peerId || !peerName) return res.status(400).json({ error: 'Missing fields' });
        result = useRedis
          ? await redisJoin(roomKey, peerId, peerName, peerMeta)
          : memJoin(roomKey, peerId, peerName, peerMeta);
        break;

      case 'poll':
        if (!peerId) return res.status(400).json({ error: 'Missing peerId' });
        result = useRedis ? await redisPoll(roomKey, peerId) : memPoll(roomKey, peerId);
        break;

      case 'signal':
        if (!peerId || !to || !message) return res.status(400).json({ error: 'Missing fields' });
        result = useRedis ? await redisSignal(roomKey, peerId, to, message) : memSignal(roomKey, peerId, to, message);
        break;

      case 'leave':
        result = useRedis ? await redisLeave(roomKey, peerId) : memLeave(roomKey, peerId);
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
