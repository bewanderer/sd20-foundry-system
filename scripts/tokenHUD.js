/**
 * Token HUD Enhancement
 * - Adds SD20 combat settings button to the Token HUD
 * - Replaces default status effects palette with SD20 conditions
 * Accessible to GMs and token owners
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';
import { openCombatSettings } from './combatSettings.js';
import { syncTokenStatusIcons, setDodgeCount } from './tokenStatusIcons.js';

const MODULE = CONFIG.MODULE_ID;

// Reverse mapping: triggered condition -> originating buildup
// When a condition is removed, reset the buildup's lastTriggeredRound so it can accumulate again
const CONDITION_TO_BUILDUP = {
  BledOut: 'Bleed',
  Poisoned: 'Poison',
  BadlyPoisoned: 'Toxic',
  Frostbitten: 'Frost',
  Cursed: 'Curse',
  Staggered: 'Poise'
};

// SD20 Status Effects Palette Definition
// Categories: buildup (status buildups), condition (status conditions), manual (visual-only)
const SD20_STATUS_PALETTE = {
  // Buildup statuses
  buildup: [
    { id: 'Bleed', label: 'Bleed', icon: 'fa-solid fa-droplet', color: '#c0c0c0' },
    { id: 'Poison', label: 'Poison', icon: 'fa-solid fa-skull-crossbones', color: '#9c27b0' },
    { id: 'Toxic', label: 'Toxic', icon: 'fa-solid fa-biohazard', color: '#7b68ee' },
    { id: 'Frost', label: 'Frost', icon: 'fa-solid fa-snowflake', color: '#00bcd4' },
    { id: 'Curse', label: 'Curse', icon: 'fa-solid fa-ghost', color: '#8b008b' },
    { id: 'Poise', label: 'Poise', icon: 'fa-solid fa-shield-halved', color: '#ff4500' }
  ],
  // Conditions
  condition: [
    { id: 'BledOut', label: 'Bled Out', icon: 'fa-solid fa-heart-crack', color: '#f44336' },
    { id: 'Poisoned', label: 'Poisoned', icon: 'fa-solid fa-flask', color: '#9c27b0' },
    { id: 'BadlyPoisoned', label: 'Badly Poisoned', icon: 'fa-solid fa-flask-vial', color: '#7b68ee' },
    { id: 'Frostbitten', label: 'Frostbitten', icon: 'fa-solid fa-icicles', color: '#00bcd4' },
    { id: 'Cursed', label: 'Cursed', icon: 'fa-solid fa-moon', color: '#8b008b' },
    { id: 'Staggered', label: 'Staggered', icon: 'fa-solid fa-person-falling', color: '#ffa500' },
    { id: 'Dazed', label: 'Dazed', icon: 'fa-solid fa-star-half-stroke', color: '#ffd700' },
    { id: 'Berserk', label: 'Berserk', icon: 'fa-solid fa-fire', color: '#f44336' },
    { id: 'Frenzy', label: 'Frenzy', icon: 'fa-solid fa-burst', color: '#ff4500' },
    { id: 'Exhaustion', label: 'Exhaustion', icon: 'fa-solid fa-bed', color: '#999999' },
    { id: 'Grappled', label: 'Grappled', icon: 'fa-solid fa-hands', color: '#ffa500' },
    { id: 'Restrained', label: 'Restrained', icon: 'fa-solid fa-lock', color: '#ffa500' },
    { id: 'Prone', label: 'Prone', icon: 'fa-solid fa-person-arrow-down-to-line', color: '#ffa500' },
    { id: 'Mounting', label: 'Mounting', icon: 'fa-solid fa-horse', color: '#4caf50' },
    { id: 'ImpairedVision', label: 'Impaired Vision', icon: 'fa-solid fa-eye-slash', color: '#999999' },
    { id: 'Deafened', label: 'Deafened', icon: 'fa-solid fa-ear-deaf', color: '#999999' },
    { id: 'LimbFracture', label: 'Limb Fracture', icon: 'fa-solid fa-bone', color: '#f44336' },
    { id: 'LockedUp', label: 'Locked Up', icon: 'fa-solid fa-person-circle-xmark', color: '#f44336' }
  ],
  // Manual visual-only icons (not automated)
  manual: [
    { id: 'Buff', label: 'Buff', icon: 'fa-solid fa-arrow-up', color: '#4caf50' },
    { id: 'Debuff', label: 'Debuff', icon: 'fa-solid fa-arrow-down', color: '#f44336' },
    { id: 'SlowAction', label: 'Slow Action', icon: 'fa-solid fa-hourglass-half', color: '#ffa500' },
    { id: 'Concentrating', label: 'Concentrating', icon: 'fa-solid fa-brain', color: '#9c27b0' },
    { id: 'Marked', label: 'Marked', icon: 'fa-solid fa-crosshairs', color: '#f44336' },
    { id: 'Hidden', label: 'Hidden', icon: 'fa-solid fa-eye-low-vision', color: '#666666' }
  ]
};

/**
 * Register Token HUD button hook
 */
