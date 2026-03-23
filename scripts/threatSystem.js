/**
 * Threat Event System
 * Creates threat events from macro execution, manages defender responses,
 * and resolves components through the damage calculation pipeline.
 */

import { CONFIG } from './config.js';
import { debug, log } from './utils.js';
import {
  calculateDamage, calculateStatusBuildup, calculateRestoration,
  rollStatusConditionDC, applyDamageToActor, applyBuildupToActor,
  applyRestorationToActor, applyConditionToActor, commitActorUpdates,
  getActorCombatSettings, getStatusTriggerEffect, isConditionActive,
  buildChatBreakdown, applyVulnerabilityToActor, getVulnerabilityForDamageType,
  // CF4: Protection functions
  applyDamageProtectionToActor, applyBuildupProtectionToActor, applyConditionProtectionToActor
} from './damageSystem.js';
import { syncTokenStatusIcons } from './tokenStatusIcons.js';
import { playMacroAnimation, isAnimationSystemAvailable, playStatusAnimation } from './animationSystem.js';

const MODULE = CONFIG.MODULE_ID;
const { DialogV2 } = foundry.applications.api;

// In-memory store of pending threat events
const pendingEvents = new Map();

// Execution batch tracking for macro chaining
// Maps executionId → { eventIds: Set, resolvedIds: Set, callback: Function }
const _executionBatches = new Map();

// Reference to the ruling panel (set during registration)
let _rulingPanel = null;

/* ========================================
   Event Store Accessors
   ======================================== */

export function getEvent(eventId) {
  return pendingEvents.get(eventId);
}

export function getAllPendingEvents() {
  // Only return events where defender has responded (not PENDING)
  // This hides events from the GM until the player accepts/reacts or timeout occurs
  const readyEvents = Array.from(pendingEvents.values())
    .filter(e => e.defenderResponse !== CONFIG.DEFENDER_RESPONSES.PENDING);
  // Newest first
  return readyEvents.reverse();
}

export function getPendingCount() {
  let count = 0;
  for (const event of pendingEvents.values()) {
    // Only count components from events where defender has responded
    if (event.defenderResponse === CONFIG.DEFENDER_RESPONSES.PENDING) continue;
    for (const comp of event.components) {
      if (comp.ruling === CONFIG.RULING_STATES.PENDING) count++;
    }
  }
  return count;
}

export function clearAllEvents() {
  pendingEvents.clear();
  _executionBatches.clear();
  _notifyPanel();
  log('All threat events cleared');
}

/* ========================================
   Execution Batch Tracking (Macro Chaining)
   ======================================== */

/** Track an event as part of an execution batch */
function _trackBatchEvent(executionId, eventId, animationContext = null) {
  if (!_executionBatches.has(executionId)) {
    _executionBatches.set(executionId, { eventIds: new Set(), callback: null, animationContext: null });
  }
  const batch = _executionBatches.get(executionId);
  batch.eventIds.add(eventId);
  // Store animation context on first event (all events in batch share the same animation)
  if (animationContext && !batch.animationContext) {
    batch.animationContext = animationContext;
  }
}

/** Check if all events in a batch are fully resolved; if so, fire the callback and play animation */
async function _checkBatchCompletion(executionId) {
  const batch = _executionBatches.get(executionId);
  if (!batch) return;

  for (const eid of batch.eventIds) {
    const event = pendingEvents.get(eid);
    // Event still pending — not all resolved yet
    if (event) return;
  }

  // All events resolved (removed from pendingEvents)
  _executionBatches.delete(executionId);
  debug(`Execution batch ${executionId} complete`);

  // Play deferred animation if configured
  if (batch.animationContext && isAnimationSystemAvailable()) {
    try {
      const ctx = batch.animationContext;
      const caster = canvas.tokens.get(ctx.casterTokenId);
      const targets = (ctx.targetTokenIds || []).map(id => canvas.tokens.get(id)).filter(Boolean);

      // Get template - try canvas.templates.get() first, fall back to canvas.scene.templates.get()
      // V13 may have templates in different locations depending on render state
      let template = null;
      if (ctx.templateId) {
        template = canvas.templates?.get(ctx.templateId)
          || canvas.templates?.placeables?.find(t => t.id === ctx.templateId)
          || canvas.scene?.templates?.get(ctx.templateId);
        if (!template) {
          debug(`[THREAT SYSTEM] Template ${ctx.templateId} not found on canvas or scene`);
        }
      }

      debug(`[THREAT SYSTEM] Playing deferred animation for batch ${executionId}`);
      debug(`[THREAT SYSTEM]   Caster: ${caster?.name || 'unknown'} (${ctx.casterTokenId})`);
      debug(`[THREAT SYSTEM]   Targets: ${targets.map(t => t.name).join(', ') || 'none'}`);
      debug(`[THREAT SYSTEM]   Template: ${template?.id || ctx.templateId || 'none'} (found: ${!!template})`);
      debug(`[THREAT SYSTEM]   Exclusion radius: ${ctx.exclusionRadius || 0}`);

      if (caster) {
        await playMacroAnimation({
          caster,
          targets,
          template,
          animConfig: ctx.animConfig,
          isHidden: ctx.isHidden,
          exclusionRadius: ctx.exclusionRadius || 0
        });
        debug(`[THREAT SYSTEM] Animation playback complete for batch ${executionId}`);
      } else {
        debug(`[THREAT SYSTEM] Skipping animation - caster token not found`);
      }
    } catch (err) {
      console.warn('Failed to play batch animation:', err);
      debug(`[THREAT SYSTEM] Animation error: ${err.message}`);
    }
  } else if (batch.animationContext) {
    debug(`[THREAT SYSTEM] Animation system not available, skipping deferred animation`);
  }

  // Fire callback if registered
  if (typeof batch.callback === 'function') {
    debug(`Firing batch callback`);
    try {
      batch.callback();
    } catch (err) {
      console.error('SD20 | Execution batch callback error:', err);
    }
  }
}

/**
 * Register a callback for when all events in an execution batch are resolved.
 * Call this after creating all threat/restoration events for one macro execution.
 * @param {string} executionId - Unique ID for this execution
 * @param {Function} callback - Called when all events are fully resolved
 */
export function registerExecutionBatch(executionId, callback) {
  const batch = _executionBatches.get(executionId);
  if (!batch) {
    // No events were tagged with this executionId — fire immediately
    debug(`Execution batch ${executionId} has no events, firing callback immediately`);
    try { callback(); } catch (err) { console.error('SD20 | Execution batch callback error:', err); }
    return;
  }
  batch.callback = callback;
  // Check in case all events already resolved before callback was registered
  _checkBatchCompletion(executionId);
}

/* ========================================
   Event Creation
   ======================================== */

