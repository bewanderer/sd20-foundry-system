/**
 * Token Status Icons
 * Renders icon-based status badges above tokens.
 *
 * Badge Types:
 * - Dead (fa-skull) - binary, no number
 * - Injured (fa-heart-crack) - binary, no number
 * - Dodged (fa-person-running) - with number (dodge count)
 * - Unified Status (fa-bars-progress) - opens Status Panel when clicked
 *
 * Number Key Support:
 * - Hover over any badge and press 0-9 to set its counter
 * - Works for Dodge and Foundry status effects
 */

import { CONFIG } from './config.js';
import { debug } from './utils.js';

const MODULE = CONFIG.MODULE_ID;

// Track the currently hovered badge for keyboard input
let _hoveredBadge = null;
let _hoveredToken = null;

// Track tokens currently being rendered to prevent duplicate calls
const _renderingTokens = new Set();

// Simple flag: is context menu currently open?
let _contextMenuOpen = false;
let _contextMenuOpenTime = 0; // Timestamp when context menu opened

// Base offset per badge (100px for 3 badges = ~33px each)
const OFFSET_PER_BADGE = 65;
const MIN_OFFSET = 180;

// Zoom scale limits for offset calculation
const OFFSET_SCALE_MIN = 0.5; // Minimum scale factor for offset (when zoomed way out)
const OFFSET_SCALE_MAX = 2.0; // Maximum scale factor for offset (when zoomed way in)

// Badge font size limits (scales with zoom but capped)
const BADGE_FONT_SIZE_MIN = 12;
const BADGE_FONT_SIZE_MAX = 12;

// Icon badge definitions
const ICON_BADGES = {
  Dead: { icon: 'fa-solid fa-skull', color: '#ffffff', bgColor: '#000000', showNumber: false },
  Injured: { icon: 'fa-solid fa-heart-crack', color: '#f44336', bgColor: '#4a1a1a', showNumber: false },
  Dodged: { icon: 'fa-solid fa-person-running-fast', color: '#4caf50', bgColor: '#1a4a1a', showNumber: true }
};

// Unified status badge (for buildup/conditions)
const UNIFIED_STATUS_BADGE = {
  icon: 'fa-solid fa-bars-progress',
  activeColor: '#ffa500',
  activeBgColor: '#4a3a1a',
  inactiveColor: '#666666',
  inactiveBgColor: '#2a2a2a'
};

// Status effect badge colors by category
const STATUS_BADGE_COLORS = {
  // Buildup statuses (orange tones)
  Bleed: { color: '#ff6b6b', bgColor: '#4a2020' },
  Poison: { color: '#9ccc65', bgColor: '#2a4a20' },
  Toxic: { color: '#ab47bc', bgColor: '#3a204a' },
  Frost: { color: '#4fc3f7', bgColor: '#204a5a' },
  Poise: { color: '#78909c', bgColor: '#2a3a40' },
  // Conditions (red/purple tones)
  BledOut: { color: '#d32f2f', bgColor: '#4a1a1a' },
  Poisoned: { color: '#7cb342', bgColor: '#2a4020' },
  BadlyPoisoned: { color: '#8e24aa', bgColor: '#3a1a4a' },
  Frostbitten: { color: '#039be5', bgColor: '#1a3a4a' },
  Staggered: { color: '#ffa726', bgColor: '#4a3a1a' },
  Dazed: { color: '#ffee58', bgColor: '#4a4a1a' },
  Berserk: { color: '#ff5722', bgColor: '#4a2a1a' },
  Frenzy: { color: '#e91e63', bgColor: '#4a1a2a' },
  Exhaustion: { color: '#9e9e9e', bgColor: '#2a2a2a' },
  Grappled: { color: '#8d6e63', bgColor: '#3a2a20' },
  Restrained: { color: '#607d8b', bgColor: '#2a3a40' },
  Prone: { color: '#795548', bgColor: '#3a2a20' },
  // Buffs (green/blue tones)
  WeaponBuff1: { color: '#4caf50', bgColor: '#1a4a2a' },
  WeaponBuff2: { color: '#00bcd4', bgColor: '#1a3a4a' },
  RestorationBuff: { color: '#8bc34a', bgColor: '#2a4a1a' },
  DefensiveBuff: { color: '#2196f3', bgColor: '#1a2a4a' },
  // Debuffs (red/orange tones)
  DefenseDebuff: { color: '#f44336', bgColor: '#4a1a1a' },
  OffenseDebuff: { color: '#ff9800', bgColor: '#4a3a1a' },
  RestorationDebuff: { color: '#9c27b0', bgColor: '#3a1a4a' },
  // Default
  default: { color: '#9e9e9e', bgColor: '#2a2a2a' }
};

