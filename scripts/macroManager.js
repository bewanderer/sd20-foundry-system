/**
 * Macro Manager
 * Handles fetching combat data from SD20 App and generating macros
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';
import { syncCombatDataToActor } from './characterSync.js';

// Catalyst weapon types - cannot perform light/heavy attacks on their own.
// If a weapon's types are ALL catalysts, no attack macros are generated.
// If it has at least one non-catalyst type (e.g. REAPER + STAFF), attacks are generated.
const CATALYST_TYPES = [
  'STAFF',
  'TALISMAN',
  'PYRO',
  'CRUCIBLE',
  'WIND_INSTRUMENT',
  'STRING_INSTRUMENT',
  'PERCUSSION_INSTRUMENT',
  'TONGUE_INSTRUMENT',
  'HORN_INSTRUMENT'
];

// Weapon types that cannot perform heavy attacks (but CAN light attack)
const NO_HEAVY_ATTACK_TYPES = [
  'GUN',
  'SHIELD'
];

// Weapon types with modified poise damage on heavy attacks
const POISE_MODIFIERS = {
  'WHIP': -1,                    // Whips deal 1 less poise
  'GREAT_BOW_BALLISTA': 'fixed', // Ballistas always deal 2 poise (handled specially)
  'ULTRA_GREAT_SWORD': 1,        // Colossal weapons deal 1 more poise
  'GREAT_AXE': 1,
  'GREAT_HAMMER': 1
};

// Map API spell categories to parent categories
const SPELL_CATEGORY_MAPPING = {
  'SOUL_CRYSTAL': 'SORCERY',
  'FROST': 'SORCERY',
  'ASSASSIN_LIGHT': 'SORCERY',
  'COSMIC': 'SORCERY',
  'DARK': 'HEX',
  'DEBUFF_HEX': 'HEX',
  'BLOOD': 'HEX',
  'DEATH': 'HEX',
  'DARKFROST_BLACKFIRE': 'HEX',
  'HEALING': 'MIRACLE',
  'LIGHTNING': 'MIRACLE',
  'BUFF_DEF_MIRACLE': 'MIRACLE',
  'FORCE': 'MIRACLE',
  'FIRE': 'PYROMANCY',
  'DRAGON': 'PYROMANCY',
  'PESTILENCE': 'PYROMANCY',
  'BUFF_DEBUFF_PYRO': 'PYROMANCY',
  'TIME': 'SPECIAL'
};

// Default icons by parent spell category
const SPELL_CATEGORY_ICONS = {
  'SORCERY': 'fa-solid fa-staff',
  'HEX': 'fa-solid fa-skull',
  'MIRACLE': 'fa-solid fa-sun',
  'PYROMANCY': 'fa-solid fa-fire',
  'SPECIAL': 'fa-solid fa-hourglass',
  // Fallback for unknown categories
  'default': 'fa-solid fa-wand-sparkles'
};

// Default icons by macro type
const MACRO_TYPE_ICONS = {
  'WEAPON_ATTACK': 'fa-solid fa-sword',
  'WEAPON_SKILL': 'fa-solid fa-hand',
  'SPELL': 'fa-solid fa-wand-sparkles',
  'SPIRIT': 'fa-brands fa-phoenix-framework',
  'CUSTOM': 'fa-solid fa-star'
};

// F2 Fix: Type categories for dice conversion
const DAMAGE_TYPE_SET = new Set(['PHYSICAL', 'MAGIC', 'FIRE', 'LIGHTNING', 'DARK', 'TRUE', 'DAMAGE_FP', 'DAMAGE_AP', 'FP', 'AP']);
const STATUS_BUILDUP_SET = new Set(['BLEED', 'POISON', 'TOXIC', 'FROST', 'CURSE', 'POISE']);
const RESTORATION_SET = new Set(['HEAL', 'RESTORE_FP', 'RESTORE_AP']);

// Stat abbreviation to full name mapping
const STAT_ABBREV_TO_FULL = {
  str: 'strength',
  dex: 'dexterity',
  vit: 'vitality',
  end: 'endurance',
  att: 'attunement',
  int: 'intelligence',
  fai: 'faith'
};

/**
 * Convert App scaling entries to manualScalingEntries format
 * @param {Array} scaling - App scaling array [{type, stat, grade/value}]
 * @param {string} damageType - The damage type to filter for
 * @param {Object} spellRequirements - Optional spell requirements for tier matching (catalyst scaling)
 * @returns {Array} manualScalingEntries array
 */
function mapScalingToManualEntries(scaling, damageType, spellRequirements = null) {
  if (!scaling || !Array.isArray(scaling)) return [];

  const normalizedType = (damageType || 'PHYSICAL').toUpperCase();

  // Check if this is tiered catalyst scaling (has 'requirement' field)
  const isTieredScaling = scaling.some(s => s.requirement !== undefined);

  if (isTieredScaling && spellRequirements) {
    // Catalyst-style tiered scaling: group by stat and find best tier for each
    return mapTieredScalingToManualEntries(scaling, spellRequirements, normalizedType);
  }

  // Simple scaling: just map entries directly
  const entries = [];
  const seenStats = new Set();

  for (const s of scaling) {
    // If scaling entry has a type, check if it matches the damage type
    // If no type is specified (common for catalyst/spell scaling), apply to all damage types
    const scalingType = s.type ? s.type.toUpperCase() : null;
    if (scalingType && scalingType !== normalizedType) continue;

    const statAbbrev = (s.stat || 'str').toLowerCase();
    const statFull = STAT_ABBREV_TO_FULL[statAbbrev] || statAbbrev;

    // Prevent duplicate stats in the same damage type's scaling entries
    if (seenStats.has(statFull)) continue;
    seenStats.add(statFull);

    // Ensure grade is uppercase to match CONFIG.SCALING_GRADES keys
    const rawGrade = s.grade || s.value || 'D';
    const grade = typeof rawGrade === 'string' ? rawGrade.toUpperCase() : String(rawGrade);

    entries.push({
      mode: 'graded',
      grade: grade,
      stat: statFull,
      fraction: 'full'
    });
  }

  return entries;
}

/**
 * Map tiered catalyst scaling to manualScalingEntries
 * Groups entries by stat and selects best tier based on spell requirements
 * @param {Array} scaling - Tiered scaling array [{stat, grade, requirement}]
 * @param {Object} spellRequirements - Spell requirements {int: 14, fai: 12, ...}
 * @param {string} normalizedType - Normalized damage type
 * @returns {Array} manualScalingEntries array
 */
