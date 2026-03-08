const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const https = require('https');
const url = require('url');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  IN-MEMORY STORE
// ─────────────────────────────────────────────
const store = {
  users: {},          // socketId -> user object
  chat: [],           // last 200 messages
  effects: [],        // active effects
  gifts: [],          // gift log
  videoState: {
    video_id: 'dQw4w9WgXcQ',
    video_type: 'youtube',   // youtube | okru | mp4 | iframe
    video_url: '',
    time: 0,
    is_playing: false,
    updated_at: Date.now(),
    title: 'Rick Astley - Never Gonna Give You Up'
  },
  roomSettings: {
    room_name: 'CEKA-MAYA Film Keyfi ♥️',
    background_color: '',
    background_image: '',
    background_gif: '',
    entrance_effect: 'royal_entrance'
  },
  entranceRateLimit: []  // timestamps
};

// ─────────────────────────────────────────────
//  YOUTUBE PROXY (Russia bypass)
// ─────────────────────────────────────────────
app.get('/ytproxy', (req, res) => {
  const videoId = req.query.v;
  if (!videoId) return res.status(400).json({ error: 'No video id' });
  // Return embed URL that works via invidious instances
  const instances = [
    `https://invidious.nerdvpn.de/embed/${videoId}?autoplay=1`,
    `https://yewtu.be/embed/${videoId}?autoplay=1`,
    `https://vid.puffyan.us/embed/${videoId}?autoplay=1`,
    `https://inv.riverside.rocks/embed/${videoId}?autoplay=1`
  ];
  res.json({ instances, primary: instances[0] });
});

// Fetch page title for URL metadata
app.get('/api/url-meta', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.json({ title: 'Video', type: 'unknown' });

  try {
    const parsed = new URL(targetUrl);
    let type = 'iframe';
    let title = 'Video';

    if (/youtube\.com|youtu\.be/.test(parsed.hostname)) {
      type = 'youtube';
      const vid = parsed.searchParams.get('v') || parsed.pathname.split('/').pop();
      return res.json({ type, video_id: vid, title: 'YouTube Video' });
    }
    if (/ok\.ru/.test(parsed.hostname)) {
      type = 'okru';
      return res.json({ type, video_url: targetUrl, title: 'OK.ru Video' });
    }
    if (/vk\.com/.test(parsed.hostname)) {
      type = 'vk';
      return res.json({ type, video_url: targetUrl, title: 'VK Video' });
    }
    if (/rutube\.ru/.test(parsed.hostname)) {
      type = 'rutube';
      const vid = parsed.pathname.split('/').filter(Boolean).pop();
      return res.json({ type, video_id: vid, title: 'Rutube Video' });
    }
    if (/\.(mp4|webm|ogg|mov|mkv)(\?|$)/i.test(targetUrl)) {
      type = 'mp4';
      return res.json({ type, video_url: targetUrl, title: 'Direct Video' });
    }
    if (/twitch\.tv/.test(parsed.hostname)) {
      type = 'twitch';
      return res.json({ type, video_url: targetUrl, title: 'Twitch Stream' });
    }

    return res.json({ type: 'iframe', video_url: targetUrl, title: 'Video' });
  } catch (e) {
    return res.json({ type: 'mp4', video_url: targetUrl, title: 'Video' });
  }
});