/**
 * Create a threat event from macro execution results
 * @param {Token} attackerToken - The attacking token
 * @param {Token} defenderToken - The defending token
 * @param {Object} macro - The macro that was executed
 * @param {Object} combatResults - Roll results from executeMacro
 * @param {Object} deferredChatData - Chat message data to post when ruling is approved (optional)
 * @param {string|null} executionId - Optional batch ID for tracking macro execution completion
 * @param {Object|null} animationContext - Animation data for deferred playback after ruling
 */
export function createThreatEvent(attackerToken, defenderToken, macro, combatResults, deferredChatData = null, executionId = null, animationContext = null) {
  const defenderActor = defenderToken.actor;
  if (!defenderActor) {
    debug('No actor on defender token, skipping threat event');
    return null;
  }

  const settings = getActorCombatSettings(defenderActor);
  const eventId = foundry.utils.randomID();

  const components = [];

  // Map damage rolls
  const damageRolls = combatResults.damageRolls || [];
  for (let i = 0; i < damageRolls.length; i++) {
    const dmg = damageRolls[i];
    const comp = {
      id: foundry.utils.randomID(),
      type: 'damage',
      originalIndex: i,  // Track original index for progressive reveal
      damageType: dmg.type,
      rawAmount: dmg.total,
      formula: dmg.formula,
      piercing: dmg.piercing || { tiers: 0, allTiers: false },
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      isImmune: false,
      result: null
    };
    // Flag as immune but keep PENDING so GM can still rule
    if (settings.damageImmunities[dmg.type]) {
      comp.isImmune = true;
      comp.autoReason = 'immune';
    }
    components.push(comp);
  }

  // Map buildup rolls
  const buildupRolls = combatResults.buildupRolls || [];
  for (let i = 0; i < buildupRolls.length; i++) {
    const eff = buildupRolls[i];
    const comp = {
      id: foundry.utils.randomID(),
      type: 'status-buildup',
      originalIndex: i,  // Track original index for progressive reveal
      statusEffect: eff.name,
      rawAmount: eff.total,
      formula: eff.formula,
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      isImmune: false,
      result: null
    };
    // Flag as immune but keep PENDING so GM can still rule
    if (settings.statusEffectImmunities[eff.name]) {
      comp.isImmune = true;
      comp.autoReason = 'immune';
    }
    components.push(comp);
  }

  // Map condition rolls
  const conditionRolls = combatResults.conditionRolls || [];
  for (let i = 0; i < conditionRolls.length; i++) {
    const cond = conditionRolls[i];
    const comp = {
      id: foundry.utils.randomID(),
      type: 'status-condition',
      originalIndex: i,  // Track original index for progressive reveal
      condition: cond.name,
      duration: cond.duration || 0,
      dc: cond.dc || 0,
      dcBonusSource: cond.dcBonusSource || 'none',
      dcBonusResolved: cond.dcBonusResolved ?? 0,
      totalDC: cond.totalDC ?? cond.dc ?? 0,
      saveType: cond.saveType || '',
      stacks: cond.stacks ?? 1,
      stacking: cond.stacking ?? false,
      sourceId: macro?.id || macro?.uuid || 'unknown',
      sourceName: macro?.name || 'Unknown',
      casterId: attackerToken?.id || attackerToken?.actor?.id || 'unknown',
      casterName: attackerToken?.name || 'Unknown',
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      isImmune: false,
      result: null
    };
    // Flag as immune but keep PENDING so GM can still rule
    if (settings.statusConditionImmunities[cond.name]) {
      comp.isImmune = true;
      comp.autoReason = 'immune';
    }
    components.push(comp);
  }

  // Map vulnerability effects
  const vulnerabilityRolls = combatResults.vulnerabilityRolls || [];
  for (let i = 0; i < vulnerabilityRolls.length; i++) {
    const vuln = vulnerabilityRolls[i];
    const comp = {
      id: foundry.utils.randomID(),
      type: 'vulnerability',
      originalIndex: i,  // Track original index for progressive reveal
      damageType: vuln.type,
      tiers: vuln.tiers || 1,
      duration: vuln.duration || 3,
      timing: vuln.timing || 'before',
      stacking: vuln.stacking || false,
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      result: null
    };
    components.push(comp);
  }

  // Sort components so 'before' vulnerabilities come before damage
  // This ensures when using "Approve All", vulnerabilities are applied before damage is calculated
  // Order: before-vulnerabilities → damage → buildup → conditions → after-vulnerabilities
  const typeOrder = {
    'vulnerability-before': 0,
    'damage': 1,
    'status-buildup': 2,
    'status-condition': 3,
    'vulnerability-after': 4
  };
  components.sort((a, b) => {
    const getOrder = (c) => {
      if (c.type === 'vulnerability') {
        return c.timing === 'before' ? typeOrder['vulnerability-before'] : typeOrder['vulnerability-after'];
      }
      return typeOrder[c.type] ?? 99;
    };
    return getOrder(a) - getOrder(b);
  });

  // NOTE: Restoration components do NOT go through threat events.
  // They are handled separately via createRestorationEvent().

  // Skip if no components
  if (components.length === 0) return null;

  // Determine if defender is player-owned before creating event
  const defenderOwners = Object.entries(defenderActor.ownership || {})
    .filter(([id, level]) => id !== 'default' && level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
    .map(([id]) => id);

  const isNPC = defenderOwners.length === 0 ||
    defenderOwners.every(id => game.users.get(id)?.isGM);

  const event = {
    id: eventId,
    attackerId: attackerToken.id,
    attackerName: attackerToken.name,
    attackerActorId: attackerToken.actor?.id,
    defenderId: defenderToken.id,
    defenderName: defenderToken.name,
    defenderActorId: defenderActor.id,
    macroName: macro.name,
    timestamp: Date.now(),
    // NPC targets immediately show in ruling panel (ACCEPT); player targets wait for response
    defenderResponse: isNPC ? CONFIG.DEFENDER_RESPONSES.ACCEPT : CONFIG.DEFENDER_RESPONSES.PENDING,
    components,
    // Store deferred chat data to post when ruling is approved
    deferredChatData,
    executionId,
    // Animation context for deferred playback after ruling
    animationContext
  };

  // If player (non-GM) is creating the event, send to GM via socket
  if (!game.user.isGM) {
    debug(`Player creating threat event, sending to GM via socket`);
    game.socket.emit(`system.${MODULE}`, {
      type: CONFIG.MESSAGE_TYPES.CREATE_THREAT_EVENT,
      event,
      isNPC,
      defenderOwners
    });
    return event; // Return the event for reference, but it's stored on GM's client
  }

  // GM stores the event locally
  pendingEvents.set(eventId, event);
  if (executionId) _trackBatchEvent(executionId, eventId, animationContext);
  debug(`Threat event created: ${eventId} (${macro.name} → ${defenderToken.name})`);

  if (isNPC) {
    // NPC: event is immediately visible in ruling panel (defenderResponse = ACCEPT)
    debug(`NPC defender "${defenderToken.name}", event ready for ruling`);
  } else {
    // Player-owned: send defender popup via socket
    _sendDefenderPopup(event, defenderOwners);
  }

  _notifyPanel();
  return event;
}

/**
 * Create a restoration event (no defender popup, goes straight to ruling panel)
 * Restorative macros still need GM ruling but don't threaten defenders.
 * @param {Object} deferredChatData - Chat message data to post when ruling is approved (optional)
 * @param {string|null} executionId - Optional batch ID for tracking macro execution completion
 * @param {Object|null} animationContext - Animation data for deferred playback after ruling
 */
export function createRestorationEvent(casterToken, targetToken, macro, combatResults, deferredChatData = null, executionId = null, animationContext = null) {
  const targetActor = targetToken.actor;
  if (!targetActor) return null;

  const components = [];

  const restorationRolls = combatResults.restorationRolls || [];
  for (let i = 0; i < restorationRolls.length; i++) {
    const rest = restorationRolls[i];
    components.push({
      id: foundry.utils.randomID(),
      type: rest.type || 'heal-hp',
      originalIndex: i,  // Track original index for progressive reveal
      rawAmount: rest.total || 0,
      formula: rest.formula || '',
      statusEffect: rest.statusEffect || null,
      conditions: rest.conditions || [],
      statusEffects: rest.statusEffects || [],
      allowOverMax: rest.allowOverMax || false,
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      result: null
    });
  }

  // CF4: Map protection components
  const damageProtRolls = combatResults.damageProtectionRolls || [];
  for (let i = 0; i < damageProtRolls.length; i++) {
    const prot = damageProtRolls[i];
    components.push({
      id: foundry.utils.randomID(),
      type: 'damage-protection',
      originalIndex: i,
      protectionType: prot.type || 'PHYSICAL',
      tiers: prot.tiers || 0,
      flat: prot.flat || 0,
      diceCount: prot.diceCount || 0,
      diceSides: prot.diceSides || 0,
      percentage: prot.percentage || 0,
      percentageTiming: prot.percentageTiming || 'INITIAL',
      durationTurns: prot.durationTurns || 0,
      durationAttacks: prot.durationAttacks || 0,
      stacking: prot.stacking || 'OVERWRITE',
      applyToCaster: prot.applyToCaster || false,
      applyToTarget: prot.applyToTarget || true,
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      result: null
    });
  }

  const buildupProtRolls = combatResults.buildupProtectionRolls || [];
  for (let i = 0; i < buildupProtRolls.length; i++) {
    const prot = buildupProtRolls[i];
    components.push({
      id: foundry.utils.randomID(),
      type: 'buildup-protection',
      originalIndex: i,
      protectionType: prot.type || 'BLEED',
      flat: prot.flat || 0,
      diceCount: prot.diceCount || 0,
      diceSides: prot.diceSides || 0,
      percentage: prot.percentage || 0,
      percentageTiming: prot.percentageTiming || 'INITIAL',
      durationTurns: prot.durationTurns || 0,
      durationAttacks: prot.durationAttacks || 0,
      stacking: prot.stacking || 'OVERWRITE',
      applyToCaster: prot.applyToCaster || false,
      applyToTarget: prot.applyToTarget || true,
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      result: null
    });
  }

  const conditionProtRolls = combatResults.conditionProtectionRolls || [];
  for (let i = 0; i < conditionProtRolls.length; i++) {
    const prot = conditionProtRolls[i];
    components.push({
      id: foundry.utils.randomID(),
      type: 'condition-protection',
      originalIndex: i,
      condition: prot.condition || 'Dazed',
      durationTurns: prot.durationTurns || 0,
      durationAttacks: prot.durationAttacks || 0,
      applyToCaster: prot.applyToCaster || false,
      applyToTarget: prot.applyToTarget || true,
      ruling: CONFIG.RULING_STATES.PENDING,
      autoReason: null,
      result: null
    });
  }

  if (components.length === 0) return null;

  const eventId = foundry.utils.randomID();
  const event = {
    id: eventId,
    attackerId: casterToken.id,
    attackerName: casterToken.name,
    attackerActorId: casterToken.actor?.id,
    defenderId: targetToken.id,
    defenderName: targetToken.name,
    defenderActorId: targetActor.id,
    macroName: macro.name,
    timestamp: Date.now(),
    defenderResponse: CONFIG.DEFENDER_RESPONSES.ACCEPT, // No popup needed
    isRestoration: true,
    components,
    // Store deferred chat data to post when ruling is approved
    deferredChatData,
    executionId,
    // Animation context for deferred playback after ruling
    animationContext
  };

  // If player (non-GM) is creating the event, send to GM via socket
  if (!game.user.isGM) {
    debug(`Player creating restoration event, sending to GM via socket`);
    game.socket.emit(`system.${MODULE}`, {
      type: CONFIG.MESSAGE_TYPES.CREATE_RESTORATION_EVENT,
      event
    });
    return event;
  }

  // GM stores the event locally
  pendingEvents.set(eventId, event);
  if (executionId) _trackBatchEvent(executionId, eventId, animationContext);
  debug(`Restoration event created: ${eventId} (${macro.name} → ${targetToken.name})`);

  // No defender popup, goes straight to ruling panel
  _notifyPanel();
  return event;
}

/* ========================================
   Defender Response
   ======================================== */

/**
 * Send threat event to defender's client via socket
 */
function _sendDefenderPopup(event, ownerIds) {
  game.socket.emit(`system.${MODULE}`, {
    type: CONFIG.MESSAGE_TYPES.THREAT_EVENT,
    eventId: event.id,
    attackerName: event.attackerName,
    defenderName: event.defenderName,
    macroName: event.macroName,
    components: event.components.map(c => ({
      type: c.type,
      damageType: c.damageType,
      statusEffect: c.statusEffect,
      condition: c.condition,
      rawAmount: c.rawAmount,
      autoReason: c.autoReason
    })),
    targetUserIds: ownerIds,
    timeout: CONFIG.COMBAT.DEFENDER_TIMEOUT
  });
  debug(`Defender popup sent to users: ${ownerIds.join(', ')}`);
}

/**
 * Handle defender response (accept or react)
 */
export async function handleDefenderResponse(eventId, response) {
  const event = pendingEvents.get(eventId);
  if (!event) {
    debug(`No event found for defender response: ${eventId}`);
    return;
  }

  event.defenderResponse = response;

  if (response === CONFIG.DEFENDER_RESPONSES.ACCEPT) {
    // Auto-resolve all pending (non-immune) components immediately
    debug(`Defender accepted event ${eventId}, auto-resolving all components`);
    for (const comp of event.components) {
      if (comp.ruling === CONFIG.RULING_STATES.PENDING) {
        await resolveComponent(eventId, comp.id, CONFIG.RULING_STATES.APPROVED);
      }
    }
  } else {
    debug(`Defender reacted to event ${eventId}, awaiting GM ruling`);
  }

  _notifyPanel();
}

/**
 * Show defender popup on this client (called from socket handler)
 */
async function _showDefenderPopup(data) {
  // Only show to targeted users
  if (!data.targetUserIds?.includes(game.user.id)) return;

  const content = `
    <p>You are being targeted by an ability. <strong>Accept</strong> or <strong>React</strong>?</p>
    <p class="cs-hint">Accept = pre-approve all. React = GM must rule on each.</p>
  `;

  // Set up auto-accept timeout
  let timeoutId = null;
  const timeoutMs = data.timeout || CONFIG.COMBAT.DEFENDER_TIMEOUT;

  const result = await new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(true), timeoutMs);

    DialogV2.confirm({
      window: {
        title: 'Incoming Ability',
        icon: 'fa-solid fa-exclamation-triangle'
      },
      content,
      yes: { label: 'Accept', icon: 'fa-solid fa-check' },
      no: { label: 'React', icon: 'fa-solid fa-shield' },
      close: () => resolve(true) // Default to accept on close
    }).then(confirmed => {
      clearTimeout(timeoutId);
      resolve(confirmed);
    });
  });

  const response = result ? CONFIG.DEFENDER_RESPONSES.ACCEPT : CONFIG.DEFENDER_RESPONSES.REACT;

  // Send response back to GM via socket
  game.socket.emit(`system.${MODULE}`, {
    type: CONFIG.MESSAGE_TYPES.DEFENDER_RESPONSE,
    eventId: data.eventId,
    response
  });

  // If this user is also GM, handle directly
  if (game.user.isGM) {
    handleDefenderResponse(data.eventId, response);
  }
}

