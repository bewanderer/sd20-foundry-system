/**
 * AoE Grid Cell Highlighting System
 * Draws colored overlays on grid cells affected by AoE templates.
 * Supports circle/hex and line shapes. Cones are left unchanged (no grid highlight).
 */

import { debug } from './utils.js';

// Map of template ID to PIXI.Graphics overlay
const _overlays = new Map();

// Highlight style
const HIGHLIGHT_COLOR = 0xff6600; // Orange
const HIGHLIGHT_ALPHA = 0.25;
const HIGHLIGHT_BORDER_COLOR = 0xff6600;
const HIGHLIGHT_BORDER_ALPHA = 0.6;
const HIGHLIGHT_BORDER_WIDTH = 2;

/**
 * Register AoE grid highlight hooks
 */
export function registerAoEGridHighlight() {
  Hooks.on('createMeasuredTemplate', _onCreateTemplate);
  Hooks.on('updateMeasuredTemplate', _onUpdateTemplate);
  Hooks.on('deleteMeasuredTemplate', _onDeleteTemplate);
  Hooks.on('canvasReady', _onCanvasReady);
  Hooks.on('canvasTearDown', _onCanvasTearDown);
  Hooks.on('updateToken', _onTokenUpdate);

  debug('AoE Grid Highlight system registered');
}

/**
 * Handle token movement - update templates that follow the caster
 */
async function _onTokenUpdate(tokenDoc, changes) {
  // Only care about position changes
  if (changes.x === undefined && changes.y === undefined) return;

  // Only GM can update templates (players don't have permission)
  if (!game.user.isGM) return;

  // Find templates that follow this token
  const templates = canvas.scene?.templates || [];
  const tokenId = tokenDoc.id;

  for (const template of templates) {
    const flags = template.flags?.['souls-d20'];
    if (!flags?.followsCaster || flags.casterTokenId !== tokenId) continue;

    // Calculate the new center position from the updated token document
    // Use the new position from changes, falling back to current document values
    const newX = changes.x ?? tokenDoc.x;
    const newY = changes.y ?? tokenDoc.y;

    // Get token dimensions to calculate center
    const gridSize = canvas.grid.size;
    const tokenWidth = (tokenDoc.width || 1) * gridSize;
    const tokenHeight = (tokenDoc.height || 1) * gridSize;

    const centerX = newX + tokenWidth / 2;
    const centerY = newY + tokenHeight / 2;

    // For cones and lines emitted from the caster's edge (large casters), the
    // template origin lives at the footprint boundary in the aim direction,
    // not at the geometric center. Recompute the edge point relative to the
    // new center so followsCaster keeps the emission at the caster's edge as
    // it moves. Circles and squares stay anchored at the center.
    let targetX = centerX;
    let targetY = centerY;
    const shape = template.t;
    if ((shape === 'cone' || shape === 'ray') && (tokenWidth > gridSize || tokenHeight > gridSize)) {
      const rad = Math.toRadians(template.direction || 0);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const halfX = tokenWidth / 2;
      const halfY = tokenHeight / 2;
      const tx = Math.abs(cos) > 1e-9 ? halfX / Math.abs(cos) : Infinity;
      const ty = Math.abs(sin) > 1e-9 ? halfY / Math.abs(sin) : Infinity;
      const t = Math.min(tx, ty);
      targetX = centerX + cos * t;
      targetY = centerY + sin * t;
    }

    // Update template position to follow the token
    await template.update({
      x: targetX,
      y: targetY,
    });
  }
}

/**
 * Handle template creation - draw overlay
 */
function _onCreateTemplate(template) {
  _drawOverlay(template);
}

/**
 * Handle template update - redraw overlay
 */
function _onUpdateTemplate(template) {
  _removeOverlay(template.id);
  _drawOverlay(template);
}

/**
 * Handle template deletion - remove overlay
 */
function _onDeleteTemplate(template) {
  _removeOverlay(template.id);
}

/**
 * Canvas ready - redraw overlays for existing templates
 */
function _onCanvasReady() {
  _clearAllOverlays();
  const templates = canvas.templates?.placeables || [];
  for (const template of templates) {
    _drawOverlay(template.document);
  }
}

/**
 * Canvas teardown - clear all overlays
 */
function _onCanvasTearDown() {
  _clearAllOverlays();
}

/**
 * Remove a specific overlay
 */
