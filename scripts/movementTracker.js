/**
 * Movement Tracker
 * Displays suggestive AP cost DURING token drag (not after movement).
 * Shows text near cursor with hex count and walk/sprint AP costs.
 * Does NOT deduct AP or block movement — players/GM manage AP manually.
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';

// Track active drag state
let _dragStartPos = null;
let _previewText = null;
let _dragToken = null;
let _methodsWrapped = false;
let _tickerCallback = null;

// Base font size (will be scaled by zoom)
const BASE_FONT_SIZE = 18;

/**
 * Register movement tracking hooks
 */
export function registerMovementTracker() {
  // Wrap Token prototype methods immediately
  _wrapTokenMethods();

  // Handle canvas events for cleanup
  Hooks.on('canvasReady', _onCanvasReady);
  Hooks.on('canvasTearDown', _cleanupAll);

  log('Movement tracker registered');
}

/**
 * Also export the pre-hook registration for backwards compatibility
 */
export function registerMovementPreHook() {
  // Now handled in registerMovementTracker
}

/**
 * Wrap Token prototype methods to intercept drag events
 */
function _wrapTokenMethods() {
  if (_methodsWrapped) return;

  // Use V13 namespaced Token class to avoid deprecation warnings
  const TokenClass = foundry.canvas?.placeables?.Token ?? Token;

  const originalDragLeftStart = TokenClass.prototype._onDragLeftStart;
  const originalDragLeftDrop = TokenClass.prototype._onDragLeftDrop;
  const originalDragLeftCancel = TokenClass.prototype._onDragLeftCancel;

  TokenClass.prototype._onDragLeftStart = function(event) {
    _handleDragStart(this);
    return originalDragLeftStart.call(this, event);
  };

  TokenClass.prototype._onDragLeftDrop = function(event) {
    _handleDragEnd();
    return originalDragLeftDrop.call(this, event);
  };

  TokenClass.prototype._onDragLeftCancel = function(event) {
    _handleDragEnd();
    return originalDragLeftCancel.call(this, event);
  };

  _methodsWrapped = true;
  debug('Token drag methods wrapped for movement tracking');
}

/**
 * Handle canvas ready
 */
function _onCanvasReady() {
  _cleanupAll();
}

/**
 * Handle drag start - start ticker to track movement
 */
function _handleDragStart(token) {
  // Only track during active combat
  if (!game.combat?.started) return;

  // Check if token has a combatant
  const combatant = game.combat.combatants.find(c => c.tokenId === token.document.id);
  if (!combatant) return;

  _dragToken = token;
  _dragStartPos = { x: token.document.x, y: token.document.y };

  // Start a ticker to update preview each frame
  _tickerCallback = () => _onTick();
  canvas.app.ticker.add(_tickerCallback);
}

/**
 * Ticker callback - runs each frame during drag
 */
function _onTick() {
  if (!_dragStartPos || !_dragToken) {
    _stopTicker();
    return;
  }

  // Get current mouse position
  const mouse = canvas.mousePosition;
  if (!mouse) return;

  // Calculate destination (mouse is at token center during drag)
  const destX = mouse.x - _dragToken.w / 2;
  const destY = mouse.y - _dragToken.h / 2;

  _updatePreviewText(destX, destY);
}

/**
 * Stop the ticker
 */
function _stopTicker() {
  if (_tickerCallback && canvas.app?.ticker) {
    canvas.app.ticker.remove(_tickerCallback);
    _tickerCallback = null;
  }
}

/**
 * Handle drag end - cleanup
 */
function _handleDragEnd() {
  _stopTicker();
  _cleanupPreview();
  _dragStartPos = null;
  _dragToken = null;
}

/**
 * Clean up everything
 */
function _cleanupAll() {
  _stopTicker();
  _cleanupPreview();
  _dragStartPos = null;
  _dragToken = null;
}

/**
 * Get font size scaled by current zoom level
 * When zoomed out, text gets larger to remain readable
 */
function _getScaledFontSize() {
  const zoom = canvas.stage?.scale?.x ?? 1;
  // Inverse scale: when zoomed out (zoom < 1), make text bigger
  // Clamp between 0.5x and 3x the base size
  const scale = Math.min(3, Math.max(0.5, 1 / zoom));
  return Math.round(BASE_FONT_SIZE * scale);
}

/**
 * Update the preview text
 */
function _updatePreviewText(destX, destY) {
  if (!_dragStartPos || !_dragToken || !canvas?.grid) return;

  try {
    const tokenCenterX = _dragToken.w / 2;
    const tokenCenterY = _dragToken.h / 2;

    // Calculate distance using Foundry's grid measurement
    const result = canvas.grid.measurePath([
      { x: _dragStartPos.x + tokenCenterX, y: _dragStartPos.y + tokenCenterY },
      { x: destX + tokenCenterX, y: destY + tokenCenterY }
    ]);

    const distance = result.distance ?? 0;
    const gridDistance = canvas.grid.distance || 5;
    const hexesMoved = Math.round(distance / gridDistance);

    // Don't show if no movement
    if (hexesMoved <= 0) {
      if (_previewText) {
        _previewText.visible = false;
      }
      return;
    }

    const walkAP = hexesMoved * CONFIG.COMBAT.WALK_AP_PER_HEX;
    const sprintAP = Math.ceil(hexesMoved / CONFIG.COMBAT.SPRINT_HEX_PER_AP);

    const text = `${hexesMoved} hex\nWalk: ${walkAP} AP | Sprint: ${sprintAP} AP`;

    // Get current scaled font size
    const fontSize = _getScaledFontSize();

    // Create or update preview text
    if (!_previewText) {
      const style = new PIXI.TextStyle({
        fontFamily: 'Signika',
        fontSize: fontSize,
        fontWeight: 'bold',
        fill: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
        dropShadow: true,
        dropShadowColor: '#000000',
        dropShadowBlur: 3,
        dropShadowDistance: 0,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: 250
      });

      _previewText = new PIXI.Text(text, style);
      _previewText.anchor.set(0.5, 1);
      canvas.stage.addChild(_previewText);
    } else {
      _previewText.text = text;
      _previewText.style.fontSize = fontSize;
      _previewText.visible = true;
    }

    // Position text above the destination
    _previewText.position.set(destX + tokenCenterX, destY - 10);

  } catch (e) {
    debug('Movement preview calculation failed:', e);
  }
}

/**
 * Clean up preview text
 */
function _cleanupPreview() {
  if (_previewText) {
    canvas.stage?.removeChild(_previewText);
    _previewText.destroy();
    _previewText = null;
  }
}