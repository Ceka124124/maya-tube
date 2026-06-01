const express = require('express');
const http = require('http');
const WS = require('ws');
const { v4: uuid } = require('uuid');
const path = require('path');
const axios = require('axios');

/* ══ EXPRESS + WS ══ */
const app = express();
const server = http.createServer(app);
const wss = new WS.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ══ STORE ══ */
const store = {
  rooms: {},  // roomId → { name, image, created, chat, video, users }
};

// Initialize with default room
const defaultRoomId = 'default-' + Date.now();
store.rooms[defaultRoomId] = {
  id: defaultRoomId,
  name: 'Maya Film',
  image: '',
  created: Date.now(),
  chat: [],
  video: { type: 'none', vurl: '', title: 'Bekleniyor...', playing: false, currentTime: 0, serverAt: Date.now() },
  users: {},  // userId → userObj
  peers: {},  // userId → { peers: [otherUserIds], voiceActive: bool }
};

/* ══ FIREBASE REST API ══ */
const FB_URL = 'https://prstars-fb9b5-default-rtdb.firebaseio.com';
async function fbSet(p, data) { try { await fetch(`${FB_URL}/${p}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); } catch(e) { } }
async function fbGet(p) { try { const r = await fetch(`${FB_URL}/${p}.json`); return await r.json(); } catch(e) { return null; } }

/* ══ HELPERS ══ */
function getRoomOrDefault() {
  const roomId = Object.keys(store.rooms)[0];
  return store.rooms[roomId];
}

function videoNow(video) {
  if (!video.playing) return video.currentTime;
  return video.currentTime + (Date.now() - video.serverAt) / 1000;
}

function videoState(video) {
  return { ...video, currentTime: videoNow(video), serverAt: Date.now() };
}

function broadcastToRoom(roomId, data, excludeId = null) {
  const room = store.rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WS.OPEN && ws.roomId === roomId && ws.userId !== excludeId) {
      ws.send(msg);
    }
  });
}

function sendToUser(userId, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WS.OPEN && ws.userId === userId) {
      ws.send(msg);
    }
  });
}

function getUsersInRoom(roomId) {
  const room = store.rooms[roomId];
  return room ? Object.values(room.users) : [];
}

/* ══ ROUTES ══ */
app.get('/api/rooms', (req, res) => {
  const rooms = {};
  Object.entries(store.rooms).forEach(([id, room]) => {
    rooms[id] = {
      name: room.name,
      image: room.image,
      users: Object.keys(room.users).length,
      created: room.created
    };
  });
  res.json(rooms);
});

app.post('/api/rooms', (req, res) => {
  const { name, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  
  const roomId = 'room-' + Math.floor(Math.random() * 999999);
  store.rooms[roomId] = {
    id: roomId,
    name,
    image: image || '',
    created: Date.now(),
    chat: [],
    video: { type: 'none', vurl: '', title: 'Bekleniyor...', playing: false, currentTime: 0, serverAt: Date.now() },
    users: {},
    peers: {}
  };
  
  res.json({ id: roomId, ...store.rooms[roomId] });
});

// Movie search API
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  try {
    // Using film.samildev.com API as provided
    const response = await axios.get(`https://film.samildev.com/api/search?q=${encodeURIComponent(q)}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    res.json(response.data || []);
  } catch(e) {
    console.error('[v0] Search error:', e.message);
    res.json([]);
  }
});

