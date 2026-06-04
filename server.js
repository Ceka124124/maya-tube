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
    else cb(new Error('Sadece resim dosyaları yüklenebilir.'));
  }
});

/* ══ KÜRESEL HAFIZA VE EKONOMİ SİSTEMİ ══ */
const store = {
  rooms: {},
  users: {} // Küresel kullanıcı veritabanı (Bağlantı kopsa bile coinler ve veriler burada saklanır)
};

// Küresel kullanıcıyı getiren veya yoksa oluşturan yardımcı fonksiyon
function getOrCreateGlobalUser(username) {
  const cleanName = (username || 'Misafir').trim().slice(0, 30);
  if (!store.users[cleanName]) {
    store.users[cleanName] = {
      username: cleanName,
      coins: 200, // Yeni gelenlere hoş geldin bakiyesi
      avatar: '',
      bio: 'Maya Film Sever!',
      vip: false,
      totalGiftsSent: 0,
      created: Date.now()
    };
  }
  return store.users[cleanName];
}

function mkRoom(name, image = '', mode = 'film') {
  const id = '' + Math.floor(Math.random() * 999999 + 1);
  store.rooms[id] = {
    id, name, image,
    mode: mode || 'film',      // 'film' | 'chat' | 'karaoke'
    bg: '',                    // Arka plan resim URL'si
    created: Date.now(),
    chat: [],
    video: {
      type: 'none', vurl: '', title: 'Bekleniyor...', playing: false,
      currentTime: 0, serverAt: Date.now()
    },
    queue: [],                 // Film kuyruğu
    karaokeQueue: [],          // Karaoke kuyruğu
    karaokeNow: null,          // Şu an çalan karaoke
    users: {},                 // Odadaki aktif kullanıcılar (userId -> userObj)
    currentFilm: null,
    createdBy: '',
    // --- ODA KİLİTLEME ---
    locked: false,
    password: '',              // 4 haneli şifre
    failedAttempts: {}         // ip -> { count, bannedUntil }
  };
  return id;
}

// Varsayılan odayı oluştur
mkRoom('Maya Film Odası', '', 'film');

/* ══ SİSTEM YARDIMCILARI (HELPERS) ══ */
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

/* ══ DİNAMİK /api/get{adı} VE /api/edit{adı} ENDPOINTLERİ ══ */

// 1. ROOM ENDPOINTLERİ
app.get('/api/getroom', (req, res) => {
  const { id } = req.query;
  if (id) {
    const room = store.rooms[id];
    if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
    return res.json(room);
  }
  res.json(store.rooms);
});

app.post('/api/editroom', (req, res) => {
  const { id, name, mode, bg, image } = req.body;
  if (!id || !store.rooms[id]) return res.status(404).json({ error: 'Oda bulunamadı veya ID eksik' });
  
  const room = store.rooms[id];
  if (name) room.name = name.slice(0, 60);
  if (mode && ['film', 'chat', 'karaoke'].includes(mode)) room.mode = mode;
  if (bg !== undefined) room.bg = bg;
  if (image !== undefined) room.image = image;

  broadcastAll(id, {
    type: 'room_update',
    room: { name: room.name, mode: room.mode, bg: room.bg, id }
  });
  sysMsg(id, `🏠 Oda ayarları API üzerinden güncellendi.`);
  res.json({ success: true, room });
});

// 2. USER ENDPOINTLERİ
app.get('/api/getuser', (req, res) => {
  const { username } = req.query;
  if (username) {
    const user = store.users[username];
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    return res.json(user);
  }
  res.json(store.users);
});

app.post('/api/edituser', (req, res) => {
  const { username, bio, avatar, vip } = req.body;
  if (!username) return res.status(400).json({ error: 'Username parametresi zorunludur' });
  
  const user = getOrCreateGlobalUser(username);
  if (bio !== undefined) user.bio = bio.slice(0, 160);
  if (avatar !== undefined) user.avatar = avatar;
  if (vip !== undefined) user.vip = !!vip;

  // Aktif odalardaki kullanıcı görünümlerini de güncelle
  Object.values(store.rooms).forEach(room => {
    Object.values(room.users).forEach(u => {
      if (u.username === username) {
        u.avatar = user.avatar;
        u.vip = user.vip;
        broadcastAll(room.id, { type: 'users', users: getUsersArr(room.id) });
      }
    });
  });

  res.json({ success: true, user });
});

