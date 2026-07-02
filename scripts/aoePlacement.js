/**
 * Batch D-rewrite: AoE placement widget.
 *
 * Pure PIXI overlay + PIXI stage event capture. No MeasuredTemplate preview.
 * Every frame during a drag we recompute cells via getHighlightedCells and
 * redraw the outline. Cell coverage the GM sees during drag is identical to
 * the coverage on commit.
 *
 * Shapes and phases:
 *
 *   Circle
 *     phase 1 (anchor): hover shows preview, left-click drops center
 *     phase 2 (size):   cursor distance = radius, left-click confirms
 *                       (skipped if minSize == maxSize)
 *
 *   Cone
 *     phase 1 (anchor): left-click drops apex
 *     phase 2 (angle+size): cursor angle + distance both from center, left-click confirms
 *
 *   Line
 *     phase 1 (anchor): left-click drops start
 *     phase 2 (endpoint): cursor position IS endpoint, left-click confirms
 *
 *   Square
 *     phase 1 (anchor):   left-click drops center
 *     phase 2 (size):     cursor distance = half-extent, rotation locked at 0, left-click locks size
 *     phase 3 (rotation): cursor angle = rotation, 45° snap (Shift = 1°), left-click confirms
 *
 * Universal:
 *   - Right-click once: back up one phase.
 *   - Right-click twice with no left-click between: full cancel.
 *   - Escape: full cancel.
 *   - No scroll wheel used.
 */

import { debug, log } from './utils.js';
import { getHighlightedCells } from './aoeGridHighlight.js';

const HIGHLIGHT_COLOR = 0xff6600;
const HIGHLIGHT_ALPHA = 0.28;
const HIGHLIGHT_BORDER_ALPHA = 0.75;
const HIGHLIGHT_BORDER_WIDTH = 2;
const OUTLINE_COLOR = 0xff6600;
const OUTLINE_ALPHA = 0.9;
const HANDLE_COLOR = 0xffffff;
const HANDLE_RADIUS = 6;
const SIZE_STEP_FT = 5;
const SQUARE_ROTATION_SNAP_DEG = 45;

function _snapToCellCenter(x, y) {
  const cell = canvas.grid.getOffset({ x, y });
  return canvas.grid.getCenterPoint({ i: cell.i, j: cell.j });
}

function _pxToFeet(px) {
  const gridPx = canvas.grid.size || 100;
  const gridDist = canvas.scene?.grid?.distance || 5;
  return (px / gridPx) * gridDist;
}

function _ftToPx(ft) {
  const gridPx = canvas.grid.size || 100;
  const gridDist = canvas.scene?.grid?.distance || 5;
  return (ft / gridDist) * gridPx;
}

function _clampSize(valueFt, scaleOpts) {
  const step = scaleOpts?.step || SIZE_STEP_FT;
  const snapped = Math.max(step, Math.round(valueFt / step) * step);
  if (!scaleOpts) return snapped;
  return Math.max(scaleOpts.minSize, Math.min(scaleOpts.maxSize, snapped));
}

/**
 * Public entry point. Returns a Promise resolving to the created template
 * document (or null on cancel).
 *
 * @param {object} templateData    Foundry MeasuredTemplate data. Must have `t`.
 *                                 Modified in place as the widget runs.
 * @param {object} options
 *   - scaleOpts:   { minSize, maxSize, step } or null
 *   - fixedOrigin: { x, y } to skip phase 1 (originate-self)
 * @returns {Promise<TemplateDocument|null>}
 */
