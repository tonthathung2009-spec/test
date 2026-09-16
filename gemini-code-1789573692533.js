const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;
const PLAYER_RADIUS = 20;

const OBSTACLES = [
  { x: 0, y: 0, w: MAP_WIDTH, h: 20 },
  { x: 0, y: MAP_HEIGHT - 20, w: MAP_WIDTH, h: 20 },
  { x: 0, y: 0, w: 20, h: MAP_HEIGHT },
  { x: MAP_WIDTH - 20, y: 0, w: 20, h: MAP_HEIGHT },
  { x: 700, y: 400, w: 200, h: 200, type: 'water' },
  { x: 200, y: 150, w: 120, h: 120, type: 'crate' },
  { x: 1280, y: 150, w: 120, h: 120, type: 'crate' },
  { x: 200, y: 730, w: 120, h: 120, type: 'wall' },
  { x: 1280, y: 730, w: 120, h: 120, type: 'wall' },
  { x: 450, y: 300, w: 60, h: 250, type: 'wall' },
  { x: 1090, y: 450, w: 60, h: 250, type: 'wall' },
  { x: 800, y: 150, w: 100, h: 100, type: 'tree' },
  { x: 700, y: 750, w: 200, h: 80, type: 'tree' }
];

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function checkCollision(x, y, radius) {
  for (const obs of OBSTACLES) {
    const closestX = Math.max(obs.x, Math.min(x, obs.x + obs.w));
    const closestY = Math.max(obs.y, Math.min(y, obs.y + obs.h));
    const distX = x - closestX;
    const distY = y - closestY;
    if ((distX * distX + distY * distY) < (radius * radius)) return true;
  }
  return false;
}

function lineIntersectsObstacles(x1, y1, x2, y2) {
  for (const obs of OBSTACLES) {
    const left = obs.x, right = obs.x + obs.w, top = obs.y, bottom = obs.y + obs.h;
    if (lineSegmentIntersect(x1, y1, x2, y2, left, top, right, top)) return true;
    if (lineSegmentIntersect(x1, y1, x2, y2, right, top, right, bottom)) return true;
    if (lineSegmentIntersect(x1, y1, x2, y2, right, bottom, left, bottom)) return true;
    if (lineSegmentIntersect(x1, y1, x2, y2, left, bottom, left, top)) return true;
  }
  return false;
}

function lineSegmentIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const uA = ((x4-x3)*(y1-y3) - (y4-y3)*(x1-x3)) / ((y4-y3)*(x2-x1) - (x4-x3)*(y2-y1));
  const uB = ((x2-x1)*(y1-y3) - (y2-y1)*(x1-x3)) / ((y4-y3)*(x2-x1) - (x4-x3)*(y2-y1));
  return (uA >= 0 && uA <= 1 && uB >= 0 && uB <= 1);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('createRoom', ({ name }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      state: 'WAITING',
      players: {},
      bombHolderId: null,
      bombTimer: 10,
      timerInterval: null
    };
    joinRoomLogic(socket, roomCode, name);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const roomCode = code.toUpperCase();
    if (!rooms[roomCode]) return socket.emit('errorMsg', 'Phòng không tồn tại!');
    if (Object.keys(rooms[roomCode].players).length >= 20) return socket.emit('errorMsg', 'Phòng đã đầy (Max 20)!');
    if (rooms[roomCode].state !== 'WAITING') return socket.emit('errorMsg', 'Trận đấu đang diễn ra!');
    joinRoomLogic(socket, roomCode, name);
  });

  function joinRoomLogic(socket, roomCode, name) {
    currentRoom = roomCode;
    socket.join(roomCode);
    const colors = ['#FF4757', '#2ED573', '#1E90FF', '#FFA500', '#9B59B6', '#1ABC9C', '#FD79A8', '#E67E22'];
    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: name || 'Player',
      x: 100 + Math.random() * 1400,
      y: 100 + Math.random() * 800,
      color: colors[Math.floor(Math.random() * colors.length)],
      isReady: false,
      isAlive: true,
      facingRight: true,
      isMoving: false
    };
    socket.emit('joinedSuccess', { roomCode, playerId: socket.id, obstacles: OBSTACLES, mapSize: { w: MAP_WIDTH, h: MAP_HEIGHT } });
    broadcastRoomUpdate(roomCode);
  }

  socket.on('toggleReady', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const p = rooms[currentRoom].players[socket.id];
    if (p) { p.isReady = !p.isReady; broadcastRoomUpdate(currentRoom); }
  });

  socket.on('startGame', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 2) return socket.emit('errorMsg', 'Cần ít nhất 2 người chơi!');
    startNewRound(room);
  });

  socket.on('move', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[socket.id];
    if (!player || !player.isAlive || room.state !== 'PLAYING') return;

    const speed = 4;
    let newX = player.x, newY = player.y;
    if (data.left) newX -= speed;
    if (data.right) newX += speed;
    if (data.up) newY -= speed;
    if (data.down) newY += speed;

    player.isMoving = (data.left || data.right || data.up || data.down);
    if (data.left) player.facingRight = false;
    if (data.right) player.facingRight = true;

    if (!checkCollision(newX, player.y, PLAYER_RADIUS)) player.x = newX;
    if (!checkCollision(player.x, newY, PLAYER_RADIUS)) player.y = newY;
    player.x = Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, player.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, player.y));
  });

  socket.on('passBomb', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.state !== 'PLAYING' || room.bombHolderId !== socket.id) return;
    const holder = room.players[socket.id];
    if (!holder || !holder.isAlive) return;

    let closestTarget = null;
    let minDistance = 85;
    for (const [id, target] of Object.entries(room.players)) {
      if (id === socket.id || !target.isAlive) continue;
      const dist = Math.hypot(target.x - holder.x, target.y - holder.y);
      if (dist < minDistance && !lineIntersectsObstacles(holder.x, holder.y, target.x, target.y)) {
        minDistance = dist;
        closestTarget = id;
      }
    }
    if (closestTarget) {
      room.bombHolderId = closestTarget;
      io.to(room.code).emit('bombPassed', { from: socket.id, to: closestTarget });
      syncGameState(room);
    }
  });

  socket.on('playAgain', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.hostId === socket.id && room.state === 'WINNER') startNewRound(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    delete room.players[socket.id];
    const remaining = Object.keys(room.players);
    if (remaining.length === 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      delete rooms[currentRoom];
      return;
    }
    if (room.hostId === socket.id) room.hostId = remaining[0];
    if (room.state === 'PLAYING' && room.bombHolderId === socket.id) transferBombRandom(room);
    checkWinCondition(room);
    broadcastRoomUpdate(currentRoom);
  });
});