// 3. COINS ENDPOINTLERİ
app.get('/api/getcoins', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username belirtilmelidir' });
  const user = store.users[username];
  res.json({ username, coins: user ? user.coins : 0 });
});

app.post('/api/editcoins', (req, res) => {
  const { username, action, amount } = req.body; // action: 'add', 'sub', 'set'
  if (!username || !action || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Eksik parametre. username, action ve amount zorunludur.' });
  }

  const user = getOrCreateGlobalUser(username);
  if (action === 'add') user.coins += amount;
  else if (action === 'sub') user.coins = Math.max(0, user.coins - amount);
  else if (action === 'set') user.coins = Math.max(0, amount);
  else return res.status(400).json({ error: 'Geçersiz işlem tipi (add/sub/set)' });

  // Odadaki canlı veriyi tetikle
  Object.values(store.rooms).forEach(room => {
    const activeUser = Object.values(room.users).find(u => u.username === username);
    if (activeUser) {
      activeUser.coins = user.coins;
      sendToUser(activeUser.id, { type: 'coins_update', coins: user.coins });
    }
  });

  res.json({ success: true, username: user.username, newBalance: user.coins });
});

// 4. QUEUE (KUYRUK) ENDPOINTLERİ
app.get('/api/getqueue', (req, res) => {
  const { roomId } = req.query;
  if (!roomId || !store.rooms[roomId]) return res.status(404).json({ error: 'Oda bulunamadı' });
  res.json(store.rooms[roomId].queue);
});

app.post('/api/editqueue', (req, res) => {
  const { roomId, action, filmId, newQueue } = req.body; // action: 'clear', 'remove', 'overwrite'
  if (!roomId || !store.rooms[roomId]) return res.status(404).json({ error: 'Oda bulunamadı' });
  
  const room = store.rooms[roomId];
  if (action === 'clear') {
    room.queue = [];
  } else if (action === 'remove' && filmId) {
    room.queue = room.queue.filter(f => f.id !== filmId);
  } else if (action === 'overwrite' && Array.isArray(newQueue)) {
    room.queue = newQueue;
  } else {
    return res.status(400).json({ error: 'Geçersiz aksiyon veya eksik veri' });
  }

  broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
  res.json({ success: true, queue: room.queue });
});

/* ══ KLASİK DİĞER ESKİ ROTARLAR VE PROXYLER ══ */
app.post('/api/rooms', (req, res) => {
  const { name, image, mode, createdBy } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = mkRoom(name, image || '', mode || 'film');
  store.rooms[id].createdBy = createdBy || '';
  res.json({ id, ...store.rooms[id] });
});

/* ── Oda Şifre Doğrulama Endpoint'i ── */
app.post('/api/room/verify', (req, res) => {
  const { roomId, password } = req.body;
  const room = store.rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  if (!room.locked) return res.json({ success: true }); // kilitli değil

  // IP al
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!room.failedAttempts) room.failedAttempts = {};
  const att = room.failedAttempts[ip] || { count: 0, bannedUntil: 0 };

  // IP ban kontrolü (1 saat)
  if (att.bannedUntil > now) {
    const minLeft = Math.ceil((att.bannedUntil - now) / 60000);
    return res.status(403).json({ error: `IP geçici olarak yasaklandı. ${minLeft} dakika sonra tekrar deneyin.`, banned: true });
  }

  if (room.password === String(password).trim()) {
    // Başarılı — sayacı sıfırla
    room.failedAttempts[ip] = { count: 0, bannedUntil: 0 };
    return res.json({ success: true });
  } else {
    att.count = (att.count || 0) + 1;
    if (att.count >= 3) {
      att.bannedUntil = now + 60 * 60 * 1000; // 1 saat ban
      att.count = 0;
    }
    room.failedAttempts[ip] = att;
    const remaining = 3 - att.count;
    return res.status(401).json({
      error: remaining > 0 ? `Yanlış şifre! ${remaining} hakkınız kaldı.` : 'IP yasaklandı — 1 saat sonra deneyin.',
      remaining,
      banned: att.bannedUntil > 0
    });
  }
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const r = await axios.get(`https://film.samildev.com/api/search?q=${encodeURIComponent(q)}`, {
      timeout: 7000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    res.json(r.data || []);
  } catch (e) { res.json([]); }
});