export function placeAoETemplate(templateData, options = {}) {
  const { scaleOpts = null, fixedOrigin = null } = options;

  return new Promise((resolve) => {
    const shape = templateData.t;
    const isCircle = shape === 'circle';
    const isCone = shape === 'cone';
    const isLine = shape === 'ray';
    const isSquare = shape === 'rect';
    const skipSizePhase = isCircle && !scaleOpts;

    // ---- PIXI overlay setup ----
    const overlay = new PIXI.Graphics();
    overlay.eventMode = 'none';
    canvas.interface.addChild(overlay);

    const label = new PIXI.Text('', {
      fontFamily: 'Signika', fontSize: 32, fontWeight: 'bold',
      fill: '#ffffff', stroke: '#000000', strokeThickness: 5,
      align: 'left',
    });
    label.anchor.set(0, 0.5);
    canvas.stage.addChild(label);

    const hint = new PIXI.Text('', {
      fontFamily: 'Signika', fontSize: 22, fontWeight: 'normal',
      fill: '#dddddd', stroke: '#000000', strokeThickness: 4,
    });
    hint.anchor.set(0, 1);
    canvas.stage.addChild(hint);

    // ---- Widget state ----
    // phase 0 = seeking anchor
    // phase 1 = first drag (size for circle/square, angle+size for cone/line)
    // phase 2 = second drag (square rotation only)
    // phase = 'done' when committed
    let phase = 0;
    let done = false;
    let lastActionWasRightClick = false;
    let cursorWorld = { x: 0, y: 0 };
    let anchorSetToken = false;

    // Ensure templateData has defaults for the shape.
    templateData.direction = templateData.direction || 0;
    templateData.distance = templateData.distance || (scaleOpts?.minSize || SIZE_STEP_FT);
    if (isCone) templateData.angle = templateData.angle || 90;
    if (isLine) templateData.width = templateData.width || (canvas.scene?.grid?.distance || 5);

    // Save token pointer state and disable so a stray click doesn't select.
    const tokenModes = new Map();
    for (const t of canvas.tokens.placeables) {
      tokenModes.set(t.id, t.eventMode);
      t.eventMode = 'none';
    }

    const origCursor = canvas.app.view.style.cursor;
    canvas.app.view.style.cursor = 'crosshair';

    // ---- Event handlers (PIXI stage-level) ----
    const stage = canvas.stage;
    const prevStageMode = stage.eventMode;
    stage.eventMode = 'static';

    const onPointerMove = (ev) => {
      if (done) return;
      const local = ev.data.getLocalPosition(stage);
      cursorWorld = { x: local.x, y: local.y };
      render();
    };

    const onPointerDown = (ev) => {
      if (done) return;
      const button = ev.data.originalEvent.button;
      if (button === 2) {
        ev.data.originalEvent.preventDefault?.();
        if (lastActionWasRightClick || phase === 0) {
          cancel();
          return;
        }
        lastActionWasRightClick = true;
        stepBack();
        return;
      }
      if (button !== 0) return;
      lastActionWasRightClick = false;
      advance();
    };

    const onKeyDown = (ev) => {
      if (done) return;
      if (ev.key === 'Escape') cancel();
    };

    // Foundry's canvas eats wheel events for zoom. We do not use wheel
    // ourselves, but we DO want the anchor phase to snap correctly even if
    // the GM scrolls. Intentionally no wheel listener.

    stage.on('pointermove', onPointerMove);
    stage.on('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    // Contextmenu on the canvas element (belt + suspenders — the pointerdown
    // with button==2 catches this in most cases but some browsers only fire
    // contextmenu). Prevent the browser context menu regardless.
    const onContext = (e) => { e.preventDefault(); };
    canvas.app.view.addEventListener('contextmenu', onContext);

    // Set initial anchor if requested (originate-self).
    if (fixedOrigin) {
      templateData.x = fixedOrigin.x;
      templateData.y = fixedOrigin.y;
      anchorSetToken = true;
      phase = 1;
      if (skipSizePhase) {
        finishConfirm();
        return;
      }
    }

    // Initial render.
    render();

    // ---- Actions ----
    function advance() {
      if (phase === 0) {
        // Drop anchor at snapped cell center.
        const snapped = _snapToCellCenter(cursorWorld.x, cursorWorld.y);
        templateData.x = snapped.x;
        templateData.y = snapped.y;
        anchorSetToken = true;
        phase = 1;
        if (skipSizePhase) {
          finishConfirm();
          return;
        }
        render();
        return;
      }
      if (phase === 1) {
        // For square only, phase 1 (size) locks and phase 2 (rotation) starts.
        // For every other shape, phase 1 IS the commit phase.
        if (isSquare) {
          phase = 2;
          render();
          return;
        }
        finishConfirm();
        return;
      }
      if (phase === 2) {
        finishConfirm();
        return;
      }
    }

    function stepBack() {
      if (phase === 0) {
        cancel();
        return;
      }
      if (phase === 2) {
        // Back up to size adjust. Keep rotation as-is so re-entering phase 2
        // starts from what the GM had.
        phase = 1;
        render();
        return;
      }
      if (phase === 1) {
        // Back up to anchor. Only allowed if we're not in a fixedOrigin flow.
        if (fixedOrigin) {
          cancel();
          return;
        }
        anchorSetToken = false;
        phase = 0;
        render();
        return;
      }
    }

    function cancel() {
      if (done) return;
      done = true;
      cleanup();
      ui.notifications.warn('AOE placement cancelled');
      resolve(null);
    }

    async function finishConfirm() {
      if (done) return;
      done = true;
      cleanup();
      try {
        const [created] = await canvas.scene.createEmbeddedDocuments('MeasuredTemplate', [templateData]);
        ui.notifications.info('AOE template placed');
        resolve(created || null);
      } catch (err) {
        console.warn('AOE commit failed:', err);
        resolve(null);
      }
    }

    function cleanup() {
      stage.off('pointermove', onPointerMove);
      stage.off('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      canvas.app.view.removeEventListener('contextmenu', onContext);
      canvas.interface.removeChild(overlay);
      overlay.destroy();
      canvas.stage.removeChild(label);
      label.destroy();
      canvas.stage.removeChild(hint);
      hint.destroy();
      stage.eventMode = prevStageMode;
      canvas.app.view.style.cursor = origCursor;
      for (const t of canvas.tokens.placeables) {
        const m = tokenModes.get(t.id);
        if (m !== undefined) t.eventMode = m;
      }
    }

    // ---- Rendering ----
    function render() {
      overlay.clear();

      // Phase 0: preview anchor cell only.
      if (phase === 0) {
        const snapped = _snapToCellCenter(cursorWorld.x, cursorWorld.y);
        _drawAnchorMarker(overlay, snapped.x, snapped.y);
        label.text = 'click to place';
        label.position.set(snapped.x + 20, snapped.y - 20);
        _updateHint('Left-click to set anchor. Right-click / Escape to cancel.');
        return;
      }

      // Update templateData from cursor for the current phase.
      _updateFromCursor();

      // Draw cell highlight (production math).
      _drawCells(overlay, templateData);

      // Draw shape outline over cells for clarity.
      _drawOutline(overlay, templateData);

      // Anchor dot at the center.
      _drawAnchorMarker(overlay, templateData.x, templateData.y);

      // Square phase 2 handle dot: place on the "top" edge midpoint after
      // rotation so the GM sees what the cursor is grabbing.
      if (isSquare && phase === 2) {
        const halfExtentPx = _ftToPx(templateData.distance);
        const rad = Math.toRadians(templateData.direction);
        const hx = templateData.x + Math.cos(rad) * halfExtentPx;
        const hy = templateData.y + Math.sin(rad) * halfExtentPx;
        _drawHandle(overlay, hx, hy);
      }

      // Update label + hint.
      const rotShown = ((templateData.direction || 0) % 360 + 360) % 360;
      const rotText = (isCone || isLine || (isSquare && phase >= 2))
        ? ` @ ${Math.round(rotShown)}deg`
        : '';
      label.text = `${templateData.distance} ft${rotText}`;
      label.position.set(cursorWorld.x + 20, cursorWorld.y - 20);

      if (isSquare && phase === 1) {
        _updateHint('Move cursor to resize. Left-click to lock size, right-click to re-anchor.');
      } else if (isSquare && phase === 2) {
        _updateHint('Move cursor to rotate (Shift = fine 1deg). Left-click to confirm, right-click to re-size.');
      } else if (isCircle) {
        _updateHint('Move cursor to resize. Left-click to confirm, right-click to re-anchor.');
      } else if (isCone) {
        _updateHint('Move cursor: angle sets direction, distance sets length. Left-click to confirm, right-click to re-anchor.');
      } else if (isLine) {
        _updateHint('Cursor is the endpoint. Left-click to confirm, right-click to re-anchor.');
      }
    }

    function _updateFromCursor() {
      const dx = cursorWorld.x - templateData.x;
      const dy = cursorWorld.y - templateData.y;
      const dist = Math.hypot(dx, dy);
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);

      if (isCircle && phase === 1) {
        const distFt = _pxToFeet(dist);
        templateData.distance = _clampSize(distFt, scaleOpts);
        return;
      }

      if (isCone && phase === 1) {
        templateData.direction = angleDeg;
        const distFt = _pxToFeet(dist);
        templateData.distance = _clampSize(distFt, scaleOpts);
        return;
      }

      if (isLine && phase === 1) {
        templateData.direction = angleDeg;
        const distFt = _pxToFeet(dist);
        templateData.distance = _clampSize(distFt, scaleOpts);
        return;
      }

      if (isSquare && phase === 1) {
        // Size only. Rotation locked to whatever we entered phase with (0 by
        // default, preserved if we came back from phase 2).
        const distFt = _pxToFeet(dist);
        templateData.distance = _clampSize(distFt, scaleOpts);
        return;
      }

      if (isSquare && phase === 2) {
        // Rotation only. Size fixed.
        const shiftHeld = _isShiftHeld();
        if (shiftHeld) {
          templateData.direction = angleDeg;
        } else {
          templateData.direction = Math.round(angleDeg / SQUARE_ROTATION_SNAP_DEG) * SQUARE_ROTATION_SNAP_DEG;
        }
        return;
      }
    }

    function _updateHint(text) {
      hint.text = text;
      const margin = 20;
      const view = canvas.app.view;
      const client = canvas.canvasCoordinatesFromClient
        ? canvas.canvasCoordinatesFromClient({ x: margin, y: view.clientHeight - margin })
        : { x: 0, y: 0 };
      hint.position.set(client.x, client.y);
    }
  });
}

// ---- helpers (shared, outside the closure) ----

let _shiftHeld = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') _shiftHeld = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') _shiftHeld = false;
  });
}
function _isShiftHeld() { return _shiftHeld; }