function startNewRound(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.state = 'PLAYING';
  Object.values(room.players).forEach(p => {
    p.isAlive = true;
    do {
      p.x = 100 + Math.random() * (MAP_WIDTH - 200);
      p.y = 100 + Math.random() * (MAP_HEIGHT - 200);
    } while (checkCollision(p.x, p.y, PLAYER_RADIUS));
  });
  transferBombRandom(room);
  startBombTimer(room);
  io.to(room.code).emit('gameStarted');
  syncGameState(room);
}

function transferBombRandom(room) {
  const alive = Object.values(room.players).filter(p => p.isAlive);
  room.bombHolderId = alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)].id : null;
}

function startBombTimer(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.bombTimer = 10;
  room.timerInterval = setInterval(() => {
    if (room.state !== 'PLAYING') return;
    room.bombTimer -= 1;
    if (room.bombTimer <= 0) {
      const victimId = room.bombHolderId;
      if (victimId && room.players[victimId]) {
        room.players[victimId].isAlive = false;
        io.to(room.code).emit('bombExploded', {
          victimId, victimName: room.players[victimId].name,
          x: room.players[victimId].x, y: room.players[victimId].y
        });
      }
      if (!checkWinCondition(room)) {
        transferBombRandom(room);
        room.bombTimer = 10;
      }
    }
    syncGameState(room);
  }, 1000);
}

function checkWinCondition(room) {
  if (room.state !== 'PLAYING') return false;
  const alive = Object.values(room.players).filter(p => p.isAlive);
  if (alive.length <= 1) {
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.state = 'WINNER';
    const winner = alive.length === 1 ? alive[0] : null;
    io.to(room.code).emit('gameOver', { winner: winner ? { id: winner.id, name: winner.name } : { name: 'Không ai cả' } });
    return true;
  }
  return false;
}

function broadcastRoomUpdate(code) {
  const room = rooms[code];
  if (room) io.to(code).emit('roomUpdated', { roomCode: room.code, hostId: room.hostId, players: room.players, state: room.state });
}

function syncGameState(room) {
  io.to(room.code).emit('gameStateSync', { players: room.players, bombHolderId: room.bombHolderId, bombTimer: room.bombTimer, state: room.state });
}

setInterval(() => {
  for (const code in rooms) {
    if (rooms[code].state === 'PLAYING') io.to(code).emit('positionUpdate', { players: rooms[code].players });
  }
}, 1000 / 30);

