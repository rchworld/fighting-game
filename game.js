/* ===================== 총검 아레나 (Gun & Sword Arena) =====================
   3D browser game built with three.js.
   Phases: LOBBY -> ITEM_SELECT -> PLAYING -> RESULTS
============================================================================ */

const ITEM_DEFS = {
  tornado:  { name: '토네이도', rank: 1, color: 0xbfe6ff },
  electric: { name: '전기',     rank: 2, color: 0xfff066 },
  ice:      { name: '얼음',     rank: 3, color: 0xaeeeff },
  rock:     { name: '돌',       rank: 4, color: 0x8a7a68 },
  fire:     { name: '불',       rank: 5, color: 0xff7a33 },
  water:    { name: '물',       rank: 6, color: 0x3399ff },
  bug:      { name: '벌레',     rank: 7, color: 0x77aa33 },
};
const ITEM_KEYS = Object.keys(ITEM_DEFS);
const ITEM_COOLDOWN = 5;      // seconds
const MATCH_SECONDS = 5 * 60; // 5 minutes
const ELIMINATE_THRESHOLD = 30; // power below this after losing a clash => eliminated

/* ------------------------------ SFX (synthesized, no assets) ------------------------------ */
let audioCtx = null;
function sfx(freq, dur, type, gainPeak) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainPeak || 0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch (e) { /* audio unavailable, ignore */ }
}
const SFX = {
  gunFire: () => sfx(180, 0.08, 'square', 0.12),
  gunMiss: () => sfx(140, 0.06, 'square', 0.06),
  swordHit: () => sfx(500, 0.12, 'triangle', 0.15),
  swordWhiff: () => sfx(300, 0.08, 'triangle', 0.06),
  itemUse: () => sfx(700, 0.2, 'sine', 0.14),
  teamSwap: () => sfx(440, 0.3, 'sawtooth', 0.13),
  eliminate: () => sfx(120, 0.5, 'sawtooth', 0.18),
  matchStart: () => sfx(880, 0.25, 'sine', 0.15),
  matchEnd: () => sfx(220, 0.6, 'sine', 0.16),
};

let phase = 'MODE_SELECT';
let gameMode = 'VARIANT'; // 'VARIANT' (아이템/탑/랭킹) | 'NORMAL' (총검만 있는 단순 난투)
let scene, camera, renderer, clock;
let floor, skyFog;
let obstacleBoxes = [];
let normalScore = 0;
let cabinGroup = null;
let teams = [];          // { key, def, power, floors, alive, players:[], color, towerMesh, towerGroup }
let playerTeam = null;
let playerObj = null;    // { mesh, vel, onGround, weapon, hp }
let bots = [];           // { mesh, teamKey, wanderTarget }
let keys = {};
let yaw = 0, pitch = 0;
let pointerLocked = false;
let playerClimb = 0; // 0..1, how far up a tower's stairway the player currently is
let jumpHeight = 0, jumpVel = 0; // Space bar jump physics
let collidables = []; // { minX, maxX, minZ, maxZ, skip? } - walls/furniture/chairs the player can't walk through

function addCollidableBox(cx, cz, halfW, halfD) {
  collidables.push({ minX: cx - halfW, maxX: cx + halfW, minZ: cz - halfD, maxZ: cz + halfD });
}
function pushOutOfCollidables(pos) {
  for (const box of collidables) {
    if (box.skip) continue;
    if (pos.x < box.minX || pos.x > box.maxX || pos.z < box.minZ || pos.z > box.maxZ) continue;
    const dLeft = pos.x - box.minX, dRight = box.maxX - pos.x;
    const dFront = pos.z - box.minZ, dBack = box.maxZ - pos.z;
    const min = Math.min(dLeft, dRight, dFront, dBack);
    if (min === dLeft) pos.x = box.minX;
    else if (min === dRight) pos.x = box.maxX;
    else if (min === dFront) pos.z = box.minZ;
    else pos.z = box.maxZ;
  }
}
const TOWER_COLLISION_RADIUS = 8; // spacious interior
const DOOR_HALF_WIDTH = 1.05; // radians (~60 degrees each side = a wide, easy-to-hit doorway)
let weapon = null;       // null | 'gun' | 'sword'
let itemCooldownLeft = 0;
let matchTimeLeft = MATCH_SECONDS;
let matchRunning = false;
let botClashTimer = 0;
let tornado = { active: false, timeLeft: 0, teamKey: null, targetKey: null };
let fireZone = { active: false, timeLeft: 0, teamKey: null };
let msgLog = [];
let fireMesh = null, tornadoMesh = null, snowGroup = null, snowTimeLeft = 0;

function initEffectMeshes() {
  fireMesh = new THREE.Mesh(
    new THREE.SphereGeometry(2.5, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0xff5511, emissive: 0xff4400, emissiveIntensity: 0.8 })
  );
  fireMesh.position.set(0, 2.5, 0);
  fireMesh.visible = false;
  scene.add(fireMesh);

  tornadoMesh = new THREE.Mesh(
    new THREE.ConeGeometry(3, 12, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xdfefff, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  tornadoMesh.visible = false;
  scene.add(tornadoMesh);

  snowGroup = new THREE.Group();
  const snowGeo = new THREE.SphereGeometry(0.08, 4, 4);
  const snowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 0; i < 200; i++) {
    const flake = new THREE.Mesh(snowGeo, snowMat);
    flake.position.set((Math.random() - 0.5) * 60, Math.random() * 20, (Math.random() - 0.5) * 60);
    snowGroup.add(flake);
  }
  snowGroup.visible = false;
  scene.add(snowGroup);
}

function updateEffectMeshes(dt) {
  if (fireMesh) {
    fireMesh.visible = fireZone.active;
    if (fireZone.active) fireMesh.rotation.y += dt * 2;
  }
  if (tornadoMesh) {
    tornadoMesh.visible = tornado.active;
    if (tornado.active) {
      const targetTeam = teams.find(t => t.key === tornado.targetKey);
      if (targetTeam) tornadoMesh.position.set(targetTeam.pos.x, 6, targetTeam.pos.z);
      tornadoMesh.rotation.y += dt * 6;
    }
  }
  if (snowGroup) {
    if (snowTimeLeft > 0) {
      snowTimeLeft -= dt;
      snowGroup.visible = true;
      for (const flake of snowGroup.children) {
        flake.position.y -= dt * 3;
        if (flake.position.y < 0) flake.position.y = 20;
      }
    } else {
      snowGroup.visible = false;
    }
  }
}

const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const timerEl = document.getElementById('timer');
const towersEl = document.getElementById('towers');
const msgEl = document.getElementById('msg');
const crosshair = document.getElementById('crosshair');
const cooldownFill = document.getElementById('cooldownFill');

/* ------------------------------ INIT THREE ------------------------------ */
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfbfc2);
  scene.fog = new THREE.FogExp2(0xbfbfc2, 0.012);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 1.7, 8);
  scene.add(camera); // so weapon models parented to the camera render

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('crosshair'));

  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(10, 20, 10);
  scene.add(dir);

  const floorGeo = new THREE.PlaneGeometry(200, 200);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9e });
  floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // scattered dreamlike brown boxes (변형/Variant arena decoration)
  obstacleBoxes = [];
  for (let i = 0; i < 40; i++) {
    const s = 1 + Math.random() * 2;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(s, s, s),
      new THREE.MeshStandardMaterial({ color: 0x8b5a2b })
    );
    const ang = Math.random() * Math.PI * 2;
    const rad = 10 + Math.random() * 70;
    box.position.set(Math.cos(ang) * rad, s / 2, Math.sin(ang) * rad);
    box.userData.isObstacle = true;
    scene.add(box);
    obstacleBoxes.push(box);
  }

  clock = new THREE.Clock();
  initEffectMeshes();
  initWeaponModels();
  window.addEventListener('resize', onResize);
  animate();
}
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* ------------------------------ LOBBY (3D walk-in) ------------------------------ */
const ROOMS = [
  { key: '5v5', label: '5 / 5', size: 5, team: true },
  { key: '4v4', label: '4 / 4', size: 4, team: true },
  { key: '3v3', label: '3 / 3', size: 3, team: true },
  { key: '2v2', label: '2 / 2', size: 2, team: true },
  { key: '1v1', label: '1 / 1', size: 1, team: false },
];
const LOBBY_CIRCLE_RADIUS = 3.5;
let lobbyGroup = null;
let lobbyCircles = []; // { mesh, room, pos }
let selectedRoom = null;
let selectedItem = null;

let lobbyBots = [];
const LOBBY_NPC_COUNT = 16;

function buildLobbyScene() {
  if (lobbyGroup) { scene.remove(lobbyGroup); }
  for (const nb of lobbyBots) scene.remove(nb.mesh);
  lobbyBots = [];
  lobbyGroup = new THREE.Group();
  lobbyCircles = [];
  const spacing = 14;
  const startX = -((ROOMS.length - 1) * spacing) / 2;
  ROOMS.forEach((room, i) => {
    const pos = new THREE.Vector3(startX + i * spacing, 0.02, -10);
    const circleColor = room.team ? 0x2fb8ff : 0xffb23f;

    // filled glowing disc on the ground (a thin flat ring is nearly invisible from eye height)
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(LOBBY_CIRCLE_RADIUS, 48),
      new THREE.MeshBasicMaterial({ color: circleColor, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(pos);
    lobbyGroup.add(disc);

    // bright rim so the circle's edge reads clearly even from far away
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(LOBBY_CIRCLE_RADIUS - 0.2, LOBBY_CIRCLE_RADIUS, 48),
      new THREE.MeshBasicMaterial({ color: circleColor, side: THREE.DoubleSide })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.copy(pos).setY(pos.y + 0.01);
    lobbyGroup.add(rim);

    // a tall translucent beacon pillar, visible as a landmark from across the lobby
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(LOBBY_CIRCLE_RADIUS, LOBBY_CIRCLE_RADIUS, 8, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: circleColor, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
    );
    beacon.position.set(pos.x, 4, pos.z);
    lobbyGroup.add(beacon);

    const label = makeTextSprite(`${room.label}\n${room.team ? '팀전' : '개인전'}`);
    label.position.set(pos.x, 2.4, pos.z);
    lobbyGroup.add(label);

    const countLabel = makeDynamicLabel('0명', 'rgba(20,60,90,0.6)');
    countLabel.sprite.position.set(pos.x, 3.6, pos.z);
    lobbyGroup.add(countLabel.sprite);

    lobbyCircles.push({ room, pos, countLabel, count: 0 });
  });
  scene.add(lobbyGroup);

  // simulated other players wandering between circles and "voting" by standing in one
  for (let i = 0; i < LOBBY_NPC_COUNT; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.4, 0.4) });
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 8), mat);
    const startCircle = lobbyCircles[Math.floor(Math.random() * lobbyCircles.length)];
    mesh.position.set(
      startCircle.pos.x + (Math.random() - 0.5) * 3,
      0.95,
      startCircle.pos.z + (Math.random() - 0.5) * 3
    );
    scene.add(mesh);
    lobbyBots.push({ mesh, target: null, waitTimer: 1 + Math.random() * 4 });
  }
}

function updateLobbyBots(dt) {
  for (const nb of lobbyBots) {
    nb.waitTimer -= dt;
    if (!nb.target && nb.waitTimer <= 0) {
      const c = lobbyCircles[Math.floor(Math.random() * lobbyCircles.length)];
      nb.target = new THREE.Vector3(
        c.pos.x + (Math.random() - 0.5) * (LOBBY_CIRCLE_RADIUS * 1.2),
        0.95,
        c.pos.z + (Math.random() - 0.5) * (LOBBY_CIRCLE_RADIUS * 1.2)
      );
    }
    if (nb.target) {
      const to = new THREE.Vector3().subVectors(nb.target, nb.mesh.position);
      to.y = 0;
      if (to.lengthSq() > 0.05) {
        to.normalize().multiplyScalar(dt * 2.2);
        nb.mesh.position.add(to);
      } else {
        nb.target = null;
        nb.waitTimer = 2 + Math.random() * 5; // "vote" by staying a while
      }
    }
  }
  // recompute live headcounts (NPCs + the player, whichever circle each stands in)
  for (const c of lobbyCircles) c.count = 0;
  for (const nb of lobbyBots) {
    for (const c of lobbyCircles) {
      const dx = nb.mesh.position.x - c.pos.x, dz = nb.mesh.position.z - c.pos.z;
      if (Math.sqrt(dx * dx + dz * dz) < LOBBY_CIRCLE_RADIUS) { c.count++; break; }
    }
  }
  for (const c of lobbyCircles) c.countLabel.setText(`${c.count}명 대기중`);
}

