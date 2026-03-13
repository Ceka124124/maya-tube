const express  = require('express');
const http      = require('http');
const WS        = require('ws');
const { v4: uuid } = require('uuid');
const path      = require('path');

/* ══ FIREBASE INIT ══ */
const firebaseConfig = {
  apiKey: "AIzaSyAVvwaeYwhyZMpCktVX08NSl-JGfgHOxfs",
  authDomain: "prstars-fb9b5.firebaseapp.com",
  databaseURL: "https://prstars-fb9b5-default-rtdb.firebaseio.com",
  projectId: "prstars-fb9b5",
  storageBucket: "prstars-fb9b5.firebasestorage.app",
  messagingSenderId: "847928058208",
  appId: "1:847928058208:web:0112d515c4139622d43e05"
};

// Firebase Admin SDK – servis hesabı yoksa REST API ile çalış
let db = null;
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: firebaseConfig.databaseURL
    });
  }
  db = admin.database();
  console.log('[Firebase] Admin SDK baglandi');
} catch(e) {
  console.log('[Firebase] Admin SDK yok, REST API kullaniliyor');
}

/* Firebase REST yazma yardimcisi */
async function fbSet(path2, data) {
  try {
    if (db) {
      await db.ref(path2).set(data);
    } else {
      const url = `${firebaseConfig.databaseURL}/${path2}.json`;
      await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
    }
  } catch(e) { console.error('[Firebase] yazma hatasi:', e.message); }
}

async function fbPush(path2, data) {
  try {
    if (db) {
      await db.ref(path2).push(data);
    } else {
      const url = `${firebaseConfig.databaseURL}/${path2}.json`;
      await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
    }
  } catch(e) { console.error('[Firebase] push hatasi:', e.message); }
}

async function fbGet(path2) {
  try {
    if (db) {
      const snap = await db.ref(path2).get();
      return snap.exists() ? snap.val() : null;
    } else {
      const url = `${firebaseConfig.databaseURL}/${path2}.json`;
      const r = await fetch(url);
      return await r.json();
    }
  } catch(e) { return null; }
}

async function fbDelete(path2) {
  try {
    if (db) {
      await db.ref(path2).remove();
    } else {
      const url = `${firebaseConfig.databaseURL}/${path2}.json`;
      await fetch(url, { method:'DELETE' });
    }
  } catch(e) {}
}

/* ══ EXPRESS + WS ══ */
const app    = express();
const server = http.createServer(app);
const wss    = new WS.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ══ IN-MEMORY STORE ══ */
const store = {
  users:  {},
  chat:   [],
  video:  { type:'none', vid:'', vurl:'', title:'Yayin bekleniyor...', playing:false, at:Date.now() },
  room:   { name:'Maya Film', bg_url:'', entrance_effect:'royal', entrance_video:'' },
  items:  []   // çerçeveler + giriş efektleri + hediyeler (Firebase'den yüklenir)
};

/* ══ FIREBASE'DEN VERİLERİ YÜKLE ══ */
async function loadFromFirebase() {
  const room  = await fbGet('room');
  const chat  = await fbGet('chat');
  const items = await fbGet('items');

  if (room)  Object.assign(store.room, room);
  if (chat)  { store.chat = Object.values(chat).sort((a,b)=>a.ts-b.ts).slice(-200); }
  if (items) { store.items = Object.entries(items).map(([k,v])=>({...v, fbKey:k})); }

  console.log(`[Firebase] Yuklendi — oda:"${store.room.name}" items:${store.items.length}`);
}

/* ══ HELPERS ══ */
function bcast(data, skip=null) {
  const s = JSON.stringify(data);
  wss.clients.forEach(c => { if(c.readyState===WS.OPEN && c.wsId!==skip) c.send(s); });
}
function sendTo(id, data) {
  wss.clients.forEach(c => { if(c.wsId===id && c.readyState===WS.OPEN) c.send(JSON.stringify(data)); });
}
function allUsers() { return Object.values(store.users); }

function sysMsg(text, msgType='system') {
  const m = { id:uuid(), username:'sistem', tur:'system', text, msgType, ts:Date.now(), avatar:'' };
  store.chat.push(m);
  if (store.chat.length > 200) store.chat.shift();
  fbPush('chat', m);
  return m;
}
function chatMsg(u, text) {
  const m = { id:uuid(), username:u.username, tur:u.tur, text:text.slice(0,500), msgType:'text', ts:Date.now(), avatar:u.avatar||'', frame:u.frame||'' };
  store.chat.push(m);
  if (store.chat.length > 200) store.chat.shift();
  fbPush('chat', m);
  return m;
}

