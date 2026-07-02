/**
 * SD20 Data Migration
 * Migrates Actor/Token flag data to system data fields
 */

import { log, warn } from './utils.js';
import { CONFIG } from './config.js';
import { normalizeMacroSets } from './macroNormalize.js';

// Bug 4: v3 walks every actor/token macroSets and assigns id + _source tags
// to combat sub-array entries so re-link merges by stable id instead of by
// content-derived identity.
const MIGRATION_VERSION = 3;
const RESTRICTED_CATEGORIES = ['initiative', 'skillChecks', 'knowledgeChecks', 'statChecks'];

/**
 * Run migration if needed (called on ready hook)
 */
export async function runMigration() {
  if (!game.user.isGM) return;

  const currentVersion = game.settings.get(CONFIG.MODULE_ID, 'migrationVersion');
  if (currentVersion >= MIGRATION_VERSION) return;

  log(`Starting migration from v${currentVersion} to v${MIGRATION_VERSION}`);
  ui.notifications.info('SD20: Migrating world data to system format...');

  let migratedActors = 0;
  let migratedTokens = 0;
  const revertedCheckMacros = { actors: [], tokens: [], total: 0 };

  // Migrate all Actors
  for (const actor of game.actors) {
    const updated = await migrateActor(actor, revertedCheckMacros);
    if (updated) migratedActors++;
  }

  // Migrate tokens in all scenes
  for (const scene of game.scenes) {
    for (const tokenDoc of scene.tokens) {
      const updated = await migrateToken(tokenDoc, revertedCheckMacros);
      if (updated) migratedTokens++;
    }
  }

  // Mark migration complete
  await game.settings.set(CONFIG.MODULE_ID, 'migrationVersion', MIGRATION_VERSION);

  log(`Migration complete: ${migratedActors} actors, ${migratedTokens} tokens migrated`);
  if (revertedCheckMacros.total > 0) {
    const actorNames = revertedCheckMacros.actors.length ? `actors: ${revertedCheckMacros.actors.join(', ')}` : '';
    const tokenNames = revertedCheckMacros.tokens.length ? `tokens: ${revertedCheckMacros.tokens.join(', ')}` : '';
    log(`Reverted ${revertedCheckMacros.total} corrupted check macros across ${[actorNames, tokenNames].filter(Boolean).join('; ')}`);
    ui.notifications.info(`SD20: Reverted ${revertedCheckMacros.total} check macros to skill-check format`);
  }
  ui.notifications.info(`SD20: Migration complete (${migratedActors} actors, ${migratedTokens} tokens)`);
}

/**
 * Walks a macroSets structure and reverts any check macro that was silently
 * converted to a PHYSICAL damage entry by the legacy builder.
 * Returns the number of macros reverted (0 if none).
 */
function revertCorruptedCheckMacros(macroSets) {
  if (!macroSets?.sets) return 0;

  let count = 0;
  for (const setData of Object.values(macroSets.sets)) {
    const macros = setData?.macros;
    if (!Array.isArray(macros)) continue;
    for (let i = 0; i < macros.length; i++) {
      const macro = macros[i];
      if (!macro || typeof macro !== 'object') continue;
      if (!RESTRICTED_CATEGORIES.includes(macro.macroCategory)) continue;
      const damageEntries = macro.combat?.damageTypes;
      if (!Array.isArray(damageEntries) || damageEntries.length === 0) continue;
      const allD20 = damageEntries.every(e => e?.diceSides === 20);
      if (!allD20) continue;

      macro.dice = [{ count: 1, sides: 20, type: null }];
      if (macro.combat) {
        macro.combat.damageTypes = [];
      } else {
        macro.combat = { damageTypes: [] };
      }
      count++;
    }
  }
  return count;
}

/**
 * Migrate a single Actor's flag data to system data
 */