function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15,15,20,0.75)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  const lines = text.split('\n');
  lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, 52 + i * 42));
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4, 2, 1);
  return sprite;
}

// A label sprite whose text can be redrawn in place (used for the live lobby headcount)
function makeDynamicLabel(text, bg) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3, 1.1, 1);
  function setText(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = bg || 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t, canvas.width / 2, 60);
    tex.needsUpdate = true;
  }
  setText(text);
  return { sprite, setText };
}

/* ------------------------------ MODE SELECT ------------------------------ */
function showModeSelect() {
  phase = 'MODE_SELECT';
  crosshair.style.display = 'none';
  resetNormalModeVisuals();
  hud.textContent = '';
  timerEl.textContent = '';
  towersEl.textContent = '';
  msgEl.textContent = '';
  cooldownFill.style.width = '0%';
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <h1>모드 선택</h1>
    <div style="display:flex; gap:20px; margin-top:10px;">
      <div id="modeNormal" class="item-btn" style="width:160px; height:140px; flex-direction:column;">
        <div style="font-size:20px; font-weight:bold;">일반</div>
        <div style="font-size:12px; opacity:0.8; margin-top:8px;">넓은 오두막집<br>총(사격)과 칼(찌르기/던지기)만</div>
      </div>
      <div id="modeVariant" class="item-btn" style="width:160px; height:140px; flex-direction:column;">
        <div style="font-size:20px; font-weight:bold;">변형</div>
        <div style="font-size:12px; opacity:0.8; margin-top:8px;">아이템, 탑, 팀 교체<br>5분 매치</div>
      </div>
      <div id="modeTag" class="item-btn" style="width:160px; height:140px; flex-direction:column;">
        <div style="font-size:20px; font-weight:bold;">술래잡기</div>
        <div style="font-size:12px; opacity:0.8; margin-top:8px;">20명, 의자 19개<br>술래에게 닿으면 탈락</div>
      </div>
      <div id="modeRedlight" class="item-btn" style="width:160px; height:140px; flex-direction:column;">
        <div style="font-size:20px; font-weight:bold;">무궁화 꽃</div>
        <div style="font-size:12px; opacity:0.8; margin-top:8px;">어두운 교실 탈출<br>빨간불에 움직이면 탈락</div>
      </div>
    </div>
  `;
  overlay.querySelector('#modeNormal').onclick = () => { gameMode = 'NORMAL'; startNormalMode(); };
  overlay.querySelector('#modeVariant').onclick = () => { gameMode = 'VARIANT'; showLobby(); };
  overlay.querySelector('#modeTag').onclick = () => { gameMode = 'TAG'; startTagMode(); };
  overlay.querySelector('#modeRedlight').onclick = () => { gameMode = 'REDLIGHT'; startRedlightMode(); };
}

/* ------------------------------ NORMAL MODE (총과 칼만 있는 단순 난투) ------------------------------ */
const NORMAL_BOUNDS = 33;
const NORMAL_BOT_COUNT = 8;

function buildCabin() {
  if (cabinGroup) scene.remove(cabinGroup);
  cabinGroup = new THREE.Group();
  collidables = [];
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b4423 });
  const size = 70, wallH = 10, wallT = 1;
  const walls = [
    { w: size, h: wallH, d: wallT, pos: [0, wallH / 2, -size / 2] },
    { w: size, h: wallH, d: wallT, pos: [0, wallH / 2, size / 2] },
    { w: wallT, h: wallH, d: size, pos: [-size / 2, wallH / 2, 0] },
    { w: wallT, h: wallH, d: size, pos: [size / 2, wallH / 2, 0] },
  ];
  walls.forEach(w => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.w, w.h, w.d), wallMat);
    mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
    cabinGroup.add(mesh);
    addCollidableBox(w.pos[0], w.pos[2], w.w / 2, w.d / 2);
  });

  // windows: light panels set into the outer walls
  const windowMat = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, emissive: 0x88ccee, emissiveIntensity: 0.4, transparent: true, opacity: 0.75 });
  const winSpots = [-24, 0, 24];
  winSpots.forEach(x => {
    const win = new THREE.Mesh(new THREE.BoxGeometry(5, 3.5, 0.15), windowMat);
    win.position.set(x, 5, -size / 2 - 0.1);
    cabinGroup.add(win);
    const win2 = win.clone();
    win2.position.set(x, 5, size / 2 + 0.1);
    cabinGroup.add(win2);
  });

  // divide the interior into a 3x3 grid of rooms, with a doorway through the
  // middle of each divider so every room connects to at least the center row/column
  const divMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a });
  const divPositions = [-size / 6, size / 6];
  const doorGap = 6;
  divPositions.forEach(pos => {
    // vertical divider (runs along Z, fixed X), split around a center doorway
    [[-size / 2, -doorGap / 2], [doorGap / 2, size / 2]].forEach(([from, to]) => {
      const len = to - from;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(wallT, wallH, len), divMat);
      seg.position.set(pos, wallH / 2, from + len / 2);
      cabinGroup.add(seg);
      addCollidableBox(pos, from + len / 2, wallT / 2, len / 2);
    });
    // horizontal divider (runs along X, fixed Z)
    [[-size / 2, -doorGap / 2], [doorGap / 2, size / 2]].forEach(([from, to]) => {
      const len = to - from;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len, wallH, wallT), divMat);
      seg.position.set(from + len / 2, wallH / 2, pos);
      cabinGroup.add(seg);
      addCollidableBox(from + len / 2, pos, len / 2, wallT / 2);
    });
  });

  // furnish each of the 9 rooms with a lamp, bed, chair, plus interior windows on
  // exterior-facing rooms already covered above
  const roomCenters = [-size / 3, 0, size / 3];
  roomCenters.forEach(rx => roomCenters.forEach(rz => addRoomFurniture(rx, rz)));

  scene.add(cabinGroup);
}

function addRoomFurniture(cx, cz) {
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
  const fabricMat = new THREE.MeshStandardMaterial({ color: 0x3a5f8a });
  const pillowMat = new THREE.MeshStandardMaterial({ color: 0xf0e6d2 });

  // bed: mattress + pillow, tucked in one corner
  const bed = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 6), fabricMat);
  bed.position.set(cx - 6, 0.4, cz - 6);
  cabinGroup.add(bed);
  const pillow = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 1.4), pillowMat);
  pillow.position.set(cx - 6, 0.85, cz - 8.7);
  cabinGroup.add(pillow);
  addCollidableBox(cx - 6, cz - 7, 2, 3.5);

  // chair: seat + backrest
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 1.4), woodMat);
  seat.position.set(cx + 6, 1, cz + 6);
  cabinGroup.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 0.15), woodMat);
  back.position.set(cx + 6, 1.7, cz + 6.65);
  cabinGroup.add(back);
  [-0.6, 0.6].forEach(dx => [-0.6, 0.6].forEach(dz => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1, 0.15), woodMat);
    leg.position.set(cx + 6 + dx, 0.5, cz + 6 + dz);
    cabinGroup.add(leg);
  }));
  addCollidableBox(cx + 6, cz + 6, 0.8, 0.8);

  // lamp: pole + glowing shade
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), woodMat);
  pole.position.set(cx + 7, 1.2, cz - 7);
  cabinGroup.add(pole);
  addCollidableBox(cx + 7, cz - 7, 0.3, 0.3);
  const shade = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 10, 10),
    new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffdd66, emissiveIntensity: 0.9 })
  );
  shade.position.set(cx + 7, 2.5, cz - 7);
  cabinGroup.add(shade);
}

let normalBots = [];
let playerHP = 100;
const PLAYER_MAX_HP = 100;

function spawnNormalBot() {
  const teamColor = 0xaa3333;
  const mesh = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x552222 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), bodyMat);
  mesh.add(body);
  const headMat = new THREE.MeshStandardMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 0.25 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 10), headMat);
  head.position.y = 0.95;
  mesh.add(head);
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xff3333, depthTest: false }));
  marker.scale.set(0.4, 0.4, 1);
  marker.position.y = 1.75;
  marker.renderOrder = 999;
  mesh.add(marker);

  // half the enemies carry a gun (keep their distance, shoot) and half a sword
  // (charge into melee) - a visible weapon model marks which
  const weaponType = Math.random() < 0.5 ? 'gun' : 'sword';
  let weaponMesh;
  if (weaponType === 'gun') {
    weaponMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x333333 })
    );
    weaponMesh.position.set(0.35, 0.5, 0.2);
  } else {
    weaponMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6 })
    );
    weaponMesh.position.set(0.35, 0.5, 0.2);
  }
  mesh.add(weaponMesh);

  // spawn somewhere visibly around the player, not lost in a far corner of the cabin
  const ang = Math.random() * Math.PI * 2;
  const dist = 12 + Math.random() * 15;
  const pos = new THREE.Vector3(camera.position.x + Math.cos(ang) * dist, 1, camera.position.z + Math.sin(ang) * dist);
  pos.x = Math.max(-32, Math.min(32, pos.x));
  pos.z = Math.max(-32, Math.min(32, pos.z));
  mesh.position.copy(pos);
  scene.add(mesh);
  const bot = {
    mesh, teamKey: 'enemy', alive: true, home: new THREE.Vector3(0, 1, 0),
    attackCooldown: 1 + Math.random(), weaponType,
    jumpVel: 0, jumpH: 0, jumpTimer: 1 + Math.random() * 2,
  };
  bots.push(bot);
  normalBots.push(bot);
  spawnClashFlash(pos, pos); // visible puff so a respawn is obvious, not just "a bot appeared somewhere"
  return bot;
}

function startNormalMode() {
  overlay.classList.add('hidden');
  crosshair.style.display = 'block';
  phase = 'NORMAL_PLAYING';

  for (const t of teams) if (t.towerGroup) scene.remove(t.towerGroup);
  teams = [];
  for (const b of bots) scene.remove(b.mesh);
  bots = [];
  normalBots = [];
  for (const d of dyingBots) scene.remove(d.mesh);
  dyingBots = [];
  duelers = [];

  floor.material.color.set(0xa0723c); // brown floor
  for (const b of obstacleBoxes) b.visible = false;
  buildCabin();

  camera.position.set(0, 1.7, 0);
  yaw = 0; pitch = 0;
  weapon = null;
  updateWeaponModels();
  normalScore = 0;
  playerHP = PLAYER_MAX_HP;
  msgLog = [];
  logMsg('일반 모드 시작! 1번: 총(발사), 2번: 칼(찌르기/던지기), M: 모드 선택으로');

  for (let i = 0; i < NORMAL_BOT_COUNT; i++) spawnNormalBot();
  requestPointerLock();
}

function normalBotRespawn() {
  setTimeout(() => {
    // cap total concurrent enemies so kills don't turn into a nonstop respawn treadmill
    if (phase === 'NORMAL_PLAYING' && normalBots.filter(b => b.alive).length < NORMAL_BOT_COUNT) {
      spawnNormalBot();
    }
  }, 6000);
}

function updateNormalHud() {
  hud.innerHTML = `
    모드: 일반<br>
    체력: ${Math.max(0, Math.round(playerHP))} / ${PLAYER_MAX_HP}<br>
    처치 수: ${normalScore}<br>
    무기: ${weapon === 'gun' ? '총 (좌클릭 발사)' : weapon === 'sword' ? '칼 (좌클릭 찌르기 / 우클릭 던지기) - 닿기만 해도 처치!' : '맨손'}<br>
    적: 총을 든 적은 거리를 두고 사격, 칼을 든 적은 근접해서 공격합니다<br>
    스페이스: 점프, C: 발차기
  `;
}

// Enemies actively engage the player instead of only wandering: sword-carriers
// charge into melee, gun-carriers hang back at range and shoot. While the
// player's sword is equipped, touching any enemy shatters them instantly.
const NORMAL_AGGRO_RANGE = 18;
const NORMAL_ATTACK_RANGE = 1.6;
const NORMAL_GUN_RANGE = 12;
function updateNormalCombat(dt) {
  for (const bot of normalBots) {
    if (!bot.alive) continue;

    // ninja-like hopping, so contact with the player (and shatter range) is less predictable
    bot.jumpTimer -= dt;
    if (bot.jumpTimer <= 0 && bot.jumpH <= 0.001) {
      bot.jumpVel = 4 + Math.random() * 2;
      bot.jumpTimer = 1 + Math.random() * 2.5;
    }
    bot.jumpVel -= 14 * dt;
    bot.jumpH = Math.max(0, bot.jumpH + bot.jumpVel * dt);
    if (bot.jumpH <= 0) { bot.jumpH = 0; bot.jumpVel = 0; }
    bot.mesh.position.y = 1 + bot.jumpH;

    const toPlayer = new THREE.Vector3().subVectors(camera.position, bot.mesh.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();

    if (weapon === 'sword' && dist < NORMAL_ATTACK_RANGE + 0.2) {
      shatterBot(bot);
      continue;
    }

    if (dist >= NORMAL_AGGRO_RANGE) { bot.duel = false; continue; }
    bot.duel = true; // reuse the "don't wander" flag while engaging

    if (bot.weaponType === 'gun') {
      // hold at range and shoot, rather than closing to melee
      if (dist > NORMAL_GUN_RANGE + 2) {
        toPlayer.normalize().multiplyScalar(dt * 2.2);
        bot.mesh.position.add(toPlayer);
      } else if (dist < NORMAL_GUN_RANGE - 2) {
        toPlayer.normalize().multiplyScalar(-dt * 1.5); // back off
        bot.mesh.position.add(toPlayer);
      }
      bot.attackCooldown -= dt;
      if (bot.attackCooldown <= 0) {
        bot.attackCooldown = 1.4;
        const from = bot.mesh.position.clone(); from.y = 1.4;
        const to = camera.position.clone();
        spawnTracer(from, to, 0xffee88);
        SFX.gunFire();
        playerHP = Math.max(0, playerHP - 6);
        if (playerHP <= 0) respawnPlayerNormal();
      }
    } else {
      if (dist > NORMAL_ATTACK_RANGE) {
        toPlayer.normalize().multiplyScalar(dt * 2.6);
        bot.mesh.position.add(toPlayer);
      } else {
        bot.attackCooldown -= dt;
        if (bot.attackCooldown <= 0) {
          bot.attackCooldown = 1;
          playerHP = Math.max(0, playerHP - 8);
          SFX.swordHit();
          if (playerHP <= 0) respawnPlayerNormal();
        }
      }
    }
  }
}

function respawnPlayerNormal() {
  playerHP = PLAYER_MAX_HP;
  camera.position.set(0, 1.7, 0);
  logMsg('쓰러졌다가 다시 일어났습니다!');
}

// "산산조각" - shatters into small flying debris pieces, distinct from the
// stun-then-die sword-swing kill
function shatterBot(bot) {
  if (!bot.alive) return;
  const pos = bot.mesh.position.clone();
  bot.alive = false;
  bot.duel = false;
  scene.remove(bot.mesh);
  SFX.swordHit();
  const shardMat = new THREE.MeshStandardMaterial({ color: 0x552222 });
  for (let i = 0; i < 8; i++) {
    const shard = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), shardMat);
    shard.position.copy(pos);
    shard.position.y = 1;
    scene.add(shard);
    const vel = new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 4 + 1, (Math.random() - 0.5) * 5);
    let t = 0;
    const fly = () => {
      t += 0.03;
      shard.position.addScaledVector(vel, 0.03);
      vel.y -= 0.25; // gravity
      shard.rotation.x += 0.3; shard.rotation.y += 0.2;
      if (t < 0.8) requestAnimationFrame(fly);
      else scene.remove(shard);
    };
    fly();
  }
  normalScore++;
  logMsg(`산산조각! (${normalScore})`);
  normalBotRespawn();
}

function resetNormalModeVisuals() {
  floor.material.color.set(0x9a9a9e);
  for (const b of obstacleBoxes) b.visible = true;
  if (cabinGroup) { scene.remove(cabinGroup); cabinGroup = null; }
  for (const b of normalBots) scene.remove(b.mesh);
  normalBots = [];
  bots = bots.filter(b => !b.mesh || b.teamKey !== 'enemy');
  collidables = [];
  resetTagModeVisuals();
  resetRedlightVisuals();
  scene.fog = new THREE.FogExp2(0xbfbfc2, 0.012);
  scene.background = new THREE.Color(0xbfbfc2);
}

/* ------------------------------ TAG MODE (술래잡기 + 매직 체어) ------------------------------ */
const TAG_CHAIR_COUNT = 19;
const TAG_BOT_COUNT = 19; // + the player = 20 participants total
const TAG_ARENA_RADIUS = 20;
let tagChairs = [];
let tagBots = [];
let taggerIsPlayer = false;
let taggerBot = null;
let playerSeated = false;
let playerEliminated = false;
let tagResultShown = false;
let tagPlate = null;
let plateSpinning = true;
let plateTimer = 0;
let playerCarrying = null; // a tagChairs entry, or null

function resetTagModeVisuals() {
  for (const c of tagChairs) scene.remove(c.mesh);
  tagChairs = [];
  for (const b of tagBots) scene.remove(b.mesh);
  tagBots = [];
  if (tagPlate) { scene.remove(tagPlate); tagPlate = null; }
  playerCarrying = null;
}

function buildChairMesh() {
  const g = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 1.4), woodMat);
  seat.position.y = 1;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 0.15), woodMat);
  back.position.set(0, 1.7, 0.65);
  g.add(back);
  [-0.6, 0.6].forEach(dx => [-0.6, 0.6].forEach(dz => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1, 0.15), woodMat);
    leg.position.set(dx, 0.5, dz);
    g.add(leg);
  }));
  return g;
}

function spawnTagBot() {
  const mesh = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x336699 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), bodyMat);
  mesh.add(body);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x3399ff, emissive: 0x224466, emissiveIntensity: 0.25 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 10), headMat);
  head.position.y = 0.95;
  mesh.add(head);
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x3399ff, depthTest: false }));
  marker.scale.set(0.4, 0.4, 1);
  marker.position.y = 1.75;
  marker.renderOrder = 999;
  mesh.add(marker);

  const ang = Math.random() * Math.PI * 2;
  const dist = 5 + Math.random() * (TAG_ARENA_RADIUS - 5);
  mesh.position.set(Math.cos(ang) * dist, 1, Math.sin(ang) * dist);
  scene.add(mesh);
  const bot = { mesh, body, bodyMat, marker, alive: true, seated: false, isTagger: false, wanderTimer: Math.random() * 2 };
  tagBots.push(bot);
  return bot;
}

function markBotAsTagger(bot) {
  bot.isTagger = true;
  bot.bodyMat.color.set(0xdd3311);
  bot.bodyMat.emissive.set(0x661100);
  bot.bodyMat.emissiveIntensity = 0.4;
  bot.marker.material.color.set(0xff3300);
}

function startTagMode() {
  overlay.classList.add('hidden');
  crosshair.style.display = 'block';
  phase = 'TAG_PLAYING';

  for (const t of teams) if (t.towerGroup) scene.remove(t.towerGroup);
  teams = [];
  for (const b of bots) scene.remove(b.mesh);
  bots = [];
  for (const d of dyingBots) scene.remove(d.mesh);
  dyingBots = [];
  duelers = [];
  if (cabinGroup) { scene.remove(cabinGroup); cabinGroup = null; }
  resetTagModeVisuals();

  floor.material.color.set(0x9a9a9e);
  for (const b of obstacleBoxes) b.visible = false;
  collidables = [];

  camera.position.set(0, 1.7, TAG_ARENA_RADIUS + 10);
  yaw = 0; pitch = 0; // face -Z, toward the chairs at the arena center
  weapon = null;
  updateWeaponModels();
  playerSeated = false;
  playerEliminated = false;
  tagResultShown = false;
  msgLog = [];

  // the spinning plate (turntable) at the arena center - chairs sit on its edge
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xaa7733, metalness: 0.3, roughness: 0.6 });
  tagPlate = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 0.4, 40), plateMat);
  tagPlate.position.y = 0.05;
  scene.add(tagPlate);
  plateSpinning = true;
  plateTimer = 5 + Math.random() * 3;

  // chairs in a ring at the center of the arena - each blocks movement while sitting
  // on the ground, but not while being carried (it follows its carrier instead)
  for (let i = 0; i < TAG_CHAIR_COUNT; i++) {
    const ang = (i / TAG_CHAIR_COUNT) * Math.PI * 2;
    const pos = new THREE.Vector3(Math.cos(ang) * 8, 0, Math.sin(ang) * 8);
    const mesh = buildChairMesh();
    mesh.position.copy(pos);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
    addCollidableBox(pos.x, pos.z, 0.8, 0.8);
    const box = collidables[collidables.length - 1];
    tagChairs.push({ mesh, pos, occupied: false, occupant: null, carriedBy: null, box });
  }

  playerCarrying = null;
  for (let i = 0; i < TAG_BOT_COUNT; i++) spawnTagBot();

  // randomly pick one of the 20 participants (player included) to be the tagger
  const pick = Math.floor(Math.random() * (TAG_BOT_COUNT + 1));
  if (pick === 0) {
    taggerIsPlayer = true;
    logMsg('당신이 술래입니다! 다른 참가자와 부딪히면 탈락시킵니다.');
  } else {
    taggerIsPlayer = false;
    taggerBot = tagBots[pick - 1];
    markBotAsTagger(taggerBot);
    logMsg('술래가 정해졌습니다! 의자를 E키로 들고 있다가, 판이 멈추면 자동으로 앉습니다.');
  }

  requestPointerLock();
}

function sitInNearbyChair() {
  if (taggerIsPlayer || playerSeated || playerEliminated) return;
  if (playerCarrying) {
    // put it back down wherever it currently is
    const chair = playerCarrying;
    chair.pos = chair.mesh.position.clone();
    if (chair.box) {
      chair.box.minX = chair.pos.x - 0.8; chair.box.maxX = chair.pos.x + 0.8;
      chair.box.minZ = chair.pos.z - 0.8; chair.box.maxZ = chair.pos.z + 0.8;
    }
    chair.carriedBy = null;
    playerCarrying = null;
    logMsg('의자를 내려놓았습니다.');
    return;
  }
  for (const chair of tagChairs) {
    if (chair.occupied || chair.carriedBy) continue;
    const dx = camera.position.x - chair.pos.x, dz = camera.position.z - chair.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) < 2.5) {
      chair.carriedBy = 'player';
      playerCarrying = chair;
      logMsg('의자를 들었습니다! 판이 멈추면 자동으로 앉습니다.');
      SFX.itemUse();
      return;
    }
  }
}

// when the spinning plate stops, everyone currently carrying a chair sits in it
function seatAllCarriers() {
  for (const chair of tagChairs) {
    if (!chair.carriedBy) continue;
    // sit right where they're standing when the plate stops, not back at the chair's
    // original spot - the chair mesh already tracks the carrier's current position
    chair.pos = chair.mesh.position.clone();
    if (chair.box) {
      chair.box.minX = chair.pos.x - 0.8; chair.box.maxX = chair.pos.x + 0.8;
      chair.box.minZ = chair.pos.z - 0.8; chair.box.maxZ = chair.pos.z + 0.8;
    }
    chair.occupied = true;
    chair.occupant = chair.carriedBy;
    if (chair.carriedBy === 'player') {
      playerSeated = true;
      playerCarrying = null;
      logMsg('판이 멈췄습니다! 의자에 앉아 안전해졌습니다.');
    } else {
      const bot = chair.carriedBy;
      bot.seated = true;
      bot.carryingChair = null;
      bot.mesh.position.set(chair.pos.x, 1, chair.pos.z);
    }
    chair.carriedBy = null;
  }
}

function eliminateTagBot(bot) {
  if (!bot.alive) return;
  bot.alive = false;
  scene.remove(bot.mesh);
  const chair = tagChairs.find(c => c.occupant === bot || c.carriedBy === bot);
  if (chair) { chair.occupied = false; chair.occupant = null; chair.carriedBy = null; }
}

function updateTagMode(dt) {
  if (tagResultShown) return;

  // the spinning plate: spins for a while, then briefly stops - anyone carrying a
  // chair at that instant sits down safely
  if (tagPlate) tagPlate.rotation.y += dt * (plateSpinning ? 3.2 : 0);
  plateTimer -= dt;
  if (plateTimer <= 0) {
    if (plateSpinning) {
      plateSpinning = false;
      plateTimer = 1.8;
      seatAllCarriers();
      SFX.matchStart();
      logMsg('판이 멈췄다!');
    } else {
      plateSpinning = true;
      plateTimer = 5 + Math.random() * 3;
      logMsg('판이 다시 돌아갑니다.');
    }
  }

  // carried chairs follow their carrier and stop blocking movement while carried
  for (const chair of tagChairs) {
    if (chair.box) chair.box.skip = !!chair.carriedBy;
    if (chair.carriedBy === 'player') {
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(-1);
      chair.mesh.position.set(camera.position.x + fwd.x * 1.2, 0, camera.position.z + fwd.z * 1.2);
    } else if (chair.carriedBy) {
      chair.mesh.position.set(chair.carriedBy.mesh.position.x, 0, chair.carriedBy.mesh.position.z);
    }
  }

  // player-controlled tagger: touching any unseated bot eliminates it
  if (taggerIsPlayer && !playerEliminated) {
    for (const bot of tagBots) {
      if (!bot.alive || bot.seated) continue;
      const dx = camera.position.x - bot.mesh.position.x, dz = camera.position.z - bot.mesh.position.z;
      if (Math.sqrt(dx * dx + dz * dz) < 1.5) {
        eliminateTagBot(bot);
        SFX.eliminate();
        logMsg('한 명을 탈락시켰습니다!');
      }
    }
  }

  for (const bot of tagBots) {
    if (!bot.alive) continue;

    if (bot.isTagger) {
      // chase the nearest unseated, un-eliminated target (player or another bot)
      let targetPos = null, targetIsPlayer = false, bestDist = Infinity;
      if (!taggerIsPlayer && !playerSeated && !playerEliminated) {
        const d = camera.position.distanceTo(bot.mesh.position);
        if (d < bestDist) { bestDist = d; targetPos = camera.position; targetIsPlayer = true; }
      }
      for (const other of tagBots) {
        if (other === bot || !other.alive || other.seated) continue;
        const d = other.mesh.position.distanceTo(bot.mesh.position);
        if (d < bestDist) { bestDist = d; targetPos = other.mesh.position; targetIsPlayer = false; }
      }
      if (targetPos) {
        const toTarget = new THREE.Vector3().subVectors(targetPos, bot.mesh.position);
        toTarget.y = 0;
        if (toTarget.length() > 1.4) {
          toTarget.normalize().multiplyScalar(dt * 3.4);
          bot.mesh.position.add(toTarget);
        } else if (targetIsPlayer) {
          playerEliminated = true;
          logMsg('술래에게 잡혔습니다... 탈락!');
          SFX.eliminate();
        } else {
          const caughtBot = tagBots.find(b => b.alive && !b.seated && b !== bot && b.mesh.position.distanceTo(bot.mesh.position) < 1.6);
          if (caughtBot) { eliminateTagBot(caughtBot); SFX.eliminate(); }
        }
      }
      continue;
    }

    if (bot.seated) continue;
    if (bot.carryingChair) continue; // holding a chair, waiting for the plate to stop

    // non-tagger bots go pick up the nearest available (unoccupied, uncarried) chair
    let nearestChair = null, nearestDist = Infinity;
    for (const chair of tagChairs) {
      if (chair.occupied || chair.carriedBy) continue;
      const d = chair.pos.distanceTo(bot.mesh.position);
      if (d < nearestDist) { nearestDist = d; nearestChair = chair; }
    }
    if (nearestChair) {
      if (nearestDist < 1.5) {
        nearestChair.carriedBy = bot;
        bot.carryingChair = nearestChair;
      } else {
        const toChair = new THREE.Vector3().subVectors(nearestChair.pos, bot.mesh.position);
        toChair.y = 0;
        toChair.normalize().multiplyScalar(dt * 2.4);
        bot.mesh.position.add(toChair);
      }
    }
  }

  // end condition: no unseated, un-eliminated non-tagger participants remain
  const stillStanding = tagBots.filter(b => b.alive && !b.seated && !b.isTagger).length
    + ((!taggerIsPlayer && !playerSeated && !playerEliminated) ? 1 : 0);
  if (stillStanding <= 0 || (taggerIsPlayer && playerEliminated)) {
    showTagResults();
  } else if (!taggerIsPlayer && playerEliminated) {
    showTagResults();
  }
}

function showTagResults() {
  if (tagResultShown) return;
  tagResultShown = true;
  matchRunning = false;
  document.exitPointerLock && document.exitPointerLock();
  const seatedCount = tagChairs.filter(c => c.occupied).length;
  const eliminatedCount = tagBots.filter(b => !b.alive).length;
  let playerLine;
  if (taggerIsPlayer) playerLine = `당신은 술래로 ${eliminatedCount}명을 탈락시켰습니다.`;
  else if (playerEliminated) playerLine = '당신은 술래에게 잡혀 탈락했습니다.';
  else if (playerSeated) playerLine = '당신은 의자에 앉아 생존했습니다!';
  else playerLine = '당신은 끝까지 살아남았습니다!';

  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <h1>게임 종료</h1>
    <p style="font-size:18px;">${playerLine}</p>
    <p>생존(의자 착석): ${seatedCount}명 / 탈락: ${eliminatedCount}명</p>
    <button id="tagAgainBtn" style="margin-top:16px; padding:10px 20px; font-size:16px;">모드 선택으로</button>
  `;
  overlay.querySelector('#tagAgainBtn').onclick = showModeSelect;
}