// Valid condition names (must match tokenHUD.js SD20_STATUS_PALETTE.condition)
const VALID_CONDITIONS = new Set([
  'BledOut', 'Poisoned', 'BadlyPoisoned', 'Frostbitten', 'Cursed', 'Staggered',
  'Dazed', 'Berserk', 'Frenzy', 'Exhaustion', 'Grappled', 'Restrained', 'Prone',
  'Mounting', 'ImpairedVision', 'Deafened', 'LimbFracture', 'LockedUp'
]);

// Valid buildup names
const VALID_BUILDUPS = new Set([
  'Bleed', 'Poison', 'Toxic', 'Frost', 'Curse', 'Poise'
]);

/**
 * Check if actor has any active buildup, conditions, or manual statuses
 * Returns true if any status effect is currently active (for badge highlighting)
 * Only considers VALID conditions/buildups - ignores orphaned data
 */
function hasActiveStatusEffects(actor) {
  if (!actor) return false;

  // Check buildup - any VALID buildup with current > 0
  const buildup = actor.getFlag(MODULE, 'statusBuildup') || {};
  for (const [name, data] of Object.entries(buildup)) {
    if (!VALID_BUILDUPS.has(name)) continue; // Skip invalid/orphaned buildups
    const current = data?.current || 0;
    if (current > 0) {
      debug(`Status highlight triggered by buildup: ${name} = ${current}`);
      return true;
    }
  }

  // Check conditions - any VALID condition with active === true
  const conditions = actor.getFlag(MODULE, 'activeConditions') || {};
  for (const [name, data] of Object.entries(conditions)) {
    if (!VALID_CONDITIONS.has(name)) continue; // Skip invalid/orphaned conditions
    if (data?.active === true) {
      debug(`Status highlight triggered by condition: ${name}`);
      return true;
    }
  }

  // Check manual statuses - any manual status that is true
  const manualStatuses = actor.getFlag(MODULE, 'manualStatuses') || {};
  for (const [name, isActive] of Object.entries(manualStatuses)) {
    if (isActive === true) {
      debug(`Status highlight triggered by manual status: ${name}`);
      return true;
    }
  }

  // Check vulnerabilities - any active vulnerability
  const vulnerabilities = actor.getFlag(MODULE, 'vulnerabilities') || [];
  if (vulnerabilities.length > 0) {
    debug(`Status highlight triggered by vulnerability: ${vulnerabilities.length} active`);
    return true;
  }

  return false;
}

/**
 * Get active status effects from token (from Foundry's status effect system)
 * Returns array of { id, name, icon, counter }
 */
function getTokenStatusEffects(token) {
  if (!token?.actor) return [];

  const effects = [];
  const actor = token.actor;

  // Get active statuses from actor.statuses Set (Foundry's global CONFIG)
  if (actor.statuses?.size > 0) {
    for (const statusId of actor.statuses) {
      // Find the status effect definition from Foundry's global CONFIG.statusEffects
      const statusDef = globalThis.CONFIG.statusEffects.find(s => s.id === statusId);
      if (!statusDef) continue;

      // Skip 'dead' status - handled separately
      if (statusId === 'dead') continue;

      // Get counter value from active effects if available
      let counter = null;
      const activeEffect = actor.effects.find(e => e.statuses?.has(statusId));
      if (activeEffect) {
        // Check for counter in flags (Foundry standard location)
        counter = activeEffect.flags?.core?.statusCounter ??
                  activeEffect.flags?.[MODULE]?.counter ??
                  null;
      }

      effects.push({
        id: statusId,
        name: statusDef.name,
        icon: statusDef.img || statusDef.icon, // V12+ uses img, fallback to icon
        counter
      });
    }
  }

  return effects;
}