/* ========================================
   Component Resolution
   ======================================== */

/**
 * Resolve a single component with a ruling
 */
export async function resolveComponent(eventId, componentId, ruling) {
  debug(`resolveComponent called: eventId=${eventId}, componentId=${componentId}, ruling=${ruling}`);
  const event = pendingEvents.get(eventId);
  if (!event) {
    debug(`Event not found: ${eventId}`);
    return;
  }

  const comp = event.components.find(c => c.id === componentId);
  if (!comp) {
    debug(`Component not found: ${componentId}`);
    return;
  }

  // Prevent duplicate rulings - if already resolved, skip
  if (comp.ruling !== CONFIG.RULING_STATES.PENDING) {
    debug(`Component ${componentId} already resolved with ruling=${comp.ruling}, skipping`);
    return;
  }

  comp.ruling = ruling;

  // Get the defender actor from the TOKEN, not the world actors collection
  // This is critical for unlinked tokens which have synthetic actors
  let defenderActor = null;
  const defenderToken = canvas.tokens?.get(event.defenderId);
  if (defenderToken?.actor) {
    defenderActor = defenderToken.actor;
    debug(`Got defender actor from token: ${defenderActor.name} (linked=${defenderToken.document.actorLink})`);
  } else {
    // Fallback to world actor if token not found (e.g., token was deleted)
    defenderActor = game.actors.get(event.defenderActorId);
    debug(`Token not found, using world actor: ${defenderActor?.name}`);
  }

  if (!defenderActor) {
    debug(`Defender actor not found: ${event.defenderActorId}`);
    comp.result = { error: 'Defender actor not found' };
    _notifyPanel();
    return;
  }

  const currentRound = game.combat?.round || 0;
  debug(`Resolving component: type=${comp.type}, ruling=${ruling}, actor=${defenderActor.name}`);

  if (ruling === CONFIG.RULING_STATES.APPROVED) {
    debug(`Executing approved component...`);
    const attackerActorId = event.attackerActorId;
    await _executeComponent(comp, defenderActor, currentRound, attackerActorId, event);
    debug(`Component execution complete`);
  } else if (ruling === CONFIG.RULING_STATES.DENIED) {
    comp.result = { denied: true };
  } else if (ruling === CONFIG.RULING_STATES.AUTO_SUCCEED) {
    // For conditions: defender auto-passes, condition NOT applied
    comp.result = { autoSucceed: true, message: `${comp.condition} resisted (GM ruling)` };
  } else if (ruling === CONFIG.RULING_STATES.AUTO_FAIL) {
    // For conditions: force apply without DC roll
    if (comp.type === 'status-condition') {
      const condResult = applyConditionToActor(defenderActor, comp.condition, comp.duration, currentRound, {
        stacks: comp.stacks ?? 1,
        stacking: comp.stacking ?? false,
        sourceId: comp.sourceId,
        sourceName: comp.sourceName,
        casterId: comp.casterId,
        casterName: comp.casterName
      });
      await commitActorUpdates(defenderActor, {}, condResult.flagUpdates);
      _syncDefenderTokens(defenderActor);
      comp.result = { autoFail: true, applied: condResult.applied, message: `${comp.condition} forced (GM ruling)` };
      // Play status animation for the applied condition
      if (condResult.applied && defenderToken) {
        playStatusAnimation(defenderToken, comp.condition);
      }
    }
  }

  // Post result to chat
  _postRulingChat(event, comp);

  // Check if all components are resolved
  const allResolved = event.components.every(c =>
    c.ruling !== CONFIG.RULING_STATES.PENDING
  );
  if (allResolved) {
    debug(`Event ${eventId} fully resolved, removing from pending`);

    // Post deferred chat message only if at least one component was not denied
    const allDenied = event.components.every(c =>
      c.ruling === CONFIG.RULING_STATES.DENIED
    );
    if (event.deferredChatData && !allDenied) {
      try {
        // Progressive reveal: rebuild chat content with only approved components
        const filteredChatData = _rebuildChatWithApprovedComponents(event);
        await ChatMessage.create(filteredChatData);
        debug(`Posted deferred chat message for event ${eventId}`);
      } catch (err) {
        console.warn('Failed to post deferred chat message:', err);
      }
    } else if (allDenied) {
      debug(`All components denied for event ${eventId}, skipping chat message`);
    }

    pendingEvents.delete(eventId);

    // Check if this completes an execution batch (for macro chaining)
    if (event.executionId) {
      _checkBatchCompletion(event.executionId);
    }
  }

  _notifyPanel();
}