function _removeOverlay(templateId) {
  const overlay = _overlays.get(templateId);
  if (overlay) {
    overlay.destroy({ children: true });
    _overlays.delete(templateId);
  }
}

/**
 * Clear all overlays
 */
function _clearAllOverlays() {
  for (const [id, overlay] of _overlays) {
    overlay.destroy({ children: true });
  }
  _overlays.clear();
}

/**
 * Draw overlay for a template
 */
function _drawOverlay(templateDoc) {
  if (!templateDoc || !canvas.grid) return;

  // Only apply to templates created by the macro targeting system (not Foundry's default drawing)
  const sd20Flags = templateDoc.flags?.['souls-d20'];
  if (!sd20Flags?.macroId && !sd20Flags?.macroData) return;

  // Check player visibility setting
  // GMs can always see overlays, players respect the visibility setting
  if (!game.user.isGM) {
    const visibility = sd20Flags.playerVisibility || 'hidden';
    if (visibility === 'hidden') {
      // Hidden from players - don't draw overlay
      return;
    }
    // Bug 9: reactiveReveal hides the AoE cells from non-GM players until the
    // GM approves the ruling that reveals the template. The template document
    // is already created with hidden=true, but the highlight overlay is drawn
    // client-side by us and needs its own gate.
    if (visibility === 'reactiveReveal') {
      return;
    }
    // 'visible' and 'afterCast' both show the overlay once the template is created
    // 'afterCast' is effectively the same as 'visible' after placement is confirmed
  }

  const shape = templateDoc.t;
  const distance = templateDoc.distance || 0;

  // Handle circle, ray, cone, and rect (Bug 10: Square). Rect only for our
  // macro-created templates - Foundry's own rect drawings do not hit the
  // early return in _drawOverlay's macroId guard.
  if (shape !== 'circle' && shape !== 'ray' && shape !== 'cone' && shape !== 'rect') return;

  // Get exclusion radius from template flags (Feature 3 integration)
  const exclusionRadius = sd20Flags.exclusionRadius || 0;

  // Get grid dimensions
  const gridSize = canvas.grid.size;
  const gridDistance = canvas.scene?.grid?.distance || 5;

  // Create PIXI.Graphics for overlay
  const overlay = new PIXI.Graphics();
  overlay.eventMode = 'none';

  if (shape === 'circle') {
    _drawCircleHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius);
  } else if (shape === 'ray') {
    _drawLineHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius);
  } else if (shape === 'cone') {
    _drawConeHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius);
  } else if (shape === 'rect') {
    _drawSquareHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius);
  }

  // Add to canvas interface layer
  canvas.interface.addChild(overlay);
  _overlays.set(templateDoc.id, overlay);
}

/**
 * Bug 1: draw circle highlight using Euclidean cell-center distance on
 * square grids. The previous BFS ring approach used Chebyshev distance
 * (king-move) and over-included corner cells at higher radii (a 10ft radius
 * would light up 5x5 = 25 cells instead of the tabletop-expected 3x3 = 9).
 * On hex grids the BFS ring approach is retained - hex distance is a
 * different, well-defined metric that BFS models correctly.
 */
function _drawCircleHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = _getCircleCells(templateDoc, gridSize, gridDistance, exclusionRadius);
  for (const key of cells) {
    const [row, col] = key.split(',').map(Number);
    const cellPos = canvas.grid.getTopLeftPoint({ i: row, j: col });
    _drawCell(overlay, cellPos.x, cellPos.y, gridSize, row, col);
  }
}

/**
 * Get neighbor offsets based on grid type
 * For hex grids, neighbors depend on column parity (even/odd columns have different offsets)
 */
