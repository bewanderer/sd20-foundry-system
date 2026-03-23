/**
 * Turn Indicator
 * Slow ash/ember particles that orbit and fade around the active combatant's token
 */

import { log, debug } from './utils.js';

let currentIndicator = null;

/**
 * Register turn indicator hooks
 */
export function registerTurnIndicator() {
  Hooks.on('updateCombat', (combat, changed) => {
    if ('turn' in changed || 'round' in changed) {
      updateTurnIndicator(combat);
    }
  });

  Hooks.on('createCombat', () => {});

  Hooks.on('deleteCombat', () => {
    clearTurnIndicator();
  });

  Hooks.on('canvasReady', () => {
    const combat = game.combat;
    if (combat?.started) {
      updateTurnIndicator(combat);
    }
  });

  log('Turn indicator registered');
}

function updateTurnIndicator(combat) {
  clearTurnIndicator();
  if (!combat?.started || !combat.combatant) return;

  const token = combat.combatant.token?.object;
  if (!token) return;

  startEmberAnimation(token);
  debug(`Turn indicator applied to ${token.name}`);
}

/**
 * A single ash/ember particle with irregular shape that orbits the token
 */
class Ember {
  constructor(cx, cy, halfW, halfH, dim) {
    this.graphics = new PIXI.Graphics();
    this.cx = cx;
    this.cy = cy;

    // Orbit parameters — distance from center along elliptical path
    this.angle = Math.random() * Math.PI * 2;
    this.orbitW = halfW + 2 + Math.random() * 6;
    this.orbitH = halfH + 2 + Math.random() * 6;
    // Slow orbit speed (radians/frame), randomized direction
    this.orbitSpeed = (0.003 + Math.random() * 0.005) * (Math.random() < 0.5 ? 1 : -1);
    // Slight upward drift
    this.driftY = -(0.03 + Math.random() * 0.08);
    this.driftX = 0;
    this.yOffset = 0;
    this.xOffset = 0;

    // Life & appearance
    this.life = 1.0;
    this.decay = 0.003 + Math.random() * 0.004;
    this.dim = dim; // if true, max opacity is 70%
    this.brightness = dim ? (0.4 + Math.random() * 0.3) : (0.7 + Math.random() * 0.3);

    // Irregular ash shape — random polygon points
    this.size = 1.0 + Math.random() * 2.2;
    this.numPoints = 4 + Math.floor(Math.random() * 4); // 4-7 vertices
    this.shape = [];
    for (let i = 0; i < this.numPoints; i++) {
      const a = (Math.PI * 2 * i) / this.numPoints;
      const r = 0.5 + Math.random() * 0.5; // radius variation 50-100%
      this.shape.push({ angle: a, radius: r });
    }
    // Slow rotation
    this.rotation = Math.random() * Math.PI * 2;
    this.rotSpeed = (Math.random() - 0.5) * 0.01;
  }

