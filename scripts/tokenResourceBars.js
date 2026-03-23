/**
 * Token Resource Bars
 * Draws HP/FP/AP bars on tokens based on Combat Settings tokenUI configuration.
 * Bars are visible to GM always, to owner based on showToSelf, to others based on showToOthers.
 * Custom HUD input fields replace Foundry's default bar inputs.
 */

import { CONFIG } from './config.js';
import { getActorCombatSettings } from './damageSystem.js';
import { debug } from './utils.js';

const MODULE = CONFIG.MODULE_ID;

// Store containers per token for cleanup
const _barContainers = new Map();

// Bar configuration
const BAR_HEIGHT = 14;
const BAR_SPACING = 3;

/**
 * Register hooks for token resource bars
 */
export function registerTokenResourceBars() {
  Hooks.on('refreshToken', _onRefreshToken);
  Hooks.on('destroyToken', _onDestroyToken);
  Hooks.on('canvasReady', _onCanvasReady);
  Hooks.on('canvasTearDown', _onCanvasTearDown);

  // Hook into Token HUD to add custom resource inputs
  Hooks.on('renderTokenHUD', _onRenderTokenHUD);

  // Refresh when actor data changes (handles linked tokens)
  // Use requestAnimationFrame to ensure fresh data is read after Foundry processes the update
  Hooks.on('updateActor', (actor, changes) => {
    const hasResourceChange = changes?.system?.hp !== undefined ||
                              changes?.system?.fp !== undefined ||
                              changes?.system?.ap !== undefined;
    const hasFlagChange = changes?.flags?.[MODULE] !== undefined;

    if (hasResourceChange || hasFlagChange) {
      requestAnimationFrame(() => _refreshActorTokens(actor));
    }
  });

  // Also refresh on token document updates (handles unlinked tokens with actorData/delta changes)
  Hooks.on('updateToken', (tokenDoc, changes) => {
    // Check if actor-related data changed on the token (various Foundry versions use different paths)
    const actorDataChanged = changes?.actorData?.system?.hp !== undefined ||
                             changes?.actorData?.system?.fp !== undefined ||
                             changes?.actorData?.system?.ap !== undefined;
    const deltaChanged = changes?.delta?.system?.hp !== undefined ||
                         changes?.delta?.system?.fp !== undefined ||
                         changes?.delta?.system?.ap !== undefined;

    if (actorDataChanged || deltaChanged) {
      requestAnimationFrame(() => {
        const token = canvas.tokens?.get(tokenDoc.id);
        if (token) {
          _drawBars(token);
        }
      });
    }
  });

  debug('Token resource bars registered');
}

/**
 * Refresh all tokens for an actor
 * Handles both linked tokens (same actor ID) and the same actor instance
 */
function _refreshActorTokens(actor) {
  if (!canvas.ready || !canvas.tokens?.placeables) return;

  for (const token of canvas.tokens.placeables) {
    // Check by actor ID (for linked tokens) or by same actor instance (for synthetic actors)
    if (token.actor?.id === actor.id || token.actor === actor) {
      _drawBars(token);
    }
  }
}

/**
 * Force refresh resource bars for a specific token
 * Call this from other modules when you know data has changed
 */
export function refreshTokenBars(token) {
  if (!token) return;
  requestAnimationFrame(() => _drawBars(token));
}

/**
 * Force refresh resource bars for all tokens of an actor
 * Call this from other modules when you know actor data has changed
 */
export function refreshActorTokenBars(actor) {
  if (!actor) return;
  requestAnimationFrame(() => _refreshActorTokens(actor));
}

/**
 * Handle token refresh
 */
function _onRefreshToken(token) {
  _drawBars(token);
}

/**
 * Handle token destruction
 */
function _onDestroyToken(token) {
  _cleanupBars(token.id);
}

/**
 * Handle canvas ready
 */
function _onCanvasReady() {
  // Redraw all token bars
  const tokens = canvas.tokens?.placeables || [];
  for (const token of tokens) {
    _drawBars(token);
  }
}

/**
 * Handle canvas teardown
 */
function _onCanvasTearDown() {
  // Clean up all bar containers
  for (const [, container] of _barContainers) {
    container.destroy({ children: true });
  }
  _barContainers.clear();
}

/**
 * Clean up bars for a specific token
 */
function _cleanupBars(tokenId) {
  const container = _barContainers.get(tokenId);
  if (container) {
    container.destroy({ children: true });
    _barContainers.delete(tokenId);
  }
}

/**
 * Check if bars should be visible to current user
 */
function _shouldShowBar(token, barSettings) {
  const actor = token.actor;
  if (!actor) return false;

  // GM always sees bars
  if (game.user.isGM) return true;

  // Check ownership
  const isOwner = actor.isOwner;

  if (isOwner) {
    return barSettings.showToSelf !== false; // Default true
  } else {
    return barSettings.showToOthers === true; // Default false
  }
}

/**
 * Check if user can edit this token's values
 */
function _canEdit(token) {
  const actor = token.actor;
  if (!actor) return false;
  return game.user.isGM || actor.isOwner;
}