function mapTieredScalingToManualEntries(scaling, spellRequirements, normalizedType) {
  const entries = [];

  // Group scaling entries by stat
  const scalingByStat = {};
  for (const entry of scaling) {
    // Filter by damage type if specified
    const scalingType = entry.type ? entry.type.toUpperCase() : null;
    if (scalingType && scalingType !== normalizedType) continue;

    const stat = (entry.stat || 'str').toUpperCase();
    if (!scalingByStat[stat]) scalingByStat[stat] = [];
    scalingByStat[stat].push(entry);
  }

  // For each stat, find the best tier the spell qualifies for
  for (const [stat, statEntries] of Object.entries(scalingByStat)) {
    const statLower = stat.toLowerCase();
    const spellReq = spellRequirements[statLower] || spellRequirements[stat] || 0;

    // If spell has 0 requirement for this stat, skip entirely
    if (spellReq === 0) continue;

    // Find highest tier where spellReq >= tierRequirement
    let bestEntry = null;
    for (const entry of statEntries) {
      const tierReq = entry.requirement || 0;
      if (spellReq >= tierReq) {
        if (!bestEntry || tierReq > (bestEntry.requirement || 0)) {
          bestEntry = entry;
        }
      }
    }

    if (bestEntry) {
      const statFull = STAT_ABBREV_TO_FULL[statLower] || statLower;
      const rawGrade = bestEntry.grade || bestEntry.value || 'D';
      const grade = typeof rawGrade === 'string' ? rawGrade.toUpperCase() : String(rawGrade);

      entries.push({
        mode: 'graded',
        grade: grade,
        stat: statFull,
        fraction: 'full'
      });
    }
  }

  return entries;
}

/**
 * F2 Fix: Convert legacy dice array to combat structure
 * Categorizes dice by type into damageTypes, statusEffects, or restoration
 * @param {Array} dice - Legacy dice array from App
 * @param {string} linkedSlot - The weapon slot (mainHand/offHand) for scaling source
 * @param {number} scalingBonus - Total scaling bonus for the weapon (legacy, kept for compat)
 * @param {string} sourceType - 'weapon', 'spell', or 'spirit' - determines scaling source
 * @param {Array} scaling - App scaling array [{type, stat, grade}] for manualScalingEntries
 * @param {Object} spellRequirements - Optional spell requirements for tier matching (catalyst scaling)
 * @returns {Object} { damageTypes: [], statusEffects: [], restoration: [] }
 */
function convertDiceToCombat(dice, linkedSlot = null, scalingBonus = 0, sourceType = null, scaling = null, spellRequirements = null) {
  const damageTypes = [];
  const statusEffects = [];
  const restoration = [];

  if (!dice || !Array.isArray(dice)) {
    return { damageTypes, statusEffects, restoration };
  }

  // Determine whether to use manual scaling (new) or weapon scaling (legacy)
  const useManualScaling = scaling && Array.isArray(scaling) && scaling.length > 0;
  let scalingSource = 'none';
  if (useManualScaling) {
    scalingSource = 'manual';
  } else if (linkedSlot) {
    scalingSource = 'weapon';
  } else if (sourceType === 'spell' || sourceType === 'spirit') {
    scalingSource = sourceType;
  }

  for (const d of dice) {
    const type = (d.type || 'PHYSICAL').toUpperCase();
    const diceCount = parseInt(d.count) || 0;
    // Bug 7: || would fall through when parseInt returns 0. Players are allowed
    // to configure 0d0, 0dX, or Xd0 rolls (flat-only, no dice, or explicit
    // zero-sided). Treat 0 as intentional.
    const parsedVal = parseInt(d.value);
    const parsedSides = parseInt(d.sides);
    const diceSides = Number.isFinite(parsedVal)
      ? parsedVal
      : (Number.isFinite(parsedSides) ? parsedSides : 6);

    if (DAMAGE_TYPE_SET.has(type)) {
      // This is a damage type - add to damageTypes
      const normalizedType = type === 'DAMAGE_FP' ? 'FP' : type === 'DAMAGE_AP' ? 'AP' : type;
      const damageEntry = {
        type: normalizedType,
        diceCount,
        diceSides,
        flatBonus: 0,
        scalingSource,
        weaponHand: linkedSlot || 'mainHand',
        manualScalingEntries: useManualScaling ? mapScalingToManualEntries(scaling, normalizedType, spellRequirements) : []
      };
      damageTypes.push(damageEntry);
    } else if (STATUS_BUILDUP_SET.has(type)) {
      // This is a status buildup - add to statusEffects
      // Status effects use 'name' not 'type'
      const statusName = type.charAt(0) + type.slice(1).toLowerCase(); // BLEED -> Bleed
      statusEffects.push({
        name: statusName,
        diceCount,
        diceSides,
        flatBonus: 0,
        manualScalingEntries: []
      });
    } else if (RESTORATION_SET.has(type)) {
      // This is restoration - add to restoration array
      let restoType;
      if (type === 'HEAL') restoType = 'heal-hp';
      else if (type === 'RESTORE_FP') restoType = 'restore-fp';
      else if (type === 'RESTORE_AP') restoType = 'restore-ap';
      else restoType = 'heal-hp';

      restoration.push({
        type: restoType,
        diceCount,
        diceSides,
        flatBonus: 0,
        scalingSource: 'none',
        manualScalingEntries: []
      });
    } else {
      // Unknown type - default to damage
      debug(`Unknown dice type "${type}", defaulting to PHYSICAL damage`);
      damageTypes.push({
        type: 'PHYSICAL',
        diceCount,
        diceSides,
        flatBonus: 0,
        scalingSource: useManualScaling ? 'manual' : (linkedSlot ? 'weapon' : 'none'),
        weaponHand: linkedSlot || 'mainHand',
        manualScalingEntries: useManualScaling ? mapScalingToManualEntries(scaling, 'PHYSICAL') : []
      });
    }
  }

  return { damageTypes, statusEffects, restoration };
}

/**
 * Macro Manager class
 * Fetches combat data from SD20 App and generates/caches macros
 */
// Item 4 (Batch C): dependency map from App-side field paths to Foundry macro
// categories. Used by invalidateCache to decide whether the whole cache entry
// gets dropped or only certain categories are marked for regeneration.
//
// Category values match CONFIG.MACRO_CATEGORIES ids (mainHand, offHand, spells,
// spirits, skills, initiative, skillChecks, knowledgeChecks, statChecks).
// Categories with the '*' suffix mean "all subcategories."
export const DELTA_REGEN_MAP = Object.freeze({
  'stats.*': ['mainHand', 'offHand', 'skillChecks', 'knowledgeChecks', 'statChecks'],
  'mainHand': ['mainHand', 'sorcery', 'hex', 'miracle', 'pyromancy'],
  'offHand': ['offHand', 'sorcery', 'hex', 'miracle', 'pyromancy'],
  'equipment.MainHand': ['mainHand', 'sorcery', 'hex', 'miracle', 'pyromancy'],
  'equipment.OffHand': ['offHand', 'sorcery', 'hex', 'miracle', 'pyromancy'],
  'weapon_modifications': ['mainHand', 'offHand'],
  'attuned_spells': ['sorcery', 'hex', 'miracle', 'pyromancy'],
  'attuned_spirits': ['spirits'],
  'attuned_weapon_skills': ['skills'],
  'combat_settings.twoHandingMainHand': ['mainHand'],
  'combat_settings.twoHandingOffHand': ['offHand'],
  'skills.*': ['skillChecks'],
  'knowledge.*': ['knowledgeChecks'],
  'level': [],
  'bonus_resistances': [],
  'bonus_statuses': [],
  'bonus_resistances_active': [],
});

const ALL_MACRO_CATEGORIES = new Set([
  'mainHand', 'offHand', 'sorcery', 'hex', 'miracle', 'pyromancy',
  'spirits', 'skills', 'abilities', 'initiative',
  'skillChecks', 'knowledgeChecks', 'statChecks', 'custom',
]);