async function migrateActor(actor, revertedTracker) {
  const updates = {};
  let hasChanges = false;

  // Migrate characterUUID
  const flagUUID = actor.getFlag(CONFIG.MODULE_ID, 'characterUUID');
  if (flagUUID && !actor.system?.characterUUID) {
    updates['system.characterUUID'] = flagUUID;
    hasChanges = true;
  }

  // Migrate macroSets
  const flagMacroSets = actor.getFlag(CONFIG.MODULE_ID, 'macroSets');
  if (flagMacroSets && !actor.system?.macroSets) {
    updates['system.macroSets'] = flagMacroSets;
    hasChanges = true;
  }

  // Migrate toggledWeapons
  const flagWeapons = actor.getFlag(CONFIG.MODULE_ID, 'toggledWeapons');
  if (flagWeapons && (!actor.system?.toggledWeapons || actor.system.toggledWeapons.length === 0)) {
    updates['system.toggledWeapons'] = flagWeapons;
    hasChanges = true;
  }

  // Revert any check macros that were silently corrupted to PHYSICAL damage.
  // Operate on a clone so we can pipe the updated structure through actor.update.
  if (revertedTracker && actor.system?.macroSets) {
    const cloned = foundry.utils.deepClone(actor.system.macroSets);
    const reverted = revertCorruptedCheckMacros(cloned);
    if (reverted > 0) {
      updates['system.macroSets'] = cloned;
      hasChanges = true;
      revertedTracker.total += reverted;
      revertedTracker.actors.push(`${actor.name}(${reverted})`);
    }
  }

  // Bug 4: assign id + _source to every combat entry that lacks one. Reads
  // the freshest structure from either updates['system.macroSets'] (if we
  // already touched it above) or actor.system.macroSets. Idempotent.
  const workingMacroSets = updates['system.macroSets'] ?? actor.system?.macroSets;
  if (workingMacroSets) {
    const beforeSerialized = JSON.stringify(workingMacroSets);
    const cloned = updates['system.macroSets'] ? workingMacroSets : foundry.utils.deepClone(workingMacroSets);
    normalizeMacroSets(cloned, 'app');
    const afterSerialized = JSON.stringify(cloned);
    if (beforeSerialized !== afterSerialized) {
      updates['system.macroSets'] = cloned;
      hasChanges = true;
    }
  }

  if (hasChanges) {
    await actor.update(updates);
    log(`Migrated Actor "${actor.name}": ${Object.keys(updates).join(', ')}`);

    // Clean up old flags after successful migration
    try {
      if (flagUUID) await actor.unsetFlag(CONFIG.MODULE_ID, 'characterUUID');
      if (flagMacroSets) await actor.unsetFlag(CONFIG.MODULE_ID, 'macroSets');
      if (flagWeapons) await actor.unsetFlag(CONFIG.MODULE_ID, 'toggledWeapons');
    } catch (e) {
      warn(`Could not clean up flags for Actor "${actor.name}":`, e);
    }
  }

  return hasChanges;
}

/**
 * Migrate token-level flags (clean up legacy data)
 */
async function migrateToken(tokenDoc, revertedTracker) {
  const flagUUID = tokenDoc.getFlag(CONFIG.MODULE_ID, 'characterUUID');
  const flagMacroSets = tokenDoc.getFlag(CONFIG.MODULE_ID, 'macroSets');
  let touched = false;

  if (flagUUID || flagMacroSets) {
    touched = true;

    // If token has an actor, migrate data there first
    const actor = tokenDoc.actor;
    if (actor && flagUUID && !actor.system?.characterUUID) {
      await actor.update({ 'system.characterUUID': flagUUID });
      log(`Migrated characterUUID from token to Actor "${actor.name}"`);
    }
    if (actor && flagMacroSets && !actor.system?.macroSets) {
      await actor.update({ 'system.macroSets': flagMacroSets });
      log(`Migrated macroSets from token to Actor "${actor.name}"`);
    }

    // Clean up token flags
    try {
      if (flagUUID) await tokenDoc.unsetFlag(CONFIG.MODULE_ID, 'characterUUID');
      if (flagMacroSets) await tokenDoc.unsetFlag(CONFIG.MODULE_ID, 'macroSets');
    } catch (e) {
      warn(`Could not clean up flags for token "${tokenDoc.name}":`, e);
    }
  }

  // Unlinked NPC tokens still keep their macroSets on a token-document flag;
  // revert corrupted check macros there as well.
  if (revertedTracker) {
    const tokenMacroSets = tokenDoc.getFlag(CONFIG.MODULE_ID, 'macroSets');
    if (tokenMacroSets) {
      const cloned = foundry.utils.deepClone(tokenMacroSets);
      const reverted = revertCorruptedCheckMacros(cloned);
      // Bug 4: normalize the same token macroSets clone so unlinked NPCs get
      // stable ids too. Idempotent.
      normalizeMacroSets(cloned, 'custom');
      const beforeSerialized = JSON.stringify(tokenMacroSets);
      const afterSerialized = JSON.stringify(cloned);
      if (reverted > 0 || beforeSerialized !== afterSerialized) {
        try {
          await tokenDoc.setFlag(CONFIG.MODULE_ID, 'macroSets', cloned);
          if (reverted > 0) {
            revertedTracker.total += reverted;
            revertedTracker.tokens.push(`${tokenDoc.name}(${reverted})`);
          }
          touched = true;
        } catch (e) {
          warn(`Could not update macroSets on token "${tokenDoc.name}":`, e);
        }
      }
    }
  }

  return touched;
}

/**
 * Register migration settings
 */
export function registerMigrationSettings() {
  game.settings.register(CONFIG.MODULE_ID, 'migrationVersion', {
    name: 'Migration Version',
    scope: 'world',
    config: false,
    type: Number,
    default: 0
  });
}