function updateTagHud() {
  const carryLine = taggerIsPlayer ? '' : playerCarrying ? 'E: 의자 내려놓기 (판이 멈추면 자동으로 앉습니다)<br>' : 'E: 근처 의자 들기<br>';
  hud.innerHTML = `
    모드: 술래잡기<br>
    역할: ${taggerIsPlayer ? '<b style="color:#ff5533">술래</b>' : (playerSeated ? '앉음(안전)' : playerEliminated ? '탈락' : playerCarrying ? '의자를 들고 있음' : '도망 중')}<br>
    판: ${plateSpinning ? '<b style="color:#ffcc44">빙글빙글 도는 중</b>' : '<b style="color:#33ff66">멈춤!</b>'}<br>
    ${carryLine}
    남은 의자: ${tagChairs.filter(c => !c.occupied && !c.carriedBy).length} / ${TAG_CHAIR_COUNT}
  `;
}

/* ------------------------------ RED LIGHT GREEN LIGHT (무궁화 꽃이 피었습니다) ------------------------------ */
const RL_CLASSROOM_LEN = 55;   // player starts at the back, doll/exit at the front
const RL_CLASSROOM_WIDE = 24;
const RL_MOVE_TOLERANCE = 0.08; // how far you can drift during red light before it counts as "moving"
let rlGroup = null;
let rlDoll = null;
let rlBots = [];
let rlLightGreen = true;
let rlTimer = 0;
let rlLastPos = null;
let rlEscaped = false;
let rlEliminated = false;
let rlResultShown = false;

