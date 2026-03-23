/**
 * Character Data Sync
 * Handles character updates from SD20 App and syncs to linked tokens
 */

import { CONFIG } from './config.js';
import { log, debug, warn, findTokenByUUID, getTokenCharacterUUID } from './utils.js';

/**
 * Register character sync handlers with BroadcastChannel
 */
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
      requestImmediateCharacterData(newUUID, actor.id);
    }

    // If UUID was cleared, update the linked UUIDs list
    if (!newUUID && oldUUID) {
      log(`Character unlinked from "${actor.name}"`);
      // Re-request to update App's knowledge of linked UUIDs
      requestLinkedCharacterData();
    }
  });

  log('Character sync handlers registered');
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

/**
 * Handle linked character response from App
 * Updates all actors linked to the received characters
 */
function handleLinkedCharacterResponse(data) {
  if (!data.characters || !Array.isArray(data.characters)) {
    debug('Invalid linked character response');
    return;
  }

  log(`Received data for ${data.characters.length} linked characters`);

  // Store and sync each character
  for (const charData of data.characters) {
    // Store in module namespace
    game.sd20.characters[charData.uuid] = charData;

    // Update all actors linked to this character
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

  const { uuid, actorId, ...characterData } = data;

  // Store character data
  game.sd20.characters[uuid] = { uuid, ...characterData };

  // If actorId was provided, update that specific actor
  if (actorId) {
    const actor = game.actors.get(actorId);
    if (actor && actor.system?.characterUUID === uuid) {
      await updateActorFromCharacterData(actor, { uuid, ...characterData });
      ui.notifications.info(`Character data synced for ${actor.name}`);

      // Trigger macro bar refresh if this actor's token is selected
      const macroBar = game.sd20?.getActiveMacroBar?.();
      if (macroBar && macroBar.actor?.id === actorId) {
        await macroBar.refreshMacros?.();
        macroBar.render?.();
      }
    }
  } else {
    // No specific actor, update all actors with this UUID
    updateActorsFromCharacterData({ uuid, ...characterData });
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
    await updateActorFromCharacterData(actor, charData);
  }
}

/**
 * Update a single actor from character data
 */
async function updateActorFromCharacterData(actor, charData) {
  if (!actor || !charData) return;

  const actorUpdates = {};

  // Store the full character data for macro generation
  actorUpdates[`flags.${CONFIG.MODULE_ID}.characterData`] = charData;

  // Update basic info
  if (charData.name && charData.name !== actor.name) {
    actorUpdates['name'] = charData.name;
    actorUpdates['prototypeToken.name'] = charData.name;
  }
  if (charData.level !== undefined) {
    actorUpdates['system.level'] = charData.level;
  }

  // Update stats
  if (charData.stats) {
    actorUpdates['system.stats'] = charData.stats;
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
 * Handle individual character update from App
 * Updates stored data and syncs to linked token
 */
function handleCharacterUpdate(data) {
  if (!data?.uuid) {
    warn('Invalid character update data:', data);
    return;
  }

  const uuid = data.uuid;
  debug(`Character update received for ${uuid}`);

  // Update stored character data
  if (game.sd20.characters[uuid]) {
    Object.assign(game.sd20.characters[uuid], data);
  }

  // Find and update linked token
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

    if (changes.currentHP !== undefined || changes.maxHP !== undefined) {
      if (changes.currentHP !== undefined) actorUpdates['system.hp.value'] = changes.currentHP;
      if (changes.maxHP !== undefined) actorUpdates['system.hp.max'] = changes.maxHP;
    }

    if (changes.currentFP !== undefined || changes.maxFP !== undefined) {
      if (changes.currentFP !== undefined) actorUpdates['system.fp.value'] = changes.currentFP;
      if (changes.maxFP !== undefined) actorUpdates['system.fp.max'] = changes.maxFP;
    }

    if (changes.currentAP !== undefined || changes.maxAP !== undefined) {
      if (changes.currentAP !== undefined) actorUpdates['system.ap.value'] = changes.currentAP;
      if (changes.maxAP !== undefined) actorUpdates['system.ap.max'] = changes.maxAP;
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