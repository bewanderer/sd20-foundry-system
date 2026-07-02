/**
 * Character Data Sync
 * Handles character updates from SD20 App and syncs to linked tokens
 */

import { CONFIG } from './config.js';
import { log, debug, warn, findTokenByUUID, getTokenCharacterUUID } from './utils.js';

const RESPONSE_DEDUPE_WINDOW_MS = 500;
const RECONNECT_RESYNC_WINDOW_MS = 30000;
// Item 5 (Batch C): Phase 2 decision A. Raised from 100 to 500 so rapid
// successive edits (typing a stat, toggling two-handing) coalesce into
// one _processCharacterUpdate pass instead of a burst.
const CHARACTER_UPDATE_DEBOUNCE_MS = 500;

const _recentResponses = new Map();
const _reconnectSnapshots = new Map();
const _pendingUpdates = new Map();
// Actors that just transitioned from no-character to linked-character. Set in
// the updateActor hook below and consumed once by updateActorFromCharacterData.
// This is the canonical signal for "treat current = max" because it does not
// depend on a persistent flag that might have failed to write earlier.
const _firstLinkPending = new Set();

function _stableHash(obj) {
  try {
    return JSON.stringify(obj, Object.keys(obj || {}).sort());
  } catch {
    return null;
  }
}

function _shouldSkipDuplicateResponse(uuid) {
  const now = Date.now();
  const last = _recentResponses.get(uuid);
  if (last && (now - last) < RESPONSE_DEDUPE_WINDOW_MS) {
    return true;
  }
  _recentResponses.set(uuid, now);
  if (_recentResponses.size > 64) {
    for (const [key, ts] of _recentResponses) {
      if ((now - ts) > RESPONSE_DEDUPE_WINDOW_MS * 4) _recentResponses.delete(key);
    }
  }
  return false;
}

function _shouldSkipReconnectResync(uuid, charData) {
  const hash = _stableHash({
    name: charData.name, level: charData.level, maxHP: charData.maxHP,
    maxFP: charData.maxFP, maxAP: charData.maxAP, stats: charData.stats,
    statMods: charData.statMods, skills: charData.skills, knowledge: charData.knowledge,
    equipment: charData.equipment, attuned_spells: charData.attuned_spells,
    attuned_spirits: charData.attuned_spirits, attuned_weapon_skills: charData.attuned_weapon_skills,
    bonus_resistances: charData.bonus_resistances, bonus_statuses: charData.bonus_statuses
  });
  if (!hash) return false;
  const now = Date.now();
  const prev = _reconnectSnapshots.get(uuid);
  if (prev && prev.hash === hash && (now - prev.ts) < RECONNECT_RESYNC_WINDOW_MS) {
    return true;
  }
  _reconnectSnapshots.set(uuid, { hash, ts: now });
  return false;
}

function _isPositiveInt(value) {
  return Number.isFinite(value) && value > 0 && Math.floor(value) === value;
}

function _validateCharacterData(charData) {
  if (!charData || typeof charData !== 'object') return false;
  if (charData.maxHP !== undefined && !_isPositiveInt(charData.maxHP)) {
    warn(`Rejecting App data: maxHP not a positive integer (got ${charData.maxHP})`);
    return false;
  }
  if (charData.maxFP !== undefined && !_isPositiveInt(charData.maxFP)) {
    warn(`Rejecting App data: maxFP not a positive integer (got ${charData.maxFP})`);
    return false;
  }
  if (charData.maxAP !== undefined && !_isPositiveInt(charData.maxAP)) {
    warn(`Rejecting App data: maxAP not a positive integer (got ${charData.maxAP})`);
    return false;
  }
  if (charData.level !== undefined && !(Number.isFinite(charData.level) && charData.level >= 0)) {
    warn(`Rejecting App data: level invalid (got ${charData.level})`);
    return false;
  }
  return true;
}