function _resolveAffectedCategories(changedFields) {
  const affected = new Set();
  for (const field of (changedFields || [])) {
    // Exact match first.
    if (DELTA_REGEN_MAP[field]) {
      for (const cat of DELTA_REGEN_MAP[field]) affected.add(cat);
      continue;
    }
    // Root path with wildcard (stats.* covers stats.strength etc.)
    const root = field.split('.')[0];
    const wildcard = `${root}.*`;
    if (DELTA_REGEN_MAP[wildcard]) {
      for (const cat of DELTA_REGEN_MAP[wildcard]) affected.add(cat);
      continue;
    }
    // Not in map: caller treats this as "unknown field, safest to full-drop."
    return null;
  }
  return affected;
}

/**
 * Item 4 (Batch C): merge an incoming delta into the cached combatData so a
 * subsequent regeneration produces correct macros without another WS round
 * trip. Called by handleCharacterDelta after invalidateCache is scheduled.
 */
export function mergeDeltaIntoCache(uuid, delta) {
  const mgr = game.sd20?.macroManager;
  if (!mgr) return;
  const cached = mgr.macroCache?.get(uuid);
  if (!cached || !cached.combatData) return;
  for (const [key, value] of Object.entries(delta || {})) {
    if (key.includes('.')) {
      foundry.utils.setProperty(cached.combatData, key, value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      cached.combatData[key] = foundry.utils.mergeObject(
        cached.combatData[key] ?? {},
        value,
        { inplace: false }
      );
    } else {
      cached.combatData[key] = value;
    }
  }
}

export class MacroManager {
  constructor() {
    // uuid -> { macros, combatData, needsRegeneration, staleCategories, lastUpdate }
    this.macroCache = new Map();
    this.pendingRequests = new Map(); // uuid -> Promise
    this.requestTimeout = 30000;
  }

  /**
   * Item 4 (Batch C): granular invalidation.
   * - No changedFields: drop the whole cache entry. Next getMacros re-requests
   *   combat data via WS. Used by _processCharacterUpdate where we do not know
   *   which fields moved.
   * - With changedFields: consult DELTA_REGEN_MAP. If every field maps to a
   *   known category set, mark those categories stale. If any field is not in
   *   the map, fall through to full drop for safety.
   */
  invalidateCache(uuid, changedFields = null) {
    if (!uuid) return;
    if (!changedFields || changedFields.length === 0) {
      if (this.macroCache.delete(uuid)) {
        debug(`Item 4: dropped whole macro cache entry for ${uuid}`);
      }
      return;
    }
    const affected = _resolveAffectedCategories(changedFields);
    if (affected === null) {
      if (this.macroCache.delete(uuid)) {
        debug(`Item 4: unknown field in delta, dropped cache for ${uuid}`);
      }
      return;
    }
    if (affected.size === 0) {
      debug(`Item 4: delta touched only non-macro fields (${changedFields.join(', ')}), cache intact`);
      return;
    }
    const cached = this.macroCache.get(uuid);
    if (!cached) return;
    cached.needsRegeneration = true;
    cached.staleCategories = cached.staleCategories || new Set();
    for (const cat of affected) cached.staleCategories.add(cat);
    debug(`Item 4: marked stale categories for ${uuid}: ${Array.from(cached.staleCategories).join(', ')}`);
  }

  /**
   * Request combat data for a character from the SD20 App
   * @param {string} uuid - Character UUID
   * @param {string|null} actorId - Optional actor ID to scope the update
   * @returns {Promise<Object|null>} Combat data or null if failed
   */
  async requestCombatData(uuid, actorId = null) {
    if (!uuid) return null;

    // Use a unique key that includes actorId to prevent request reuse issues
    const requestKey = actorId ? `${uuid}:${actorId}` : uuid;

    // Check for existing pending request
    if (this.pendingRequests.has(requestKey)) {
      debug(`Reusing pending request for ${requestKey}`);
      return this.pendingRequests.get(requestKey);
    }

    const requestId = foundry.utils.randomID(8);

    const promise = new Promise((resolve) => {
      const bcm = game.sd20?.broadcastChannel;
      if (!bcm) {
        log('BroadcastChannel not available');
        resolve(null);
        return;
      }

      // Listen for response using bcm.on(). The handler unregisters itself
      // on first match so a duplicate response from a second App tab does
      // not double-resolve. characterSync has its own persistent handler.
      const handler = (data) => {
        if (data?.uuid === uuid && (!actorId || data?.actorId === actorId)) {
          clearTimeout(timeoutId);
          bcm.off(CONFIG.MESSAGE_TYPES.COMBAT_DATA_RESPONSE, handler);
          this.pendingRequests.delete(requestKey);
          debug(`Received combat data for ${uuid}${actorId ? ` (actor: ${actorId})` : ''} requestId=${requestId}`);
          resolve(data);
        }
      };

      const timeoutId = setTimeout(() => {
        debug(`Combat data request timed out for ${uuid} requestId=${requestId}`);
        bcm.off(CONFIG.MESSAGE_TYPES.COMBAT_DATA_RESPONSE, handler);
        this.pendingRequests.delete(requestKey);
        resolve(null);
      }, this.requestTimeout);

      bcm.on(CONFIG.MESSAGE_TYPES.COMBAT_DATA_RESPONSE, handler);

      bcm.send(CONFIG.MESSAGE_TYPES.COMBAT_DATA_REQUEST, { uuid, actorId, requestId });

      debug(`Requested combat data for ${uuid}${actorId ? ` (actor: ${actorId})` : ''} requestId=${requestId}`);
    });

    this.pendingRequests.set(requestKey, promise);
    return promise;
  }

  /**
   * Get macros for a character, fetching from App if needed
   * @param {string} uuid - Character UUID
   * @param {boolean} forceRefresh - Force refetch from App
   * @returns {Promise<Array>} Array of macro objects
   */
  async getMacros(uuid, forceRefresh = false, actor = null) {
    if (!uuid) return [];

    const cached = this.macroCache.get(uuid);

    // Item 3 (Batch C): invalidation-driven cache. Cache is fresh unless a
    // CHARACTER_UPDATE dropped it or a CHARACTER_DELTA_UPDATE marked it as
    // needsRegeneration. The 30s TTL + background-refresh dance is gone.
    if (cached && !forceRefresh && !cached.needsRegeneration) {
      debug(`Item 3: cache hit for ${uuid}, returning cached macros`);
      return cached.macros;
    }

    // Item 4 (Batch C): partial regeneration path. When we know combatData is
    // current (delta merged it in) but macros are stale, regenerate locally
    // without a WS round trip. This is the Bug 6 fast path.
    if (cached && !forceRefresh && cached.needsRegeneration && cached.combatData) {
      debug(`Item 4: regenerating macros for ${uuid} from cached combatData (no WS round trip)`);
      const macros = this.generateMacros(cached.combatData, actor);
      cached.macros = macros;
      cached.needsRegeneration = false;
      cached.staleCategories = new Set();
      cached.lastUpdate = Date.now();
      return macros;
    }

    // No cache OR forceRefresh: WS round trip to get fresh combat data.
    const combatData = await this.requestCombatData(uuid, actor?.id || null);
    if (!combatData) {
      return cached?.macros || [];
    }

    const macros = this.generateMacros(combatData, actor);

    this.macroCache.set(uuid, {
      macros,
      combatData,
      needsRegeneration: false,
      staleCategories: new Set(),
      lastUpdate: Date.now(),
    });

    if (actor) {
      syncCombatDataToActor(actor, combatData).catch(err => {
        debug('Failed to sync combat data to actor flags:', err);
      });
    }

    return macros;
  }

  /**
   * Generate macro objects from combat data and actor system data
   * @param {Object} combatData - Combat data from SD20 App
   * @param {Actor|null} actor - Foundry actor for skills/knowledge/stats
   * @returns {Array} Array of macro objects
   */
  generateMacros(combatData, actor = null) {
    const macros = [];
    const stats = combatData.stats || {};

    // Bug 2 diagnostic: surface what payload the App actually sent so a
    // "macros missing" symptom can be told apart from "App did not send".
    debug(`generateMacros: payload summary uuid=${combatData.uuid} ` +
          `mainHand=${combatData.mainHand ? combatData.mainHand.name || 'yes' : 'null'} ` +
          `offHand=${combatData.offHand ? combatData.offHand.name || 'yes' : 'null'} ` +
          `attunedSpells=${combatData.attunedSpells?.length ?? 0} ` +
          `attunedSpirits=${combatData.attunedSpirits?.length ?? 0} ` +
          `attunedWeaponSkills=${combatData.attunedWeaponSkills?.length ?? 0} ` +
          `catalysts=${combatData.catalysts?.length ?? 0}`);

    // Generate weapon macros - mainHand is now the weapon data directly
    // CF3: For trick weapons, generate macros for EACH form
    if (combatData.mainHand) {
      const weaponMacros = this.generateWeaponMacrosForAllForms(
        combatData.mainHand,
        stats,
        'mainHand',
        combatData.combatSettings?.twoHandingMainHand
      );
      macros.push(...weaponMacros);
    }

    // Always generate off-hand macros if weapon equipped
    // CF3: For trick weapons, generate macros for EACH form
    if (combatData.offHand) {
      const offHandMacros = this.generateWeaponMacrosForAllForms(
        combatData.offHand,
        stats,
        'offHand',
        combatData.combatSettings?.twoHandingOffHand
      );
      macros.push(...offHandMacros);
    }

    // Generators return null for unhydrated stub entries; collect-and-filter
    // so a single broken spell does not produce an "undefined" macro on the bar.
    const pushIfDefined = (macro) => { if (macro) macros.push(macro); };

    // CF2: Generate spell macros - one per spell × catalyst combination
    const catalysts = combatData.catalysts || [];
    if (combatData.attunedSpells?.length > 0) {
      for (const spell of combatData.attunedSpells) {
        if (catalysts.length > 0) {
          // Generate a spell macro for EACH catalyst
          for (const catalyst of catalysts) {
            pushIfDefined(this.generateSpellMacroForCatalyst(spell, stats, catalyst));
          }
        } else {
          // Backwards compatibility: no catalysts, use pre-calculated scaling
          pushIfDefined(this.generateSpellMacro(spell, stats));
        }
        // Note: Charged variants are NOT auto-generated per CF2 decision
      }
    }

    // CF2: Generate spirit macros - one per spirit × catalyst combination
    if (combatData.attunedSpirits?.length > 0) {
      for (const spirit of combatData.attunedSpirits) {
        if (catalysts.length > 0) {
          // Generate a spirit macro for EACH catalyst
          for (const catalyst of catalysts) {
            pushIfDefined(this.generateSpiritMacroForCatalyst(spirit, stats, catalyst));
          }
        } else {
          // Backwards compatibility: no catalysts, use pre-calculated scaling
          pushIfDefined(this.generateSpiritMacro(spirit, stats));
        }
      }
    }

    // Generate weapon skill macros
    if (combatData.attunedWeaponSkills?.length > 0) {
      for (const skill of combatData.attunedWeaponSkills) {
        pushIfDefined(this.generateWeaponSkillMacro(skill, stats));
      }
    }

    // Generate initiative, skill check, knowledge check, and stat check macros
    // These use combat data from the app (statMods, skills, knowledge)
    const statMods = combatData.statMods || {};
    const appSkills = combatData.skills || {};
    const appKnowledge = combatData.knowledge || {};

    // Initiative: 1d20 + dexterity mod (from app)
    const dexMod = statMods.dexterity ?? Math.floor(((stats.dexterity || 10) - 10) / 2);
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
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: 'initiative',
      linkedSlot: null,
      macroCategory: 'initiative',
      macroSet: 1
    });

    // Skill Checks: 1d20 + skill modifier (from app)
    const SKILL_ICONS = {
      Athletics: 'fa-solid fa-dumbbell',
      Acrobatics: 'fa-solid fa-person-running',
      Perception: 'fa-solid fa-eye',
      FireKeeping: 'fa-solid fa-campfire',
      Sanity: 'fa-solid fa-brain',
      Stealth: 'fa-solid fa-mask',
      Precision: 'fa-solid fa-crosshairs',
      Diplomacy: 'fa-solid fa-handshake'
    };
    for (const [skillName, skillMod] of Object.entries(appSkills)) {
      const mod = parseInt(skillMod) || 0;
      macros.push({
        id: `check-skill-${skillName.toLowerCase()}`,
        type: CONFIG.MACRO_TYPES.SKILL_CHECK,
        name: skillName,
        description: `1d20 ${mod >= 0 ? '+' : '−'} ${Math.abs(mod)}`,
        icon: SKILL_ICONS[skillName] || 'fa-solid fa-dice-d20',
        apCost: 0,
        fpCost: 0,
        dice: [{ count: 1, sides: 20, value: 20, type: null }],
        scalingBonus: mod,
        source: CONFIG.MACRO_SOURCES.APP,
        sourceId: `skill-${skillName.toLowerCase()}`,
        linkedSlot: null,
        macroCategory: 'skillChecks',
        macroSet: 1
      });
    }

    // Knowledge Checks: 1d20 + knowledge modifier (from app)
    const KNOWLEDGE_ICONS = {
      Magics: 'fa-solid fa-hat-wizard',
      WorldHistory: 'fa-solid fa-globe',
      Monsters: 'fa-solid fa-dragon',
      Cosmic: 'fa-solid fa-stars'
    };
    for (const [knowledgeName, knowledgeMod] of Object.entries(appKnowledge)) {
      const mod = parseInt(knowledgeMod) || 0;
      const displayName = knowledgeName === 'WorldHistory' ? 'World History' : knowledgeName;
      macros.push({
        id: `check-knowledge-${knowledgeName.toLowerCase()}`,
        type: CONFIG.MACRO_TYPES.SKILL_CHECK,
        name: displayName,
        description: `1d20 ${mod >= 0 ? '+' : '−'} ${Math.abs(mod)}`,
        icon: KNOWLEDGE_ICONS[knowledgeName] || 'fa-solid fa-book-open',
        apCost: 0,
        fpCost: 0,
        dice: [{ count: 1, sides: 20, value: 20, type: null }],
        scalingBonus: mod,
        source: CONFIG.MACRO_SOURCES.APP,
        sourceId: `knowledge-${knowledgeName.toLowerCase()}`,
        linkedSlot: null,
        macroCategory: 'knowledgeChecks',
        macroSet: 1
      });
    }

    // Stat Checks: 1d20 + stat modifier (from app, not calculated)
    const STAT_ICONS = {
      vitality: 'fa-solid fa-heart',
      endurance: 'fa-solid fa-shield-heart',
      strength: 'fa-solid fa-hand-fist',
      dexterity: 'fa-solid fa-feather',
      attunement: 'fa-solid fa-wand-sparkles',
      intelligence: 'fa-solid fa-lightbulb',
      faith: 'fa-solid fa-sun'
    };
    for (const [statName, statValue] of Object.entries(stats)) {
      const mod = statMods[statName] ?? Math.floor(((parseInt(statValue) || 10) - 10) / 2);
      const displayName = statName.charAt(0).toUpperCase() + statName.slice(1);
      macros.push({
        id: `check-stat-${statName}`,
        type: CONFIG.MACRO_TYPES.SKILL_CHECK,
        name: displayName,
        description: `1d20 ${mod >= 0 ? '+' : '−'} ${Math.abs(mod)}`,
        icon: STAT_ICONS[statName] || 'fa-solid fa-dice-d20',
        apCost: 0,
        fpCost: 0,
        dice: [{ count: 1, sides: 20, value: 20, type: null }],
        scalingBonus: mod,
        source: CONFIG.MACRO_SOURCES.APP,
        sourceId: `stat-${statName}`,
        linkedSlot: null,
        macroCategory: 'statChecks',
        macroSet: 1
      });
    }

    // Bug 2 diagnostic: per-category count of what we generated for the bar.
    const categoryCount = {};
    for (const m of macros) {
      const cat = m?.macroCategory || 'uncategorized';
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    }
    debug(`generateMacros: produced ${macros.length} macros, by-category=${JSON.stringify(categoryCount)}`);

    return macros;
  }

  /**
   * Generate macros for a weapon (light attack, heavy attack, skills)
   */
  /**
   * CF3: Generate weapon macros for all forms (trick weapon support)
   * For non-trick weapons, delegates to generateWeaponMacros
   * For trick weapons, generates separate macros for each form
   */
  generateWeaponMacrosForAllForms(weapon, stats, slot, twoHanding) {
    if (!weapon) return [];

    // Check if this is a trick weapon with forms data
    if (weapon.is_trick && weapon.forms) {
      const macros = [];

      // Generate macros for primary form
      if (weapon.forms.primary) {
        const primaryMacros = this.generateWeaponMacrosForForm(
          weapon,
          weapon.forms.primary,
          'primary',
          stats,
          slot,
          twoHanding
        );
        macros.push(...primaryMacros);
      }

      // Generate macros for secondary form
      if (weapon.forms.secondary) {
        const secondaryMacros = this.generateWeaponMacrosForForm(
          weapon,
          weapon.forms.secondary,
          'secondary',
          stats,
          slot,
          twoHanding
        );
        macros.push(...secondaryMacros);
      }

      return macros;
    }

    // Non-trick weapon: use standard generation
    return this.generateWeaponMacros(weapon, stats, slot, twoHanding);
  }

  /**
   * CF3: Generate weapon macros for a specific form of a trick weapon
   */
  generateWeaponMacrosForForm(weapon, formData, formType, stats, slot, twoHanding) {
    const macros = [];
    const weaponType = formData.type || weapon.weapon_type || '';

    // Format form type for display (e.g., "REAPER" -> "Reaper")
    const formLabel = weaponType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Check if this form is catalyst-only (no attack macros)
    const isCatalystOnly = CATALYST_TYPES.includes(weaponType);

    if (isCatalystOnly) {
      debug(`Skipping attack macros for catalyst form: ${weapon.name} [${formLabel}]`);
      return macros;
    }

    // CF1: Calculate per-type scaling bonuses for this form's scaling
    const scalingBonusByType = this.calculateScalingBonusByType(formData.scaling || [], stats, twoHanding);
    const scalingBonus = Object.values(scalingBonusByType).reduce((sum, b) => sum + b, 0);
    const lightApCost = parseInt(formData.ap) || parseInt(weapon.ap) || 2;

    // F2 Fix: Convert legacy dice to combat structure
    // Pass form scaling to map to manualScalingEntries
    const formScaling = formData.scaling || [];
    const lightCombat = convertDiceToCombat(formData.dice || [], slot, scalingBonus, null, formScaling);

    // Light Attack
    macros.push({
      id: `${slot}-${formType}-light-${weapon.id}`,
      type: CONFIG.MACRO_TYPES.WEAPON_ATTACK,
      name: `${weapon.name} [${formLabel}] (Light)`,
      description: `Light attack with ${weapon.name} in ${formLabel} form`,
      icon: 'fa-solid fa-sword',
      apCost: lightApCost,
      fpCost: 0,
      dice: formData.dice || [],
      combat: lightCombat, // F2 Fix: Proper combat structure
      scalingBonus,
      scalingBonusByType,
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: weapon.id,
      linkedSlot: slot,
      attackType: 'light',
      weaponType,
      weaponForm: formType, // CF3: Track which form this macro is for
      customData: null,
      hotkey: null,
      macroSet: 1
    });

    // Heavy Attack - not for guns/shields
    const canHeavy = !NO_HEAVY_ATTACK_TYPES.includes(weaponType);
    if (canHeavy) {
      // Calculate poise damage based on weapon type
      let poiseDamage = lightApCost;
      if (weaponType === 'GREAT_BOW_BALLISTA') {
        poiseDamage = 2;
      } else if (POISE_MODIFIERS[weaponType]) {
        poiseDamage += POISE_MODIFIERS[weaponType];
      }

      // F2 Fix: Convert heavy dice to combat structure
      const heavyDice = this.modifyDiceForHeavy(formData.dice || []);
      const heavyCombat = convertDiceToCombat(heavyDice, slot, scalingBonus, null, formScaling);

      macros.push({
        id: `${slot}-${formType}-heavy-${weapon.id}`,
        type: CONFIG.MACRO_TYPES.WEAPON_ATTACK,
        name: `${weapon.name} [${formLabel}] (Heavy)`,
        description: `Heavy attack with ${weapon.name} in ${formLabel} form`,
        icon: 'fa-solid fa-axe-battle',
        apCost: lightApCost + 1,
        fpCost: 0,
        dice: heavyDice,
        combat: heavyCombat, // F2 Fix: Proper combat structure
        scalingBonus,
        scalingBonusByType,
        poiseDamage,
        source: CONFIG.MACRO_SOURCES.APP,
        sourceId: weapon.id,
        linkedSlot: slot,
        attackType: 'heavy',
        weaponType,
        weaponForm: formType, // CF3: Track which form this macro is for
        customData: null,
        hotkey: null,
        macroSet: 1
      });
    }

    return macros;
  }

  generateWeaponMacros(weapon, stats, slot, twoHanding) {
    const macros = [];
    // CF1: Calculate per-type scaling bonuses
    const scalingBonusByType = weapon.scalingBonusByType !== undefined
      ? weapon.scalingBonusByType
      : this.calculateScalingBonusByType(weapon.scaling, stats, twoHanding);
    // Keep total for backwards compatibility
    const scalingBonus = weapon.scalingBonus !== undefined
      ? weapon.scalingBonus
      : Object.values(scalingBonusByType).reduce((sum, b) => sum + b, 0);
    const weaponType = weapon.weapon_type || '';
    const secondType = weapon.second_type || null;
    const lightApCost = parseInt(weapon.ap) || 2;

    // Check if weapon is catalyst-only (all types are catalysts = no attack macros)
    const isCatalystOnly = CATALYST_TYPES.includes(weaponType)
      && (!secondType || CATALYST_TYPES.includes(secondType));

    if (isCatalystOnly) {
      debug(`Skipping attack macros for catalyst-only weapon: ${weapon.name} (${weaponType}${secondType ? '/' + secondType : ''})`);
      return macros;
    }

    // F2 Fix: Convert legacy dice to combat structure
    // Pass weapon.scaling to map to manualScalingEntries for runtime resolution
    const lightCombat = convertDiceToCombat(weapon.dice, slot, scalingBonus, null, weapon.scaling);

    // Light Attack
    macros.push({
      id: `${slot}-light-${weapon.id}`,
      type: CONFIG.MACRO_TYPES.WEAPON_ATTACK,
      name: `${weapon.name} (Light)`,
      description: `Light attack with ${weapon.name}`,
      icon: 'fa-solid fa-sword',
      apCost: lightApCost,
      fpCost: 0,
      dice: weapon.dice || [],
      combat: lightCombat, // F2 Fix: Proper combat structure
      scalingBonus,
      scalingBonusByType, // CF1: Per-damage-type scaling (kept for backwards compat)
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: weapon.id,
      linkedSlot: slot,
      attackType: 'light',
      weaponType,
      customData: null,
      hotkey: null,
      macroSet: 1
    });

    // Heavy Attack - not for guns/shields, and not for catalyst types
    const allTypes = [weaponType, secondType].filter(Boolean);
    const canHeavy = !allTypes.some(t => NO_HEAVY_ATTACK_TYPES.includes(t))
      && !allTypes.every(t => CATALYST_TYPES.includes(t));
    if (canHeavy) {
      // Calculate poise damage based on weapon type
      let poiseDamage = lightApCost; // Default: poise = light AP cost
      if (weaponType === 'GREAT_BOW_BALLISTA') {
        poiseDamage = 2; // Ballistas always deal 2 poise
      } else if (POISE_MODIFIERS[weaponType]) {
        poiseDamage += POISE_MODIFIERS[weaponType];
      }

      // F2 Fix: Convert heavy dice to combat structure
      const heavyDice = this.modifyDiceForHeavy(weapon.dice);
      const heavyCombat = convertDiceToCombat(heavyDice, slot, scalingBonus, null, weapon.scaling);

      macros.push({
        id: `${slot}-heavy-${weapon.id}`,
        type: CONFIG.MACRO_TYPES.WEAPON_ATTACK,
        name: `${weapon.name} (Heavy)`,
        description: `Heavy attack with ${weapon.name}`,
        icon: 'fa-solid fa-axe-battle',
        apCost: lightApCost + 1, // Heavy costs 1 more AP
        fpCost: 0,
        dice: heavyDice,
        combat: heavyCombat, // F2 Fix: Proper combat structure
        scalingBonus, // Same scaling as light attack (kept for backwards compat)
        scalingBonusByType, // CF1: Per-damage-type scaling (kept for backwards compat)
        poiseDamage,
        source: CONFIG.MACRO_SOURCES.APP,
        sourceId: weapon.id,
        linkedSlot: slot,
        attackType: 'heavy',
        weaponType,
        customData: null,
        hotkey: null,
        macroSet: 1
      });
    }

    // Weapon skills are currently skipped (not pulling from API URLs)
    // TODO: Add weapon skills when App sends full skill objects

    return macros;
  }

  /**
   * Generate a spell macro
   */
  generateSpellMacro(spell, stats, isCharged = false) {
    if (!spell || spell.name === undefined) {
      debug('Skipping spell macro: missing name', spell?.id);
      return null;
    }
    // Use pre-calculated scalingBonus from App if available, otherwise calculate locally
    const scalingBonus = spell.scalingBonus !== undefined
      ? spell.scalingBonus
      : this.calculateScalingBonus(spell.spell_scaling, stats, false);
    const prefix = isCharged ? 'Charged: ' : '';

    // Get icon based on spell category - map API category to parent category first
    const apiCategory = spell.category?.toUpperCase() || '';
    const parentCategory = SPELL_CATEGORY_MAPPING[apiCategory] || apiCategory || 'default';
    const icon = SPELL_CATEGORY_ICONS[parentCategory] || SPELL_CATEGORY_ICONS['default'];
    debug(`Spell ${spell.name}: apiCategory=${apiCategory}, parentCategory=${parentCategory}, icon=${icon}`);

    // F2 Fix: Convert legacy dice to combat structure (no linkedSlot for spells)
    // Pass spell_scaling to map to manualScalingEntries
    const spellCombat = convertDiceToCombat(spell.dice, null, scalingBonus, 'spell', spell.spell_scaling);

    return {
      id: `spell-${spell.id}${isCharged ? '-charged' : ''}`,
      type: CONFIG.MACRO_TYPES.SPELL,
      name: `${prefix}${spell.name}`,
      description: spell.description || '',
      icon,
      category: parentCategory,
      apCost: spell.ap || 0,
      fpCost: spell.fp || 0,
      dice: spell.dice || [],
      combat: spellCombat, // F2 Fix: Proper combat structure
      scalingBonus, // Kept for backwards compatibility
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: spell.id,
      linkedSlot: null,
      range: spell.range || '',
      duration: spell.duration || '',
      customData: null,
      hotkey: null,
      macroSet: 1
    };
  }

  /**
   * Generate a spirit summoning macro
   */
  generateSpiritMacro(spirit, stats) {
    if (!spirit || spirit.name === undefined) {
      debug('Skipping spirit macro: missing name', spirit?.id);
      return null;
    }
    // Use pre-calculated scalingBonus from App if available, otherwise calculate locally
    const scalingBonus = spirit.scalingBonus !== undefined
      ? spirit.scalingBonus
      : this.calculateScalingBonus(spirit.spell_scaling, stats, false);

    // F2 Fix: Convert legacy dice to combat structure (no linkedSlot for spirits)
    // Pass spell_scaling to map to manualScalingEntries
    const spiritCombat = convertDiceToCombat(spirit.dice, null, scalingBonus, 'spirit', spirit.spell_scaling);

    return {
      id: `spirit-${spirit.id}`,
      type: CONFIG.MACRO_TYPES.SPIRIT,
      name: `Summon: ${spirit.name}`,
      description: spirit.description || '',
      icon: 'fa-brands fa-phoenix-framework',
      apCost: spirit.ap || 0,
      fpCost: spirit.fp || 0,
      maintenanceCost: spirit.cost || 0,
      dice: spirit.dice || [],
      combat: spiritCombat, // F2 Fix: Proper combat structure
      scalingBonus, // Kept for backwards compatibility
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: spirit.id,
      linkedSlot: null,
      tier: spirit.tier,
      size: spirit.size,
      range: spirit.range || '',
      customData: null,
      hotkey: null,
      macroSet: 1
    };
  }

  /**
   * CF2: Generate a spell macro for a specific catalyst
   * Creates unique macro with catalyst-specific scaling
   * @param {Object} spell - The spell data
   * @param {Object} stats - Character stats
   * @param {Object} catalyst - The catalyst weapon with spell_scaling
   */
  generateSpellMacroForCatalyst(spell, stats, catalyst) {
    if (!spell || spell.name === undefined) {
      debug('Skipping catalyst spell macro: missing name', spell?.id);
      return null;
    }
    // Calculate scaling using THIS catalyst's spell_scaling
    const scalingBonus = this.calculateSpellScalingForCatalyst(spell, catalyst, stats);
    const catalystName = catalyst.displayName || catalyst.name || 'Catalyst';

    // Get icon based on spell category
    const apiCategory = spell.category?.toUpperCase() || '';
    const parentCategory = SPELL_CATEGORY_MAPPING[apiCategory] || apiCategory || 'default';
    const icon = SPELL_CATEGORY_ICONS[parentCategory] || SPELL_CATEGORY_ICONS['default'];

    // F2 Fix: Convert legacy dice to combat structure (no linkedSlot for spells)
    // Use catalyst's spell_scaling for manualScalingEntries, pass spell requirements for tier matching
    const spellCombat = convertDiceToCombat(spell.dice, null, scalingBonus, 'spell', catalyst.spell_scaling, spell.requirements);

    return {
      id: `spell-${spell.id}-${catalyst.id}`,
      type: CONFIG.MACRO_TYPES.SPELL,
      name: `[${catalystName}]: ${spell.name}`,
      description: spell.description || '',
      icon,
      category: parentCategory,
      apCost: spell.ap || 0,
      fpCost: spell.fp || 0,
      dice: spell.dice || [],
      combat: spellCombat, // F2 Fix: Proper combat structure
      scalingBonus, // Kept for backwards compatibility
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: spell.id,
      catalystId: catalyst.id,
      catalystSlot: catalyst.slot,
      linkedSlot: null,
      range: spell.range || '',
      duration: spell.duration || '',
      customData: null,
      hotkey: null,
      macroSet: 1
    };
  }

  /**
   * CF2: Generate a spirit macro for a specific catalyst
   * Creates unique macro with catalyst-specific scaling
   * @param {Object} spirit - The spirit data
   * @param {Object} stats - Character stats
   * @param {Object} catalyst - The catalyst weapon with spell_scaling
   */
  generateSpiritMacroForCatalyst(spirit, stats, catalyst) {
    if (!spirit || spirit.name === undefined) {
      debug('Skipping catalyst spirit macro: missing name', spirit?.id);
      return null;
    }
    // Calculate scaling using THIS catalyst's spell_scaling
    const scalingBonus = this.calculateSpellScalingForCatalyst(spirit, catalyst, stats);
    const catalystName = catalyst.displayName || catalyst.name || 'Catalyst';

    // F2 Fix: Convert legacy dice to combat structure (no linkedSlot for spirits)
    // Use catalyst's spell_scaling for manualScalingEntries, pass spirit requirements for tier matching
    const spiritCombat = convertDiceToCombat(spirit.dice, null, scalingBonus, 'spirit', catalyst.spell_scaling, spirit.requirements);

    return {
      id: `spirit-${spirit.id}-${catalyst.id}`,
      type: CONFIG.MACRO_TYPES.SPIRIT,
      name: `[${catalystName}]: Summon ${spirit.name}`,
      description: spirit.description || '',
      icon: 'fa-brands fa-phoenix-framework',
      apCost: spirit.ap || 0,
      fpCost: spirit.fp || 0,
      maintenanceCost: spirit.cost || 0,
      dice: spirit.dice || [],
      combat: spiritCombat, // F2 Fix: Proper combat structure
      scalingBonus, // Kept for backwards compatibility
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: spirit.id,
      catalystId: catalyst.id,
      catalystSlot: catalyst.slot,
      linkedSlot: null,
      tier: spirit.tier,
      size: spirit.size,
      range: spirit.range || '',
      customData: null,
      hotkey: null,
      macroSet: 1
    };
  }

  /**
   * CF2: Calculate spell scaling for a specific catalyst
   * Uses the catalyst's spell_scaling tiers based on the spell's requirements
   * @param {Object} spellOrSpirit - The spell or spirit with requirements
   * @param {Object} catalyst - The catalyst with spell_scaling
   * @param {Object} stats - Character stats (uses full names: strength, intelligence, etc.)
   * @returns {number} Total scaling bonus
   */
  calculateSpellScalingForCatalyst(spellOrSpirit, catalyst, stats) {
    if (!catalyst?.spell_scaling || !Array.isArray(catalyst.spell_scaling)) return 0;

    // Map stat abbreviations to full stat names (App sends full names in stats object)
    const STAT_ABBREV_TO_FULL = {
      str: 'strength',
      dex: 'dexterity',
      vit: 'vitality',
      end: 'endurance',
      att: 'attunement',
      int: 'intelligence',
      fai: 'faith'
    };

    const requirements = spellOrSpirit.requirements || {};
    let totalBonus = 0;

    // Group spell_scaling entries by stat
    const scalingByStat = {};
    for (const entry of catalyst.spell_scaling) {
      const stat = entry.stat?.toUpperCase();
      if (!scalingByStat[stat]) scalingByStat[stat] = [];
      scalingByStat[stat].push(entry);
    }

    // For each stat with scaling entries, find the best tier the spell qualifies for
    for (const [stat, entries] of Object.entries(scalingByStat)) {
      const spellReq = requirements[stat.toLowerCase()] || requirements[stat] || 0;

      // If spell has 0 requirement for this stat, skip this scaling entirely
      if (spellReq === 0) continue;

      // Find highest tier where spellReq >= tierRequirement
      let bestEntry = null;
      for (const entry of entries) {
        const tierReq = entry.requirement || 0;
        if (spellReq >= tierReq) {
          if (!bestEntry || tierReq > (bestEntry.requirement || 0)) {
            bestEntry = entry;
          }
        }
      }

      if (bestEntry) {
        // Convert abbreviation to full name for stats lookup
        const statAbbrev = stat.toLowerCase();
        const statKey = STAT_ABBREV_TO_FULL[statAbbrev] || statAbbrev;
        const statValue = stats[statKey] || 10;
        const statMod = Math.floor((statValue - 10) / 2);
        const rawGrade = bestEntry.grade || bestEntry.value || 'E';
        const grade = typeof rawGrade === 'string' ? rawGrade.toUpperCase() : String(rawGrade);
        const multiplier = CONFIG.SCALING_GRADES[grade] || 0;
        totalBonus += Math.floor(multiplier * statMod);
      }
    }

    return totalBonus;
  }

  /**
   * Generate a weapon skill macro
   */
  generateWeaponSkillMacro(skill, stats, linkedSlot = null) {
    if (!skill || skill.name === undefined) {
      debug('Skipping weapon skill macro: missing name', skill?.id);
      return null;
    }
    // Use pre-calculated scalingBonus from App if available, otherwise calculate locally
    const scalingBonus = skill.scalingBonus !== undefined
      ? skill.scalingBonus
      : this.calculateScalingBonus(skill.scaling || skill.spell_scaling, stats, false);

    // F2 Fix: Convert legacy dice to combat structure
    const skillCombat = convertDiceToCombat(skill.dice, linkedSlot, scalingBonus);

    return {
      id: `skill-${skill.id}`,
      type: CONFIG.MACRO_TYPES.WEAPON_SKILL,
      name: skill.name,
      description: skill.description || '',
      icon: 'fa-solid fa-hand',
      apCost: skill.ap || skill.cost_ap || 0,
      fpCost: skill.fp || skill.cost_fp || 0,
      dice: skill.dice || [],
      combat: skillCombat, // F2 Fix: Proper combat structure
      scalingBonus,
      source: CONFIG.MACRO_SOURCES.APP,
      sourceId: skill.id,
      linkedSlot,
      customData: null,
      hotkey: null,
      macroSet: 1
    };
  }

  /**
   * CF1: Calculate scaling bonus per damage type
   * @param {Array} scaling - Array of {type, stat, value/grade} objects
   * @param {Object} stats - Character stats
   * @param {boolean} twoHanding - Whether two-handing (upgrades STR grade)
   * @returns {Object} Scaling bonuses keyed by damage type { PHYSICAL: 5, FIRE: -2 }
   */
  calculateScalingBonusByType(scaling, stats, twoHanding) {
    if (!scaling || !Array.isArray(scaling)) return {};

    // Map stat abbreviations to full stat names (App sends full names in stats object)
    const STAT_ABBREV_TO_FULL = {
      str: 'strength',
      dex: 'dexterity',
      vit: 'vitality',
      end: 'endurance',
      att: 'attunement',
      int: 'intelligence',
      fai: 'faith'
    };

    const bonusByType = {};
    for (const scalingEntry of scaling) {
      const type = scalingEntry.type?.toUpperCase() || 'PHYSICAL';
      const stat = scalingEntry.stat;
      const rawGrade = scalingEntry.grade || scalingEntry.value;
      // Ensure grade is uppercase to match CONFIG.SCALING_GRADES keys
      const grade = typeof rawGrade === 'string' ? rawGrade.toUpperCase() : String(rawGrade || 'D');

      // Convert abbreviation to full name for lookup
      const statAbbrev = stat?.toLowerCase();
      const statKey = STAT_ABBREV_TO_FULL[statAbbrev] || statAbbrev;
      const statValue = stats[statKey] || 10;
      const statMod = Math.floor((statValue - 10) / 2);

      let effectiveGrade = grade;
      if (twoHanding && stat?.toUpperCase() === 'STR') {
        effectiveGrade = this.upgradeGrade(grade);
      }

      const multiplier = CONFIG.SCALING_GRADES[effectiveGrade] || 0;
      const bonus = Math.floor(multiplier * statMod);

      // Add to existing bonus for this type (multiple scaling entries can target same type)
      bonusByType[type] = (bonusByType[type] || 0) + bonus;
    }

    return bonusByType;
  }

  /**
   * Calculate scaling bonus from stat scaling (legacy - returns total)
   * @param {Array} scaling - Array of {stat, value/grade} objects
   * @param {Object} stats - Character stats
   * @param {boolean} twoHanding - Whether two-handing (upgrades STR grade)
   * @returns {number} Total scaling bonus (sum of all types)
   */
  calculateScalingBonus(scaling, stats, twoHanding) {
    // CF1: Use per-type calculation and sum for backwards compatibility
    const bonusByType = this.calculateScalingBonusByType(scaling, stats, twoHanding);
    return Object.values(bonusByType).reduce((sum, b) => sum + b, 0);
  }

  /**
   * Upgrade a scaling grade by one step
   */
  upgradeGrade(grade) {
    const order = CONFIG.GRADE_ORDER;
    const idx = order.indexOf(grade);
    if (idx === -1 || idx >= order.length - 1) return grade;
    return order[idx + 1];
  }

  /**
   * Modify dice for heavy attack (add 2 more primary dice)
   * Primary dice is the first dice entry (top damage type on weapon)
   */
  modifyDiceForHeavy(dice) {
    if (!dice || !Array.isArray(dice) || dice.length === 0) return dice;

    // Clone and add 2 to the first (primary) die's count
    const modified = JSON.parse(JSON.stringify(dice));
    if (modified[0]) {
      modified[0].count = (modified[0].count || 1) + 2;
    }
    return modified;
  }

  /**
   * Clear cached macros for a character
   */
  clearCache(uuid) {
    if (uuid) {
      this.macroCache.delete(uuid);
    } else {
      this.macroCache.clear();
    }
  }

  /**
   * Get cached combat data for a character
   */
  getCachedCombatData(uuid) {
    return this.macroCache.get(uuid)?.combatData || null;
  }
}

