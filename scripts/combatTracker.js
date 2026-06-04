/**
 * Combat Tracker Enhancements
 * End Turn button, GM controls, auto-roll, and passive regeneration
 */

import { CONFIG } from './config.js';
import { log, debug, warn } from './utils.js';
import { postMaskedChat, canSeeActorName } from './permissions.js';
import {
  getActorCombatSettings, getActorStatusBuildup, getActorActiveConditions,
  applyDamageToActor, commitActorUpdates, isConditionActive,
  tickVulnerabilityDurations
} from './damageSystem.js';
import { syncTokenStatusIcons } from './tokenStatusIcons.js';
import { playRapidStatusAnimations, playStatusAnimation } from './animationSystem.js';
import { showDelayTurnDialog, gmExecuteDelay } from './delayTurnDialog.js';

const { DialogV2 } = foundry.applications.api;
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

/**
 * Register combat tracker settings
 */
export function registerCombatTrackerSettings() {
  // Initiative auto-roll toggle
  game.settings.register(CONFIG.MODULE_ID, 'autoRollInitiative', {
    name: 'Auto-Roll Initiative',
    hint: 'Automatically roll initiative for your tokens when combat starts',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true
  });

  // Passive regeneration setting (world-level for GM control)
  game.settings.register(CONFIG.MODULE_ID, 'enablePassiveRegen', {
    name: 'Enable Passive Regeneration',
    hint: 'Allow passive HP/FP regeneration at turn start (configured per token)',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });
}

/**
 * Register combat tracker enhancements
 */
export function registerCombatTracker() {
  Hooks.on('renderCombatTracker', (app, html) => {
    const el = html instanceof HTMLElement ? html : html[0] ?? html;
    addEndTurnButton(el);
    addGMControls(el);
    hidePlayerTurnArrows(el);
    maskNativeTrackerForPlayers(el);
  });

  // Auto-roll initiative when combat starts
  Hooks.on('combatStart', handleCombatStart);

  // Handle turn start for passive regeneration
  Hooks.on('updateCombat', handleTurnChange);

  game.socket.on(`system.${CONFIG.MODULE_ID}`, (data, userId) => {
    if (data.type === 'delayTurn' && game.user.isGM) {
      gmExecuteDelay(data, userId);
    }
  });

  Hooks.on('updateCombatant', _onCombatantDefeatedHook);

  log('Combat tracker enhancements registered');
}

/**
 * Helper: create a DOM element from an HTML string
 */
function htmlToElement(htmlString) {
  const t = document.createElement('template');
  t.innerHTML = htmlString.trim();
  return t.content.firstElementChild;
}

/**
 * Add End Turn button to combat tracker
 */
function addEndTurnButton(html) {
  const combat = game.combat;
  if (!combat?.started) return;

  // Check if current user can end turn
  const combatant = combat.combatant;
  if (!combatant) return;

  // Only add Delay button for players (GM uses Foundry's built-in controls)
  if (game.user.isGM) return;
  if (!combatant.isOwner) return;

  // Find the combat controls area
  const controls = html.querySelectorAll('.combat-control');
  if (controls.length === 0) return;

  // Check if button already exists
  if (html.querySelector('.sd20-delay-turn')) return;

  // Create Delay Turn button for players
  const delayTurnBtn = htmlToElement(`
    <a class="combat-control sd20-delay-turn" title="Delay Turn">
      <i class="fas fa-clock"></i> Delay
    </a>
  `);

  delayTurnBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    await showDelayTurnDialog(combatant, combat);
  });

  controls[controls.length - 1].insertAdjacentElement('afterend', delayTurnBtn);
}

function hidePlayerTurnArrows(html) {
  if (game.user.isGM) return;
  const selectors = [
    '[data-control="previousTurn"]',
    '[data-control="nextTurn"]',
    '[data-control="previousRound"]',
    '[data-control="nextRound"]',
    'button.combat-control.fa-arrow-left',
    'button.combat-control.fa-arrow-right',
    'button.combat-control.fa-step-backward',
    'button.combat-control.fa-step-forward',
    'a.combat-control.fa-arrow-left',
    'a.combat-control.fa-arrow-right'
  ];
  for (const sel of selectors) {
    html.querySelectorAll(sel).forEach(btn => { btn.style.display = 'none'; });
  }
}

function maskNativeTrackerForPlayers(html) {
  if (game.user.isGM) return;
  const combat = game.combat;
  if (!combat) return;

  const UNKNOWN_IMG = 'icons/svg/mystery-man.svg';

  html.querySelectorAll('.combatant').forEach(row => {
    const combatantId = row.dataset.combatantId;
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) return;

    const tokenDoc = combatant.token;
    const placedToken = tokenDoc ? canvas.tokens?.get(tokenDoc.id) : null;
    const visibleOnCanvas = placedToken ? placedToken.visible : true;
    const actor = combatant.actor;
    const nameRevealed = actor ? canSeeActorName(actor) : true;

    if (visibleOnCanvas && nameRevealed) return;

    const maskedName = visibleOnCanvas ? '???' : '?';
    const maskImage = !visibleOnCanvas;

    const nameEl = row.querySelector(
      '.token-name h4, .token-name strong, .token-name span, h4.name, .combatant-name, h4'
    );
    if (nameEl) {
      nameEl.textContent = maskedName;
      nameEl.removeAttribute('data-tooltip');
      nameEl.removeAttribute('title');
    }

    row.removeAttribute('data-tooltip');
    row.removeAttribute('title');
    row.setAttribute('aria-label', maskedName);

    if (maskImage) {
      const imgEl = row.querySelector('img.token-image, img');
      if (imgEl) {
        imgEl.src = UNKNOWN_IMG;
        imgEl.removeAttribute('data-tooltip');
        imgEl.removeAttribute('title');
        imgEl.alt = maskedName;
      }
    }
  });
}