function _drawAnchorMarker(g, x, y) {
  g.beginFill(HANDLE_COLOR, 1.0);
  g.drawCircle(x, y, 5);
  g.endFill();
  g.lineStyle(2, 0x000000, 0.8);
  g.drawCircle(x, y, 5);
  g.lineStyle(0);
}

function _drawHandle(g, x, y) {
  g.beginFill(HANDLE_COLOR, 1.0);
  g.drawCircle(x, y, HANDLE_RADIUS);
  g.endFill();
  g.lineStyle(2, 0x000000, 0.8);
  g.drawCircle(x, y, HANDLE_RADIUS);
  g.lineStyle(0);
}

function _drawCells(g, templateData) {
  // Delegate to production cell math so preview == commit.
  let cells;
  try {
    cells = getHighlightedCells(templateData);
  } catch (err) {
    return;
  }
  const gridSize = canvas.grid.size;
  for (const key of cells) {
    const [row, col] = key.split(',').map(Number);
    const pos = canvas.grid.getTopLeftPoint({ i: row, j: col });
    g.beginFill(HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA);
    g.drawRect(pos.x, pos.y, gridSize, gridSize);
    g.endFill();
    g.lineStyle(HIGHLIGHT_BORDER_WIDTH, HIGHLIGHT_COLOR, HIGHLIGHT_BORDER_ALPHA);
    g.drawRect(pos.x, pos.y, gridSize, gridSize);
    g.lineStyle(0);
  }
}