/**
 * Resolve all pending components in an event with the same ruling
 */
export async function resolveAllComponents(eventId, ruling) {
  const event = pendingEvents.get(eventId);
  if (!event) return;

  for (const comp of event.components) {
    // Only resolve pending components - already resolved ones are skipped
    if (comp.ruling === CONFIG.RULING_STATES.PENDING) {
      await resolveComponent(eventId, comp.id, ruling);
    }
  }
}

/**
 * Execute a single approved component through the calculation pipeline
 * @param {Object} comp - The component to execute
 * @param {Actor} defenderActor - The target actor
 * @param {number} currentRound - Current combat round
 * @param {string|null} attackerActorId - Attacker's actor ID
 * @param {Object|null} event - The parent threat event (used for creating triggered events)
 */
async function _executeComponent(comp, defenderActor, currentRound, attackerActorId = null, event = null) {
  debug(`_executeComponent called: type=${comp.type}, rawAmount=${comp.rawAmount}, actor=${defenderActor?.name}, isImmune=${comp.isImmune}`);

  // If component is immune, skip actual application but record the result
  if (comp.isImmune) {
    debug(`Component is immune, skipping application`);
    comp.result = { immune: true, message: `${defenderActor.name} is immune` };
    return;
  }

  let systemUpdates = {};
  let flagUpdates = {};

  switch (comp.type) {
    case 'damage': {
      // Log current HP before damage for debugging
      const currentHP = defenderActor.system?.hp?.value ?? 0;
      const maxHP = defenderActor.system?.hp?.max ?? 0;
      debug(`Damage target "${defenderActor.name}": current HP=${currentHP}/${maxHP}, isToken=${!!defenderActor.token}, uuid=${defenderActor.uuid}`);

      // Get active vulnerabilities on target for this damage type
      const activeVuln = getVulnerabilityForDamageType(defenderActor, comp.damageType);

      // Build piercing + vulnerability options from component
      const damageOptions = {
        piercingTiers: comp.piercing?.tiers || 0,
        piercingAllTiers: comp.piercing?.allTiers || false,
        vulnerabilityTiers: activeVuln.tiers
      };
      const calcResult = calculateDamage(comp.rawAmount, comp.damageType, defenderActor, damageOptions);
      debug(`Damage calc: raw=${comp.rawAmount}, final=${calcResult.final}, newHP=${currentHP - calcResult.final}`);
      const applyResult = applyDamageToActor(defenderActor, calcResult.final, comp.damageType);
      debug(`Apply result: updates=${JSON.stringify(applyResult.updates)}`);
      Object.assign(systemUpdates, applyResult.updates || {});
      Object.assign(flagUpdates, applyResult.flagUpdates || {});
      comp.result = { calcResult, applyResult };
      break;
    }

    case 'status-buildup': {
      const calcResult = calculateStatusBuildup(comp.rawAmount, comp.statusEffect, defenderActor, currentRound);
      if (calcResult.final > 0 || calcResult.triggered) {
        const applyResult = applyBuildupToActor(defenderActor, comp.statusEffect, calcResult.final, currentRound, calcResult.triggered);
        Object.assign(flagUpdates, applyResult.flagUpdates || {});

        // If triggered, create a new threat event for the triggered condition (requires GM ruling)
        // This ensures conditions like Curse go through the GM panel before being applied
        if (calcResult.triggered && applyResult.conditionToApply) {
          const triggerEffect = getStatusTriggerEffect(comp.statusEffect);
          const defenderToken = canvas.tokens?.get(event.defenderId);
          const attackerToken = canvas.tokens?.get(event.attackerId);

          if (defenderToken && attackerToken) {
            // Build combat results for the triggered condition
            const triggerResults = {
              damageRolls: [],
              buildupRolls: [],
              conditionRolls: [{
                name: applyResult.conditionToApply,
                duration: triggerEffect?.duration || 0,
                dc: 0, // No save for triggered conditions
                dcBonusSource: 'none',
                dcBonusResolved: 0,
                // Store trigger effect data for special handling
                triggerEffect: triggerEffect
              }],
              restorationRolls: [],
              vulnerabilityRolls: []
            };

            // Add trigger damage as TRUE damage (e.g., BledOut = 20% max HP)
            if (triggerEffect?.hpPercent && triggerEffect.type !== 'dot') {
              const maxHP = defenderActor.system?.hp?.max || 0;
              const triggerDamage = Math.floor(maxHP * (triggerEffect.hpPercent / 100));
              if (triggerDamage > 0) {
                triggerResults.damageRolls.push({
                  type: 'TRUE',
                  total: triggerDamage,
                  formula: `${triggerDamage}`,
                  piercing: { tiers: 0, allTiers: false }
                });
              }
            }

            debug(`${comp.statusEffect} triggered! Creating GM ruling event for ${applyResult.conditionToApply}`);

            // Create threat event for the triggered condition - GM must rule on it
            createThreatEvent(
              attackerToken,
              defenderToken,
              { name: `${comp.statusEffect} Trigger`, id: `${comp.statusEffect.toLowerCase()}-trigger` },
              triggerResults,
              null, // No deferred chat
              event.executionId, // Same execution batch
              null // No animation
            );
          }
        }

        comp.result = { calcResult, applyResult };
      } else {
        comp.result = { calcResult, blocked: true };
      }
      break;
    }

    case 'status-condition': {
      // DC/noSave/saveType are informational only (shown in chat card for players to roll against manually).
      // GM approval is sufficient to apply the condition - no automatic DC check.
      const condResult = applyConditionToActor(defenderActor, comp.condition, comp.duration, currentRound, {
        stacks: comp.stacks ?? 1,
        stacking: comp.stacking ?? false,
        sourceId: comp.sourceId,
        sourceName: comp.sourceName,
        casterId: comp.casterId,
        casterName: comp.casterName
      });
      Object.assign(flagUpdates, condResult.flagUpdates || {});
      comp.result = { condResult };

      // Handle special trigger effects (e.g., Curse sets HP to 0)
      // These are passed through triggerEffect when condition is triggered from buildup
      if (comp.triggerEffect?.setHPToZero) {
        systemUpdates['system.hp.value'] = 0;
        systemUpdates['system.hp.temp'] = 0;
        debug(`${comp.condition} trigger effect: HP and Temp HP set to 0`);
      }
      break;
    }

    case 'vulnerability': {
      // Apply vulnerability debuff to target
      const vulnData = {
        type: comp.damageType,
        tiers: comp.tiers,
        duration: comp.duration,
        timing: comp.timing,
        stacking: comp.stacking
      };
      const applyResult = applyVulnerabilityToActor(defenderActor, vulnData, attackerActorId, currentRound);
      Object.assign(flagUpdates, applyResult.flagUpdates || {});
      comp.result = { applyResult, vulnerability: applyResult.vulnerability };
      break;
    }

    // Restoration types
    case 'heal-hp':
    case 'restore-fp':
    case 'restore-ap': {
      const restComp = { type: comp.type, amount: comp.rawAmount, allowOverMax: comp.allowOverMax };
      const calcResult = calculateRestoration(restComp, defenderActor);
      const applyResult = applyRestorationToActor(defenderActor, calcResult);
      Object.assign(systemUpdates, applyResult.updates || {});
      Object.assign(flagUpdates, applyResult.flagUpdates || {});
      comp.result = { calcResult, applyResult };
      break;
    }

    case 'reduce-buildup': {
      const restComp = { type: 'reduce-buildup', statusEffect: comp.statusEffect, amount: comp.rawAmount };
      const calcResult = calculateRestoration(restComp, defenderActor);
      const applyResult = applyRestorationToActor(defenderActor, calcResult);
      Object.assign(flagUpdates, applyResult.flagUpdates || {});
      comp.result = { calcResult, applyResult };
      break;
    }

    case 'cure-condition': {
      const restComp = { type: 'cure-condition', conditions: comp.conditions || [] };
      const calcResult = calculateRestoration(restComp, defenderActor);
      const applyResult = applyRestorationToActor(defenderActor, calcResult);
      Object.assign(flagUpdates, applyResult.flagUpdates || {});
      comp.result = { calcResult, applyResult };
      break;
    }

    case 'cure-effect': {
      const restComp = { type: 'cure-effect', statusEffects: comp.statusEffects || [] };
      const calcResult = calculateRestoration(restComp, defenderActor);
      const applyResult = applyRestorationToActor(defenderActor, calcResult);
      Object.assign(flagUpdates, applyResult.flagUpdates || {});
      comp.result = { calcResult, applyResult };
      break;
    }

    // CF4: Protection types
    case 'damage-protection': {
      const protData = {
        type: comp.protectionType,
        tiers: comp.tiers || 0,
        flat: comp.flat || 0,
        diceCount: comp.diceCount || 0,
        diceSides: comp.diceSides || 0,
        percentage: comp.percentage || 0,
        percentageTiming: comp.percentageTiming || 'INITIAL',
        durationTurns: comp.durationTurns || 0,
        durationAttacks: comp.durationAttacks || 0,
        stacking: comp.stacking || 'OVERWRITE'
      };
      const sourceId = event?.macroId || 'unknown';
      const sourceName = event?.macroName || 'Unknown';

      // Apply to target if specified
      if (comp.applyToTarget !== false) {
        const applyResult = applyDamageProtectionToActor(defenderActor, protData, sourceId, sourceName, currentRound);
        Object.assign(flagUpdates, applyResult.flagUpdates || {});
        comp.result = { applyResult, targetApplied: true };
      }

      // Apply to caster if specified
      if (comp.applyToCaster && attackerActorId) {
        const casterActor = game.actors.get(attackerActorId);
        if (casterActor) {
          const casterResult = applyDamageProtectionToActor(casterActor, protData, sourceId, sourceName, currentRound);
          await commitActorUpdates(casterActor, {}, casterResult.flagUpdates || {});
          comp.result = { ...comp.result, casterApplied: true, casterResult };
          _syncDefenderTokens(casterActor);
        }
      }
      break;
    }

    case 'buildup-protection': {
      const protData = {
        type: comp.protectionType,
        flat: comp.flat || 0,
        diceCount: comp.diceCount || 0,
        diceSides: comp.diceSides || 0,
        percentage: comp.percentage || 0,
        percentageTiming: comp.percentageTiming || 'INITIAL',
        durationTurns: comp.durationTurns || 0,
        durationAttacks: comp.durationAttacks || 0,
        stacking: comp.stacking || 'OVERWRITE'
      };
      const sourceId = event?.macroId || 'unknown';
      const sourceName = event?.macroName || 'Unknown';

      // Apply to target if specified
      if (comp.applyToTarget !== false) {
        const applyResult = applyBuildupProtectionToActor(defenderActor, protData, sourceId, sourceName, currentRound);
        Object.assign(flagUpdates, applyResult.flagUpdates || {});
        comp.result = { applyResult, targetApplied: true };
      }

      // Apply to caster if specified
      if (comp.applyToCaster && attackerActorId) {
        const casterActor = game.actors.get(attackerActorId);
        if (casterActor) {
          const casterResult = applyBuildupProtectionToActor(casterActor, protData, sourceId, sourceName, currentRound);
          await commitActorUpdates(casterActor, {}, casterResult.flagUpdates || {});
          comp.result = { ...comp.result, casterApplied: true, casterResult };
          _syncDefenderTokens(casterActor);
        }
      }
      break;
    }

    case 'condition-protection': {
      const protData = {
        condition: comp.condition,
        durationTurns: comp.durationTurns || 0,
        durationAttacks: comp.durationAttacks || 0
      };
      const sourceId = event?.macroId || 'unknown';
      const sourceName = event?.macroName || 'Unknown';

      // Apply to target if specified
      if (comp.applyToTarget !== false) {
        const applyResult = applyConditionProtectionToActor(defenderActor, protData, sourceId, sourceName, currentRound);
        Object.assign(flagUpdates, applyResult.flagUpdates || {});
        comp.result = { applyResult, targetApplied: true };
      }

      // Apply to caster if specified
      if (comp.applyToCaster && attackerActorId) {
        const casterActor = game.actors.get(attackerActorId);
        if (casterActor) {
          const casterResult = applyConditionProtectionToActor(casterActor, protData, sourceId, sourceName, currentRound);
          await commitActorUpdates(casterActor, {}, casterResult.flagUpdates || {});
          comp.result = { ...comp.result, casterApplied: true, casterResult };
          _syncDefenderTokens(casterActor);
        }
      }
      break;
    }
  }

  // Batch commit all updates
  debug(`Commit check: systemUpdates=${JSON.stringify(systemUpdates)}, flagUpdates=${JSON.stringify(flagUpdates)}`);
  if (Object.keys(systemUpdates).length > 0 || Object.keys(flagUpdates).length > 0) {
    debug(`Committing updates to actor ${defenderActor?.name}...`);
    await commitActorUpdates(defenderActor, systemUpdates, flagUpdates);
    debug(`Updates committed successfully`);
  } else {
    debug(`No updates to commit`);
  }

  // Play status animations for applied conditions
  // Get defender token for animation playback
  const defenderToken = canvas.tokens?.placeables?.find(t => t.actor?.id === defenderActor.id);
  if (defenderToken) {
    // Status buildup that triggered a condition
    if (comp.type === 'status-buildup' && comp.result?.applyResult?.conditionToApply) {
      playStatusAnimation(defenderToken, comp.result.applyResult.conditionToApply);
    }
    // Direct status condition application
    if (comp.type === 'status-condition' && comp.result?.condResult?.applied) {
      playStatusAnimation(defenderToken, comp.condition);
    }
  }

  // Sync token status icons
  _syncDefenderTokens(defenderActor);
}

