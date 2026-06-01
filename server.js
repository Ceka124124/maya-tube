const express = require('express');
const http = require('http');
const WS = require('ws');
const { v4: uuid } = require('uuid');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WS.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ══ STORE ══ */
const store = { rooms: {} };

function mkRoom(name, image = '') {
  const id = 'room-' + Math.floor(Math.random() * 999999 + 1);
  store.rooms[id] = {
    id, name, image,
    created: Date.now(),
    chat: [],
    video: { type: 'none', vurl: '', title: 'Bekleniyor...', playing: false, currentTime: 0, serverAt: Date.now() },
    queue: [],        // [{id, title, url, source, poster, addedBy, addedAt}]
    users: {},        // userId → userObj
    currentFilm: null // {title, url, source, poster}
  };
  return id;
}

// Default room
mkRoom('Maya Film Odası', '');

/* ══ HELPERS ══ */
function videoNow(v) { return v.playing ? v.currentTime + (Date.now() - v.serverAt) / 1000 : v.currentTime; }
function videoState(v) { return { ...v, currentTime: videoNow(v), serverAt: Date.now() }; }

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

function broadcastAll(roomId, data) { broadcastToRoom(roomId, data, null); }

function sendToUser(userId, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WS.OPEN && ws.userId === userId) ws.send(msg);
  });
}

function getUsersArr(roomId) {
  const room = store.rooms[roomId];
  return room ? Object.values(room.users) : [];
}

function sysMsg(roomId, text) {
  const msg = { id: uuid(), username: 'sistem', tur: 'system', text, ts: Date.now() };
  const room = store.rooms[roomId];
  if (room) { room.chat.push(msg); if (room.chat.length > 300) room.chat.shift(); }
  broadcastAll(roomId, { type: 'chat', msg });
}

function nextInQueue(roomId) {
  const room = store.rooms[roomId];
  if (!room || room.queue.length === 0) return;
  const next = room.queue.shift();
  room.currentFilm = next;
  room.video = {
    type: 'stream',
    vurl: next.proxyUrl || next.url,
    title: next.title,
    playing: true,
    currentTime: 0,
    serverAt: Date.now()
  };
  broadcastAll(roomId, { type: 'video_change', video: videoState(room.video), film: next });
  broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
  sysMsg(roomId, `▶️ Şimdi oynuyor: ${next.title}`);
}

/* ══ ROUTES ══ */
app.get('/api/rooms', (req, res) => {
  const out = {};
  Object.entries(store.rooms).forEach(([id, r]) => {
    out[id] = {
      id,
      name: r.name,
      image: r.image,
      users: Object.keys(r.users).length,
      created: r.created,
      currentFilm: r.currentFilm
    };
  });
  res.json(out);
});