function _getNeighborOffsets(row, col, isHex) {
  if (!isHex) {
    // Square grid: 8-directional (including diagonals)
    return [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],           [0, 1],
      [1, -1],  [1, 0],  [1, 1]
    ];
  }

  // Hex grid: 6 neighbors
  // Foundry grid types:
  // - Hexagonal Columns (canvas.grid.columns = true) = flat-top hexes, odd-q coordinate system
  // - Hexagonal Rows (canvas.grid.columns = false) = pointy-top hexes, odd-r coordinate system
  const isColumnar = canvas.grid.columns;

  if (isColumnar) {
    // Hexagonal Columns: flat-top hexes using odd-q offset coordinates
    // Neighbor offsets depend on column parity
    const isOddCol = col % 2 === 1;
    if (isOddCol) {
      return [
        [-1, 0],          // top
        [0, -1],          // top-left
        [1, -1],          // bottom-left
        [1, 0],           // bottom
        [1, 1],           // bottom-right
        [0, 1]            // top-right
      ];
    } else {
      return [
        [-1, 0],          // top
        [-1, -1],         // top-left
        [0, -1],          // bottom-left
        [1, 0],           // bottom
        [0, 1],           // bottom-right
        [-1, 1]           // top-right
      ];
    }
  } else {
    // Hexagonal Rows: pointy-top hexes using odd-r offset coordinates
    // Neighbor offsets depend on row parity
    const isOddRow = row % 2 === 1;
    if (isOddRow) {
      return [
        [-1, 0],          // upper-left
        [-1, 1],          // upper-right
        [0, -1],          // left
        [0, 1],           // right
        [1, 0],           // lower-left
        [1, 1]            // lower-right
      ];
    } else {
      return [
        [-1, -1],         // upper-left
        [-1, 0],          // upper-right
        [0, -1],          // left
        [0, 1],           // right
        [1, -1],          // lower-left
        [1, 0]            // lower-right
      ];
    }
  }
}

/**
 * Bug 1: draw line/ray highlight using the strict "cell center inside the
 * ray rectangle" rule. Share cell selection with the targeting getter so the
 * visual and the target set never drift.
 */
function _drawLineHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = _getLineCells(templateDoc, gridSize, gridDistance, exclusionRadius);
  for (const key of cells) {
    const [row, col] = key.split(',').map(Number);
    const cellPos = canvas.grid.getTopLeftPoint({ i: row, j: col });
    _drawCell(overlay, cellPos.x, cellPos.y, gridSize, row, col);
  }
}

/**
 * Draw cone highlight using polar coordinate sampling
 * Supports exclusion zone (cells within exclusion distance from origin are not highlighted)
 */
function _drawConeHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius) {
  const distanceFt = templateDoc.distance || 0;
  if (distanceFt <= 0) return;

  // Origin position in pixels
  const originX = templateDoc.x;
  const originY = templateDoc.y;

  // Cone parameters
  const direction = Math.toRadians(templateDoc.direction || 0);
  const angleDeg = templateDoc.angle || 90;
  const halfAngle = Math.toRadians(angleDeg / 2);

  // Distance in pixels
  const distancePx = (distanceFt / gridDistance) * gridSize;

  // Exclusion distance in pixels
  const exclusionPx = (exclusionRadius / gridDistance) * gridSize;

  // Sample the cone area using polar coordinates
  const stepSize = gridSize / 4;
  const distSteps = Math.ceil(distancePx / stepSize);
  const angleSteps = Math.max(8, Math.ceil(angleDeg / 5)); // More steps for wider cones

  const visitedCells = new Set();
  const cellsToHighlight = [];

  // Sample radially from origin
  for (let r = 0; r <= distSteps; r++) {
    const dist = r * stepSize;

    // Skip if within exclusion zone
    if (dist < exclusionPx) continue;

    // Sample across the cone angle
    for (let a = 0; a <= angleSteps; a++) {
      const angleOffset = (a / angleSteps - 0.5) * 2 * halfAngle;
      const currentAngle = direction + angleOffset;

      const x = originX + Math.cos(currentAngle) * dist;
      const y = originY + Math.sin(currentAngle) * dist;

      // Get grid cell at this point
      const cell = canvas.grid.getOffset({ x, y });
      const key = `${cell.i},${cell.j}`;

      if (!visitedCells.has(key)) {
        visitedCells.add(key);
        cellsToHighlight.push({ row: cell.i, col: cell.j });
      }
    }
  }

  // Draw each cell
  for (const { row, col } of cellsToHighlight) {
    const cellPos = canvas.grid.getTopLeftPoint({ i: row, j: col });
    _drawCell(overlay, cellPos.x, cellPos.y, gridSize, row, col);
  }
}

/**
 * Draw a single cell highlight (supports both square and hex grids)
 * @param {PIXI.Graphics} overlay - The graphics object to draw on
 * @param {number} x - Top-left X from getTopLeftPoint
 * @param {number} y - Top-left Y from getTopLeftPoint
 * @param {number} size - Grid size
 * @param {number} row - Grid row (i coordinate)
 * @param {number} col - Grid column (j coordinate)
 */