export function registerCharacterSyncHandlers() {
  const bcm = game.sd20.broadcastChannel;

  // Handle character list response
  bcm.on(CONFIG.MESSAGE_TYPES.CHARACTER_RESPONSE_ALL, (data) => {
    handleCharacterListResponse(data);
  });

  // Handle linked character response (new sync architecture)
  bcm.on(CONFIG.MESSAGE_TYPES.CHARACTER_RESPONSE_LINKED, (data) => {
    handleLinkedCharacterResponse(data);
  });

  // Handle single character update
  bcm.on(CONFIG.MESSAGE_TYPES.CHARACTER_UPDATE, (data) => {
    handleCharacterUpdate(data);
  });

  // Optimization 3: field-scoped delta. Merges into the stored snapshot and
  // regenerates only the macros affected by the changed fields. Falls back to
  // full CHARACTER_UPDATE if the delta cannot be reconciled.
  bcm.on(CONFIG.MESSAGE_TYPES.CHARACTER_DELTA_UPDATE, (data) => {
    handleCharacterDelta(data).catch(err => {
      debug('handleCharacterDelta failed, ignoring:', err);
    });
  });

  // Handle combat data response (for immediate fetch on first link)
  bcm.on(CONFIG.MESSAGE_TYPES.COMBAT_DATA_RESPONSE, (data) => {
    handleCombatDataResponse(data);
  });

  // Request linked character data when connection is established
  bcm.on(CONFIG.MESSAGE_TYPES.APP_HANDSHAKE, () => {
    // Small delay to ensure connection is stable
    setTimeout(() => requestLinkedCharacterData(), 500);
  });

  // Watch for actor characterUUID changes to request immediate data
  Hooks.on('updateActor', async (actor, changes, options, userId) => {
    // Only process system updates
    if (userId !== game.user.id) return;

    // Check if characterUUID was changed
    const newUUID = changes.system?.characterUUID;
    if (newUUID === undefined) return;

    // Get the old UUID from the actor's source data
    const oldUUID = actor._source?.system?.characterUUID;

    // If UUID was set (not cleared) and it's different from before
    if (newUUID && newUUID !== oldUUID) {
      log(`New character link detected on "${actor.name}": ${newUUID}`);
      // Mark this actor so the next App response treats current = max.
      // Consumed by updateActorFromCharacterData, see below.
      _firstLinkPending.add(actor.id);
      requestImmediateCharacterData(newUUID, actor.id);
    }

    if (!newUUID && oldUUID) {
      // Soft default. Whether data is wiped is decided by the caller of the
      // unlink action (macroBar._performUnlink picks 'actor' or 'both'); the
      // hook itself only notifies the App that this UUID is no longer linked.
      log(`Character unlinked from "${actor.name}"`);
      requestLinkedCharacterData();
    }
  });

  log('Character sync handlers registered');
}

// Mirrors actor.system + SD20 flags onto every existing token of this actor.
// Linked tokens get a visual refresh (they already inherit from the actor);
// unlinked tokens have their delta and flags rewritten so the new max HP/FP/AP,
// equipment, resistances and other synced fields actually appear on the bars
// and macro bar of tokens that were placed BEFORE the link happened.
//
// Tokens flagged as orphaned (from a prior soft-unlink) are skipped so they
// keep the snapshot the user wanted to preserve.
async function _syncTokensFromActor(actor, { isFirstLink = false } = {}) {
  if (!actor?.id || !game.scenes) return;

  // Resources (hp/fp/ap) are split: max is mirrored from actor to token via
  // dot notation so we never clobber the token's current values. Other system
  // keys (stats, level, equipment) are fully mirrored because they don't
  // carry gameplay state. Foundry's damage system owns current resources;
  // the App is forbidden from changing them, per the user's locked rule.
  //
  // On initial link only, we also mirror current = max for unlinked tokens
  // so the freshly linked character starts at full resources.
  const RESOURCE_KEYS = ['hp', 'fp', 'ap'];
  const STATIC_KEYS = ['level', 'stats', 'equippedWeapons'];
  const FLAG_KEYS = [
    'characterData', 'characterUUID', 'skills', 'knowledge', 'equipment',
    'attuned_spells', 'attuned_spirits', 'attuned_weapon_skills',
    'combat', 'combatSettings', 'statMods', 'macroSets'
  ];

  const systemSnapshot = {};
  for (const key of RESOURCE_KEYS) {
    const maxValue = actor.system?.[key]?.max;
    if (maxValue !== undefined) {
      systemSnapshot[`delta.system.${key}.max`] = maxValue;
      if (isFirstLink) {
        systemSnapshot[`delta.system.${key}.value`] = maxValue;
      }
    }
  }
  for (const key of STATIC_KEYS) {
    const value = actor.system?.[key];
    if (value !== undefined) {
      systemSnapshot[`delta.system.${key}`] = foundry.utils.deepClone(value);
    }
  }

  const flagsSnapshot = {};
  for (const key of FLAG_KEYS) {
    const value = actor.getFlag(CONFIG.MODULE_ID, key);
    if (value !== undefined && value !== null) {
      flagsSnapshot[`flags.${CONFIG.MODULE_ID}.${key}`] = foundry.utils.deepClone(value);
    }
  }

  for (const scene of game.scenes) {
    const updates = [];
    for (const tokenDoc of scene.tokens) {
      if (tokenDoc.actorId !== actor.id) continue;
      if (tokenDoc.getFlag(CONFIG.MODULE_ID, 'orphaned')) continue;

      const proposed = { ...flagsSnapshot };
      if (!tokenDoc.actorLink) Object.assign(proposed, systemSnapshot);

      // Only write fields that actually differ. Tokens get mirrored on
      // every actor.update which is loud for actors with many tokens; this
      // turns it into a no-op for the common case where nothing changed.
      const diff = {};
      for (const [key, value] of Object.entries(proposed)) {
        const current = foundry.utils.getProperty(tokenDoc, key);
        if (!foundry.utils.objectsEqual(current ?? null, value ?? null)) {
          diff[key] = value;
        }
      }
      if (Object.keys(diff).length === 0) continue;
      updates.push({ _id: tokenDoc.id, ...diff });
    }
    if (updates.length === 0) continue;
    try {
      await scene.updateEmbeddedDocuments('Token', updates);
    } catch (err) {
      warn(`Failed to sync tokens on scene "${scene.name}":`, err);
    }
  }

  if (canvas?.tokens?.placeables) {
    for (const placed of canvas.tokens.placeables) {
      if (placed.document.actorId === actor.id
          && !placed.document.getFlag(CONFIG.MODULE_ID, 'orphaned')) {
        placed.refresh();
      }
    }
  }
}