  update() {
    // Orbit around center
    this.angle += this.orbitSpeed;
    // Drift
    this.yOffset += this.driftY;
    this.xOffset += this.driftX;
    this.driftX += (Math.random() - 0.5) * 0.005;

    const x = this.cx + Math.cos(this.angle) * this.orbitW + this.xOffset;
    const y = this.cy + Math.sin(this.angle) * this.orbitH + this.yOffset;

    this.rotation += this.rotSpeed;
    this.life -= this.decay;
    if (this.life <= 0) return false;

    this.graphics.clear();

    const intensity = this.life * this.brightness;
    const maxAlpha = this.dim ? 0.7 : 1.0;
    const alpha = intensity * maxAlpha;

    // Color: bright gold → deep orange → dim red
    const r = 255;
    const g = Math.floor(180 * intensity + 40);
    const b = Math.floor(30 * intensity);
    const color = (r << 16) | (g << 8) | b;

    const s = this.size * (0.4 + 0.6 * this.life);

    // Soft glow
    this.graphics.beginFill(color, alpha * 0.2);
    this.graphics.drawCircle(x, y, s * 3);
    this.graphics.endFill();

    // Helper to draw the irregular ash polygon
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    const drawShape = () => {
      const first = this.shape[0];
      const fx = first.radius * s * Math.cos(first.angle);
      const fy = first.radius * s * Math.sin(first.angle);
      this.graphics.moveTo(x + fx * cos - fy * sin, y + fx * sin + fy * cos);
      for (let i = 1; i < this.shape.length; i++) {
        const pt = this.shape[i];
        const px = pt.radius * s * Math.cos(pt.angle);
        const py = pt.radius * s * Math.sin(pt.angle);
        this.graphics.lineTo(x + px * cos - py * sin, y + px * sin + py * cos);
      }
      this.graphics.closePath();
    };

    // Dark outline for visibility against any background
    this.graphics.lineStyle(1.5, 0x000000, alpha * 0.4);
    this.graphics.beginFill(0, 0);
    drawShape();
    this.graphics.endFill();

    // Filled ash shape
    this.graphics.lineStyle(0);
    this.graphics.beginFill(color, alpha * 0.85);
    drawShape();
    this.graphics.endFill();

    return true;
  }

  destroy() {
    this.graphics.destroy();
  }
}

/**
 * Start the ember animation on a token
 */
function startEmberAnimation(token) {
  if (!token || token._sd20TurnRing) return;

  const container = new PIXI.Container();
  token._sd20TurnRing = container;
  token.addChild(container);

  const cx = token.w / 2;
  const cy = token.h / 2;
  const halfW = token.w / 2 + 4;
  const halfH = token.h / 2 + 4;

  const EMBER_COUNT = 48; // 24 bright + 24 dim
  const SPAWN_INTERVAL = 3;
  const PAUSE_FRAMES = 60;

  let embers = [];
  let spawnedCount = 0;
  let spawnTimer = 0;
  let phase = 'spawning';
  let pauseTimer = 0;

  const animate = () => {
    if (!container || container.destroyed) return;

    if (phase === 'spawning') {
      spawnTimer++;
      if (spawnTimer >= SPAWN_INTERVAL && spawnedCount < EMBER_COUNT) {
        // Alternate bright and dim embers
        const dim = spawnedCount % 2 === 1;
        const ember = new Ember(cx, cy, halfW, halfH, dim);
        container.addChild(ember.graphics);
        embers.push(ember);
        spawnedCount++;
        spawnTimer = 0;
      }

      if (spawnedCount >= EMBER_COUNT) {
        phase = 'fading';
      }

      embers = embers.filter(ember => {
        const alive = ember.update();
        if (!alive) {
          container.removeChild(ember.graphics);
          ember.destroy();
        }
        return alive;
      });
    } else if (phase === 'fading') {
      embers = embers.filter(ember => {
        const alive = ember.update();
        if (!alive) {
          container.removeChild(ember.graphics);
          ember.destroy();
        }
        return alive;
      });

      if (embers.length === 0) {
        pauseTimer = 0;
        phase = 'pause';
      }
    } else if (phase === 'pause') {
      pauseTimer++;
      if (pauseTimer >= PAUSE_FRAMES) {
        spawnedCount = 0;
        spawnTimer = 0;
        phase = 'spawning';
      }
    }

    requestAnimationFrame(animate);
  };

  container._sd20AnimationId = requestAnimationFrame(animate);
  currentIndicator = { token };
}

/**
 * Clear the turn indicator
 */
function clearTurnIndicator() {
  if (!currentIndicator) return;
  const { token } = currentIndicator;

  if (token?._sd20TurnRing) {
    token._sd20TurnRing.destroy({ children: true });
    delete token._sd20TurnRing;
  }

  currentIndicator = null;
}

/**
 * Register turn indicator settings
 */
export function registerTurnIndicatorSettings() {
  // Reserved for future customization
}