function addGMControls(html) {
  if (!game.user.isGM) return;

  const combat = game.combat;
  if (!combat) return;

  // Add context menu to combatant entries
  html.querySelectorAll('.combatant').forEach((element) => {
    const combatantId = element.dataset.combatantId;
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) return;

    // Right-click context menu
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showCombatantContextMenu(event, combatant, combat);
    });
  });
}

/**
 * Show context menu for combatant (GM only)
 */
function showCombatantContextMenu(event, combatant, combat) {
  // Remove any existing context menu
  document.querySelectorAll('.sd20-context-menu').forEach(el => el.remove());

  const menu = htmlToElement(`
    <div class="sd20-context-menu">
      <div class="menu-item" data-action="skip">
        <i class="fas fa-forward"></i> Skip Turn
      </div>
      <div class="menu-item" data-action="move-up">
        <i class="fas fa-arrow-up"></i> Move Up
      </div>
      <div class="menu-item" data-action="move-down">
        <i class="fas fa-arrow-down"></i> Move Down
      </div>
      <div class="menu-item" data-action="remove">
        <i class="fas fa-trash"></i> Remove
      </div>
    </div>
  `);

  menu.style.position = 'fixed';
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';

  menu.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', async function() {
      const action = this.dataset.action;
      await handleCombatantAction(action, combatant, combat);
      menu.remove();
    });
  });

  // Close menu on click outside
  document.addEventListener('click', () => menu.remove(), { once: true });

  document.body.appendChild(menu);
}

/**
 * Handle combatant context menu action
 */
async function handleCombatantAction(action, combatant, combat) {
  switch (action) {
    case 'skip':
      if (combat.combatant?.id === combatant.id) {
        await combat.nextTurn();
      }
      break;

    case 'move-up':
      const currentInit = combatant.initiative ?? 0;
      await combatant.update({ initiative: currentInit + 1 });
      break;

    case 'move-down':
      const initValue = combatant.initiative ?? 0;
      await combatant.update({ initiative: Math.max(0, initValue - 1) });
      break;

    case 'remove':
      await combatant.delete();
      break;
  }
}

/**
 * End the current turn
 */
async function endCurrentTurn() {
  const combat = game.combat;
  if (!combat?.started) return;

  debug('Ending current turn');
  await combat.nextTurn();
}

/**
 * Handle combat start - auto-roll initiative for player tokens
 */
async function handleCombatStart(combat) {
  const autoRoll = game.settings.get(CONFIG.MODULE_ID, 'autoRollInitiative');
  if (!autoRoll) {
    debug('Auto-roll initiative disabled');
    return;
  }

  // Find combatants that belong to current user and have no initiative
  const myUnrolledCombatants = combat.combatants.filter(c => {
    // Must be owned by current user (or GM owns NPCs)
    const isOwner = c.isOwner || (game.user.isGM && !c.hasPlayerOwner);
    // Must not already have initiative
    const needsRoll = c.initiative === null || c.initiative === undefined;
    return isOwner && needsRoll;
  });

  if (myUnrolledCombatants.length === 0) {
    debug('No combatants need initiative roll');
    return;
  }

  debug(`Auto-rolling initiative for ${myUnrolledCombatants.length} combatants`);

  // Roll initiative for each combatant
  const ids = myUnrolledCombatants.map(c => c.id);
  await combat.rollInitiative(ids);

  ui.notifications.info(`Auto-rolled initiative for ${myUnrolledCombatants.length} combatant(s)`);
}

/**
 * Handle turn change - trigger passive regeneration at turn start
 */
