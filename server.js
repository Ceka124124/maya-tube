const express = require('express');
const http = require('http');
const WS = require('ws');
const { v4: uuid } = require('uuid');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WS.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ══ UPLOAD SETUP ══ */
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
['chat', 'room', 'user'].forEach(folder => {
  const p = path.join(UPLOAD_DIR, folder);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = req.body?.folder || 'chat';
    const allowed = ['chat', 'room', 'user'];
    const dest = path.join(UPLOAD_DIR, allowed.includes(folder) ? folder : 'chat');
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, uuid() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

/* ══ STORE ══ */
const store = { rooms: {} };

function mkRoom(name, image = '', mode = 'film') {
  const id = 'room-' + Math.floor(Math.random() * 999999 + 1);
  store.rooms[id] = {
    id, name, image,
    mode: mode || 'film',      // 'film' | 'chat'
    bg: '',                    // background image url
    created: Date.now(),
    chat: [],
    video: {
      type: 'none', vurl: '', title: 'Bekleniyor...', playing: false,
      currentTime: 0, serverAt: Date.now()
    },
    queue: [],                 // [{id, title, url, source, poster, addedBy, addedAt}]
    users: {},                 // userId → userObj
    currentFilm: null,         // {title, url, source, poster}
    createdBy: ''              // username of creator (gets admin)
  };
  return id;
}

// Default room
mkRoom('Maya Film Odası', '', 'film');

/* ══ HELPERS ══ */
function videoNow(v) {
  return v.playing ? v.currentTime + (Date.now() - v.serverAt) / 1000 : v.currentTime;
}
function videoState(v) {
  return { ...v, currentTime: videoNow(v), serverAt: Date.now() };
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

function broadcastAll(roomId, data) {
  broadcastToRoom(roomId, data, null);
}

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
  if (room) {
    room.chat.push(msg);
    if (room.chat.length > 300) room.chat.shift();
  }
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

function isFirstUserInRoom(roomId) {
  const room = store.rooms[roomId];
  return room && Object.keys(room.users).length === 0;
}

/* ══ ROUTES ══ */

// Rooms list
app.get('/api/rooms', (req, res) => {
  const out = {};
  Object.entries(store.rooms).forEach(([id, r]) => {
    out[id] = {
      id,
      name: r.name,
      image: r.image,
      mode: r.mode || 'film',
      bg: r.bg || '',
      users: Object.keys(r.users).length,
      created: r.created,
      currentFilm: r.currentFilm
    };
  });
  res.json(out);
});

// Create room
app.post('/api/rooms', (req, res) => {
  const { name, image, mode, createdBy } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = mkRoom(name, image || '', mode || 'film');
  store.rooms[id].createdBy = createdBy || '';
  res.json({ id, ...store.rooms[id] });
});

// Search proxy
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const r = await axios.get(
      `https://film.samildev.com/api/search?q=${encodeURIComponent(q)}`,
      { timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    res.json(r.data || []);
  } catch (e) {
    res.json([]);
  }
});

// Links proxy
app.get('/api/links', async (req, res) => {
  const { url, provider } = req.query;
  if (!url || !provider) return res.json([]);
  try {
    const r = await axios.get(
      `https://film.samildev.com/api/links?url=${encodeURIComponent(url)}&provider=${encodeURIComponent(provider)}`,
      { timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    res.json(r.data || []);
  } catch (e) {
    res.json([]);
  }
});

// Queue
app.get('/api/rooms/:id/queue', (req, res) => {
  const room = store.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json(room.queue);
});

// Image upload
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const folder = req.body?.folder || 'chat';
  const relPath = `/uploads/${folder}/${req.file.filename}`;
  res.json({ url: relPath, path: relPath, file_url: relPath });
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.message === 'Only images allowed') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

/* ══ PROXY ROUTE ══
   HTML uses: /proxy?url=https://...
   This forwards the request server-side to avoid CORS issues.
*/
app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'url param required' });

  try {
    const isPost = req.method === 'POST';
    const headers = { 'User-Agent': 'Mozilla/5.0' };

    // Forward Content-Type for POST requests (but not multipart — multer handles that separately)
    if (isPost && req.headers['content-type'] && !req.headers['content-type'].includes('multipart')) {
      headers['Content-Type'] = req.headers['content-type'];
    }

    const axiosConfig = {
      method: isPost ? 'post' : 'get',
      url: target,
      headers,
      timeout: 10000,
      responseType: 'arraybuffer',
      validateStatus: () => true
    };

    if (isPost) axiosConfig.data = req.body;

    const r = await axios(axiosConfig);

    // Forward status and content-type
    res.status(r.status);
    const ct = r.headers['content-type'];
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(r.data);
  } catch (e) {
    res.status(502).json({ error: 'Proxy error: ' + e.message });
  }
});