function _drawCell(overlay, x, y, size, row = 0, col = 0) {
  const isHex = canvas.grid.isHexagonal;

  if (isHex) {
    // For hex grids, use getCenterPoint for accurate center
    const center = canvas.grid.getCenterPoint({ i: row, j: col });

    // Calculate hex radius based on grid configuration
    // Foundry's grid.size is the hex cell size (width for flat-top, height for pointy-top)
    const isColumnar = canvas.grid.columns;
    // For flat-top (columnar): size is width, radius = size / 2
    // For pointy-top (rows): size is height, radius = size / 2
    // The hex should fit within the grid cell, so use size / 2 as the outer radius
    const radius = size / 2;

    const points = _getHexPoints(center.x, center.y, radius);

    // Fill
    overlay.beginFill(HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA);
    overlay.drawPolygon(points);
    overlay.endFill();

    // Border
    overlay.lineStyle(HIGHLIGHT_BORDER_WIDTH, HIGHLIGHT_BORDER_COLOR, HIGHLIGHT_BORDER_ALPHA);
    overlay.drawPolygon(points);
    overlay.lineStyle(0);
  } else {
    // Square grid - draw rectangle
    overlay.beginFill(HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA);
    overlay.drawRect(x, y, size, size);
    overlay.endFill();

    overlay.lineStyle(HIGHLIGHT_BORDER_WIDTH, HIGHLIGHT_BORDER_COLOR, HIGHLIGHT_BORDER_ALPHA);
    overlay.drawRect(x, y, size, size);
    overlay.lineStyle(0);
  }
}

/**
 * Get hexagon corner points for drawing
 * @param {number} cx - Center X
 * @param {number} cy - Center Y
 * @param {number} radius - Hex radius (half the size)
 * @returns {number[]} Flat array of [x1, y1, x2, y2, ...] points
 */
function _getHexPoints(cx, cy, radius) {
  const points = [];
  // Determine grid orientation:
  // - Hexagonal Columns (canvas.grid.columns = true) = flat-top hexes (vertices at 0°, 60°, 120°...)
  // - Hexagonal Rows (canvas.grid.columns = false) = pointy-top hexes (vertices at 30°, 90°, 150°...)
  const isColumnar = canvas.grid.columns;

  for (let i = 0; i < 6; i++) {
    // Flat-top (columns): vertices at 0°, 60°, 120°, 180°, 240°, 300°
    // Pointy-top (rows): vertices at 30°, 90°, 150°, 210°, 270°, 330°
    const angleDeg = isColumnar ? (60 * i) : (60 * i + 30);
    const angleRad = Math.PI / 180 * angleDeg;
    points.push(cx + radius * Math.cos(angleRad));
    points.push(cy + radius * Math.sin(angleRad));
  }
  return points;
}

/* -------------------------------------------- */
/*  Exported Cell-Based Targeting Functions     */
/* -------------------------------------------- */

/**
 * Get the set of highlighted cell keys for a template
 * @param {MeasuredTemplateDocument} templateDoc - The template document
 * @returns {Set<string>} Set of cell keys in format "row,col"
 */
export function getHighlightedCells(templateDoc) {
  if (!templateDoc || !canvas.grid) return new Set();

  const sd20Flags = templateDoc.flags?.['souls-d20'];
  const shape = templateDoc.t;
  const gridSize = canvas.grid.size;
  const gridDistance = canvas.scene?.grid?.distance || 5;
  const exclusionRadius = sd20Flags?.exclusionRadius || 0;

  if (shape === 'circle') {
    return _getCircleCells(templateDoc, gridSize, gridDistance, exclusionRadius);
  } else if (shape === 'ray') {
    return _getLineCells(templateDoc, gridSize, gridDistance, exclusionRadius);
  } else if (shape === 'cone') {
    return _getConeCells(templateDoc, gridSize, gridDistance, exclusionRadius);
  } else if (shape === 'rect') {
    return _getSquareCells(templateDoc, gridSize, gridDistance, exclusionRadius);
  }

  return new Set();
}

/**
 * Check if a token's grid cell is within the highlighted cells of a template
 * @param {Token} token - The token to check
 * @param {MeasuredTemplateDocument} templateDoc - The template document
 * @returns {boolean} True if token's cell is highlighted
 */