async function handleTurnChange(combat, changed, _options, _userId) {
  // Only process on turn change
  if (!('turn' in changed) && !('round' in changed)) return;
  if (!combat?.started) return;

  const combatant = combat.combatant;
  if (!combatant) return;

  // Only process for tokens the current user controls
  if (!combatant.isOwner && !game.user.isGM) return;

  const token = combatant.token;
  if (!token) return;

  // Reset AP to max at turn start, but preserve bonus AP (over max from abilities)
  // Only restore if current AP is BELOW max - don't reduce if above max
  const actor = combatant.actor;
  if (actor) {
    const maxAP = actor.system?.ap?.max ?? CONFIG.COMBAT.DEFAULT_AP;
    const currentAP = actor.system?.ap?.value ?? 0;
    if (currentAP < maxAP) {
      await actor.update({ 'system.ap.value': maxAP });
      debug(`${combatant.name} AP restored to ${maxAP}`);
    } else if (currentAP > maxAP) {
      debug(`${combatant.name} has bonus AP (${currentAP}/${maxAP}) - preserving`);
    }
  }

  // Passive HP/FP regeneration (resource recovery happens before status effects per rulebook)
  const regenEnabled = game.settings.get(CONFIG.MODULE_ID, 'enablePassiveRegen');
  if (regenEnabled && actor) {
    // Read from actor combat settings (overrides.passiveRecovery.hpPerRound / fpPerRound)
    const settings = getActorCombatSettings(actor);
    const hpRegen = settings.overrides?.passiveRecovery?.hpPerRound || 0;
    const fpRegen = settings.overrides?.passiveRecovery?.fpPerRound || 0;
    if (hpRegen !== 0 || fpRegen !== 0) {
      await applyPassiveRegeneration(actor, hpRegen, fpRegen, combatant.name);
    }
  }

  // Turn-start automation: status effects/conditions procing and ending (GM only)
  if (actor && game.user.isGM) {
    await _processTurnStartAutomation(actor, token, combatant.name, combat.round);
  }

  // Handle AOE template duration tracking (GM only — scene document modifications require GM permissions)
  if (game.user.isGM) {
    // Determine previous combatant (whose turn just ended)
    // Use combat.previous if available (Foundry V11+), otherwise calculate from changed values
    let prevCombatant = null;

    debug(`[AOE Turn] Turn change detected: changed.turn=${changed.turn}, changed.round=${changed.round}, combat.turn=${combat.turn}, combat.round=${combat.round}`);
    debug(`[AOE Turn] combat.previous: ${JSON.stringify(combat.previous)}`);

    if (combat.previous?.combatantId) {
      // V11+ reliable method: use the stored previous combatant ID
      prevCombatant = combat.combatants.get(combat.previous.combatantId);
      debug(`[AOE Turn] Using combat.previous.combatantId: ${prevCombatant?.name || 'null'}`);
    } else {
      // Fallback for older versions: calculate from turn indices
      const prevTurn = (changed.turn !== undefined) ? changed.turn - 1 : null;
      const roundChanged = 'round' in changed;

      debug(`[AOE Turn] Fallback: prevTurn=${prevTurn}, roundChanged=${roundChanged}`);

      if (prevTurn !== null && prevTurn >= 0) {
        prevCombatant = combat.turns[prevTurn];
        debug(`[AOE Turn] Using prevTurn index ${prevTurn}: ${prevCombatant?.name || 'null'}`);
      } else if (roundChanged || (prevTurn !== null && prevTurn < 0)) {
        // Wrapped around to new round — previous was last combatant of prior round
        // But ONLY if this isn't the very first turn of combat
        const isFirstTurnEver = combat.round === 1 && combat.turn === 0 && !changed.round;
        if (!isFirstTurnEver) {
          prevCombatant = combat.turns[combat.turns.length - 1];
          debug(`[AOE Turn] Wrapped around - using last combatant: ${prevCombatant?.name || 'null'}`);
        } else {
          debug(`[AOE Turn] First turn of combat - no previous combatant`);
        }
      } else {
        debug(`[AOE Turn] No prevCombatant determined`);
      }
    }

    // Duration 0 (instant): remove at end of caster's turn
    if (prevCombatant) {
      debug(`[AOE Turn] Calling handleTemplateEndOfTurn for: ${prevCombatant.name}`);
      await handleTemplateEndOfTurn(prevCombatant);
    }

    // Duration >0: decrement at start of caster's turn
    await handleTemplateDuration(combatant);

    // Tick vulnerability durations at end of each combatant's turn
    if (prevCombatant?.actor) {
      await handleVulnerabilityDuration(prevCombatant.actor, combat.round);
    }
  }
}

/**
 * Decrement vulnerability durations on an actor at end of their turn
 */
async function handleVulnerabilityDuration(actor, currentRound) {
  if (!actor) return;

  const result = tickVulnerabilityDurations(actor, currentRound);

  // Always update if there are any vulnerabilities (to persist decremented durations)
  // or if any expired (to remove them)
  if (result.expired.length > 0 || result.remaining.length > 0) {
    // Use commitActorUpdates to properly prefix flag paths with 'flags.souls-d20.'
    await commitActorUpdates(actor, {}, result.flagUpdates);

    for (const vuln of result.expired) {
      debug(`Vulnerability ${vuln.type} expired on ${actor.name}`);
    }

    // Sync icons if needed
    const token = canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
    if (token) syncTokenStatusIcons(token);
  }
}

/**
 * Remove instant (duration 0) AOE templates when the current turn ends.
 * Duration 0 means "instant" — show the affected area, then remove when the turn ends.
 *
 * IMPORTANT: For duration 0, we check `turnCasterActorId` (whose turn it was when cast),
 * NOT `casterActorId` (who cast it). This handles reactions/opportunity attacks
 * that are used outside of your own turn.
 */