/**
 * Get the dodge count for an actor
 */
function getDodgeCount(actor) {
  if (!actor) return 0;
  return actor.getFlag(MODULE, 'dodgeCount') || 0;
}

/**
 * Set the dodge count for an actor
 */
export async function setDodgeCount(actor, count) {
  if (!actor) return;
  const newCount = Math.max(0, Math.floor(count));
  if (newCount === 0) {
    await actor.unsetFlag(MODULE, 'dodgeCount');
  } else {
    await actor.setFlag(MODULE, 'dodgeCount', newCount);
  }
}

/**
 * Set a status effect counter for an actor
 * Updates the Foundry ActiveEffect's counter flag
 */
export async function setStatusEffectCounter(actor, statusId, count) {
  if (!actor) return;

  // Find the active effect for this status
  const activeEffect = actor.effects.find(e => e.statuses?.has(statusId));

  if (!activeEffect) {
    // If no active effect exists and count > 0, create one
    if (count > 0) {
      const statusDef = globalThis.CONFIG.statusEffects.find(s => s.id === statusId);
      if (statusDef) {
        await actor.createEmbeddedDocuments('ActiveEffect', [{
          name: statusDef.name,
          img: statusDef.img || statusDef.icon,
          statuses: [statusId],
          flags: {
            core: { statusCounter: count },
            [MODULE]: { counter: count }
          }
        }]);
      }
    }
    return;
  }

  // Update existing effect
  if (count === 0) {
    // Remove the effect entirely
    await activeEffect.delete();
  } else {
    // Update the counter
    await activeEffect.update({
      'flags.core.statusCounter': count,
      [`flags.${MODULE}.counter`]: count
    });
  }
}

/**
 * Gather icon badges for a token
 * Returns array of { id, icon, color, bgColor, number, clickable }
 */
function gatherBadges(token) {
  const actor = token.actor;
  if (!actor) return [];

  const badges = [];
  const hp = actor.system?.hp;

  // Dead badge (HP <= 0)
  if (hp && hp.max > 0 && hp.value <= 0) {
    badges.push({
      id: 'Dead',
      ...ICON_BADGES.Dead,
      number: null,
      clickable: false
    });
  }
  // Injured badge (HP > 0 but <= 50%)
  else if (hp && hp.max > 0 && hp.value > 0 && hp.value <= hp.max * CONFIG.COMBAT.INJURED_THRESHOLD) {
    badges.push({
      id: 'Injured',
      ...ICON_BADGES.Injured,
      number: null,
      clickable: false
    });
  }

  // Dodged badge (if dodge count > 0)
  const dodgeCount = getDodgeCount(actor);
  if (dodgeCount > 0) {
    badges.push({
      id: 'Dodged',
      ...ICON_BADGES.Dodged,
      number: dodgeCount,
      clickable: false
    });
  }

  // Foundry status effect badges (from Token HUD toggles)
  const statusEffects = getTokenStatusEffects(token);
  for (const effect of statusEffects) {
    const colors = STATUS_BADGE_COLORS[effect.id] || STATUS_BADGE_COLORS.default;
    badges.push({
      id: `status-${effect.id}`,
      icon: effect.icon.startsWith('fa-') ? effect.icon : null,
      iconUrl: effect.icon.startsWith('fa-') ? null : effect.icon,
      color: colors.color,
      bgColor: colors.bgColor,
      number: effect.counter,
      showNumber: effect.counter != null,
      clickable: false,
      isStatusEffect: true
    });
  }

  // Unified status badge (always visible - gray when inactive, colored when active)
  const hasStatus = hasActiveStatusEffects(actor);
  badges.push({
    id: 'StatusPanel',
    icon: UNIFIED_STATUS_BADGE.icon,
    color: hasStatus ? UNIFIED_STATUS_BADGE.activeColor : UNIFIED_STATUS_BADGE.inactiveColor,
    bgColor: hasStatus ? UNIFIED_STATUS_BADGE.activeBgColor : UNIFIED_STATUS_BADGE.inactiveBgColor,
    number: null,
    clickable: true,
    showNumber: false
  });

  return badges;
}