export function isTokenInHighlightedCells(token, templateDoc) {
  const highlightedCells = getHighlightedCells(templateDoc);
  if (highlightedCells.size === 0) return false;

  // Get the cell the token's center is in
  const tokenCell = canvas.grid.getOffset({ x: token.center.x, y: token.center.y });
  const tokenCellKey = `${tokenCell.i},${tokenCell.j}`;

  return highlightedCells.has(tokenCellKey);
}

/**
 * Batch D: circle cell coverage.
 * - Square grid: Chebyshev (king-move) rings. N feet covers all cells within
 *   floor(N / gridDistance) rings. 5 ft = 3x3, 10 ft = 5x5, 15 ft = 7x7.
 *   Diagonals count as adjacent, matching tabletop convention.
 * - Hex grid: BFS by rings using proper hex neighbor offsets.
 * Exclusion: cells within `exclusionRadius` rings are dropped.
 */
function _getCircleCells(templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = new Set();
  const radiusFt = templateDoc.distance || 0;
  if (radiusFt <= 0) return cells;

  const rings = Math.floor(radiusFt / gridDistance);
  const exclusionRings = Math.floor(exclusionRadius / gridDistance);
  if (rings <= 0) return cells;

  const originCell = canvas.grid.getOffset({ x: templateDoc.x, y: templateDoc.y });
  const isHex = canvas.grid.isHexagonal;

  if (isHex) {
    // Hex grid keeps the BFS-from-single-cell model. Large-caster expansion
    // on hex would need a different metric; punt for now.
    const visited = new Set();
    const queue = [[originCell.i, originCell.j, 0]];
    visited.add(`${originCell.i},${originCell.j}`);
    while (queue.length > 0) {
      const [row, col, dist] = queue.shift();
      const outside = exclusionRings <= 0 || dist > exclusionRings;
      if (dist <= rings && outside) cells.add(`${row},${col}`);
      if (dist < rings) {
        const neighborOffsets = _getNeighborOffsets(row, col, isHex);
        for (const [dr, dc] of neighborOffsets) {
          const nr = row + dr;
          const nc = col + dc;
          const key = `${nr},${nc}`;
          if (!visited.has(key)) {
            visited.add(key);
            queue.push([nr, nc, dist + 1]);
          }
        }
      }
    }
    return cells;
  }

  // Square grid: Chebyshev distance from the caster's footprint bounding box.
  // For a 1x1 origin (normal placement or medium caster) this reduces to the
  // classic Chebyshev-from-single-cell formula. For larger casters, the AoE
  // measures reach from the outer edge of the footprint, so a 2x2 creature
  // with a 20ft circle actually gets 20ft past its own tiles instead of only
  // 15ft (the "reach eaten by the caster" bug).
  const footprint = _getFootprintBounds(templateDoc, originCell, gridSize);
  for (let row = footprint.topRow - rings; row <= footprint.bottomRow + rings; row++) {
    for (let col = footprint.leftCol - rings; col <= footprint.rightCol + rings; col++) {
      const cheb = _chebyshevToBounds(row, col, footprint);
      if (cheb > rings) continue;
      if (exclusionRings > 0 && cheb <= exclusionRings) continue;
      cells.add(`${row},${col}`);
    }
  }
  return cells;
}

/**
 * Derive the caster's footprint bounding box in cell coordinates from stored
 * originator flags. Falls back to a 1x1 footprint at the origin cell so
 * templates without the flag behave exactly as before.
 */
function _getFootprintBounds(templateDoc, originCell, gridSize) {
  const flags = templateDoc.flags?.['souls-d20'];
  const wCells = Math.max(1, Math.round(flags?.originatorWidth || 1));
  const hCells = Math.max(1, Math.round(flags?.originatorHeight || 1));

  if (wCells === 1 && hCells === 1) {
    return {
      topRow: originCell.i,
      bottomRow: originCell.i,
      leftCol: originCell.j,
      rightCol: originCell.j,
    };
  }

  // templateDoc.x/y sits at the caster's center. The footprint's top-left
  // pixel is one half-footprint offset up and left from that.
  const topLeftPx = {
    x: templateDoc.x - (wCells * gridSize) / 2,
    y: templateDoc.y - (hCells * gridSize) / 2,
  };
  const topLeftCell = canvas.grid.getOffset(topLeftPx);
  return {
    topRow: topLeftCell.i,
    bottomRow: topLeftCell.i + hCells - 1,
    leftCol: topLeftCell.j,
    rightCol: topLeftCell.j + wCells - 1,
  };
}

