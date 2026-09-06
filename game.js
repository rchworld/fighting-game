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

let phase = 'LOBBY';
let scene, camera, renderer, clock;
let floor, skyFog;
let teams = [];          // { key, def, power, floors, alive, players:[], color, towerMesh, towerGroup }
let playerTeam = null;
let playerObj = null;    // { mesh, vel, onGround, weapon, hp }
let bots = [];           // { mesh, teamKey, wanderTarget }
let keys = {};
let yaw = 0, pitch = 0;
let pointerLocked = false;
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

  // scattered dreamlike gray boxes
  for (let i = 0; i < 40; i++) {
    const s = 1 + Math.random() * 2;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(s, s, s),
      new THREE.MeshStandardMaterial({ color: 0xaaaaae })
    );
    const ang = Math.random() * Math.PI * 2;
    const rad = 10 + Math.random() * 70;
    box.position.set(Math.cos(ang) * rad, s / 2, Math.sin(ang) * rad);
    box.userData.isObstacle = true;
    scene.add(box);
  }

  clock = new THREE.Clock();
  initEffectMeshes();
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

function buildLobbyScene() {
  if (lobbyGroup) { scene.remove(lobbyGroup); }
  lobbyGroup = new THREE.Group();
  lobbyCircles = [];
  const spacing = 14;
  const startX = -((ROOMS.length - 1) * spacing) / 2;
  ROOMS.forEach((room, i) => {
    const pos = new THREE.Vector3(startX + i * spacing, 0.02, -10);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(LOBBY_CIRCLE_RADIUS - 0.15, LOBBY_CIRCLE_RADIUS, 48),
      new THREE.MeshBasicMaterial({ color: room.team ? 0x7fdcff : 0xffcf7f, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos);
    lobbyGroup.add(ring);

    const label = makeTextSprite(`${room.label}\n${room.team ? '팀전' : '개인전'}`);
    label.position.set(pos.x, 2.4, pos.z);
    lobbyGroup.add(label);

    lobbyCircles.push({ room, pos });
  });
  scene.add(lobbyGroup);
}

function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
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

function showLobby() {
  phase = 'LOBBY';
  crosshair.style.display = 'none';
  hud.textContent = '';
  timerEl.textContent = '';
  towersEl.textContent = '';
  msgEl.textContent = '이동: WASD, 시선: 마우스 — 원 안으로 걸어 들어가 방을 선택하세요.';
  cooldownFill.style.width = '0%';
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <h1>로비</h1>
    <p>클릭하여 시작한 뒤 WASD로 이동해 원하는 방의 원 안으로 걸어 들어가세요.</p>
    <p style="opacity:0.7;">파란 원 = 팀전, 노란 원 = 개인전(1/1)</p>
  `;
  buildLobbyScene();
  for (const t of teams) { if (t.towerGroup) t.towerGroup.visible = false; }
  for (const b of bots) { b.mesh.visible = false; }
  playerObj = { pos: new THREE.Vector3(0, 1.7, 10), vel: new THREE.Vector3(), onGround: true };
  camera.position.copy(playerObj.pos);
  yaw = Math.PI; pitch = 0;
  document.addEventListener('click', lobbyClickToStart);
}
function lobbyClickToStart() {
  if (phase !== 'LOBBY') return;
  overlay.classList.add('hidden');
  requestPointerLock();
}

function updateLobby(dt) {
  updatePlayer(dt);
  for (const c of lobbyCircles) {
    const dx = camera.position.x - c.pos.x;
    const dz = camera.position.z - c.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) < LOBBY_CIRCLE_RADIUS) {
      document.removeEventListener('click', lobbyClickToStart);
      selectedRoom = c.room;
      scene.remove(lobbyGroup);
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

  const teamSize = selectedRoom.size;
  const numTeams = ITEM_KEYS.length; // 7 teams, one per item type
  const radius = 45;

  ITEM_KEYS.forEach((key, i) => {
    const ang = (i / numTeams) * Math.PI * 2;
    const def = ITEM_DEFS[key];
    const team = {
      key, def, power: 100, floors: 1, alive: true,
      players: [], color: def.color,
      pos: new THREE.Vector3(Math.cos(ang) * radius, 0, Math.sin(ang) * radius),
    };
    team.towerGroup = new THREE.Group();
    team.towerGroup.position.copy(team.pos);
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
  tornado.active = false;
  fireZone.active = false;
  snowTimeLeft = 0;
  botClashTimer = 8;
  msgLog = [];
  logMsg(`매치 시작! 당신의 팀: ${playerTeam.def.name}`);
  requestPointerLock();
}

function buildTower(team) {
  while (team.towerGroup.children.length > 0) {
    team.towerGroup.remove(team.towerGroup.children[0]);
  }
  const mat = new THREE.MeshStandardMaterial({ color: team.color });
  for (let f = 0; f < team.floors; f++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), mat);
    box.position.y = f * 2 + 1;
    team.towerGroup.add(box);
  }
}

function spawnBot(team) {
  const mat = new THREE.MeshStandardMaterial({ color: team.color });
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), mat);
  const offset = new THREE.Vector3((Math.random() - 0.5) * 10, 1, (Math.random() - 0.5) * 10);
  mesh.position.copy(team.pos).add(offset);
  mesh.position.y = 1;
  scene.add(mesh);
  const bot = { mesh, teamKey: team.key, wander: new THREE.Vector3().copy(mesh.position), alive: true };
  bots.push(bot);
  team.players.push(bot);
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
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (phase !== 'PLAYING') return;
  if (e.code === 'Digit1') toggleWeapon('gun');
  if (e.code === 'Digit2') toggleWeapon('sword');
  if (e.code === 'Enter') useItem();
  if (e.code === 'KeyX' && weapon === 'sword') suicide();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

document.addEventListener('click', () => {
  if (phase === 'PLAYING' && !pointerLocked) requestPointerLock();
});
function requestPointerLock() {
  renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock();
}
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', (e) => {
  if (!pointerLocked || (phase !== 'PLAYING' && phase !== 'LOBBY')) return;
  yaw -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
});
document.addEventListener('mousedown', (e) => {
  if (phase !== 'PLAYING' || !pointerLocked) return;
  if (weapon === 'gun' && e.button === 0) fireGun();
  if (weapon === 'sword' && e.button === 0) swordThrust();
  if (weapon === 'sword' && e.button === 2) swordThrow();
});
document.addEventListener('contextmenu', (e) => { if (phase === 'PLAYING') e.preventDefault(); });

function toggleWeapon(w) {
  weapon = (weapon === w) ? null : w;
}

/* ------------------------------ COMBAT ------------------------------ */
function getForwardRay() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  return new THREE.Raycaster(camera.position, dir, 0.1, 200);
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

function fireGun() {
  const ray = getForwardRay();
  ray.far = 200;
  const targets = bots.filter(b => b.alive).map(b => b.mesh);
  const hits = ray.intersectObjects(targets, false);
  const dir = ray.ray.direction.clone();
  if (hits.length > 0) {
    spawnTracer(camera.position, hits[0].point, 0xffee88);
    const mesh = hits[0].object;
    const bot = bots.find(b => b.mesh === mesh);
    if (bot) resolvePlayerHit(bot);
  } else {
    spawnTracer(camera.position, camera.position.clone().add(dir.multiplyScalar(200)), 0xffee88);
    logMsg('총알이 빗나갔습니다.');
  }
}

function swordThrust() {
  const ray = getForwardRay();
  ray.far = 2.5;
  const targets = bots.filter(b => b.alive).map(b => b.mesh);
  const objHits = ray.intersectObjects(scene.children.filter(o => o.userData.isObstacle));
  const hits = ray.intersectObjects(targets, false);
  if (hits.length > 0) {
    const bot = bots.find(b => b.mesh === hits[0].object);
    if (bot) resolvePlayerHit(bot);
  } else if (objHits.length > 0) {
    spawnStuckKnife(objHits[0].point, ray.ray.direction);
    logMsg('칼이 물체에 꽂혔습니다.');
  } else {
    logMsg('허공을 찔렀습니다.');
  }
}
function swordThrow() {
  const ray = getForwardRay();
  ray.far = 40;
  const targets = bots.filter(b => b.alive).map(b => b.mesh);
  const hits = ray.intersectObjects(targets, false);
  if (hits.length > 0) {
    const bot = bots.find(b => b.mesh === hits[0].object);
    if (bot) resolvePlayerHit(bot);
    logMsg('던진 칼이 명중했습니다!');
  } else {
    logMsg('칼을 던졌지만 빗나갔습니다.');
  }
  weapon = null; // knife thrown away
}
function suicide() {
  logMsg('스스로 목숨을 끊었습니다... 팀 전력이 급감합니다.');
  playerTeam.power = Math.max(0, playerTeam.power - 40);
  checkElimination(playerTeam);
}

function resolvePlayerHit(bot) {
  const targetTeam = teams.find(t => t.key === bot.teamKey);
  if (!targetTeam || targetTeam.key === playerTeam.key) return;
  clashTeams(playerTeam, targetTeam, true);
  // remove the specific bot hit either way (they were struck directly)
  removeBot(bot);
}

function removeBot(bot) {
  bot.alive = false;
  scene.remove(bot.mesh);
  const team = teams.find(t => t.key === bot.teamKey);
  if (team) {
    team.players = team.players.filter(p => p !== bot);
    if (team.players.length === 0 && team.key !== playerTeam.key) {
      // no bots left, but keep team as "alive" flag governed by power/eliminate logic
    }
  }
}

/* ------------------------------ TEAM CLASH / RANK LOGIC ------------------------------ */
function rankOf(teamKey) { return ITEM_DEFS[teamKey].rank; }

function clashTeams(teamA, teamB, fromPlayer) {
  if (!teamA.alive || !teamB.alive) return;
  const rA = rankOf(teamA.key), rB = rankOf(teamB.key);
  let winner, loser;
  if (rA < rB) { winner = teamA; loser = teamB; }
  else if (rB < rA) { winner = teamB; loser = teamA; }
  else { winner = Math.random() < 0.5 ? teamA : teamB; loser = winner === teamA ? teamB : teamA; }

  if (loser.power <= ELIMINATE_THRESHOLD) {
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
    logMsg(`${winner.def.name} 팀이 ${loser.def.name} 팀을 이겨 팀이 교체되었습니다! (탑 ${winner.floors}층)`);
  }
}

function eliminateTeam(team) {
  team.alive = false;
  team.power = 0;
  for (const b of team.players) removeBot(b);
  team.players = [];
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
  if (itemCooldownLeft > 0 || !playerTeam.alive) return;
  itemCooldownLeft = ITEM_COOLDOWN;
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
      others.forEach(t => { t.power = Math.max(0, t.power * 0.8); checkElimination(t); });
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
        if (t) { t.power = Math.max(0, t.power * 0.9); checkElimination(t); }
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
        if (fTeam) { fTeam.power = Math.max(0, fTeam.power * 0.7); checkElimination(fTeam); }
        fireZone.active = false;
        logMsg(`${playerTeam.def.name} 팀이 물 10L를 불탑에 뿌려 불을 껐습니다! 불탑 힘 30% 감소.`);
      } else {
        logMsg('불이 없어 물을 사용했지만 효과가 없었습니다.');
      }
      break;
    }
    case 'bug': {
      const t = others[Math.floor(Math.random() * others.length)];
      if (t) { t.power = Math.max(0, t.power * 0.85); checkElimination(t); }
      logMsg(`${playerTeam.def.name} 팀이 벌레떼를 보내 ${t ? t.def.name : ''} 팀의 힘을 15% 감소시켰습니다!`);
      break;
    }
  }
  // if any other team uses an item while fire zone active (approximate with random chance for bot teams)
}

/* ------------------------------ BOT AI + PERIODIC CLASHES ------------------------------ */
function updateBots(dt) {
  for (const bot of bots) {
    if (!bot.alive) continue;
    bot.mesh.position.x += Math.sin(performance.now() * 0.0003 + bot.mesh.id) * dt * 0.3;
    bot.mesh.position.z += Math.cos(performance.now() * 0.00025 + bot.mesh.id) * dt * 0.3;
  }
}

function updateBotClashes(dt) {
  botClashTimer -= dt;
  if (botClashTimer <= 0) {
    botClashTimer = 10 + Math.random() * 6;
    const alive = teams.filter(t => t.alive);
    if (alive.length >= 2) {
      const a = alive[Math.floor(Math.random() * alive.length)];
      let b = alive[Math.floor(Math.random() * alive.length)];
      let tries = 0;
      while (b === a && tries++ < 5) b = alive[Math.floor(Math.random() * alive.length)];
      if (a !== b) clashTeams(a, b, false);
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
  if (keys['KeyW']) move.add(forward);
  if (keys['KeyS']) move.sub(forward);
  if (keys['KeyA']) move.sub(right);
  if (keys['KeyD']) move.add(right);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);
  camera.position.y = 1.7;

  // simple bounds
  camera.position.x = Math.max(-95, Math.min(95, camera.position.x));
  camera.position.z = Math.max(-95, Math.min(95, camera.position.z));
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
    내 팀: <b>${playerTeam.def.name}</b> (${playerTeam.alive ? '생존' : '멸망'})<br>
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

  if (phase === 'LOBBY' && pointerLocked) {
    updateLobby(dt);
  }

  if (phase === 'PLAYING' && matchRunning) {
    updatePlayer(dt);
    updateBots(dt);
    updateBotClashes(dt);
    updateTimedEffects(dt);
    updateEffectMeshes(dt);
    updateHud();

    matchTimeLeft -= dt;
    if (matchTimeLeft <= 0) {
      matchTimeLeft = 0;
      endMatch();
    }
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
showLobby();