function resetRedlightVisuals() {
  if (rlGroup) { scene.remove(rlGroup); rlGroup = null; }
  rlDoll = null;
  rlBots = [];
}

function buildClassmateMesh(color) {
  const mesh = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 8), new THREE.MeshStandardMaterial({ color }));
  mesh.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 8, 8), new THREE.MeshStandardMaterial({ color: 0xddc9a3 }));
  head.position.y = 0.9;
  mesh.add(head);
  return mesh;
}

function startRedlightMode() {
  overlay.classList.add('hidden');
  crosshair.style.display = 'block';
  phase = 'REDLIGHT_PLAYING';

  for (const t of teams) if (t.towerGroup) scene.remove(t.towerGroup);
  teams = [];
  for (const b of bots) scene.remove(b.mesh);
  bots = [];
  for (const d of dyingBots) scene.remove(d.mesh);
  dyingBots = [];
  duelers = [];
  resetRedlightVisuals();

  floor.material.color.set(0x151016);
  for (const b of obstacleBoxes) b.visible = false;
  collidables = [];
  scene.fog = new THREE.FogExp2(0x0a0810, 0.035);
  scene.background = new THREE.Color(0x0a0810);

  weapon = null;
  updateWeaponModels();
  rlLightGreen = true;
  rlTimer = 2.5 + Math.random() * 2;
  rlEscaped = false;
  rlEliminated = false;
  rlResultShown = false;
  msgLog = [];

  rlGroup = new THREE.Group();
  const darkWallMat = new THREE.MeshStandardMaterial({ color: 0x1c1620 });
  const wallH = 8;
  const walls = [
    { w: RL_CLASSROOM_WIDE, h: wallH, d: 1, pos: [0, wallH / 2, -RL_CLASSROOM_LEN / 2] },
    { w: RL_CLASSROOM_WIDE, h: wallH, d: 1, pos: [0, wallH / 2, RL_CLASSROOM_LEN / 2] },
    { w: 1, h: wallH, d: RL_CLASSROOM_LEN, pos: [-RL_CLASSROOM_WIDE / 2, wallH / 2, 0] },
    { w: 1, h: wallH, d: RL_CLASSROOM_LEN, pos: [RL_CLASSROOM_WIDE / 2, wallH / 2, 0] },
  ];
  walls.forEach(w => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.w, w.h, w.d), darkWallMat);
    mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
    rlGroup.add(mesh);
    addCollidableBox(w.pos[0], w.pos[2], w.w / 2, w.d / 2);
  });

  // rows of desks between the player's start and the doll at the front
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x2a2018 });
  for (let row = -1; row <= 4; row++) {
    for (let col = -3; col <= 3; col++) {
      if (col === 0) continue; // leave a center aisle
      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1, 1), deskMat);
      desk.position.set(col * 3, 0.5, row * 5);
      rlGroup.add(desk);
      addCollidableBox(col * 3, row * 5, 0.9, 0.6);
    }
  }

  // the doll, standing at the front facing away (green light)
  rlDoll = new THREE.Group();
  const dollBody = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 2.6, 12), new THREE.MeshStandardMaterial({ color: 0xffcc55 }));
  dollBody.position.y = 1.3;
  rlDoll.add(dollBody);
  const dollHead = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffe0b0 }));
  dollHead.position.y = 2.9;
  rlDoll.add(dollHead);
  rlDoll.position.set(0, 0, -RL_CLASSROOM_LEN / 2 + 3);
  rlDoll.rotation.y = Math.PI; // facing away from the player at first (green light)
  rlGroup.add(rlDoll);

  // dim flickering light near the doll, otherwise the room is nearly pitch black
  const dollLight = new THREE.PointLight(0xffaa66, 1.2, 20);
  dollLight.position.set(0, 3, -RL_CLASSROOM_LEN / 2 + 3);
  rlGroup.add(dollLight);

  // classmates trying to escape alongside the player
  for (let i = 0; i < 6; i++) {
    const mesh = buildClassmateMesh(new THREE.Color().setHSL(Math.random(), 0.3, 0.35));
    mesh.position.set((Math.random() - 0.5) * (RL_CLASSROOM_WIDE - 4), 1, RL_CLASSROOM_LEN / 2 - 4 - Math.random() * 6);
    rlGroup.add(mesh);
    rlBots.push({ mesh, alive: true, escaped: false });
  }

  scene.add(rlGroup);

  camera.position.set(0, 1.7, RL_CLASSROOM_LEN / 2 - 3);
  yaw = Math.PI; pitch = 0; // face -Z, toward the doll at the front
  rlLastPos = camera.position.clone();
  logMsg('무궁화 꽃이 피었습니다... 초록불엔 움직이고, 빨간불엔 멈추세요!');
  requestPointerLock();
}

