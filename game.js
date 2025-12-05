const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const startBtn = document.getElementById('startBtn');
const restartBtn = document.getElementById('restartBtn');
const controlModeBtn = document.getElementById('controlModeBtn');
const scoreEl = document.getElementById('score');
const shieldEl = document.getElementById('shield');
const stateEl = document.getElementById('state');
const effectsEl = document.getElementById('effects');

const btnLeft  = document.getElementById('btnLeft');
const btnRight = document.getElementById('btnRight');
const btnBoost = document.getElementById('btnBoost');
const btnGhost = document.getElementById('btnGhost');
const btnPause = document.getElementById('btnPause');

const keys = {};
const touchControls = {
  left: false,
  right: false,
  boost: false
};

let game = null;
let lastTime = 0;

// режим керування: 'keyboard' | 'head'
let controlMode = 'keyboard';

// ---- Трекінг голови (MediaPipe FaceMesh) ----
let headYaw = 0;                 // "повертання" голови (вліво/вправо)
let headTrackingStarted = false;
let faceMeshInstance = null;
let cameraInstance = null;
let videoElement = null;

// ---- Жести очей/брів ----
let eyeLeftOpen = 1;
let eyeRightOpen = 1;
let lastSquintTime = 0;
let squintCooldown = 700; // мс між активаціями фантома
let browLifted = false;


// --- Калібрування брів ---
let mouthBaseline = null;
let mouthOpen = false;

// стабілізуючі пороги
const upperThreshold = 0.02;  // рот відкрився
const lowerThreshold = 0.01;  // рот точно закрився




// ініціалізація FaceMesh
function startHeadTracking() {
  if (headTrackingStarted) return;
  if (typeof FaceMesh === 'undefined') {
    console.warn('MediaPipe FaceMesh не завантажений');
    return;
  }

  // приховане відео з камери
  videoElement = document.createElement('video');
  videoElement.style.display = 'none';
  document.body.appendChild(videoElement);

  const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  faceMesh.onResults(onFaceResults);
  faceMeshInstance = faceMesh;

  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await faceMesh.send({image: videoElement});
    },
    width: 640,
    height: 480
  });
  camera.start();
  cameraInstance = camera;

  headTrackingStarted = true;
}

// допоміжні функції для очей / брів
function eyeOpenRatio(landmarks, topId, bottomId) {
  const top = landmarks[topId];
  const bottom = landmarks[bottomId];
  return Math.abs(top.y - bottom.y);
}

function eyebrowLiftAmount(landmarks, left) {
  // орієнтовні індекси
  const eyeId = left ? 159 : 386;
  const browId = left ? 70 : 300;
  const eye = landmarks[eyeId];
  const brow = landmarks[browId];
  // чим менше значення (більш негативне), тим брова вище
  return brow.y - eye.y;
}

// обробка результатів FaceMesh
function onFaceResults(results) {
  // Якщо керування клавіатурою – жести вимкнено
  if (controlMode !== "head") return;

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) return;
  const landmarks = results.multiFaceLandmarks[0];

  // ---------- ПОВОРОТ ГОЛОВОЮ ----------
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const nose = landmarks[1];

  const midEyesX = (leftEye.x + rightEye.x) / 2;
  headYaw = nose.x - midEyesX;


  // ----------- ВІДКРИВАННЯ РОТА (BOOST) ------------
  if (controlMode === "head") {
      const upperLip = landmarks[13].y;
      const lowerLip = landmarks[14].y;

      const mouthGap = lowerLip - upperLip;

      // Перше калібрування (рот закритий)
      if (mouthBaseline === null) {
          mouthBaseline = mouthGap;
          return;
      }

      // Плавне оновлення baseline — щоб враховувати невеликі рухи голови
      mouthBaseline = mouthBaseline * 0.95 + mouthGap * 0.05;

      const diff = mouthGap - mouthBaseline;

      // 📌 Гістерезис:
      if (!mouthOpen && diff > upperThreshold) {
          mouthOpen = true;     // рот справді відкрився
      }
      else if (mouthOpen && diff < lowerThreshold) {
          mouthOpen = false;    // рот повернувся в норму
      }
  } else {
      mouthOpen = false;
  }


  // ---------- ПРИЖМУРЕННЯ (GHOST) ----------
  const blinkL = Math.abs(landmarks[159].y - landmarks[145].y);
  const blinkR = Math.abs(landmarks[386].y - landmarks[374].y);

  const squintThreshold = 0.008;
  const now = performance.now();

  if (
    (blinkL < squintThreshold || blinkR < squintThreshold) &&
    now - lastSquintTime > squintCooldown
  ) {
    lastSquintTime = now;

    if (game && game.player && !game.player.ghost && game.player.ghostCooldown <= 0) {
      activateGhost();
    }
  }
}