export function registerTokenHUD() {
  Hooks.on('renderTokenHUD', (app, html) => {
    addSD20HUDButton(app, html);
    replaceStatusEffectsPalette(app, html);
  });

  log('Token HUD SD20 button registered');
}

/**
 * Add SD20 combat settings button to Token HUD
 */
function addSD20HUDButton(app, html) {
  const token = app.object;
  if (!token) return;

  const actor = token.actor;
  if (!actor) return;

  // Only show for GMs or token owners
  if (!game.user.isGM && !actor.isOwner) return;

  // html may be HTMLElement or jQuery — handle both
  const el = html instanceof HTMLElement ? html : (html[0] || html);
  const rightColumn = el.querySelector('.col.right');

  // Create Combat Settings button
  const settingsButton = document.createElement('div');
  settingsButton.classList.add('control-icon', 'sd20-hud-settings');
  settingsButton.setAttribute('title', 'Combat Settings');
  settingsButton.dataset.action = 'sd20-settings';
  settingsButton.innerHTML = `<i class="fas fa-shield-halved"></i>`;

  // Click: open combat settings for this token's actor
  // Pass the token so unlinked tokens save to their own delta
  settingsButton.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCombatSettings(actor, token);
  });

  // Create Dodge toggle button
  const dodgeButton = createDodgeButton(token, actor, app);

  // Add buttons to HUD
  if (rightColumn) {
    rightColumn.prepend(settingsButton);
    rightColumn.prepend(dodgeButton); // Dodge above Combat Settings
  } else {
    const attr = el.querySelector('.attribute');
    if (attr) {
      attr.after(settingsButton);
      attr.after(dodgeButton);
    }
  }
}

/**
 * Create the Dodge toggle button for Token HUD
 * Click: toggles dodge badge on/off (add 1 or remove all)
 * No keyboard handling here - that's handled by the token badge hover + global listener
 */
function createDodgeButton(token, actor, app) {
  const dodgeCount = actor.getFlag(MODULE, 'dodgeCount') || 0;
  const isActive = dodgeCount > 0;

  const button = document.createElement('div');
  button.classList.add('control-icon', 'sd20-hud-dodge');
  if (isActive) button.classList.add('active');
  button.setAttribute('title', `Dodge (${dodgeCount}) - Click to toggle on/off`);
  button.dataset.action = 'sd20-dodge';
  button.innerHTML = `<i class="fa-solid fa-person-running-fast"></i>`;
  if (isActive) {
    button.innerHTML += `<span class="dodge-count">${dodgeCount}</span>`;
  }

  // Click: toggle dodge (if active, remove all; if inactive, add 1)
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isActive) {
      await setDodgeCount(actor, 0);
      log(`Removed dodge from ${actor.name}`);
    } else {
      await setDodgeCount(actor, 1);
      log(`Added dodge to ${actor.name}`);
    }
    syncTokenStatusIcons(token);
    app.render();
  });

  // NO keyboard handler here - keyboard input is handled by
  // hovering over the badge on the token + the global keyboard listener
  // in tokenStatusIcons.js. This prevents focus-stealing issues.

  return button;
}

/**
 * Replace the default status effects palette with SD20 custom conditions
 * Displayed as badges with hover+number functionality for setting duration
 */