async function handleTemplateEndOfTurn(combatant) {
  if (!combatant?.actor) {
    debug(`[AOE Cleanup] No actor for combatant, skipping`);
    return;
  }
  if (!canvas.scene?.templates) {
    debug(`[AOE Cleanup] No scene templates, skipping`);
    return;
  }

  const actorId = combatant.actor.id;
  debug(`[AOE Cleanup] ========================================`);
  debug(`[AOE Cleanup] Checking templates at end of ${combatant.name}'s turn`);
  debug(`[AOE Cleanup] Actor ID: ${actorId}`);

  // Debug: log all templates on scene
  const allTemplates = canvas.scene.templates.contents;
  debug(`[AOE Cleanup] Total templates on scene: ${allTemplates.length}`);
  for (const t of allTemplates) {
    const flags = t.flags?.['souls-d20'];
    const durationVal = flags?.duration;
    const durationNum = Number(durationVal);
    const isInstant = durationVal !== undefined && durationNum === 0 && !isNaN(durationNum);
    // Show turnCasterActorId for duration 0 templates
    const turnCaster = flags?.turnCasterActorId || flags?.casterActorId;
    debug(`[AOE Cleanup]   Template "${flags?.macroName || 'unknown'}": turnCasterActorId=${turnCaster}, casterActorId=${flags?.casterActorId}, duration=${durationVal} (isInstant: ${isInstant})`);
  }

  // Use .contents to get array from EmbeddedCollection (V13 compatibility)
  const templates = allTemplates.filter(t => {
    const flags = t.flags?.['souls-d20'];
    if (!flags) return false;

    // Convert duration to number to handle both string and number cases
    const durationVal = flags.duration;
    const duration = Number(durationVal);

    // Only match if duration is explicitly 0 (not undefined/NaN)
    const isInstant = durationVal !== undefined && duration === 0 && !isNaN(duration);

    // For duration 0: use turnCasterActorId (whose turn it was when cast)
    // Fall back to casterActorId for backwards compatibility with old templates
    const turnCasterActorId = flags.turnCasterActorId || flags.casterActorId;
    const matchesTurn = turnCasterActorId === actorId;
    const matches = matchesTurn && isInstant;

    if (matchesTurn || flags.casterActorId === actorId) {
      debug(`[AOE Cleanup]   Checking "${flags.macroName}": turnCasterActorId=${turnCasterActorId}, matchesTurn=${matchesTurn}, isInstant=${isInstant}, MATCH=${matches}`);
    }
    return matches;
  });

  debug(`[AOE Cleanup] Found ${templates.length} instant templates to remove`);
  if (templates.length === 0) return;

  const toDelete = templates.map(t => t.id).filter(id => canvas.scene.templates.get(id));
  if (toDelete.length > 0) {
    await canvas.scene.deleteEmbeddedDocuments('MeasuredTemplate', toDelete);
    ui.notifications.info(`${toDelete.length} instant AOE template(s) removed (turn ended)`);
    for (const t of templates) {
      const name = t.flags?.['souls-d20']?.macroName || 'Unknown';
      debug(`Instant AOE "${name}" removed at end of ${combatant.name}'s turn`);
    }
  }
}

/**
 * Decrement AOE template durations and delete expired ones at the start of the caster's turn.
 * Duration >0: decrement each turn start, delete when reaching 0.
 * Duration -1: permanent (never removed).
 * Duration 0: handled by handleTemplateEndOfTurn (removed at turn end).
 */
async function handleTemplateDuration(combatant) {
  if (!combatant?.actor) return;
  if (!canvas.scene?.templates) return;

  const actorId = combatant.actor.id;
  // Use .contents for V13 EmbeddedCollection compatibility
  const allTemplates = canvas.scene.templates.contents;
  const templates = allTemplates.filter(t => {
    const flags = t.flags?.['souls-d20'];
    return flags?.casterActorId === actorId && flags?.duration > 0;
  });

  if (templates.length === 0) return;

  const toDelete = [];

  for (const template of templates) {
    const duration = template.flags['souls-d20'].duration;
    const newDuration = duration - 1;

    if (newDuration <= 0) {
      toDelete.push(template.id);
      const name = template.flags?.['souls-d20']?.macroName || 'Unknown';
      debug(`AOE template "${name}" expired for ${combatant.name}`);
    } else {
      await template.setFlag('souls-d20', 'duration', newDuration);
      debug(`AOE template duration: ${duration} -> ${newDuration} turns remaining`);
    }
  }

  if (toDelete.length > 0) {
    // Filter to only templates that still exist on the scene (use .get() for V13)
    const existing = toDelete.filter(id => canvas.scene.templates.get(id));
    if (existing.length > 0) {
      await canvas.scene.deleteEmbeddedDocuments('MeasuredTemplate', existing);
      ui.notifications.info(`${existing.length} AOE template(s) expired`);
    }
  }
}

/**
 * Apply passive regeneration to an actor
 * Applies HP/FP healing, caps at max (no overflow to temp HP)
 * Skips if already at max
 */