function _drawOutline(g, templateData) {
  const shape = templateData.t;
  g.lineStyle(2, OUTLINE_COLOR, OUTLINE_ALPHA);
  const ox = templateData.x;
  const oy = templateData.y;
  const distPx = _ftToPx(templateData.distance || 0);

  if (shape === 'circle') {
    g.drawCircle(ox, oy, distPx);
  } else if (shape === 'cone') {
    const halfAngle = Math.toRadians((templateData.angle || 90) / 2);
    const dir = Math.toRadians(templateData.direction || 0);
    const p1x = ox + Math.cos(dir - halfAngle) * distPx;
    const p1y = oy + Math.sin(dir - halfAngle) * distPx;
    const p2x = ox + Math.cos(dir + halfAngle) * distPx;
    const p2y = oy + Math.sin(dir + halfAngle) * distPx;
    g.moveTo(ox, oy);
    g.lineTo(p1x, p1y);
    // Arc between p1 and p2 through the tip; approximate with a polyline.
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const t = dir - halfAngle + (2 * halfAngle * i) / steps;
      g.lineTo(ox + Math.cos(t) * distPx, oy + Math.sin(t) * distPx);
    }
    g.lineTo(ox, oy);
  } else if (shape === 'ray') {
    const widthPx = _ftToPx(templateData.width || (canvas.scene?.grid?.distance || 5));
    const dir = Math.toRadians(templateData.direction || 0);
    const cos = Math.cos(dir), sin = Math.sin(dir);
    const nx = -sin, ny = cos;
    const h = widthPx / 2;
    const p1x = ox + nx * h, p1y = oy + ny * h;
    const p2x = ox + cos * distPx + nx * h, p2y = oy + sin * distPx + ny * h;
    const p3x = ox + cos * distPx - nx * h, p3y = oy + sin * distPx - ny * h;
    const p4x = ox - nx * h, p4y = oy - ny * h;
    g.moveTo(p1x, p1y);
    g.lineTo(p2x, p2y);
    g.lineTo(p3x, p3y);
    g.lineTo(p4x, p4y);
    g.lineTo(p1x, p1y);
  } else if (shape === 'rect') {
    const halfPx = distPx;
    const dir = Math.toRadians(templateData.direction || 0);
    const cos = Math.cos(dir), sin = Math.sin(dir);
    // Four vertices of the un-rotated square, then rotate around origin.
    const localVerts = [
      { x: -halfPx, y: -halfPx }, { x: halfPx, y: -halfPx },
      { x: halfPx, y: halfPx },   { x: -halfPx, y: halfPx },
    ];
    const world = localVerts.map(v => ({
      x: ox + v.x * cos - v.y * sin,
      y: oy + v.x * sin + v.y * cos,
    }));
    g.moveTo(world[0].x, world[0].y);
    for (let i = 1; i < world.length; i++) g.lineTo(world[i].x, world[i].y);
    g.lineTo(world[0].x, world[0].y);
  }
  g.lineStyle(0);
}