// ─────────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────────
function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.id !== excludeId) {
      client.send(msg);
    }
  });
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function sendTo(socketId, data) {
  wss.clients.forEach(client => {
    if (client.id === socketId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function getActiveUsers() {
  const now = Date.now();
  return Object.values(store.users).filter(u => now - u.last_active < 300000);
}

function addChatMessage(username, tur, message, type = 'text') {
  const msg = {
    id: uuidv4(),
    username,
    tur,
    message,
    message_type: type,
    created_at: new Date().toISOString()
  };
  store.chat.push(msg);
  if (store.chat.length > 200) store.chat.shift();
  return msg;
}

function triggerEntranceEffect(username, tur) {
  // Rate limit: max 5 per minute
  const now = Date.now();
  store.entranceRateLimit = store.entranceRateLimit.filter(t => now - t < 60000);
  if (store.entranceRateLimit.length >= 5) return;

  const isVip = ['maya', 'ceka'].includes(username.toLowerCase());
  const effectType = isVip
    ? store.roomSettings.entrance_effect || 'royal_entrance'
    : 'normal_entrance';

  const effect = {
    id: uuidv4(),
    effect_type: effectType,
    effect_data: JSON.stringify({
      type: effectType,
      username,
      tur,
      message: `${username} odaya giriş yaptı!`,
      isVip
    }),
    created_at: now,
    duration: isVip ? 5 : 3
  };

  store.effects.push(effect);
  if (store.effects.length > 50) store.effects.shift();
  store.entranceRateLimit.push(now);

  broadcastAll({ type: 'effect', effect });
}

wss.on('connection', (ws, req) => {
  ws.id = uuidv4();
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const { type } = data;

    // ── JOIN ──
    if (type === 'join') {
      const { username, tur = 'user' } = data;
      const existing = Object.values(store.users).find(u => u.username === username);

      store.users[ws.id] = {
        id: ws.id,
        username,
        tur,
        exp: existing?.exp || 0,
        level: existing?.level || 1,
        is_muted: existing?.is_muted || false,
        is_banned: existing?.is_banned || false,
        seat_number: existing?.seat_number || 0,
        last_active: Date.now()
      };

      if (existing?.is_banned) {
        ws.send(JSON.stringify({ type: 'banned' }));
        ws.close();
        return;
      }

      // Send initial state to joiner
      ws.send(JSON.stringify({
        type: 'init',
        videoState: store.videoState,
        chat: store.chat.slice(-50),
        users: getActiveUsers(),
        roomSettings: store.roomSettings
      }));

      // Entrance effect
      triggerEntranceEffect(username, tur);

      // System message
      const sysMsg = addChatMessage('Sistema', 'system', `🎉 ${username} odaya katıldı!`, 'system');
      broadcastAll({ type: 'chat', message: sysMsg });
      broadcastAll({ type: 'users', users: getActiveUsers() });
    }

    // ── CHAT ──
    else if (type === 'chat') {
      const user = store.users[ws.id];
      if (!user || user.is_muted || user.is_banned) return;
      if (!data.message?.trim()) return;

      // EXP gain
      user.exp = (user.exp || 0) + 1;
      user.level = Math.floor(user.exp / 20) + 1;
      user.last_active = Date.now();

      const msg = addChatMessage(user.username, user.tur, data.message.slice(0, 500), data.message_type || 'text');
      broadcastAll({ type: 'chat', message: msg });
    }

    // ── VIDEO SYNC ──
    else if (type === 'video_sync') {
      const user = store.users[ws.id];
      if (!user || user.tur !== 'admin') return;

      // Store güncel zamanı sakla
      store.videoState = {
        ...store.videoState,
        time: data.videoState.time ?? store.videoState.time,
        is_playing: data.videoState.is_playing ?? store.videoState.is_playing,
        updated_at: Date.now()
      };

      // Sadece izleyicilere gönder (admin'e gönderme)
      const msg = JSON.stringify({ type: 'video_sync', videoState: store.videoState });
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.id !== ws.id) {
          const clientUser = store.users[client.id];
          if (clientUser && clientUser.tur !== 'admin') {
            client.send(msg);
          }
        }
      });
    }

    // ── VIDEO CHANGE ──
    else if (type === 'video_change') {
      const user = store.users[ws.id];
      if (!user || user.tur !== 'admin') return;

      store.videoState = {
        video_id: data.video_id || '',
        video_type: data.video_type || 'youtube',
        video_url: data.video_url || '',
        time: 0,
        is_playing: true,
        updated_at: Date.now(),
        title: data.title || 'Video'
      };

      const sysMsg = addChatMessage('Sistema', 'system', `🎬 ${user.username} yeni video başlattı: ${data.title || 'Video'}`, 'system');
      broadcastAll({ type: 'chat', message: sysMsg });
      broadcastAll({ type: 'video_change', videoState: store.videoState });
    }

    // ── GIFT ──
    else if (type === 'gift') {
      const user = store.users[ws.id];
      if (!user) return;

      const gift = {
        id: uuidv4(),
        sender: user.username,
        receiver: data.receiver,
        gift_name: data.gift_name,
        gift_emoji: data.gift_emoji || '🎁',
        created_at: Date.now()
      };
      store.gifts.push(gift);

      const effect = {
        id: uuidv4(),
        effect_type: 'gift',
        effect_data: JSON.stringify({ ...gift, type: 'gift' }),
        created_at: Date.now(),
        duration: 4
      };
      store.effects.push(effect);

      const giftMsg = addChatMessage('Sistema', 'system',
        `${gift.gift_emoji} ${gift.sender} → ${gift.receiver}: ${gift.gift_name}!`, 'gift');
      broadcastAll({ type: 'chat', message: giftMsg });
      broadcastAll({ type: 'effect', effect });
    }

    // ── ADMIN: MUTE/BAN ──
    else if (type === 'mute_user') {
      const user = store.users[ws.id];
      if (!user || user.tur !== 'admin') return;
      const target = Object.values(store.users).find(u => u.username === data.username);
      if (target) {
        target.is_muted = !target.is_muted;
        broadcastAll({ type: 'users', users: getActiveUsers() });
        const sysMsg = addChatMessage('Sistema', 'system',
          `${target.is_muted ? '🔇' : '🔊'} ${target.username} ${target.is_muted ? 'susturuldu' : 'sesi açıldı'}`, 'system');
        broadcastAll({ type: 'chat', message: sysMsg });
      }
    }

    else if (type === 'ban_user') {
      const user = store.users[ws.id];
      if (!user || user.tur !== 'admin') return;
      const target = Object.values(store.users).find(u => u.username === data.username);
      if (target) {
        target.is_banned = true;
        sendTo(target.id, { type: 'banned' });
        const sysMsg = addChatMessage('Sistema', 'system', `🚫 ${target.username} banlandi`, 'system');
        broadcastAll({ type: 'chat', message: sysMsg });
      }
    }

    // ── ROOM SETTINGS ──
    else if (type === 'update_room_settings') {
      const user = store.users[ws.id];
      if (!user || user.tur !== 'admin') return;
      store.roomSettings = { ...store.roomSettings, ...data.settings };
      broadcastAll({ type: 'room_settings', settings: store.roomSettings });
    }

    // ── SEAT ──
    else if (type === 'take_seat') {
      const user = store.users[ws.id];
      if (!user) return;
      // Free old seat
      Object.values(store.users).forEach(u => {
        if (u.seat_number === data.seat && u.id !== ws.id) u.seat_number = 0;
      });
      user.seat_number = data.seat;
      broadcastAll({ type: 'users', users: getActiveUsers() });
    }

    // ── PING ──
    else if (type === 'ping') {
      const user = store.users[ws.id];
      if (user) user.last_active = Date.now();
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    const user = store.users[ws.id];
    if (user) {
      // Admin çıkınca videoyu mevcut zamanda "playing" bırak (izleyiciler kaldığı yerden devam eder)
      if (user.tur === 'admin') {
        store.videoState.updated_at = Date.now();
        // is_playing true kalır, izleyiciler kendi playerlarında devam eder
      }
      const sysMsg = addChatMessage('Sistema', 'system', `👋 ${user.username} odadan ayrıldı`, 'system');
      delete store.users[ws.id];
      broadcastAll({ type: 'chat', message: sysMsg });
      broadcastAll({ type: 'users', users: getActiveUsers() });
    }
  });

  ws.on('error', () => {});
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Clean old effects
setInterval(() => {
  const now = Date.now();
  store.effects = store.effects.filter(e => now - e.created_at < 30000);
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 CEKA-MAYA Cinema Room running at http://localhost:${PORT}`);
});