async function applyPassiveRegeneration(actor, hpRegen, fpRegen, name) {
  if (!actor) return;

  const messages = [];
  const updates = {};

  // HP regeneration (caps at max, no overflow)
  if (hpRegen > 0) {
    const currentHP = actor.system?.hp?.value ?? 0;
    const maxHP = actor.system?.hp?.max ?? 0;

    if (currentHP >= maxHP) {
      // Already at or above max HP - skip
      debug(`${name} HP already at max (${currentHP}/${maxHP}) - skipping passive HP regen`);
    } else {
      // Apply HP regen, cap at max
      const newHP = Math.min(currentHP + hpRegen, maxHP);
      const actualGain = newHP - currentHP;
      updates['system.hp.value'] = newHP;
      messages.push(`+${actualGain} HP`);
      debug(`${name} regenerates ${actualGain} HP (${currentHP} → ${newHP})`);
    }
  }

  // FP regeneration (caps at max)
  if (fpRegen > 0) {
    const currentFP = actor.system?.fp?.value ?? 0;
    const maxFP = actor.system?.fp?.max ?? 0;

    if (currentFP >= maxFP) {
      // Already at or above max FP - skip
      debug(`${name} FP already at max (${currentFP}/${maxFP}) - skipping passive FP regen`);
    } else {
      // Apply FP regen, cap at max
      const newFP = Math.min(currentFP + fpRegen, maxFP);
      const actualGain = newFP - currentFP;
      updates['system.fp.value'] = newFP;
      messages.push(`+${actualGain} FP`);
      debug(`${name} regenerates ${actualGain} FP (${currentFP} → ${newFP})`);
    }
  }

  // Apply updates if any
  if (Object.keys(updates).length > 0) {
    await actor.update(updates);
  }

  // Log to chat if anything was regenerated
  if (messages.length > 0) {
    postMaskedChat(actor, (displayName) =>
      `<div class="sd20-regen-message"><strong>${displayName}</strong> regenerates ${messages.join(', ')}</div>`
    );
  }
}

async function _zeroHpOnMarkDefeated(combatant) {
  const actor = combatant?.actor;
  if (!actor) return;
  const hp = actor.system?.hp;
  if (!hp) return;
  const updates = {};
  if ((hp.value ?? 0) !== 0) updates['system.hp.value'] = 0;
  if ((hp.temp ?? 0) !== 0) updates['system.hp.temp'] = 0;
  if (Object.keys(updates).length) await actor.update(updates);
}

async function _onCombatantDefeatedHook(combatant, change, _options, userId) {
  if (userId !== game.user.id) return;
  if (change.defeated !== true) return;
  if (!game.user.isGM) return;
  await _zeroHpOnMarkDefeated(combatant);
}

/* ========================================
   Turn-Start Automation (5.8)
   ======================================== */

/**
 * Process all turn-start effects for a combatant:
 * 1. Status buildup recovery
 * 2. Condition duration countdown
 * 3. Poison/Toxic DoT damage
 * 4. Bleed staunch prompt
 * 5. Injured indicator check
 */