app.get('/api/links', async (req, res) => {
  const { url, provider } = req.query;
  if (!url || !provider) return res.json([]);
  try {
    const r = await axios.get(`https://film.samildev.com/api/links?url=${encodeURIComponent(url)}&provider=${encodeURIComponent(provider)}`, {
      timeout: 7000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    res.json(r.data || []);
  } catch (e) { res.json([]); }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi' });
  const folder = req.body?.folder || 'chat';
  const relPath = `/uploads/${folder}/${req.file.filename}`;
  res.json({ url: relPath, path: relPath, file_url: relPath });
});

app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'url param required' });
  try {
    const isPost = req.method === 'POST';
    const headers = { 'User-Agent': 'Mozilla/5.0' };
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
    res.status(r.status);
    const ct = r.headers['content-type'];
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(r.data);
  } catch (e) { res.status(502).json({ error: 'Proxy error: ' + e.message }); }
});

/* ══ WEBSOCKET VE EKONOMİ ENTEGRASYONU ══ */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || Object.keys(store.rooms)[0];
  const rawUser = url.searchParams.get('user') || 'Misafir';
  const avatar = (url.searchParams.get('avatar') || '').slice(0, 500);

  const room = store.rooms[roomId];
  if (!room) { ws.close(1008, 'Oda bulunamadı'); return; }

  // Küresel ekonomi kaydından verileri yükle/oluştur
  const globalUser = getOrCreateGlobalUser(rawUser);

  ws.userId = uuid();
  ws.roomId = roomId;
  ws.alive = true;
  ws.username = globalUser.username; // Kopma durumunda yakalamak için

  let initialRole = 'user';
  if (room.createdBy && globalUser.username === room.createdBy) {
    initialRole = 'admin';
  } else if (isFirstUserInRoom(roomId)) {
    initialRole = 'admin';
    if (!room.createdBy) room.createdBy = globalUser.username;
  }

  // Odadaki anlık nesneye küresel durumu bağla
  const user = {
    id: ws.userId,
    username: globalUser.username,
    tur: initialRole,
    avatar: avatar || globalUser.avatar,
    coins: globalUser.coins,
    vip: globalUser.vip,
    seat: 0,
    muted: false,
    voice: false,
    speaking: false
  };

  room.users[ws.userId] = user;

  // İlk bağlantı paketi (Init)
  ws.send(JSON.stringify({
    type: 'init',
    myId: ws.userId,
    users: getUsersArr(roomId),
    chat: room.chat.slice(-80),
    video: videoState(room.video),
    queue: room.queue,
    karaokeQueue: room.karaokeQueue || [],
    karaokeNow: room.karaokeNow || null,
    room: {
      name: room.name,
      image: room.image,
      mode: room.mode || 'film',
      bg: room.bg || '',
      id: roomId,
      locked: room.locked || false
    }
  }));

  broadcastToRoom(roomId, { type: 'users', users: getUsersArr(roomId) }, ws.userId);
  sysMsg(roomId, `👋 ${user.username} odaya katıldı. (Bakiye: 💰${user.coins})`);

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const u = room.users[ws.userId];
    if (!u) return;
    
    // Her işlemde küresel referansı taze tutalım
    const gUser = store.users[u.username];

    switch (data.type) {
      case 'chat': {
        if (u.muted) return;
        const text = (data.text || '').slice(0, 500).trim();
        if (!text) return;
        const msg = {
          id: uuid(),
          username: u.username,
          tur: u.tur,
          avatar: u.avatar || '',
          vip: u.vip || false,
          text,
          ts: Date.now(),
          replyTo: data.replyTo || null
        };
        room.chat.push(msg);
        if (room.chat.length > 300) room.chat.shift();
        broadcastAll(roomId, { type: 'chat', msg });
        break;
      }

      /* 💰 EKONOMİ: HEDİYE GÖNDERME SİSTEMİ 🚀 */
      case 'send_gift': {
        const { toUserId, giftType } = data; // giftType: 'popcorn' (20c), 'cola' (50c), 'diamond' (100c)
        const targetUser = room.users[toUserId];
        if (!targetUser || targetUser.id === ws.userId) return;

        const giftPrices = { popcorn: 20, cola: 50, diamond: 100 };
        const cost = giftPrices[giftType] || 20;

        if (gUser.coins < cost) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Yetersiz Coin bakiyesi!' }));
        }

        // Hesaplamalar
        gUser.coins -= cost;
        u.coins = gUser.coins;
        
        const gTarget = store.users[targetUser.username];
        gTarget.coins += cost; // Hediyeyi alan coini kapar
        targetUser.coins = gTarget.coins;

        gUser.totalGiftsSent += 1;

        // Her iki tarafa da bakiye güncellemesi yolla
        sendToUser(ws.userId, { type: 'coins_update', coins: u.coins });
        sendToUser(targetUser.id, { type: 'coins_update', coins: targetUser.coins });
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });

        sysMsg(roomId, `🎁 ${u.username}, ${targetUser.username} kullanıcısına ${giftType.toUpperCase()} gönderdi! (+💰${cost})`);
        break;
      }

      case 'take_seat': {
        const seatNum = parseInt(data.seat);
        const maxSeats = room.mode === 'chat' ? 8 : 6;
        if (seatNum < 1 || seatNum > maxSeats) return;
        const occupied = Object.values(room.users).find(x => x.seat === seatNum && x.id !== ws.userId);
        if (occupied) return;

        if (u.seat === seatNum) {
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

      /* 🎬 COIN DESTEKLİ FİLM İSTEĞİ (RÜŞVET SİSTEMİ) */
      case 'request_film': {
        if (u.muted) return;
        const useCoins = data.useCoins === true; // Eğer true ise 40 coin harcayıp onaysız direkt sıraya ekler!

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

        if (u.tur === 'admin' || u.tur === 'mod' || (useCoins && gUser.coins >= 40)) {
          if (!(u.tur === 'admin' || u.tur === 'mod') && useCoins) {
            gUser.coins -= 40;
            u.coins = gUser.coins;
            sendToUser(ws.userId, { type: 'coins_update', coins: u.coins });
            sysMsg(roomId, `🪙 ${u.username} 40 Coin ödeyerek filmi direkt sıraya soktu!`);
          }
          
          req_film.approved = true;
          room.queue.push(req_film);
          broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
          sysMsg(roomId, `📋 Sıraya eklendi: ${req_film.title}`);
          if (!room.video.vurl && room.queue.length > 0) nextInQueue(roomId);
        } else {
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

      case 'remove_queue': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        room.queue = room.queue.filter(q => q.id !== data.id);
        broadcastAll(roomId, { type: 'queue_update', queue: room.queue });
        break;
      }

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

      case 'video_ended': {
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

      case 'video_sync': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        if (data.playing !== undefined) room.video.playing = data.playing;
        if (data.currentTime !== undefined) room.video.currentTime = data.currentTime;
        else room.video.currentTime = videoNow(room.video);
        room.video.serverAt = Date.now();
        broadcastAll(roomId, { type: 'video_sync', video: videoState(room.video) });
        break;
      }

      case 'room_update': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        const d = data.data || data;
        if (d.name) room.name = d.name.slice(0, 60);
        if (d.mode && (d.mode === 'film' || d.mode === 'chat' || d.mode === 'karaoke')) room.mode = d.mode;
        if (d.bg !== undefined) room.bg = d.bg;
        broadcastAll(roomId, {
          type: 'room_update',
          room: { name: room.name, mode: room.mode, bg: room.bg, id: roomId }
        });
        sysMsg(roomId, `🏠 ${u.username} otağı yenilədi`);
        break;
      }

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

      case 'buy_vip': {
        const VIP_PRICE = 5000;
        if (gUser.coins < VIP_PRICE) {
          return ws.send(JSON.stringify({ type: 'error', message: `VIP için ${VIP_PRICE} Coin gereklidir! Şu an: ${gUser.coins} Coin` }));
        }
        if (gUser.vip) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Zaten VIP üyesiniz!' }));
        }
        gUser.coins -= VIP_PRICE;
        gUser.vip = true;
        u.coins = gUser.coins;
        u.vip = true;
        sendToUser(ws.userId, { type: 'vip_granted', coins: u.coins, vip: true });
        broadcastAll(roomId, { type: 'users', users: getUsersArr(roomId) });
        sysMsg(roomId, `👑 ${u.username} VIP oldu! Tebrikler!`);
        break;
      }
      case 'karaoke_add': {
        if (!room.karaokeQueue) room.karaokeQueue = [];
        const kItem = {
          id: uuid(),
          videoId: data.videoId || '',
          title: (data.title || '').slice(0, 100),
          addedBy: u.username,
          addedAt: Date.now()
        };
        if (!kItem.videoId) return;
        room.karaokeQueue.push(kItem);
        broadcastAll(roomId, { type: 'karaoke_queue', queue: room.karaokeQueue });
        sysMsg(roomId, `🎤 ${u.username} sıraya ekledi: ${kItem.title}`);
        if (!room.karaokeNow) {
          room.karaokeNow = room.karaokeQueue.shift();
          room.karaokeQueue = room.karaokeQueue;
          broadcastAll(roomId, { type: 'karaoke_play', item: room.karaokeNow });
          broadcastAll(roomId, { type: 'karaoke_queue', queue: room.karaokeQueue || [] });
        }
        break;
      }

      case 'karaoke_next': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        if (!room.karaokeQueue || room.karaokeQueue.length === 0) {
          room.karaokeNow = null;
          broadcastAll(roomId, { type: 'karaoke_play', item: null });
          return;
        }
        room.karaokeNow = room.karaokeQueue.shift();
        broadcastAll(roomId, { type: 'karaoke_play', item: room.karaokeNow });
        broadcastAll(roomId, { type: 'karaoke_queue', queue: room.karaokeQueue });
        sysMsg(roomId, `⏭️ Sıradaki: ${room.karaokeNow.title}`);
        break;
      }

      case 'karaoke_remove': {
        if (u.tur !== 'admin' && u.tur !== 'mod') return;
        if (!room.karaokeQueue) return;
        room.karaokeQueue = room.karaokeQueue.filter(k => k.id !== data.id);
        broadcastAll(roomId, { type: 'karaoke_queue', queue: room.karaokeQueue });
        break;
      }

      /* 🔒 ODA KİLİTLEME / AÇMA */
      case 'lock_room': {
        if (u.tur !== 'admin') return;
        const pwd = String(data.password || '').trim();
        if (pwd && pwd.length !== 4) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Şifre tam 4 haneli olmalıdır!' }));
        }
        room.locked = !!data.locked;
        room.password = room.locked ? pwd : '';
        broadcastAll(roomId, {
          type: 'room_lock_status',
          locked: room.locked
        });
        sysMsg(roomId, room.locked
          ? `🔒 ${u.username} odayı kilitledi!`
          : `🔓 ${u.username} odanın kilidini açtı!`
        );
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

