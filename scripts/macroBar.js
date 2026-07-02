/**
 * Macro Bar UI
 * Category-based macro bar with dropdown menus
 * Uses direct DOM manipulation for v13 compatibility
 */

import { CONFIG } from './config.js';
import { log, debug, resolveMaxUses, renderDiceBreakdown } from './utils.js';
import { addMacrosToLibraryBatch } from './macroLibrary.js';
import { resolveTargets } from './targetingSystem.js';
import { setExecutionContext, clearExecutionContext } from './sd20Api.js';
import { playMacroAnimation, isAnimationSystemAvailable, selectAnimationTarget, animationNeedsTarget, cancelActiveGridSelection } from './animationSystem.js';
import { resetActorToBlank, resetTokenToBlank, orphanAllTokensOfActor } from './characterSync.js';
import { postMaskedChat } from './permissions.js';
import { normalizeMacroEntries } from './macroNormalize.js';
import { placeAoETemplate } from './aoePlacement.js';

const { DialogV2 } = foundry.applications.api;

const MAX_MACROS_PER_SET = 50; // Max macros per set (for auto-populate limit)
const INACTIVE_TIMEOUT = 5000; // 5 seconds before becoming transparent
const MAX_SET_NAME_LENGTH = 20; // Max characters for set names

// Macro chaining: queue of macros to execute after current one completes
const _chainQueue = [];

/**
 * Queue a macro to execute after the current one finishes.
 * Can be called multiple times to chain a sequence of macros.
 * Only available inside custom scripts via sd20.chainMacro().
 * @param {string|number} macroIdentifier - Macro name (string) or slot index (number)
 */
export function chainMacro(macroIdentifier) {
  _chainQueue.push(macroIdentifier);
  debug(`Macro chain queued: ${macroIdentifier} (queue length: ${_chainQueue.length})`);
}

/** Execute the next chained macro from the queue if any remain */
function _executeChainIfPending(macroBar) {
  if (!_chainQueue.length || !macroBar) return;

  const identifier = _chainQueue.shift();

  // Find the macro by name or slot index
  const macros = macroBar.macroSets?.[macroBar.activeSet]?.macros || [];
  let chainedMacro = null;

  if (typeof identifier === 'number') {
    chainedMacro = macros[identifier] || null;
  } else if (typeof identifier === 'string') {
    chainedMacro = macros.find(m => m?.name === identifier) || null;
  }

  if (!chainedMacro) {
    debug(`Chained macro not found: ${identifier}`);
    ui.notifications.warn(`Chained macro "${identifier}" not found in current macro set`);
    _chainQueue.length = 0; // Clear remaining chain on failure
    return;
  }

  debug(`Executing chained macro: ${chainedMacro.name}`);
  macroBar.executeMacro(chainedMacro, true);
}

/**
 * Macro Bar - Direct DOM implementation for Foundry v13 compatibility
 * Avoids Application V1 deprecation issues
 *
 * Storage: Actor flags (persists across token deletion/recreation)
 * - characterUUID: Link to SD20 App character
 * - macroSets: All macro sets and their macros
 */
export class MacroBar {
  constructor(tokenId) {
    this.tokenId = tokenId;
    this.actorId = null; // Actor ID for flag storage
    this.characterUUID = null;
    this.activeSet = 1;
    // Sets are now stored as an object with metadata: { id, name, macros, active }
    this.macroSets = {};
    this.setOrder = []; // Array of set IDs in display order
    this.element = null;
    this.rendered = false;
    // Dropdown state
    this.openCategory = null;
    this.groupedMacros = {};
    // Activity tracking for transparency effect
    this.inactivityTimer = null;
    this.isInactive = false;
    // Permission tracking
    this.isReadOnly = false;
    // Aborts in-flight refreshMacros() when the bar is closed or a newer refresh starts
    this._refreshAbortController = null;
  }

  /**
   * Initialize macro bar for a token
   * Now uses Actor flags for persistent storage across token deletion/recreation
   */
  async initialize() {
    const token = canvas.tokens.get(this.tokenId);
    if (!token) {
      debug('MacroBar.initialize: token not found');
      return;
    }

    debug(`MacroBar.initialize: token="${token.name}", tokenId=${this.tokenId}`);

    // Get Actor ID from token
    const actorId = token.actor?.id;
    if (!actorId) {
      debug('Token has no actor - macro bar requires an actor for storage');
      ui.notifications.warn('SD20 Macro Bar requires a token linked to an Actor');
      return;
    }

    // IMPORTANT: Fetch Actor fresh from game.actors to get latest flags
    // token.actor may have stale cached data on newly created tokens
    const actor = game.actors.get(actorId);
    if (!actor) {
      debug('Actor not found in game.actors');
      return;
    }

    debug(`MacroBar.initialize: actor="${actor.name}", actorId=${actor.id}`);
    this.actorId = actor.id;

    // Track whether this is an unlinked token (NPC/monster)
    // Unlinked tokens need token-specific storage, not actor storage
    this.isUnlinked = !token.document.actorLink;
    debug(`MacroBar.initialize: isUnlinked=${this.isUnlinked}`);

    // Check if user has permission to modify this actor
    this.isReadOnly = !actor.isOwner;

    // Get characterUUID from system data, then legacy flags
    const actorCharUUID = actor.system?.characterUUID;
    const legacyCharUUID = actor.getFlag(CONFIG.MODULE_ID, 'characterUUID')
      || token.document.getFlag(CONFIG.MODULE_ID, 'characterUUID');
    this.characterUUID = actorCharUUID || legacyCharUUID;

    debug(`MacroBar.initialize: actorCharUUID=${actorCharUUID}, legacyCharUUID=${legacyCharUUID}, using=${this.characterUUID}`);

    // Migrate token data to actor if needed (only if linked)
    if (this.characterUUID) {
      await this._migrateTokenToActor(token, actor);
    }

    // Load saved macro sets
    // Storage strategy:
    // - App-linked characters (has characterUUID): ACTOR flags (persists across tokens, App provides fresh macros)
    // - Unlinked NPCs (no characterUUID, actorLink=false): TOKEN flags (each token is independent)
    // - Linked tokens without App (no characterUUID, actorLink=true): ACTOR flags

    // Determine storage location: use actor flags if linked to App OR if token is actor-linked
    const useActorStorage = this.characterUUID || !this.isUnlinked;

    let savedData;
    if (useActorStorage) {
      savedData = actor.system?.macroSets || actor.getFlag(CONFIG.MODULE_ID, 'macroSets');
      debug(`Loading macroSets from ACTOR (App-linked or actor-linked token)`);
    } else {
      // Only use token flags for unlinked NPCs without App connection
      savedData = token.document.getFlag(CONFIG.MODULE_ID, 'macroSets');
      debug(`Loading macroSets from TOKEN document for unlinked NPC`);
    }
    if (savedData) {
      // Check if it's the new format (has setOrder) or old format
      if (savedData.setOrder) {
        // New format
        this.activeSet = savedData.activeSet || savedData.setOrder[0];
        this.macroSets = savedData.sets || {};
        this.setOrder = savedData.setOrder || [];
      } else if (savedData.sets) {
        // Old format - migrate to new
        this._migrateOldFormat(savedData);
      }
    }

    // Initialize with default set if empty
    if (this.setOrder.length === 0) {
      this._initializeDefaultSets();
    }

    // Fetch macros from App only if linked to a character
    if (this.characterUUID) {
      await this.refreshMacros();
    } else {
      // For unlinked actors (NPCs/monsters), generate basic macros from token's actor data
      // IMPORTANT: Use token.actor (synthetic actor) for unlinked tokens to get token-specific stats
      // game.actors.get() returns base actor which lacks token-specific combat settings
      const actorForMacros = this.isUnlinked ? token.actor : actor;
      debug(`Generating macros for ${this.isUnlinked ? 'UNLINKED' : 'linked'} actor, using: ${actorForMacros?.name}`);
      await this._generateBasicMacrosForActor(actorForMacros, token);
    }
  }

  /**
   * Generate basic macros (initiative, skill checks, stat checks) for unlinked actors
   * Used for NPCs/monsters that don't have a character in the SD20 App
   * @param {Actor} actor - The actor to generate macros for (use token.actor for unlinked tokens)
   * @param {Token} token - Optional token reference for context
   * @param {boolean} forceRegenerate - If true, clear existing check macros and regenerate
   */
  async _generateBasicMacrosForActor(actor, token = null, forceRegenerate = false) {
    if (!actor) return;

    const activeSetData = this.macroSets[this.activeSet];
    if (!activeSetData) return;

    // If force regenerating, remove all existing check- macros first
    if (forceRegenerate) {
      debug('Force regenerating macros - clearing existing check- macros');
      activeSetData.macros = activeSetData.macros.filter(m => !m?.id?.startsWith('check-'));
    }

    // Check if basic macros already exist
    const existingIds = new Set(activeSetData.macros.map(m => m?.id).filter(Boolean));
    const hasInitiative = existingIds.has('check-initiative');
    const hasSkillChecks = Array.from(existingIds).some(id => id?.startsWith('check-skill-'));
    const hasStatChecks = Array.from(existingIds).some(id => id?.startsWith('check-stat-'));

    // Skip if macros already exist (don't regenerate)
    if (hasInitiative && hasSkillChecks && hasStatChecks) {
      debug('Basic macros already exist for unlinked actor');
      return;
    }

    debug(`Generating basic macros for actor: ${actor.name} (type: ${actor.type})`);
    const macros = [];

    // Get actor stats from system data
    const stats = actor.system?.stats || {};
    const skills = actor.system?.skills || {};
    const skillBonuses = actor.system?.skillBonuses || {}; // NPCs have separate skill bonuses
    const knowledge = actor.system?.knowledge || {};

    // Debug: log stat values being read
    debug(`Actor stats:`, JSON.stringify(stats));
    debug(`Actor skills:`, JSON.stringify(skills));
    if (Object.keys(skillBonuses).length > 0) {
      debug(`Actor skillBonuses (NPC):`, JSON.stringify(skillBonuses));
    }

    // Initiative: 1d20 + dexterity mod
    if (!hasInitiative) {
      const dexMod = stats.dexterity?.mod ?? Math.floor(((stats.dexterity?.value || 10) - 10) / 2);
      macros.push({
        id: 'check-initiative',
        type: CONFIG.MACRO_TYPES.SKILL_CHECK,
        name: 'Initiative',
        description: `1d20 ${dexMod >= 0 ? '+' : '−'} ${Math.abs(dexMod)} (DEX)`,
        icon: 'fa-solid fa-bolt',
        apCost: 0,
        fpCost: 0,
        dice: [{ count: 1, sides: 20, value: 20, type: null }],
        scalingBonus: dexMod,
        source: CONFIG.MACRO_SOURCES.CUSTOM,
        macroCategory: 'initiative',
        macroSet: 1
      });
    }

    // Skill Checks
    if (!hasSkillChecks) {
      // Skill formulas: skillName -> [stat1, stat2] (skill total = stat1Mod + stat2Mod + flatBonus)
      const SKILL_FORMULAS = {
        Athletics: { stats: ['strength', 'endurance'], icon: 'fa-solid fa-dumbbell' },
        Acrobatics: { stats: ['dexterity', 'endurance'], icon: 'fa-solid fa-person-running' },
        Perception: { stats: ['intelligence', 'endurance'], icon: 'fa-solid fa-eye' },
        FireKeeping: { stats: ['faith', 'endurance'], icon: 'fa-solid fa-campfire' },
        Sanity: { stats: ['strength', 'attunement'], icon: 'fa-solid fa-brain' },
        Stealth: { stats: ['dexterity', 'attunement'], icon: 'fa-solid fa-mask' },
        Precision: { stats: ['intelligence', 'attunement'], icon: 'fa-solid fa-crosshairs' },
        Diplomacy: { stats: ['faith', 'attunement'], icon: 'fa-solid fa-handshake' }
      };

      // Helper to get stat mod (from stats object or calculate from value)
      const getStatMod = (statName) => {
        const statData = stats[statName];
        return statData?.mod ?? Math.floor(((statData?.value || 10) - 10) / 2);
      };

      for (const [skillName, { stats: [stat1, stat2], icon }] of Object.entries(SKILL_FORMULAS)) {
        // Calculate skill total: stat1Mod + stat2Mod + flatBonus
        const stat1Mod = getStatMod(stat1);
        const stat2Mod = getStatMod(stat2);
        const flatBonus = skillBonuses[skillName] ?? 0;
        const total = stat1Mod + stat2Mod + flatBonus;

        macros.push({
          id: `check-skill-${skillName.toLowerCase()}`,
          type: CONFIG.MACRO_TYPES.SKILL_CHECK,
          name: skillName,
          description: `1d20 ${total >= 0 ? '+' : '−'} ${Math.abs(total)}`,
          icon,
          apCost: 0,
          fpCost: 0,
          dice: [{ count: 1, sides: 20, value: 20, type: null }],
          scalingBonus: total,
          source: CONFIG.MACRO_SOURCES.CUSTOM,
          macroCategory: 'skillChecks',
          macroSet: 1
        });
      }
    }

    // Knowledge Checks (only for characters, not NPCs)
    if (actor.type !== 'npc') {
      const hasKnowledgeChecks = Array.from(existingIds).some(id => id?.startsWith('check-knowledge-'));
      if (!hasKnowledgeChecks) {
        const KNOWLEDGE_ICONS = {
          Magics: 'fa-solid fa-hat-wizard',
          WorldHistory: 'fa-solid fa-globe',
          Monsters: 'fa-solid fa-dragon',
          Cosmic: 'fa-solid fa-stars'
        };
        for (const [knowledgeName, icon] of Object.entries(KNOWLEDGE_ICONS)) {
          const mod = knowledge[knowledgeName] ?? 0;
          const displayName = knowledgeName === 'WorldHistory' ? 'World History' : knowledgeName;
          macros.push({
            id: `check-knowledge-${knowledgeName.toLowerCase()}`,
            type: CONFIG.MACRO_TYPES.SKILL_CHECK,
            name: displayName,
            description: `1d20 ${mod >= 0 ? '+' : '−'} ${Math.abs(mod)}`,
            icon,
            apCost: 0,
            fpCost: 0,
            dice: [{ count: 1, sides: 20, value: 20, type: null }],
            scalingBonus: mod,
            source: CONFIG.MACRO_SOURCES.CUSTOM,
            macroCategory: 'knowledgeChecks',
            macroSet: 1
          });
        }
      }
    }

    // Stat Checks
    if (!hasStatChecks) {
      const STAT_ICONS = {
        vitality: 'fa-solid fa-heart',
        endurance: 'fa-solid fa-shield-heart',
        strength: 'fa-solid fa-hand-fist',
        dexterity: 'fa-solid fa-feather',
        attunement: 'fa-solid fa-wand-sparkles',
        intelligence: 'fa-solid fa-lightbulb',
        faith: 'fa-solid fa-sun'
      };
      for (const [statName, icon] of Object.entries(STAT_ICONS)) {
        const statData = stats[statName];
        const mod = statData?.mod ?? Math.floor(((statData?.value || 10) - 10) / 2);
        const displayName = statName.charAt(0).toUpperCase() + statName.slice(1);
        macros.push({
          id: `check-stat-${statName}`,
          type: CONFIG.MACRO_TYPES.SKILL_CHECK,
          name: displayName,
          description: `1d20 ${mod >= 0 ? '+' : '−'} ${Math.abs(mod)}`,
          icon,
          apCost: 0,
          fpCost: 0,
          dice: [{ count: 1, sides: 20, value: 20, type: null }],
          scalingBonus: mod,
          source: CONFIG.MACRO_SOURCES.CUSTOM,
          macroCategory: 'statChecks',
          macroSet: 1
        });
      }
    }

    // Add new macros to active set
    if (macros.length > 0) {
      activeSetData.macros = [...activeSetData.macros, ...macros];
      await this.saveMacroSets();
      debug(`Added ${macros.length} basic macros for unlinked actor`);
    }
  }

  /**
   * Migrate macro data from Token flags to Actor flags
   * Called automatically when token is selected
   * Batches updates for performance
   */
  async _migrateTokenToActor(token, actor) {
    // Check if token has old macro data
    const tokenMacroSets = token.document.getFlag(CONFIG.MODULE_ID, 'macroSets');
    const tokenCharUUID = token.document.getFlag(CONFIG.MODULE_ID, 'characterUUID');

    // If token has no data to migrate, skip
    if (!tokenMacroSets && !tokenCharUUID) return;

    // Check if actor already has macro data
    const actorMacroSets = actor.system?.macroSets || actor.getFlag(CONFIG.MODULE_ID, 'macroSets');

    // Batch actor updates
    const actorUpdateData = {};
    if (tokenCharUUID && !actor.system?.characterUUID) {
      log('Migrating characterUUID from token to actor system data');
      actorUpdateData['system.characterUUID'] = tokenCharUUID;
    }
    if (tokenMacroSets && !actorMacroSets) {
      log('Migrating macroSets from token to actor system data');
      actorUpdateData['system.macroSets'] = tokenMacroSets;
    }

    // Single actor update call
    if (Object.keys(actorUpdateData).length > 0) {
      await actor.update(actorUpdateData);
    }

    // Batch token flag cleanup
    const tokenUnsetPromises = [];
    if (tokenMacroSets) {
      tokenUnsetPromises.push(token.document.unsetFlag(CONFIG.MODULE_ID, 'macroSets'));
      debug('Cleaning up token macroSets flag');
    }
    if (tokenCharUUID) {
      tokenUnsetPromises.push(token.document.unsetFlag(CONFIG.MODULE_ID, 'characterUUID'));
      debug('Cleaning up token characterUUID flag');
    }

    // Run token cleanup in parallel
    if (tokenUnsetPromises.length > 0) {
      await Promise.all(tokenUnsetPromises);
    }

    log('Token-to-Actor migration complete');
  }

  /**
   * Migrate old macro set format to new format
   */
  _migrateOldFormat(savedData) {
    debug('Migrating old macro set format to new format');
    const oldSets = savedData.sets || {};
    this.macroSets = {};
    this.setOrder = [];

    // Convert numbered sets to named sets
    for (const [key, macros] of Object.entries(oldSets)) {
      const setId = `set-${key}`;
      this.macroSets[setId] = {
        id: setId,
        name: `Set ${key}`,
        macros: macros || [],
        active: true
      };
      this.setOrder.push(setId);
    }

    // Set active to first set or migrate from old activeSet
    const oldActiveSet = savedData.activeSet || 1;
    this.activeSet = `set-${oldActiveSet}`;

    // Ensure active set exists
    if (!this.macroSets[this.activeSet] && this.setOrder.length > 0) {
      this.activeSet = this.setOrder[0];
    }
  }

  /**
   * Initialize default macro sets
   */
  _initializeDefaultSets() {
    const defaultSet = {
      id: 'set-1',
      name: 'Set 1',
      macros: [],
      active: true
    };
    this.macroSets = { 'set-1': defaultSet };
    this.setOrder = ['set-1'];
    this.activeSet = 'set-1';
  }

  /**
   * Refresh macros from SD20 App
   * @param {boolean} forceReset - If true, reset all macros to app state (clears user edits)
   * @param {boolean} forceRefresh - If true, bypass cache and fetch fresh from App
   */
  async refreshMacros(forceReset = false, forceRefresh = false) {
    if (!this.characterUUID) return;

    const manager = game.sd20?.macroManager;
    if (!manager) return;

    // Single-flight: callers that arrive while a refresh is in progress get
    // the same promise. Stops two refreshes overlapping and clobbering each
    // other's merge or stomping a pending addMacroToSlot save.
    if (this._refreshInFlight) {
      debug('refreshMacros already in flight, joining existing promise');
      return this._refreshInFlight;
    }

    if (this._refreshAbortController) {
      this._refreshAbortController.abort();
    }
    const controller = new AbortController();
    this._refreshAbortController = controller;
    const signal = controller.signal;

    this._refreshInFlight = this._doRefreshMacros(forceReset, forceRefresh, signal);
    try {
      return await this._refreshInFlight;
    } finally {
      this._refreshInFlight = null;
    }
  }