function updateRedlightMode(dt) {
  if (rlResultShown) return;

  rlTimer -= dt;
  if (rlTimer <= 0) {
    rlLightGreen = !rlLightGreen;
    rlDoll.rotation.y = rlLightGreen ? Math.PI : 0; // faces the player during red light
    if (rlLightGreen) {
      rlTimer = 2.5 + Math.random() * 2.5;
      logMsg('무궁화 꽃이 피었습니다... (초록불)');
    } else {
      rlTimer = 1.8 + Math.random() * 1.7;
      rlLastPos.copy(camera.position);
      logMsg('정지! (빨간불)');
      SFX.matchStart();
    }
  }

  if (!rlLightGreen) {
    const moved = Math.hypot(camera.position.x - rlLastPos.x, camera.position.z - rlLastPos.z);
    if (moved > RL_MOVE_TOLERANCE) {
      rlEliminated = true;
      logMsg('들켰습니다... 탈락!');
      SFX.eliminate();
      showRedlightResults();
      return;
    }
  }
  rlLastPos.copy(camera.position);

  // classmates: shuffle toward the doll during green, freeze during red
  for (const bot of rlBots) {
    if (!bot.alive || bot.escaped) continue;
    if (rlLightGreen) {
      const toDoll = new THREE.Vector3(0 - bot.mesh.position.x, 0, rlDoll.position.z - bot.mesh.position.z);
      toDoll.y = 0;
      if (toDoll.length() > 1) {
        toDoll.normalize().multiplyScalar(dt * 1.8);
        bot.mesh.position.add(toDoll);
      }
    }
    if (bot.mesh.position.z < rlDoll.position.z + 3) {
      bot.escaped = true;
      scene.remove(bot.mesh);
    }
  }

  // reaching the doll's area = escaped
  if (camera.position.z < rlDoll.position.z + 3) {
    rlEscaped = true;
    showRedlightResults();
  }
}

function showRedlightResults() {
  if (rlResultShown) return;
  rlResultShown = true;
  document.exitPointerLock && document.exitPointerLock();
  const escapedFriends = rlBots.filter(b => b.escaped).length;
  const line = rlEscaped ? '탈출에 성공했습니다!' : '술래에게 들켜 탈락했습니다...';
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <h1>${rlEscaped ? '탈출 성공' : '게임 종료'}</h1>
    <p style="font-size:18px;">${line}</p>
    <p>함께 탈출한 친구: ${escapedFriends}명</p>
    <button id="rlAgainBtn" style="margin-top:16px; padding:10px 20px; font-size:16px;">모드 선택으로</button>
  `;
  overlay.querySelector('#rlAgainBtn').onclick = showModeSelect;
}

function updateRedlightHud() {
  hud.innerHTML = `
    모드: 무궁화 꽃이 피었습니다<br>
    신호: ${rlLightGreen ? '<b style="color:#33ff66">초록불 (이동 가능)</b>' : '<b style="color:#ff3333">빨간불 (정지!)</b>'}<br>
    남은 거리: ${Math.max(0, Math.round(camera.position.z - (rlDoll ? rlDoll.position.z + 3 : 0)))}m
  `;
}

function showLobby() {
  phase = 'LOBBY';
  crosshair.style.display = 'none';
  resetNormalModeVisuals();
  hud.textContent = '';
  timerEl.textContent = '';
  towersEl.textContent = '';
  msgEl.textContent = '이동: WASD, 시선: 마우스 — 원 안으로 걸어 들어가 방을 선택하세요.';
  cooldownFill.style.width = '0%';
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <h1>로비</h1>
    <p>클릭하여 시작한 뒤 WASD로 이동해 원하는 방의 원 안으로 걸어 들어가세요.</p>
    <p style="opacity:0.7;">파란 원 = 팀전, 노란 원 = 개인전(1/1) — 다른 대기 중인 플레이어 수가 원 위에 표시됩니다.</p>
  `;
  buildLobbyScene();
  for (const t of teams) { if (t.towerGroup) t.towerGroup.visible = false; }
  for (const b of bots) { b.mesh.visible = false; }
  playerObj = { pos: new THREE.Vector3(0, 1.7, 10), vel: new THREE.Vector3(), onGround: true };
  camera.position.copy(playerObj.pos);
  yaw = 0; pitch = 0; // face -Z, toward the circles (which sit at z=-10)
  document.removeEventListener('click', lobbyClickToStart);
  setTimeout(() => document.addEventListener('click', lobbyClickToStart), 0);
}
function lobbyClickToStart() {
  if (phase !== 'LOBBY') return;
  overlay.classList.add('hidden');
  requestPointerLock();
}

function updateLobby(dt) {
  updatePlayer(dt);
  updateLobbyBots(dt);
  for (const c of lobbyCircles) {
    const dx = camera.position.x - c.pos.x;
    const dz = camera.position.z - c.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) < LOBBY_CIRCLE_RADIUS) {
      document.removeEventListener('click', lobbyClickToStart);
      selectedRoom = c.room;
      scene.remove(lobbyGroup);
      for (const nb of lobbyBots) scene.remove(nb.mesh);
      lobbyBots = [];
      showItemSelect();
      break;
    }
  }
}

function showItemSelect() {
  phase = 'ITEM_SELECT';
  document.exitPointerLock && document.exitPointerLock();
  overlay.classList.remove('hidden');
  msgEl.textContent = '';
  overlay.innerHTML = `
    <h1>아이템 선택</h1>
    <p>${selectedRoom.label} - ${selectedRoom.team ? '팀전' : '개인전'}</p>
    <div id="itemList"></div>
    <p id="startHint" style="opacity:0.6;">아이템을 선택하면 게임이 시작됩니다.</p>
  `;
  const listEl = overlay.querySelector('#itemList');
  ITEM_KEYS.forEach(k => {
    const def = ITEM_DEFS[k];
    const div = document.createElement('div');
    div.className = 'item-btn';
    div.textContent = def.name;
    div.style.borderColor = '#' + def.color.toString(16).padStart(6, '0');
    div.onclick = () => { selectedItem = k; startMatch(); };
    listEl.appendChild(div);
  });
}

/* ------------------------------ MATCH SETUP ------------------------------ */
function startMatch() {
  overlay.classList.add('hidden');
  crosshair.style.display = 'block';

  // clear previous match objects
  for (const t of teams) {
    if (t.towerGroup) scene.remove(t.towerGroup);
  }
  for (const b of bots) scene.remove(b.mesh);
  bots = [];
  teams = [];
  if (playerObj && playerObj.mesh) scene.remove(playerObj.mesh);

  const teamSize = selectedRoom.size; // room size = players per team (always 7 teams, one per item)
  const activeKeys = ITEM_KEYS;
  const numTeams = activeKeys.length;
  const radius = 26; // close enough that all 7 towers' activity stays visible

  activeKeys.forEach((key, i) => {
    const ang = (i / numTeams) * Math.PI * 2;
    const def = ITEM_DEFS[key];
    const pos = new THREE.Vector3(Math.cos(ang) * radius, 0, Math.sin(ang) * radius);
    const team = {
      key, def, power: 100, floors: 1, alive: true,
      players: [], color: def.color,
      pos,
      doorAngle: Math.atan2(-pos.z, -pos.x), // door faces the arena center, reachable from spawn
    };
    team.towerGroup = new THREE.Group();
    team.towerGroup.position.copy(team.pos);
    team.towerGroup.lookAt(0, team.towerGroup.position.y, 0); // local -Z (the doorway gap) faces the arena center
    scene.add(team.towerGroup);
    buildTower(team);
    teams.push(team);

    const isPlayerTeam = key === selectedItem;
    const membersToSpawn = isPlayerTeam ? teamSize - 1 : teamSize;
    for (let m = 0; m < membersToSpawn; m++) {
      spawnBot(team);
    }
    if (isPlayerTeam) playerTeam = team;
  });

  // spawn player near own team's tower
  spawnPlayer(playerTeam.pos);

  matchTimeLeft = MATCH_SECONDS;
  matchRunning = true;
  itemCooldownLeft = 0;
  weapon = null;
  updateWeaponModels();
  tornado.active = false;
  fireZone.active = false;
  snowTimeLeft = 0;
  botClashTimer = 4;
  for (const d of dyingBots) scene.remove(d.mesh);
  dyingBots = [];
  duelers = [];
  msgLog = [];
  logMsg(`매치 시작! 당신의 팀: ${playerTeam.def.name}`);
  SFX.matchStart();
  requestPointerLock();
}

function buildTower(team) {
  while (team.towerGroup.children.length > 0) {
    team.towerGroup.remove(team.towerGroup.children[0]);
  }
  const mat = new THREE.MeshStandardMaterial({ color: team.color });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, metalness: 0.4, roughness: 0.6 });
  const treadMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, metalness: 0.5, roughness: 0.5 });

  // a wide floor plate for the spacious interior, with a glowing lava pit near the core
  const floorPlate = new THREE.Mesh(
    new THREE.CircleGeometry(TOWER_COLLISION_RADIUS - 0.3, 32),
    new THREE.MeshStandardMaterial({ color: 0x3a3a3e })
  );
  floorPlate.rotation.x = -Math.PI / 2;
  floorPlate.position.y = 0.02;
  team.towerGroup.add(floorPlate);

  const lava = new THREE.Mesh(
    new THREE.CircleGeometry(4, 24),
    new THREE.MeshStandardMaterial({ color: 0xff5522, emissive: 0xff3300, emissiveIntensity: 1.2 })
  );
  lava.rotation.x = -Math.PI / 2;
  lava.position.y = 0.04;
  team.towerGroup.add(lava);
  team.lavaMesh = lava;

  // a wide doorway frame marking the spacious entrance (local -Z, facing the arena center)
  const doorHalfW = Math.sin(DOOR_HALF_WIDTH) * TOWER_COLLISION_RADIUS;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, metalness: 0.3, roughness: 0.7 });
  [-doorHalfW, doorHalfW].forEach(xOff => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, 0.4), frameMat);
    post.position.set(xOff, 2, -TOWER_COLLISION_RADIUS);
    team.towerGroup.add(post);
  });
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorHalfW * 2 + 0.4, 0.4, 0.4), frameMat);
  lintel.position.set(0, 4, -TOWER_COLLISION_RADIUS);
  team.towerGroup.add(lintel);

  // caterpillar tread rails ringing the spacious interior's outer wall, height grows with floor count
  const towerHeight = team.floors * 2;
  const treadRing = 12;
  for (let i = 0; i < treadRing; i++) {
    const a = (i / treadRing) * Math.PI * 2;
    // leave a gap in the wall ring where the doorway is (local -Z, angle = PI)
    const angFromDoor = Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI));
    if (Math.abs(angFromDoor) < DOOR_HALF_WIDTH + 0.15) continue;
    const tx = Math.cos(a) * TOWER_COLLISION_RADIUS;
    const tz = Math.sin(a) * TOWER_COLLISION_RADIUS;
    const tread = new THREE.Mesh(new THREE.BoxGeometry(0.7, towerHeight, 1.4), treadMat);
    tread.position.set(tx, towerHeight / 2, tz);
    tread.lookAt(0, towerHeight / 2, 0);
    team.towerGroup.add(tread);
  }

  // factory floors, each with a small staircase up to the next floor
  for (let f = 0; f < team.floors; f++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), mat);
    box.position.y = f * 2 + 1;
    team.towerGroup.add(box);

    const stepCount = 4;
    for (let s = 0; s < stepCount; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 0.9), darkMat);
      step.position.set(2.3, f * 2 + (s + 1) * (2 / stepCount) - 0.15, 1.5 - s * 0.5);
      team.towerGroup.add(step);
    }
  }
}