/**
 * Chebyshev distance from a cell (row, col) to an axis-aligned bounding box
 * in cell coordinates. Returns 0 when the cell is inside the box.
 */
function _chebyshevToBounds(row, col, bounds) {
  const rowDist = Math.max(0, bounds.topRow - row, row - bounds.bottomRow);
  const colDist = Math.max(0, bounds.leftCol - col, col - bounds.rightCol);
  return Math.max(rowDist, colDist);
}

/**
 * Bug 1: cells for line/ray templates. Include a cell only if its center
 * lies inside the ray's local-frame rectangle (0 <= x <= lengthPx and
 * abs(y) <= halfWidthPx). This is stricter than the previous over-sampled
 * approach and stops the "5ft-wide line paints 10ft" symptom.
 */
function _getLineCells(templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = new Set();
  const lengthFt = templateDoc.distance || 0;
  if (lengthFt <= 0) return cells;

  const originX = templateDoc.x;
  const originY = templateDoc.y;
  const direction = Math.toRadians(templateDoc.direction || 0);
  const lengthPx = (lengthFt / gridDistance) * gridSize;
  const widthFt = templateDoc.width || gridDistance;
  const widthPx = (widthFt / gridDistance) * gridSize;
  const halfWidthPx = widthPx / 2;
  const exclusionPx = (exclusionRadius / gridDistance) * gridSize;

  const cosDir = Math.cos(direction);
  const sinDir = Math.sin(direction);

  // Diagonal reach compensation. The projected-Euclidean-distance check below
  // measures how far along the ray a cell center is in pixels. At a cardinal
  // direction one grid step = one gridSize of localX, so a 20ft ray reaches 4
  // cells. At 45deg the same 4 diagonal cells are sqrt(2) * gridSize away in
  // localX, so a 20ft ray would only reach the 3rd cell without this scale.
  // Dividing by max(|cos|, |sin|) reaches by the ratio needed for grid-based
  // (Chebyshev-style) length semantics: 20ft = 4 tiles in any direction.
  const cardinalScale = Math.max(Math.abs(cosDir), Math.abs(sinDir));
  const effectiveLengthPx = cardinalScale > 0 ? lengthPx / cardinalScale : lengthPx;
  const effectiveExclusionPx = cardinalScale > 0 ? exclusionPx / cardinalScale : exclusionPx;

  // Bounding-box cell range large enough to contain the whole ray at any
  // rotation. Use max(effectiveLength, width) as the half-extent buffer.
  const originCell = canvas.grid.getOffset({ x: originX, y: originY });
  const cellSpan = Math.ceil(Math.max(effectiveLengthPx, widthPx) / gridSize) + 2;

  // Floating-point epsilon so boundary cells at exact multiples of the grid
  // (e.g. the 4th diagonal cell at 45deg where localX ~= effectiveLengthPx
  // within 2e-13) get included instead of dropped.
  const EPS = 1e-6;

  for (let dRow = -cellSpan; dRow <= cellSpan; dRow++) {
    for (let dCol = -cellSpan; dCol <= cellSpan; dCol++) {
      const row = originCell.i + dRow;
      const col = originCell.j + dCol;
      const center = canvas.grid.getCenterPoint({ i: row, j: col });
      const dx = center.x - originX;
      const dy = center.y - originY;
      // Rotate into local frame where the ray goes down the +x axis.
      const localX = dx * cosDir + dy * sinDir;
      const localY = -dx * sinDir + dy * cosDir;
      if (localX < -EPS || localX > effectiveLengthPx + EPS) continue;
      if (Math.abs(localY) > halfWidthPx + EPS) continue;
      if (effectiveExclusionPx > 0 && localX < effectiveExclusionPx - EPS) continue;
      cells.add(`${row},${col}`);
    }
  }

  return cells;
}

/**
 * Get cells for cone templates (polar coordinate sampling)
 */