async function _processTurnStartAutomation(actor, token, name, currentRound) {
  const chatLines = [];
  let systemUpdates = {};
  let flagUpdates = {};

  // 1. Status buildup recovery
  const recoveryResults = _calculateBuildupRecovery(actor);
  for (const rec of recoveryResults) {
    if (rec.amount <= 0) continue;
    const buildup = getActorStatusBuildup(actor);
    const current = buildup[rec.status]?.current || 0;
    const newVal = Math.max(0, current - rec.amount);
    flagUpdates[`statusBuildup.${rec.status}.current`] = newVal;

    // Reset poise tracking when buildup hits 0
    if (rec.status === 'Poise' && newVal === 0) {
      flagUpdates[`statusBuildup.Poise.instanceCount`] = 0;
      flagUpdates[`statusBuildup.Poise.totalDamage`] = 0;
    }

    if (current > 0) {
      chatLines.push(`Recovers ${rec.amount} ${rec.status} buildup (${current} → ${newVal})`);
    }
  }

  // 2. Condition duration countdown
  const conditions = getActorActiveConditions(actor);
  for (const [condName, condData] of Object.entries(conditions)) {
    if (!condData?.active) continue;

    // Check if this is a stackable condition with stackEntries
    if (condData.stackEntries && Array.isArray(condData.stackEntries)) {
      // Decrement each stack entry's remainingRounds
      const updatedEntries = [];
      let expiredStacks = 0;

      for (const entry of condData.stackEntries) {
        if (entry.remainingRounds == null) {
          // Indefinite entry - keep as is
          updatedEntries.push(entry);
        } else {
          // Decrement remaining rounds
          const newRounds = entry.remainingRounds - 1;
          if (newRounds > 0) {
            // Still has time remaining
            updatedEntries.push({ ...entry, remainingRounds: newRounds });
          } else {
            // Entry expired (reached 0)
            expiredStacks += entry.stacks;
          }
        }
      }

      if (updatedEntries.length === 0) {
        // All entries expired - deactivate condition
        flagUpdates[`activeConditions.${condName}`] = { active: false, stackEntries: [], totalStacks: 0 };
        chatLines.push(`No longer ${condName}`);
        const buildupName = CONDITION_TO_BUILDUP[condName];
        if (buildupName) {
          flagUpdates[`statusBuildup.${buildupName}.lastTriggeredRound`] = -1;
        }
      } else {
        // Update with remaining entries - set the entire condition object to ensure proper merge
        const newTotal = updatedEntries.reduce((sum, e) => sum + e.stacks, 0);
        flagUpdates[`activeConditions.${condName}`] = {
          active: true,
          stackEntries: updatedEntries,
          totalStacks: newTotal
        };
        if (expiredStacks > 0) {
          chatLines.push(`${condName}: ${expiredStacks} stack(s) expired, ${newTotal} remaining`);
        } else {
          chatLines.push(`${condName}: ${newTotal} stack(s)`);
        }
      }
      continue;
    }

    // Non-stackable condition - original behavior
    if (condData.remainingRounds == null) continue; // Indefinite conditions don't tick

    const newRounds = condData.remainingRounds - 1;
    if (newRounds <= 0) {
      // Expired — remove condition
      flagUpdates[`activeConditions.${condName}`] = { active: false, remainingRounds: 0 };
      chatLines.push(`No longer ${condName}`);
      // Reset buildup's lastTriggeredRound so it can accumulate again immediately
      const buildupName = CONDITION_TO_BUILDUP[condName];
      if (buildupName) {
        flagUpdates[`statusBuildup.${buildupName}.lastTriggeredRound`] = -1;
      }
    } else {
      flagUpdates[`activeConditions.${condName}.remainingRounds`] = newRounds;
      chatLines.push(`${condName}: ${newRounds} round(s) remaining`);
    }
  }

  // 3. Poison/Toxic DoT damage (goes through temp HP first)
  const maxHP = actor.system?.hp?.max || 1;
  let currentHP = actor.system?.hp?.value || 0;
  let currentTemp = actor.system?.hp?.temp || 0;
  const dotConditions = []; // Track which DoT conditions ticked for animations

  // Helper to apply DoT damage through temp HP first
  const applyDotDamage = (dmg, conditionName, displayName) => {
    if (dmg <= 0) return;
    let remaining = dmg;
    const breakdown = [];

    // Consume temp HP first
    if (currentTemp > 0 && remaining > 0) {
      const tempConsumed = Math.min(currentTemp, remaining);
      const newTemp = currentTemp - tempConsumed;
      remaining -= tempConsumed;
      systemUpdates['system.hp.temp'] = newTemp;
      breakdown.push(`Temp HP: ${currentTemp} → ${newTemp}`);
      currentTemp = newTemp; // Track for next DoT
    }

    // Apply remaining to current HP
    if (remaining > 0) {
      const hpBefore = systemUpdates['system.hp.value'] ?? currentHP;
      const newHP = Math.max(0, hpBefore - remaining);
      systemUpdates['system.hp.value'] = newHP;
      breakdown.push(`HP: ${hpBefore} → ${newHP}`);
      currentHP = newHP; // Track for next DoT
    }

    const breakdownStr = breakdown.length > 0 ? ` (${breakdown.join(', ')})` : '';
    chatLines.push(`${displayName} deals ${dmg} true damage${breakdownStr}`);
    dotConditions.push(conditionName);
  };

  if (isConditionActive(actor, 'Poisoned')) {
    const dotDmg = Math.floor(maxHP * 0.05);
    applyDotDamage(dotDmg, 'Poisoned', 'Poison');
  }

  if (isConditionActive(actor, 'BadlyPoisoned')) {
    const dotDmg = Math.floor(maxHP * 0.10);
    applyDotDamage(dotDmg, 'BadlyPoisoned', 'Toxic');
  }

  // Commit buildup recovery + condition countdown + DoT damage
  if (Object.keys(systemUpdates).length > 0 || Object.keys(flagUpdates).length > 0) {
    await commitActorUpdates(actor, systemUpdates, flagUpdates);
  }

  // Play DoT tick animations after commit - use rapid playback for multiple ticks
  if (token && dotConditions.length > 0) {
    playRapidStatusAnimations(token, dotConditions); // Plays all tick animations simultaneously
  }

  // 4. Bleed staunch prompt (needs to happen after commit, as it may update HP/AP)
  if (isConditionActive(actor, 'BledOut')) {
    await _handleBleedStaunch(actor, token, name, maxHP);
  }

  // 5. Injured indicator check (after all HP changes)
  _checkInjuredIndicator(actor);

  // Sync token status icons after all changes
  _syncActorTokens(actor);

  // Post automation chat log
  if (chatLines.length > 0) {
    const content = `
      <div class="sd20-turn-automation">
        <div class="turn-auto-header"><strong>${name}</strong> — Turn Start</div>
        <ul>${chatLines.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
    `;
    ChatMessage.create({
      content,
      speaker: { alias: name },
      whisper: game.users.filter(u => u.isGM).map(u => u.id)
    });
  }
}

/**
 * Calculate buildup recovery amounts per status effect
 * Base 1 for most, poise = floor(threshold / 2)
 * Modified by actor overrides and auras from nearby tokens
 */