/* ══ 💰 PASİF COIN KAZANMA DÖNGÜSÜ (MİS GİBİ EKONOMİ) ══ */
// Her 60 saniyede bir odada duran herkes pasif gelir kazanır. Koltukta mikrofonu açık olanlar daha çok kazanır!
setInterval(() => {
  Object.values(store.rooms).forEach(room => {
    Object.values(room.users).forEach(u => {
      const gUser = store.users[u.username];
      if (!gUser) return;

      let reward = 2; // Odada durma ödülü
      if (u.seat > 0) reward += 3; // Koltukta oturma bonusu (+3)
      if (u.voice) reward += 2;    // Mikrofon açma bonusu (+2)
      if (u.vip) reward *= 2;      // VIP Üyelere 2 katı kazanç çarpanı!

      gUser.coins += reward;
      u.coins = gUser.coins; // Senkronize et

      // Kullanıcıya kazanç bildirimini ve yeni bakiyeyi uçur
      sendToUser(u.id, { type: 'coins_passive_earned', earned: reward, coins: u.coins });
    });
  });
}, 60000);

/* ══ PERİYODİK VİDEO SENKRONİZASYONU ══ */
setInterval(() => {
  Object.values(store.rooms).forEach(room => {
    if (!room.video.vurl) return;
    broadcastAll(room.id, { type: 'video_sync', video: videoState(room.video) });
  });
}, 15000);

/* ══ HATA YAKALAYICI (BOZUK JSON GEÇİRMEZ KORUMA) ══ */
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Geçersiz JSON formatı veya boş gövde.' });
  }
  if (err instanceof multer.MulterError || err?.message === 'Sadece resim dosyaları yüklenebilir.') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Maya Film - ULTRA V2] Sunucu port ${PORT} üzerinde şahlandı!`);
});