function _templateStats() {
  return {
    vitality: { value: 10, mod: 0 },
    endurance: { value: 10, mod: 0 },
    strength: { value: 10, mod: 0 },
    dexterity: { value: 10, mod: 0 },
    attunement: { value: 10, mod: 0 },
    intelligence: { value: 10, mod: 0 },
    faith: { value: 10, mod: 0 }
  };
}

function _templateSkills() {
  return {
    Athletics: 0, Acrobatics: 0, Perception: 0, FireKeeping: 0,
    Sanity: 0, Stealth: 0, Precision: 0, Diplomacy: 0
  };
}

function _templateKnowledge() {
  return { Magics: 0, WorldHistory: 0, Monsters: 0, Cosmic: 0 };
}

// Wipes the actor's App-synced system fields + SD20 flags back to template
// defaults. Does NOT touch any tokens on canvas. Caller decides whether to
// also reset specific tokens or leave them (orphaned snapshots).
export async function resetActorToBlank(actor) {
  if (!actor?.id) return;
  try {
    await actor.update({
      'system.hp': { value: 0, max: 0 },
      'system.fp': { value: 0, max: 0 },
      'system.ap': { value: 8, max: 8 },
      'system.level': 0,
      'system.stats': _templateStats(),
      'system.skills': _templateSkills(),
      'system.knowledge': _templateKnowledge(),
      'system.equippedWeapons': null,
      'system.macroSets': null,
      [`flags.${CONFIG.MODULE_ID}.characterData`]: null,
      [`flags.${CONFIG.MODULE_ID}.skills`]: null,
      [`flags.${CONFIG.MODULE_ID}.knowledge`]: null,
      [`flags.${CONFIG.MODULE_ID}.equipment`]: null,
      [`flags.${CONFIG.MODULE_ID}.attuned_spells`]: null,
      [`flags.${CONFIG.MODULE_ID}.attuned_spirits`]: null,
      [`flags.${CONFIG.MODULE_ID}.attuned_weapon_skills`]: null,
      [`flags.${CONFIG.MODULE_ID}.combat`]: null,
      [`flags.${CONFIG.MODULE_ID}.statMods`]: null
    });
  } catch (err) {
    warn(`Failed to reset actor "${actor.name}":`, err);
  }
}

