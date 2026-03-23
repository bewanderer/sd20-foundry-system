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

    // Update template position to follow the token
    await template.update({
      x: centerX,
      y: centerY
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
    // 'visible' and 'afterCast' both show the overlay once the template is created
    // 'afterCast' is effectively the same as 'visible' after placement is confirmed
  }

  const shape = templateDoc.t;
  const distance = templateDoc.distance || 0;

  // Handle circle, ray, and cone shapes
  if (shape !== 'circle' && shape !== 'ray' && shape !== 'cone') return;

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
  }

  // Add to canvas interface layer
  canvas.interface.addChild(overlay);
  _overlays.set(templateDoc.id, overlay);
}

/**
 * Draw circle/hex highlight using BFS ring expansion
 * Supports both square and hex grids
 */
function _drawCircleHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius) {
  const radiusFt = templateDoc.distance || 0;
  if (radiusFt <= 0) return;

  // Origin position in pixels
  const originX = templateDoc.x;
  const originY = templateDoc.y;

  // Calculate rings: 1 ring per gridDistance feet
  const rings = Math.floor(radiusFt / gridDistance);
  const exclusionRings = Math.floor(exclusionRadius / gridDistance);

  if (rings <= 0) return;

  // Get origin grid cell
  const originCell = canvas.grid.getOffset({ x: originX, y: originY });

  // BFS to find all cells within radius
  const visited = new Set();
  const cellsToHighlight = [];

  // Queue: [row, col, distance in rings]
  const queue = [[originCell.i, originCell.j, 0]];
  visited.add(`${originCell.i},${originCell.j}`);

  const isHex = canvas.grid.isHexagonal;

  while (queue.length > 0) {
    const [row, col, dist] = queue.shift();

    // Add to highlight if within radius but outside exclusion
    // When exclusionRings is 0, include ALL cells (no exclusion)
    const isOutsideExclusion = exclusionRings <= 0 || dist > exclusionRings;
    if (dist <= rings && isOutsideExclusion) {
      cellsToHighlight.push({ row, col });
    }

    // Expand to neighbors if within radius
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

  // Draw each cell
  for (const { row, col } of cellsToHighlight) {
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
 * Draw line/ray highlight using step-based rasterization
 * Properly handles width and exclusion zone across the full ray width
 */
function _drawLineHighlight(overlay, templateDoc, gridSize, gridDistance, exclusionRadius) {
  const lengthFt = templateDoc.distance || 0;
  if (lengthFt <= 0) return;

  // Origin position in pixels
  const originX = templateDoc.x;
  const originY = templateDoc.y;

  // Direction in radians
  const direction = Math.toRadians(templateDoc.direction || 0);

  // Ray dimensions in pixels
  const lengthPx = (lengthFt / gridDistance) * gridSize;
  const widthFt = templateDoc.width || gridDistance;
  const widthPx = (widthFt / gridDistance) * gridSize;

  // Exclusion distance in pixels (along the ray, not from origin point)
  const exclusionPx = (exclusionRadius / gridDistance) * gridSize;

  // Step size for sampling
  const stepSize = gridSize / 4;
  const lengthSteps = Math.ceil(lengthPx / stepSize);
  const widthSteps = Math.max(1, Math.ceil(widthPx / stepSize));

  // Perpendicular direction for width sampling
  const perpDir = direction + Math.PI / 2;
  const cosDir = Math.cos(direction);
  const sinDir = Math.sin(direction);
  const cosPerp = Math.cos(perpDir);
  const sinPerp = Math.sin(perpDir);

  const visitedCells = new Set();
  const cellsToHighlight = [];

  // Sample along the length
  for (let i = 0; i <= lengthSteps; i++) {
    const distAlongRay = i * stepSize;

    // Skip if within exclusion zone (exclusion is measured along the ray)
    if (distAlongRay < exclusionPx) continue;

    // Sample across the width (centered on the ray)
    for (let w = 0; w <= widthSteps; w++) {
      // Width offset from center (-halfWidth to +halfWidth)
      const widthOffset = (w / widthSteps - 0.5) * widthPx;

      const x = originX + cosDir * distAlongRay + cosPerp * widthOffset;
      const y = originY + sinDir * distAlongRay + sinPerp * widthOffset;

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
 * Get cells for circle/hex templates (BFS ring expansion)
 */
function _getCircleCells(templateDoc, gridSize, gridDistance, exclusionRadius) {
  const cells = new Set();
  const radiusFt = templateDoc.distance || 0;
  if (radiusFt <= 0) return cells;

  const originX = templateDoc.x;
  const originY = templateDoc.y;
  const rings = Math.floor(radiusFt / gridDistance);
  const exclusionRings = Math.floor(exclusionRadius / gridDistance);

  if (rings <= 0) return cells;

  const originCell = canvas.grid.getOffset({ x: originX, y: originY });
  const visited = new Set();
  const queue = [[originCell.i, originCell.j, 0]];
  visited.add(`${originCell.i},${originCell.j}`);

  const isHex = canvas.grid.isHexagonal;

  while (queue.length > 0) {
    const [row, col, dist] = queue.shift();
    const isOutsideExclusion = exclusionRings <= 0 || dist > exclusionRings;

    if (dist <= rings && isOutsideExclusion) {
      cells.add(`${row},${col}`);
    }

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

/**
 * Get cells for line/ray templates (step-based rasterization)
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
  const exclusionPx = (exclusionRadius / gridDistance) * gridSize;

  const stepSize = gridSize / 4;
  const lengthSteps = Math.ceil(lengthPx / stepSize);
  const widthSteps = Math.max(1, Math.ceil(widthPx / stepSize));

  const perpDir = direction + Math.PI / 2;
  const cosDir = Math.cos(direction);
  const sinDir = Math.sin(direction);
  const cosPerp = Math.cos(perpDir);
  const sinPerp = Math.sin(perpDir);

  for (let i = 0; i <= lengthSteps; i++) {
    const distAlongRay = i * stepSize;
    if (distAlongRay < exclusionPx) continue;

    for (let w = 0; w <= widthSteps; w++) {
      const widthOffset = (w / widthSteps - 0.5) * widthPx;
      const x = originX + cosDir * distAlongRay + cosPerp * widthOffset;
      const y = originY + sinDir * distAlongRay + sinPerp * widthOffset;

      const cell = canvas.grid.getOffset({ x, y });
      cells.add(`${cell.i},${cell.j}`);
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