function spawnBot(team) {
  const mesh = new THREE.Group();

  // darken pale team colors (ice/water/electric) so bots stand out against the gray sky/floor
  const bodyColor = new THREE.Color(team.color).multiplyScalar(0.55);
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), bodyMat);
  body.position.y = 0;
  mesh.add(body);

  // bright head so bots read as characters, not scenery
  const headMat = new THREE.MeshStandardMaterial({ color: team.color, emissive: team.color, emissiveIntensity: 0.25 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 10), headMat);
  head.position.y = 0.95;
  mesh.add(head);

  // always-visible marker above the head: colored green (ally) / red (enemy) and
  // kept up to date every frame, plus a floating "아군"/"적" text label, so it's
  // always obvious who's on your side even after a team-swap.
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x33ff55, depthTest: false }));
  marker.scale.set(0.4, 0.4, 1);
  marker.position.y = 1.75;
  marker.renderOrder = 999;
  mesh.add(marker);

  const label = makeTextSprite('아군');
  label.scale.set(1.2, 0.6, 1);
  label.position.y = 2.3;
  label.material.depthTest = false;
  label.renderOrder = 999;
  mesh.add(label);

  const offset = new THREE.Vector3((Math.random() - 0.5) * 10, 1, (Math.random() - 0.5) * 10);
  mesh.position.copy(team.pos).add(offset);
  mesh.position.y = 1;
  scene.add(mesh);
  const bot = { mesh, teamKey: team.key, wander: new THREE.Vector3().copy(mesh.position), alive: true, marker, label };
  bots.push(bot);
  team.players.push(bot);
}

function updateAllegianceMarkers() {
  if (gameMode !== 'VARIANT') return; // Normal mode bots are always shown as enemies (red), fixed at spawn
  for (const bot of bots) {
    if (!bot.alive) continue;
    const isAlly = bot.teamKey === playerTeam.key;
    bot.marker.material.color.set(isAlly ? 0x33ff55 : 0xff3333);
    if (bot.label.userData.allyText !== isAlly) {
      bot.label.userData.allyText = isAlly;
      const tex = makeTextSprite(isAlly ? '아군' : '적').material.map;
      bot.label.material.map.dispose();
      bot.label.material.map = tex;
      bot.label.material.needsUpdate = true;
    }
  }
}

function spawnPlayer(nearPos) {
  // spawn a bit toward the arena center so we don't clip into our own tower
  const toCenter = new THREE.Vector3(-nearPos.x, 0, -nearPos.z).normalize();
  const spawnPos = new THREE.Vector3(nearPos.x, 1.7, nearPos.z).addScaledVector(toCenter, 8);
  playerObj = { pos: spawnPos, vel: new THREE.Vector3(), onGround: true };
  camera.position.copy(playerObj.pos);
  yaw = Math.atan2(toCenter.x, toCenter.z) + Math.PI;
  pitch = 0;
}

/* ------------------------------ INPUT ------------------------------ */
function isPlayingPhase() { return phase === 'PLAYING' || phase === 'NORMAL_PLAYING' || phase === 'TAG_PLAYING' || phase === 'REDLIGHT_PLAYING'; }

window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); // stop page scroll
  if (e.code === 'KeyM' && (phase === 'NORMAL_PLAYING' || phase === 'TAG_PLAYING' || phase === 'REDLIGHT_PLAYING' || phase === 'LOBBY')) {
    document.exitPointerLock && document.exitPointerLock();
    showModeSelect();
    return;
  }
  if (!isPlayingPhase()) return;
  if (phase === 'TAG_PLAYING') {
    if (e.code === 'KeyE') sitInNearbyChair();
    return;
  }
  if (e.code === 'Digit1') toggleWeapon('gun');
  if (e.code === 'Digit2') toggleWeapon('sword');
  if (e.code === 'Enter') useItem();
  if (e.code === 'KeyX' && weapon === 'sword') suicide();
  if (e.code === 'KeyC' && !e.repeat) performKick();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

document.addEventListener('click', () => {
  if (isPlayingPhase() && !pointerLocked) requestPointerLock();
});
function requestPointerLock() {
  renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock();
}
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', (e) => {
  if (!isPlayingPhase() && phase !== 'LOBBY') return;
  if (pointerLocked) {
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
    pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
  } else if (dragLooking) {
    // fallback look control for environments where pointer lock is unavailable
    // (e.g. the page opened directly as a file:// URL, or inside a sandboxed iframe)
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
    pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
    dragDistance += Math.abs(e.movementX) + Math.abs(e.movementY);
  }
});
let dragLooking = false;
let dragDistance = 0;
document.addEventListener('mousedown', (e) => {
  if ((isPlayingPhase() || phase === 'LOBBY') && !pointerLocked && e.button === 0) {
    dragLooking = true;
    dragDistance = 0;
  }
});
document.addEventListener('mouseup', (e) => {
  // Without pointer lock, the same left button both aims (drag) and fires, so only
  // treat it as a shot if the button was released without dragging the view first —
  // otherwise every shot fired at mousedown, before the player had aimed at all.
  if (isPlayingPhase() && !pointerLocked && e.button === 0 && dragLooking && dragDistance < 6) {
    fireWeaponPrimary();
  }
  dragLooking = false;
});
document.addEventListener('mousedown', (e) => {
  if (!isPlayingPhase()) return;
  if (pointerLocked && e.button === 0) fireWeaponPrimary();
  if (weapon === 'sword' && e.button === 2) swordThrow();
});
function fireWeaponPrimary() {
  if (weapon === 'gun') fireGun();
  else if (weapon === 'sword') swordThrust();
}
document.addEventListener('contextmenu', (e) => { if (isPlayingPhase()) e.preventDefault(); });

function toggleWeapon(w) {
  weapon = (weapon === w) ? null : w;
  updateWeaponModels();
}

let gunModel = null, swordModel = null;
function initWeaponModels() {
  gunModel = new THREE.Group();
  const gunBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.08, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x555555 })
  );
  gunModel.add(gunBody);
  gunModel.position.set(0.22, -0.2, -0.4);
  gunModel.visible = false;
  camera.add(gunModel);

  swordModel = new THREE.Group();
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.04, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.7 })
  );
  blade.position.z = -0.2;
  const hilt = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.06, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x442211 })
  );
  hilt.position.z = 0.1;
  swordModel.add(blade, hilt);
  swordModel.position.set(0.22, -0.2, -0.4);
  swordModel.visible = false;
  camera.add(swordModel);
}
function updateWeaponModels() {
  if (gunModel) gunModel.visible = weapon === 'gun';
  if (swordModel) swordModel.visible = weapon === 'sword';
}
let weaponKick = 0; // 0..1, decays each frame
function playWeaponKick() { weaponKick = 1; }
function updateWeaponKick(dt) {
  if (weaponKick <= 0) return;
  weaponKick = Math.max(0, weaponKick - dt * 6);
  const model = weapon === 'gun' ? gunModel : weapon === 'sword' ? swordModel : null;
  if (model) model.position.z = -0.4 + weaponKick * 0.15;
}

/* ------------------------------ COMBAT ------------------------------ */
function getForwardRay() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const ray = new THREE.Raycaster(camera.position, dir, 0.1, 200);
  ray.camera = camera; // required for raycasting against Sprites (ally/enemy markers)
  return ray;
}

function spawnTracer(start, end, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([start, end]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  setTimeout(() => { scene.remove(line); geo.dispose(); mat.dispose(); }, 120);
}

function spawnStuckKnife(point, dir) {
  const knife = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6 })
  );
  knife.position.copy(point);
  knife.lookAt(point.clone().add(dir));
  knife.rotateX(Math.PI / 2);
  scene.add(knife);
}

function findBotByHitObject(obj) {
  let o = obj;
  while (o) {
    const bot = bots.find(b => b.mesh === o);
    if (bot) return bot;
    o = o.parent;
  }
  return null;
}

function fireGun() {
  if (gameMode === 'VARIANT' && !playerTeam.alive) return;
  playWeaponKick();
  const ray = getForwardRay();
  ray.far = 200;
  const targets = bots.filter(b => b.alive).map(b => b.mesh);
  const hits = ray.intersectObjects(targets, true);
  const dir = ray.ray.direction.clone();
  if (hits.length > 0) {
    spawnTracer(camera.position, hits[0].point, 0xffee88);
    SFX.gunFire();
    const bot = findBotByHitObject(hits[0].object);
    if (bot) resolvePlayerHit(bot);
  } else {
    spawnTracer(camera.position, camera.position.clone().add(dir.multiplyScalar(200)), 0xffee88);
    SFX.gunMiss();
    logMsg('총알이 빗나갔습니다.');
  }
}

function swordThrust() {
  if (gameMode === 'VARIANT' && !playerTeam.alive) return;
  playWeaponKick();
  const ray = getForwardRay();
  ray.far = 2.5;
  const targets = bots.filter(b => b.alive).map(b => b.mesh);
  const objHits = ray.intersectObjects(scene.children.filter(o => o.userData.isObstacle));
  const hits = ray.intersectObjects(targets, true);
  if (hits.length > 0) {
    SFX.swordHit();
    const bot = findBotByHitObject(hits[0].object);
    if (bot) stunThenKill(bot);
  } else if (objHits.length > 0) {
    spawnStuckKnife(objHits[0].point, ray.ray.direction);
    SFX.swordWhiff();
    logMsg('칼이 물체에 꽂혔습니다.');
  } else {
    SFX.swordWhiff();
    logMsg('허공을 찔렀습니다.');
  }
}
function swordThrow() {
  if (gameMode === 'VARIANT' && !playerTeam.alive) return;
  const ray = getForwardRay();
  ray.far = 40;
  const targets = bots.filter(b => b.alive).map(b => b.mesh);
  const hits = ray.intersectObjects(targets, true);
  if (hits.length > 0) {
    SFX.swordHit();
    const bot = findBotByHitObject(hits[0].object);
    if (bot) stunThenKill(bot);
    logMsg('던진 칼이 명중했습니다!');
  } else {
    SFX.swordWhiff();
    logMsg('칼을 던졌지만 빗나갔습니다.');
  }
  weapon = null; // knife thrown away
  updateWeaponModels();
}

// A bare-handed flying kick - works with any weapon (or none) equipped, so a jump
// kick can finish off an enemy without needing to switch weapons mid-air.
function performKick() {
  if (!isPlayingPhase()) return;
  if (gameMode === 'VARIANT' && (!playerTeam || !playerTeam.alive)) return;
  const ray = getForwardRay();
  ray.far = 2.4;
  const targets = bots.filter(b => b.alive).map(b => b.mesh);
  const hits = ray.intersectObjects(targets, true);
  playWeaponKick();
  if (hits.length > 0) {
    SFX.swordHit();
    const bot = findBotByHitObject(hits[0].object);
    if (bot) {
      if (gameMode === 'NORMAL') shatterBot(bot);
      else stunThenKill(bot);
    }
    logMsg('발차기 명중!');
  } else {
    SFX.swordWhiff();
    logMsg('발차기가 빗나갔습니다.');
  }
}
function suicide() {
  if (gameMode !== 'VARIANT' || !playerTeam.alive) return;
  logMsg('스스로 목숨을 끊었습니다... 팀 전력이 급감합니다.');
  playerTeam.power = Math.max(0, playerTeam.power - 40);
  checkElimination(playerTeam);
}

function resolvePlayerHit(bot) {
  if (gameMode === 'NORMAL') {
    normalScore++;
    removeBot(bot);
    normalBotRespawn();
    logMsg(`처치! (${normalScore})`);
    return;
  }
  const targetTeam = teams.find(t => t.key === bot.teamKey);
  if (!targetTeam || targetTeam.key === playerTeam.key) return;
  clashTeams(playerTeam, targetTeam, true);
  // remove the specific bot hit either way (they were struck directly)
  removeBot(bot);
}

// Sword hits freeze the target in place for a beat before they die, instead of
// vanishing immediately like a gunshot.
function stunThenKill(bot) {
  if (!bot.alive || bot.stunned) return;
  bot.stunned = true;
  const flashMat = bot.mesh.children[0] && bot.mesh.children[0].material;
  const origEmissive = flashMat && flashMat.emissive ? flashMat.emissive.clone() : null;
  if (flashMat) { flashMat.emissive = new THREE.Color(0xffffff); flashMat.emissiveIntensity = 0.8; }
  setTimeout(() => {
    if (!bot.alive) return;
    resolvePlayerHit(bot);
  }, 700);
}

