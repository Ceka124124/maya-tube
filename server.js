
const express = require('express');
const http    = require('http');
const WS      = require('ws');
const { v4: uuid } = require('uuid');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WS.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─── IN-MEMORY STORE ─── */
const store = {
  users: {},
  chat:  [],
  video: { type:'none', vid:'', vurl:'', title:'Yayın bekleniyor...', playing:false, at:Date.now() },
  room:  { name:'Film Odası', bg_url:'', entrance_effect:'royal', entrance_video:'' }
};

function bcast(data, skip=null){
  const s=JSON.stringify(data);
  wss.clients.forEach(c=>{ if(c.readyState===WS.OPEN&&c.wsId!==skip) c.send(s); });
}
function sendTo(id,data){
  wss.clients.forEach(c=>{ if(c.wsId===id&&c.readyState===WS.OPEN) c.send(JSON.stringify(data)); });
}
function allUsers(){ return Object.values(store.users); }
function sysMsg(text,msgType='system'){
  const m={id:uuid(),username:'sistem',tur:'system',text,msgType,ts:Date.now(),avatar:''};
  store.chat.push(m); if(store.chat.length>200)store.chat.shift(); return m;
}
function chatMsg(u,text){
  const m={id:uuid(),username:u.username,tur:u.tur,text:text.slice(0,500),msgType:'text',ts:Date.now(),avatar:u.avatar||''};
  store.chat.push(m); if(store.chat.length>200)store.chat.shift(); return m;
}

wss.on('connection',ws=>{
  ws.wsId=uuid(); ws.alive=true;
  ws.on('pong',()=>{ws.alive=true;});
  ws.on('message',raw=>{
    let d; try{d=JSON.parse(raw);}catch{return;}
    switch(d.type){

      case 'join':{
        const {username,tur,avatar=''}=d;
        if(!username)return;
        const prev=allUsers().find(u=>u.username===username);
        if(prev?.banned){ws.send(JSON.stringify({type:'banned'}));ws.close();return;}
        store.users[ws.wsId]={
          id:ws.wsId,username,tur:tur||'user',avatar,
          seat:0,muted:false,banned:false,voice:false,
          exp:prev?.exp||0,lvl:prev?Math.floor((prev.exp||0)/20)+1:1
        };
        ws.send(JSON.stringify({type:'init',myId:ws.wsId,video:store.video,chat:store.chat.slice(-60),users:allUsers(),room:store.room}));
        bcast({type:'entrance',username,tur:tur||'user',effect:tur==='admin'?store.room.entrance_effect:'normal',entrance_video:tur==='admin'?store.room.entrance_video:''},ws.wsId);
        const m=sysMsg(`${username} odaya katıldı`);
        bcast({type:'chat',msg:m});
        bcast({type:'users',users:allUsers()});
        break;
      }

      case 'chat':{
        const u=store.users[ws.wsId];
        if(!u||u.muted||u.banned||!d.text?.trim())return;
        u.exp++;u.lvl=Math.floor(u.exp/20)+1;
        bcast({type:'chat',msg:chatMsg(u,d.text)});
        break;
      }

      case 'video_change':{
        const u=store.users[ws.wsId];
        if(!u||u.tur!=='admin')return;
        store.video={type:d.vtype||'mp4',vid:d.vid||'',vurl:d.vurl||'',title:d.title||'Video',playing:true,at:Date.now()};
        bcast({type:'video_change',video:store.video});
        bcast({type:'chat',msg:sysMsg(`${u.username} yeni video: ${store.video.title}`)});
        break;
      }

      case 'video_sync':{
        const u=store.users[ws.wsId];
        if(!u||u.tur!=='admin')return;
        if(d.video)store.video={...store.video,...d.video,at:Date.now()};
        bcast({type:'video_sync',video:store.video},ws.wsId);
        break;
      }

      case 'take_seat':{
        const u=store.users[ws.wsId];
        if(!u)return;
        if(u.seat===d.seat){u.seat=0;u.voice=false;bcast({type:'voice_peer_left',peerId:ws.wsId});}
        else{
          const occ=allUsers().find(x=>x.seat===d.seat);
          if(occ&&occ.id!==ws.wsId)return;
          u.seat=d.seat;
        }
        bcast({type:'users',users:allUsers()});
        break;
      }

      case 'voice_join':{
        const u=store.users[ws.wsId];
        if(!u||u.seat===0)return;
        u.voice=true;
        bcast({type:'voice_peer_joined',peerId:ws.wsId},ws.wsId);
        const existing=allUsers().filter(x=>x.id!==ws.wsId&&x.voice).map(x=>x.id);
        ws.send(JSON.stringify({type:'voice_peers_existing',peers:existing}));
        bcast({type:'users',users:allUsers()});
        break;
      }

      case 'voice_leave':{
        const u=store.users[ws.wsId];
        if(!u)return;
        u.voice=false;
        bcast({type:'voice_peer_left',peerId:ws.wsId});
        bcast({type:'users',users:allUsers()});
        break;
      }

      case 'webrtc_signal':{
        const u=store.users[ws.wsId];
        if(!u||!d.to)return;
        sendTo(d.to,{type:'webrtc_signal',from:ws.wsId,signal:d.signal});
        break;
      }

      case 'update_avatar':{
        const u=store.users[ws.wsId];
        if(!u)return;
        u.avatar=(d.avatar||'').slice(0,500);
        bcast({type:'users',users:allUsers()});
        break;
      }

      case 'room_settings':{
        const u=store.users[ws.wsId];
        if(!u||u.tur!=='admin')return;
        store.room={...store.room,...d.settings};
        bcast({type:'room_settings',room:store.room});
        break;
      }

      case 'mute_user':{
        const u=store.users[ws.wsId];
        if(!u||u.tur!=='admin')return;
        const t=allUsers().find(x=>x.username===d.username);
        if(!t)return;
        t.muted=!t.muted;
        bcast({type:'users',users:allUsers()});
        bcast({type:'chat',msg:sysMsg(`${t.username} ${t.muted?'susturuldu':'sesi açıldı'}`)});
        break;
      }

      case 'kick_user':{
        const u=store.users[ws.wsId];
        if(!u||u.tur!=='admin')return;
        const t=allUsers().find(x=>x.username===d.username);
        if(!t)return;
        t.banned=true;
        sendTo(t.id,{type:'banned'});
        bcast({type:'chat',msg:sysMsg(`${t.username} odadan atıldı`)});
        break;
      }

      case 'gift':{
        const u=store.users[ws.wsId];
        if(!u)return;
        const m=sysMsg(`${d.emoji||'★'} ${u.username} → ${d.to}: ${d.name}`,'gift');
        bcast({type:'chat',msg:m});
        bcast({type:'gift_fx',from:u.username,to:d.to,name:d.name,emoji:d.emoji||'★'});
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({type:'pong'}));
        break;
    }
  });

  ws.on('close',()=>{
    const u=store.users[ws.wsId];
    if(!u)return;
    if(u.voice)bcast({type:'voice_peer_left',peerId:ws.wsId});
    delete store.users[ws.wsId];
    bcast({type:'chat',msg:sysMsg(`${u.username} ayrıldı`)});
    bcast({type:'users',users:allUsers()});
  });
  ws.on('error',()=>{});
});

setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(!ws.alive)return ws.terminate();
    ws.alive=false;ws.ping();
  });
},25000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`\n  Film Odasi  http://localhost:${PORT}\n  Admin URL:  http://localhost:${PORT}?isAdmin=true\n`));