/**
 * Sync status icons for all tokens of a given actor
 */
function _syncDefenderTokens(actor) {
  if (!canvas?.tokens?.placeables) return;
  for (const token of canvas.tokens.placeables) {
    if (token.actor?.id === actor.id) {
      syncTokenStatusIcons(token);
    }
  }
}

/**
 * Post ruling result to chat
 */
function _postRulingChat(event, comp) {
  const isHarmful = CONFIG.HARMFUL_COMPONENTS.includes(comp.type);
  const colorClass = isHarmful ? 'harmful' : 'positive';
  let detail = '';

  if (comp.ruling === CONFIG.RULING_STATES.DENIED) {
    const reason = comp.autoReason ? ` (${comp.autoReason})` : '';
    detail = `<span class="ruling-denied">DENIED${reason}</span>`;
  } else if (comp.result?.immune) {
    // Component was approved but target is immune - no effect applied
    detail = `<span class="ruling-immune">IMMUNE (no effect applied)</span>`;
  } else if (comp.ruling === CONFIG.RULING_STATES.AUTO_SUCCEED) {
    detail = `<span class="ruling-auto-succeed">Auto-Succeed: ${comp.condition} resisted</span>`;
  } else if (comp.ruling === CONFIG.RULING_STATES.AUTO_FAIL) {
    detail = `<span class="ruling-auto-fail">Auto-Fail: ${comp.condition} applied</span>`;
  } else if (comp.result) {
    // Build detail from result
    if (comp.type === 'damage' && comp.result.calcResult) {
      const cr = comp.result.calcResult;
      detail = `<span style="color:${CONFIG.DAMAGE_TYPE_COLORS[comp.damageType] || '#fff'}">${comp.damageType}</span> ${cr.raw} → ${cr.final} damage`;
    } else if (comp.type === 'status-buildup' && comp.result.calcResult) {
      const cr = comp.result.calcResult;
      detail = `${comp.statusEffect} +${cr.final}`;
      if (cr.triggered) detail += ' <strong>(TRIGGERED!)</strong>';
    } else if (comp.type === 'status-condition') {
      if (comp.result.resisted) {
        detail = `${comp.condition} resisted`;
      } else {
        detail = `${comp.condition} applied`;
      }
    } else if (comp.type === 'vulnerability') {
      const vuln = comp.result?.vulnerability;
      if (vuln) {
        detail = `<span style="color:${CONFIG.DAMAGE_TYPE_COLORS[comp.damageType] || '#fff'}">${comp.damageType}</span> Vulnerability (-${vuln.tiers} tier${vuln.tiers > 1 ? 's' : ''}) for ${vuln.duration} rounds`;
      } else {
        detail = `${comp.damageType} Vulnerability applied`;
      }
    } else {
      detail = `${comp.type} applied`;
    }
  }

  const content = `
    <div class="sd20-ruling-chat ${colorClass}">
      <div class="ruling-header">${event.attackerName} → ${event.defenderName}</div>
      <div class="ruling-detail">${detail}</div>
    </div>
  `;

  ChatMessage.create({
    content,
    speaker: { alias: 'Ruling' },
    whisper: game.users.filter(u => u.isGM).map(u => u.id)
  });
}