// Movie links API
app.get('/api/links', async (req, res) => {
  const { url, provider } = req.query;
  if (!url || !provider) return res.json([]);
  
  try {
    const response = await axios.get(`https://film.samildev.com/api/links?url=${encodeURIComponent(url)}&provider=${provider}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    res.json(response.data || []);
  } catch(e) {
    console.error('[v0] Links error:', e.message);
    res.json([]);
  }
});

/* ══ WEBSOCKET ══ */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || Object.keys(store.rooms)[0];
  const username = url.searchParams.get('user') || 'Anonymous';
  
  const room = store.rooms[roomId];
  if (!room) {
    ws.close(1008, 'Room not found');
    return;
  }
  
  ws.userId = uuid();
  ws.roomId = roomId;
  ws.alive = true;
  
  const user = {
    id: ws.userId,
    username,
    tur: 'user',
    avatar: '',
    seat: 0,
    muted: false,
    voice: false
  };
  
  room.users[ws.userId] = user;
  
  // Send init data
  ws.send(JSON.stringify({
    type: 'init',
    myId: ws.userId,
    users: getUsersInRoom(roomId),
    chat: room.chat.slice(-60),
    video: videoState(room.video),
    room: { name: room.name, image: room.image }
  }));
  
  // Notify others
  broadcastToRoom(roomId, {
    type: 'users',
    users: getUsersInRoom(roomId)
  }, ws.userId);
  
  broadcastToRoom(roomId, {
    type: 'chat',
    msg: {
      id: uuid(),
      username: 'sistem',
      tur: 'system',
      text: `${username} odaya katıldı`,
      ts: Date.now()
    }
  });
  
  ws.on('pong', () => {
    ws.alive = true;
  });
  
  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    
    const u = room.users[ws.userId];
    if (!u) return;
    
    switch (data.type) {
      case 'chat': {
        if (u.muted) return;
        const text = (data.text || '').slice(0, 500);
        if (!text.trim()) return;
        
        const msg = {
          id: uuid(),
          username: u.username,
          tur: u.tur,
          text,
          ts: Date.now()
        };
        
        room.chat.push(msg);
        if (room.chat.length > 250) room.chat.shift();
        
        broadcastToRoom(roomId, { type: 'chat', msg });
        break;
      }
      
      case 'take_seat': {
        const seatNum = data.seat;
        const occupied = Object.values(room.users).find(x => x.seat === seatNum && x.id !== ws.userId);
        
        if (u.seat === seatNum) {
          // Toggle off
          u.seat = 0;
          u.voice = false;
          broadcastToRoom(roomId, { type: 'voice_peer_left', peerId: ws.userId });
        } else if (!occupied) {
          // Take seat
          u.seat = seatNum;
        }
        
        broadcastToRoom(roomId, { type: 'users', users: getUsersInRoom(roomId) });
        break;
      }
      
      case 'voice_join': {
        if (u.seat === 0) return;
        u.voice = true;
        
        // Get all current voice peers
        const peers = Object.values(room.users)
          .filter(x => x.id !== ws.userId && x.voice && x.seat > 0)
          .map(x => x.id);
        
        // ✅ FIX: Send voice_peer_joined so OTHERS can connect to THIS user
        broadcastToRoom(roomId, {
          type: 'voice_peer_joined',
          peerId: ws.userId,
          username: u.username
        });
        
        // Send existing peers to NEW user (they should connect to everyone speaking)
        ws.send(JSON.stringify({
          type: 'voice_peers_existing',
          peers
        }));
        
        broadcastToRoom(roomId, { type: 'users', users: getUsersInRoom(roomId) });
        break;
      }
      
      case 'voice_leave': {
        u.voice = false;
        broadcastToRoom(roomId, { type: 'voice_peer_left', peerId: ws.userId });
        broadcastToRoom(roomId, { type: 'users', users: getUsersInRoom(roomId) });
        break;
      }
      
      case 'webrtc_signal': {
        if (!data.to) return;
        sendToUser(data.to, {
          type: 'webrtc_signal',
          from: ws.userId,
          signal: data.signal
        });
        break;
      }
      
      case 'kick_user': {
        // Only moderators can kick (for now, admins only)
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        
        const target = room.users[data.userId];
        if (!target) return;
        
        target.seat = 0;
        target.voice = false;
        
        sendToUser(data.userId, {
          type: 'kicked',
          reason: 'You were removed by ' + u.username
        });
        
        broadcastToRoom(roomId, { type: 'users', users: getUsersInRoom(roomId) });
        broadcastToRoom(roomId, {
          type: 'chat',
          msg: {
            id: uuid(),
            username: 'sistem',
            tur: 'system',
            text: `${target.username} koltuktan atıldı`,
            ts: Date.now()
          }
        });
        break;
      }
      
      case 'mute_user': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        
        const target = room.users[data.userId];
        if (!target) return;
        
        target.muted = data.mute !== false;
        broadcastToRoom(roomId, { type: 'users', users: getUsersInRoom(roomId) });
        break;
      }
      
      case 'video_change': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        
        room.video = {
          type: data.vtype || 'mp4',
          vurl: data.vurl || '',
          title: data.title || 'Video',
          playing: true,
          currentTime: 0,
          serverAt: Date.now()
        };
        
        broadcastToRoom(roomId, { type: 'video_change', video: videoState(room.video) });
        broadcastToRoom(roomId, {
          type: 'chat',
          msg: {
            id: uuid(),
            username: 'sistem',
            tur: 'system',
            text: `${u.username} yeni video: ${room.video.title}`,
            ts: Date.now()
          }
        });
        break;
      }
      
      case 'video_sync': {
        if (u.tur !== 'admin') return;
        
        room.video.playing = data.playing !== undefined ? data.playing : room.video.playing;
        room.video.currentTime = data.currentTime !== undefined ? data.currentTime : videoNow(room.video);
        room.video.serverAt = Date.now();
        
        broadcastToRoom(roomId, { type: 'video_sync', video: videoState(room.video) });
        break;
      }
    }
  });
  
  ws.on('close', () => {
    if (!room.users[ws.userId]) return;
    
    const u = room.users[ws.userId];
    u.voice = false;
    
    delete room.users[ws.userId];
    
    broadcastToRoom(roomId, {
      type: 'chat',
      msg: {
        id: uuid(),
        username: 'sistem',
        tur: 'system',
        text: `${u.username} ayrıldı`,
        ts: Date.now()
      }
    });
    
    broadcastToRoom(roomId, { type: 'users', users: getUsersInRoom(roomId) });
    broadcastToRoom(roomId, { type: 'voice_peer_left', peerId: ws.userId });
  });
});

// Ping pong for keep-alive
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) {
      ws.terminate();
      return;
    }
    ws.alive = false;
    ws.ping();
  });
}, 30000);

/* ══ START SERVER ══ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[v0] Maya Film server running on port ${PORT}`);
  console.log(`[v0] Room API endpoints:`);
  console.log(`[v0]   GET  /api/rooms - List all rooms`);
  console.log(`[v0]   POST /api/rooms - Create new room`);
  console.log(`[v0]   GET  /api/search?q=... - Search movies`);
});