// Wipes one token's delta + SD20 flags back to blank. Used by the hard-unlink
// path to clear ONLY the clicked token. Other tokens of the same actor are
// left alone (linked ones follow the actor, unlinked ones keep their delta).
export async function resetTokenToBlank(tokenDoc) {
  if (!tokenDoc) return;
  const clearedFlags = {
    [`flags.${CONFIG.MODULE_ID}.characterUUID`]: null,
    [`flags.${CONFIG.MODULE_ID}.characterData`]: null,
    [`flags.${CONFIG.MODULE_ID}.skills`]: null,
    [`flags.${CONFIG.MODULE_ID}.knowledge`]: null,
    [`flags.${CONFIG.MODULE_ID}.equipment`]: null,
    [`flags.${CONFIG.MODULE_ID}.attuned_spells`]: null,
    [`flags.${CONFIG.MODULE_ID}.attuned_spirits`]: null,
    [`flags.${CONFIG.MODULE_ID}.attuned_weapon_skills`]: null,
    [`flags.${CONFIG.MODULE_ID}.combat`]: null,
    [`flags.${CONFIG.MODULE_ID}.combatSettings`]: null,
    [`flags.${CONFIG.MODULE_ID}.statMods`]: null,
    [`flags.${CONFIG.MODULE_ID}.macroSets`]: null,
    [`flags.${CONFIG.MODULE_ID}.orphaned`]: null
  };
  const update = { ...clearedFlags };
  if (!tokenDoc.actorLink) {
    update['delta.system.hp'] = { value: 0, max: 0 };
    update['delta.system.fp'] = { value: 0, max: 0 };
    update['delta.system.ap'] = { value: 8, max: 8 };
    update['delta.system.level'] = 0;
    update['delta.system.stats'] = _templateStats();
    update['delta.system.skills'] = _templateSkills();
    update['delta.system.knowledge'] = _templateKnowledge();
    update['delta.system.equippedWeapons'] = null;
    update['delta.system.resistances'] = null;
    update['delta.system.skillBonuses'] = null;
  }
  try {
    await tokenDoc.update(update);
  } catch (err) {
    warn(`Failed to reset token "${tokenDoc.name}":`, err);
  }
  const placed = canvas?.tokens?.get(tokenDoc.id);
  if (placed) placed.refresh();
}

// Soft-unlink helper. Marks every existing token of this actor as orphaned so
// future actor-level syncs (link, unlink, re-link) skip them. Tokens keep
// whatever data they had at this moment as a snapshot.
export async function orphanAllTokensOfActor(actor) {
  if (!actor?.id || !game.scenes) return;
  for (const scene of game.scenes) {
    const updates = [];
    for (const tokenDoc of scene.tokens) {
      if (tokenDoc.actorId !== actor.id) continue;
      if (tokenDoc.getFlag(CONFIG.MODULE_ID, 'orphaned')) continue;
      updates.push({
        _id: tokenDoc.id,
        [`flags.${CONFIG.MODULE_ID}.orphaned`]: true
      });
    }
    if (updates.length === 0) continue;
    try {
      await scene.updateEmbeddedDocuments('Token', updates);
    } catch (err) {
      warn(`Failed to orphan tokens on scene "${scene.name}":`, err);
    }
  }
}

/**
 * Get all character UUIDs that are linked to actors in this world
 */
export function getLinkedCharacterUUIDs() {
  const linkedUuids = [];

  for (const actor of game.actors) {
    const uuid = actor.system?.characterUUID;
    if (uuid && !linkedUuids.includes(uuid)) {
      linkedUuids.push(uuid);
    }
  }

  return linkedUuids;
}

/**
 * Request character data for all linked UUIDs
 * Called on connection established and when links change
 */
export function requestLinkedCharacterData() {
  const bcm = game.sd20.broadcastChannel;
  if (!bcm?.connected) {
    debug('Cannot request linked characters: not connected');
    return;
  }

  const linkedUuids = getLinkedCharacterUUIDs();

  if (linkedUuids.length === 0) {
    debug('No linked characters to request');
    return;
  }

  log(`Requesting data for ${linkedUuids.length} linked characters: ${linkedUuids.join(', ')}`);
  bcm.send(CONFIG.MESSAGE_TYPES.CHARACTER_REQUEST_LINKED, {
    linkedUuids: linkedUuids
  });
}

/**
 * Request immediate data for a specific character (used on first link)
 */
function requestImmediateCharacterData(uuid, actorId) {
  const bcm = game.sd20.broadcastChannel;
  if (!bcm?.connected) {
    warn('Cannot request character data: not connected to App');
    return;
  }

  log(`Requesting immediate data for character: ${uuid}`);
  bcm.send(CONFIG.MESSAGE_TYPES.COMBAT_DATA_REQUEST, {
    uuid: uuid,
    actorId: actorId,
    immediate: true  // Flag to indicate this is an immediate request
  });
}

function handleLinkedCharacterResponse(data) {
  if (!data.characters || !Array.isArray(data.characters)) {
    debug('Invalid linked character response');
    return;
  }

  log(`Received data for ${data.characters.length} linked characters`);

  for (const charData of data.characters) {
    if (!_validateCharacterData(charData)) continue;

    if (_shouldSkipReconnectResync(charData.uuid, charData)) {
      debug(`Skipping bulk re-sync for ${charData.uuid} (identical snapshot within ${RECONNECT_RESYNC_WINDOW_MS}ms)`);
      // Still keep the cache fresh, just do not rewrite the actor.
      game.sd20.characters[charData.uuid] = charData;
      continue;
    }

    game.sd20.characters[charData.uuid] = charData;
    updateActorsFromCharacterData(charData);
  }
}