/* ══ WEBSOCKET ══ */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || Object.keys(store.rooms)[0];
  const username = (url.searchParams.get('user') || 'Misafir').slice(0, 30);
  const avatar = (url.searchParams.get('avatar') || '').slice(0, 500);
  const createdBy = (url.searchParams.get('createdBy') || '').slice(0, 30);

  const room = store.rooms[roomId];
  if (!room) { ws.close(1008, 'Room not found'); return; }

  ws.userId = uuid();
  ws.roomId = roomId;
  ws.alive = true;

  // Determine role:
  // - If username matches room.createdBy → admin
  // - If room is empty (first to join) → admin
  // - Otherwise → user
  let initialRole = 'user';
  if (room.createdBy && username === room.createdBy) {
    initialRole = 'admin';
  } else if (isFirstUserInRoom(roomId)) {
    initialRole = 'admin';
    if (!room.createdBy) room.createdBy = username;
  }

  const user = {
    id: ws.userId,
    username,
    tur: initialRole,
    avatar,
    seat: 0,
    muted: false,
    voice: false,
    speaking: false
  };

  room.users[ws.userId] = user;

  // Send init payload — includes room mode and bg
  ws.send(JSON.stringify({
    type: 'init',
    myId: ws.userId,
    users: getUsersArr(roomId),
    chat: room.chat.slice(-80),
    video: videoState(room.video),
    queue: room.queue,
    room: {
      name: room.name,
      image: room.image,
      mode: room.mode || 'film',
      bg: room.bg || '',
      id: roomId
    }
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

      /* ─── CHAT ─── */
      case 'chat': {
        if (u.muted) return;
        const text = (data.text || '').slice(0, 500).trim();
        if (!text) return;
        const msg = {
          id: uuid(),
          username: u.username,
          tur: u.tur,
          avatar: u.avatar || '',
          text,
          ts: Date.now(),
          replyTo: data.replyTo || null
        };
        room.chat.push(msg);
        if (room.chat.length > 300) room.chat.shift();
        broadcastAll(roomId, { type: 'chat', msg });
        break;
      }

      /* ─── TAKE SEAT ─── */
      case 'take_seat': {
        const seatNum = parseInt(data.seat);
        const maxSeats = room.mode === 'chat' ? 8 : 6;
        if (seatNum < 1 || seatNum > maxSeats) return;
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

      /* ─── VOICE JOIN ─── */
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

      /* ─── VOICE LEAVE ─── */
      case 'voice_leave': {
        u.voice = false;
        u.speaking = false;
        broadcastAll(roomId, { type: 'voice_peer_left', peerId: ws.userId });
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        break;
      }

      /* ─── SPEAKING ─── */
      case 'speaking': {
        u.speaking = data.active === true;
        broadcastAll(roomId, { type: 'speaking', userId: ws.userId, active: u.speaking });
        break;
      }

      /* ─── WEBRTC SIGNAL ─── */
      case 'webrtc_signal': {
        if (!data.to) return;
        sendToUser(data.to, { type: 'webrtc_signal', from: ws.userId, signal: data.signal });
        break;
      }

      /* ─── FILM REQUEST (regular users) ─── */
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
          // Auto-approve for admins/mods
          req_film.approved = true;
          room.queue.push(req_film);
          broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
          sysMsg(roomId, `📋 ${u.username} sıraya ekledi: ${req_film.title}`);
          if (!room.video.vurl && room.queue.length > 0) nextInQueue(roomId);
        } else {
          // Pending request — show to mods/admins
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

      /* ─── APPROVE REQUEST (mod/admin) ─── */
      case 'approve_request': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        const item = {
          id: data.id || uuid(),
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

      /* ─── DENY REQUEST (mod/admin) ─── */
      case 'deny_request': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        broadcastAll(roomId, {
          type: 'request_denied',
          requestId: data.requestId,
          title: data.title
        });
        sysMsg(roomId, `❌ ${u.username} reddetti: ${data.title}`);
        break;
      }

      /* ─── REMOVE FROM QUEUE (mod/admin) ─── */
      case 'remove_queue': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        room.queue = room.queue.filter(q => q.id !== data.id);
        broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
        break;
      }

      /* ─── SKIP VIDEO (mod/admin) ─── */
      case 'skip_video': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        sysMsg(roomId, `⏭️ ${u.username} geçti`);
        if (room.queue.length > 0) {
          nextInQueue(roomId);
        } else {
          room.video = {
            type: 'none', vurl: '', title: 'Bekleniyor...',
            playing: false, currentTime: 0, serverAt: Date.now()
          };
          room.currentFilm = null;
          broadcastAll(roomId, { type: 'video_change', video: room.video, film: null });
        }
        break;
      }

      /* ─── VIDEO ENDED (client reports) ─── */
      case 'video_ended': {
        // Only process from mods/admins to avoid duplicate triggers
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        if (room.queue.length > 0) {
          nextInQueue(roomId);
        } else {
          room.video = {
            type: 'none', vurl: '', title: 'Bekleniyor...',
            playing: false, currentTime: 0, serverAt: Date.now()
          };
          room.currentFilm = null;
          broadcastAll(roomId, { type: 'video_change', video: room.video, film: null });
        }
        break;
      }

      /* ─── DIRECT VIDEO (admin/mod) ─── */
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
        broadcastAll(roomId, {
          type: 'video_change',
          video: videoState(room.video),
          film: room.currentFilm
        });
        sysMsg(roomId, `▶️ ${u.username} başlattı: ${room.video.title}`);
        break;
      }

      /* ─── VIDEO SYNC (admin/mod) ─── */
      case 'video_sync': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        if (data.playing !== undefined) room.video.playing = data.playing;
        if (data.currentTime !== undefined) room.video.currentTime = data.currentTime;
        else room.video.currentTime = videoNow(room.video);
        room.video.serverAt = Date.now();
        broadcastAll(roomId, { type: 'video_sync', video: videoState(room.video) });
        break;
      }

      /* ─── ROOM UPDATE (admin/mod) ─── */
      case 'room_update': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        const d = data.data || data; // support both {type,data:{...}} and {type,...fields}
        if (d.name) room.name = d.name.slice(0, 60);
        if (d.mode && (d.mode === 'film' || d.mode === 'chat')) room.mode = d.mode;
        if (d.bg !== undefined) room.bg = d.bg;
        broadcastAll(roomId, {
          type: 'room_update',
          room: { name: room.name, mode: room.mode, bg: room.bg, id: roomId }
        });
        sysMsg(roomId, `🏠 ${u.username} otağı yenilədi`);
        break;
      }

      /* ─── KICK FROM SEAT (mod/admin) ─── */
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

      /* ─── MUTE USER (mod/admin) ─── */
      case 'mute_user': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        const target = room.users[data.userId];
        if (!target) return;
        target.muted = data.mute !== false;
        sendToUser(data.userId, { type: 'muted', muted: target.muted });
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        sysMsg(roomId, target.muted
          ? `🔇 ${target.username} susturuldu`
          : `🔊 ${target.username} sesi açıldı`
        );
        break;
      }

      /* ─── PROMOTE USER (admin only) ─── */
      case 'promote_user': {
        if (u.tur !== 'admin') return;
        const target = room.users[data.userId];
        if (!target) return;
        const newRole = data.role || 'mod';
        if (!['admin', 'mod', 'user'].includes(newRole)) return;
        target.tur = newRole;
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        sysMsg(roomId, `⭐ ${target.username} ${target.tur} oldu`);
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

/* ══ PING-PONG KEEP-ALIVE ══ */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    ws.ping();
  });
}, 30000);

/* ══ PERIODIC VIDEO SYNC ══
   Every 15s broadcast current video state to all rooms with active video
   so late joiners or reconnected clients stay in sync.
*/
setInterval(() => {
  Object.values(store.rooms).forEach(room => {
    if (!room.video.vurl) return;
    broadcastAll(room.id, { type: 'video_sync', video: videoState(room.video) });
  });
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Maya Film] Server running on port ${PORT}`);
});