/**
 * Create a custom macro from builder data
 * @param {Object} data - Custom macro data from builder
 * @returns {Object} Macro object
 */
export function createCustomMacro(data) {
  return {
    id: `custom-${foundry.utils.randomID()}`,
    type: CONFIG.MACRO_TYPES.CUSTOM,
    name: data.name || 'Custom Macro',
    description: data.description || '',
    icon: data.icon || 'fa-solid fa-star',
    apCost: data.apCost || 0,
    fpCost: data.fpCost || 0,
    dice: data.dice || [],
    scalingBonus: 0,
    source: CONFIG.MACRO_SOURCES.CUSTOM,
    sourceId: null,
    linkedSlot: data.linkedSlot || null,
    range: data.range || '',
    duration: data.duration || '',
    statusEffect: data.statusEffect || null,
    aoe: data.aoe || null,
    customData: {
      scalingLink: data.scalingLink || 'none',
      customScript: data.customScript || null
    },
    hotkey: null,
    macroSet: data.macroSet || 1
  };
}

/**
 * Create a toggled weapon macro (for weapon swap system)
 * CF3: Now supports trick weapons with per-form macros
 * @param {Object} weapon - Weapon data
 * @param {Object} stats - Character stats
 * @returns {Array} Array of macro objects for the weapon
 */
export function createToggledWeaponMacros(weapon, stats) {
  const manager = game.sd20?.macroManager;
  if (!manager) return [];

  // CF3: Use the new method that handles trick weapons with per-form macros
  const macros = manager.generateWeaponMacrosForAllForms(weapon, stats, 'toggled', false);

  // Mark all as toggled source
  for (const macro of macros) {
    macro.source = CONFIG.MACRO_SOURCES.TOGGLED;
    macro.id = `toggled-${macro.id}`;
  }

  return macros;
}

/**
 * Register the macro manager
 */
export function registerMacroManager() {
  game.sd20 = game.sd20 || {};
  game.sd20.macroManager = new MacroManager();

  // Listen for character updates to refresh macro cache
  Hooks.on('sd20CharacterUpdate', (uuid) => {
    debug(`Character ${uuid} updated, clearing macro cache`);
    game.sd20.macroManager.clearCache(uuid);
  });

  log('Macro manager registered');
}