/* ══ WEBSOCKET ══ */
wss.on('connection', ws => {
  ws.wsId = uuid();
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }

    switch(d.type) {

      /* ── JOIN ── */
      case 'join': {
        const { username, tur, avatar='' } = d;
        if (!username) return;
        const prev = allUsers().find(u => u.username===username);
        if (prev?.banned) { ws.send(JSON.stringify({type:'banned'})); ws.close(); return; }

        // Kullanıcının kayıtlı çerçeve ve efektlerini getir
        fbGet(`userItems/${username}`).then(userItems => {
          store.users[ws.wsId] = {
            id: ws.wsId, username, tur: tur||'user', avatar,
            seat: 0, muted: false, banned: false, voice: false,
            exp: prev?.exp||0, lvl: prev ? Math.floor((prev.exp||0)/20)+1 : 1,
            frame: d.frame || '',
            ownedItems: userItems ? Object.values(userItems) : []
          };
          ws.send(JSON.stringify({
            type:'init', myId:ws.wsId,
            video: store.video,
            chat:  store.chat.slice(-60),
            users: allUsers(),
            room:  store.room,
            items: store.items,
            ownedItems: store.users[ws.wsId].ownedItems
          }));

          const u = store.users[ws.wsId];
          // Giriş efekti: kişiye özel mi var?
          const personalEff = store.items.find(it => it.type==='entrance' && u.ownedItems.includes(it.id));
          bcast({
            type: 'entrance',
            username, tur: tur||'user',
            effect: tur==='admin' ? store.room.entrance_effect : 'normal',
            entrance_video: tur==='admin' ? store.room.entrance_video : '',
            personal_entrance: personalEff || null,
            avatar
          }, ws.wsId);

          const m = sysMsg(`${username} odaya katildi`);
          bcast({ type:'chat', msg:m });
          bcast({ type:'users', users:allUsers() });
        });
        break;
      }

      /* ── CHAT ── */
      case 'chat': {
        const u = store.users[ws.wsId];
        if (!u || u.muted || u.banned || !d.text?.trim()) return;
        u.exp++; u.lvl = Math.floor(u.exp/20)+1;
        bcast({ type:'chat', msg:chatMsg(u, d.text) });
        break;
      }

      /* ── CLEAR CHAT (admin) ── */
      case 'clear_chat': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        store.chat = [];
        fbDelete('chat');
        bcast({ type:'chat_cleared' });
        break;
      }

      /* ── VIDEO ── */
      case 'video_change': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        store.video = { type:d.vtype||'mp4', vid:d.vid||'', vurl:d.vurl||'', title:d.title||'Video', playing:true, at:Date.now() };
        fbSet('video', store.video);
        bcast({ type:'video_change', video:store.video });
        bcast({ type:'chat', msg:sysMsg(`${u.username} yeni video: ${store.video.title}`) });
        break;
      }
      case 'video_sync': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        if (d.video) store.video = { ...store.video, ...d.video, at:Date.now() };
        fbSet('video', store.video);
        bcast({ type:'video_sync', video:store.video }, ws.wsId);
        break;
      }

      /* ── SEAT ── */
      case 'take_seat': {
        const u = store.users[ws.wsId];
        if (!u) return;
        if (u.seat===d.seat) { u.seat=0; u.voice=false; bcast({type:'voice_peer_left',peerId:ws.wsId}); }
        else {
          const occ = allUsers().find(x => x.seat===d.seat);
          if (occ && occ.id!==ws.wsId) return;
          u.seat = d.seat;
        }
        bcast({ type:'users', users:allUsers() });
        break;
      }

      /* ── VOICE ── */
      case 'voice_join': {
        const u = store.users[ws.wsId];
        if (!u || u.seat===0) return;
        u.voice = true;
        bcast({ type:'voice_peer_joined', peerId:ws.wsId }, ws.wsId);
        const existing = allUsers().filter(x => x.id!==ws.wsId && x.voice).map(x => x.id);
        ws.send(JSON.stringify({ type:'voice_peers_existing', peers:existing }));
        bcast({ type:'users', users:allUsers() });
        break;
      }
      case 'voice_leave': {
        const u = store.users[ws.wsId];
        if (!u) return;
        u.voice = false;
        bcast({ type:'voice_peer_left', peerId:ws.wsId });
        bcast({ type:'users', users:allUsers() });
        break;
      }
      case 'webrtc_signal': {
        const u = store.users[ws.wsId];
        if (!u || !d.to) return;
        sendTo(d.to, { type:'webrtc_signal', from:ws.wsId, signal:d.signal });
        break;
      }

      /* ── FRAME SELECT ── */
      case 'set_frame': {
        const u = store.users[ws.wsId];
        if (!u) return;
        const frame = store.items.find(it => it.type==='frame' && it.id===d.frameId);
        u.frame = frame ? frame.id : '';
        bcast({ type:'users', users:allUsers() });
        break;
      }

      /* ── AVATAR ── */
      case 'update_avatar': {
        const u = store.users[ws.wsId];
        if (!u) return;
        u.avatar = (d.avatar||'').slice(0,500);
        bcast({ type:'users', users:allUsers() });
        break;
      }

      /* ── ROOM SETTINGS (admin) ── */
      case 'room_settings': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        store.room = { ...store.room, ...d.settings };
        fbSet('room', store.room);
        bcast({ type:'room_settings', room:store.room });
        break;
      }

      /* ── ITEM EKLE/SİL (admin) ── */
      case 'add_item': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        const item = { id:uuid(), name:d.name||'Item', type:d.itemType||'frame', url:d.url||'', effectUrl:d.effectUrl||'', ts:Date.now() };
        store.items.push(item);
        fbPush('items', item).then(() => {
          bcast({ type:'items_update', items:store.items });
        });
        break;
      }
      case 'delete_item': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        store.items = store.items.filter(it => it.id!==d.itemId);
        // Firebase'den sil (fbKey ile)
        fbGet('items').then(all => {
          if (!all) return;
          Object.entries(all).forEach(([k,v]) => { if(v.id===d.itemId) fbDelete(`items/${k}`); });
        });
        bcast({ type:'items_update', items:store.items });
        break;
      }

      /* ── HEDİYE EKLE/SİL (admin) ── */
      case 'add_gift': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        const gift = { id:uuid(), name:d.name||'Hediye', emoji:d.emoji||'🎁', url:d.url||'', effectUrl:d.effectUrl||'', type:'gift', ts:Date.now() };
        store.items.push(gift);
        fbPush('items', gift).then(() => {
          bcast({ type:'items_update', items:store.items });
        });
        break;
      }

      /* ── HEDİYE GÖNDER ── */
      case 'gift': {
        const u = store.users[ws.wsId];
        if (!u) return;
        const giftItem = store.items.find(it => it.id===d.giftId && it.type==='gift');
        const m = sysMsg(`${giftItem?.emoji||d.emoji||'★'} ${u.username} → ${d.to}: ${giftItem?.name||d.name}`,'gift');
        bcast({ type:'chat', msg:m });
        bcast({ type:'gift_fx', from:u.username, to:d.to, name:giftItem?.name||d.name, emoji:giftItem?.emoji||d.emoji||'★', effectUrl:giftItem?.effectUrl||'' });
        break;
      }

      /* ── MUTE / KICK ── */
      case 'mute_user': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        const t = allUsers().find(x => x.username===d.username);
        if (!t) return;
        t.muted = !t.muted;
        bcast({ type:'users', users:allUsers() });
        bcast({ type:'chat', msg:sysMsg(`${t.username} ${t.muted?'susturuldu':'sesi acildi'}`) });
        break;
      }
      case 'kick_user': {
        const u = store.users[ws.wsId];
        if (!u || u.tur!=='admin') return;
        const t = allUsers().find(x => x.username===d.username);
        if (!t) return;
        t.banned = true;
        sendTo(t.id, { type:'banned' });
        bcast({ type:'chat', msg:sysMsg(`${t.username} odadan atildi`) });
        break;
      }

      case 'ping': ws.send(JSON.stringify({type:'pong'})); break;
    }
  });

  ws.on('close', () => {
    const u = store.users[ws.wsId];
    if (!u) return;
    if (u.voice) bcast({ type:'voice_peer_left', peerId:ws.wsId });
    delete store.users[ws.wsId];
    bcast({ type:'chat', msg:sysMsg(`${u.username} ayrildi`) });
    bcast({ type:'users', users:allUsers() });
  });

  ws.on('error', () => {});
});

/* Heartbeat */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  });
}, 25000);

/* ══ START ══ */
loadFromFirebase().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () =>
    console.log(`\n  Maya Film  http://localhost:${PORT}\n  Admin:     http://localhost:${PORT}?isAdmin=true\n`)
  );
});