function _calculateBuildupRecovery(actor) {
  const settings = getActorCombatSettings(actor);
  // Use selfRecoveryBonus (new name) with fallback to selfRecoveryModifier (old name) for backwards compat
  const selfMod = settings.overrides?.statusRecovery?.selfRecoveryBonus ?? settings.overrides?.statusRecovery?.selfRecoveryModifier ?? 0;
  const thresholds = actor.getFlag(MODULE, 'combat')?.statusThresholds || CONFIG.DEFAULT_THRESHOLDS;

  const results = [];

  for (const status of Object.values(CONFIG.STATUS_EFFECTS)) {
    // Skip if immune (no buildup to recover)
    if (settings.statusEffectImmunities[status]) continue;

    let baseRecovery = status === 'Poise' ? Math.floor((thresholds.Poise || 5) / 2) : 1;
    let recovery = baseRecovery + selfMod;

    // Check for aura effects from nearby tokens (pass status to filter by target)
    const auraEffect = _getAuraRecoveryEffect(actor, settings, status);
    if (auraEffect.prevented) {
      recovery = 0;
    } else {
      recovery += auraEffect.bonus;
    }

    results.push({ status, amount: Math.max(0, recovery) });
  }

  return results;
}

/**
 * Calculate hex distance (in rings/cells) between two tokens using BFS
 * 1 hex = directly adjacent, 2 hex = adjacent to adjacent, etc.
 */
function _calculateGridDistance(token1, token2) {
  if (!canvas?.grid) return Infinity;

  // Get grid cell coordinates for both tokens
  const cell1 = canvas.grid.getOffset({ x: token1.center.x, y: token1.center.y });
  const cell2 = canvas.grid.getOffset({ x: token2.center.x, y: token2.center.y });

  // Same cell = distance 0
  if (cell1.i === cell2.i && cell1.j === cell2.j) return 0;

  // BFS to find shortest path
  const isHex = canvas.grid.isHexagonal;
  const visited = new Set();
  const queue = [[cell1.i, cell1.j, 0]]; // [row, col, distance]
  visited.add(`${cell1.i},${cell1.j}`);

  // Limit search to reasonable distance (20 cells max)
  const maxSearch = 20;

  while (queue.length > 0) {
    const [row, col, dist] = queue.shift();

    // Check if the target was found
    if (row === cell2.i && col === cell2.j) {
      return dist;
    }

    // Don't expand beyond max search
    if (dist >= maxSearch) continue;

    // Get neighbors based on grid type
    const neighbors = _getNeighborOffsets(row, col, isHex);
    for (const [dr, dc] of neighbors) {
      const nr = row + dr;
      const nc = col + dc;
      const key = `${nr},${nc}`;

      if (!visited.has(key)) {
        visited.add(key);
        queue.push([nr, nc, dist + 1]);
      }
    }
  }

  return Infinity; // Not found within max search
}

/**
 * Get neighbor offsets based on grid type
 * For hex grids, neighbors depend on row/column parity
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
    const isOddCol = col % 2 === 1;
    if (isOddCol) {
      return [
        [-1, 0],  // top
        [0, -1],  // top-left
        [1, -1],  // bottom-left
        [1, 0],   // bottom
        [1, 1],   // bottom-right
        [0, 1]    // top-right
      ];
    } else {
      return [
        [-1, 0],  // top
        [-1, -1], // top-left
        [0, -1],  // bottom-left
        [1, 0],   // bottom
        [0, 1],   // bottom-right
        [-1, 1]   // top-right
      ];
    }
  } else {
    // Hexagonal Rows: pointy-top hexes using odd-r offset coordinates
    const isOddRow = row % 2 === 1;
    if (isOddRow) {
      return [
        [-1, 0],  // upper-left
        [-1, 1],  // upper-right
        [0, -1],  // left
        [0, 1],   // right
        [1, 0],   // lower-left
        [1, 1]    // lower-right
      ];
    } else {
      return [
        [-1, -1], // upper-left
        [-1, 0],  // upper-right
        [0, -1],  // left
        [0, 1],   // right
        [1, -1],  // lower-left
        [1, 0]    // lower-right
      ];
    }
  }
}

/**
 * Check aura effects on recovery from nearby tokens for a specific status effect
 * @param {Actor} actor - The actor being affected
 * @param {Object} ownSettings - The actor's own combat settings
 * @param {string} status - The status effect to check (e.g., 'Bleed', 'Poison', 'Poise')
 */