/**
 * Handle Token HUD render - add custom resource inputs
 */
function _onRenderTokenHUD(hud, html) {
  const token = hud.object;
  const actor = token?.actor;
  if (!actor) return;

  // Only show for users who can edit
  if (!_canEdit(token)) return;

  // Hide Foundry's default bar inputs (html is native element in v12)
  const bar1 = html.querySelector('.attribute.bar1');
  const bar2 = html.querySelector('.attribute.bar2');
  if (bar1) bar1.style.display = 'none';
  if (bar2) bar2.style.display = 'none';

  // Get current values
  const hp = actor.system.hp || { value: 0, max: 1, temp: 0 };
  const fp = actor.system.fp || { value: 0, max: 1 };
  const ap = actor.system.ap || { value: 0, max: 1 };

  // Create custom input container - ABOVE token (FP and AP)
  const topInputs = document.createElement('div');
  topInputs.className = 'sd20-hud-inputs sd20-hud-top';
  topInputs.innerHTML = `
    <div class="sd20-hud-input-group fp">
      <label>FP</label>
      <input type="text" class="sd20-hud-value" data-resource="fp" value="${fp.value}/${fp.max}" />
    </div>
    <div class="sd20-hud-input-group ap">
      <label>AP</label>
      <input type="text" class="sd20-hud-value" data-resource="ap" value="${ap.value}/${ap.max}" />
    </div>
  `;

  // Create custom input container - BELOW token (HP and Temp HP)
  const bottomInputs = document.createElement('div');
  bottomInputs.className = 'sd20-hud-inputs sd20-hud-bottom';
  bottomInputs.innerHTML = `
    <div class="sd20-hud-input-group hp">
      <label>HP</label>
      <input type="text" class="sd20-hud-value" data-resource="hp" value="${hp.value}/${hp.max}" />
    </div>
    <div class="sd20-hud-input-group temp-hp">
      <label>Temp</label>
      <input type="text" class="sd20-hud-value" data-resource="tempHP" value="${hp.temp || 0}" />
    </div>
  `;

  // Add to HUD
  const middleCol = html.querySelector('.col.middle');
  if (middleCol) {
    middleCol.prepend(topInputs);
    middleCol.append(bottomInputs);
  }

  // Handle input changes
  html.querySelectorAll('.sd20-hud-value').forEach(input => {
    input.addEventListener('change', async (e) => {
      const resource = input.dataset.resource;
      const rawValue = input.value.trim();

      const update = {};

      if (resource === 'hp' || resource === 'fp' || resource === 'ap') {
        // Parse "current/max" or just "current"
        let newValue;
        if (rawValue.includes('/')) {
          newValue = parseInt(rawValue.split('/')[0]) || 0;
        } else {
          // Support relative values like +5 or -3
          if (rawValue.startsWith('+') || rawValue.startsWith('-')) {
            const delta = parseInt(rawValue) || 0;
            newValue = actor.system[resource].value + delta;
          } else {
            newValue = parseInt(rawValue) || 0;
          }
        }

        const max = actor.system[resource].max;

        if (resource === 'hp') {
          // Handle overflow -> Temp HP
          if (newValue > max) {
            const overflow = newValue - max;
            update['system.hp.value'] = max;
            update['system.hp.temp'] = (hp.temp || 0) + overflow;
          } else {
            update['system.hp.value'] = Math.max(0, newValue);
          }
          // Update HP input display (clamped to max)
          input.value = `${Math.max(0, Math.min(newValue, max))}/${max}`;
        } else {
          // FP and AP can go above max - no upper clamping
          const finalValue = Math.max(0, newValue);
          update[`system.${resource}.value`] = finalValue;
          // Update input display (show actual value, even if above max)
          input.value = `${finalValue}/${max}`;
        }

      } else if (resource === 'tempHP') {
        // Temp HP - just a flat number, support relative
        let newTemp;
        if (rawValue.startsWith('+') || rawValue.startsWith('-')) {
          const delta = parseInt(rawValue) || 0;
          newTemp = (hp.temp || 0) + delta;
        } else {
          newTemp = parseInt(rawValue) || 0;
        }
        update['system.hp.temp'] = Math.max(0, newTemp);
        input.value = Math.max(0, newTemp);
      }

      if (Object.keys(update).length > 0) {
        await actor.update(update);
      }
    });

    // Select all on focus for easy editing
    input.addEventListener('focus', () => {
      input.select();
    });

    // Submit on Enter
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      }
    });
  });
}

/**
 * Draw resource bars on a token (no text, just colored bars)
 */
