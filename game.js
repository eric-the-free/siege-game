(() => {
  // ===== Canvas setup (retina-safe) =====
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  function resize() {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }
  window.addEventListener("resize", resize, { passive: true });
  resize();

  // ===== HUD =====
  const elLevel = document.getElementById("level");
  const elPower = document.getElementById("power");
  const elShots = document.getElementById("shots");
  const elDestroyed = document.getElementById("destroyed");

  // ===== Simple physics helpers =====
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const len = (x, y) => Math.hypot(x, y);

  // ===== World settings =====
  const G = 1200;                 // gravity (px/s^2)
  const AIR = 0.998;              // mild air drag per tick
  const RESTITUTION = 0.35;       // bounce off ground
  const FRICTION = 0.84;          // ground friction
  const DT_MAX = 1 / 30;

  // Ground (in CSS pixels)
  function groundY() { return window.innerHeight * 0.83; }

  // Cannon position
  function cannonPos() {
    return { x: window.innerWidth * 0.14, y: groundY() - 12 };
  }

  // ===== Game state =====
  let level = 1;
  let shots = 0;
  let powerMult = 1.0;

  let aiming = false;
  let aimStart = { x: 0, y: 0 };
  let aimNow = { x: 0, y: 0 };

  // Projectile
  let ball = null; // {x,y,vx,vy,r,alive,damage}

  // Blocks (simple AABB rectangles) with HP
  let blocks = []; // {x,y,w,h,hp,maxHp,mat,alive}
  let totalBlocks = 0;

  // ===== Materials =====
  const materials = {
    wood:   { hp:  90, color: "#b87a4b", score: 1.0 },
    stone:  { hp: 150, color: "#8b93a1", score: 1.3 },
    metal:  { hp: 220, color: "#6b7a8f", score: 1.6 },
    glass:  { hp:  45, color: "#7ad7ff", score: 0.8 },
  };

  // ===== Level generator (buildings/castles-ish) =====
  function rand(seed) {
    // deterministic-ish LCG per level
    let s = seed >>> 0;
    return () => (s = (1664525 * s + 1013904223) >>> 0) / 4294967296;
  }

  function makeLevel(n) {
    blocks = [];
    shots = 0;
    powerMult = 1.0 + (n - 1) * 0.08; // gets stronger each level
    ball = null;

    const r = rand(1337 + n * 999);
    const gy = groundY();
    const baseX = window.innerWidth * 0.55;
    const baseW = window.innerWidth * 0.38;

    // Choose theme: building / castle / stacked towers
    const themeRoll = r();
    const theme = themeRoll < 0.33 ? "castle" : themeRoll < 0.66 ? "city" : "towers";

    // Difficulty scaling
    const floors = clamp(3 + Math.floor(n * 0.35), 3, 9);
    const density = clamp(0.55 + n * 0.02, 0.55, 0.85);

    // Block sizes
    const bw = clamp(44 - Math.floor(n * 0.4), 26, 44);
    const bh = clamp(28 - Math.floor(n * 0.25), 18, 28);

    // Material mix gets tougher
    function pickMat() {
      const t = clamp(n / 18, 0, 1);
      const p = r();
      if (p < 0.10) return "glass";
      if (p < 0.58 - 0.18 * t) return "wood";
      if (p < 0.90 - 0.10 * t) return "stone";
      return "metal";
    }

    function addBlock(x, y, w, h, mat) {
      const m = materials[mat];
      blocks.push({
        x, y, w, h,
        hp: m.hp,
        maxHp: m.hp,
        mat,
        alive: true
      });
    }

    // Build layouts
    if (theme === "city") {
      // Several buildings of varying height
      const buildings = 3 + Math.floor(r() * 3);
      for (let b = 0; b < buildings; b++) {
        const bx = baseX + (b / buildings) * baseW + (r() * 20 - 10);
        const widthBlocks = 3 + Math.floor(r() * 4);
        const heightBlocks = clamp(2 + Math.floor(r() * floors), 2, floors);
        for (let y = 0; y < heightBlocks; y++) {
          for (let x = 0; x < widthBlocks; x++) {
            if (r() > density) continue;
            addBlock(
              bx + x * (bw + 2),
              gy - (y + 1) * (bh + 2),
              bw, bh,
              pickMat()
            );
          }
        }
      }
    } else if (theme === "towers") {
      // Tall thin towers + a bridge
      const towers = 2 + Math.floor(r() * 2);
      const gap = baseW / (towers + 1);
      const topYs = [];
      for (let tIdx = 0; tIdx < towers; tIdx++) {
        const tx = baseX + gap * (tIdx + 1) + (r() * 18 - 9);
        const heightBlocks = clamp(4 + Math.floor(r() * floors), 4, floors);
        for (let y = 0; y < heightBlocks; y++) {
          for (let x = 0; x < 2; x++) {
            if (r() > density + 0.08) continue;
            addBlock(tx + x * (bw + 2), gy - (y + 1) * (bh + 2), bw, bh, pickMat());
          }
        }
        topYs.push(gy - heightBlocks * (bh + 2));
      }
      // bridge between first and last
      if (towers >= 2) {
        const bridgeY = Math.min(...topYs) - (bh + 8);
        const bridgeX = baseX + gap * 1.1;
        const bridgeBlocks = 9 + Math.floor(r() * 5);
        for (let i = 0; i < bridgeBlocks; i++) {
          if (r() > 0.75) continue;
          addBlock(bridgeX + i * (bw * 0.78), bridgeY, bw * 0.72, bh * 0.65, "wood");
        }
      }
    } else {
      // castle: walls + towers + battlements
      const wallHeight = clamp(3 + Math.floor(n * 0.18), 3, floors);
      const wallWidthBlocks = 10 + Math.floor(r() * 6);

      const startX = baseX + (r() * 20 - 10);
      for (let y = 0; y < wallHeight; y++) {
        for (let x = 0; x < wallWidthBlocks; x++) {
          if (r() > density) continue;
          addBlock(startX + x * (bw + 2), gy - (y + 1) * (bh + 2), bw, bh, y === wallHeight - 1 ? "stone" : pickMat());
        }
      }
      // towers
      const towerW = 3;
      const towerH = wallHeight + 2 + Math.floor(r() * 3);
      const tower1X = startX - (bw + 2) * 1.2;
      const tower2X = startX + (bw + 2) * (wallWidthBlocks - towerW + 0.2);
      [tower1X, tower2X].forEach((tx) => {
        for (let y = 0; y < towerH; y++) {
          for (let x = 0; x < towerW; x++) {
            if (r() > density + 0.05) continue;
            addBlock(tx + x * (bw + 2), gy - (y + 1) * (bh + 2), bw, bh, "stone");
          }
        }
        // battlements on top
        for (let i = 0; i < towerW; i++) {
          if (r() > 0.65) continue;
          addBlock(tx + i * (bw + 2), gy - (towerH + 1) * (bh + 2), bw, bh * 0.7, "wood");
        }
      });
    }

    // tiny "deco" blocks
    const deco = 6 + Math.floor(r() * 10);
    for (let i = 0; i < deco; i++) {
      if (r() > 0.55) continue;
      const x = baseX + r() * baseW;
      const y = gy - (1 + Math.floor(r() * (floors + 1))) * (bh + 2);
      addBlock(x, y, bw * 0.75, bh * 0.75, r() < 0.5 ? "glass" : "wood");
    }

    totalBlocks = blocks.length;
    syncHud();
  }

  function syncHud() {
    elLevel.textContent = String(level);
    elShots.textContent = String(shots);
    elPower.textContent = `${powerMult.toFixed(2)}x`;
    const destroyed = totalBlocks === 0 ? 0 : Math.round(100 * (1 - blocks.filter(b => b.alive).length / totalBlocks));
    elDestroyed.textContent = `${destroyed}%`;
  }

  // ===== Collision: circle vs AABB =====
  function circleRectCollision(cx, cy, r, rect) {
    const closestX = clamp(cx, rect.x, rect.x + rect.w);
    const closestY = clamp(cy, rect.y, rect.y + rect.h);
    const dx = cx - closestX;
    const dy = cy - closestY;
    const d2 = dx * dx + dy * dy;
    return d2 <= r * r ? { hit: true, dx, dy, closestX, closestY } : { hit: false };
  }

  // ===== Fire projectile =====
  function fire(fromX, fromY, toX, toY) {
    const dx = fromX - toX;
    const dy = fromY - toY;
    const drag = clamp(len(dx, dy), 0, 160);

    // direction from cannon to target (inverse of drag)
    const angle = Math.atan2(dy, dx);

    // base strength scales with level
    const base = 700;
    const speed = (base + drag * 6) * powerMult;

    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    const radius = clamp(14 + level * 0.25, 14, 22);
    const damage = (120 + drag * 1.4) * powerMult;

    ball = {
      x: fromX,
      y: fromY,
      vx, vy,
      r: radius,
      damage,
      alive: true,
      traveled: 0
    };

    shots += 1;
    syncHud();
  }

  // ===== Input (touch + mouse) =====
  function getPoint(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function onDown(e) {
    e.preventDefault();
    const p = getPoint(e);
    aiming = true;
    aimStart = p;
    aimNow = p;
  }
  function onMove(e) {
    if (!aiming) return;
    e.preventDefault();
    aimNow = getPoint(e);
  }
  function onUp(e) {
    if (!aiming) return;
    e.preventDefault();
    aiming = false;
    const { x, y } = cannonPos();

    // only allow firing if no active projectile (keeps it simple)
    if (!ball || !ball.alive) {
      fire(x, y, aimNow.x, aimNow.y);
    }
  }

  canvas.addEventListener("touchstart", onDown, { passive: false });
  canvas.addEventListener("touchmove", onMove, { passive: false });
  canvas.addEventListener("touchend", onUp, { passive: false });
  canvas.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  // Restart level
  document.getElementById("restart").addEventListener("click", () => {
    makeLevel(level);
  });

  // ===== Game loop =====
  let last = performance.now();
  function tick(now) {
    const dt = clamp((now - last) / 1000, 0, DT_MAX);
    last = now;

    update(dt);
    draw();

    requestAnimationFrame(tick);
  }

  function update(dt) {
    // Update projectile
    if (ball && ball.alive) {
      // Integrate
      ball.vy += G * dt;
      ball.vx *= AIR;
      ball.vy *= AIR;

      const oldX = ball.x;
      const oldY = ball.y;

      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      ball.traveled += len(ball.x - oldX, ball.y - oldY);

      // Ground collision
      const gy = groundY();
      if (ball.y + ball.r > gy) {
        ball.y = gy - ball.r;
        ball.vy = -ball.vy * RESTITUTION;
        ball.vx *= FRICTION;

        // Stop if it's basically done
        if (Math.abs(ball.vy) < 120 && Math.abs(ball.vx) < 90) {
          ball.alive = false;
        }
      }

      // Out of bounds
      if (ball.x < -200 || ball.x > window.innerWidth + 200 || ball.y > window.innerHeight + 300) {
        ball.alive = false;
      }

      // Collide with blocks
      for (const b of blocks) {
        if (!b.alive) continue;
        const hit = circleRectCollision(ball.x, ball.y, ball.r, b);
        if (!hit.hit) continue;

        // Damage is proportional to impact speed
        const speed = len(ball.vx, ball.vy);
        const dmg = ball.damage * (0.35 + clamp(speed / 1200, 0.0, 1.2));
        b.hp -= dmg;

        // Simple bounce response: reflect velocity on the axis of deeper penetration
        const overlapX = Math.min(Math.abs(ball.x - b.x), Math.abs(ball.x - (b.x + b.w)));
        const overlapY = Math.min(Math.abs(ball.y - b.y), Math.abs(ball.y - (b.y + b.h)));

        if (overlapX < overlapY) {
          ball.vx = -ball.vx * 0.55;
        } else {
          ball.vy = -ball.vy * 0.55;
        }

        // Slight energy loss
        ball.vx *= 0.92;
        ball.vy *= 0.92;

        // Break block
        if (b.hp <= 0) {
          b.alive = false;
        }

        // One block per frame is enough (keeps it stable)
        break;
      }

      // Win condition: mostly destroyed
      const aliveCount = blocks.filter(b => b.alive).length;
      const destroyedPct = totalBlocks ? (1 - aliveCount / totalBlocks) : 1;
      if (destroyedPct >= 0.85) {
        // advance after a short pause
        ball.alive = false;
        level += 1;
        makeLevel(level);
      }
    }

    syncHud();
  }

  function draw() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Background gradient sky
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#111a33");
    g.addColorStop(0.6, "#0d1020");
    g.addColorStop(1, "#090b12");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Ground
    const gy = groundY();
    ctx.fillStyle = "#1b2133";
    ctx.fillRect(0, gy, w, h - gy);

    // Cannon
    const c = cannonPos();
    // base
    ctx.fillStyle = "#222a40";
    ctx.fillRect(c.x - 26, c.y + 8, 52, 18);

    // barrel angle based on current aim (purely visual)
    let barrelAngle = -0.35;
    if (aiming) {
      const dx = c.x - aimNow.x;
      const dy = c.y - aimNow.y;
      barrelAngle = Math.atan2(dy, dx);
      barrelAngle = clamp(barrelAngle, -2.5, -0.05);
    }

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(barrelAngle);
    ctx.fillStyle = "#2f3a57";
    ctx.fillRect(0, -10, 62, 20);
    ctx.restore();

    // Aim line
    if (aiming && (!ball || !ball.alive)) {
      const dx = c.x - aimNow.x;
      const dy = c.y - aimNow.y;
      const drag = clamp(len(dx, dy), 0, 160);
      ctx.strokeStyle = `rgba(140, 200, 255, ${0.25 + drag / 320})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(aimNow.x, aimNow.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Power hint
      ctx.fillStyle = "rgba(233,238,252,0.85)";
      ctx.font = "14px -apple-system, system-ui, sans-serif";
      ctx.fillText(`pull: ${Math.round(drag)}  |  shot power: ${(powerMult).toFixed(2)}x`,
        c.x + 10, c.y - 18
      );
    }

    // Blocks
    for (const b of blocks) {
      if (!b.alive) continue;
      const mat = materials[b.mat];
      const hpPct = b.hp / b.maxHp;

      // main body
      ctx.fillStyle = mat.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);

      // outline
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x, b.y, b.w, b.h);

      // damage cracks bar (tiny HP indicator)
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(b.x, b.y + b.h - 5, b.w, 5);
      ctx.fillStyle = `rgba(120,255,140,${0.55})`;
      ctx.fillRect(b.x, b.y + b.h - 5, b.w * clamp(hpPct, 0, 1), 5);
    }

    // Projectile
    if (ball && ball.alive) {
      // shadow
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(ball.x + 8, groundY() + 12, ball.r * 0.85, ball.r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();

      // ball
      ctx.fillStyle = "#d7dde8";
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Start
  makeLevel(level);
  requestAnimationFrame(tick);
})();