/* ========================================
   Progressive Reveal - Chat Message Filtering
   ======================================== */

/**
 * Rebuild chat message content with only approved components
 * Denied components are omitted entirely from the chat message
 * @param {Object} event - The threat/restoration event with resolved components
 * @returns {Object} - Modified chat data with filtered content
 */
function _rebuildChatWithApprovedComponents(event) {
  const chatData = foundry.utils.deepClone(event.deferredChatData);
  const combatResults = chatData.flags?.['souls-d20']?.combatResults;

  if (!combatResults) {
    debug('No combatResults in chat data, returning as-is');
    return chatData;
  }

  // Get approved component indices by type
  const approvedIndices = {
    damage: new Set(),
    'status-buildup': new Set(),
    'status-condition': new Set(),
    vulnerability: new Set(),
    restoration: new Set()
  };

  for (const comp of event.components) {
    // Include approved, auto-succeed, and auto-fail (applied) components
    const isApproved = comp.ruling === CONFIG.RULING_STATES.APPROVED ||
                       comp.ruling === CONFIG.RULING_STATES.AUTO_SUCCEED ||
                       comp.ruling === CONFIG.RULING_STATES.AUTO_FAIL;
    if (isApproved && comp.originalIndex !== undefined) {
      // Map component type to combatResults key
      let key = comp.type;
      if (comp.type === 'heal-hp' || comp.type === 'restore-fp' || comp.type === 'restore-ap' ||
          comp.type === 'reduce-buildup' || comp.type === 'cure-condition' || comp.type === 'cure-effect') {
        key = 'restoration';
      }
      if (approvedIndices[key]) {
        approvedIndices[key].add(comp.originalIndex);
      }
    }
  }

  // Filter combatResults arrays to only include approved indices
  const filteredResults = {
    ...combatResults,
    damageRolls: (combatResults.damageRolls || []).filter((_, i) => approvedIndices.damage.has(i)),
    buildupRolls: (combatResults.buildupRolls || []).filter((_, i) => approvedIndices['status-buildup'].has(i)),
    conditionRolls: (combatResults.conditionRolls || []).filter((_, i) => approvedIndices['status-condition'].has(i)),
    vulnerabilityRolls: (combatResults.vulnerabilityRolls || []).filter((_, i) => approvedIndices.vulnerability.has(i)),
    restorationRolls: (combatResults.restorationRolls || []).filter((_, i) => approvedIndices.restoration.has(i))
  };

  // Rebuild the HTML content with filtered results
  chatData.content = _buildFilteredChatContent(chatData, filteredResults);

  // Update the flags with filtered results
  chatData.flags['souls-d20'].combatResults = filteredResults;

  debug('Rebuilt chat with approved components only', {
    original: {
      damage: combatResults.damageRolls?.length || 0,
      buildup: combatResults.buildupRolls?.length || 0,
      conditions: combatResults.conditionRolls?.length || 0,
      vulnerabilities: combatResults.vulnerabilityRolls?.length || 0,
      restoration: combatResults.restorationRolls?.length || 0
    },
    filtered: {
      damage: filteredResults.damageRolls.length,
      buildup: filteredResults.buildupRolls.length,
      conditions: filteredResults.conditionRolls.length,
      vulnerabilities: filteredResults.vulnerabilityRolls.length,
      restoration: filteredResults.restorationRolls.length
    }
  });

  return chatData;
}