function _drawBars(token) {
  if (!token?.actor) return;

  // Clean up existing bars
  _cleanupBars(token.id);

  const actor = token.actor;
  const settings = getActorCombatSettings(actor);
  const tokenUI = settings.tokenUI;

  // Check what bars to show
  const showHP = _shouldShowBar(token, tokenUI.hp);
  const showFP = _shouldShowBar(token, tokenUI.fp);
  const showAP = _shouldShowBar(token, tokenUI.ap);

  if (!showHP && !showFP && !showAP) return;

  // Create container for bars
  const container = new PIXI.Container();
  container.name = `sd20-resource-bars-${token.id}`;

  // Position below the token
  const tokenWidth = token.w;
  const tokenHeight = token.h;
  const barWidth = tokenWidth * 0.95;
  const startX = (tokenWidth - barWidth) / 2;
  let startY = tokenHeight + 4;

  let barIndex = 0;

  // HP Bar (red with golden temp HP overlay)
  if (showHP) {
    const hp = actor.system.hp || { value: 0, max: 1, temp: 0 };
    const tempHP = hp.temp || 0;
    const maxHP = hp.max || 1;
    const currentHP = hp.value || 0;

    // Scale to effective total: bar shows proportional split between current HP and temp HP
    // This ensures temp HP is always visible, even when HP is at max
    // Example: 100/100 HP + 100 temp → displayBase = 200, red = 50%, gold = 50%
    const effectiveTotal = currentHP + tempHP;
    const displayBase = Math.max(maxHP, effectiveTotal);

    // Calculate percentages relative to displayBase
    const hpPercent = displayBase > 0 ? Math.max(0, currentHP / displayBase) : 0;
    const tempPercent = displayBase > 0 ? Math.max(0, tempHP / displayBase) : 0;

    const y = startY + barIndex * (BAR_HEIGHT + BAR_SPACING);

    // Background with vignette corners
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.75);
    bg.drawRoundedRect(startX, y, barWidth, BAR_HEIGHT, 3);
    bg.endFill();
    container.addChild(bg);

    // HP fill (solid red)
    if (hpPercent > 0) {
      const hpWidth = barWidth * hpPercent;
      const hpBar = new PIXI.Graphics();
      hpBar.beginFill(0xf44336, 0.95);
      hpBar.drawRoundedRect(startX, y, hpWidth, BAR_HEIGHT, 3);
      hpBar.endFill();
      container.addChild(hpBar);
    }

    // Temp HP fill (solid gold)
    if (tempHP > 0 && tempPercent > 0) {
      const tempStartX = startX + barWidth * hpPercent;
      const tempWidth = barWidth * tempPercent;
      const tempBar = new PIXI.Graphics();
      tempBar.beginFill(0xc8a84e, 0.95);
      tempBar.drawRoundedRect(tempStartX, y, tempWidth, BAR_HEIGHT, 3);
      tempBar.endFill();
      container.addChild(tempBar);
    }

    // Border
    const border = new PIXI.Graphics();
    border.lineStyle(1, 0x444444, 1);
    border.drawRoundedRect(startX, y, barWidth, BAR_HEIGHT, 3);
    container.addChild(border);

    barIndex++;
  }

  // FP Bar (blue) - allow overflow above max
  if (showFP) {
    const fp = actor.system.fp || { value: 0, max: 1 };
    // Allow above 100% for overflow
    const fpPercent = Math.min(1, Math.max(0, fp.value / (fp.max || 1)));

    const y = startY + barIndex * (BAR_HEIGHT + BAR_SPACING);

    // Background
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.75);
    bg.drawRoundedRect(startX, y, barWidth, BAR_HEIGHT, 3);
    bg.endFill();
    container.addChild(bg);

    // FP fill (solid blue)
    if (fpPercent > 0) {
      const fpWidth = barWidth * fpPercent;
      const fpBar = new PIXI.Graphics();
      fpBar.beginFill(0x2196f3, 0.95);
      fpBar.drawRoundedRect(startX, y, fpWidth, BAR_HEIGHT, 3);
      fpBar.endFill();
      container.addChild(fpBar);
    }

    // Border
    const border = new PIXI.Graphics();
    border.lineStyle(1, 0x444444, 1);
    border.drawRoundedRect(startX, y, barWidth, BAR_HEIGHT, 3);
    container.addChild(border);

    barIndex++;
  }

  // AP Bar (green) - allow overflow above max
  if (showAP) {
    const ap = actor.system.ap || { value: 0, max: 1 };
    const apPercent = Math.min(1, Math.max(0, ap.value / (ap.max || 1)));

    const y = startY + barIndex * (BAR_HEIGHT + BAR_SPACING);

    // Background
    const bg = new PIXI.Graphics();
    bg.beginFill(0x000000, 0.75);
    bg.drawRoundedRect(startX, y, barWidth, BAR_HEIGHT, 3);
    bg.endFill();
    container.addChild(bg);

    // AP fill (solid green)
    if (apPercent > 0) {
      const apWidth = barWidth * apPercent;
      const apBar = new PIXI.Graphics();
      apBar.beginFill(0x4caf50, 0.95);
      apBar.drawRoundedRect(startX, y, apWidth, BAR_HEIGHT, 3);
      apBar.endFill();
      container.addChild(apBar);
    }

    // Border
    const border = new PIXI.Graphics();
    border.lineStyle(1, 0x444444, 1);
    border.drawRoundedRect(startX, y, barWidth, BAR_HEIGHT, 3);
    container.addChild(border);

    barIndex++;
  }

  // Add container to token
  token.addChild(container);
  _barContainers.set(token.id, container);
}