function _getConeCells(templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = new Set();
  const distanceFt = templateDoc.distance || 0;
  if (distanceFt <= 0) return cells;

  const originX = templateDoc.x;
  const originY = templateDoc.y;
  const direction = Math.toRadians(templateDoc.direction || 0);
  const angleDeg = templateDoc.angle || 90;
  const halfAngle = Math.toRadians(angleDeg / 2);
  const distancePx = (distanceFt / gridDistance) * gridSize;
  const exclusionPx = (exclusionRadius / gridDistance) * gridSize;

  const stepSize = gridSize / 4;
  const distSteps = Math.ceil(distancePx / stepSize);
  const angleSteps = Math.max(8, Math.ceil(angleDeg / 5));

  for (let r = 0; r <= distSteps; r++) {
    const dist = r * stepSize;
    if (dist < exclusionPx) continue;

    for (let a = 0; a <= angleSteps; a++) {
      const angleOffset = (a / angleSteps - 0.5) * 2 * halfAngle;
      const currentAngle = direction + angleOffset;
      const x = originX + Math.cos(currentAngle) * dist;
      const y = originY + Math.sin(currentAngle) * dist;

      const cell = canvas.grid.getOffset({ x, y });
      cells.add(`${cell.i},${cell.j}`);
    }
  }

  return cells;
}

/**
 * Bug 10: draw a Square AoE. Square uses Foundry's rect template type where
 * width == distance (both in feet). We draw only the cells inside that
 * square. Placement snapping is handled at template creation time in
 * macroBar._createAOETemplate.
 */
function _drawSquareHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = _getSquareCells(templateDoc, gridSize, gridDistance, exclusionRadius);
  for (const key of cells) {
    const [row, col] = key.split(',').map(Number);
    const cellPos = canvas.grid.getTopLeftPoint({ i: row, j: col });
    _drawCell(overlay, cellPos.x, cellPos.y, gridSize, row, col);
  }
}

/**
 * Batch D: square cell coverage.
 *
 * Square is a rotated rectangle centered on the template origin. Distance N
 * is the half-extent from center in feet. At rotation 0, coverage matches an
 * N-ft Chebyshev circle. At other rotations, cells whose center falls inside
 * the rotated rectangle are included.
 *
 * Rotation is derived from templateDoc.direction (Foundry stores it in
 * degrees). Exclusion carves a smaller centered rotated square out of the
 * middle.
 */
function _getSquareCells(templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = new Set();
  const halfExtentFt = templateDoc.distance || 0;
  if (halfExtentFt <= 0) return cells;

  const originX = templateDoc.x;
  const originY = templateDoc.y;
  const halfExtentPx = (halfExtentFt / gridDistance) * gridSize;
  const exclusionHalfPx = (exclusionRadius / gridDistance) * gridSize;

  const angleRad = Math.toRadians(templateDoc.direction || 0);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  // For a large caster with originate-from-self, expand the square's local-
  // frame half-extents by the caster's footprint half-size so the AoE reaches
  // halfExtentFt past the caster's outer edge instead of only halfExtentFt
  // past its center. This uses a per-axis (Minkowski) expansion, which is
  // exact at rotation 0/90 and an acceptable approximation at other angles.
  const flags = templateDoc.flags?.['souls-d20'];
  const wCells = Math.max(1, Math.round(flags?.originatorWidth || 1));
  const hCells = Math.max(1, Math.round(flags?.originatorHeight || 1));
  const halfFootprintXPx = ((wCells - 1) * gridSize) / 2;
  const halfFootprintYPx = ((hCells - 1) * gridSize) / 2;
  const effectiveHalfXPx = halfExtentPx + halfFootprintXPx;
  const effectiveHalfYPx = halfExtentPx + halfFootprintYPx;

  const originCell = canvas.grid.getOffset({ x: originX, y: originY });
  const cellSpan = Math.ceil((Math.max(effectiveHalfXPx, effectiveHalfYPx) * Math.SQRT2) / gridSize) + 1;

  for (let dRow = -cellSpan; dRow <= cellSpan; dRow++) {
    for (let dCol = -cellSpan; dCol <= cellSpan; dCol++) {
      const row = originCell.i + dRow;
      const col = originCell.j + dCol;
      const center = canvas.grid.getCenterPoint({ i: row, j: col });
      const dx = center.x - originX;
      const dy = center.y - originY;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      if (Math.abs(localX) > effectiveHalfXPx) continue;
      if (Math.abs(localY) > effectiveHalfYPx) continue;
      if (exclusionHalfPx > 0
          && Math.abs(localX) < exclusionHalfPx
          && Math.abs(localY) < exclusionHalfPx) {
        continue;
      }
      cells.add(`${row},${col}`);
    }
  }
  return cells;
}