function replaceStatusEffectsPalette(app, html) {
  const token = app.object;
  if (!token) return;

  const actor = token.actor;
  if (!actor) return;

  // Only allow editing for GMs or token owners
  const canEdit = game.user.isGM || actor.isOwner;

  // html may be HTMLElement or jQuery — handle both
  const el = html instanceof HTMLElement ? html : (html[0] || html);

  // Find the status effects palette
  const effectsButton = el.querySelector('[data-action="effects"]');
  if (!effectsButton) return;

  // Get the status effects wrapper/container
  const statusEffects = el.querySelector('.status-effects');
  if (!statusEffects) return;

  // Get current active states from actor flags
  const activeConditions = actor.getFlag(MODULE, 'activeConditions') || {};
  const manualStatuses = actor.getFlag(MODULE, 'manualStatuses') || {};

  // Clear existing effects completely and replace with SD20 palette
  statusEffects.innerHTML = '';
  statusEffects.classList.add('sd20-status-palette');

  // Create category sections
  const categories = [
    { key: 'condition', title: 'Conditions', items: SD20_STATUS_PALETTE.condition },
    { key: 'manual', title: 'Manual', items: SD20_STATUS_PALETTE.manual }
  ];

  for (const category of categories) {
    const section = document.createElement('div');
    section.className = 'sd20-palette-section';

    const header = document.createElement('div');
    header.className = 'sd20-palette-header';
    header.textContent = category.title;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'sd20-palette-grid';

    for (const status of category.items) {
      const isCondition = category.key === 'condition';
      const isActive = isCondition
        ? activeConditions[status.id]?.active
        : manualStatuses[status.id];
      const duration = isCondition ? (activeConditions[status.id]?.remainingRounds ?? null) : null;

      // Create badge-style item
      const badge = document.createElement('div');
      badge.className = `sd20-palette-badge ${isActive ? 'active' : ''}`;
      badge.dataset.statusId = status.id;
      badge.dataset.statusType = category.key;
      badge.title = `${status.label}${canEdit ? ' - Click to toggle, hover + 0-9 to set duration' : ''}`;

      // Badge content wrapper
      const badgeContent = document.createElement('div');
      badgeContent.className = 'sd20-badge-content';

      // Icon
      const icon = document.createElement('i');
      icon.className = status.icon;
      icon.style.color = isActive ? status.color : '#666';
      badgeContent.appendChild(icon);

      // Label
      const label = document.createElement('span');
      label.className = 'sd20-badge-label';
      label.textContent = status.label;
      badgeContent.appendChild(label);

      badge.appendChild(badgeContent);

      // Duration badge (for conditions)
      if (isCondition && isActive) {
        const durationBadge = document.createElement('span');
        durationBadge.className = 'sd20-badge-duration';
        durationBadge.textContent = duration !== null ? duration : '∞';
        badge.appendChild(durationBadge);
      }

      if (canEdit) {
        badge.style.cursor = 'pointer';

        // Click: toggle status
        badge.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await toggleStatus(token, status.id, category.key, !isActive);
          app.render();
        });

        // Hover + number: set duration (conditions only)
        if (isCondition) {
          const keyHandler = async (e) => {
            // Don't intercept if typing in an input
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
              return;
            }

            const num = parseInt(e.key);
            if (!isNaN(num) && num >= 0 && num <= 9) {
              e.preventDefault();
              e.stopPropagation();
              // Set duration: 0 = deactivate, 1-9 = set rounds
              if (num === 0) {
                await setStatusDuration(actor, status.id, null, false);
                log(`Deactivated ${status.label} for ${actor.name}`);
              } else {
                await setStatusDuration(actor, status.id, num, true);
                log(`Set ${status.label} duration to ${num} rounds for ${actor.name}`);
              }
              syncTokenStatusIcons(token);
              app.render();
            }
          };

          badge.addEventListener('mouseenter', () => {
            document.addEventListener('keydown', keyHandler);
          });

          badge.addEventListener('mouseleave', () => {
            document.removeEventListener('keydown', keyHandler);
          });
        }
      }

      grid.appendChild(badge);
    }

    section.appendChild(grid);
    statusEffects.appendChild(section);
  }

  debug('SD20 status palette rendered');
}

/**
 * Set a condition's duration and active state
 */
async function setStatusDuration(actor, statusId, duration, active) {
  if (!actor) return;
  const conditions = actor.getFlag(MODULE, 'activeConditions') || {};
  conditions[statusId] = {
    active: active,
    remainingRounds: active ? duration : null
  };
  await actor.setFlag(MODULE, 'activeConditions', conditions);

  // When deactivating, reset buildup's lastTriggeredRound so it can accumulate again
  if (!active) {
    const buildupName = CONDITION_TO_BUILDUP[statusId];
    if (buildupName) {
      const buildup = actor.getFlag(MODULE, 'statusBuildup') || {};
      if (buildup[buildupName]) {
        buildup[buildupName].lastTriggeredRound = -1;
        await actor.setFlag(MODULE, 'statusBuildup', buildup);
      }
    }
  }
}

/**
 * Toggle a status on a token
 */
async function toggleStatus(token, statusId, statusType, active) {
  const actor = token.actor;
  if (!actor) return;

  if (statusType === 'condition') {
    const conditions = actor.getFlag(MODULE, 'activeConditions') || {};
    if (active) {
      conditions[statusId] = { active: true, remainingRounds: null };
    } else {
      conditions[statusId] = { active: false, remainingRounds: null };
      // Reset buildup's lastTriggeredRound so it can accumulate again
      const buildupName = CONDITION_TO_BUILDUP[statusId];
      if (buildupName) {
        const buildup = actor.getFlag(MODULE, 'statusBuildup') || {};
        if (buildup[buildupName]) {
          buildup[buildupName].lastTriggeredRound = -1;
          await actor.setFlag(MODULE, 'statusBuildup', buildup);
        }
      }
    }
    await actor.setFlag(MODULE, 'activeConditions', conditions);
  } else if (statusType === 'manual') {
    const manualStatuses = actor.getFlag(MODULE, 'manualStatuses') || {};
    manualStatuses[statusId] = active;
    await actor.setFlag(MODULE, 'manualStatuses', manualStatuses);
  }

  // Sync token status icons
  syncTokenStatusIcons(token);
  log(`Toggled ${statusId} to ${active} for ${actor.name}`);
}