/**
 * Build filtered chat HTML content from filtered combat results
 * Mirrors the logic in macroBar._buildMacroChat() but with filtered data
 */
function _buildFilteredChatContent(chatData, filteredResults) {
  const macroName = chatData.flags?.['souls-d20']?.macroName || 'Action';

  let html = `<div class="sd20-macro-card">`;

  // Header (macro name - full macro object unavailable, so just show name)
  html += `<div class="macro-card-header">`;
  html += `<i class="fa-solid fa-star"></i>`;
  html += `<span class="macro-card-name">${macroName}</span>`;
  html += `</div>`;

  // Damage rolls (red/harmful accent)
  if (filteredResults.damageRolls?.length > 0) {
    html += `<div class="combat-section harmful">`;
    for (const dmg of filteredResults.damageRolls) {
      const color = CONFIG.DAMAGE_TYPE_COLORS[dmg.type] || '#c0c0c0';
      html += `<div class="combat-component damage-row">`;
      html += `<span class="damage-type-label" style="color:${color}">${dmg.type || 'Physical'}</span>`;
      html += `<span class="damage-formula">${dmg.formula || '0'}</span>`;
      html += `<span class="damage-total">= ${dmg.total}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Status buildup + conditions (red/harmful accent)
  const hasBuildup = filteredResults.buildupRolls?.length > 0;
  const hasConditions = filteredResults.conditionRolls?.length > 0;
  if (hasBuildup || hasConditions) {
    html += `<div class="combat-section harmful">`;
    for (const eff of (filteredResults.buildupRolls || [])) {
      html += `<div class="combat-component buildup-row">`;
      html += `<span class="buildup-label">${eff.name || 'Buildup'}</span>`;
      html += `<span class="buildup-formula">${eff.formula || '0'}</span>`;
      html += `<span class="buildup-total">= ${eff.total}</span>`;
      html += `</div>`;
    }
    for (const cond of (filteredResults.conditionRolls || [])) {
      html += `<div class="combat-component condition-row">`;
      html += `<span class="condition-label">${cond.name}</span>`;
      if (cond.duration) html += `<span class="condition-duration">${cond.duration} rnd</span>`;
      if (cond.totalDC) {
        html += `<span class="condition-dc">DC ${cond.totalDC}</span>`;
        if (cond.saveType) {
          const saveLabel = cond.saveType.includes(':') ? cond.saveType.split(':')[1] : cond.saveType;
          const formattedLabel = saveLabel.charAt(0).toUpperCase() + saveLabel.slice(1);
          html += `<span class="condition-check">${formattedLabel}</span>`;
        }
      } else {
        html += `<span class="condition-auto">Auto</span>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Restoration (green/positive accent)
  if (filteredResults.restorationRolls?.length > 0) {
    html += `<div class="combat-section positive">`;
    for (const rest of filteredResults.restorationRolls) {
      html += `<div class="combat-component restoration-row">`;
      const typeLabels = {
        'heal-hp': 'Heal HP', 'restore-fp': 'Restore FP', 'restore-ap': 'Restore AP',
        'reduce-buildup': `Reduce ${rest.statusEffect || 'Buildup'}`,
        'cure-condition': `Cure: ${(rest.conditions || []).join(', ') || 'None'}`,
        'cure-effect': `Cure: ${(rest.statusEffects || []).join(', ') || 'None'}`
      };
      html += `<span class="restoration-label">${typeLabels[rest.restorationType] || rest.restorationType}</span>`;
      if (rest.formula) {
        html += `<span class="restoration-formula">${rest.formula}</span>`;
        html += `<span class="restoration-total">= ${rest.total}</span>`;
      }
      if (rest.allowOverMax) html += `<span class="restoration-overmax">Over Max</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/* ========================================
   Panel Notification
   ======================================== */

function _notifyPanel() {
  // Auto-open for GM when there are pending events
  if (game.user.isGM && pendingEvents.size > 0 && !_rulingPanel?.rendered) {
    _rulingPanel?.render({ force: true });
  } else if (_rulingPanel?.rendered) {
    _rulingPanel.render();
  }

  // Wake up panel from idle state when new events arrive
  if (_rulingPanel?.rendered && _rulingPanel.onNewEvent) {
    _rulingPanel.onNewEvent();
  }

  // Update badge count
  _updateBadge();
}

function _updateBadge() {
  const count = getPendingCount();
  const badge = document.querySelector('.sd20-ruling-badge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }
}

/**
 * Set the ruling panel reference (called during registration)
 */
export function setRulingPanel(panel) {
  _rulingPanel = panel;
}

/* ========================================
   Socket Handler Registration
   ======================================== */

export function registerThreatSocket() {
  game.socket.on(`system.${MODULE}`, (data) => {
    switch (data.type) {
      case CONFIG.MESSAGE_TYPES.THREAT_EVENT:
        // Player receives defender popup
        _showDefenderPopup(data);
        break;

      case CONFIG.MESSAGE_TYPES.DEFENDER_RESPONSE:
        // GM receives defender response
        if (game.user.isGM) {
          handleDefenderResponse(data.eventId, data.response);
        }
        break;

      case CONFIG.MESSAGE_TYPES.RULING_RESULT:
        // All clients receive ruling result (for chat sync)
        debug('Ruling result received:', data);
        break;

      case CONFIG.MESSAGE_TYPES.GM_UPDATE_REQUEST:
        // GM processes update requests from players who lack permission
        if (game.user.isGM) {
          _handleGMUpdateRequest(data);
        }
        break;

      case CONFIG.MESSAGE_TYPES.CREATE_THREAT_EVENT:
        // GM receives threat event from player
        if (game.user.isGM) {
          _handlePlayerThreatEvent(data);
        }
        break;

      case CONFIG.MESSAGE_TYPES.CREATE_RESTORATION_EVENT:
        // GM receives restoration event from player
        if (game.user.isGM) {
          _handlePlayerRestorationEvent(data);
        }
        break;
    }
  });

  debug('Threat system socket handlers registered');
}

/**
 * GM processes update requests from players who lack document permissions
 */
async function _handleGMUpdateRequest(data) {
  const { documentType, documentUuid, updates } = data;
  if (!documentType || !documentUuid || !updates) {
    debug('Invalid GM update request:', data);
    return;
  }

  try {
    let doc;
    if (documentType === 'actor') {
      doc = await fromUuid(documentUuid);
    } else if (documentType === 'token') {
      doc = await fromUuid(documentUuid);
    }

    if (!doc) {
      debug(`GM update: document not found for UUID ${documentUuid}`);
      return;
    }

    await doc.update(updates);
    debug(`GM proxy update completed for ${documentType} ${documentUuid}`);
  } catch (err) {
    console.error('SD20: GM proxy update failed:', err);
  }
}

/**
 * GM handles threat event created by a player
 */
function _handlePlayerThreatEvent(data) {
  const { event, isNPC, defenderOwners } = data;
  if (!event) {
    debug('Invalid player threat event data');
    return;
  }

  debug(`GM received threat event from player: ${event.id} (${event.macroName} → ${event.defenderName})`);

  // Store the event on GM's client
  pendingEvents.set(event.id, event);
  if (event.executionId) _trackBatchEvent(event.executionId, event.id, event.animationContext);

  if (isNPC) {
    debug(`NPC defender "${event.defenderName}", event ready for ruling`);
  } else {
    // Player-owned: send defender popup via socket
    _sendDefenderPopup(event, defenderOwners);
  }

  _notifyPanel();
}

/**
 * GM handles restoration event created by a player
 */
function _handlePlayerRestorationEvent(data) {
  const { event } = data;
  if (!event) {
    debug('Invalid player restoration event data');
    return;
  }

  debug(`GM received restoration event from player: ${event.id} (${event.macroName} → ${event.defenderName})`);

  // Store the event on GM's client
  pendingEvents.set(event.id, event);
  if (event.executionId) _trackBatchEvent(event.executionId, event.id, event.animationContext);

  _notifyPanel();
}