let dyingBots = []; // { mesh, t }

function removeBot(bot) {
  if (!bot.alive) return;
  bot.alive = false;
  dyingBots.push({ mesh: bot.mesh, t: 0 });
  const team = teams.find(t => t.key === bot.teamKey);
  if (team) team.players = team.players.filter(p => p !== bot);
}

function updateDyingBots(dt) {
  for (let i = dyingBots.length - 1; i >= 0; i--) {
    const d = dyingBots[i];
    d.t += dt;
    const s = Math.max(0, 1 - d.t / 0.4);
    d.mesh.scale.setScalar(s);
    d.mesh.position.y = Math.max(0.05, d.mesh.position.y - dt * 1.5);
    if (d.t >= 0.4) {
      scene.remove(d.mesh);
      dyingBots.splice(i, 1);
    }
  }
}

// A small sphere that flies from one tower to another over `duration` seconds, then pops.
function spawnProjectile(fromPos, toPos, color, duration, size) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(size || 0.6, 10, 10),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 })
  );
  const from = fromPos.clone(); from.y = 4;
  const to = toPos.clone(); to.y = 2;
  mesh.position.copy(from);
  scene.add(mesh);
  let t = 0;
  const step = () => {
    t += 0.045;
    const k = Math.min(1, t / duration);
    mesh.position.lerpVectors(from, to, k);
    mesh.position.y += Math.sin(k * Math.PI) * 3; // arc
    if (k < 1) requestAnimationFrame(step);
    else { scene.remove(mesh); spawnClashFlash(toPos, toPos); }
  };
  step();
}

// "전기 기운이 맴돌아" - a ring of electric sparks swirling around a tower
function spawnElectricSwirl(pos) {
  const group = new THREE.Group();
  group.position.set(pos.x, 3, pos.z);
  const sparkCount = 6;
  const sparks = [];
  for (let i = 0; i < sparkCount; i++) {
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff066 })
    );
    group.add(spark);
    sparks.push(spark);
  }
  scene.add(group);
  let t = 0;
  const duration = 1.2;
  const spin = () => {
    t += 0.04;
    sparks.forEach((s, i) => {
      const a = (i / sparkCount) * Math.PI * 2 + t * 8;
      s.position.set(Math.cos(a) * 3.4, Math.sin(t * 5 + i) * 0.6, Math.sin(a) * 3.4);
    });
    if (t < duration) requestAnimationFrame(spin);
    else scene.remove(group);
  };
  spin();
}

// "돌 두개가 굴러가" - rocks rolling along the ground instead of flying through the air
function spawnRollingRock(fromPos, toPos) {
  const mesh = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.55, 0),
    new THREE.MeshStandardMaterial({ color: 0x8a7a68 })
  );
  const from = fromPos.clone(); from.y = 0.5;
  const to = toPos.clone(); to.y = 0.5;
  mesh.position.copy(from);
  scene.add(mesh);
  const axis = new THREE.Vector3(to.z - from.z, 0, from.x - to.x).normalize();
  let t = 0;
  const duration = 1.1;
  const roll = () => {
    t += 0.045;
    const k = Math.min(1, t / duration);
    mesh.position.lerpVectors(from, to, k);
    mesh.rotateOnWorldAxis(axis, 0.5);
    if (k < 1) requestAnimationFrame(roll);
    else { scene.remove(mesh); spawnClashFlash(toPos, toPos); }
  };
  roll();
}

// "벌레들이 튀어나와 그 팀을 공격해" - a small swarm scattering toward the target
function spawnBugSwarm(fromPos, toPos) {
  const bugCount = 7;
  for (let i = 0; i < bugCount; i++) {
    const bug = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0x77aa33, emissive: 0x445511, emissiveIntensity: 0.5 })
    );
    const from = fromPos.clone();
    from.x += (Math.random() - 0.5) * 1.5;
    from.z += (Math.random() - 0.5) * 1.5;
    from.y = 0.6;
    const to = toPos.clone();
    to.x += (Math.random() - 0.5) * 2.5;
    to.z += (Math.random() - 0.5) * 2.5;
    to.y = 0.6;
    bug.position.copy(from);
    scene.add(bug);
    let t = 0;
    const duration = 0.6 + Math.random() * 0.4;
    const jitterSeed = Math.random() * 10;
    const flit = () => {
      t += 0.045;
      const k = Math.min(1, t / duration);
      bug.position.lerpVectors(from, to, k);
      bug.position.x += Math.sin(t * 20 + jitterSeed) * 0.15;
      bug.position.y += Math.abs(Math.sin(t * 25 + jitterSeed)) * 0.3;
      if (k < 1) requestAnimationFrame(flit);
      else scene.remove(bug);
    };
    flit();
  }
  spawnClashFlash(toPos, toPos);
}

// A rising, expanding burst of light at the caster's own tower the instant an
// item is activated, so "the effect being generated" is clearly visible before
// it travels anywhere.
function spawnCastBurst(pos, color) {
  const ringCount = 3;
  for (let i = 0; i < ringCount; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.6, 0.12, 8, 20),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pos.x, 0.5, pos.z);
    scene.add(ring);
    let t = 0;
    const delay = i * 0.12;
    const rise = () => {
      t += 0.045;
      const k = t - delay;
      if (k < 0) { requestAnimationFrame(rise); return; }
      ring.position.y = 0.5 + k * 4;
      ring.scale.setScalar(1 + k * 2.5);
      ring.material.opacity = Math.max(0, 0.9 - k * 1.1);
      if (k < 0.9) requestAnimationFrame(rise);
      else scene.remove(ring);
    };
    rise();
  }
  // a quick bright flash at ground level marking the moment of activation
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 12, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
  );
  flash.position.set(pos.x, 1, pos.z);
  scene.add(flash);
  let ft = 0;
  const fade = () => {
    ft += 0.05;
    flash.scale.setScalar(1 + ft * 3);
    flash.material.opacity = Math.max(0, 1 - ft * 2.5);
    if (ft < 0.4) requestAnimationFrame(fade);
    else scene.remove(flash);
  };
  fade();
}

function spawnClashFlash(posA, posB) {
  const mid = new THREE.Vector3().addVectors(posA, posB).multiplyScalar(0.5);
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 })
  );
  flash.position.copy(mid);
  flash.position.y = 3;
  scene.add(flash);
  let t = 0;
  const grow = () => {
    t += 0.05;
    flash.scale.setScalar(1 + t * 4);
    flash.material.opacity = Math.max(0, 0.8 - t * 1.6);
    if (t < 0.5) requestAnimationFrame(grow);
    else scene.remove(flash);
  };
  grow();
}

/* ------------------------------ TEAM CLASH / RANK LOGIC ------------------------------ */
function rankOf(teamKey) { return ITEM_DEFS[teamKey].rank; }

function clashTeams(teamA, teamB, fromPlayer) {
  if (!teamA.alive || !teamB.alive) return;
  if (!fromPlayer) spawnClashFlash(teamA.pos, teamB.pos);
  const rA = rankOf(teamA.key), rB = rankOf(teamB.key);
  let winner, loser;
  if (rA < rB) { winner = teamA; loser = teamB; }
  else if (rB < rA) { winner = teamB; loser = teamA; }
  else { winner = Math.random() < 0.5 ? teamA : teamB; loser = winner === teamA ? teamB : teamA; }

  const rankGap = Math.abs(rA - rB);
  if (loser.power <= ELIMINATE_THRESHOLD || rankGap >= 3) {
    eliminateTeam(loser);
    winner.floors += 1;
    buildTower(winner);
    logMsg(`${winner.def.name} 팀이 ${loser.def.name} 팀을 멸망시켰습니다! (탑 ${winner.floors}층)`);
  } else {
    // swap rosters between the two teams
    const tmpPlayers = winner.players; winner.players = loser.players; loser.players = tmpPlayers;
    for (const b of winner.players) b.teamKey = winner.key;
    for (const b of loser.players) b.teamKey = loser.key;
    winner.floors += 1;
    buildTower(winner);
    loser.power = Math.max(10, loser.power - 15);
    SFX.teamSwap();
    logMsg(`${winner.def.name} 팀이 ${loser.def.name} 팀을 이겨 팀이 교체되었습니다! (탑 ${winner.floors}층)`);
  }
}

function eliminateTeam(team) {
  team.alive = false;
  team.power = 0;
  for (const b of team.players) removeBot(b);
  team.players = [];
  SFX.eliminate();
  if (team === playerTeam) {
    logMsg('당신의 팀이 멸망했습니다! 관전 모드로 전환됩니다.');
  }
}

function checkElimination(team) {
  if (team.power <= 0 && team.alive) {
    // find strongest surviving rival to credit
    eliminateTeam(team);
  }
}

/* ------------------------------ ITEM USE ------------------------------ */
function useItem() {
  if (gameMode !== 'VARIANT' || itemCooldownLeft > 0 || !playerTeam.alive) return;
  itemCooldownLeft = ITEM_COOLDOWN;
  SFX.itemUse();
  spawnCastBurst(playerTeam.pos, playerTeam.color);
  const key = playerTeam.key;
  const others = teams.filter(t => t.alive && t.key !== key);
  switch (key) {
    case 'tornado': {
      tornado.active = true; tornado.timeLeft = 10; tornado.teamKey = key;
      const target = others[Math.floor(Math.random() * others.length)];
      if (target) {
        target.power = Math.max(0, target.power * 0.5);
        tornado.targetKey = target.key;
        logMsg(`${playerTeam.def.name} 팀이 대왕 토네이도를 일으켜 ${target.def.name} 팀 탑의 힘이 50% 감소했습니다!`);
        checkElimination(target);
      }
      break;
    }
    case 'electric': {
      others.forEach(t => {
        t.power = Math.max(0, t.power * 0.8);
        spawnElectricSwirl(t.pos);
        checkElimination(t);
      });
      logMsg(`${playerTeam.def.name} 팀이 감전 능력을 사용해 모든 팀의 힘을 20% 감소시켰습니다!`);
      break;
    }
    case 'ice': {
      snowTimeLeft = 10;
      if (tornado.active) {
        tornado.active = false;
        const tTeam = teams.find(t => t.key === tornado.teamKey);
        if (tTeam) { tTeam.power = Math.max(0, tTeam.power * 0.9); checkElimination(tTeam); }
        logMsg(`${playerTeam.def.name} 팀이 눈꽃으로 토네이도를 멈췄습니다! 토네이도 팀은 힘 10%를 잃었습니다.`);
      } else if (fireZone.active) {
        fireZone.active = false;
        const fTeam = teams.find(t => t.key === fireZone.teamKey);
        if (fTeam) { fTeam.power = Math.max(0, fTeam.power * 0.8); checkElimination(fTeam); }
        logMsg(`${playerTeam.def.name} 팀의 눈꽃이 활동을 멈추게 하여 상대 팀이 힘 20%를 잃었습니다.`);
      } else {
        logMsg(`${playerTeam.def.name} 팀이 눈꽃을 내리게 했습니다.`);
      }
      break;
    }
    case 'rock': {
      for (let i = 0; i < 2; i++) {
        const t = others[Math.floor(Math.random() * others.length)];
        if (t) {
          t.power = Math.max(0, t.power * 0.9);
          spawnRollingRock(playerTeam.pos, t.pos);
          checkElimination(t);
        }
      }
      logMsg(`${playerTeam.def.name} 팀이 돌 2개를 날려 다른 탑을 공격했습니다! (각 10% 감소)`);
      break;
    }
    case 'fire': {
      fireZone.active = true; fireZone.timeLeft = 8; fireZone.teamKey = key;
      logMsg(`${playerTeam.def.name} 팀이 중앙에 큰 불덩어리를 만들었습니다!`);
      break;
    }
    case 'water': {
      if (fireZone.active) {
        const fTeam = teams.find(t => t.key === fireZone.teamKey);
        if (fTeam) {
          fTeam.power = Math.max(0, fTeam.power * 0.7);
          spawnProjectile(playerTeam.pos, fTeam.pos, 0x3399ff, 0.5, 0.8);
          checkElimination(fTeam);
        }
        fireZone.active = false;
        logMsg(`${playerTeam.def.name} 팀이 물 10L를 불탑에 뿌려 불을 껐습니다! 불탑 힘 30% 감소.`);
      } else {
        logMsg('불이 없어 물을 사용했지만 효과가 없었습니다.');
      }
      break;
    }
    case 'bug': {
      const t = others[Math.floor(Math.random() * others.length)];
      if (t) {
        t.power = Math.max(0, t.power * 0.85);
        spawnBugSwarm(playerTeam.pos, t.pos);
        checkElimination(t);
      }
      logMsg(`${playerTeam.def.name} 팀이 벌레떼를 보내 ${t ? t.def.name : ''} 팀의 힘을 15% 감소시켰습니다!`);
      break;
    }
  }
  // if any other team uses an item while fire zone active (approximate with random chance for bot teams)
}