  async _doRefreshMacros(forceReset, forceRefresh, signal) {
    const manager = game.sd20.macroManager;

    const token = canvas.tokens.get(this.tokenId);
    const actor = token?.actor || null;
    // Use cache by default for faster loading, only force refresh when explicitly requested
    const macros = await manager.getMacros(this.characterUUID, forceRefresh, actor);
    if (signal.aborted) return;
    debug(`Loaded ${macros.length} macros for character ${this.characterUUID}${forceRefresh ? ' (fresh from App)' : ' (cached)'}`);

    // If no macros from App (cache miss or App offline), use saved macros
    // This ensures the macro bar isn't blank when App is temporarily unavailable
    if (!macros.length) {
      // Check for saved macros in the active set
      const activeSetData = this.macroSets[this.activeSet];
      const hasSavedMacros = activeSetData?.macros?.some(m => m !== null);

      if (hasSavedMacros) {
        debug('App offline - using persisted macros from actor flags');
      } else {
        // No saved macros and App offline - generate basic macros from actor stats as fallback
        debug('App offline and no saved macros - generating basic macros from actor stats');
        await this._generateBasicMacrosForActor(actor, token);
      }
      return;
    }

    // Sync combat data to actor (weapons, stats, skills, knowledge)
    const cached = manager.macroCache.get(this.characterUUID);
    if (cached?.combatData && actor) {
      const cd = cached.combatData;
      const updateData = {};

      // Weapon scaling data for custom macro resolution
      // CF1: Store per-damage-type scaling for correct damage calculation
      const weaponData = {};
      if (cd.mainHand) {
        const mainHandScalingByType = cd.mainHand.scalingBonusByType ?? manager.calculateScalingBonusByType(
          cd.mainHand.scaling, cd.stats || {}, cd.combatSettings?.twoHandingMainHand
        );
        weaponData.mainHand = {
          name: cd.mainHand.name || null,
          scalingBonusByType: mainHandScalingByType,
          // Keep scalingBonus for backwards compatibility (sum of all types)
          scalingBonus: cd.mainHand.scalingBonus ?? Object.values(mainHandScalingByType).reduce((sum, b) => sum + b, 0)
        };
      }
      if (cd.offHand) {
        const offHandScalingByType = cd.offHand.scalingBonusByType ?? manager.calculateScalingBonusByType(
          cd.offHand.scaling, cd.stats || {}, cd.combatSettings?.twoHandingOffHand
        );
        weaponData.offHand = {
          name: cd.offHand.name || null,
          scalingBonusByType: offHandScalingByType,
          // Keep scalingBonus for backwards compatibility (sum of all types)
          scalingBonus: cd.offHand.scalingBonus ?? Object.values(offHandScalingByType).reduce((sum, b) => sum + b, 0)
        };
      }
      if (weaponData.mainHand || weaponData.offHand) {
        updateData['system.equippedWeapons'] = weaponData;
      }

      // Sync stats (value + mod from app) to actor for initiative and stat checks
      if (cd.stats && typeof cd.stats === 'object') {
        const statMods = cd.statMods || {};
        for (const [statName, statValue] of Object.entries(cd.stats)) {
          const val = parseInt(statValue) || 10;
          const mod = statMods[statName] ?? Math.floor((val - 10) / 2);
          updateData[`system.stats.${statName}.value`] = val;
          updateData[`system.stats.${statName}.mod`] = mod;
        }
      }

      // Sync skills from app to actor
      if (cd.skills && typeof cd.skills === 'object') {
        for (const [skillName, skillValue] of Object.entries(cd.skills)) {
          updateData[`system.skills.${skillName}`] = parseInt(skillValue) || 0;
        }
      }

      // Sync knowledge from app to actor
      if (cd.knowledge && typeof cd.knowledge === 'object') {
        for (const [knowledgeName, knowledgeValue] of Object.entries(cd.knowledge)) {
          updateData[`system.knowledge.${knowledgeName}`] = parseInt(knowledgeValue) || 0;
        }
      }

      // Sync level from app to actor
      if (cd.level !== undefined) {
        updateData['system.level'] = parseInt(cd.level) || 0;
      }

      if (Object.keys(updateData).length > 0) {
        // For unlinked tokens, update via the token document's delta
        // Direct actor.update() doesn't persist for synthetic actors on unlinked tokens
        if (this.isUnlinked && token) {
          // Convert flat keys like "system.stats.strength.value" to nested delta object
          const deltaUpdate = {};
          for (const [key, value] of Object.entries(updateData)) {
            foundry.utils.setProperty(deltaUpdate, key, value);
          }
          await token.document.update({ delta: deltaUpdate });
        } else {
          // Linked token or actor-linked: update the actor directly
          await actor.update(updateData);
        }
      }
    }

    if (signal.aborted) return;

    // Store available macros for the macro picker
    this.availableMacros = macros;

    // Get current active set
    const activeSetData = this.macroSets[this.activeSet];

    // Merge app macros into the active set, preserving custom macros and user additions
    if (activeSetData && macros.length > 0) {
      // Keep existing custom macros (source === 'custom')
      // BUT filter out any custom macros whose ID matches an incoming app macro
      // (the app version supersedes the custom version if they have the same ID)
      const incomingAppIds = new Set(macros.map(m => m.id));
      const customMacros = activeSetData.macros.filter(
        m => m && m.source === CONFIG.MACRO_SOURCES.CUSTOM && !incomingAppIds.has(m.id)
      );

      // Also preserve modified app macros that are no longer in the incoming data
      // (e.g., macro was deleted/renamed in app but user has local edits)
      const orphanedModifiedMacros = activeSetData.macros.filter(
        m => m && m.source === CONFIG.MACRO_SOURCES.APP && m.modified && !incomingAppIds.has(m.id)
      );

      // Build map of current app macros for partial merge
      const currentAppMacros = new Map();
      for (const m of activeSetData.macros) {
        if (m && m.source === CONFIG.MACRO_SOURCES.APP) {
          currentAppMacros.set(m.id, m);
        }
      }

      // Update app macros with fresh data
      const existingAppIds = new Set(
        activeSetData.macros.filter(m => m && m.source !== CONFIG.MACRO_SOURCES.CUSTOM).map(m => m.id)
      );
      const updatedAppMacros = macros.slice(0, MAX_MACROS_PER_SET).map(freshMacro => {
        const currentMacro = currentAppMacros.get(freshMacro.id);

        // If macro doesn't exist yet, use fresh version as-is
        // Store the original app data for "Reset to App Defaults" feature
        if (!currentMacro) {
          return {
            ...freshMacro,
            appSourceId: freshMacro.id,
            appOriginalData: JSON.parse(JSON.stringify(freshMacro)) // Store original for reset
          };
        }

        // Force reset: completely replace with app data, clear modified flag
        // This is used when user clicks "Refresh from App" button
        if (forceReset) {
          return {
            ...freshMacro,
            hotkey: currentMacro.hotkey, // Keep hotkey assignment
            appSourceId: freshMacro.id,
            appOriginalData: JSON.parse(JSON.stringify(freshMacro)), // Refresh original data
            modified: false, // Clear modified flag
            editedFields: [] // Clear field-level tracking
          };
        }

        // User-owned fields that survive every re-link, regardless of modified flag.
        // Animation, targeting, custom code and rest ability are picked locally
        // in Foundry and the App never sets them. Combat balance fields update
        // from the App (handled below by the merged.combat assignment).
        const userFields = {};
        if (currentMacro.targeting) userFields.targeting = currentMacro.targeting;
        if (currentMacro.aoe) userFields.aoe = currentMacro.aoe;
        if (currentMacro.aoeDuration != null) userFields.aoeDuration = currentMacro.aoeDuration;
        if (currentMacro.aoePermanent != null) userFields.aoePermanent = currentMacro.aoePermanent;
        if (currentMacro.secondaryCombat) userFields.secondaryCombat = currentMacro.secondaryCombat;
        if (currentMacro.customScript) userFields.customScript = currentMacro.customScript;
        if (currentMacro.scriptEdited) userFields.scriptEdited = currentMacro.scriptEdited;
        if (currentMacro.restAbility) userFields.restAbility = currentMacro.restAbility;
        if (currentMacro.animation) userFields.animation = currentMacro.animation;

        // Unmodified macro: refresh base data, preserve hotkey + user fields
        // Update appOriginalData with fresh data since macro isn't modified
        if (!currentMacro.modified) {
          return {
            ...freshMacro,
            hotkey: currentMacro.hotkey,
            appSourceId: freshMacro.id,
            appOriginalData: JSON.parse(JSON.stringify(freshMacro)),
            ...userFields
          };
        }

        // Modified macro: use field-level tracking to preserve only edited fields
        // Start with fresh app data, then overlay edited fields from current macro
        const editedFields = new Set(currentMacro.editedFields || []);

        // If no edited fields tracked, macro is not actually modified - use fresh data
        if (editedFields.size === 0) {
          return {
            ...freshMacro,
            hotkey: currentMacro.hotkey,
            appSourceId: freshMacro.id,
            appOriginalData: JSON.parse(JSON.stringify(freshMacro)),
            modified: false,
            editedFields: [],
            ...userFields
          };
        }

        const merged = {
          ...freshMacro,
          hotkey: currentMacro.hotkey,
          modified: true,
          editedFields: currentMacro.editedFields || [],
          appSourceId: freshMacro.id,
          // Preserve the stored original - DON'T update with fresh, keep the baseline
          appOriginalData: currentMacro.appOriginalData || JSON.parse(JSON.stringify(freshMacro)),
          ...userFields
        };

        // === BASIC INFO SECTION ===
        if (editedFields.has('name')) merged.name = currentMacro.name;
        if (editedFields.has('description')) merged.description = currentMacro.description;
        if (editedFields.has('apCost')) merged.apCost = currentMacro.apCost;
        if (editedFields.has('fpCost')) merged.fpCost = currentMacro.fpCost;
        if (editedFields.has('range')) merged.range = currentMacro.range;
        if (editedFields.has('icon')) merged.icon = currentMacro.icon;
        if (editedFields.has('flavor')) merged.flavor = currentMacro.flavor;
        if (editedFields.has('keywords')) merged.keywords = currentMacro.keywords;

        // === PRIMARY COMBAT SECTION ===
        // Use smart entry-by-entry merging that preserves edited entries while allowing new App entries
        merged.combat = { ...(freshMacro.combat || {}) };

        // Merge damageTypes by 'type' identity (PHYSICAL, FIRE, etc.)
        merged.combat.damageTypes = this._mergeCombatArray(
          freshMacro.combat?.damageTypes || [],
          currentMacro.combat?.damageTypes || [],
          editedFields,
          'combat.damageTypes',
          'type'
        );

        // Merge statusEffects by 'name' identity (Bleed, Poison, etc.)
        merged.combat.statusEffects = this._mergeCombatArray(
          freshMacro.combat?.statusEffects || [],
          currentMacro.combat?.statusEffects || [],
          editedFields,
          'combat.statusEffects',
          'name'
        );

        // Merge statusConditions by 'name' identity
        merged.combat.statusConditions = this._mergeCombatArray(
          freshMacro.combat?.statusConditions || [],
          currentMacro.combat?.statusConditions || [],
          editedFields,
          'combat.statusConditions',
          'name'
        );

        // Merge restoration by 'type' identity (heal-hp, restore-fp, etc.)
        merged.combat.restoration = this._mergeCombatArray(
          freshMacro.combat?.restoration || [],
          currentMacro.combat?.restoration || [],
          editedFields,
          'combat.restoration',
          'type'
        );

        // Vulnerabilities don't typically come from App, preserve user edits entirely
        if (editedFields.has('combat.vulnerabilities') && currentMacro.combat?.vulnerabilities) {
          merged.combat.vulnerabilities = currentMacro.combat.vulnerabilities;
        }

        // === SECONDARY COMBAT SECTION ===
        if (editedFields.has('secondaryCombat.damageTypes') || editedFields.has('secondaryCombat.statusEffects') ||
            editedFields.has('secondaryCombat.statusConditions') || editedFields.has('secondaryCombat.restoration')) {
          merged.secondaryCombat = currentMacro.secondaryCombat || merged.secondaryCombat;
        }

        // === ANIMATION SECTION ===
        if (editedFields.has('animation')) {
          merged.animation = currentMacro.animation;
        }

        // === TARGETING SECTION ===
        if (editedFields.has('targeting')) {
          merged.targeting = currentMacro.targeting;
        }

        // === AOE SECTION ===
        if (editedFields.has('aoe')) {
          merged.aoe = currentMacro.aoe;
          merged.aoeDuration = currentMacro.aoeDuration;
          merged.aoePermanent = currentMacro.aoePermanent;
        }

        // === SCRIPT SECTION ===
        if (editedFields.has('customScript')) {
          merged.customScript = currentMacro.customScript;
          merged.scriptEdited = currentMacro.scriptEdited;
        }

        // Note: scalingBonus is intentionally NOT preserved - it's a dynamic value
        // that should always be refreshed from the app (weapon stats can change)

        return merged;
      });

      if (signal.aborted) return;

      // Combine: app macros first, then orphaned modified macros, then custom macros
      activeSetData.macros = [...updatedAppMacros, ...orphanedModifiedMacros, ...customMacros];

      // Bug 2 diagnostic logs: surface what arrived, what stuck, and what got dropped
      // so a slow / missing / partial-data case can be diagnosed from F12 alone.
      const byCategory = {};
      for (const m of activeSetData.macros) {
        if (!m) continue;
        const cat = m.macroCategory || 'uncategorized';
        byCategory[cat] = (byCategory[cat] || 0) + 1;
      }
      debug(`refreshMacros merge complete: total=${activeSetData.macros.length} ` +
            `(app=${updatedAppMacros.length} orphaned=${orphanedModifiedMacros.length} custom=${customMacros.length}) ` +
            `by-category=${JSON.stringify(byCategory)}`);
      const droppedAppMacros = macros.filter(m => {
        const fresh = updatedAppMacros.find(am => am.id === m.id);
        return !fresh;
      });
      if (droppedAppMacros.length > 0) {
        debug(`refreshMacros: ${droppedAppMacros.length} incoming App macros were NOT placed: ` +
              droppedAppMacros.map(m => `${m.name}(${m.id})`).join(', '));
      }

      await this.saveMacroSets();
      if (signal.aborted) return;

      // Auto-add new app macros to library (batch operation - single save)
      const newAppMacros = macros.filter(m => !existingAppIds.has(m.id));
      if (newAppMacros.length > 0) {
        const token = canvas.tokens.get(this.tokenId);
        const actor = token?.actor;
        const sourceName = actor?.name || 'Unknown Actor';
        await addMacrosToLibraryBatch(newAppMacros, sourceName);
        if (signal.aborted) return;
        debug(`Auto-added ${newAppMacros.length} new macros to library from App`);
      }
    }

    this.render();
  }

  /**
   * Bug 4: merge combat arrays by stable per-entry id + _source tag.
   *
   * Rules:
   * - Fresh App entries are matched to current entries by id when available.
   *   Legacy entries that have no id yet fall back to type/name identity so the
   *   first re-link after migration still lines up. macroNormalize.js will
   *   stamp ids on them during that first successful merge.
   * - When a current entry with _source === 'custom' matches an incoming App
   *   entry, the custom stays. App never overwrites a player-added row.
   * - When a current entry with _source === 'app' matches an incoming App
   *   entry, field-level editedFields tracking runs to decide whether to
   *   keep the current row or take the fresh one.
   * - Current entries not present in the fresh set are kept if they are
   *   _source === 'custom' (App did not create them) and dropped otherwise
   *   (App removed them).
   */
  _mergeCombatArray(freshEntries, currentEntries, editedFields, fieldPrefix, identityKey = 'type') {
    const fresh = Array.isArray(freshEntries) ? freshEntries : [];
    const current = Array.isArray(currentEntries) ? currentEntries : [];
    if (!fresh.length && !current.length) return [];

    // Custom entries live independently of App: they never match a fresh id
    // (they were minted by the player). We keep them and interleave later.
    const customCurrent = [];
    const appCurrent = [];
    for (const entry of current) {
      if (!entry) continue;
      if (entry._source === 'custom') customCurrent.push(entry);
      else appCurrent.push(entry);
    }

    // Build lookups on the App-source current entries only.
    const currentById = new Map();
    const currentByIdentity = new Map();
    appCurrent.forEach((entry, index) => {
      if (entry.id) currentById.set(entry.id, { entry, index });
      const idKey = entry[identityKey];
      if (idKey && !currentByIdentity.has(idKey)) currentByIdentity.set(idKey, { entry, index });
    });

    const consumedCurrentIds = new Set();
    const result = [];

    for (const freshEntry of fresh) {
      // Match by id first, then fall back to type/name identity for legacy data.
      let match = freshEntry.id ? currentById.get(freshEntry.id) : null;
      if (!match) {
        const idKey = freshEntry[identityKey];
        if (idKey) match = currentByIdentity.get(idKey);
      }

      if (!match) {
        // App added this entry. Stamp defaults so future merges are id-keyed.
        result.push({
          ...freshEntry,
          id: freshEntry.id || foundry.utils.randomID(),
          _source: 'app',
        });
        continue;
      }

      consumedCurrentIds.add(match.entry);

      const stableKey = match.entry.id || match.entry[identityKey];
      const entryEdited = Array.from(editedFields).some(f =>
        f.startsWith(`${fieldPrefix}[${match.index}]`)
        || f.startsWith(`${fieldPrefix}:${stableKey}`)
      );

      if (entryEdited) {
        result.push({
          ...match.entry,
          id: match.entry.id || freshEntry.id || foundry.utils.randomID(),
          _source: 'app',
        });
      } else {
        result.push({
          ...freshEntry,
          id: match.entry.id || freshEntry.id || foundry.utils.randomID(),
          _source: 'app',
        });
      }
    }

    // App-source current entries that no incoming fresh entry claimed: App
    // deleted them. Drop unless the player explicitly tracked the field
    // (they added it via the builder, which then flagged editedFields).
    // Iterate the source array directly so legacy entries with only an
    // identity key (no id yet) are considered too. Bug 4 (Batch C test).
    appCurrent.forEach((entry, index) => {
      if (consumedCurrentIds.has(entry)) return;
      const stableKey = entry.id || entry[identityKey];
      const userAdded = Array.from(editedFields).some(f =>
        f.startsWith(`${fieldPrefix}[${index}]`)
        || (stableKey && f.startsWith(`${fieldPrefix}:${stableKey}`))
      );
      if (userAdded) result.push(entry);
    });

    // Custom entries always survive - App has no authority over them.
    for (const entry of customCurrent) result.push(entry);

    return result;
  }

  /**
   * Get macros for the current active set
   * Returns empty array if the active set is unavailable
   */
  _getActiveMacros() {
    const setData = this.macroSets[this.activeSet];
    // Return empty if no set data or set is unavailable
    if (!setData || setData.active === false) return [];
    return setData.macros || [];
  }

  /**
   * Ensure the active set is available, switch to first available if not
   */
  _ensureActiveSetIsAvailable() {
    const activeSetData = this.macroSets[this.activeSet];

    // Active set exists and is available
    if (activeSetData && activeSetData.active !== false) return;

    // Find the first available set
    for (const setId of this.setOrder) {
      const setData = this.macroSets[setId];
      if (setData && setData.active !== false) {
        this.activeSet = setId;
        return;
      }
    }

    // No available sets - activeSet will show empty
  }