/**
 * Create HTML badge element
 * IMPORTANT: No focus/tabindex - keyboard input via hover + global listener only
 */
function createBadgeElement(badge, token) {
  const el = document.createElement('div');
  el.className = 'sd20-token-badge';
  el.dataset.badgeId = badge.id;

  // Make badges bigger - minimum 14px font, scale with token size
  // Scale with zoom but cap at min/max
  const fontSize = Math.min(BADGE_FONT_SIZE_MAX, Math.max(BADGE_FONT_SIZE_MIN, token.h * 0.2));

  // Check if this badge supports number key input (via hover + keyboard)
  const supportsNumberInput = badge.id === 'Dodged' || badge.isStatusEffect;

  el.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 3px 8px;
    border-radius: 12px;
    background: ${badge.bgColor};
    border: 2px solid ${badge.color};
    font-size: ${fontSize}px;
    color: ${badge.color};
    cursor: ${badge.clickable ? 'pointer' : 'default'};
    user-select: none;
  `;

  // Icon - either FontAwesome or image URL
  if (badge.icon) {
    // FontAwesome icon
    const icon = document.createElement('i');
    icon.className = badge.icon;
    el.appendChild(icon);
  } else if (badge.iconUrl) {
    // Image-based icon (SVG from Foundry)
    const img = document.createElement('img');
    img.src = badge.iconUrl;
    img.style.cssText = `
      width: ${fontSize}px;
      height: ${fontSize}px;
      filter: drop-shadow(0 0 1px ${badge.color});
    `;
    el.appendChild(img);
  }

  // Number element - ALWAYS visible if badge has a number
  const hasNumber = badge.number != null && badge.number > 0;
  if (hasNumber) {
    const num = document.createElement('span');
    num.className = 'badge-number';
    num.textContent = badge.number;
    num.style.cssText = `
      font-weight: bold;
      min-width: 12px;
      text-align: center;
    `;
    el.appendChild(num);
  }

  // Hover tracking for global keyboard listener (NO focus stealing)
  if (supportsNumberInput) {
    el.addEventListener('mouseenter', () => {
      _hoveredBadge = { element: el, badge, token };
      _hoveredToken = token;
    });
    el.addEventListener('mouseleave', () => {
      _hoveredBadge = null;
      _hoveredToken = null;
    });
  }

  // Click handler for status panel only
  if (badge.clickable && badge.id === 'StatusPanel') {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openStatusPanel(token);
    });
  }

  return el;
}

/**
 * Open the status panel for a token
 */
async function openStatusPanel(token) {
  // Dynamic import to avoid circular dependencies
  const { StatusPanel } = await import('./statusPanel.js');
  StatusPanel.open(token);
}

/**
 * Render HTML badge container above a token
 */
function renderBadges(token, badges) {
  // First clear any existing badges (including orphans)
  clearBadges(token);
  if (!badges.length) return;

  // Double-check: ensure no orphan badges remain for this token
  document.querySelectorAll(`.sd20-token-badges[data-token-id="${token.id}"]`).forEach(el => el.remove());

  // Create container
  const container = document.createElement('div');
  container.className = 'sd20-token-badges';
  container.dataset.tokenId = token.id;
  container.style.cssText = `
    position: absolute;
    display: flex;
    flex-direction: row-reverse;
    gap: 4px;
    justify-content: center;
    pointer-events: auto;
    z-index: 0;
  `;

  // Add badges
  for (const badge of badges) {
    container.appendChild(createBadgeElement(badge, token));
  }

  // Position above token
  const tokenRect = token.bounds;
  const canvasRect = canvas.app.view.getBoundingClientRect();
  const scale = canvas.stage.scale.x;

  // Calculate position
  const tokenScreenX = (tokenRect.x * scale) + canvasRect.left + (canvas.stage.pivot.x * -scale) + (canvas.stage.position.x);
  const tokenScreenY = (tokenRect.y * scale) + canvasRect.top + (canvas.stage.pivot.y * -scale) + (canvas.stage.position.y);
  const tokenScreenWidth = tokenRect.width * scale;

  // Add to DOM first to measure width
  document.body.appendChild(container);
  const containerWidth = container.offsetWidth;

  // Center above token (with offset if context menu is open for this token)
  let leftPos = tokenScreenX + (tokenScreenWidth - containerWidth) / 2;

  // Check if context menu is open and this token is controlled - apply offset
  const shouldOffset = _contextMenuOpen && token.controlled;

  // Apply dynamic offset based on badge count if context menu is open for this token
  // Scale offset with zoom level (larger when zoomed in, smaller when zoomed out)
  if (shouldOffset) {
    const baseOffset = Math.max(MIN_OFFSET, badges.length * OFFSET_PER_BADGE);
    const clampedScale = Math.min(OFFSET_SCALE_MAX, Math.max(OFFSET_SCALE_MIN, scale));
    const offset = baseOffset * clampedScale;
    leftPos -= offset;
  }
  container.style.left = `${leftPos}px`;
  container.style.top = `${tokenScreenY - container.offsetHeight - 4}px`;

  token._sd20BadgeContainer = container;
}

/**
 * Remove badge container from token
 * Also cleans up any orphan badges in the DOM with same token ID
 */
function clearBadges(token) {
  // Clean up reference
  if (token._sd20BadgeContainer) {
    token._sd20BadgeContainer.remove();
    delete token._sd20BadgeContainer;
  }

  // Also clean up any orphan badges in DOM for this token
  if (token?.id) {
    document.querySelectorAll(`.sd20-token-badges[data-token-id="${token.id}"]`).forEach(el => el.remove());
  }
}

/**
 * Sync status icons for a single token
 */
export function syncTokenStatusIcons(token) {
  if (!token || !token.actor) {
    clearBadges(token);
    return;
  }

  // Prevent duplicate renders for the same token
  if (_renderingTokens.has(token.id)) return;
  _renderingTokens.add(token.id);

  try {
    const badges = gatherBadges(token);
    renderBadges(token, badges);
  } finally {
    // Clear the flag after a short delay to allow for rapid subsequent calls to be blocked
    setTimeout(() => _renderingTokens.delete(token.id), 50);
  }
}

/**
 * Sync all tokens on the current scene
 */
function syncAllTokens() {
  // Clear all existing badges first
  document.querySelectorAll('.sd20-token-badges').forEach(el => el.remove());

  if (!canvas?.tokens?.placeables) return;
  for (const token of canvas.tokens.placeables) {
    syncTokenStatusIcons(token);
  }
}

/**
 * Find tokens linked to a given actor and sync them
 */
function syncTokensForActor(actor) {
  if (!canvas?.tokens?.placeables || !actor) return;
  for (const token of canvas.tokens.placeables) {
    if (token.actor?.id === actor.id) {
      syncTokenStatusIcons(token);
    }
  }
}

/**
 * Update badge positions on canvas pan/zoom
 */
function updateBadgePositions() {
  if (!canvas?.tokens?.placeables) return;
  for (const token of canvas.tokens.placeables) {
    if (token._sd20BadgeContainer) {
      // Re-render to update positions
      const badges = gatherBadges(token);
      renderBadges(token, badges);
    }
  }
}

/**
 * Update a single token's badge position (for real-time movement)
 */
function updateBadgePosition(token) {
  if (!token._sd20BadgeContainer) return;

  const container = token._sd20BadgeContainer;
  const tokenRect = token.bounds;
  const canvasRect = canvas.app.view.getBoundingClientRect();
  const scale = canvas.stage.scale.x;

  // Calculate position
  const tokenScreenX = (tokenRect.x * scale) + canvasRect.left + (canvas.stage.pivot.x * -scale) + (canvas.stage.position.x);
  const tokenScreenY = (tokenRect.y * scale) + canvasRect.top + (canvas.stage.pivot.y * -scale) + (canvas.stage.position.y);
  const tokenScreenWidth = tokenRect.width * scale;
  const containerWidth = container.offsetWidth;

  // Calculate left position with forced offset if active
  let leftPos = tokenScreenX + (tokenScreenWidth - containerWidth) / 2;

  // Check if context menu is open and this token is controlled - apply offset
  // Scale offset with zoom level (larger when zoomed in, smaller when zoomed out)
  if (_contextMenuOpen && token.controlled) {
    // Count badges in the container to calculate dynamic offset
    const badgeCount = container.querySelectorAll('.sd20-token-badge').length;
    const baseOffset = Math.max(MIN_OFFSET, badgeCount * OFFSET_PER_BADGE);
    const clampedScale = Math.min(OFFSET_SCALE_MAX, Math.max(OFFSET_SCALE_MIN, scale));
    const offset = baseOffset * clampedScale;
    leftPos -= offset;
  }

  // Update position
  container.style.left = `${leftPos}px`;
  container.style.top = `${tokenScreenY - container.offsetHeight - 4}px`;
}

/**
 * Register hooks for automatic syncing
 */
export function registerTokenStatusIcons() {
  // Global keyboard listener for number keys when a badge is hovered
  // This is the ONLY place keyboard input is handled for badges - no focus stealing
  document.addEventListener('keydown', async (e) => {
    // Only process if a badge is currently hovered
    if (!_hoveredBadge || !_hoveredToken) return;

    // Check if an input/textarea is focused - don't intercept those
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
      return;
    }

    // Check for number keys 0-9
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      e.stopPropagation();
      const value = parseInt(e.key);
      const { badge, token } = _hoveredBadge;

      if (badge.id === 'Dodged') {
        // Update dodge count - setting to 0 removes the badge
        await setDodgeCount(token.actor, value);
        debug(`Dodge set to ${value} for ${token.actor?.name}`);
      } else if (badge.isStatusEffect) {
        // Update status effect counter
        const statusId = badge.id.replace('status-', '');
        await setStatusEffectCounter(token.actor, statusId, value);
        debug(`Status ${statusId} counter set to ${value} for ${token.actor?.name}`);
      }

      // Clear hover state and re-sync badges to show updated value
      _hoveredBadge = null;
      _hoveredToken = null;
      syncTokenStatusIcons(token);
    }
  });

  // Sync all tokens when scene loads
  Hooks.on('canvasReady', () => {
    // Hide Foundry's default PIXI-based status effects on all tokens
    if (canvas?.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        if (token.effects) token.effects.visible = false;
      }
    }
    syncAllTokens();
    debug('Token status icons synced on canvas ready');
  });

  // Sync when a token is drawn/refreshed (handles drag movement in real-time)
  Hooks.on('refreshToken', (token) => {
    // Hide Foundry's default PIXI-based status effect icons
    // Uses custom HTML badge system instead
    if (token.effects) {
      token.effects.visible = false;
    }

    // If badge already exists, just update position for efficiency during drag
    if (token._sd20BadgeContainer) {
      updateBadgePosition(token);
    } else {
      syncTokenStatusIcons(token);
    }
  });

  // Update positions when a token document is updated (includes position changes)
  Hooks.on('updateToken', (tokenDoc, changes) => {
    if (changes.x !== undefined || changes.y !== undefined) {
      const token = canvas.tokens.get(tokenDoc.id);
      if (token) {
        // Small delay to ensure token visual has moved first
        requestAnimationFrame(() => updateBadgePosition(token));
      }
    }
  });

  // Update positions on canvas pan/zoom
  Hooks.on('canvasPan', () => {
    updateBadgePositions();
  });

  // Sync when actor data changes (flags or HP)
  Hooks.on('updateActor', (actor, changes) => {
    const flagsChanged = changes?.flags?.[MODULE];
    const hpChanged = changes?.system?.hp;
    if (flagsChanged || hpChanged) {
      syncTokensForActor(actor);
    }
  });

  // Sync when active effects change (status effects from Token HUD)
  Hooks.on('createActiveEffect', (effect) => {
    const actor = effect.parent;
    if (actor) syncTokensForActor(actor);
  });

  Hooks.on('deleteActiveEffect', (effect) => {
    const actor = effect.parent;
    if (actor) syncTokensForActor(actor);
  });

  Hooks.on('updateActiveEffect', (effect, changes) => {
    // Only sync if the counter or status changed
    if (changes?.flags?.core?.statusCounter !== undefined || changes?.statuses) {
      const actor = effect.parent;
      if (actor) syncTokensForActor(actor);
    }
  });

  // Clean up badges when token is deleted
  // Note: Token may already be removed from canvas.tokens by the time this hook fires
  // Clean up directly by token ID instead of trying to get the canvas token
  Hooks.on('deleteToken', (tokenDoc) => {
    // Clean up DOM elements directly by token ID (works even if token is gone from canvas)
    document.querySelectorAll(`.sd20-token-badges[data-token-id="${tokenDoc.id}"]`)
      .forEach(el => el.remove());

    // Also try canvas token cleanup if it still exists (for any PIXI references)
    const token = canvas.tokens.get(tokenDoc.id);
    if (token?._sd20BadgeContainer) {
      token._sd20BadgeContainer.remove();
      delete token._sd20BadgeContainer;
    }
  });

  // Clean up all badges when scene changes
  Hooks.on('canvasTearDown', () => {
    document.querySelectorAll('.sd20-token-badges').forEach(el => el.remove());
  });

  // Listen for right-click on canvas to trigger offset
  document.addEventListener('contextmenu', () => {
    // Check if right-click target is a token
    const controlled = canvas?.tokens?.controlled[0];
    if (controlled) {
      console.log('SD20: Right-click detected, token controlled:', controlled.name);
      _contextMenuOpen = true;
      _contextMenuOpenTime = Date.now();
      syncAllTokens();
    }
  });

  // Listen for clicks on canvas to close the context menu state
  // Ignore clicks within 300ms of opening (prevents immediate close)
  // Ignore clicks on UI elements (context menu items, etc.)
  document.addEventListener('click', (e) => {
    if (_contextMenuOpen && (Date.now() - _contextMenuOpenTime) > 300) {
      // Only reset if clicking on canvas, not on UI elements
      const isCanvasClick = e.target.closest('#board') || e.target.closest('canvas');
      if (isCanvasClick) {
        console.log('SD20: Canvas click detected, closing context menu state');
        _contextMenuOpen = false;
        syncAllTokens();
      }
    }
  });

  // Also listen for Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _contextMenuOpen) {
      console.log('SD20: Escape pressed, closing context menu state');
      _contextMenuOpen = false;
      syncAllTokens();
    }
  });

  debug('Token status icons registered');
}

/**
 * Debug helper: Inspect all status-related flags on an actor
 * Call from console: game.sd20.debugActorStatus(actor) or select a token and run game.sd20.debugActorStatus()
 */
export function debugActorStatus(actor) {
  // If no actor provided, try to get from controlled token
  if (!actor) {
    const token = canvas?.tokens?.controlled[0];
    actor = token?.actor;
  }

  if (!actor) {
    console.warn('SD20: No actor provided and no token selected');
    return;
  }

  console.group(`SD20 Status Debug: ${actor.name}`);

  // Get all status-related flags
  const buildup = actor.getFlag(MODULE, 'statusBuildup') || {};
  const conditions = actor.getFlag(MODULE, 'activeConditions') || {};
  const manualStatuses = actor.getFlag(MODULE, 'manualStatuses') || {};

  console.log('=== Status Buildup ===');
  console.table(Object.entries(buildup).map(([name, data]) => ({
    Name: name,
    Current: data?.current ?? 'N/A',
    'Triggers Highlight': (data?.current || 0) > 0 ? 'YES' : 'no'
  })));

  console.log('=== Active Conditions ===');
  console.table(Object.entries(conditions).map(([name, data]) => ({
    Name: name,
    Active: data?.active ?? 'N/A',
    Duration: data?.remainingRounds ?? 'indefinite',
    'Triggers Highlight': data?.active === true ? 'YES' : 'no'
  })));

  console.log('=== Manual Statuses ===');
  console.table(Object.entries(manualStatuses).map(([name, isActive]) => ({
    Name: name,
    Active: isActive,
    'Triggers Highlight': isActive === true ? 'YES' : 'no'
  })));

  const vulnerabilities = actor.getFlag(MODULE, 'vulnerabilities') || [];
  console.log('=== Vulnerabilities ===');
  console.table(vulnerabilities.map(v => ({
    Type: v.type,
    Tiers: v.tiers,
    Duration: v.duration,
    'Triggers Highlight': 'YES'
  })));

  // Summary
  const hasActive = hasActiveStatusEffects(actor);
  console.log(`=== Summary: Badge should be ${hasActive ? 'HIGHLIGHTED (orange)' : 'GRAY'} ===`);

  console.groupEnd();

  return { buildup, conditions, manualStatuses, vulnerabilities, shouldHighlight: hasActive };
}

/**
 * Clean up orphaned/invalid status flags on an actor
 * Removes any conditions or buildups that aren't in the valid lists
 * @param {Actor} actor - Actor to clean up (uses controlled token if not provided)
 * @returns {Promise<{removed: string[], kept: string[]}>}
 */
export async function cleanupActorStatus(actor) {
  if (!actor) {
    const token = canvas?.tokens?.controlled[0];
    actor = token?.actor;
  }

  if (!actor) {
    console.warn('SD20: No actor provided and no token selected');
    return { removed: [], kept: [] };
  }

  const removed = [];
  const kept = [];

  // Clean up conditions
  const conditions = actor.getFlag(MODULE, 'activeConditions') || {};
  const cleanedConditions = {};

  for (const [name, data] of Object.entries(conditions)) {
    if (VALID_CONDITIONS.has(name)) {
      cleanedConditions[name] = data;
      kept.push(`condition:${name}`);
    } else {
      removed.push(`condition:${name}`);
    }
  }

  // Clean up buildups
  const buildup = actor.getFlag(MODULE, 'statusBuildup') || {};
  const cleanedBuildup = {};

  for (const [name, data] of Object.entries(buildup)) {
    if (VALID_BUILDUPS.has(name)) {
      cleanedBuildup[name] = data;
      kept.push(`buildup:${name}`);
    } else {
      removed.push(`buildup:${name}`);
    }
  }

  // Apply cleaned data
  if (removed.length > 0) {
    await actor.setFlag(MODULE, 'activeConditions', cleanedConditions);
    await actor.setFlag(MODULE, 'statusBuildup', cleanedBuildup);

    // Sync tokens
    if (canvas?.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        if (token.actor?.id === actor.id) {
          syncTokenStatusIcons(token);
        }
      }
    }

    console.log(`SD20: Cleaned up ${actor.name} - removed:`, removed);
  } else {
    console.log(`SD20: No orphaned status data found for ${actor.name}`);
  }

  return { removed, kept };
}