// TRẢ VỀ TOÀN BỘ GIAO DIỆN & CLIENT CODE TRÊN TRÌNH DUYỆT
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BOM RELAY - Single File</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: sans-serif; user-select: none; }
    body, html { width: 100%; height: 100%; overflow: hidden; background: #1a1a24; color: #fff; }
    #gameCanvas { display: block; width: 100vw; height: 100vh; background: #2b2b36; }
    #ui-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; z-index: 10; pointer-events: none; }
    .panel { pointer-events: auto; background: rgba(25, 25, 35, 0.95); border: 3px solid #ff4757; border-radius: 16px; padding: 30px; width: 90%; max-width: 420px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.7); }
    .panel h1 { font-size: 32px; color: #ff4757; margin-bottom: 5px; }
    .subtitle { font-size: 14px; color: #aaa; margin-bottom: 20px; }
    .input-group { margin-bottom: 15px; text-align: left; }
    .input-group label { display: block; font-size: 13px; color: #ccc; margin-bottom: 5px; }
    input[type="text"] { width: 100%; padding: 12px; border-radius: 8px; border: 2px solid #444; background: #111; color: #fff; font-size: 16px; text-align: center; outline: none; }
    input[type="text"]:focus { border-color: #ff4757; }
    .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 5px; }
    .btn.primary { background: #ff4757; color: white; }
    .btn.secondary { background: #1e90ff; color: white; }
    .btn.success { background: #2ed573; color: white; }
    .divider { margin: 15px 0; font-size: 12px; color: #666; }
    .player-list { max-height: 200px; overflow-y: auto; margin: 15px 0; border: 1px solid #333; border-radius: 8px; padding: 10px; background: rgba(0,0,0,0.3); }
    .player-item { display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid #222; font-size: 14px; }
    .badge { font-size: 11px; padding: 3px 6px; border-radius: 4px; font-weight: bold; }
    .badge.host { background: #ffa500; color: #000; }
    .badge.ready { background: #2ed573; color: #000; }
    #game-hud { position: absolute; top: 15px; left: 50%; transform: translateX(-50%); z-index: 5; display: flex; flex-direction: column; align-items: center; pointer-events: none; }
    .hud-card { background: rgba(0,0,0,0.75); border: 2px solid #555; padding: 10px 25px; border-radius: 30px; display: flex; gap: 20px; font-size: 16px; font-weight: bold; }
    .controls-hint { margin-top: 8px; background: rgba(0,0,0,0.5); padding: 4px 12px; border-radius: 12px; font-size: 12px; color: #ddd; }
    .trophy { font-size: 64px; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="ui-overlay">
    <div id="start-screen" class="panel">
      <h1>💣 BOM RELAY 💣</h1>
      <p class="subtitle">Party Game Realtime Top-Down Chibi</p>
      <div class="input-group">
        <label>Tên người chơi:</label>
        <input type="text" id="player-name" placeholder="Nhập tên..." maxlength="12">
      </div>
      <button id="btn-create" class="btn primary">TẠO PHÒNG</button>
      <div class="divider">HOẶC</div>
      <div class="input-group">
        <input type="text" id="room-code-input" placeholder="MÃ PHÒNG" maxlength="4">
        <button id="btn-join" class="btn secondary">THAM GIA</button>
      </div>
    </div>
    <div id="lobby-screen" class="panel hidden">
      <h2>PHÒNG: <span id="lobby-code-display">----</span></h2>
      <div id="player-count">Người chơi: 0/20</div>
      <div id="player-list" class="player-list"></div>
      <button id="btn-ready" class="btn secondary">SẴN SÀNG</button>
      <button id="btn-start" class="btn success hidden">BẮT ĐẦU GAME</button>
    </div>
    <div id="winner-screen" class="panel hidden">
      <h1 class="trophy">🏆</h1>
      <h2 id="winner-name">Player X Thắng!</h2>
      <button id="btn-play-again" class="btn primary hidden">CHƠI LẠI</button>
    </div>
  </div>
  <div id="game-hud" class="hidden">
    <div class="hud-card">
      <div>⏱️ BOM: <span id="hud-timer">10</span>s</div>
      <div>💣 CẦM BOM: <span id="hud-holder">---</span></div>
      <div>👥 SỐNG SÓT: <span id="hud-alive">0</span></div>
    </div>
    <div class="controls-hint">[WASD] Di chuyển | [E] Truyền Bom</div>
  </div>
  <canvas id="gameCanvas"></canvas>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    window.addEventListener('resize', resize); resize();

    let myPlayerId = null, currentRoomCode = null, gameState = 'WAITING';
    let players = {}, obstacles = [], mapSize = { w: 1600, h: 1000 };
    let bombHolderId = null, bombTimer = 10, explosionEffects = [];
    const keys = { up: false, down: false, left: false, right: false };

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    function playSound(type) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      if (type === 'tick') {
        osc.type = 'sine'; osc.frequency.setValueAtTime(600, now);
        gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        osc.start(now); osc.stop(now + 0.05);
      } else if (type === 'fastTick') {
        osc.type = 'square'; osc.frequency.setValueAtTime(900, now);
        gain.gain.setValueAtTime(0.15, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
        osc.start(now); osc.stop(now + 0.04);
      } else if (type === 'pass') {
        osc.type = 'triangle'; osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.15);
        gain.gain.setValueAtTime(0.2, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now); osc.stop(now + 0.15);
      } else if (type === 'boom') {
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.5);
        gain.gain.setValueAtTime(0.4, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
        osc.start(now); osc.stop(now + 0.5);
      }
    }

    const uiStartScreen = document.getElementById('start-screen');
    const uiLobbyScreen = document.getElementById('lobby-screen');
    const uiWinnerScreen = document.getElementById('winner-screen');
    const uiGameHud = document.getElementById('game-hud');
    const inputName = document.getElementById('player-name');
    const inputRoomCode = document.getElementById('room-code-input');

    document.getElementById('btn-create').onclick = () => socket.emit('createRoom', { name: inputName.value.trim() || 'Player' });
    document.getElementById('btn-join').onclick = () => {
      const code = inputRoomCode.value.trim();
      if(code) socket.emit('joinRoom', { code, name: inputName.value.trim() || 'Player' });
    };
    document.getElementById('btn-ready').onclick = () => socket.emit('toggleReady');
    document.getElementById('btn-start').onclick = () => socket.emit('startGame');
    document.getElementById('btn-play-again').onclick = () => socket.emit('playAgain');

    window.onkeydown = (e) => {
      if (['w', 'W', 'ArrowUp'].includes(e.key)) keys.up = true;
      if (['s', 'S', 'ArrowDown'].includes(e.key)) keys.down = true;
      if (['a', 'A', 'ArrowLeft'].includes(e.key)) keys.left = true;
      if (['d', 'D', 'ArrowRight'].includes(e.key)) keys.right = true;
      if (['e', 'E'].includes(e.key)) socket.emit('passBomb');
    };
    window.onkeyup = (e) => {
      if (['w', 'W', 'ArrowUp'].includes(e.key)) keys.up = false;
      if (['s', 'S', 'ArrowDown'].includes(e.key)) keys.down = false;
      if (['a', 'A', 'ArrowLeft'].includes(e.key)) keys.left = false;
      if (['d', 'D', 'ArrowRight'].includes(e.key)) keys.right = false;
    };

    setInterval(() => { if (gameState === 'PLAYING') socket.emit('move', keys); }, 1000 / 60);

    socket.on('joinedSuccess', (data) => {
      myPlayerId = data.playerId; currentRoomCode = data.roomCode;
      obstacles = data.obstacles; mapSize = data.mapSize;
      uiStartScreen.classList.add('hidden'); uiLobbyScreen.classList.remove('hidden');
      document.getElementById('lobby-code-display').innerText = currentRoomCode;
    });

    socket.on('errorMsg', (msg) => alert(msg));

    socket.on('roomUpdated', (room) => {
      players = room.players;
      document.getElementById('player-count').innerText = \`Người chơi: \${Object.keys(players).length}/20\`;
      const listContainer = document.getElementById('player-list');
      listContainer.innerHTML = '';
      Object.values(players).forEach(p => {
        const item = document.createElement('div'); item.className = 'player-item';
        const isHost = p.id === room.hostId;
        item.innerHTML = \`<span><strong style="color:\${p.color}">●</strong> \${p.name}</span>
          <span class="badge \${isHost ? 'host' : (p.isReady ? 'ready' : '')}">\${isHost ? 'HOST' : (p.isReady ? 'READY' : 'WAITING')}</span>\`;
        listContainer.appendChild(item);
      });
      document.getElementById('btn-start').classList.toggle('hidden', socket.id !== room.hostId);
    });

    socket.on('gameStarted', () => {
      gameState = 'PLAYING';
      uiLobbyScreen.classList.add('hidden'); uiWinnerScreen.classList.add('hidden'); uiGameHud.classList.remove('hidden');
    });

    socket.on('gameStateSync', (data) => {
      players = data.players; bombHolderId = data.bombHolderId;
      if (bombTimer !== data.bombTimer) {
        bombTimer = data.bombTimer;
        playSound(bombTimer <= 5 ? 'fastTick' : 'tick');
      }
      document.getElementById('hud-timer').innerText = bombTimer;
      document.getElementById('hud-holder').innerText = players[bombHolderId] ? players[bombHolderId].name : '---';
      document.getElementById('hud-alive').innerText = Object.values(players).filter(p => p.isAlive).length;
    });

    socket.on('positionUpdate', (data) => {
      for (const id in data.players) {
        if (players[id]) {
          players[id].x = data.players[id].x; players[id].y = data.players[id].y;
          players[id].facingRight = data.players[id].facingRight; players[id].isMoving = data.players[id].isMoving;
        }
      }
    });

    socket.on('bombPassed', (data) => { bombHolderId = data.to; playSound('pass'); });
    socket.on('bombExploded', (data) => {
      playSound('boom');
      explosionEffects.push({ x: data.x, y: data.y, radius: 10, alpha: 1.0 });
    });

    socket.on('gameOver', (data) => {
      gameState = 'WINNER';
      uiGameHud.classList.add('hidden'); uiWinnerScreen.classList.remove('hidden');
      document.getElementById('winner-name').innerText = \`\${data.winner.name} THẮNG! 🎉\`;
      document.getElementById('btn-play-again').classList.toggle('hidden', socket.id !== players[myPlayerId]?.id);
    });

    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let camX = 0, camY = 0;
      if (players[myPlayerId]) {
        camX = canvas.width / 2 - players[myPlayerId].x;
        camY = canvas.height / 2 - players[myPlayerId].y;
      }
      ctx.save(); ctx.translate(camX, camY);

      ctx.fillStyle = '#388e3c'; ctx.fillRect(0, 0, mapSize.w, mapSize.h);
      ctx.strokeStyle = '#2e7d32'; ctx.lineWidth = 4;
      for (let x = 0; x < mapSize.w; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mapSize.h); ctx.stroke(); }
      for (let y = 0; y < mapSize.h; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(mapSize.w, y); ctx.stroke(); }

      obstacles.forEach(obs => {
        if (obs.type === 'water') { ctx.fillStyle = '#0288d1'; ctx.fillRect(obs.x, obs.y, obs.w, obs.h); }
        else if (obs.type === 'crate') { ctx.fillStyle = '#8d6e63'; ctx.fillRect(obs.x, obs.y, obs.w, obs.h); }
        else if (obs.type === 'tree') { ctx.fillStyle = '#1b5e20'; ctx.fillRect(obs.x, obs.y, obs.w, obs.h); }
        else { ctx.fillStyle = '#616161'; ctx.fillRect(obs.x, obs.y, obs.w, obs.h); }
      });

      explosionEffects.forEach((fx, i) => {
        ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.radius, 0, Math.PI * 2);
        ctx.fillStyle = \`rgba(255, 69, 0, \${fx.alpha})\`; ctx.fill();
        fx.radius += 3; fx.alpha -= 0.04;
        if (fx.alpha <= 0) explosionEffects.splice(i, 1);
      });

      const now = Date.now();
      Object.values(players).forEach(p => {
        if (!p.isAlive) return;
        const bounceY = p.isMoving ? Math.sin(now / 100) * 4 : 0;
        ctx.save(); ctx.translate(p.x, p.y + bounceY);

        ctx.beginPath(); ctx.ellipse(0, 18, 15, 6, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();

        ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2);
        ctx.fillStyle = p.color; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.stroke();

        const eyeOffset = p.facingRight ? 6 : -6;
        ctx.fillStyle = '#fff'; ctx.beginPath();
        ctx.arc(eyeOffset - 3, -4, 5, 0, Math.PI * 2); ctx.arc(eyeOffset + 5, -4, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000'; ctx.beginPath();
        ctx.arc(eyeOffset - 2, -4, 2, 0, Math.PI * 2); ctx.arc(eyeOffset + 6, -4, 2, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(p.name, 0, -30);

        if (p.id === bombHolderId) {
          const isUrgent = bombTimer <= 5;
          ctx.font = isUrgent ? '28px sans-serif' : '22px sans-serif';
          ctx.fillText('💣', 0, -45);
          if (isUrgent && Math.floor(now / 150) % 2 === 0) {
            ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2);
            ctx.strokeStyle = '#ff4757'; ctx.lineWidth = 4; ctx.stroke();
          }
        }
        ctx.restore();
      });

      ctx.restore();
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=== BOM RELAY đang chạy tại http://localhost:${PORT} ===`);
});