  /**
   * Group macros by category for dropdown display
   * Also consolidates spell/spirit catalyst variants into grouped macros
   * @param {Array} macros - Flat array of macros
   * @returns {Object} Macros grouped by category id
   */
  _groupMacrosByCategory(macros) {
    const grouped = {};

    // Initialize all categories with empty arrays
    for (const cat of CONFIG.MACRO_CATEGORIES) {
      grouped[cat.id] = [];
    }

    // First pass: collect all macros and identify spell/spirit variants
    const spellVariants = {}; // { sourceId: [macro1, macro2, ...] }
    const spiritVariants = {}; // { sourceId: [macro1, macro2, ...] }
    const regularMacros = [];

    for (const macro of macros) {
      // Skip null, invalid, or unavailable macro entries
      if (!macro) continue;
      if (macro.available === false) continue;

      // Check if this is a spell/spirit with catalyst (has catalystId)
      if (macro.type === CONFIG.MACRO_TYPES.SPELL && macro.catalystId) {
        const key = macro.sourceId;
        if (!spellVariants[key]) spellVariants[key] = [];
        spellVariants[key].push(macro);
      } else if (macro.type === CONFIG.MACRO_TYPES.SPIRIT && macro.catalystId) {
        const key = macro.sourceId;
        if (!spiritVariants[key]) spiritVariants[key] = [];
        spiritVariants[key].push(macro);
      } else {
        regularMacros.push(macro);
      }
    }

    // Add regular macros to their categories
    for (const macro of regularMacros) {
      const categoryId = this._getMacroCategory(macro);
      if (grouped[categoryId]) {
        grouped[categoryId].push(macro);
      }
    }

    // Consolidate spell variants into grouped macros
    for (const [sourceId, variants] of Object.entries(spellVariants)) {
      if (variants.length === 0) continue;

      // Use first variant as template for the group macro
      const template = variants[0];
      // Extract base spell name (remove "[Catalyst]: " prefix)
      const baseName = template.name.includes(']: ')
        ? template.name.split(']: ')[1]
        : template.name;

      const groupMacro = {
        ...template,
        id: `spell-group-${sourceId}`,
        name: baseName,
        isGroup: true,
        variants: variants.map(v => ({
          ...v,
          // Extract catalyst name from "[Catalyst]: SpellName" format
          catalystName: v.name.includes(']: ') ? v.name.split(']: ')[0].slice(1) : v.name
        }))
      };

      const categoryId = this._getMacroCategory(groupMacro);
      if (grouped[categoryId]) {
        grouped[categoryId].push(groupMacro);
      }
    }

    // Consolidate spirit variants into grouped macros
    for (const [sourceId, variants] of Object.entries(spiritVariants)) {
      if (variants.length === 0) continue;

      // Use first variant as template for the group macro
      const template = variants[0];
      // Extract base spirit name (remove "[Catalyst]: Summon " prefix)
      let baseName = template.name;
      if (template.name.includes(']: Summon ')) {
        baseName = 'Summon ' + template.name.split(']: Summon ')[1];
      } else if (template.name.includes(']: ')) {
        baseName = template.name.split(']: ')[1];
      }

      const groupMacro = {
        ...template,
        id: `spirit-group-${sourceId}`,
        name: baseName,
        isGroup: true,
        variants: variants.map(v => ({
          ...v,
          // Extract catalyst name
          catalystName: v.name.includes(']: ') ? v.name.split(']: ')[0].slice(1) : v.name
        }))
      };

      const categoryId = this._getMacroCategory(groupMacro);
      if (grouped[categoryId]) {
        grouped[categoryId].push(groupMacro);
      }
    }

    return grouped;
  }

  /**
   * Determine which category a macro belongs to
   */
  _getMacroCategory(macro) {
    // User-defined category takes priority (for custom macros)
    if (macro.macroCategory) {
      return macro.macroCategory;
    }

    // Weapon attacks go by linked slot
    if (macro.linkedSlot === 'mainHand') {
      return 'mainHand';
    }
    if (macro.linkedSlot === 'offHand') {
      return 'offHand';
    }

    // Spells go by spell category
    if (macro.type === CONFIG.MACRO_TYPES.SPELL) {
      const cat = (macro.category || '').toUpperCase();
      if (cat === 'SORCERY') return 'sorcery';
      if (cat === 'HEX') return 'hex';
      if (cat === 'MIRACLE') return 'miracle';
      if (cat === 'PYROMANCY') return 'pyromancy';
      // Unknown spell category defaults to sorcery
      return 'sorcery';
    }

    // Spirits
    if (macro.type === CONFIG.MACRO_TYPES.SPIRIT) {
      return 'spirits';
    }

    // Weapon skills
    if (macro.type === CONFIG.MACRO_TYPES.WEAPON_SKILL) {
      return 'skills';
    }

    // Custom macros
    if (macro.type === CONFIG.MACRO_TYPES.CUSTOM || macro.source === CONFIG.MACRO_SOURCES.CUSTOM) {
      return 'custom';
    }

    // Default to custom
    return 'custom';
  }

  /**
   * Render the macro bar to DOM
   * Always shows for owned tokens - includes link/unlink button in controls
   */
  render(force = false) {
    // Remove existing element if re-rendering
    if (this.element) {
      this.element.remove();
    }

    // Create wrapper element
    this.element = document.createElement('div');
    this.element.id = 'sd20-macro-bar';
    this.element.className = 'sd20-macro-bar-app';
    if (this.isReadOnly) {
      this.element.classList.add('read-only');
    }

    // Ensure active set is available, switch to first available if not
    this._ensureActiveSetIsAvailable();

    // Group macros by category using the new data format
    const currentMacros = this._getActiveMacros();
    this.groupedMacros = this._groupMacrosByCategory(currentMacros);

    // Build HTML content
    const html = this._buildHTML();
    this.element.innerHTML = html;

    // Append to document body
    document.body.appendChild(this.element);

    // Activate listeners
    this._activateListeners(this.element);

    // Start inactivity timer
    this._resetInactivityTimer();

    this.rendered = true;
    debug(`Macro bar rendered (${this.isReadOnly ? 'read-only' : 'editable'}, ${this.characterUUID ? 'linked' : 'unlinked'})`);
  }

  /**
   * Build HTML content for macro bar with category buttons
   */
  _buildHTML() {
    // Build set tabs with scrollable container (only show available sets)
    let tabsHTML = '<div class="macro-set-tabs-scroll">';
    for (const setId of this.setOrder) {
      const setData = this.macroSets[setId];
      if (!setData) continue;
      // Skip unavailable/inactive sets - they shouldn't appear in the macro bar
      if (setData.active === false) continue;

      const activeClass = setId === this.activeSet ? 'active' : '';
      const displayName = setData.name.length > 10 ? setData.name.substring(0, 10) + '...' : setData.name;
      tabsHTML += `<button class="macro-set-tab ${activeClass}" data-set="${setId}" title="${setData.name}">${displayName}</button>`;
    }
    // Add "+" button for new set (hide in read-only mode)
    if (!this.isReadOnly) {
      tabsHTML += `<button class="macro-set-tab add-set-btn" data-action="add-set" title="Add New Set"><i class="fa-solid fa-plus"></i></button>`;
    }
    tabsHTML += '</div>';

    // Build category buttons
    let categoriesHTML = '';
    for (const cat of CONFIG.MACRO_CATEGORIES) {
      const macros = this.groupedMacros[cat.id] || [];
      const count = macros.length;
      const hasContent = count > 0;
      const emptyClass = hasContent ? '' : 'empty';
      const expandedClass = this.openCategory === cat.id ? 'expanded' : '';

      categoriesHTML += `
        <button class="macro-category-btn ${emptyClass} ${expandedClass}"
                data-category="${cat.id}"
                data-hotkey="${cat.hotkey}"
                title="${cat.name} (${count})">
          <i class="${cat.icon}"></i>
          <span class="category-name">${cat.name}</span>
          ${count > 0 ? `<span class="category-count">${count}</span>` : ''}
        </button>
      `;
    }

    // Build control buttons
    let controlsHTML = '<div class="macro-controls">';
    if (!this.isReadOnly) {
      controlsHTML += `
        <button class="macro-control-btn" data-action="add" title="Add Custom Macro">
          <i class="fa-solid fa-plus"></i>
        </button>`;
    }
    // Refresh button: for linked characters refresh from App, for NPCs regenerate from stats
    const isAppConnected = game.sd20?.broadcastChannel?.connected === true;
    let refreshDisabled, refreshTitle, refreshAction;
    if (this.characterUUID) {
      // Linked to SD20 App character
      refreshDisabled = !isAppConnected;
      refreshTitle = isAppConnected ? 'Refresh from App' : 'SD20 App not connected';
      refreshAction = 'refresh';
    } else {
      // NPC/monster - regenerate from token's combat settings
      refreshDisabled = false;
      refreshTitle = 'Regenerate Macros from Combat Settings';
      refreshAction = 'regenerate';
    }

    controlsHTML += `
      <button class="macro-control-btn${refreshDisabled ? ' disabled' : ''}" data-action="${refreshAction}" title="${refreshTitle}"${refreshDisabled ? ' disabled' : ''}>
        <i class="fa-solid fa-sync"></i>
      </button>
      <button class="macro-control-btn" data-action="settings" title="Macro Settings">
        <i class="fa-solid fa-cog"></i>
      </button>`;

    // Link/Unlink button - only for player characters, not NPCs
    // NPCs don't have SD20 App character links (one-way sync is App → Foundry)
    const token = canvas.tokens.get(this.tokenId);
    const actor = token?.actor;
    const isNPC = actor?.type === 'npc';

    if (!this.isReadOnly && !isNPC) {
      if (this.characterUUID) {
        controlsHTML += `
          <button class="macro-control-btn link-btn linked" data-action="unlink" title="Unlink from SD20 Character">
            <i class="fa-solid fa-link"></i>
          </button>`;
      } else {
        controlsHTML += `
          <button class="macro-control-btn link-btn unlinked" data-action="link" title="Link to SD20 Character">
            <i class="fa-solid fa-link-slash"></i>
          </button>`;
      }
    }

    // Rest button
    controlsHTML += `
      <button class="macro-control-btn rest-btn" data-action="rest" title="Take a Rest">
        <i class="fa-solid fa-fire"></i>
      </button>`;

    controlsHTML += '</div>';

    // Add read-only indicator if applicable
    const readOnlyBadge = this.isReadOnly
      ? '<div class="read-only-badge" title="You do not own this Actor"><i class="fa-solid fa-lock"></i></div>'
      : '';

    // Optimization 8: sync indicator. States: 'idle' (no badge), 'syncing'
    // (spinner during a Refresh-from-App), 'offline' (App unreachable after
    // last try). Owned by this instance's _syncState field.
    let syncBadge = '';
    if (this._syncState === 'syncing') {
      syncBadge = '<div class="macro-sync-badge macro-sync-syncing" title="Syncing from SD20 App"><i class="fa-solid fa-arrows-rotate fa-spin"></i></div>';
    } else if (this._syncState === 'offline') {
      syncBadge = '<div class="macro-sync-badge macro-sync-offline" title="SD20 App offline - using cached data"><i class="fa-solid fa-triangle-exclamation"></i></div>';
    }

    return `
      <div class="sd20-macro-bar" data-character-uuid="${this.characterUUID || ''}">
        ${readOnlyBadge}
        ${syncBadge}
        <div class="macro-set-tabs">${tabsHTML}</div>
        <div class="macro-category-bar">${categoriesHTML}</div>
        ${controlsHTML}
      </div>
    `;
  }

  /**
   * Optimization 8: transition the sync-indicator badge. Called by the
   * Refresh-from-App flow around the App round trip.
   * @param {'idle'|'syncing'|'offline'} state
   */
  setSyncState(state) {
    if (this._syncState === state) return;
    this._syncState = state;
    if (this.element) this.render();
  }

  /**
   * Create a DOM element from an HTML string
   */
  _createElement(htmlString) {
    const template = document.createElement('template');
    template.innerHTML = htmlString.trim();
    return template.content.firstElementChild;
  }

  /**
   * Activate event listeners
   */
  _activateListeners(html) {
    // Category button clicks
    html.querySelectorAll('.macro-category-btn').forEach(el => {
      el.addEventListener('click', this._onCategoryClick.bind(this));
      el.addEventListener('contextmenu', this._onCategoryRightClick.bind(this));
    });

    // Set tabs
    html.querySelectorAll('.macro-set-tab').forEach(el => {
      el.addEventListener('click', this._onSetTabClick.bind(this));
      if (!el.dataset.action) {
        el.addEventListener('contextmenu', this._onSetTabRightClick.bind(this));
      }
    });

    // Control buttons
    html.querySelectorAll('.macro-control-btn').forEach(el => {
      el.addEventListener('click', this._onControlClick.bind(this));
    });

    // Close dropdown when clicking elsewhere
    this._documentClickHandler = (e) => {
      if (!e.target.closest('.macro-category-btn, .sd20-macro-dropdown, .sd20-variant-submenu')) {
        this._closeDropdown();
      }
    };
    document.addEventListener('click', this._documentClickHandler);

    // Activity tracking - hover and mouse events
    html.addEventListener('mouseenter', () => {
      this._setActive();
    });
    html.addEventListener('mouseleave', () => {
      this._resetInactivityTimer();
    });
  }