function _getAuraRecoveryEffect(actor, ownSettings, status) {
  let prevented = false;
  let bonus = 0;

  if (!canvas?.tokens?.placeables) return { prevented, bonus };

  // Find this actor's token position
  const ownToken = canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
  if (!ownToken) return { prevented, bonus };

  for (const otherToken of canvas.tokens.placeables) {
    if (!otherToken.actor || otherToken.actor.id === actor.id) continue;

    const otherSettings = getActorCombatSettings(otherToken.actor);
    const otherRecovery = otherSettings.overrides?.statusRecovery;
    if (!otherRecovery) continue;

    // Calculate distance in grid cells (hexes) using BFS
    // This correctly counts rings: 1 = adjacent, 2 = adjacent to adjacent, etc.
    const gridDistance = _calculateGridDistance(ownToken, otherToken);

    // Prevent recovery aura - check if this status is targeted
    if (otherRecovery.preventRecoveryRadius > 0 && gridDistance <= otherRecovery.preventRecoveryRadius) {
      // Check if this aura targets this specific status effect
      const targets = otherRecovery.preventRecoveryTargets || {};
      const targetsThisStatus = targets.all || targets[status];

      if (targetsThisStatus) {
        // Check exclude-self (the aura source excludes itself from its own aura)
        if (!(otherRecovery.preventRecoveryExcludeSelf && otherToken.actor.id === actor.id)) {
          prevented = true;
        }
      }
    }

    // Increase recovery aura - check if this status is targeted
    if (otherRecovery.increaseRecoveryRadius > 0 && gridDistance <= otherRecovery.increaseRecoveryRadius) {
      // Check if this aura targets this specific status effect
      const targets = otherRecovery.increaseRecoveryTargets || {};
      const targetsThisStatus = targets.all || targets[status];

      if (targetsThisStatus) {
        if (!(otherRecovery.increaseRecoveryExcludeSelf && otherToken.actor.id === actor.id)) {
          bonus += otherRecovery.increaseRecoveryAmount || 0;
        }
      }
    }
  }

  return { prevented, bonus };
}

/**
 * Handle Bled Out staunch prompt
 * Actor owner chooses: spend 2 AP to staunch, or take 10% max HP true damage
 */
async function _handleBleedStaunch(actor, token, name, maxHP) {
  const bleedDmg = Math.floor(maxHP * 0.10);
  const currentAP = actor.system?.ap?.value || 0;
  const canStaunch = currentAP >= 2;

  const content = `
    <p><strong>${name}</strong> is bleeding out!</p>
    <p>Spend 2 AP to staunch bleeding, or take ${bleedDmg} true damage.</p>
    ${!canStaunch ? '<p><em>(Not enough AP to staunch)</em></p>' : ''}
  `;

  let staunch = false;
  if (canStaunch) {
    staunch = await DialogV2.confirm({
      window: { title: `${name} — Bled Out`, icon: 'fa-solid fa-droplet' },
      content,
      yes: { label: 'Staunch (2 AP)', icon: 'fa-solid fa-bandage' },
      no: { label: `Take ${bleedDmg} Damage`, icon: 'fa-solid fa-heart-crack' }
    });
  }

  const flagUpdates = {};
  const systemUpdates = {};

  // Remove BledOut condition either way
  flagUpdates['activeConditions.BledOut'] = { active: false, remainingRounds: 0 };
  // Reset Bleed lastTriggeredRound so actor can gain Bleed buildup again immediately
  flagUpdates['statusBuildup.Bleed.lastTriggeredRound'] = -1;

  if (staunch) {
    systemUpdates['system.ap.value'] = currentAP - 2;
    postMaskedChat(actor, (displayName) =>
      `<strong>${displayName}</strong> staunches their bleeding (2 AP spent).`
    );
  } else {
    // Bleed damage goes through temp HP first
    let remaining = bleedDmg;
    const currentTemp = actor.system?.hp?.temp || 0;
    const currentHP = actor.system?.hp?.value || 0;
    const breakdown = [];

    if (currentTemp > 0 && remaining > 0) {
      const tempConsumed = Math.min(currentTemp, remaining);
      systemUpdates['system.hp.temp'] = currentTemp - tempConsumed;
      remaining -= tempConsumed;
      breakdown.push(`Temp HP: ${currentTemp} → ${currentTemp - tempConsumed}`);
    }

    if (remaining > 0) {
      const newHP = Math.max(0, currentHP - remaining);
      systemUpdates['system.hp.value'] = newHP;
      breakdown.push(`HP: ${currentHP} → ${newHP}`);
    }

    const breakdownStr = breakdown.length > 0 ? ` (${breakdown.join(', ')})` : '';
    postMaskedChat(actor, (displayName) =>
      `<strong>${displayName}</strong> takes ${bleedDmg} true damage from bleeding${breakdownStr}.`
    );
    // Play staunch bleeding animation (rapid playback for the damage tick)
    if (token) {
      playStatusAnimation(token, 'StaunchBleeding', true); // Uses StaunchBleedingTick animation
    }
  }

  await commitActorUpdates(actor, systemUpdates, flagUpdates);
}

/**
 * Check and update Injured indicator based on HP threshold
 */
function _checkInjuredIndicator(actor) {
  const hp = actor.system?.hp;
  if (!hp || hp.max <= 0) return;

  const isInjured = hp.value > 0 && hp.value <= hp.max * CONFIG.COMBAT.INJURED_THRESHOLD;
  // Injured indicator is visual-only, handled by tokenStatusIcons via HP check
  // No flag needed — tokenStatusIcons reads HP directly
}

/**
 * Sync status icons for all tokens belonging to an actor
 */
function _syncActorTokens(actor) {
  if (!canvas?.tokens?.placeables) return;
  for (const token of canvas.tokens.placeables) {
    if (token.actor?.id === actor.id) {
      syncTokenStatusIcons(token);
    }
  }
}