/**
 * Handle combat data response (immediate fetch on first link)
 */
async function handleCombatDataResponse(data) {
  if (!data?.uuid) {
    debug('Invalid combat data response');
    return;
  }

  const dedupeKey = data.actorId ? `${data.uuid}:${data.actorId}` : data.uuid;
  if (_shouldSkipDuplicateResponse(dedupeKey)) {
    debug(`Duplicate combat:response-data for ${dedupeKey} within ${RESPONSE_DEDUPE_WINDOW_MS}ms, skipping`);
    return;
  }

  if (!_validateCharacterData(data)) return;

  const { uuid, actorId, requestId, ...characterData } = data;
  if (requestId) debug(`combat:response-data trace requestId=${requestId} uuid=${uuid}`);

  game.sd20.characters[uuid] = { uuid, ...characterData };

  if (actorId) {
    const actor = game.actors.get(actorId);
    if (actor && actor.system?.characterUUID === uuid) {
      // Capture before updateActorFromCharacterData consumes the marker.
      const wasFirstLink = _firstLinkPending.has(actor.id);
      await updateActorFromCharacterData(actor, { uuid, ...characterData });
      await _syncTokensFromActor(actor, { isFirstLink: wasFirstLink });
      ui.notifications.info(`Character data synced for ${actor.name}`);
    }
  } else {
    await updateActorsFromCharacterData({ uuid, ...characterData });
  }
}

/**
 * Update all actors linked to a character UUID
 */
async function updateActorsFromCharacterData(charData) {
  const linkedActors = game.actors.filter(a => a.system?.characterUUID === charData.uuid);

  if (linkedActors.length === 0) {
    debug(`No actors found for character UUID: ${charData.uuid}`);
    return;
  }

  for (const actor of linkedActors) {
    const wasFirstLink = _firstLinkPending.has(actor.id);
    await updateActorFromCharacterData(actor, charData);
    await _syncTokensFromActor(actor, { isFirstLink: wasFirstLink });
  }
}

/**
 * Update a single actor from character data
 */
async function updateActorFromCharacterData(actor, charData) {
  if (!actor || !charData) return;

  // First-link detection: keyed off the characterUUID transition latched by
  // the updateActor hook in registerCharacterSyncHandlers. This does not rely
  // on a persistent flag (which can fail to write on permission edge cases
  // and would cause every subsequent App refresh to be treated as a new link).
  // Once consumed here, the marker is removed so resyncs do not overwrite
  // current HP/FP/AP again.
  const isFirstLink = _firstLinkPending.has(actor.id);
  if (isFirstLink) {
    _firstLinkPending.delete(actor.id);
    debug(`First-link detected for ${actor.name}, will set current = max`);
  }

  const actorUpdates = {};

  actorUpdates[`flags.${CONFIG.MODULE_ID}.characterData`] = charData;

  if (charData.name && charData.name !== actor.name) {
    actorUpdates['name'] = charData.name;
    actorUpdates['prototypeToken.name'] = charData.name;
  }
  if (charData.level !== undefined) {
    actorUpdates['system.level'] = charData.level;
  }

  if (charData.stats) {
    actorUpdates['system.stats'] = charData.stats;
  }

  if (charData.maxHP !== undefined) {
    actorUpdates['system.hp.max'] = charData.maxHP;
    if (isFirstLink) actorUpdates['system.hp.value'] = charData.maxHP;
  }
  if (charData.maxFP !== undefined) {
    actorUpdates['system.fp.max'] = charData.maxFP;
    if (isFirstLink) actorUpdates['system.fp.value'] = charData.maxFP;
  }
  if (charData.maxAP !== undefined) {
    actorUpdates['system.ap.max'] = charData.maxAP;
    if (isFirstLink) actorUpdates['system.ap.value'] = charData.maxAP;
  }

  // Update skills and knowledge
  if (charData.skills) {
    actorUpdates[`flags.${CONFIG.MODULE_ID}.skills`] = charData.skills;
  }
  if (charData.knowledge) {
    actorUpdates[`flags.${CONFIG.MODULE_ID}.knowledge`] = charData.knowledge;
  }

  // Update equipment
  if (charData.equipment) {
    actorUpdates[`flags.${CONFIG.MODULE_ID}.equipment`] = charData.equipment;
  }

  // Update attuned abilities
  if (charData.attuned_spells) {
    actorUpdates[`flags.${CONFIG.MODULE_ID}.attuned_spells`] = charData.attuned_spells;
  }
  if (charData.attuned_spirits) {
    actorUpdates[`flags.${CONFIG.MODULE_ID}.attuned_spirits`] = charData.attuned_spirits;
  }
  if (charData.attuned_weapon_skills) {
    actorUpdates[`flags.${CONFIG.MODULE_ID}.attuned_weapon_skills`] = charData.attuned_weapon_skills;
  }

  // Update resistances and status thresholds
  if (charData.bonus_resistances) {
    actorUpdates[`flags.${CONFIG.MODULE_ID}.combat.resistances`] = charData.bonus_resistances;
  }
  if (charData.bonus_statuses || charData.statMods) {
    const statMods = charData.statMods || {};
    const bonus = charData.bonus_statuses || {};
    const endurance = charData.stats?.endurance || 10;
    actorUpdates[`flags.${CONFIG.MODULE_ID}.combat.statusThresholds`] = {
      Bleed: 10 + (statMods.strength || 0) + (bonus.Bleed || 0),
      Poison: 10 + (statMods.intelligence || 0) + (bonus.Poison || 0),
      Toxic: 10 + (statMods.intelligence || 0) + (bonus.Toxic || 0),
      Frost: 10 + (statMods.strength || 0) + (bonus.Frost || 0),
      Curse: 10 + (bonus.Curse || 0),
      Poise: endurance >= 10 ? endurance - 5 + (bonus.Poise || 0) : 5 + (bonus.Poise || 0)
    };
  }

  // Apply updates
  if (Object.keys(actorUpdates).length > 0) {
    try {
      await actor.update(actorUpdates);
      debug(`Actor "${actor.name}" updated from character data`);
    } catch (err) {
      warn(`Failed to update actor "${actor.name}":`, err);
    }
  }
}