app.post('/api/rooms', (req, res) => {
  const { name, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = mkRoom(name, image || '');
  res.json({ id, ...store.rooms[id] });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const r = await axios.get(`https://film.samildev.com/api/search?q=${encodeURIComponent(q)}`, {
      timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    res.json(r.data || []);
  } catch (e) { res.json([]); }
});

app.get('/api/links', async (req, res) => {
  const { url, provider } = req.query;
  if (!url || !provider) return res.json([]);
  try {
    const r = await axios.get(`https://film.samildev.com/api/links?url=${encodeURIComponent(url)}&provider=${encodeURIComponent(provider)}`, {
      timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    res.json(r.data || []);
  } catch (e) { res.json([]); }
});

// Queue endpoints
app.get('/api/rooms/:id/queue', (req, res) => {
  const room = store.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json(room.queue);
});

/* ══ WEBSOCKET ══ */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || Object.keys(store.rooms)[0];
  const username = (url.searchParams.get('user') || 'Misafir').slice(0, 30);

  const room = store.rooms[roomId];
  if (!room) { ws.close(1008, 'Room not found'); return; }

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
    voice: false,
    speaking: false
  };

  room.users[ws.userId] = user;

  ws.send(JSON.stringify({
    type: 'init',
    myId: ws.userId,
    users: getUsersArr(roomId),
    chat: room.chat.slice(-80),
    video: videoState(room.video),
    queue: room.queue,
    room: { name: room.name, image: room.image, id: roomId }
  }));

  broadcastToRoom(roomId, { type: 'users', users: getUsersArr(roomId) }, ws.userId);
  sysMsg(roomId, `👋 ${username} odaya katıldı`);

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const u = room.users[ws.userId];
    if (!u) return;

    switch (data.type) {

      case 'chat': {
        if (u.muted) return;
        const text = (data.text || '').slice(0, 500).trim();
        if (!text) return;
        const msg = { id: uuid(), username: u.username, tur: u.tur, text, ts: Date.now() };
        room.chat.push(msg);
        if (room.chat.length > 300) room.chat.shift();
        broadcastAll(roomId, { type: 'chat', msg });
        break;
      }

      case 'take_seat': {
        const seatNum = parseInt(data.seat);
        if (seatNum < 1 || seatNum > 6) return;
        const occupied = Object.values(room.users).find(x => x.seat === seatNum && x.id !== ws.userId);
        if (occupied) return;

        if (u.seat === seatNum) {
          // Leave seat
          u.seat = 0;
          u.voice = false;
          u.speaking = false;
          broadcastAll(roomId, { type: 'voice_peer_left', peerId: ws.userId });
        } else {
          u.seat = seatNum;
        }
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        break;
      }

      case 'voice_join': {
        if (u.seat === 0) return;
        u.voice = true;
        const peers = Object.values(room.users)
          .filter(x => x.id !== ws.userId && x.voice && x.seat > 0)
          .map(x => x.id);

        broadcastToRoom(roomId, { type: 'voice_peer_joined', peerId: ws.userId, username: u.username }, ws.userId);
        ws.send(JSON.stringify({ type: 'voice_peers_existing', peers }));
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        break;
      }

      case 'voice_leave': {
        u.voice = false;
        u.speaking = false;
        broadcastAll(roomId, { type: 'voice_peer_left', peerId: ws.userId });
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        break;
      }

      case 'speaking': {
        u.speaking = data.active === true;
        broadcastAll(roomId, { type: 'speaking', userId: ws.userId, active: u.speaking });
        break;
      }

      case 'webrtc_signal': {
        if (!data.to) return;
        sendToUser(data.to, { type: 'webrtc_signal', from: ws.userId, signal: data.signal });
        break;
      }

      // ─── FILM REQUEST (normal users) ───
      case 'request_film': {
        if (u.muted) return;
        const req_film = {
          id: uuid(),
          title: (data.title || '').slice(0, 100),
          url: data.url || '',
          source: data.source || '',
          poster: data.poster || '',
          proxyUrl: data.proxyUrl || '',
          quality: data.quality || '',
          addedBy: u.username,
          addedById: ws.userId,
          addedAt: Date.now(),
          approved: false
        };
        if (!req_film.title || !req_film.url) return;

        if (u.tur === 'admin' || u.tur === 'mod') {
          // Auto approve for mods/admins
          req_film.approved = true;
          room.queue.push(req_film);
          broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
          sysMsg(roomId, `📋 ${u.username} sıraya ekledi: ${req_film.title}`);
          if (!room.video.vurl && room.queue.length > 0) nextInQueue(roomId);
        } else {
          // Pending request — broadcast to mods/admins only
          const requestMsg = {
            id: uuid(),
            username: 'sistem',
            tur: 'request',
            text: `🎬 Film isteği: "${req_film.title}" — ${u.username}`,
            ts: Date.now(),
            requestData: req_film
          };
          room.chat.push(requestMsg);
          if (room.chat.length > 300) room.chat.shift();
          broadcastAll(roomId, { type: 'film_request', request: req_film });
          broadcastAll(roomId, { type: 'chat', msg: requestMsg });
        }
        break;
      }

      // ─── MOD APPROVE REQUEST ───
      case 'approve_request': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        const item = {
          id: uuid(),
          title: (data.title || '').slice(0, 100),
          url: data.url || '',
          source: data.source || '',
          poster: data.poster || '',
          proxyUrl: data.proxyUrl || '',
          quality: data.quality || '',
          addedBy: data.addedBy || u.username,
          addedById: data.addedById || ws.userId,
          addedAt: Date.now(),
          approved: true
        };
        room.queue.push(item);
        broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
        sysMsg(roomId, `✅ ${u.username} onayladı: ${item.title}`);
        if (!room.video.vurl || !room.video.playing) {
          if (room.queue.length > 0) nextInQueue(roomId);
        }
        break;
      }

      // ─── MOD DENY REQUEST ───
      case 'deny_request': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        broadcastAll(roomId, { type: 'request_denied', requestId: data.requestId, title: data.title });
        sysMsg(roomId, `❌ ${u.username} reddetti: ${data.title}`);
        break;
      }

      // ─── REMOVE FROM QUEUE ───
      case 'remove_queue': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        room.queue = room.queue.filter(q => q.id !== data.id);
        broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
        break;
      }

      // ─── SKIP VIDEO ───
      case 'skip_video': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        sysMsg(roomId, `⏭️ ${u.username} geçti`);
        if (room.queue.length > 0) {
          nextInQueue(roomId);
        } else {
          room.video = { type: 'none', vurl: '', title: 'Bekleniyor...', playing: false, currentTime: 0, serverAt: Date.now() };
          room.currentFilm = null;
          broadcastAll(roomId, { type: 'video_change', video: room.video, film: null });
        }
        break;
      }

      // ─── DIRECT VIDEO (admin/mod only) ───
      case 'video_change': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        room.video = {
          type: data.vtype || 'stream',
          vurl: data.vurl || '',
          title: data.title || 'Video',
          playing: true,
          currentTime: 0,
          serverAt: Date.now()
        };
        room.currentFilm = { title: data.title, url: data.vurl, source: '', poster: '' };
        broadcastAll(roomId, { type: 'video_change', video: videoState(room.video), film: room.currentFilm });
        sysMsg(roomId, `▶️ ${u.username} başlattı: ${room.video.title}`);
        break;
      }

      case 'video_sync': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        room.video.playing = data.playing !== undefined ? data.playing : room.video.playing;
        room.video.currentTime = data.currentTime !== undefined ? data.currentTime : videoNow(room.video);
        room.video.serverAt = Date.now();
        broadcastAll(roomId, { type: 'video_sync', video: videoState(room.video) });
        break;
      }

      // ─── KICK FROM SEAT ───
      case 'kick_seat': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        const target = room.users[data.userId];
        if (!target) return;
        target.seat = 0;
        target.voice = false;
        target.speaking = false;
        sendToUser(data.userId, { type: 'kicked_from_seat' });
        broadcastAll(roomId, { type: 'voice_peer_left', peerId: data.userId });
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        sysMsg(roomId, `🚪 ${target.username} koltuktan atıldı`);
        break;
      }

      // ─── MUTE USER ───
      case 'mute_user': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        const target = room.users[data.userId];
        if (!target) return;
        target.muted = data.mute !== false;
        sendToUser(data.userId, { type: 'muted', muted: target.muted });
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        sysMsg(roomId, target.muted ? `🔇 ${target.username} susturuldu` : `🔊 ${target.username} sesi açıldı`);
        break;
      }

      // ─── PROMOTE USER ───
      case 'promote_user': {
        if (u.tur !== 'admin') return;
        const target = room.users[data.userId];
        if (!target) return;
        target.tur = data.role || 'mod';
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        sysMsg(roomId, `⭐ ${target.username} ${target.tur} oldu`);
        break;
      }

      // ─── MAKE ADMIN ───
      case 'make_admin': {
        // First user in room gets admin — handled at join for now
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room.users[ws.userId]) return;
    const u = room.users[ws.userId];
    u.voice = false;
    delete room.users[ws.userId];
    broadcastAll(roomId, { type: 'voice_peer_left', peerId: ws.userId });
    broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
    sysMsg(roomId, `👋 ${u.username} ayrıldı`);
  });
});

// Ping-pong keep-alive
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    ws.ping();
  });
}, 30000);

// Auto-advance queue when video ends (check every 10s based on timing)
setInterval(() => {
  Object.values(store.rooms).forEach(room => {
    if (!room.video.playing || !room.video.vurl) return;
    // Let clients report video end via 'video_ended' message
  });
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Maya Film] Server running on port ${PORT}`);
});