// --------- Класи ---------
class Snake {
  constructor(x, y) {
    this.pos = { x, y };
    this.angle = 0;
    this.baseSpeed = 2.4;
    this.speed = this.baseSpeed;
    this.radius = 10;
    this.segments = [];
    this.length = 30;

    this.ghost = false;
    this.ghostCooldown = 0;
    this.ghostDurationMs = 2000;

    this.shield = 1;
  }

  update(dt) {
    if (this.ghostCooldown > 0) this.ghostCooldown -= dt;
    if (this.ghostCooldown < 0) this.ghostCooldown = 0;

    this.pos.x += Math.cos(this.angle) * this.speed;
    this.pos.y += Math.sin(this.angle) * this.speed;

    this.segments.unshift({ x: this.pos.x, y: this.pos.y });
    if (this.segments.length > this.length) {
      this.segments.pop();
    }
  }

  grow(amount = 10) {
    this.length += amount;
  }

  draw() {
    // гладке тіло
    ctx.lineWidth = this.radius * 2;
    ctx.strokeStyle = this.ghost ? '#a855f7' : '#22c55e';
    ctx.lineCap = 'round';

    ctx.beginPath();
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();

    // голова
    ctx.save();
    ctx.shadowColor = this.ghost ? '#a855f7' : '#4ade80';
    ctx.shadowBlur = 12;
    ctx.fillStyle = this.ghost ? '#a855f7' : '#22c55e';
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // очі
    const eyeAngle = this.angle;
    const ex = Math.cos(eyeAngle) * 6;
    const ey = Math.sin(eyeAngle) * 6;

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(this.pos.x + ex - 3, this.pos.y + ey, 2.5, 0, Math.PI * 2);
    ctx.arc(this.pos.x + ex + 3, this.pos.y + ey, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

class Enemy {
  constructor(x, y, speed = 1.6, radius = 14, color = '#ef4444', fast = false) {
    this.pos = { x, y };
    this.baseSpeed = speed;
    this.radius = radius;
    this.color = color;
    this.fast = fast;
  }

  update(player, slowFactor) {
    const a = Math.atan2(player.pos.y - this.pos.y, player.pos.x - this.pos.x);
    const sp = this.baseSpeed * slowFactor;
    this.pos.x += Math.cos(a) * sp;
    this.pos.y += Math.sin(a) * sp;
  }

  draw() {
    const pulse = Math.sin(performance.now() / 200) * 2;
    const grad = ctx.createRadialGradient(
      this.pos.x, this.pos.y, 4,
      this.pos.x, this.pos.y, this.radius + 4
    );
    grad.addColorStop(0, '#fecaca');
    grad.addColorStop(1, this.fast ? '#b91c1c' : '#991b1b');

    ctx.fillStyle = grad;
    ctx.save();
    ctx.shadowColor = this.fast ? '#fb7185' : '#ef4444';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius + pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(248,113,113,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

class Sniper {
  constructor(x, y) {
    this.pos = { x, y };
    this.radius = 14;
    this.cooldown = 0;
    this.cooldownMax = 120;
    this.angle = 0;
  }

  update(player) {
    this.cooldown--;
    this.angle = Math.atan2(player.pos.y - this.pos.y, player.pos.x - this.pos.x);
    if (this.cooldown <= 0) {
      game.bullets.push(new Bullet(this.pos.x, this.pos.y, player));
      this.cooldown = this.cooldownMax;
    }
  }

  draw() {
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(0, 0, this.radius + 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#4c1d95';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.rotate(this.angle);
    ctx.fillStyle = '#a855f7';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(0, -3, this.radius + 10, 6, 3);
      ctx.fill();
    } else {
      ctx.fillRect(0, -3, this.radius + 10, 6);
    }

    ctx.rotate(-this.angle);
    ctx.fillStyle = '#c4b5fd';
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

class Bullet {
  constructor(x, y, target) {
    this.pos = { x, y };
    const a = Math.atan2(target.pos.y - y, target.pos.x - x);
    this.dir = { x: Math.cos(a), y: Math.sin(a) };
    this.baseSpeed = 4;
    this.radius = 4;
    this.dead = false;
    this.angle = a;
  }

  update(slowFactor) {
    const sp = this.baseSpeed * slowFactor;
    this.pos.x += this.dir.x * sp;
    this.pos.y += this.dir.y * sp;
    if (
      this.pos.x < -20 || this.pos.x > canvas.width + 20 ||
      this.pos.y < -20 || this.pos.y > canvas.height + 20
    ) {
      this.dead = true;
    }
  }

  draw() {
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.angle);

    const grad = ctx.createLinearGradient(-14, 0, 4, 0);
    grad.addColorStop(0, 'rgba(129,140,248,0)');
    grad.addColorStop(1, '#ddd6fe');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-14, -3);
    ctx.lineTo(4, -1.5);
    ctx.lineTo(4, 1.5);
    ctx.lineTo(-14, 3);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#e5e7eb';
    ctx.beginPath();
    ctx.arc(4, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

class Mine {
  constructor(x, y) {
    this.pos = { x, y };
    this.radius = 14;
    this.explosionRadius = 52;
    this.dead = false;
  }

  update(player) {
    if (!player.ghost) {
      if (dist(player.pos, this.pos) < this.explosionRadius) {
        this.dead = true;
        handleHit('міна');
      }
    }
  }

  draw() {
    const x = this.pos.x;
    const y = this.pos.y;

    // --- Мʼяка зона вибуху ---
    ctx.strokeStyle = 'rgba(248,250,252,0.05)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, this.explosionRadius, 0, Math.PI * 2);
    ctx.stroke();

    // --- Неоновий glow навколо корпусу міни ---
    ctx.save();
    ctx.shadowColor = '#facc15';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#eab308';
    ctx.beginPath();
    ctx.arc(x, y, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- Внутрішній градієнтний диск ---
    const grad = ctx.createRadialGradient(
      x - 2, y - 2, 2,
      x, y, this.radius + 3
    );
    grad.addColorStop(0, '#fef9c3');
    grad.addColorStop(1, '#1f2937');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, this.radius - 1, 0, Math.PI * 2);
    ctx.fill();

    // --- Тонке жовте кільце по краю ---
    ctx.strokeStyle = 'rgba(250,204,21,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, this.radius - 3, 0, Math.PI * 2);
    ctx.stroke();

    // --- Центральна темна точка ---
    ctx.fillStyle = '#020617';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

class Food {
  constructor(x, y) {
    this.pos = { x, y };
    this.radius = 8;
  }

  draw() {
    const x = this.pos.x;
    const y = this.pos.y;

    // --- НЕОНОВЕ СВІТІННЯ ---
    ctx.save();
    ctx.shadowColor = '#facc15';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#eab308';
    ctx.beginPath();
    ctx.arc(x, y, this.radius + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- ГЛАДКИЙ ГРАДІЄНТ ЯБЛУКА ---
    const grad = ctx.createRadialGradient(
      x - 3, y - 3, 2,
      x, y, this.radius + 2
    );
    grad.addColorStop(0, '#fef9c3');
    grad.addColorStop(1, '#eab308');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, this.radius + 1, 0, Math.PI * 2);
    ctx.fill();

    // --- МІНІ-ЛИСТОК НАВЕРХУ ---
    ctx.fillStyle = '#16a34a';
    ctx.beginPath();
    ctx.ellipse(
      x - 3,
      y - this.radius,
      3, 5,
      -0.4, 0, Math.PI * 2
    );
    ctx.fill();
  }
}

// --------- Хелпери ---------
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function circleCollide(p1, r1, p2, r2) {
  return dist(p1, p2) < r1 + r2;
}

function randomPosAwayFrom(playerPos, minDist = 80) {
  let x, y, tries = 0;
  do {
    x = 40 + Math.random() * (canvas.width - 80);
    y = 40 + Math.random() * (canvas.height - 80);
    tries++;
  } while (tries < 50 && dist(playerPos, {x,y}) < minDist);
  return {x, y};
}

// --------- Ігровий стан ---------
function resetGame() {
  const player = new Snake(canvas.width / 2, canvas.height / 2 + 40);
  const foodPos = randomPosAwayFrom(player.pos, 120);

  game = {
    player,
    enemies: [],
    snipers: [],
    mines: [],
    bullets: [],
    food: new Food(foodPos.x, foodPos.y),
    score: 0,
    running: false,
    gameOver: false,
    paused: false,
  };

  updateUI();
  draw(0);
}

function startGame() {
  if (!game) resetGame();
  if (game.gameOver) resetGame();
  game.running = true;
  game.gameOver = false;
  game.paused = false;
  stateEl.textContent = 'У процесі';
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// базові вороги – плавний ріст
function desiredBaseEnemies(score) {
  if (score < 4) return 0;
  if (score < 8) return 1;
  if (score < 13) return 2;
  if (score < 19) return 3;
  return 4;
}

function spawnBaseEnemy(player) {
  const pos = randomPosAwayFrom(player.pos, 140);
  return new Enemy(pos.x, pos.y, 1.6, 14, '#ef4444', false);
}

function spawnFastEnemy(player) {
  const pos = randomPosAwayFrom(player.pos, 140);
  return new Enemy(pos.x, pos.y, 2.6, 9, '#ef4444', true);
}

function ensureBaseEnemies() {
  const desired = desiredBaseEnemies(game.score);
  const currentBase = game.enemies.filter(e => !e.fast);
  const diff = desired - currentBase.length;

  if (diff > 0) {
    for (let i = 0; i < diff; i++) {
      game.enemies.push(spawnBaseEnemy(game.player));
    }
  } else if (diff < 0) {
    for (let i = 0; i < Math.abs(diff); i++) {
      const idx = game.enemies.findIndex(e => !e.fast);
      if (idx >= 0) game.enemies.splice(idx, 1);
    }
  }
}

function spawnFood() {
  const pos = randomPosAwayFrom(game.player.pos, 100);
  game.food = new Food(pos.x, pos.y);
}

// --------- Update / Draw ---------
function loop(timestamp) {
  if (!game || !game.running) return;
  const dtMs = timestamp - lastTime;
  lastTime = timestamp;
  const dt = dtMs / 16.666;

  if (!game.paused) {
    update(dt);
  }
  draw(dt);

  if (game.running) requestAnimationFrame(loop);
}

function update(dt) {
  const p = game.player;

  // === Поворот ===
  if (controlMode === 'keyboard') {
    if (keys['KeyA'] || touchControls.left)  p.angle -= 0.06 * dt;
    if (keys['KeyD'] || touchControls.right) p.angle += 0.06 * dt;
  } else if (controlMode === 'head') {
    // headYaw ~ [-0.08, 0.08] приблизно
    const yaw = headYaw || 0;
    const deadZone = 0.01;       // щоб дрібний шум не крутив змійку
    const maxYaw = 0.08;         // середня чутливість (варіант B)
    if (Math.abs(yaw) > deadZone) {
      let normalized = yaw / maxYaw;          // ~[-1,1]
      if (normalized > 1) normalized = 1;
      if (normalized < -1) normalized = -1;
      const sensitivity = 1.2;               // трішки більше за 1 для комфортного повороту
      p.angle += normalized * 0.06 * dt * sensitivity;
    }
  }

  // Boost: E / мобільний / підняті брови (але тільки при керуванні головою)
  const boostByKeys = (keys['KeyE'] || touchControls.boost);
  const boostByMouth = (controlMode === 'head' && mouthOpen);

  const boostFactor = (boostByKeys || boostByMouth) ? 1.8 : 1;

  p.speed = p.baseSpeed * boostFactor;

  // Фантом по Q (клавіша) – додатково до прижмурення
  if (keys['KeyQ'] && !p.ghost && p.ghostCooldown <= 0) {
    activateGhost();
  }

  p.update(dt);

  const slowFactor = 1;
  game.enemies.forEach(e => e.update(p, slowFactor));
  game.snipers.forEach(s => s.update(p));
  game.mines.forEach(m => m.update(p));
  game.bullets.forEach(b => b.update(slowFactor));

  game.bullets = game.bullets.filter(b => !b.dead);
  game.mines = game.mines.filter(m => !m.dead);

  const margin = 10;
  if (
    p.pos.x < margin || p.pos.x > canvas.width - margin ||
    p.pos.y < margin || p.pos.y > canvas.height - margin
  ) {
    handleHit('стіна');
  }

  if (game.food && circleCollide(p.pos, p.radius, game.food.pos, game.food.radius)) {
    onFoodEat();
    spawnFood();
  }

  if (!p.ghost) {
    for (const e of game.enemies) {
      if (circleCollide(p.pos, p.radius, e.pos, e.radius)) {
        handleHit('ворог');
        break;
      }
    }
    for (const b of game.bullets) {
      if (circleCollide(p.pos, p.radius, b.pos, b.radius)) {
        b.dead = true;
        handleHit('куля');
        break;
      }
    }
  }

  ensureBaseEnemies();
  updateUI();
}

function draw(dt) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const bgGrad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  bgGrad.addColorStop(0, '#020617');
  bgGrad.addColorStop(1, '#020617');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

  if (!game) return;

  if (game.food) game.food.draw();
  game.mines.forEach(m => m.draw());
  game.enemies.forEach(e => e.draw());
  game.snipers.forEach(s => s.draw());
  game.bullets.forEach(b => b.draw());

  drawOrbs(game.player, game.score);
  game.player.draw();

  if (game.player.ghost) {
    ctx.fillStyle = 'rgba(88,28,135,0.22)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Екран паузи
  if (game.paused && !game.gameOver) {
    ctx.fillStyle = 'rgba(15,23,42,0.65)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#e5e7eb';
    ctx.textAlign = 'center';
    ctx.font = '28px system-ui';
    ctx.fillText('ПАУЗА', canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = '16px system-ui';
    ctx.fillText('Натисніть P або ⏸, щоб продовжити', canvas.width / 2, canvas.height / 2 + 20);
    return;
  }

  if (game.gameOver) {
    ctx.fillStyle = 'rgba(15,23,42,0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e5e7eb';
    ctx.textAlign = 'center';
    ctx.font = '28px system-ui';
    ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = '16px system-ui';
    ctx.fillText(`Рахунок: ${game.score}`, canvas.width / 2, canvas.height / 2 + 20);
    ctx.fillText('Натисни "Рестарт", щоб спробувати ще', canvas.width / 2, canvas.height / 2 + 46);
  }
}

// --------- Орби на тілі ---------
function orbCount(score) {
  return Math.min(score, 6);
}
function getOrbPoints(player, count) {
  if (count <= 0) return [];
  if (player.segments.length < 5) return [];

  const points = [];
  const step = Math.floor(player.segments.length / (count + 1));
  for (let i = 0; i < count; i++) {
    const index = (i + 1) * step;
    if (index < player.segments.length) {
      points.push(player.segments[index]);
    }
  }
  return points;
}
function drawOrbs(player, score) {
  const count = orbCount(score);
  const points = getOrbPoints(player, count);
  if (!points.length) return;

  ctx.save();
  points.forEach((seg, i) => {
    const alpha = 0.3 + i * 0.05;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(seg.x, seg.y, player.radius + 3, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();

    ctx.globalAlpha = alpha * 0.6;
    ctx.beginPath();
    ctx.arc(seg.x, seg.y, player.radius + 9, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80';
    ctx.fill();
  });
  ctx.restore();
  ctx.globalAlpha = 1;
}

// --------- Їжа (просте яблуко) ---------
function onFoodEat() {
  const p = game.player;
  game.score++;
  p.grow(10);

  // поетапне ускладнення
  if (game.score === 6) {         // перший снайпер
    const pos = randomPosAwayFrom(p.pos, 160);
    game.snipers.push(new Sniper(pos.x, pos.y));
  }

  if (game.score === 10) {        // перша міна
    const pos = randomPosAwayFrom(p.pos, 140);
    game.mines.push(new Mine(pos.x, pos.y));
  }

  if (game.score === 14) {        // перший швидкий ворог
    game.enemies.push(spawnFastEnemy(p));
  }

  if (game.score === 17) {        // друга міна
    const pos = randomPosAwayFrom(p.pos, 140);
    game.mines.push(new Mine(pos.x, pos.y));
  }

  if (game.score === 25) {        // третя міна
    const pos = randomPosAwayFrom(p.pos, 140);
    game.mines.push(new Mine(pos.x, pos.y));
  }

  if (game.score === 30) {        // друга пушка
    const pos = randomPosAwayFrom(p.pos, 160);
    game.snipers.push(new Sniper(pos.x, pos.y));
  }
}

// --------- Фантом / Хіти ---------
function activateGhost() {
  const p = game.player;
  p.ghost = true;
  p.ghostCooldown = 60;
  setTimeout(() => {
    p.ghost = false;
  }, p.ghostDurationMs);
}

function handleHit(source) {
  const p = game.player;
  if (p.shield > 0) {
    p.shield -= 1;
    p.pos.x += -Math.cos(p.angle) * 25;
    p.pos.y += -Math.sin(p.angle) * 25;
  } else {
    endGame(source);
  }
}

function endGame(reason) {
  if (!game || game.gameOver) return;
  game.running = false;
  game.gameOver = true;
  game.paused = false;
  stateEl.textContent = 'Кінець гри';
  setTimeout(() => {
    alert(`Гру закінчено (${reason}). Ваш рахунок: ${game.score}`);
  }, 50);
  updateUI();
}

// --------- UI ---------
function updateUI() {
  if (!game) return;
  scoreEl.textContent = game.score;
  shieldEl.textContent = game.player.shield;

  const effects = [];
  if (game.player.ghost) effects.push('Фантом');
  effectsEl.textContent = effects.length ? effects.join(', ') : '—';

  if (game.gameOver) {
    stateEl.textContent = 'Кінець гри';
  } else if (game.paused && game.running) {
    stateEl.textContent = 'Пауза';
  } else if (game.running) {
    stateEl.textContent = 'У процесі';
  } else {
    stateEl.textContent = 'Готово до старту';
  }
}

// --------- Події клавіатури ---------
window.addEventListener('keydown', (e) => {
  const code = e.code;
  keys[code] = true;

  // Пауза на P
  if (code === 'KeyP' && game && !game.gameOver) {
    game.paused = !game.paused;
    updateUI();
  }
});

window.addEventListener('keyup', (e) => {
  const code = e.code;
  keys[code] = false;
});

// --------- Кнопки старт/рестарт ---------
startBtn.addEventListener('click', startGame);
restartBtn.addEventListener('click', () => {
  resetGame();
});

// --------- Перемикач керування ---------
controlModeBtn.addEventListener('click', () => {
  if (controlMode === 'keyboard') {

    controlMode = 'head';
    controlModeBtn.textContent = 'Керування: Клавіатура';

    startHeadTracking();

    // Перекалібрувати брови через 0.5с після увімкнення камери
    setTimeout(() => {
      browBaseline = null;
      browSmoothCounter = 0;
      browLifted = false;
    }, 500);

  } else {

    controlMode = 'keyboard';
    controlModeBtn.textContent = 'Керування: Голова';

    // Повністю вимикаємо всі жести
    browLifted = false;
    browBaseline = null;
    browSmoothCounter = 0;
  }
});


// ---- Мобільні кнопки ----
function bindHoldButton(btn, onDown, onUp) {
  if (!btn) return;
  const start = (e) => {
    e.preventDefault();
    onDown();
  };
  const end = (e) => {
    e.preventDefault();
    onUp();
  };
  btn.addEventListener('touchstart', start);
  btn.addEventListener('touchend', end);
  btn.addEventListener('touchcancel', end);
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', end);
  btn.addEventListener('mouseleave', end);
}

// поворот
bindHoldButton(btnLeft,
  () => touchControls.left = true,
  () => touchControls.left = false
);
bindHoldButton(btnRight,
  () => touchControls.right = true,
  () => touchControls.right = false
);

// буст
bindHoldButton(btnBoost,
  () => touchControls.boost = true,
  () => touchControls.boost = false
);

// фантом (одноразово)
if (btnGhost) {
  btnGhost.addEventListener('click', (e) => {
    e.preventDefault();
    if (game && game.player && !game.player.ghost && game.player.ghostCooldown <= 0) {
      activateGhost();
    }
  });
}

// пауза (одноразово)
if (btnPause) {
  btnPause.addEventListener('click', (e) => {
    e.preventDefault();
    if (game && !game.gameOver) {
      game.paused = !game.paused;
      updateUI();
    }
  });
}

resetGame();
