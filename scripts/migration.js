/**
 * SD20 Data Migration
 * Migrates Actor/Token flag data to system data fields
 */

import { log, warn } from './utils.js';
import { CONFIG } from './config.js';

const MIGRATION_VERSION = 1;

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

  // Migrate all Actors
  for (const actor of game.actors) {
    const updated = await migrateActor(actor);
    if (updated) migratedActors++;
  }

  // Migrate tokens in all scenes
  for (const scene of game.scenes) {
    for (const tokenDoc of scene.tokens) {
      const updated = await migrateToken(tokenDoc);
      if (updated) migratedTokens++;
    }
  }

  // Mark migration complete
  await game.settings.set(CONFIG.MODULE_ID, 'migrationVersion', MIGRATION_VERSION);

  log(`Migration complete: ${migratedActors} actors, ${migratedTokens} tokens migrated`);
  ui.notifications.info(`SD20: Migration complete (${migratedActors} actors, ${migratedTokens} tokens)`);
}

/**
 * Migrate a single Actor's flag data to system data
 */
async function migrateActor(actor) {
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
async function migrateToken(tokenDoc) {
  const flagUUID = tokenDoc.getFlag(CONFIG.MODULE_ID, 'characterUUID');
  const flagMacroSets = tokenDoc.getFlag(CONFIG.MODULE_ID, 'macroSets');

  if (!flagUUID && !flagMacroSets) return false;

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

  return true;
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