/**
 * Handle character list response from App
 * Stores all received characters in module namespace
 */
function handleCharacterListResponse(data) {
  if (!data.characters || !Array.isArray(data.characters)) {
    return;
  }

  debug(`Received ${data.characters.length} characters from App`);

  // Store characters
  data.characters.forEach(character => {
    game.sd20.characters[character.uuid] = character;
  });

  // Update any linked tokens with fresh data
  syncAllLinkedTokens(data.characters);
}

/**
 * Optimization 3: apply a field-scoped delta from the App.
 *
 * Shape of `data`:
 *   { uuid, delta: { 'stats.strength': 16, 'combat_settings.twoHandingMainHand': true, ... } }
 * or
 *   { uuid, delta: { stats: { strength: 16 }, ... } }  (nested object form)
 *
 * We merge the delta into the actor's stored characterData snapshot, invalidate
 * the affected macro cache entries, and let the next macro-bar render pull
 * fresh macros without a full App round trip.
 */
async function handleCharacterDelta(data) {
  if (!data?.uuid || !data.delta || typeof data.delta !== 'object') {
    debug('CHARACTER_DELTA_UPDATE ignored: missing uuid or delta');
    return;
  }

  const uuid = data.uuid;
  const character = game.sd20?.characters?.[uuid];
  if (!character) {
    debug(`CHARACTER_DELTA_UPDATE for ${uuid}: no cached character, falling back to CHARACTER_UPDATE`);
    return;
  }

  // Merge delta into the in-memory character snapshot. Supports both nested
  // object shape and dot-path key shape.
  for (const [key, value] of Object.entries(data.delta)) {
    if (key.includes('.')) {
      foundry.utils.setProperty(character, key, value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      foundry.utils.mergeObject(character[key] ?? (character[key] = {}), value, { inplace: true });
    } else {
      character[key] = value;
    }
  }

  // Item 4 (Batch C): also merge the delta into the macro manager's cached
  // combatData so a subsequent getMacros can regenerate without a WS round
  // trip. Then mark the affected categories stale via changedFields so the
  // regen path fires.
  try {
    const { mergeDeltaIntoCache } = await import('./macroManager.js');
    mergeDeltaIntoCache(uuid, data.delta);
  } catch (err) {
    debug('mergeDeltaIntoCache import failed:', err);
  }

  const mgr = game.sd20?.macroManager;
  if (mgr?.invalidateCache) mgr.invalidateCache(uuid, Object.keys(data.delta));

  const token = findTokenByUUID(uuid);
  if (token) {
    updateTokenFromCharacter(token, character);
  }
}

function handleCharacterUpdate(data) {
  if (!data?.uuid) {
    warn('Invalid character update data:', data);
    return;
  }

  const uuid = data.uuid;

  const existingTimer = _pendingUpdates.get(uuid);
  if (existingTimer) {
    clearTimeout(existingTimer.timerId);
    _pendingUpdates.delete(uuid);
  }

  const timerId = setTimeout(() => {
    _pendingUpdates.delete(uuid);
    _processCharacterUpdate(uuid, data);
  }, CHARACTER_UPDATE_DEBOUNCE_MS);

  _pendingUpdates.set(uuid, { timerId, data });
}

function _processCharacterUpdate(uuid, data) {
  debug(`Character update processed for ${uuid}`);

  if (!_validateCharacterData(data)) return;

  if (game.sd20.characters[uuid]) {
    Object.assign(game.sd20.characters[uuid], data);
  }

  // Item 2 (Batch C): invalidate cached macros for this uuid so the next
  // macro-bar render regenerates from fresh data. Without this, macros
  // sit on the pre-update cache until the 30s TTL expires. That was the
  // Bug 6 root cause: two-handing toggled on the App would take up to
  // 30s to reflect in Foundry macros.
  const mgr = game.sd20?.macroManager;
  if (mgr?.invalidateCache) mgr.invalidateCache(uuid);

  const token = findTokenByUUID(uuid);
  if (!token) {
    debug(`No token linked to character ${uuid}`);
    return;
  }

  updateTokenFromCharacter(token, data);
}

/**
 * Sync all linked tokens with character data
 * Called when receiving full character list
 */
function syncAllLinkedTokens(characters) {
  if (!canvas?.tokens?.placeables) return;

  const characterMap = new Map(characters.map(c => [c.uuid, c]));

  canvas.tokens.placeables.forEach(token => {
    const uuid = getTokenCharacterUUID(token);
    if (uuid && characterMap.has(uuid)) {
      const character = characterMap.get(uuid);
      updateTokenFromCharacter(token, character);
    }
  });
}

/**
 * Update token bars and properties from character data
 */
async function updateTokenFromCharacter(token, changes) {
  const uuid = getTokenCharacterUUID(token);
  const character = game.sd20.characters[uuid] || changes;
  const actor = token.actor;

  // Update Actor system data (token bars auto-bind via primaryTokenAttribute/secondaryTokenAttribute)
  if (actor) {
    const actorUpdates = {};

    // App pushes only touch max values. Current HP/FP/AP are owned by
    // Foundry's damage system once the character is linked. App-side flask
    // drinks etc. used to flow back here and reset combat state mid-fight.
    if (changes.maxHP !== undefined && _isPositiveInt(changes.maxHP)) {
      actorUpdates['system.hp.max'] = changes.maxHP;
    }
    if (changes.maxFP !== undefined && _isPositiveInt(changes.maxFP)) {
      actorUpdates['system.fp.max'] = changes.maxFP;
    }
    if (changes.maxAP !== undefined && _isPositiveInt(changes.maxAP)) {
      actorUpdates['system.ap.max'] = changes.maxAP;
    }

    // Store equipped weapon scaling data for runtime macro resolution
    if (character.mainHand !== undefined || character.offHand !== undefined) {
      actorUpdates['system.equippedWeapons'] = {
        mainHand: character.mainHand ? {
          name: character.mainHand.name || null,
          scalingBonus: character.mainHand.scalingBonus ?? 0
        } : null,
        offHand: character.offHand ? {
          name: character.offHand.name || null,
          scalingBonus: character.offHand.scalingBonus ?? 0
        } : null
      };
    }

    // Sync actor name from App character name
    if (changes.name !== undefined && changes.name !== actor.name) {
      actorUpdates['name'] = changes.name;
      // Also update prototype token name so new tokens get the correct name
      actorUpdates['prototypeToken.name'] = changes.name;
    }

    // Store stats, skills, knowledge on actor system data
    if (changes.stats) actorUpdates['system.stats'] = changes.stats;
    if (changes.statMods) actorUpdates[`flags.${CONFIG.MODULE_ID}.statMods`] = changes.statMods;
    if (changes.skills) actorUpdates[`flags.${CONFIG.MODULE_ID}.skills`] = changes.skills;
    if (changes.knowledge) actorUpdates[`flags.${CONFIG.MODULE_ID}.knowledge`] = changes.knowledge;

    // Store resistance and threshold data on actor flags
    if (changes.resistances) {
      actorUpdates[`flags.${CONFIG.MODULE_ID}.combat.resistances`] = changes.resistances;
    }
    if (changes.bonusStatuses || changes.statMods) {
      const statMods = changes.statMods || {};
      const bonus = changes.bonusStatuses || {};
      const endurance = changes.stats?.endurance || character.stats?.endurance || 10;
      actorUpdates[`flags.${CONFIG.MODULE_ID}.combat.statusThresholds`] = {
        Bleed: 10 + (statMods.strength || 0) + (bonus.Bleed || 0),
        Poison: 10 + (statMods.intelligence || 0) + (bonus.Poison || 0),
        Toxic: 10 + (statMods.intelligence || 0) + (bonus.Toxic || 0),
        Frost: 10 + (statMods.strength || 0) + (bonus.Frost || 0),
        Curse: 10 + (bonus.Curse || 0),
        Poise: endurance >= 10 ? endurance - 5 + (bonus.Poise || 0) : 5 + (bonus.Poise || 0)
      };
    }

    if (Object.keys(actorUpdates).length > 0) {
      // Check if user has permission to update this actor
      const canUpdate = actor.isOwner || game.user.isGM;

      if (canUpdate) {
        try {
          await actor.update(actorUpdates);
          debug(`Actor "${actor.name}" system data updated:`, Object.keys(actorUpdates));
        } catch (err) {
          // If direct update fails (e.g., ActorDelta permission), route through GM socket
          debug(`Direct actor update failed, routing through GM socket: ${err.message}`);
          _requestGMUpdate('actor', actor.uuid, actorUpdates);
        }
      } else {
        // Route through GM socket for non-owned actors
        debug(`No permission to update actor "${actor.name}", routing through GM socket`);
        _requestGMUpdate('actor', actor.uuid, actorUpdates);
      }
    }
  }

  // Update token name if character name changed
  if (changes.name !== undefined) {
    const canUpdateToken = token.document.isOwner || game.user.isGM;

    if (canUpdateToken) {
      try {
        await token.document.update({ name: changes.name });
        debug(`Token "${token.name}" name updated`);
      } catch (err) {
        debug(`Direct token update failed, routing through GM socket: ${err.message}`);
        _requestGMUpdate('token', token.document.uuid, { name: changes.name });
      }
    } else {
      debug(`No permission to update token "${token.name}", routing through GM socket`);
      _requestGMUpdate('token', token.document.uuid, { name: changes.name });
    }
  }
}

/**
 * Request GM to perform an update on behalf of the player
 */
function _requestGMUpdate(documentType, documentUuid, updates) {
  game.socket.emit(`system.${CONFIG.MODULE_ID}`, {
    type: CONFIG.MESSAGE_TYPES.GM_UPDATE_REQUEST,
    documentType,
    documentUuid,
    updates
  });
}

/**
 * Sync combat-specific data (resistances, thresholds) to actor flags
 * Called when fresh combat data arrives from the App
 */
export async function syncCombatDataToActor(actor, combatData) {
  if (!actor || !combatData) return;

  const flagUpdates = {};

  // Store resistance tables on actor flags
  if (combatData.resistances) {
    flagUpdates.resistances = combatData.resistances;
  }

  // Compute and store status thresholds from statMods + bonusStatuses
  const statMods = combatData.statMods || {};
  const bonus = combatData.bonusStatuses || {};
  const endurance = combatData.stats?.endurance || 10;

  flagUpdates.statusThresholds = {
    Bleed: 10 + (statMods.strength || 0) + (bonus.Bleed || 0),
    Poison: 10 + (statMods.intelligence || 0) + (bonus.Poison || 0),
    Toxic: 10 + (statMods.intelligence || 0) + (bonus.Toxic || 0),
    Frost: 10 + (statMods.strength || 0) + (bonus.Frost || 0),
    Curse: 10 + (bonus.Curse || 0),
    Poise: endurance >= 10 ? endurance - 5 + (bonus.Poise || 0) : 5 + (bonus.Poise || 0)
  };

  // Batch update all flags at once
  await actor.update({ [`flags.${CONFIG.MODULE_ID}.combat`]: flagUpdates });
  debug(`Combat data synced to actor "${actor.name}":`, Object.keys(flagUpdates));
}

/**
 * Request fresh character data for a specific UUID
 * Useful for refreshing a single character's data
 */
export function requestCharacterData(uuid) {
  game.sd20.broadcastChannel.send(CONFIG.MESSAGE_TYPES.CHARACTER_REQUEST, {
    uuid,
    timestamp: Date.now()
  });
}