/* ------------------------------ BOT AI + PERIODIC CLASHES ------------------------------ */
let duelers = []; // { bot, home, phase:'approach'|'hold'|'return', t }

function updateBots(dt) {
  for (const bot of bots) {
    if (!bot.alive) continue;
    if (bot.duel || bot.stunned) continue; // handled by updateDuelers / frozen by a sword hit
    if (!bot.wanderTarget || bot.wanderTimer === undefined) bot.wanderTimer = 0;
    bot.wanderTimer -= dt;
    if (bot.wanderTimer <= 0) {
      bot.wanderTimer = 2 + Math.random() * 3;
      const team = teams.find(t => t.key === bot.teamKey);
      const home = bot.home || (team ? team.pos : bot.mesh.position);
      const spread = gameMode === 'NORMAL' ? 30 : 12;
      bot.wanderTarget = new THREE.Vector3(
        home.x + (Math.random() - 0.5) * spread,
        1,
        home.z + (Math.random() - 0.5) * spread
      );
    }
    const to = new THREE.Vector3().subVectors(bot.wanderTarget, bot.mesh.position);
    to.y = 0;
    if (to.lengthSq() > 0.04) {
      to.normalize().multiplyScalar(dt * 1.6);
      bot.mesh.position.add(to);
    }
  }
}

function updateBotClashes(dt) {
  botClashTimer -= dt;
  if (botClashTimer <= 0) {
    // fewer teams (2-team battles) clash more often so the fight stays active and visible
    botClashTimer = 4 + Math.random() * 3;
    const alive = teams.filter(t => t.alive);
    if (alive.length >= 2) {
      const a = alive[Math.floor(Math.random() * alive.length)];
      let b = alive[Math.floor(Math.random() * alive.length)];
      let tries = 0;
      while (b === a && tries++ < 5) b = alive[Math.floor(Math.random() * alive.length)];
      if (a !== b) startDuel(a, b);
    }
  }
}

function startDuel(teamA, teamB) {
  const mid = new THREE.Vector3().addVectors(teamA.pos, teamB.pos).multiplyScalar(0.5);
  const botA = teamA.players.find(b => b.alive && !b.duel);
  const botB = teamB.players.find(b => b.alive && !b.duel);
  const reps = [botA, botB].filter(Boolean);
  for (const bot of reps) {
    bot.duel = true;
    duelers.push({ bot, home: bot.mesh.position.clone(), mid: mid.clone(), phase: 'approach', t: 0 });
  }
  // resolve the actual clash once they've had time to "meet" (or immediately if no reps available)
  setTimeout(() => clashTeams(teamA, teamB, false), reps.length > 0 ? 900 : 0);
}

function updateDuelers(dt) {
  for (let i = duelers.length - 1; i >= 0; i--) {
    const d = duelers[i];
    if (!d.bot.alive) { duelers.splice(i, 1); continue; }
    d.t += dt;
    if (d.phase === 'approach') {
      const dur = 0.9;
      const k = Math.min(1, d.t / dur);
      d.bot.mesh.position.lerpVectors(d.home, d.mid, k);
      if (k >= 1) { d.phase = 'hold'; d.t = 0; }
    } else if (d.phase === 'hold') {
      if (d.t >= 0.4) { d.phase = 'return'; d.t = 0; }
    } else if (d.phase === 'return') {
      const dur = 0.9;
      const k = Math.min(1, d.t / dur);
      d.bot.mesh.position.lerpVectors(d.mid, d.home, k);
      if (k >= 1) { d.bot.duel = false; duelers.splice(i, 1); }
    }
  }
}

/* ------------------------------ TIMED EFFECTS ------------------------------ */
function updateTimedEffects(dt) {
  if (tornado.active) {
    tornado.timeLeft -= dt;
    if (tornado.timeLeft <= 0) tornado.active = false;
  }
  if (fireZone.active) {
    fireZone.timeLeft -= dt;
    if (fireZone.timeLeft <= 0) fireZone.active = false;
  }
  if (itemCooldownLeft > 0) itemCooldownLeft = Math.max(0, itemCooldownLeft - dt);
}

/* ------------------------------ PLAYER MOVEMENT ------------------------------ */
function updatePlayer(dt) {
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  const speed = 8;
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(-1);
  const right = new THREE.Vector3(forward.z, 0, -forward.x);
  const move = new THREE.Vector3();
  if (keys['KeyW'] || keys['ArrowUp']) move.add(forward);
  if (keys['KeyS'] || keys['ArrowDown']) move.sub(forward);
  if (keys['KeyA'] || keys['ArrowLeft']) move.sub(right);
  if (keys['KeyD'] || keys['ArrowRight']) move.add(right);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);

  // jump: a ninja-like hop, so you can close distance and kick over enemies' heads
  if (isPlayingPhase()) {
    if (keys['Space'] && jumpVel === 0 && jumpHeight <= 0.001) jumpVel = 6.5;
    jumpVel -= 16 * dt; // gravity
    jumpHeight = Math.max(0, jumpHeight + jumpVel * dt);
    if (jumpHeight <= 0) { jumpHeight = 0; jumpVel = 0; }
  }

  // simple bounds
  const bound = (phase === 'NORMAL_PLAYING' || phase === 'TAG_PLAYING' || phase === 'REDLIGHT_PLAYING') ? NORMAL_BOUNDS : 95;
  camera.position.x = Math.max(-bound, Math.min(bound, camera.position.x));
  camera.position.z = Math.max(-bound, Math.min(bound, camera.position.z));

  // walls, furniture, and chairs block movement instead of letting the player walk through them
  if (phase === 'NORMAL_PLAYING' || phase === 'TAG_PLAYING' || phase === 'REDLIGHT_PLAYING') pushOutOfCollidables(camera.position);

  // Team factory towers: solid on the outside, but each has a doorway (facing the
  // arena center) you can walk through, and walking toward the middle climbs the
  // stairs up to the top floor.
  playerClimb = 0;
  if (phase === 'PLAYING') {
    for (const team of teams) {
      if (!team.towerGroup || !team.towerGroup.visible) continue;
      const dx = camera.position.x - team.pos.x;
      const dz = camera.position.z - team.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= TOWER_COLLISION_RADIUS || dist <= 0.0001) continue;

      const angle = Math.atan2(dz, dx);
      const doorWorldAngle = Math.atan2(Math.sin(team.doorAngle), Math.cos(team.doorAngle));
      let angDiff = angle - doorWorldAngle;
      angDiff = Math.atan2(Math.sin(angDiff), Math.cos(angDiff)); // wrap to [-pi, pi]

      if (Math.abs(angDiff) < DOOR_HALF_WIDTH) {
        // inside the wide doorway: walking toward the tower's spacious core climbs the stairs
        playerClimb = Math.max(playerClimb, 1 - dist / TOWER_COLLISION_RADIUS);
      } else {
        const push = TOWER_COLLISION_RADIUS / dist;
        camera.position.x = team.pos.x + dx * push;
        camera.position.z = team.pos.z + dz * push;
      }
    }
  }
  camera.position.y = 1.7 + playerClimb * 12 + jumpHeight; // climb toward the top floor near the tower's core, plus any jump
}

/* ------------------------------ HUD ------------------------------ */
function logMsg(text) {
  msgLog.push(text);
  if (msgLog.length > 3) msgLog.shift();
  msgEl.innerHTML = msgLog.join('<br>');
}

function updateHud() {
  const min = Math.floor(matchTimeLeft / 60);
  const sec = Math.floor(matchTimeLeft % 60).toString().padStart(2, '0');
  timerEl.textContent = `${min}:${sec}`;

  hud.innerHTML = `
    내 팀: <b>${playerTeam.def.name}</b> (${playerTeam.alive ? '생존' : '멸망'}) — <span style="color:#33ff55">초록 = 아군</span> / <span style="color:#ff3333">빨강 = 적</span><br>
    아군 인원: ${playerTeam.players.length}명<br>
    팀 전력: ${Math.round(playerTeam.power)}%<br>
    탑 층수: ${playerTeam.floors}층<br>
    무기: ${weapon === 'gun' ? '총 (좌클릭 발사)' : weapon === 'sword' ? '칼 (좌클릭 찌르기 / 우클릭 던지기 / X 자살)' : '맨손'}<br>
    아이템: ${playerTeam.def.name} ${itemCooldownLeft > 0 ? `(재사용 ${itemCooldownLeft.toFixed(1)}s)` : '(Enter로 사용 가능)'}
  `;
  cooldownFill.style.width = `${100 - (itemCooldownLeft / ITEM_COOLDOWN) * 100}%`;

  const sorted = [...teams].sort((a, b) => b.floors - a.floors || b.power - a.power);
  towersEl.innerHTML = sorted.map(t =>
    `<span style="color:#${t.color.toString(16).padStart(6, '0')}">${t.def.name}</span>: ${t.floors}층 / ${Math.round(t.power)}% ${t.alive ? '' : '(멸망)'}`
  ).join('<br>');
}

/* ------------------------------ RESULTS ------------------------------ */
function endMatch() {
  matchRunning = false;
  SFX.matchEnd();
  document.exitPointerLock && document.exitPointerLock();
  const sorted = [...teams].sort((a, b) => b.floors - a.floors || b.power - a.power || rankOf(a.key) - rankOf(b.key));
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <h1>결과 발표</h1>
    <ol style="text-align:left; font-size:18px;">
      ${sorted.map(t => `<li>${t.def.name} — ${t.floors}층 / 전력 ${Math.round(t.power)}% ${t.alive ? '' : '(멸망)'}</li>`).join('')}
    </ol>
    <button id="againBtn" style="margin-top:16px; padding:10px 20px; font-size:16px;">로비로 돌아가기</button>
  `;
  overlay.querySelector('#againBtn').onclick = showLobby;
}

/* ------------------------------ MAIN LOOP ------------------------------ */
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (phase === 'LOBBY') {
    updateLobby(dt);
  }

  if (phase === 'PLAYING' && matchRunning) {
    updatePlayer(dt);
    updateBots(dt);
    updateBotClashes(dt);
    updateTimedEffects(dt);
    updateEffectMeshes(dt);
    updateDyingBots(dt);
    updateDuelers(dt);
    updateWeaponKick(dt);
    updateAllegianceMarkers();
    updateHud();

    matchTimeLeft -= dt;
    const aliveTeams = teams.filter(t => t.alive);
    if (matchTimeLeft <= 0 || aliveTeams.length <= 1) {
      matchTimeLeft = Math.max(0, matchTimeLeft);
      endMatch();
    }
  }

  if (phase === 'NORMAL_PLAYING') {
    updatePlayer(dt);
    updateNormalCombat(dt);
    updateBots(dt);
    updateDyingBots(dt);
    updateWeaponKick(dt);
    updateNormalHud();
  }

  if (phase === 'TAG_PLAYING') {
    updatePlayer(dt);
    updateTagMode(dt);
    updateTagHud();
  }

  if (phase === 'REDLIGHT_PLAYING') {
    updatePlayer(dt);
    updateRedlightMode(dt);
    updateRedlightHud();
  }

  renderer.render(scene, camera);
}

/* wire startMatch phase transition */
const _origStartMatch = startMatch;
startMatch = function () {
  _origStartMatch();
  phase = 'PLAYING';
};

initThree();
showModeSelect();