  /**
   * Reset the inactivity timer
   */
  _resetInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    this.inactivityTimer = setTimeout(() => {
      this._setInactive();
    }, INACTIVE_TIMEOUT);
  }

  /**
   * Mark macro bar as active (fully visible)
   */
  _setActive() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.isInactive = false;
    if (this.element) {
      this.element.classList.remove('inactive');
    }
  }

  /**
   * Mark macro bar as inactive (transparent)
   */
  _setInactive() {
    // Don't go inactive if dropdown is open
    if (this.openCategory) return;

    this.isInactive = true;
    if (this.element) {
      this.element.classList.add('inactive');
    }
  }

  /**
   * Close the macro bar
   */
  close() {
    if (this._refreshAbortController) {
      this._refreshAbortController.abort();
      this._refreshAbortController = null;
    }

    // Clean up document click handler
    if (this._documentClickHandler) {
      document.removeEventListener('click', this._documentClickHandler);
      this._documentClickHandler = null;
    }
    this._closeDropdown();
    this._hideTooltip();

    // Clear inactivity timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.element) {
      this.element.remove();
      this.element = null;
    }
    this.rendered = false;
    debug('Macro bar closed');
  }

  /**
   * Handle category button click - toggle dropdown
   */
  _onCategoryClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const categoryId = event.currentTarget.dataset.category;
    const macros = this.groupedMacros[categoryId] || [];

    if (macros.length === 0) {
      // Empty category - open add macro dialog for this category
      this._openAddMacroDialog(null, categoryId);
      return;
    }

    // Toggle dropdown
    if (this.openCategory === categoryId) {
      this._closeDropdown();
    } else {
      this._showDropdown(event.currentTarget, categoryId, macros);
    }
  }

  /**
   * Handle category right-click - show category context menu
   */
  _onCategoryRightClick(event) {
    event.preventDefault();
    const categoryId = event.currentTarget.dataset.category;
    // For now, just open add macro dialog for this category
    this._openAddMacroDialog(null, categoryId);
  }

  /**
   * Show dropdown for a category
   */
  _showDropdown(buttonElement, categoryId, macros) {
    // Close any existing dropdown
    this._closeDropdown();

    this.openCategory = categoryId;

    // Mark button as expanded
    buttonElement.classList.add('expanded');

    // Build dropdown HTML - filter out null macros first
    const validMacros = macros.filter(m => m != null);
    const token = canvas.tokens.get(this.tokenId);
    const actor = token?.actor;
    let itemsHTML = '';
    validMacros.forEach((macro, index) => {
      const hotkeyNum = index + 1;
      const hotkeyBadge = hotkeyNum <= 9 ? `<span class="macro-hotkey-badge">${hotkeyNum}</span>` : '';

      // Rest ability badge and uses
      let restBadge = '';
      let depleted = false;
      if (macro.restAbility?.type) {
        const restType = macro.restAbility.type === 'short' ? 'SR' : 'LR';
        const badgeClass = macro.restAbility.type === 'short' ? 'sr' : 'lr';
        const maxUses = resolveMaxUses(macro.restAbility, actor);
        const currentUses = macro.restAbility.currentUses ?? maxUses;
        depleted = currentUses <= 0;
        restBadge = `
          <span class="rest-info">
            <span class="rest-badge ${badgeClass}">${restType}</span>
            <span class="rest-uses ${depleted ? 'depleted' : ''}">${currentUses}/${maxUses}</span>
          </span>
        `;
      }

      // Check if this is a grouped macro (spell/spirit with multiple catalysts)
      const hasVariants = macro.isGroup && macro.variants?.length > 1;
      const expandArrow = hasVariants ? '<i class="fa-solid fa-chevron-right variant-arrow"></i>' : '';

      const apCost = parseInt(macro.apCost) || 0;
      const fpCost = parseInt(macro.fpCost) || 0;
      const currentAP = actor?.system?.ap?.value ?? Infinity;
      const currentFP = actor?.system?.fp?.value ?? Infinity;
      const cannotAfford = apCost > currentAP || fpCost > currentFP;

      itemsHTML += `
        <div class="sd20-macro-dropdown-item ${depleted ? 'uses-depleted' : ''} ${cannotAfford ? 'cannot-afford' : ''} ${hasVariants ? 'has-variants' : ''}"
             data-macro-index="${index}" ${hasVariants ? 'data-has-variants="true"' : ''}>
          ${hotkeyBadge}
          <i class="${macro.icon || 'fa-solid fa-star'}"></i>
          <span class="macro-name">${macro.name}</span>
          <span class="macro-costs">
            ${macro.apCost ? `<span class="ap">${macro.apCost} AP</span>` : ''}
            ${macro.fpCost ? `<span class="fp">${macro.fpCost} FP</span>` : ''}
          </span>
          ${restBadge}
          ${expandArrow}
        </div>
      `;
    });

    const dropdown = this._createElement(`
      <div class="sd20-macro-dropdown" data-category="${categoryId}">
        ${itemsHTML}
      </div>
    `);

    // Position dropdown above the button
    const rect = buttonElement.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';

    // Add click handlers for dropdown items
    dropdown.querySelectorAll('.sd20-macro-dropdown-item').forEach(el => {
      el.addEventListener('click', (e) => {
        this._hideTooltip();
        const index = parseInt(e.currentTarget.dataset.macroIndex);
        const macro = validMacros[index];

        // If this is a grouped macro with multiple variants, toggle submenu on click
        if (macro?.isGroup && macro.variants?.length > 1) {
          e.stopPropagation();
          // Toggle submenu - if already open for this macro, close it
          const existingSubmenu = document.querySelector('.sd20-variant-submenu');
          if (existingSubmenu && existingSubmenu.dataset.groupId === macro.id) {
            this._hideVariantSubmenu();
          } else {
            this._showVariantSubmenu(e.currentTarget, macro);
          }
          return;
        }

        // Single-variant groups: execute the variant directly
        if (macro?.isGroup && macro.variants?.length === 1) {
          this._closeDropdown();
          this.executeMacro(macro.variants[0]);
          return;
        }

        this._executeMacroFromDropdown(categoryId, index);
      });

      // Add right-click for edit context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const index = parseInt(e.currentTarget.dataset.macroIndex);
        const macro = validMacros[index];
        if (!macro) return;

        // For single-variant groups, show context menu for the variant
        if (macro.isGroup && macro.variants?.length === 1) {
          this._showMacroContextMenu(e, macro.variants[0]);
        } else if (!macro.isGroup) {
          // Normal macros - show context menu
          this._showMacroContextMenu(e, macro);
        }
        // Multi-variant groups don't get context menu (use submenu instead)
      });

      // Add tooltip and range highlight on hover (but NOT submenu - only on click)
      el.addEventListener('mouseenter', (e) => {
        const index = parseInt(e.currentTarget.dataset.macroIndex);
        // Fetch fresh macro data from current state to ensure tooltip shows latest info
        const freshMacros = this.groupedMacros[categoryId]?.filter(m => m != null) || [];
        const macro = freshMacros[index] || macros[index];
        if (macro) {
          // For grouped macros, show tooltip for the base spell (first variant)
          if (macro.isGroup && macro.variants?.length > 0) {
            this._showTooltip(e.currentTarget, macro.variants[0]);
          } else {
            this._showTooltip(e.currentTarget, macro);
          }
          this._showRangeHighlight(macro);
        }
      });

      el.addEventListener('mouseleave', () => {
        this._hideTooltip();
        this._hideRangeHighlight();
      });
    });

    document.body.appendChild(dropdown);
  }

  /**
   * Show variant submenu for grouped spells/spirits
   * Renders full macro info like regular dropdown items
   */
  _showVariantSubmenu(parentElement, groupMacro) {
    // Remove any existing submenu
    this._hideVariantSubmenu();

    const variants = groupMacro.variants || [];
    if (variants.length === 0) return;

    const token = canvas.tokens.get(this.tokenId);
    const actor = token?.actor;

    let variantsHTML = '';
    variants.forEach((variant, index) => {
      // Build rest ability badge if present
      let restBadge = '';
      let depleted = false;
      if (variant.restAbility?.type) {
        const restType = variant.restAbility.type === 'short' ? 'SR' : 'LR';
        const badgeClass = variant.restAbility.type === 'short' ? 'sr' : 'lr';
        const maxUses = resolveMaxUses(variant.restAbility, actor);
        const currentUses = variant.restAbility.currentUses ?? maxUses;
        depleted = currentUses <= 0;
        restBadge = `
          <span class="rest-info">
            <span class="rest-badge ${badgeClass}">${restType}</span>
            <span class="rest-uses ${depleted ? 'depleted' : ''}">${currentUses}/${maxUses}</span>
          </span>
        `;
      }

      // Show catalyst name as the primary identifier with scaling
      const scalingDisplay = variant.scalingBonus
        ? `<span class="macro-scaling">${variant.scalingBonus >= 0 ? '+' : ''}${variant.scalingBonus}</span>`
        : '';

      const vApCost = parseInt(variant.apCost) || 0;
      const vFpCost = parseInt(variant.fpCost) || 0;
      const vCurrentAP = actor?.system?.ap?.value ?? Infinity;
      const vCurrentFP = actor?.system?.fp?.value ?? Infinity;
      const vCannotAfford = vApCost > vCurrentAP || vFpCost > vCurrentFP;

      variantsHTML += `
        <div class="sd20-variant-item ${depleted ? 'uses-depleted' : ''} ${vCannotAfford ? 'cannot-afford' : ''}" data-variant-index="${index}">
          <i class="${variant.icon || 'fa-solid fa-star'}"></i>
          <span class="macro-name">[${variant.catalystName}]</span>
          <span class="macro-costs">
            ${variant.apCost ? `<span class="ap">${variant.apCost} AP</span>` : ''}
            ${variant.fpCost ? `<span class="fp">${variant.fpCost} FP</span>` : ''}
          </span>
          ${scalingDisplay}
          ${restBadge}
        </div>
      `;
    });

    const submenu = this._createElement(`
      <div class="sd20-variant-submenu" data-group-id="${groupMacro.id}">
        ${variantsHTML}
      </div>
    `);

    // Position submenu to the right of the parent item
    const rect = parentElement.getBoundingClientRect();
    submenu.style.position = 'fixed';
    submenu.style.left = (rect.right + 4) + 'px';
    submenu.style.top = rect.top + 'px';

    // Add click handlers for variant items
    submenu.querySelectorAll('.sd20-variant-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const variantIndex = parseInt(e.currentTarget.dataset.variantIndex);
        const variant = variants[variantIndex];
        if (variant) {
          this._hideVariantSubmenu();
          this._closeDropdown();
          this.executeMacro(variant);
        }
      });

      // Right-click for edit context menu on variant macros
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const variantIndex = parseInt(e.currentTarget.dataset.variantIndex);
        const variant = variants[variantIndex];
        if (variant) {
          this._showMacroContextMenu(e, variant);
        }
      });

      // Show tooltip for variant
      el.addEventListener('mouseenter', (e) => {
        const variantIndex = parseInt(e.currentTarget.dataset.variantIndex);
        const variant = variants[variantIndex];
        if (variant) {
          this._showTooltip(e.currentTarget, variant);
          this._showRangeHighlight(variant);
        }
      });

      el.addEventListener('mouseleave', () => {
        this._hideTooltip();
        this._hideRangeHighlight();
      });
    });

    document.body.appendChild(submenu);
  }

  /**
   * Hide variant submenu
   */
  _hideVariantSubmenu() {
    const existing = document.querySelector('.sd20-variant-submenu');
    if (existing) existing.remove();
  }

  /**
   * Word-wrap text at specified character limit
   */
  /**
   * Hard-wrap text at exactly maxChars per line.
   * E.g., 453 chars with maxChars=50 = 9 lines of 50 + 1 line of 3
   */
  _wrapText(text, maxChars = 50) {
    if (!text || text.length <= maxChars) return text;
    const lines = [];
    for (let i = 0; i < text.length; i += maxChars) {
      lines.push(text.slice(i, i + maxChars));
    }
    return lines.join('<br>');
  }

  /**
   * Get damage type color from config
   */
  _getDamageTypeColor(type) {
    const colors = CONFIG.DAMAGE_TYPE_COLORS || {};
    return colors[type?.toUpperCase()] || colors.PHYSICAL || '#c0c0c0';
  }

  _getStatusEffectColor(name) {
    const colors = CONFIG.STATUS_EFFECT_COLORS || {};
    // Normalize name (e.g., 'bleed' -> 'Bleed')
    const normalizedName = name?.charAt(0).toUpperCase() + name?.slice(1).toLowerCase();
    return colors[normalizedName] || '#ffa500'; // Default orange
  }

  _getConditionColor(name) {
    const colors = CONFIG.CONDITION_COLORS || {};
    return colors[name] || colors.default || '#9c27b0';
  }

  _getRestorationColor(type) {
    const colors = CONFIG.RESTORATION_COLORS || {};
    return colors[type] || '#4caf50'; // Default green
  }

  // Tooltip-side mirror of _rollCombatComponent's scaling resolver. Returns
  // the same number the executor would push into the dice formula, so the
  // tooltip can show the resolved value (e.g. 1d2 frost + 4 from STR D-Full)
  // instead of a bare 1d2.
  _resolveComponentScaling(component, macro) {
    if (!component?.scalingSource) return 0;
    const damageType = (component.type || 'PHYSICAL').toUpperCase();

    if (component.scalingSource === 'weapon') {
      if (macro?.scalingBonusByType && typeof macro.scalingBonusByType === 'object') {
        return macro.scalingBonusByType[damageType]
          ?? macro.scalingBonusByType[damageType.toLowerCase()]
          ?? 0;
      }
      return this._resolveWeaponScalingByType(component.weaponHand || 'mainHand', damageType);
    }
    if (component.scalingSource === 'spell' || component.scalingSource === 'spirit') {
      return macro?.scalingBonus || 0;
    }
    if (component.scalingSource === 'manual' && component.manualScalingEntries?.length) {
      return this._resolveManualScalingEntries(component.manualScalingEntries);
    }
    if (component.scalingSource.includes(':')) {
      const token = canvas.tokens.get(this.tokenId);
      const actor = token?.actor || game.actors.get(this.actorId);
      if (actor?.type === 'npc') {
        return this._resolveMonsterScaling(component.scalingSource, actor);
      }
    }
    return 0;
  }

  // Renders one combat-component formula row as "<dice> + <flat> + <scaling>"
  // with the system's standard inline coloring. flat = gold, scaling = green
  // (positive) or red (negative). Returns the joined parts; callers prepend
  // their own type label.
  _renderComponentFormula(component, macro, colors) {
    const parts = [];
    if (component.diceCount && component.diceSides) {
      parts.push(`${component.diceCount}d${component.diceSides}`);
    }
    if (component.flatBonus) {
      const sign = component.flatBonus > 0 ? '+' : '';
      parts.push(`<span style="color:${colors.flat}">${sign}${component.flatBonus}</span>`);
    }
    const scaling = this._resolveComponentScaling(component, macro);
    if (scaling !== 0) {
      const color = scaling < 0 ? '#ff6b6b' : colors.scaling;
      const sign = scaling > 0 ? '+' : '';
      parts.push(`<span style="color:${color}">${sign}${scaling}</span>`);
    }
    return parts.join(' ') || '0';
  }

  // Returns { diceFormula, bonus } for a skill-check macro. simpleRoll is the
  // modern shape; dice[] + scalingBonus is the legacy one some untouched
  // template-default macros still carry.
  _getCheckMacroDiceAndBonus(macro) {
    if (macro.simpleRoll?.diceCount && macro.simpleRoll?.diceSides) {
      return {
        diceFormula: `${macro.simpleRoll.diceCount}d${macro.simpleRoll.diceSides}`,
        bonus: macro.simpleRoll.bonus || 0
      };
    }
    if (Array.isArray(macro.dice) && macro.dice.length > 0) {
      const die = macro.dice[0];
      return {
        diceFormula: `${die.count || 1}d${die.sides || die.value || 20}`,
        bonus: macro.scalingBonus || 0
      };
    }
    return null;
  }

  /**
   * Show tooltip for a macro
   * F1: Unified styling with proper section ordering and colors
   */
  _showTooltip(element, macro) {
    this._hideTooltip();

    // Standard colors from config/CSS variables
    const COLOR_SCALING = '#4caf50';  // --sd20-green
    const COLOR_FLAT_BONUS = '#c8a84e';  // --sd20-gold

    // Build tooltip content
    let tooltipHTML = `
      <div class="sd20-macro-tooltip">
        <div class="tooltip-header">
          <i class="${macro.icon || 'fa-solid fa-star'}"></i>
          <span>${macro.name}</span>
        </div>
    `;

    if (macro.description) {
      const wrappedDesc = this._wrapText(macro.description, 50);
      tooltipHTML += `<div class="tooltip-desc">${wrappedDesc}</div>`;
    }

    // Cost stats row
    const hasStats = macro.apCost || macro.fpCost || macro.range;
    if (hasStats) {
      tooltipHTML += `<div class="tooltip-stats">`;
      if (macro.apCost) {
        tooltipHTML += `<span class="stat-ap">${macro.apCost} AP</span>`;
      }
      if (macro.fpCost) {
        tooltipHTML += `<span class="stat-fp">${macro.fpCost} FP</span>`;
      }
      if (macro.range) {
        tooltipHTML += `<span class="stat-range">${macro.range}</span>`;
      }
      tooltipHTML += `</div>`;
    }

    // Initiative / Skill Checks / Knowledge / Stat Checks. Covers both
    // system-generated check macros (type=SKILL_CHECK) and user-customized
    // ones edited in the builder (still saved into one of these categories).
    const isSkillCheckMacro = macro.type === CONFIG.MACRO_TYPES.SKILL_CHECK
      || ['initiative', 'skillChecks', 'knowledgeChecks', 'statChecks'].includes(macro.macroCategory);

    if (isSkillCheckMacro) {
      const info = this._getCheckMacroDiceAndBonus(macro);
      if (info) {
        tooltipHTML += `<div class="tooltip-dice">Dice: <strong>${info.diceFormula}</strong></div>`;
        const color = info.bonus < 0 ? '#ff6b6b' : COLOR_SCALING;
        const sign = info.bonus > 0 ? '+' : '';
        tooltipHTML += `<div class="tooltip-scaling">Scaling: <span style="color:${color}">${sign}${info.bonus}</span></div>`;
      }
    }

    const componentColors = { flat: COLOR_FLAT_BONUS, scaling: COLOR_SCALING };

    // ============ SECTION 1: DAMAGE ============
    const damageTypes = macro.combat?.damageTypes || [];
    if (!isSkillCheckMacro && damageTypes.length > 0) {
      tooltipHTML += `<div class="tooltip-section tooltip-section-damage">`;
      tooltipHTML += `<div class="tooltip-section-label">Damage</div>`;
      for (const dt of damageTypes) {
        const formula = this._renderComponentFormula(dt, macro, componentColors);
        const typeColor = this._getDamageTypeColor(dt.type);
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${typeColor}">${dt.type || 'PHYSICAL'}</span><span class="tooltip-formula">${formula}</span></div>`;
      }
      tooltipHTML += `</div>`;
    } else if (!isSkillCheckMacro && macro.dice?.length > 0) {
      // Fallback to legacy dice format if no combat.damageTypes
      tooltipHTML += `<div class="tooltip-section tooltip-section-damage">`;
      tooltipHTML += `<div class="tooltip-section-label">Damage</div>`;
      for (const d of macro.dice) {
        const sides = d.value || d.sides;
        const type = d.type || 'PHYSICAL';
        const typeColor = this._getDamageTypeColor(type);
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${typeColor}">${type}</span><span class="tooltip-formula">${d.count}d${sides}</span></div>`;
      }
      tooltipHTML += `</div>`;
    }

    // ============ SECTION 2: STATUS BUILDUP ============
    const statusEffects = macro.combat?.statusEffects || [];
    if (!isSkillCheckMacro && statusEffects.length > 0) {
      tooltipHTML += `<div class="tooltip-section tooltip-section-buildup">`;
      tooltipHTML += `<div class="tooltip-section-label">Status Buildup</div>`;
      for (const eff of statusEffects) {
        const formula = this._renderComponentFormula(eff, macro, componentColors);
        const effectColor = this._getStatusEffectColor(eff.name);
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${effectColor}">${eff.name}</span><span class="tooltip-formula">${formula}</span></div>`;
      }
      tooltipHTML += `</div>`;
    }

    // ============ SECTION 3: CONDITIONS ============
    // Skip for skill check macros
    const conditions = macro.combat?.statusConditions || [];
    if (!isSkillCheckMacro && conditions.length > 0) {
      tooltipHTML += `<div class="tooltip-section tooltip-section-conditions">`;
      tooltipHTML += `<div class="tooltip-section-label">Conditions</div>`;
      for (const cond of conditions) {
        const condColor = this._getConditionColor(cond.name);
        const dcStr = cond.dc ? `DC ${cond.dc}` : '';
        const durStr = cond.duration ? `${cond.duration} rnd` : '';
        const details = [dcStr, durStr].filter(Boolean).join(', ');
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${condColor}">${cond.name}</span>${details ? `<span class="tooltip-detail">${details}</span>` : ''}</div>`;
      }
      tooltipHTML += `</div>`;
    }

    // ============ SECTION 4: RESTORATION ============
    const restoration = macro.combat?.restoration || [];
    if (!isSkillCheckMacro && restoration.length > 0) {
      tooltipHTML += `<div class="tooltip-section tooltip-section-restoration">`;
      tooltipHTML += `<div class="tooltip-section-label">Restoration</div>`;
      for (const rest of restoration) {
        const formula = this._renderComponentFormula(rest, macro, componentColors);
        const restColor = this._getRestorationColor(rest.type);
        const typeLabel = rest.type === 'heal-hp' ? 'Heal HP' :
                          rest.type === 'restore-fp' ? 'Restore FP' :
                          rest.type === 'restore-ap' ? 'Restore AP' :
                          rest.type === 'reduce-buildup' ? `Reduce ${rest.statusEffect || 'Buildup'}` :
                          rest.type === 'cure-condition' ? 'Cure Condition' :
                          rest.type === 'cure-effect' ? 'Cure Effect' : rest.type;
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${restColor}">${typeLabel}</span><span class="tooltip-formula">${formula}</span></div>`;
      }
      tooltipHTML += `</div>`;
    }

    // ============ SECTION 5: PROTECTION (CF4) ============
    // Skip for skill check macros
    const damageProtection = macro.combat?.damageProtectionRolls || [];
    const buildupProtection = macro.combat?.buildupProtectionRolls || [];
    const conditionProtection = macro.combat?.conditionProtectionRolls || [];
    const hasProtection = damageProtection.length > 0 || buildupProtection.length > 0 || conditionProtection.length > 0;

    if (!isSkillCheckMacro && hasProtection) {
      tooltipHTML += `<div class="tooltip-section tooltip-section-protection">`;
      tooltipHTML += `<div class="tooltip-section-label">Protection</div>`;

      for (const prot of damageProtection) {
        const protColor = this._getDamageTypeColor(prot.type);
        const parts = [];
        if (prot.tiers) parts.push(`+${prot.tiers}T`);
        if (prot.diceCount && prot.diceSides) parts.push(`${prot.diceCount}d${prot.diceSides}`);
        if (prot.flat) parts.push(`<span style="color:${COLOR_FLAT_BONUS}">+${prot.flat} flat</span>`);
        const scaling = this._resolveComponentScaling(prot, macro);
        if (scaling !== 0) {
          const color = scaling < 0 ? '#ff6b6b' : COLOR_SCALING;
          const sign = scaling > 0 ? '+' : '';
          parts.push(`<span style="color:${color}">${sign}${scaling}</span>`);
        }
        if (prot.percentage) parts.push(`${prot.percentage}%`);
        const durParts = [];
        if (prot.durationTurns) durParts.push(`${prot.durationTurns} rds`);
        if (prot.durationAttacks) durParts.push(`${prot.durationAttacks} hits`);
        const dur = durParts.length ? ` (${durParts.join(', ')})` : '';
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${protColor}">${prot.type} Prot.</span><span class="tooltip-formula">${parts.join(' ')}${dur}</span></div>`;
      }

      for (const prot of buildupProtection) {
        const protColor = this._getStatusEffectColor(prot.type);
        const parts = [];
        if (prot.diceCount && prot.diceSides) parts.push(`${prot.diceCount}d${prot.diceSides}`);
        if (prot.flat) parts.push(`<span style="color:${COLOR_FLAT_BONUS}">+${prot.flat} flat</span>`);
        const scaling = this._resolveComponentScaling(prot, macro);
        if (scaling !== 0) {
          const color = scaling < 0 ? '#ff6b6b' : COLOR_SCALING;
          const sign = scaling > 0 ? '+' : '';
          parts.push(`<span style="color:${color}">${sign}${scaling}</span>`);
        }
        if (prot.percentage) parts.push(`${prot.percentage}%`);
        const durParts = [];
        if (prot.durationTurns) durParts.push(`${prot.durationTurns} rds`);
        if (prot.durationAttacks) durParts.push(`${prot.durationAttacks} hits`);
        const dur = durParts.length ? ` (${durParts.join(', ')})` : '';
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${protColor}">${prot.type} Buildup Prot.</span><span class="tooltip-formula">${parts.join(' ')}${dur}</span></div>`;
      }

      for (const prot of conditionProtection) {
        const protColor = this._getConditionColor(prot.condition);
        const durParts = [];
        if (prot.durationTurns) durParts.push(`${prot.durationTurns} rds`);
        if (prot.durationAttacks) durParts.push(`${prot.durationAttacks} blocked`);
        const dur = durParts.length ? durParts.join(', ') : 'Permanent';
        tooltipHTML += `<div class="tooltip-row"><span class="tooltip-type" style="color:${protColor}">${prot.condition} Immunity</span><span class="tooltip-formula">${dur}</span></div>`;
      }

      tooltipHTML += `</div>`;
    }

    tooltipHTML += `</div>`;

    const tooltip = this._createElement(tooltipHTML);

    // Position off-screen initially to avoid flash
    tooltip.style.position = 'fixed';
    tooltip.style.left = '-9999px';
    tooltip.style.top = '-9999px';
    tooltip.style.visibility = 'hidden';

    document.body.appendChild(tooltip);

    // Use requestAnimationFrame to ensure dimensions are calculated after render
    requestAnimationFrame(() => {
      // Get the hovered element's position
      const rect = element.getBoundingClientRect();
      // Check for dropdown or variant submenu container
      const dropdown = element.closest('.sd20-macro-dropdown');
      const submenu = element.closest('.sd20-variant-submenu');
      const container = dropdown || submenu;
      if (!container) {
        this._hideTooltip();
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const tooltipHeight = tooltip.offsetHeight || 100; // Fallback if still 0
      const tooltipWidth = tooltip.offsetWidth || 200; // Fallback if still 0

      // Calculate left position - to the right of container
      let leftPos = containerRect.right + 8;

      // If tooltip would go off right edge, position to the left of container
      if (leftPos + tooltipWidth > window.innerWidth - 10) {
        leftPos = containerRect.left - tooltipWidth - 8;
      }

      // Calculate top position - align with hovered item
      // Use the element's top position, clamped to viewport
      let topPos = Math.max(10, rect.top);

      // Ensure tooltip doesn't go below viewport
      if (topPos + tooltipHeight > window.innerHeight - 10) {
        topPos = window.innerHeight - tooltipHeight - 10;
      }

      // Final clamp to ensure it's always on screen
      topPos = Math.max(10, topPos);

      tooltip.style.left = leftPos + 'px';
      tooltip.style.top = topPos + 'px';
      tooltip.style.visibility = 'visible';
    });
  }

  /**
   * Hide the macro tooltip
   */
  _hideTooltip() {
    document.querySelectorAll('.sd20-macro-tooltip').forEach(el => el.remove());
  }

  /**
   * Show range highlight around the selected token for a macro's range value
   * Draws a filled circle covering all hexes within range
   */
  _showRangeHighlight(macro) {
    this._hideRangeHighlight();
    const range = parseInt(macro.range) || 0;
    if (range <= 0) return;

    const token = canvas.tokens.get(this.tokenId);
    if (!token) return;

    // Use Euclidean (flat) distance: pixels per foot based on grid size/distance
    // This ignores hex grid step counting and draws a true circle at the correct radius
    const gridPx = canvas.grid.size || 100;
    const gridDist = canvas.grid.distance || 5;
    const pxPerFt = gridPx / gridDist;
    const radiusPx = range * pxPerFt;

    const gfx = new PIXI.Graphics();
    gfx.beginFill(0x4488ff, 0.15);
    gfx.lineStyle(2, 0x4488ff, 0.6);
    gfx.drawCircle(token.center.x, token.center.y, radiusPx);
    gfx.endFill();

    canvas.stage.addChild(gfx);
    this._rangeHighlight = gfx;
  }

  /**
   * Remove any active range highlight overlay
   */
  _hideRangeHighlight() {
    if (this._rangeHighlight) {
      canvas.stage.removeChild(this._rangeHighlight);
      this._rangeHighlight.destroy();
      this._rangeHighlight = null;
    }
  }

  /**
   * Close the open dropdown
   */
  _closeDropdown() {
    document.querySelectorAll('.sd20-macro-dropdown').forEach(el => el.remove());
    this._hideVariantSubmenu();
    this._hideTooltip();
    this._hideRangeHighlight();
    if (this.element) {
      this.element.querySelectorAll('.macro-category-btn').forEach(el => el.classList.remove('expanded'));
    }
    this.openCategory = null;
  }

  /**
   * Execute a macro from the dropdown by index
   */
  async _executeMacroFromDropdown(categoryId, index) {
    const macros = this.groupedMacros[categoryId] || [];
    const macro = macros[index];

    if (macro) {
      this._closeDropdown();
      await this.executeMacro(macro);
    }
  }

  /**
   * Show context menu for a macro in dropdown
   */
  _showMacroContextMenu(event, macro) {
    document.querySelectorAll('.sd20-slot-context-menu').forEach(el => el.remove());

    const menu = this._createElement(`
      <div class="sd20-slot-context-menu">
        <div class="menu-item" data-action="edit">
          <i class="fa-solid fa-edit"></i> Edit
        </div>
        <div class="menu-item" data-action="save-library">
          <i class="fa-solid fa-book"></i> Save to Library
        </div>
        <div class="menu-item" data-action="remove">
          <i class="fa-solid fa-trash"></i> Remove
        </div>
      </div>
    `);

    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';

    menu.querySelectorAll('.menu-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        const action = e.currentTarget.dataset.action;
        menu.remove();

        switch (action) {
          case 'edit':
            this._openEditMacroDialog(macro);
            break;
          case 'save-library':
            await this._saveToLibrary(macro);
            break;
          case 'remove':
            await this._removeMacroById(macro.id);
            break;
        }
      });
    });

    document.addEventListener('click', () => menu.remove(), { once: true });
    document.body.appendChild(menu);
  }

  /**
   * Save macro to user's library
   */
  async _saveToLibrary(macro) {
    if (game.sd20?.addMacroToLibrary) {
      // Get actor name for source tracking
      const actor = game.actors.get(this.actorId);
      const sourceName = actor?.name || 'Unknown Actor';

      await game.sd20.addMacroToLibrary(macro, sourceName);
      ui.notifications.info(`Saved "${macro.name}" to library`);
    } else {
      ui.notifications.warn('Macro library not available');
    }
  }

  /**
   * Handle set tab click
   */
  async _onSetTabClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    const action = target.dataset.action;

    // Handle add-set button
    if (action === 'add-set') {
      await this._addNewSet();
      return;
    }

    const setId = target.dataset.set;
    if (setId && setId !== this.activeSet) {
      this.activeSet = setId;
      await this.saveMacroSets();
      this.render();
    }
  }

  /**
   * Handle set tab right-click - show context menu
   */
  _onSetTabRightClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    const action = target.dataset.action;

    // Don't show context menu for add button
    if (action === 'add-set') return;

    const setId = target.dataset.set;
    if (!setId) return;

    this._showSetContextMenu(event, setId);
  }

  /**
   * Show context menu for a macro set tab
   */
  _showSetContextMenu(event, setId) {
    document.querySelectorAll('.sd20-set-context-menu').forEach(el => el.remove());

    const setData = this.macroSets[setId];
    if (!setData) return;

    const menu = this._createElement(`
      <div class="sd20-set-context-menu">
        <div class="menu-item" data-action="rename">
          <i class="fa-solid fa-pen"></i> Rename
        </div>
        <div class="menu-item" data-action="copy-to-library">
          <i class="fa-solid fa-book"></i> Copy Set to Library
        </div>
        <div class="menu-item" data-action="delete">
          <i class="fa-solid fa-trash"></i> Delete
        </div>
      </div>
    `);

    menu.style.position = 'fixed';
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';

    menu.querySelectorAll('.menu-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        const action = e.currentTarget.dataset.action;
        menu.remove();

        switch (action) {
          case 'rename':
            this._showRenameSetDialog(setId);
            break;
          case 'copy-to-library':
            await this._copySetToLibrary(setId);
            break;
          case 'delete':
            await this._deleteSet(setId);
            break;
        }
      });
    });

    document.addEventListener('click', () => menu.remove(), { once: true });
    document.body.appendChild(menu);
  }

  /**
   * Add a new macro set
   * @param {string} name - Optional name for the set
   */
  async _addNewSet(name = null) {
    // Generate unique ID
    const newId = `set-${Date.now()}`;
    const setNumber = this.setOrder.length + 1;
    const setName = name || `Set ${setNumber}`;

    this.macroSets[newId] = {
      id: newId,
      name: setName,
      macros: [],
      active: true
    };
    this.setOrder.push(newId);
    this.activeSet = newId;

    await this.saveMacroSets();
    this.render();
    ui.notifications.info(`Macro set "${setName}" created`);
  }

  /**
   * Show dialog to rename a set
   */
  async _showRenameSetDialog(setId) {
    const setData = this.macroSets[setId];
    if (!setData) return;

    const result = await DialogV2.prompt({
      window: { title: 'Rename Macro Set' },
      content: `
        <form>
          <div class="form-group">
            <label>Set Name (max ${MAX_SET_NAME_LENGTH} characters)</label>
            <input type="text" name="setName" value="${setData.name}" maxlength="${MAX_SET_NAME_LENGTH}" autofocus />
          </div>
        </form>
      `,
      ok: {
        label: 'Save',
        icon: 'fa-solid fa-save',
        callback: (_event, btn) => {
          const form = btn.closest('.application')?.querySelector('form')
            || btn.closest('.dialog-content')?.querySelector('form');
          return form?.querySelector('input[name="setName"]')?.value?.trim() || '';
        }
      }
    });

    if (result && result.length <= MAX_SET_NAME_LENGTH) {
      setData.name = result;
      await this.saveMacroSets();
      this.render();
    }
  }

  /**
   * Show dialog to select rest type (short/long)
   */
  async _showRestDialog() {
    const token = canvas.tokens.get(this.tokenId);
    const actor = token?.actor;
    if (!actor) {
      ui.notifications.warn('No actor found');
      return;
    }

    const result = await DialogV2.wait({
      window: { title: 'Take a Rest' },
      content: `
        <form class="sd20-rest-dialog">
          <p>Select rest type:</p>
          <div class="rest-options">
            <label class="rest-option">
              <input type="radio" name="restType" value="short" checked />
              <span class="rest-option-label">
                <i class="fa-solid fa-campfire"></i>
                <strong>Short Rest</strong>
                <small>Restores HP, FP, AP. Resets SR abilities.</small>
              </span>
            </label>
            <label class="rest-option">
              <input type="radio" name="restType" value="long" />
              <span class="rest-option-label">
                <i class="fa-solid fa-bed"></i>
                <strong>Long Rest</strong>
                <small>Restores HP, FP, AP. Resets SR and LR abilities.</small>
              </span>
            </label>
          </div>
        </form>
      `,
      buttons: [{
        action: 'rest',
        label: 'Rest',
        icon: 'fa-solid fa-fire',
        default: true,
        callback: (_event, btn) => {
          const form = btn.closest('.application')?.querySelector('form')
            || btn.closest('.dialog-content')?.querySelector('form');
          return form?.querySelector('input[name="restType"]:checked')?.value || 'short';
        }
      }, {
        action: 'cancel',
        label: 'Cancel',
        icon: 'fa-solid fa-times'
      }]
    });

    if (result && result !== 'cancel') {
      await this._performRest(result, actor, token);
    }
  }

  /**
   * Perform rest - restore resources and reset ability uses
   */
  async _performRest(type, actor, token) {
    // Restore HP, FP, AP to max
    const sys = actor.system;
    const updateData = {};
    if (sys.hp?.max !== undefined) updateData['system.hp.value'] = sys.hp.max;
    if (sys.fp?.max !== undefined) updateData['system.fp.value'] = sys.fp.max;
    if (sys.ap?.max !== undefined) updateData['system.ap.value'] = sys.ap.max;

    if (Object.keys(updateData).length > 0) {
      await actor.update(updateData);
    }

    // Reset rest ability uses across all macro sets
    let abilitiesReset = 0;
    for (const setId of this.setOrder) {
      const setData = this.macroSets[setId];
      if (!setData?.macros) continue;

      for (const macro of setData.macros) {
        if (!macro?.restAbility?.type) continue;

        // Short rest resets only SR; Long rest resets both SR and LR
        const shouldReset = type === 'long' || macro.restAbility.type === 'short';
        if (shouldReset) {
          const maxUses = resolveMaxUses(macro.restAbility, actor);
          macro.restAbility.currentUses = maxUses;
          abilitiesReset++;
        }
      }
    }

    await this.saveMacroSets();
    this.render();

    // postMaskedChat dual-emits: insiders (GM + actor owners) see the real
    // name, outsiders see '???'. The render hook in souls-d20.js takes care
    // of the speaker header on all other macro-roll chat cards as well.
    const restLabel = type === 'short' ? 'short rest' : 'long rest';
    postMaskedChat(actor, (displayName) =>
      `<div class="sd20-rest-message"><strong>${displayName}</strong> took a <em>${restLabel}</em>.</div>`
    );

    const resetMsg = abilitiesReset > 0 ? ` ${abilitiesReset} abilities reset.` : '';
    ui.notifications.info(`${actor.name} took a ${restLabel}. HP, FP, AP restored.${resetMsg}`);
  }

  /**
   * Copy all macros from a set to the user's library
   */
  async _copySetToLibrary(setId) {
    const setData = this.macroSets[setId];
    if (!setData || !setData.macros || setData.macros.length === 0) {
      ui.notifications.warn('No macros in this set to copy');
      return;
    }

    const actor = game.actors.get(this.actorId);
    const sourceName = actor?.name || 'Unknown Actor';

    let copied = 0;
    for (const macro of setData.macros) {
      if (macro) {
        await addMacroToLibrary(macro, sourceName);
        copied++;
      }
    }

    if (copied > 0) {
      ui.notifications.info(`Copied ${copied} macro${copied > 1 ? 's' : ''} from "${setData.name}" to library`);
    }
  }

  /**
   * Delete a macro set
   */
  async _deleteSet(setId) {
    // Don't delete if it's the last set
    if (this.setOrder.length <= 1) {
      ui.notifications.warn('Cannot delete the last macro set');
      return;
    }

    const setData = this.macroSets[setId];
    const setName = setData?.name || 'Set';

    // Confirm deletion
    const confirmed = await DialogV2.confirm({
      window: { title: 'Delete Macro Set' },
      content: `<p>Are you sure you want to delete "${setName}"?</p><p>All macros in this set will be removed.</p>`
    });

    if (!confirmed) return;

    // Remove from order array
    const orderIndex = this.setOrder.indexOf(setId);
    if (orderIndex >= 0) {
      this.setOrder.splice(orderIndex, 1);
    }

    // Delete from sets object
    delete this.macroSets[setId];

    // Switch to first available set if deleted set was active
    if (this.activeSet === setId) {
      this.activeSet = this.setOrder[0];
    }

    await this.saveMacroSets();
    this.render();
    ui.notifications.info(`Macro set "${setName}" deleted`);
  }

  /**
   * Handle control button click
   */
  async _onControlClick(event) {
    event.preventDefault();
    const action = event.currentTarget.dataset.action;

    switch (action) {
      case 'add':
        this._openAddMacroDialog();
        break;
      case 'refresh': {
        if (!this.characterUUID) {
          ui.notifications.warn('Link a character first to refresh macros from the App');
          return;
        }
        const isAppConnected = game.sd20?.broadcastChannel?.connected === true;
        if (!isAppConnected) {
          ui.notifications.warn('SD20 App is not connected. Start the App and relay server to sync.');
          return;
        }
        // Optimization 8: surface the round-trip in the header badge so the
        // player knows why the bar is temporarily unresponsive.
        this.setSyncState('syncing');
        try {
          await this.refreshMacros(false, true);
          this.setSyncState('idle');
          ui.notifications.info('Macros refreshed from SD20 App (user edits preserved)');
        } catch (err) {
          this.setSyncState('offline');
          debug('refreshMacros failed during manual refresh:', err);
          ui.notifications.warn('Refresh failed - App may be offline. Showing cached macros.');
        }
        break;
      }
      case 'regenerate': {
        // For NPCs/monsters without App link - regenerate macros from token's combat settings
        const token = canvas.tokens.get(this.tokenId);
        if (!token) {
          ui.notifications.error('Token not found');
          return;
        }
        // Use token.actor (synthetic actor) to get token-specific stats
        const actorForMacros = this.isUnlinked ? token.actor : game.actors.get(this.actorId);
        debug(`Regenerating macros for ${this.isUnlinked ? 'UNLINKED' : 'linked'} actor: ${actorForMacros?.name}`);
        await this._generateBasicMacrosForActor(actorForMacros, token, true); // forceRegenerate=true
        this.render();
        ui.notifications.info(`Macros regenerated from ${token.name}'s combat settings`);
        break;
      }
      case 'settings':
        this._openMacroSettings();
        break;
      case 'link':
        await this._linkCharacter();
        break;
      case 'unlink':
        await this._unlinkCharacter();
        break;
      case 'library':
        if (game.sd20?.openMacroLibrary) {
          game.sd20.openMacroLibrary();
        }
        break;
      case 'rest':
        await this._showRestDialog();
        break;
    }
  }

  /**
   * Open character linking dialog
   */
  async _linkCharacter() {
    const token = canvas.tokens.get(this.tokenId);
    if (!token) return;
    const { showCharacterSelector } = await import('./linkDialog.js');
    await showCharacterSelector(token.document, null);
  }

  /**
   * Open unlink dialog with choices: token, actor, or both
   */
  async _unlinkCharacter() {
    const token = canvas.tokens.get(this.tokenId);
    if (!token) return;

    const actor = token.actor;
    const actorId = actor?.id;
    const worldActor = actorId ? game.actors.get(actorId) : null;
    const characterUUID = this.characterUUID;
    const character = game.sd20?.characters?.[characterUUID];
    const charName = character?.name || 'SD20 Character';
    const actorName = worldActor?.name || actor?.name || 'Unknown Actor';

    // Build dialog content using CSS classes for styling
    const content = `
      <div class="souls-d20 sd20-unlink-dialog">
        <p class="unlink-heading">
          <strong>Unlink "${actorName}"</strong> from <strong>"${charName}"</strong>
        </p>
        <p class="unlink-subtext">
          This determines how macros and character data are cleared.
          Choose carefully. This action cannot be undone.
        </p>
        <div class="unlink-options">
          <label class="unlink-option option-actor">
            <input type="radio" name="unlink-scope" value="actor" checked>
            <div>
              <strong>Unlink the Actor</strong>
              <div class="option-desc">Removes SD20 character link from the Actor. All tokens using this Actor will lose their SD20 connection. Macro sets on the Actor are preserved.</div>
            </div>
          </label>
          <label class="unlink-option option-both">
            <input type="radio" name="unlink-scope" value="both">
            <div>
              <strong>Unlink Actor and clear all macros</strong>
              <div class="option-desc">Removes SD20 character link AND deletes all saved macro sets from the Actor. This is a full reset.</div>
            </div>
          </label>
        </div>
      </div>
    `;

    const scope = await DialogV2.prompt({
      window: { title: 'Unlink SD20 Character' },
      content,
      ok: {
        label: 'Unlink',
        icon: 'fa-solid fa-unlink',
        callback: (_event, btn) => {
          const container = btn.closest('.application')?.querySelector('.unlink-options')
            || btn.closest('.dialog-content')?.querySelector('.unlink-options');
          if (!container) return null;
          const checked = container.querySelector('input[name="unlink-scope"]:checked');
          return checked?.value || null;
        }
      }
    });

    if (scope) {
      await this._performUnlink(scope, worldActor, token, characterUUID, charName, actorName);
    }
  }

  /**
   * Perform the actual unlink based on chosen scope
   */
  async _performUnlink(scope, actor, token, characterUUID, charName, actorName) {
    switch (scope) {
      case 'actor':
        // Soft: tokens on canvas keep their data forever, but the actor goes
        // back to a blank state so future drags-from-actor make blank tokens.
        // Mark existing tokens as orphaned BEFORE clearing the actor so the
        // updateActor hook (which can fan out) does not touch them.
        if (actor) {
          await orphanAllTokensOfActor(actor);
          await actor.update({ 'system.characterUUID': '' });
        }
        ui.notifications.info(`Actor "${actorName}" unlinked from "${charName}". Existing tokens preserved.`);
        break;

      case 'both':
        // Hard: blank this specific token, blank the actor, leave other tokens
        // of the same actor alone. Linked ones will follow the now-blank actor
        // automatically; unlinked ones keep their delta.
        if (actor) {
          await actor.update({ 'system.characterUUID': '' });
          await resetActorToBlank(actor);
        }
        await resetTokenToBlank(token.document);
        ui.notifications.info(`"${actorName}" unlinked. Actor and this token cleared.`);
        break;
    }

    // Remove from character storage
    if (game.sd20?.characters?.[characterUUID]) {
      delete game.sd20.characters[characterUUID];
    }

    // Update macro bar state - clear characterUUID first
    this.characterUUID = null;

    if (scope === 'both') {
      // Full unlink: complete blank slate - no macros at all
      // User explicitly wants to clear everything and start fresh
      this.macroSets = {};
      this.setOrder = [];
      this.activeSet = null;
      this._initializeDefaultSets();

      // Clear stale groupedMacros cache before render
      this.groupedMacros = {};

      // Save the empty state
      await this.saveMacroSets();
    }
    // Actor-only unlink no longer touches macro sources. Bug 4: the App-source
    // tag is what lets a future re-link line up incoming App data with the
    // existing rows. Flipping every macro to custom used to drop those tags
    // and cause player-edited copies of App macros to be filtered out on
    // re-link. Macros keep working offline because the stored data itself is
    // local; they do not require an active App connection to execute.

    // Re-render AFTER all state changes are complete
    this.render();

    // Force immediate UI updates across all relevant elements
    this._refreshAllUIForActor(actor, token);
  }

  /**
   * Force refresh of all UI elements for an actor after unlink
   * @param {Actor} actor - The actor that was unlinked
   * @param {Token} token - The token
   */
  _refreshAllUIForActor(actor, token) {
    // Refresh actor sheet if open
    if (actor?.sheet?.rendered) {
      actor.sheet.render(true);
    }

    // Refresh all tokens for this actor on the current scene
    const tokens = canvas.tokens?.placeables?.filter(t => t.actor?.id === actor?.id) || [];
    for (const t of tokens) {
      // Refresh token HUD if it's displayed for this token
      if (canvas.hud?.token?.object?.id === t.id) {
        canvas.hud.token.render(true);
      }
      // Refresh token appearance
      t.refresh();
    }

    // Trigger a hook that other modules can listen to
    Hooks.callAll('sd20CharacterLinkChanged', actor, token?.document);
  }

  /**
   * Resolve weapon scaling bonus at runtime
   * Returns the numeric scaling bonus for mainHand or offHand
   */
  _resolveWeaponScaling(scalingLink) {
    if (scalingLink !== 'mainHand' && scalingLink !== 'offHand') return 0;

    const character = game.sd20?.characters?.[this.characterUUID];
    const weapon = scalingLink === 'mainHand' ? character?.mainHand : character?.offHand;
    if (weapon?.scalingBonus !== undefined) return weapon.scalingBonus;

    // Offline fallback: use stored actor data
    const token = canvas.tokens.get(this.tokenId);
    const stored = token?.actor?.system?.equippedWeapons?.[scalingLink];
    if (stored?.scalingBonus !== undefined) return stored.scalingBonus;

    debug(`Scaling link "${scalingLink}" could not be resolved. Using 0.`);
    return 0;
  }

  /**
   * Resolve weapon scaling bonus for a specific damage type (CF1: Per-damage-type scaling)
   * Returns the scaling bonus for the given damage type, or falls back to total if not available
   * @param {string} scalingLink - 'mainHand' or 'offHand'
   * @param {string} damageType - The damage type to get scaling for (PHYSICAL, MAGIC, FIRE, etc.)
   * @returns {number} The scaling bonus for that damage type
   */
  _resolveWeaponScalingByType(scalingLink, damageType) {
    if (scalingLink !== 'mainHand' && scalingLink !== 'offHand') return 0;
    const normalizedType = (damageType || 'PHYSICAL').toUpperCase();

    const character = game.sd20?.characters?.[this.characterUUID];
    const weapon = scalingLink === 'mainHand' ? character?.mainHand : character?.offHand;

    // Check for per-type scaling first
    if (weapon?.scalingBonusByType && typeof weapon.scalingBonusByType === 'object') {
      const bonus = weapon.scalingBonusByType[normalizedType];
      if (bonus !== undefined) return bonus;
      // If no scaling for this type, return 0 (intentional - no scaling defined for this damage type)
      return 0;
    }

    // Fallback to total scaling for backwards compatibility
    if (weapon?.scalingBonus !== undefined) return weapon.scalingBonus;

    // Offline fallback: use stored actor data
    const token = canvas.tokens.get(this.tokenId);
    const stored = token?.actor?.system?.equippedWeapons?.[scalingLink];

    if (stored?.scalingBonusByType && typeof stored.scalingBonusByType === 'object') {
      const bonus = stored.scalingBonusByType[normalizedType];
      if (bonus !== undefined) return bonus;
      return 0;
    }

    if (stored?.scalingBonus !== undefined) return stored.scalingBonus;

    debug(`Scaling link "${scalingLink}" could not be resolved for type "${damageType}". Using 0.`);
    return 0;
  }

  /**
   * Resolve monster stat scaling
   * @param {string} scalingSource - Format: "stat:strength" or "statMod:dexterity"
   * @param {Actor} actor - The NPC actor
   * @returns {number} The stat value or mod to add as scaling bonus
   */
  _resolveMonsterScaling(scalingSource, actor) {
    if (!scalingSource || !actor || actor.type !== 'npc') return 0;

    const [type, statName] = scalingSource.split(':');
    if (!type || !statName) return 0;

    const stats = actor.system?.stats || {};
    const statData = stats[statName];

    if (!statData) {
      debug(`Monster scaling: stat "${statName}" not found on actor`);
      return 0;
    }

    if (type === 'stat') {
      // Use raw stat value
      return statData.value ?? statData ?? 0;
    } else if (type === 'statMod') {
      // Use stat modifier (stored or computed)
      if (statData.mod !== undefined) {
        return statData.mod;
      }
      // Compute if only value is stored
      const val = statData.value ?? statData ?? 10;
      return Math.floor((val - 10) / 2);
    }

    return 0;
  }

  /**
   * Resolve manual scaling entries at runtime
   * Calculates total bonus from grade/stat/fraction entries
   * @param {Array} entries - Array of {mode, grade, stat, fraction} objects
   * @returns {number} The total scaling bonus
   */
  _resolveManualScalingEntries(entries) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) return 0;

    // Get the actor for stat resolution
    // For unlinked tokens, MUST use token.actor to get the synthetic actor with delta data
    // game.actors.get() returns the base actor which doesn't have the synced stats
    const token = canvas.tokens.get(this.tokenId);
    const actor = token?.actor || game.actors.get(this.actorId);
    if (!actor) return 0;

    const stats = actor.system?.stats || {};
    let totalBonus = 0;

    for (const entry of entries) {
      const { mode, stat, fraction } = entry;
      // Ensure grade is uppercase to match CONFIG.SCALING_GRADES keys
      const grade = typeof entry.grade === 'string' ? entry.grade.toUpperCase() : String(entry.grade || 'D');

      // Get stat value
      const statData = stats[stat];
      if (statData === undefined || statData === null) continue;

      // Get raw stat value - handle different structures
      let statValue;
      if (typeof statData === 'object' && statData !== null) {
        statValue = statData.value ?? statData.total ?? statData.current ?? 10;
      } else {
        statValue = statData ?? 10;
      }

      // Calculate stat modifier: floor((value - 10) / 2)
      const statMod = Math.floor((statValue - 10) / 2);

      let scalingValue = 0;

      if (mode === 'flat') {
        // Flat mode: use raw stat VALUE directly
        scalingValue = statValue;
      } else {
        // Graded mode: use stat MOD × grade multiplier
        const gradeMultiplier = CONFIG.SCALING_GRADES?.[grade] || 1.0;
        scalingValue = Math.floor(gradeMultiplier * statMod);
      }

      // Apply fraction
      const fractionMultiplier = CONFIG.SCALING_FRACTIONS?.[fraction] || 1.0;
      if (fractionMultiplier !== 1.0) {
        scalingValue = Math.floor(scalingValue * fractionMultiplier);
      }

      totalBonus += scalingValue;
    }

    return totalBonus;
  }

  /**
   * Execute a macro - rolls each combat component separately
   */
  async executeMacro(macro, _isChainedExecution = false) {
    debug(`Executing macro: ${macro.name}${_isChainedExecution ? ' (chained)' : ''}`);

    // Cancel any active grid selection to prevent softlock
    cancelActiveGridSelection();

    // Fresh top-level execution clears any leftover chain queue
    if (!_isChainedExecution) _chainQueue.length = 0;

    const token = canvas.tokens.get(this.tokenId);
    if (!token) {
      ui.notifications.warn('Token not found');
      return;
    }

    // Custom script execution path (parallel to builder path)
    if (macro.scriptEdited && macro.customScript) {
      setExecutionContext(token, macro);
      try {
        const sd20 = game.sd20?.api || {};
        const caster = token;
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const scriptFn = new AsyncFunction('sd20', 'caster', 'token', 'macro', 'game', macro.customScript);
        await scriptFn(sd20, caster, token, macro, game);
      } catch (err) {
        console.error('SD20 | Custom script execution failed:', err);
        ui.notifications.error(`Script error in "${macro.name}": ${err.message}`);
      }
      clearExecutionContext();
      _executeChainIfPending(this);
      return;
    }

    // Effect choice for non-AoE macros with secondary effects configured
    const hasSecondary = this._hasSecondaryEffects(macro);
    const isAoEMacro = !!(macro.aoe?.shape && ((macro.aoe?.sizeMin > 0) || (macro.aoe?.sizeMax > 0)));
    let effectChoice = 'primary';
    if (hasSecondary && !isAoEMacro) {
      effectChoice = await this._showEffectChoicePopup(macro);
      if (!effectChoice) return; // cancelled
    }

    // If single-target mode with AoE, place AoE first so user can see the area while picking
    let preplacedAoE = false;
    let preplacedTemplate = null;
    if (macro.targeting?.isTargetMacro && macro.targeting.mode === 'single' &&
        macro.aoe?.shape && (macro.aoe.sizeMin > 0 || macro.aoe.sizeMax > 0)) {
      preplacedTemplate = await this._createAOETemplate(macro, token);
      if (!preplacedTemplate) return; // User cancelled AoE placement
      preplacedAoE = true;
    }

    // Resolve targets if this is a targeting macro
    let resolvedTargets = null;
    if (macro.targeting?.isTargetMacro) {
      const createAoEFn = (m, t) => this._createAOETemplate(m, t);
      const result = await resolveTargets(macro, token, createAoEFn, preplacedTemplate);
      if (result.cancelled) return;
      resolvedTargets = result.targets;
    }

    // Spend AP/FP cost on the casting actor. Skipped on chained executions so
    // queued follow-up macros do not pay the cost twice for the same player action.
    if (!_isChainedExecution) {
      const apCost = parseInt(macro.apCost) || 0;
      const fpCost = parseInt(macro.fpCost) || 0;
      if (apCost > 0 || fpCost > 0) {
        const castingActor = token.actor;
        const currentAP = castingActor?.system?.ap?.value ?? 0;
        const currentFP = castingActor?.system?.fp?.value ?? 0;
        const newAP = Math.max(0, currentAP - apCost);
        const newFP = Math.max(0, currentFP - fpCost);
        if (this.isUnlinked && token) {
          await token.document.update({
            'delta.system.ap.value': newAP,
            'delta.system.fp.value': newFP
          });
        } else if (castingActor) {
          await castingActor.update({
            'system.ap.value': newAP,
            'system.fp.value': newFP
          });
        }
      }
    }

    // Decrement rest ability uses if applicable
    if (macro.restAbility?.type) {
      const actor = token.actor;
      const maxUses = resolveMaxUses(macro.restAbility, actor);
      const currentUses = macro.restAbility.currentUses ?? maxUses;
      if (currentUses <= 0) {
        ui.notifications.warn(`${macro.name} has no uses remaining (recovers on ${macro.restAbility.type === 'short' ? 'short' : 'long'} rest)`);
      } else {
        macro.restAbility.currentUses = currentUses - 1;
        await this.saveMacroSets();
        this.render();
        debug(`${macro.name} uses: ${currentUses} -> ${currentUses - 1}`);
      }
    }

    const combat = this._getSelectedCombat(macro, effectChoice);
    const hasCombat = combat && (
      combat.damageTypes?.length || combat.statusEffects?.length ||
      combat.statusConditions?.length || combat.restoration?.length ||
      combat.vulnerabilities?.length ||
      // CF4: Protection arrays
      combat.damageProtection?.length || combat.buildupProtection?.length ||
      combat.conditionProtection?.length
    );

    // Collect all rolls and results
    const allRolls = [];
    const combatResults = {
      damageRolls: [],
      buildupRolls: [],
      conditionRolls: [],
      restorationRolls: [],
      vulnerabilityRolls: [],
      // CF4: Protection roll arrays
      damageProtectionRolls: [],
      buildupProtectionRolls: [],
      conditionProtectionRolls: []
    };

    if (hasCombat) {
      // Roll each damage type
      for (const dmg of (combat.damageTypes || [])) {
        const result = await this._rollCombatComponent(dmg, 'damage', macro);
        combatResults.damageRolls.push(result);
        if (result.roll) allRolls.push(result.roll);
      }

      // Roll each status buildup
      for (const eff of (combat.statusEffects || [])) {
        const result = await this._rollCombatComponent(eff, 'buildup', macro);
        combatResults.buildupRolls.push(result);
        if (result.roll) allRolls.push(result.roll);
      }

      // Process status conditions - resolve DC bonus and calculate total DC
      for (const cond of (combat.statusConditions || [])) {
        const result = { ...cond };
        // Resolve DC bonus from source (attacker's stats)
        if (cond.dcBonusSource && cond.dcBonusSource !== 'none') {
          result.dcBonusResolved = this._resolveDCBonus(cond.dcBonusSource, token);
        }
        // Calculate total DC for display
        if (cond.dc && cond.dc > 0) {
          result.totalDC = cond.dc + (result.dcBonusResolved ?? 0);
        }
        combatResults.conditionRolls.push(result);
      }

      // Roll each restoration component
      for (const rest of (combat.restoration || [])) {
        const restType = rest.type;
        const atTurnStart = !!rest.atTurnStart;
        const atTurnEnd = !!rest.atTurnEnd;
        if (['heal-hp', 'restore-fp', 'restore-ap', 'reduce-buildup'].includes(restType)) {
          const result = await this._rollCombatComponent(rest, 'restoration', macro);
          result.type = restType;
          result.restorationType = restType;
          result.allowOverMax = rest.allowOverMax || false;
          result.atTurnStart = atTurnStart;
          result.atTurnEnd = atTurnEnd;
          if (restType === 'reduce-buildup') result.statusEffect = rest.statusEffect;
          combatResults.restorationRolls.push(result);
          if (result.roll) allRolls.push(result.roll);
        } else {
          combatResults.restorationRolls.push({
            type: restType,
            restorationType: restType,
            conditions: rest.conditions || [],
            statusEffects: rest.statusEffects || [],
            atTurnStart,
            atTurnEnd,
            total: 0
          });
        }
      }

      // Collect vulnerability effects (no rolls, just data)
      for (const vuln of (combat.vulnerabilities || [])) {
        combatResults.vulnerabilityRolls.push({
          type: vuln.type,
          tiers: vuln.tiers || 1,
          duration: vuln.duration || 3,
          timing: vuln.timing || 'before',
          stacking: vuln.stacking || false
        });
      }

      // CF4: Collect damage protection effects
      for (const prot of (combat.damageProtection || [])) {
        combatResults.damageProtectionRolls.push({
          type: prot.type || 'PHYSICAL',
          tiers: parseInt(prot.tiers) || 0,
          flat: parseInt(prot.flat) || 0,
          diceCount: parseInt(prot.diceCount) || 0,
          diceSides: parseInt(prot.diceSides) || 0,
          percentage: parseInt(prot.percentage) || 0,
          percentageTiming: prot.percentageTiming || 'INITIAL',
          durationTurns: parseInt(prot.durationTurns) || 0,
          durationAttacks: parseInt(prot.durationAttacks) || 0,
          stacking: prot.stacking || 'OVERWRITE',
          applyToCaster: prot.applyToCaster || false,
          applyToTarget: prot.applyToTarget !== false
        });
      }

      // CF4: Collect buildup protection effects
      for (const prot of (combat.buildupProtection || [])) {
        combatResults.buildupProtectionRolls.push({
          type: prot.type || 'BLEED',
          flat: parseInt(prot.flat) || 0,
          diceCount: parseInt(prot.diceCount) || 0,
          diceSides: parseInt(prot.diceSides) || 0,
          percentage: parseInt(prot.percentage) || 0,
          percentageTiming: prot.percentageTiming || 'INITIAL',
          durationTurns: parseInt(prot.durationTurns) || 0,
          durationAttacks: parseInt(prot.durationAttacks) || 0,
          stacking: prot.stacking || 'OVERWRITE',
          applyToCaster: prot.applyToCaster || false,
          applyToTarget: prot.applyToTarget !== false
        });
      }

      // CF4: Collect condition immunity protection effects
      for (const prot of (combat.conditionProtection || [])) {
        combatResults.conditionProtectionRolls.push({
          condition: prot.condition || 'Dazed',
          durationTurns: parseInt(prot.durationTurns) || 0,
          durationAttacks: parseInt(prot.durationAttacks) || 0,
          applyToCaster: prot.applyToCaster || false,
          applyToTarget: prot.applyToTarget !== false
        });
      }
    } else if (macro.dice?.length > 0) {
      // Legacy dice fallback
      const effectiveScaling = this._resolveLegacyScaling(macro);
      const diceStr = macro.dice.map(d => `${d.count}d${d.value || d.sides}`).join(' + ');
      let formula = diceStr;
      if (effectiveScaling && effectiveScaling !== 0) {
        formula += effectiveScaling > 0 ? ` + ${effectiveScaling}` : ` - ${Math.abs(effectiveScaling)}`;
      }
      const roll = new Roll(formula);
      await roll.evaluate();
      allRolls.push(roll);
      combatResults._legacyRoll = roll;
      combatResults._legacyRollHTML = await roll.render();
    }

    // Simple roll (optional non-damage roll if configured). Skipped entirely
    // when the macro has a combat block with any rolling content. The combat
    // section provides its own per-component dice display and the simpleRoll
    // line below would otherwise duplicate or mislabel the result.
    const hasCombatRollContent = (
      (macro.combat?.damageTypes?.length > 0) ||
      (macro.combat?.statusEffects?.length > 0) ||
      (macro.combat?.statusConditions?.length > 0) ||
      (macro.combat?.restoration?.length > 0) ||
      (macro.secondaryCombat?.damageTypes?.length > 0) ||
      (macro.secondaryCombat?.statusEffects?.length > 0) ||
      (macro.secondaryCombat?.statusConditions?.length > 0) ||
      (macro.secondaryCombat?.restoration?.length > 0)
    );
    // Bug 13: allow flat-only simpleRoll (count = 0). Fires when at least one of
    // count > 0 or bonus != 0 is present. Sides is informational at that point.
    const sr = macro.simpleRoll;
    const srHasDice = sr?.diceSides && (parseInt(sr.diceCount) || 0) > 0;
    const srHasBonus = (parseInt(sr?.bonus) || 0) !== 0;
    if (!hasCombatRollContent && (srHasDice || srHasBonus)) {
      const count = parseInt(sr.diceCount) || 0;
      const sides = parseInt(sr.diceSides) || 0;
      let bonus = parseInt(sr.bonus) || 0;
      // NPC default check macros store the actor-derived modifier on `dcBonus`
      // (e.g. 'stat:dexterity'). Resolve it at roll time so the initiative or
      // skill check actually reflects the actor's current stats.
      if (bonus === 0 && macro.dcBonus) {
        const resolved = this._resolveDCBonus(macro.dcBonus, token);
        if (typeof resolved === 'number' && !isNaN(resolved)) {
          bonus = resolved;
        }
      }
      // 0d0 or 0d20 are valid "flat-only" cases. Build a formula that Foundry
      // can evaluate cleanly: dice term only if count > 0 and sides > 0.
      let formula = '';
      if (count > 0 && sides > 0) formula = `${count}d${sides}`;
      if (bonus !== 0) {
        if (formula) {
          formula += bonus > 0 ? ` + ${bonus}` : ` - ${Math.abs(bonus)}`;
        } else {
          formula = `${bonus}`;
        }
      }
      if (!formula) formula = '0';
      const simpleRoll = new Roll(formula);
      await simpleRoll.evaluate();
      allRolls.push(simpleRoll);
      combatResults._simpleRoll = simpleRoll;
      combatResults._simpleRollHTML = await simpleRoll.render();
    }

    // Determine if chat should be deferred until ruling is approved
    const hasHarmful = combatResults.damageRolls?.length || combatResults.buildupRolls?.length || combatResults.conditionRolls?.length || combatResults.vulnerabilityRolls?.length;
    const hasRestoration = combatResults.restorationRolls?.length;
    // CF4: Protection is positive and goes through restoration event
    const hasProtection = combatResults.damageProtectionRolls?.length || combatResults.buildupProtectionRolls?.length || combatResults.conditionProtectionRolls?.length;
    const usesThreatSystem = hasCombat && game.sd20?.threatSystem && resolvedTargets?.length && (hasHarmful || hasRestoration || hasProtection);

    // Build chat card
    const content = this._buildMacroChat(macro, combatResults);

    // Store results in message flags for ruling panel
    const messageData = {
      speaker: ChatMessage.getSpeaker({ token: token.document }),
      content,
      rolls: allRolls,
      flags: {
        'souls-d20': {
          combatResults,
          macroId: macro.id,
          macroName: macro.name,
          actorId: token.actor?.id
        }
      }
    };

    // Create AOE template BEFORE animations if macro has area of effect defined
    // This ensures animations can use the template position
    // Skip if targeting already placed it (aoe mode or single+aoe pre-placement)
    const targetingHandledAoE = macro.targeting?.isTargetMacro &&
      (macro.targeting?.mode === 'aoe' || preplacedAoE);
    let nonTargetingAoETemplate = null;
    if (!targetingHandledAoE && macro.aoe?.shape && ((macro.aoe?.sizeMin > 0) || (macro.aoe?.sizeMax > 0))) {
      nonTargetingAoETemplate = await this._createAOETemplate(macro, token);
      // If user cancelled AoE placement, still continue with macro (just no AoE)
    }

    // Determine the template to use for animations
    const animationTemplate = preplacedTemplate || nonTargetingAoETemplate || null;

    // If using threat system, defer chat until ruling is approved
    // Otherwise post immediately
    if (!usesThreatSystem) {
      await ChatMessage.create(messageData);

      // Play animation immediately for non-threat macros (no ruling needed)
      debug(`Animation check: enabled=${macro.animation?.enabled}, available=${isAnimationSystemAvailable()}`);
      if (macro.animation?.enabled && isAnimationSystemAvailable()) {
        let gridTarget = null;

        // If macro doesn't use targeting system AND has no AoE template,
        // but animation needs a target (projectile/impact/area), prompt for grid selection
        const usesTargeting = macro.targeting?.isTargetMacro;
        const hasAoETemplate = !!animationTemplate;
        const needsGridTarget = !usesTargeting && !hasAoETemplate && animationNeedsTarget(macro.animation);

        if (needsGridTarget && (!resolvedTargets || resolvedTargets.length === 0)) {
          debug(`Macro has no targeting and no AoE but animation needs target - prompting for grid selection`);
          gridTarget = await selectAnimationTarget(token);
          if (!gridTarget) {
            debug('Grid target selection cancelled, skipping animation');
          }
        }

        if (!needsGridTarget || gridTarget) {
          debug(`Playing animation - caster: ${token.name}, targets: ${(resolvedTargets || []).map(t => t.name).join(', ')}, template: ${animationTemplate?.id || 'none'}, gridTarget: ${gridTarget ? `(${Math.round(gridTarget.x)}, ${Math.round(gridTarget.y)})` : 'none'}`);
          await playMacroAnimation({
            caster: token,
            targets: resolvedTargets || [],
            template: animationTemplate,
            animConfig: macro.animation,
            isHidden: macro.aoe?.playerVisibility === 'hidden',
            gridTarget,
            exclusionRadius: macro.aoe?.exclusionRadius || 0
          });
        }
      }
    } else {
      debug(`Using threat system - animation will be deferred. hasCombat=${hasCombat}, hasTargets=${resolvedTargets?.length}`);
    }

    // Create threat/restoration events for resolved targets
    const executionId = foundry.utils.randomID();
    let createdThreatEvents = false;

    if (hasCombat && game.sd20?.threatSystem && resolvedTargets?.length) {
      // Prepare animation config for deferred playback after ruling approval
      const animationContext = (macro.animation?.enabled && isAnimationSystemAvailable()) ? {
        casterTokenId: token.id,
        targetTokenIds: resolvedTargets.map(t => t.id),
        templateId: animationTemplate?.id || null,
        animConfig: macro.animation,
        isHidden: macro.aoe?.playerVisibility === 'hidden',
        exclusionRadius: macro.aoe?.exclusionRadius || 0
      } : null;

      const aoeOptions = { aoeTemplateId: animationTemplate?.id || null };
      for (const targetToken of resolvedTargets) {
        if (hasHarmful) {
          game.sd20.threatSystem.createThreatEvent(token, targetToken, macro, combatResults, messageData, executionId, animationContext, aoeOptions);
          createdThreatEvents = true;
        }
        if (hasRestoration) {
          game.sd20.threatSystem.createRestorationEvent(token, targetToken, macro, combatResults, messageData, executionId, animationContext, aoeOptions);
          createdThreatEvents = true;
        }
      }
    }

    // Execute custom script if present
    if (macro.customScript?.trim()) {
      await this._executeCustomScript(macro, token, allRolls[0] || null);
    }

    // Visual feedback on slot
    if (this.element) {
      const slotElement = this.element.querySelector(`.macro-slot[data-slot="${this.macroSets[this.activeSet]?.macros?.indexOf(macro)}"]`);
      if (slotElement) {
        slotElement.classList.add('activated');
        setTimeout(() => slotElement.classList.remove('activated'), 200);
      }
    }

    // Macro chaining: if threat events were created, wait for resolution; otherwise fire now
    if (createdThreatEvents && game.sd20?.threatSystem?.registerExecutionBatch) {
      game.sd20.threatSystem.registerExecutionBatch(executionId, () => _executeChainIfPending(this));
    } else {
      _executeChainIfPending(this);
    }
  }

  /**
   * Execute an AoE repeat - re-rolls combat for targets in/near a template
   * Called by the AoE repeat button UI
   * @param {Object} macroData - Stored macro data from template flags
   * @param {string} effectChoice - 'primary', 'secondary', or 'both'
   * @param {Token[]} targets - Array of target tokens
   * @param {MeasuredTemplate} template - The AoE template document
   */
  /**
   * Check if a macro has any secondary combat effects configured
   */
  _hasSecondaryEffects(macro) {
    const sc = macro.secondaryCombat;
    return !!(sc && (
      sc.damageTypes?.length || sc.statusEffects?.length ||
      sc.statusConditions?.length || sc.restoration?.length
    ));
  }

  /**
   * Get the combat data based on the user's effect choice
   * @param {Object} macro - The macro being executed
   * @param {string} choice - 'primary', 'secondary', or 'both'
   * @returns {Object} The combat data to use for rolling
   */
  _getSelectedCombat(macro, choice) {
    const primary = macro.combat || {};
    const secondary = macro.secondaryCombat || {};
    if (choice === 'secondary') return secondary;
    if (choice === 'both') return {
      damageTypes: [...(primary.damageTypes || []), ...(secondary.damageTypes || [])],
      statusEffects: [...(primary.statusEffects || []), ...(secondary.statusEffects || [])],
      statusConditions: [...(primary.statusConditions || []), ...(secondary.statusConditions || [])],
      restoration: [...(primary.restoration || []), ...(secondary.restoration || [])]
    };
    return primary;
  }

  /**
   * Show a popup for non-AoE macros to choose which effects to trigger
   * @returns {Promise<string|null>} 'primary', 'secondary', 'both', or null if cancelled
   */
  async _showEffectChoicePopup(macro) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

      const dialog = new foundry.applications.api.DialogV2({
        window: { title: `${macro.name}` },
        content: '<p style="text-align:center;margin:0.5rem 0;">Which effects should trigger?</p>',
        buttons: [
          { action: 'primary', icon: 'fa-solid fa-swords', label: 'Primary', callback: () => done('primary') },
          { action: 'secondary', icon: 'fa-solid fa-wand-sparkles', label: 'Secondary', callback: () => done('secondary') },
          { action: 'both', icon: 'fa-solid fa-layer-group', label: 'Both', callback: () => done('both') }
        ],
        close: () => done(null)
      });
      dialog.render({ force: true });
    });
  }

  /**
   * Roll a single combat component (damage, buildup, or restoration)
   * Builds formula from dice config + flat + scaling
   * @param {Object} component - The combat component to roll
   * @param {string} componentType - 'damage', 'buildup', or 'restoration'
   * @param {Object} macro - The macro being executed (for scaling access)
   */
  async _rollCombatComponent(component, _componentType, macro) {
    const result = { ...component, total: 0, formula: '', roll: null };
    const parts = [];

    // Dice
    const count = parseInt(component.diceCount) || 0;
    // Bug 7: || falls through on parseInt(0). Preserve intentional zeros so
    // players can configure zero-sided dice deliberately.
    const parsedSides = parseInt(component.diceSides);
    const sides = Number.isFinite(parsedSides) ? parsedSides : 6;
    if (count > 0) {
      parts.push(`${count}d${sides}`);
    }

    // Flat bonus
    const flat = parseInt(component.flatBonus) || 0;
    if (flat !== 0) {
      parts.push(flat > 0 ? `${flat}` : `${flat}`);
    }

    // Weapon scaling bonus (players) - CF1: Per-damage-type scaling
    if (component.scalingSource === 'weapon') {
      const hand = component.weaponHand || 'mainHand';
      const damageType = (component.type || 'PHYSICAL').toUpperCase();

      // CF1/CF3: First try macro's own scalingBonusByType (handles trick weapon forms correctly)
      let wpnScaling = 0;
      if (macro?.scalingBonusByType && typeof macro.scalingBonusByType === 'object') {
        wpnScaling = macro.scalingBonusByType[damageType] ?? 0;
      } else {
        // Fall back to resolving from equipped weapon (backwards compatibility)
        wpnScaling = this._resolveWeaponScalingByType(hand, damageType);
      }

      if (wpnScaling !== 0) {
        parts.push(wpnScaling > 0 ? `${wpnScaling}` : `${wpnScaling}`);
        result.weaponScalingApplied = wpnScaling;
        result.weaponHandUsed = hand;
        result.scalingDamageType = damageType;
      }
    } else if (component.scalingSource === 'spell' || component.scalingSource === 'spirit') {
      // Spell/Spirit scaling - use macro's total scalingBonus (legacy)
      const scalingValue = macro?.scalingBonus || 0;
      if (scalingValue !== 0) {
        parts.push(`${scalingValue}`);
        result.spellScalingApplied = scalingValue;
      }
    } else if (component.scalingSource === 'manual' && component.manualScalingEntries?.length) {
      // Manual scaling with grade/stat/fraction entries
      const manualBonus = this._resolveManualScalingEntries(component.manualScalingEntries);
      if (manualBonus !== 0) {
        parts.push(`${manualBonus}`);
        result.manualScalingApplied = manualBonus;
        result.manualScalingEntries = component.manualScalingEntries;
      }
    } else if (component.scalingSource && component.scalingSource.includes(':')) {
      // Monster stat scaling (stat:strength, statMod:dexterity, etc.)
      // For unlinked tokens, use token.actor to get synthetic actor with delta data
      const token = canvas.tokens.get(this.tokenId);
      const actor = token?.actor || game.actors.get(this.actorId);
      if (actor?.type === 'npc') {
        const monsterScaling = this._resolveMonsterScaling(component.scalingSource, actor);
        if (monsterScaling !== 0) {
          parts.push(monsterScaling > 0 ? `${monsterScaling}` : `${monsterScaling}`);
          result.monsterScalingApplied = monsterScaling;
          result.monsterScalingSource = component.scalingSource;
        }
      }
    }

    if (parts.length === 0) return result;

    result.formula = parts.join(' + ').replace(/\+ -/g, '- ');
    const roll = new Roll(result.formula);
    await roll.evaluate();
    result.roll = roll;
    result.total = roll.total;
    result.rollHTML = await roll.render();
    // Bug 11: capture the per-die HTML as a plain string so it survives the
    // deepClone that happens when the deferred chat is rebuilt after the GM
    // rules on components. Without this, the after-ruling chat drops back to
    // formula + total only and hides per-die values.
    result.diceBreakdown = renderDiceBreakdown(roll);

    return result;
  }

  /**
   * Resolve DC bonus from a source (stat value, stat mod, skill, knowledge, weapon scaling)
   */
  _resolveDCBonus(source, token) {
    if (!source || source === 'none') return 0;
    if (source === 'weaponScaling') return this._resolveWeaponScaling('mainHand');

    const actor = token?.actor;
    if (!actor) return 0;

    const [type, name] = source.split(':');

    // Stats can be stored as flat numbers (e.g., stats.strength = 20) or as objects (stats.strength = { value: 20, mod: 5 })
    // Handle both formats like _resolveMonsterScaling does
    const statData = actor.system?.stats?.[name];

    // statValue: returns raw stat value (e.g., 20)
    if (type === 'statValue') {
      // If statData is an object with .value, use that; otherwise use statData directly as the value
      return (typeof statData === 'object' && statData !== null) ? (statData.value ?? 0) : (statData ?? 0);
    }
    // statMod: returns stat modifier calculated from stat value
    if (type === 'statMod') {
      // If statData has a precomputed .mod, use that
      if (typeof statData === 'object' && statData !== null && statData.mod !== undefined) {
        return statData.mod;
      }
      // Otherwise compute mod from the stat value: Math.floor((value - 10) / 2)
      const val = (typeof statData === 'object' && statData !== null) ? (statData.value ?? 10) : (statData ?? 10);
      return Math.floor((val - 10) / 2);
    }
    // stat: legacy support - returns mod (same as statMod)
    if (type === 'stat') {
      if (typeof statData === 'object' && statData !== null && statData.mod !== undefined) {
        return statData.mod;
      }
      const val = (typeof statData === 'object' && statData !== null) ? (statData.value ?? 10) : (statData ?? 10);
      return Math.floor((val - 10) / 2);
    }
    if (type === 'skill') {
      return actor.system?.skills?.[name] || 0;
    }
    if (type === 'knowledge') {
      return actor.system?.knowledge?.[name] || 0;
    }
    return 0;
  }

  /**
   * Resolve legacy scaling for old macros without combat config
   */
  _resolveLegacyScaling(macro) {
    let effectiveScaling = macro.scalingBonus || 0;
    const scalingLink = macro.scalingLink || 'none';
    if (scalingLink === 'mainHand' || scalingLink === 'offHand') {
      effectiveScaling = this._resolveWeaponScaling(scalingLink);
    }
    return effectiveScaling;
  }

  /**
   * Create a MeasuredTemplate for AOE macros with interactive placement
   * Two modes: originate from caster (self) or click-to-place on map
   * Supports range scaling via mouse wheel when rangeMin/rangeMax differ
   */
  async _createAOETemplate(macro, token) {
    const shapeMap = {
      circle: 'circle',
      // Bug 10: hex stays in code for backward compatibility with existing
      // hex-shape macros in the wild. New macros pick from the UI-visible
      // options only.
      hex: 'circle',
      cone: 'cone',
      line: 'ray',
      square: 'rect'
    };
    const t = shapeMap[macro.aoe?.shape];
    if (!t) return null;

    const originateSelf = macro.aoe.originateSelf ?? false;
    const requiresRotation = (t === 'cone' || t === 'ray');

    // Duration: -1 permanent, 0 removed end-of-turn, >0 tracked turns
    const duration = macro.aoePermanent ? -1 : (parseInt(macro.aoeDuration) || 0);
    debug(`[AOE Create] Creating template for "${macro.name}": aoePermanent=${macro.aoePermanent}, aoeDuration=${macro.aoeDuration}, calculated duration=${duration}`);

    // AOE size scaling: determine min/max from aoe.sizeMin/sizeMax
    const sizeMin = parseInt(macro.aoe.sizeMin) || 0;
    const sizeMax = parseInt(macro.aoe.sizeMax) || 0;
    let minSize, maxSize;
    if (sizeMin > 0 && sizeMax > 0) {
      minSize = Math.min(sizeMin, sizeMax);
      maxSize = Math.max(sizeMin, sizeMax);
    } else if (sizeMin > 0) {
      minSize = sizeMin;
      maxSize = sizeMin;
    } else if (sizeMax > 0) {
      minSize = sizeMax;
      maxSize = sizeMax;
    } else {
      minSize = 5;
      maxSize = 5;
    }
    const canScale = minSize !== maxSize;

    // Determine player visibility: player-owned tokens always visible, GM uses macro setting
    const isPlayerOwned = token.actor?.hasPlayerOwner || false;
    const playerVisibility = isPlayerOwned ? 'visible' : (macro.aoe?.playerVisibility || 'hidden');

    const templateData = {
      t,
      user: game.user.id,
      distance: minSize,
      direction: 0,
      fillColor: game.user.color || '#FF0000',
      flags: {
        'souls-d20': {
          duration,
          casterActorId: token.actor?.id,
          casterTokenId: token.id,
          // For duration 0: track whose turn it is NOW (for removal at end of current turn)
          // This handles reactions/opportunity attacks used outside your own turn
          turnCasterActorId: game.combat?.combatant?.actor?.id || token.actor?.id,
          createdRound: game.combat?.round || 0,
          macroName: macro.name,
          macroId: macro.id,
          exclusionRadius: parseInt(macro.aoe?.exclusionRadius) || 0,
          followsCaster: originateSelf && (macro.aoe?.followsCaster || false),
          playerVisibility,
          // Store combat data for AoE repeat execution
          macroData: {
            id: macro.id,
            name: macro.name,
            combat: macro.combat || null,
            secondaryCombat: macro.secondaryCombat || null,
            targeting: macro.targeting || null
          }
        }
      }
    };

    if (t === 'cone') templateData.angle = macro.aoe.coneAngle || 90;
    if (t === 'ray') templateData.width = macro.aoe.lineWidth || canvas.grid.distance;
    // Batch D: rect is now center-anchored via the new aoePlacement widget.
    // Distance is the half-extent from center in feet; width equals distance
    // so Foundry's built-in outline still renders roughly the right shape,
    // but the cell coverage math (aoeGridHighlight._getSquareCells) is what
    // actually determines targeting.
    if (t === 'rect') templateData.width = templateData.distance;

    if (playerVisibility === 'hidden' || playerVisibility === 'reactiveReveal') {
      templateData.hidden = true;
    }

    const scaleOpts = canScale ? { minSize, maxSize, step: canvas.grid.distance || 5 } : null;

    // Batch D: unified placement widget for every shape.
    // - originateSelf pins the origin at the caster (fixedOrigin option).
    // - Others start by asking the GM to click an origin.
    if (originateSelf) {
      return await placeAoETemplate(templateData, {
        scaleOpts,
        fixedOrigin: { x: token.center.x, y: token.center.y },
      });
    }
    return await placeAoETemplate(templateData, { scaleOpts });
  }


  /**
   * Execute a macro's custom JavaScript
   * Provides SD20 helper functions in the script context
   */
  async _executeCustomScript(macro, token, roll) {
    const actor = token.actor;
    const worldActor = actor?.id ? game.actors.get(actor.id) : null;
    const character = game.sd20?.characters?.[this.characterUUID];

    // Build sd20 helper object available to scripts
    const sd20 = {
      // Roll dice and return the Roll object
      roll: async (formula) => {
        const r = new Roll(formula);
        await r.evaluate();
        return r;
      },
      // Get the current token
      getToken: () => token,
      // Get the current actor (world actor)
      getCurrentActor: () => worldActor || actor,
      // Get linked SD20 character data
      getCharacter: () => character,
      // Get main hand weapon data
      getMainHandWeapon: () => character?.mainHand || null,
      // Get off-hand weapon data
      getOffHandWeapon: () => character?.offHand || null,
      // Send a message to chat
      sendToChat: async (content, options = {}) => {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ token: token.document }),
          content,
          ...options
        });
      },
      // Get the roll result from this macro execution (null if no dice)
      getRoll: () => roll,
      // Get the macro data
      getMacro: () => macro
    };

    try {
      const asyncFn = new Function('sd20', 'token', 'actor', 'character', 'roll', 'macro',
        `return (async () => { ${macro.customScript} })();`
      );
      await asyncFn(sd20, token, worldActor || actor, character, roll, macro);
    } catch (err) {
      console.error(`SD20 | Custom script error in "${macro.name}":`, err);
      ui.notifications.error(`Script error in "${macro.name}": ${err.message}`);
    }
  }

  /**
   * Render dice breakdown showing individual dice results with min/max highlighting
   * @param {Roll} roll - The Foundry Roll object
   * @returns {string} HTML string showing dice breakdown
   */
  _renderDiceBreakdown(roll) {
    return renderDiceBreakdown(roll);
  }

  /**
   * Build chat message HTML for macro execution
   * Enhanced version with combat component breakdown
   */
  _buildMacroChat(macro, combatResults) {
    let html = `<div class="sd20-macro-card">`;

    // Header
    html += `<div class="macro-card-header">`;
    html += `<i class="${macro.icon || 'fa-solid fa-star'}"></i>`;
    html += `<span class="macro-card-name">${macro.name}</span>`;
    html += `</div>`;

    if (macro.description) {
      if (macro.showDescriptionToPlayers === false) {
        html += `<div class="macro-card-description gm-only">${macro.description}</div>`;
      } else {
        html += `<div class="macro-card-description">${macro.description}</div>`;
      }
    }

    // Stats row (AP, FP, Range, AOE)
    html += `<div class="macro-card-stats">`;
    if (macro.apCost > 0) html += `<span class="stat ap">AP: ${macro.apCost}</span>`;
    if (macro.fpCost > 0) html += `<span class="stat fp">FP: ${macro.fpCost}</span>`;
    if (macro.range) html += `<span class="stat range">Range: ${macro.range}</span>`;
    if (macro.aoe?.shape && ((macro.aoe?.sizeMin > 0) || (macro.aoe?.sizeMax > 0))) {
      const shapeDisplay = macro.aoe.shape.charAt(0).toUpperCase() + macro.aoe.shape.slice(1);
      const aoeSize = macro.aoe.sizeMin === macro.aoe.sizeMax
        ? `${macro.aoe.sizeMin}ft`
        : `${macro.aoe.sizeMin}-${macro.aoe.sizeMax}ft`;
      html += `<span class="stat aoe">AOE: ${shapeDisplay} ${aoeSize}</span>`;
    }
    html += `</div>`;

    // Legacy roll (old macros without combat config)
    if (combatResults._legacyRoll) {
      const damageTypes = macro.dice?.map(d => d.type).filter(Boolean) || [];
      const uniqueTypes = [...new Set(damageTypes)];
      const diceBreakdown = this._renderDiceBreakdown(combatResults._legacyRoll);
      html += `<div class="macro-card-roll">`;
      html += `<span class="damage-dice-breakdown">${diceBreakdown}</span>`;
      html += `<span class="damage-total">= ${combatResults._legacyRoll.total}</span>`;
      if (uniqueTypes.length > 0) {
        html += `<div class="damage-types">`;
        for (const t of uniqueTypes) {
          html += `<span class="damage-type damage-${t.toLowerCase()}">${t}</span>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    // Damage rolls (red/harmful accent)
    if (combatResults.damageRolls?.length > 0) {
      html += `<div class="combat-section harmful">`;
      for (const dmg of combatResults.damageRolls) {
        const color = CONFIG.DAMAGE_TYPE_COLORS[dmg.type] || '#c0c0c0';
        html += `<div class="combat-component damage-row">`;
        html += `<span class="damage-type-label" style="color:${color}">${dmg.type || 'Physical'}</span>`;
        // Show dice breakdown with individual results
        const diceBreakdown = dmg.roll ? this._renderDiceBreakdown(dmg.roll) : (dmg.formula || '0');
        html += `<span class="damage-dice-breakdown">${diceBreakdown}</span>`;
        html += `<span class="damage-total">= ${dmg.total}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    // Status buildup + conditions (red/harmful accent)
    const hasBuildup = combatResults.buildupRolls?.length > 0;
    const hasConditions = combatResults.conditionRolls?.length > 0;
    if (hasBuildup || hasConditions) {
      html += `<div class="combat-section harmful">`;
      for (const eff of (combatResults.buildupRolls || [])) {
        html += `<div class="combat-component buildup-row">`;
        html += `<span class="buildup-label">${eff.name || 'Buildup'}</span>`;
        // Show dice breakdown with individual results
        const diceBreakdown = eff.roll ? this._renderDiceBreakdown(eff.roll) : (eff.formula || '0');
        html += `<span class="buildup-dice-breakdown">${diceBreakdown}</span>`;
        html += `<span class="buildup-total">= ${eff.total}</span>`;
        html += `</div>`;
      }
      for (const cond of (combatResults.conditionRolls || [])) {
        html += `<div class="combat-component condition-row">`;
        html += `<span class="condition-label">${cond.name}</span>`;
        if (cond.duration) html += `<span class="condition-duration">${cond.duration} rnd</span>`;
        if (cond.totalDC) {
          html += `<span class="condition-dc">DC ${cond.totalDC}</span>`;
          if (cond.saveType) {
            // Format saveType for display (e.g., "stat:vitality" -> "Vitality", "skill:Athletics" -> "Athletics")
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
    if (combatResults.restorationRolls?.length > 0) {
      html += `<div class="combat-section positive">`;
      for (const rest of combatResults.restorationRolls) {
        html += `<div class="combat-component restoration-row">`;
        const typeLabels = {
          'heal-hp': 'Heal HP', 'restore-fp': 'Restore FP', 'restore-ap': 'Restore AP',
          'reduce-buildup': `Reduce ${rest.statusEffect || 'Buildup'}`,
          'cure-condition': `Cure: ${(rest.conditions || []).join(', ') || 'None'}`,
          'cure-effect': `Cure: ${(rest.statusEffects || []).join(', ') || 'None'}`
        };
        html += `<span class="restoration-label">${typeLabels[rest.restorationType] || rest.restorationType}</span>`;
        if (rest.formula) {
          // Show dice breakdown with individual results
          const diceBreakdown = rest.roll ? this._renderDiceBreakdown(rest.roll) : rest.formula;
          html += `<span class="restoration-dice-breakdown">${diceBreakdown}</span>`;
          html += `<span class="restoration-total">= ${rest.total}</span>`;
        }
        if (rest.allowOverMax) html += `<span class="restoration-overmax">Over Max</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }

    // Simple roll (non-damage roll configured via Basic Info)
    if (combatResults._simpleRoll) {
      const isCheck = ['initiative', 'skillChecks', 'knowledgeChecks', 'statChecks'].includes(macro.macroCategory);
      const breakdownClass = isCheck ? 'check-dice-breakdown' : 'damage-dice-breakdown';
      const totalClass = isCheck ? 'check-total' : 'damage-total';
      const diceBreakdown = this._renderDiceBreakdown(combatResults._simpleRoll);
      html += `<div class="macro-card-roll simple-roll${isCheck ? ' check-roll' : ''}">`;
      html += `<span class="simple-roll-label">${isCheck ? 'Check' : 'Roll'}:</span>`;
      html += `<span class="${breakdownClass}">${diceBreakdown}</span>`;
      html += `<span class="${totalClass}">= ${combatResults._simpleRoll.total}</span>`;
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  /**
   * Open add macro dialog
   * @param {number|null} slot - Slot index (legacy, now ignored)
   * @param {string|null} categoryId - Category to add macro to
   */
  _openAddMacroDialog(slot = null, categoryId = null) {
    if (game.sd20?.openCustomMacroBuilder) {
      game.sd20.openCustomMacroBuilder(this, null, null, { defaultCategory: categoryId });
    } else {
      ui.notifications.warn('Custom macro builder not available');
    }
  }

  /**
   * Open edit macro dialog for any macro type
   */
  _openEditMacroDialog(macro) {
    if (game.sd20?.openCustomMacroBuilder) {
      // Find macro index for slot reference
      const setData = this.macroSets[this.activeSet];
      const macros = setData?.macros || [];
      const slotIndex = macros.findIndex(m => m && m.id === macro.id);
      game.sd20.openCustomMacroBuilder(this, slotIndex >= 0 ? slotIndex : null, macro);
    }
  }

  /**
   * Remove a macro by its ID from the current set
   */
  async _removeMacroById(macroId) {
    if (!macroId) {
      debug('Cannot remove macro: no ID provided');
      return;
    }

    const setData = this.macroSets[this.activeSet];
    if (!setData || !setData.macros) {
      debug('Cannot remove macro: active set not found');
      return;
    }

    const index = setData.macros.findIndex(m => m && m.id === macroId);

    if (index >= 0) {
      // Remove the macro from the array (splice instead of setting to null)
      setData.macros.splice(index, 1);
      debug(`Removed macro ${macroId} from set ${this.activeSet}`);

      await this.saveMacroSets();
      this._closeDropdown();
      this.render();
      ui.notifications.info('Macro removed');
    } else {
      debug(`Macro ${macroId} not found in set ${this.activeSet}`);
    }
  }

  /**
   * Open macro settings (All Macros Manager)
   */
  _openMacroSettings() {
    if (game.sd20?.openAllMacrosManager) {
      game.sd20.openAllMacrosManager();
    } else {
      ui.notifications.warn('All Macros Manager not available');
    }
  }

  /**
   * Add macro to the current set
   * With category system, slot is optional (macros are grouped by category)
   */
  async addMacroToSlot(slot, macro) {
    const setData = this.macroSets[this.activeSet];
    if (!setData) {
      debug('Cannot add macro: active set not found');
      return;
    }

    if (!setData.macros) {
      setData.macros = [];
    }

    // Bug 4: stamp per-entry id + _source before storing so re-link and
    // subsequent App deltas can line up rows correctly.
    const defaultSource = macro?.source === CONFIG.MACRO_SOURCES.APP ? 'app' : 'custom';
    normalizeMacroEntries(macro, defaultSource);

    if (slot !== null && slot !== undefined) {
      // Ensure array is long enough
      while (setData.macros.length <= slot) {
        setData.macros.push(null);
      }
      setData.macros[slot] = macro;
    } else {
      // Append to end of array
      setData.macros.push(macro);
    }

    await this.saveMacroSets();
    this.render();
  }

  /**
   * Remove macro from slot
   */
  async removeMacroFromSlot(slot) {
    const setData = this.macroSets[this.activeSet];
    if (setData?.macros?.[slot]) {
      setData.macros[slot] = null;
      await this.saveMacroSets();
      this.render();
    }
  }

  /**
   * Save macro sets to appropriate storage
   * Storage strategy:
   * - App-linked characters (has characterUUID): ACTOR (persists across tokens)
   * - Unlinked NPCs (no characterUUID, actorLink=false): TOKEN (each token independent)
   * - Linked tokens without App (no characterUUID, actorLink=true): ACTOR
   */
  async saveMacroSets() {
    if (this.isReadOnly) {
      debug('Cannot save macros - read-only mode (no actor ownership)');
      return;
    }

    // Snapshot the slot ids at entry. If they change while the actor.update
    // is in flight (e.g. an addMacroToSlot or refreshMacros wrote in parallel)
    // we re-run with the current state so the parallel write is not lost.
    const buildSnapshot = () => {
      const active = this.macroSets?.[this.activeSet];
      return (active?.macros || []).map(m => m?.id ?? null).join('|');
    };
    const enterSnapshot = buildSnapshot();

    const macroData = {
      activeSet: this.activeSet,
      sets: this.macroSets,
      setOrder: this.setOrder
    };

    const useActorStorage = this.characterUUID || !this.isUnlinked;

    if (useActorStorage) {
      const actor = game.actors.get(this.actorId);
      if (!actor) {
        debug('Cannot save macros - actor not found');
        return;
      }
      const current = actor.system?.macroSets ?? {};
      const diff = foundry.utils.diffObject(current, macroData);
      if (foundry.utils.isEmpty(diff)) {
        debug('saveMacroSets noop - actor state already matches, skipping write');
        return;
      }
      await actor.update({ 'system.macroSets': macroData });
      debug('Saved macroSets to ACTOR');
    } else {
      const token = canvas.tokens.get(this.tokenId);
      if (!token) {
        debug('Cannot save macros - token not found');
        return;
      }
      const tokenCurrent = token.document.getFlag(CONFIG.MODULE_ID, 'macroSets') ?? {};
      const tokenDiff = foundry.utils.diffObject(tokenCurrent, macroData);
      if (foundry.utils.isEmpty(tokenDiff)) {
        debug('saveMacroSets noop - token flag already matches, skipping write');
        return;
      }
      await token.document.setFlag(CONFIG.MODULE_ID, 'macroSets', macroData);
      debug('Saved macroSets to TOKEN document (unlinked NPC)');
    }

    if (buildSnapshot() !== enterSnapshot) {
      debug('saveMacroSets detected concurrent change, re-saving');
      return this.saveMacroSets();
    }
  }

  /**
   * Handle hotkey press - two-stage system
   * First press opens category dropdown, second press executes macro
   */
  async handleHotkey(key) {
    // Find category matching this hotkey
    const category = CONFIG.MACRO_CATEGORIES.find(c => c.hotkey === key);
    if (!category) return false;

    const categoryId = category.id;
    const macros = this.groupedMacros[categoryId] || [];

    // If dropdown is open for this category, execute macro at index
    if (this.openCategory === categoryId) {
      // Key '1' = index 0, '2' = index 1, etc.
      const macroIndex = parseInt(key) - 1;
      if (macroIndex >= 0 && macroIndex < macros.length) {
        await this._executeMacroFromDropdown(categoryId, macroIndex);
        return true;
      }
      // If no macro at that index, just close the dropdown
      this._closeDropdown();
      return true;
    }

    // If dropdown is open for a different category, check if this key
    // is meant to execute a macro in THAT dropdown
    if (this.openCategory !== null) {
      const openMacros = this.groupedMacros[this.openCategory] || [];
      const macroIndex = parseInt(key) - 1;
      if (macroIndex >= 0 && macroIndex < openMacros.length) {
        await this._executeMacroFromDropdown(this.openCategory, macroIndex);
        return true;
      }
    }

    // Otherwise, open this category's dropdown
    if (macros.length > 0) {
      const button = this.element?.querySelector(`.macro-category-btn[data-category="${categoryId}"]`);
      if (button) {
        this._showDropdown(button, categoryId, macros);
        return true;
      }
    }

    return false;
  }
}

// Global macro bar instance
let activeMacroBar = null;

/**
 * Show macro bar for selected token
 * Now shows for any owned token - displays "Link Character" if not linked
 */
export function showMacroBar(token) {
  if (!token) return;

  // controlToken fires false/true on every reselection of the same token.
  // Rebuilding the bar on each one was the visible source of the per-select
  // churn the player sees (cached render then background refresh). Same
  // token id stays put; data changes get picked up by the updateActor hook.
  if (activeMacroBar?.tokenId === token.id) {
    activeMacroBar.render();
    return;
  }

  closeMacroBar();

  activeMacroBar = new MacroBar(token.id);
  activeMacroBar.initialize().then(() => {
    if (activeMacroBar) {
      activeMacroBar.render(true);
    }
  });
}

/**
 * Close macro bar
 */
export function closeMacroBar() {
  if (activeMacroBar) {
    activeMacroBar.close();
    activeMacroBar = null;
  }
  // Also clean up any orphaned macro bar elements
  const orphaned = document.getElementById('sd20-macro-bar');
  if (orphaned) {
    orphaned.remove();
  }
}

/**
 * Get active macro bar
 */
export function getActiveMacroBar() {
  return activeMacroBar;
}

/**
 * Register macro bar keybindings (must be called during init hook)
 * 1-9 open category dropdowns or execute macros within open dropdown
 */
export function registerMacroBarKeybindings() {
  // Register keybindings for each category (1-9)
  const categoryNames = ['Main Hand', 'Off Hand', 'Sorcery', 'Hex', 'Miracle', 'Pyromancy', 'Spirits', 'Skills', 'Custom'];

  for (let i = 1; i <= 9; i++) {
    game.keybindings.register(CONFIG.MODULE_ID, `macroKey${i}`, {
      name: `Macro Key ${i} (${categoryNames[i - 1]})`,
      hint: `Open ${categoryNames[i - 1]} category or execute macro ${i} in open dropdown`,
      editable: [{ key: `Digit${i}` }],
      onDown: () => handleMacroHotkey(String(i)),
      restricted: false,
      precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
    });
  }

  // Tab to switch macro sets
  game.keybindings.register(CONFIG.MODULE_ID, 'cycleSet', {
    name: 'Cycle Macro Set',
    hint: 'Switch to next macro set',
    editable: [{ key: 'Tab' }],
    onDown: () => {
      if (activeMacroBar && activeMacroBar.setOrder.length > 0) {
        activeMacroBar._closeDropdown();
        const currentIndex = activeMacroBar.setOrder.indexOf(activeMacroBar.activeSet);
        const nextIndex = (currentIndex + 1) % activeMacroBar.setOrder.length;
        activeMacroBar.activeSet = activeMacroBar.setOrder[nextIndex];
        activeMacroBar.saveMacroSets();
        activeMacroBar.render();
        return true;
      }
      return false;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });

  // Escape to close dropdown
  game.keybindings.register(CONFIG.MODULE_ID, 'closeDropdown', {
    name: 'Close Macro Dropdown',
    hint: 'Close the open macro dropdown',
    editable: [{ key: 'Escape' }],
    onDown: () => {
      if (activeMacroBar && activeMacroBar.openCategory) {
        activeMacroBar._closeDropdown();
        return true;
      }
      return false;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });

  log('Macro bar keybindings registered');
}

/**
 * Check if a token is owned by the user and has an Actor
 * Now shows macro bar for any owned token (not just linked ones)
 */
function tokenIsOwnedWithActor(token) {
  // Get Actor from the token
  const actor = token.actor;
  if (!actor) return false;

  // Check if user owns the actor
  return actor.isOwner;
}

/**
 * Check if a token has SD20 character link (on Actor or Token for migration)
 */
function tokenHasCharacterLink(token) {
  const actorId = token.actor?.id;
  const actor = actorId ? game.actors.get(actorId) : null;

  const actorUUID = actor?.system?.characterUUID
    || actor?.getFlag(CONFIG.MODULE_ID, 'characterUUID');
  const tokenUUID = token.document.getFlag(CONFIG.MODULE_ID, 'characterUUID');

  return actorUUID || tokenUUID;
}

/**
 * Register macro bar hooks (called during ready hook)
 */
export function registerMacroBar() {
  // Check for already-controlled tokens on canvas ready (for page refresh with selected token)
  Hooks.on('canvasReady', () => {
    const showSD20Bar = game.settings.get(CONFIG.MODULE_ID, 'showSD20MacroBar');
    if (!showSD20Bar) return;

    // Find first owned controlled token
    const ownedToken = canvas.tokens.controlled.find(t => tokenIsOwnedWithActor(t));
    if (ownedToken) {
      debug('Canvas ready: showing macro bar for already-controlled token');
      showMacroBar(ownedToken);
    }
  });

  // Show macro bar when token is selected (if enabled)
  Hooks.on('controlToken', (token, controlled) => {
    // Check if SD20 macro bar is enabled
    const showSD20Bar = game.settings.get(CONFIG.MODULE_ID, 'showSD20MacroBar');
    if (!showSD20Bar) {
      closeMacroBar();
      return;
    }

    // Now shows macro bar for any owned token (not just linked ones)
    if (controlled && tokenIsOwnedWithActor(token)) {
      showMacroBar(token);
    } else if (!controlled) {
      // Check if any controlled token is owned with actor
      const ownedToken = canvas.tokens.controlled.find(t => tokenIsOwnedWithActor(t));
      if (ownedToken) {
        showMacroBar(ownedToken);
      } else {
        closeMacroBar();
      }
    }
  });

  // Watch for Actor flag changes (character link/unlink) to refresh macro bar
  Hooks.on('updateActor', (actor, changes, options, userId) => {
    if (!activeMacroBar) return;

    // Check if the updated actor matches the tracked macro bar actor
    if (actor.id !== activeMacroBar.actorId) return;

    // Check if characterUUID changed (system data or legacy flags)
    const systemCharChanged = changes?.system && ('characterUUID' in changes.system);
    const flagChanges = changes?.flags?.[CONFIG.MODULE_ID];
    const flagCharChanged = flagChanges && ('characterUUID' in flagChanges || '-=characterUUID' in flagChanges);

    if (systemCharChanged || flagCharChanged) {
      debug('Actor characterUUID changed, re-initializing macro bar');
      const token = canvas.tokens.get(activeMacroBar.tokenId);
      if (token) {
        showMacroBar(token);
      }
      return;
    }

    // Check if macroSets changed (e.g. from library copy or external update)
    // Skip if this client triggered the change (userId matches) to avoid overwriting in-memory data
    if (changes?.system && ('macroSets' in changes.system) && userId !== game.user.id) {
      debug('Actor macroSets changed externally, re-rendering macro bar');
      const freshActor = game.actors.get(actor.id);
      const savedData = freshActor?.system?.macroSets;
      if (savedData) {
        activeMacroBar.activeSet = savedData.activeSet || activeMacroBar.activeSet;
        activeMacroBar.macroSets = savedData.sets || activeMacroBar.macroSets;
        activeMacroBar.setOrder = savedData.setOrder || activeMacroBar.setOrder;
      }
      activeMacroBar.render();
    }
  });

  log('Macro bar hooks registered');
}

/**
 * Handle macro hotkey - two-stage system
 * First press opens category, second press executes macro in dropdown
 */
function handleMacroHotkey(key) {
  // Don't intercept hotkeys when typing in an input field
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
    return false;
  }

  if (activeMacroBar) {
    activeMacroBar.handleHotkey(key);
    return true;
  }
  return false;
}
