const express  = require('express');
const http     = require('http');
const WS       = require('ws');
const { v4: uuid } = require('uuid');
const path     = require('path');

/* ══ FIREBASE REST API ══ */
const FB_URL = 'https://prstars-fb9b5-default-rtdb.firebaseio.com';
async function fbSet(p,data){try{await fetch(`${FB_URL}/${p}.json`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}catch(e){}}
async function fbPush(p,data){try{const r=await fetch(`${FB_URL}/${p}.json`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return await r.json();}catch(e){return null;}}
async function fbGet(p){try{const r=await fetch(`${FB_URL}/${p}.json`);return await r.json();}catch(e){return null;}}
async function fbDelete(p){try{await fetch(`${FB_URL}/${p}.json`,{method:'DELETE'});}catch(e){}}
async function fbUpdate(p,data){try{await fetch(`${FB_URL}/${p}.json`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}catch(e){}}

/* ══ EXPRESS + WS ══ */
const app    = express();
const server = http.createServer(app);
const wss    = new WS.Server({ server });
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

/* ══ STORE ══ */
const store = {
  users:  {},   // wsId → userObj
  chat:   [],
  video:  { type:'none', vid:'', vurl:'', title:'Yayin bekleniyor...', playing:false, currentTime:0, serverAt:Date.now() },
  room:   { name:'Maya Film', entrance_effect:'royal', entrance_video:'', seatColor:'#c41230', seatIcon:'' },
  items:  [],
  badges: {},   // username → { iconUrl, label }
  pairs:  [],   // [{id, user1, user2, iconUrl}]  koltuk çifti simgeleri
};

/* ══ PERSİSTENT USER PROFILES (Firebase) ══ */
/* /profiles/{username} = { tur, frame, entranceId, badge } */
async function loadUserProfile(username) {
  const p = await fbGet(`profiles/${encodeURIComponent(username)}`);
  return p && typeof p === 'object' ? p : {};
}
async function saveUserProfile(username, data) {
  await fbUpdate(`profiles/${encodeURIComponent(username)}`, data);
}

/* ══ VIDEO ══ */
function videoNow() {
  const v = store.video;
  if (!v.playing) return v.currentTime;
  return v.currentTime + (Date.now() - v.serverAt) / 1000;
}
function videoState() {
  return { ...store.video, currentTime: videoNow(), serverAt: Date.now() };
}

/* Admin veya mod seviyesini kontrol et */
function isAdmin(u) { return u?.tur === 'admin'; }
function isMod(u)   { return u?.tur === 'admin' || u?.tur === 'mod'; }

/* ══ FIREBASE YÜKLE ══ */
async function loadFromFirebase() {
  try {
    const [room, chat, items, badges, pairs] = await Promise.all([
      fbGet('room'), fbGet('chat'), fbGet('items'),
      fbGet('badges'), fbGet('pairs')
    ]);
    if (room  && typeof room === 'object')  Object.assign(store.room, room);
    if (chat  && typeof chat === 'object')  store.chat  = Object.values(chat).filter(Boolean).sort((a,b)=>a.ts-b.ts).slice(-200);
    if (items && typeof items === 'object') store.items = Object.entries(items).map(([k,v])=>({...v,_fbKey:k}));
    if (badges&& typeof badges==='object')  store.badges = badges;
    if (pairs && Array.isArray(pairs))      store.pairs  = pairs;
    else if (pairs && typeof pairs==='object') store.pairs = Object.values(pairs);
    console.log(`[Firebase] Yuklendi — oda:"${store.room.name}" items:${store.items.length}`);
  } catch(e) { console.error('[Firebase] Hata:',e.message); }
}

/* ══ HELPERS ══ */
function bcast(data,skip=null){const s=JSON.stringify(data);wss.clients.forEach(c=>{if(c.readyState===WS.OPEN&&c.wsId!==skip)c.send(s);});}
function sendTo(id,data){wss.clients.forEach(c=>{if(c.wsId===id&&c.readyState===WS.OPEN)c.send(JSON.stringify(data));});}
function allUsers(){return Object.values(store.users);}

function sysMsg(text,msgType='system'){
  const m={id:uuid(),username:'sistem',tur:'system',text,msgType,ts:Date.now(),avatar:''};
  store.chat.push(m);if(store.chat.length>250)store.chat.shift();
  fbPush('chat',m);return m;
}
function chatMsg(u,d){
  const m={id:uuid(),username:u.username,tur:u.tur,text:(d.text||'').slice(0,500),
    msgType:d.msgType||'text',gifUrl:d.gifUrl||'',replyTo:d.replyTo||null,
    mentions:d.mentions||[],ts:Date.now(),avatar:u.avatar||'',frame:u.frame||''};
  store.chat.push(m);if(store.chat.length>250)store.chat.shift();
  fbPush('chat',m);return m;
}

/* Aktif çift simgesini hesapla */
function getPairIcon(seat1, seat2) {
  for (const p of store.pairs) {
    const u1 = allUsers().find(u => u.username === p.user1);
    const u2 = allUsers().find(u => u.username === p.user2);
    if (!u1 || !u2) continue;
    // İki kullanıcı yan yana mı? (fark 1 koltuk)
    const s1 = u1.seat, s2 = u2.seat;
    if (s1 > 0 && s2 > 0 && Math.abs(s1-s2) === 1) {
      const mid = (s1 + s2) / 2;
      if (seat1 === mid || seat2 === mid || s1 === seat1 || s2 === seat1) {
        return { pairId: p.id, iconUrl: p.iconUrl, midSeat: mid, s1, s2 };
      }
    }
  }
  return null;
}

function getRoomData() {
  return {
    ...store.room,
    badges: store.badges,
    pairs:  store.pairs
  };
}

/* ══ WEBSOCKET ══ */
wss.on('connection', ws => {
  ws.wsId  = uuid();
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', async raw => {
    let d; try{ d = JSON.parse(raw); } catch { return; }

    switch(d.type) {

      /* ── JOIN ── */
      case 'join': {
        const { username, avatar='' } = d;
        if (!username) return;

        // Banned kontrolü
        const prev = allUsers().find(u => u.username === username);
        if (prev?.banned) { ws.send(JSON.stringify({type:'banned'})); ws.close(); return; }

        // Profile yükle (kalıcı: tur, frame, entranceId, badge)
        const profile = await loadUserProfile(username);

        // Avatar: gönderilen > Firebase kayıtlı
        let finalAvatar = avatar;
        if (!finalAvatar || finalAvatar.length < 10) {
          try {
            const avR = await fbGet(`avatars/${encodeURIComponent(username)}`);
            if (avR && typeof avR === 'string') finalAvatar = avR;
          } catch(e) {}
        }

        // tur: URL ?isAdmin > profilde kayıtlı > user
        const urlTur = d.tur || 'user';
        const savedTur = profile.tur || 'user';
        // isAdmin URL parametresi her zaman geçerli (güvenlik sunucu tarafında)
        const tur = urlTur === 'admin' ? 'admin' : (savedTur === 'mod' ? 'mod' : 'user');

        store.users[ws.wsId] = {
          id: ws.wsId, username, tur,
          avatar: finalAvatar || '',
          seat: 0, muted: false, banned: false, voice: false,
          exp:  prev?.exp  || profile.exp  || 0,
          lvl:  prev?.lvl  || (profile.exp ? Math.floor(profile.exp/20)+1 : 1),
          frame: profile.frame || d.frame || '',
          entranceId: profile.entranceId || d.entranceId || '',
          badge: store.badges[username] || null,
          isVideoMod: profile.isVideoMod || false,  // admin video yetkisi verdi mi
        };

        const u = store.users[ws.wsId];

        ws.send(JSON.stringify({
          type:'init', myId:ws.wsId,
          video: videoState(),
          chat:  store.chat.slice(-60),
          users: allUsers(),
          room:  getRoomData(),
          items: store.items,
          ownedItems: []
        }));

        // Giriş efekti
        const personalEff = u.entranceId
          ? store.items.find(it => it.id === u.entranceId && it.type === 'entrance')
          : null;
        bcast({ type:'entrance', username, tur,
          entrance_video: isAdmin(u) ? store.room.entrance_video : '',
          personal_entrance: personalEff || null,
          avatar: finalAvatar || '' }, ws.wsId);

        bcast({ type:'chat', msg: sysMsg(`${username} odaya katildi`) });
        bcast({ type:'users', users: allUsers() });
        break;
      }

      /* ── CHAT ── */
      case 'chat': {
        const u = store.users[ws.wsId];
        if (!u || u.muted || u.banned) return;
        const isGif = d.msgType === 'gif' && d.gifUrl;
        if (!isGif && !d.text?.trim()) return;
        const mentions = [];
        const re = /@([\w\u011f\u00fc\u015f\u0131\u00f6\u00e7\u011e\u00dc\u015e\u0130\u00d6\u00c7]+)/g;
        let mm; while ((mm=re.exec(d.text||''))!==null) mentions.push(mm[1]);
        d.mentions = mentions;
        u.exp++; u.lvl = Math.floor(u.exp/20)+1;
        bcast({ type:'chat', msg: chatMsg(u, d) });
        break;
      }

      case 'clear_chat': {
        const u = store.users[ws.wsId];
        if (!isAdmin(u)) return;
        store.chat = []; fbDelete('chat');
        bcast({ type:'chat_cleared' }); break;
      }

      case 'delete_msg': {
        const u = store.users[ws.wsId]; if (!u) return;
        const idx = store.chat.findIndex(m => m.id === d.msgId); if (idx < 0) return;
        const msg = store.chat[idx];
        if (msg.username !== u.username && !isAdmin(u)) return;
        store.chat.splice(idx, 1);
        bcast({ type:'msg_deleted', msgId: d.msgId }); break;
      }

      /* ── VIDEO (admin veya yetkili mod) ── */
      case 'video_change': {
        const u = store.users[ws.wsId];
        if (!isAdmin(u) && !u?.isVideoMod) return;
        store.video = { type:d.vtype||'mp4', vid:d.vid||'', vurl:d.vurl||'', title:d.title||'Video', playing:true, currentTime:0, serverAt:Date.now() };
        fbSet('video', store.video);
        bcast({ type:'video_change', video: videoState() });
        bcast({ type:'chat', msg: sysMsg(`${u.username} yeni video: ${store.video.title}`) });
        break;
      }

      case 'video_sync': {
        const u = store.users[ws.wsId];
        // Sadece admin sync gönderebilir; mod videoyu başlatabilir ama sync'i admin yönetir
        if (!isAdmin(u)) return;
        store.video.playing     = d.playing !== undefined ? d.playing : store.video.playing;
        store.video.currentTime = d.currentTime !== undefined ? d.currentTime : videoNow();
        store.video.serverAt    = Date.now();
        fbSet('video', store.video);
        bcast({ type:'video_sync', video: videoState() }, ws.wsId); break;
      }

      /* ── SEAT ── */
      case 'take_seat': {
        const u = store.users[ws.wsId]; if (!u) return;
        if (u.seat === d.seat) {
          u.seat = 0; u.voice = false;
          bcast({ type:'voice_peer_left', peerId: ws.wsId });
        } else {
          const occ = allUsers().find(x => x.seat === d.seat);
          if (occ && occ.id !== ws.wsId) return;
          u.seat = d.seat;
        }
        bcast({ type:'users', users: allUsers() }); break;
      }

      /* ── VOICE ── */
      case 'voice_join': {
        const u = store.users[ws.wsId]; if (!u || u.seat === 0) return;
        u.voice = true;
        bcast({ type:'voice_peer_joined', peerId: ws.wsId }, ws.wsId);
        const existing = allUsers().filter(x => x.id !== ws.wsId && x.voice).map(x => x.id);
        ws.send(JSON.stringify({ type:'voice_peers_existing', peers: existing }));
        bcast({ type:'users', users: allUsers() }); break;
      }
      case 'voice_leave': {
        const u = store.users[ws.wsId]; if (!u) return;
        u.voice = false;
        bcast({ type:'voice_peer_left', peerId: ws.wsId });
        bcast({ type:'users', users: allUsers() }); break;
      }
      case 'webrtc_signal': {
        const u = store.users[ws.wsId]; if (!u || !d.to) return;
        sendTo(d.to, { type:'webrtc_signal', from: ws.wsId, signal: d.signal }); break;
      }

      /* ── FRAME (kalıcı) ── */
      case 'set_frame': {
        const u = store.users[ws.wsId]; if (!u) return;
        const frame = store.items.find(it => it.type === 'frame' && it.id === d.frameId);
        u.frame = frame ? frame.id : '';
        saveUserProfile(u.username, { frame: u.frame });
        bcast({ type:'users', users: allUsers() }); break;
      }

      /* ── ENTRANCE ID (kalıcı) ── */
      case 'set_entrance': {
        const u = store.users[ws.wsId]; if (!u) return;
        const eff = store.items.find(it => it.type === 'entrance' && it.id === d.entranceId);
        u.entranceId = eff ? eff.id : '';
        saveUserProfile(u.username, { entranceId: u.entranceId });
        ws.send(JSON.stringify({ type:'pong' })); break;  // ack
      }

      /* ── AVATAR ── */
      case 'update_avatar': {
        const u = store.users[ws.wsId]; if (!u) return;
        u.avatar = (d.avatar||'').slice(0, 500000);
        if (d.avatar) fbSet(`avatars/${encodeURIComponent(u.username)}`, d.avatar).catch(()=>{});
        bcast({ type:'users', users: allUsers() }); break;
      }

      /* ── ROOM SETTINGS ── */
      case 'room_settings': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        store.room = { ...store.room, ...d.settings };
        fbSet('room', store.room);
        bcast({ type:'room_settings', room: getRoomData() }); break;
      }

      /* ── ITEM EKLE/SİL ── */
      case 'add_item': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const item = { id:uuid(), name:d.name||'Item', type:d.itemType||'frame', url:d.url||'', effectUrl:d.effectUrl||'', ts:Date.now() };
        store.items.push(item); fbPush('items', item);
        bcast({ type:'items_update', items: store.items }); break;
      }
      case 'delete_item': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const found = store.items.find(it => it.id === d.itemId);
        store.items = store.items.filter(it => it.id !== d.itemId);
        if (found?._fbKey) fbDelete(`items/${found._fbKey}`);
        else fbGet('items').then(all => {
          if (!all || typeof all !== 'object') return;
          Object.entries(all).forEach(([k,v]) => { if (v?.id === d.itemId) fbDelete(`items/${k}`); });
        });
        bcast({ type:'items_update', items: store.items }); break;
      }

      /* ── HEDİYE ── */
      case 'add_gift': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const gift = { id:uuid(), name:d.name||'Hediye', emoji:d.emoji||'🎁', url:d.url||'', effectUrl:d.effectUrl||'', type:'gift', ts:Date.now() };
        store.items.push(gift); fbPush('items', gift);
        bcast({ type:'items_update', items: store.items }); break;
      }
      case 'gift': {
        const u = store.users[ws.wsId]; if (!u) return;
        const giftItem = store.items.find(it => it.id === d.giftId && it.type === 'gift');
        const m = sysMsg(`${giftItem?.emoji||d.emoji||'🎁'} ${u.username} → ${d.to}: ${giftItem?.name||d.name}`, 'gift');
        bcast({ type:'chat', msg: m });
        bcast({ type:'gift_fx', from:u.username, to:d.to, name:giftItem?.name||d.name, emoji:giftItem?.emoji||d.emoji||'🎁', effectUrl:giftItem?.effectUrl||'' });
        break;
      }

      /* ── MOD YETKİSİ VER/AL (admin only) ── */
      case 'set_mod': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const t = allUsers().find(x => x.username === d.username); if (!t) return;
        t.tur = d.isMod ? 'mod' : 'user';
        saveUserProfile(t.username, { tur: t.tur });
        bcast({ type:'users', users: allUsers() });
        bcast({ type:'chat', msg: sysMsg(`${t.username} ${d.isMod ? 'moderatör yapıldı' : 'moderatörlükten alındı'}`) });
        break;
      }

      /* ── VİDEO KONTROLÜ VER/AL (admin only) ── */
      case 'set_video_mod': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const t = allUsers().find(x => x.username === d.username); if (!t) return;
        t.isVideoMod = !!d.give;
        saveUserProfile(t.username, { isVideoMod: t.isVideoMod });
        sendTo(t.id, { type:'video_mod_status', isVideoMod: t.isVideoMod });
        bcast({ type:'users', users: allUsers() });
        bcast({ type:'chat', msg: sysMsg(`${t.username} ${d.give ? 'video kontrolü aldı' : 'video kontrolü kaybetti'}`) });
        break;
      }

      /* ── BADGE EKLE (admin only) ── */
      case 'set_badge': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        if (d.iconUrl) {
          store.badges[d.username] = { iconUrl: d.iconUrl, label: d.label || '' };
        } else {
          delete store.badges[d.username];
        }
        fbSet('badges', store.badges);
        // Online kullanıcıya da uygula
        const t = allUsers().find(x => x.username === d.username);
        if (t) t.badge = store.badges[d.username] || null;
        bcast({ type:'room_settings', room: getRoomData() });
        bcast({ type:'users', users: allUsers() }); break;
      }

      /* ── KOLTUK ÇİFT SİMGESİ EKLE/SİL (admin only) ── */
      case 'add_pair': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const pair = { id: uuid(), user1: d.user1, user2: d.user2, iconUrl: d.iconUrl };
        // Varsa güncelle, yoksa ekle
        const idx = store.pairs.findIndex(p => p.user1 === d.user1 && p.user2 === d.user2);
        if (idx >= 0) store.pairs[idx] = pair;
        else store.pairs.push(pair);
        fbSet('pairs', store.pairs);
        bcast({ type:'room_settings', room: getRoomData() });
        bcast({ type:'users', users: allUsers() }); break;
      }
      case 'delete_pair': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        store.pairs = store.pairs.filter(p => p.id !== d.pairId);
        fbSet('pairs', store.pairs);
        bcast({ type:'room_settings', room: getRoomData() });
        bcast({ type:'users', users: allUsers() }); break;
      }

      /* ── MUTE / KICK ── */
      case 'mute_user': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const t = allUsers().find(x => x.username === d.username); if (!t) return;
        t.muted = !t.muted;
        bcast({ type:'users', users: allUsers() });
        bcast({ type:'chat', msg: sysMsg(`${t.username} ${t.muted?'susturuldu':'sesi açıldı'}`) }); break;
      }
      case 'kick_user': {
        const u = store.users[ws.wsId]; if (!isAdmin(u)) return;
        const t = allUsers().find(x => x.username === d.username); if (!t) return;
        t.banned = true;
        sendTo(t.id, { type:'banned' });
        bcast({ type:'chat', msg: sysMsg(`${t.username} odadan atıldı`) }); break;
      }

      case 'ping': ws.send(JSON.stringify({type:'pong'})); break;
    }
  });

  ws.on('close', () => {
    const u = store.users[ws.wsId]; if (!u) return;
    if (u.voice) bcast({ type:'voice_peer_left', peerId: ws.wsId });
    // Exp kaydet
    saveUserProfile(u.username, { exp: u.exp, lvl: u.lvl });
    delete store.users[ws.wsId];
    bcast({ type:'chat', msg: sysMsg(`${u.username} ayrıldı`) });
    bcast({ type:'users', users: allUsers() });
  });

  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive=false; ws.ping(); });
}, 25000);

/* ══ START ══ */
loadFromFirebase().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`\n  🎬 Maya Film  http://localhost:${PORT}\n  Admin: http://localhost:${PORT}?isAdmin=true\n`));
});
