/**
 * Damage Calculation Engine
 * Core math for damage, buildup, healing, and DC checks.
 * All calculations round down (Math.floor).
 */

import { CONFIG } from './config.js';
import { debug, log } from './utils.js';

/* ========================================
   Helper: Read Actor Flag Data
   ======================================== */

const MODULE = CONFIG.MODULE_ID;

// Default combat settings structure (used when actor has no settings yet)
const DEFAULT_COMBAT_SETTINGS = {
  damageImmunities: {
    PHYSICAL: false, MAGIC: false, FIRE: false, LIGHTNING: false, DARK: false
  },
  statusEffectImmunities: {
    Bleed: false, Poison: false, Toxic: false, Frost: false, Curse: false, Poise: false
  },
  statusConditionImmunities: {
    Grappled: false, Restrained: false, Prone: false, Mounting: false,
    ImpairedVision: false, Deafened: false, Dazed: false, LimbFracture: false,
    LockedUp: false, Staggered: false, Frenzy: false, Berserk: false,
    Exhaustion: false, BledOut: false, Poisoned: false, BadlyPoisoned: false,
    Frostbitten: false, Cursed: false
  },
  overrides: {
    damage: {
      PHYSICAL:  { flatReduction: 0, percentReduction: 0 },
      MAGIC:     { flatReduction: 0, percentReduction: 0 },
      FIRE:      { flatReduction: 0, percentReduction: 0 },
      LIGHTNING: { flatReduction: 0, percentReduction: 0 },
      DARK:      { flatReduction: 0, percentReduction: 0 }
    },
    statusBuildup: {
      Bleed:  { flatReduction: 0, percentReduction: 0 },
      Poison: { flatReduction: 0, percentReduction: 0 },
      Toxic:  { flatReduction: 0, percentReduction: 0 },
      Frost:  { flatReduction: 0, percentReduction: 0 },
      Curse:  { flatReduction: 0, percentReduction: 0 },
      Poise:  { flatReduction: 0, percentReduction: 0 }
    },
    healing: {
      flatBonus: 0,
      percentModifier: 0,
      invertHealing: false
    },
    passiveRecovery: {
      hpPerRound: 0,
      fpPerRound: 0
    },
    statusRecovery: {
      selfRecoveryBonus: 0,
      preventRecoveryRadius: 0,
      preventRecoveryTargets: {
        all: false, Bleed: false, Poison: false, Toxic: false, Frost: false, Curse: false, Poise: false
      },
      preventRecoveryExcludeSelf: false,
      increaseRecoveryRadius: 0,
      increaseRecoveryAmount: 0,
      increaseRecoveryTargets: {
        all: false, Bleed: false, Poison: false, Toxic: false, Frost: false, Curse: false, Poise: false
      },
      increaseRecoveryExcludeSelf: false
    }
  },
  tokenUI: {
    hp: { showToSelf: true, showToOthers: false },
    fp: { showToSelf: true, showToOthers: false },
    ap: { showToSelf: true, showToOthers: false }
  }
};

// Map status effect name to its triggered condition
const STATUS_TRIGGER_MAP = {
  Bleed:  'BledOut',
  Poison: 'Poisoned',
  Toxic:  'BadlyPoisoned',
  Frost:  'Frostbitten',
  Curse:  'Cursed',
  Poise:  'Staggered'
};

/**
 * Get actor combat settings with defaults merged in
 */
export function getActorCombatSettings(actor) {
  if (!actor) return { ...DEFAULT_COMBAT_SETTINGS };
  const stored = actor.getFlag(MODULE, 'combatSettings');
  if (!stored) return { ...DEFAULT_COMBAT_SETTINGS };
  // Deep merge stored over defaults
  return {
    damageImmunities: { ...DEFAULT_COMBAT_SETTINGS.damageImmunities, ...stored.damageImmunities },
    statusEffectImmunities: { ...DEFAULT_COMBAT_SETTINGS.statusEffectImmunities, ...stored.statusEffectImmunities },
    statusConditionImmunities: { ...DEFAULT_COMBAT_SETTINGS.statusConditionImmunities, ...stored.statusConditionImmunities },
    overrides: {
      damage: _mergeOverrideGroup(DEFAULT_COMBAT_SETTINGS.overrides.damage, stored.overrides?.damage),
      statusBuildup: _mergeOverrideGroup(DEFAULT_COMBAT_SETTINGS.overrides.statusBuildup, stored.overrides?.statusBuildup),
      healing: { ...DEFAULT_COMBAT_SETTINGS.overrides.healing, ...stored.overrides?.healing },
      passiveRecovery: { ...DEFAULT_COMBAT_SETTINGS.overrides.passiveRecovery, ...stored.overrides?.passiveRecovery },
      statusRecovery: _mergeStatusRecovery(DEFAULT_COMBAT_SETTINGS.overrides.statusRecovery, stored.overrides?.statusRecovery)
    },
    tokenUI: {
      hp: { ...DEFAULT_COMBAT_SETTINGS.tokenUI.hp, ...stored.tokenUI?.hp },
      fp: { ...DEFAULT_COMBAT_SETTINGS.tokenUI.fp, ...stored.tokenUI?.fp },
      ap: { ...DEFAULT_COMBAT_SETTINGS.tokenUI.ap, ...stored.tokenUI?.ap }
    }
  };
}

function _mergeOverrideGroup(defaults, stored) {
  if (!stored) return { ...defaults };
  const result = {};
  for (const key of Object.keys(defaults)) {
    result[key] = { ...defaults[key], ...stored[key] };
  }
  return result;
}

function _mergeStatusRecovery(defaults, stored) {
  if (!stored) return { ...defaults };
  return {
    selfRecoveryBonus: stored.selfRecoveryBonus ?? stored.selfRecoveryModifier ?? defaults.selfRecoveryBonus,
    preventRecoveryRadius: stored.preventRecoveryRadius ?? defaults.preventRecoveryRadius,
    preventRecoveryTargets: { ...defaults.preventRecoveryTargets, ...stored.preventRecoveryTargets },
    preventRecoveryExcludeSelf: stored.preventRecoveryExcludeSelf ?? defaults.preventRecoveryExcludeSelf,
    increaseRecoveryRadius: stored.increaseRecoveryRadius ?? defaults.increaseRecoveryRadius,
    increaseRecoveryAmount: stored.increaseRecoveryAmount ?? defaults.increaseRecoveryAmount,
    increaseRecoveryTargets: { ...defaults.increaseRecoveryTargets, ...stored.increaseRecoveryTargets },
    increaseRecoveryExcludeSelf: stored.increaseRecoveryExcludeSelf ?? defaults.increaseRecoveryExcludeSelf
  };
}

/**
 * Get actor resistance data from App sync (for player characters)
 * Normalizes different data formats from the App into a consistent structure
 * IMPORTANT: The App sends Title Case keys (Physical, Magic, etc.) but the
 * damage calculation expects UPPERCASE keys (PHYSICAL, MAGIC, etc.)
 * This function normalizes both the structure and the key casing.
 */
export function getActorResistances(actor) {
  if (!actor) return null;
  const raw = actor.getFlag(MODULE, 'combat.resistances');
  if (!raw) return null;

  // Debug log the raw resistance data
  debug(`Raw resistance data for ${actor.name}:`, JSON.stringify(raw));

  // Normalize keys to UPPERCASE for damage calculation
  const normalizeKeys = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // Convert title case to uppercase (Physical -> PHYSICAL)
      // Also handle FlatPhysical -> FlatPHYSICAL
      let normalizedKey = key;
      if (key.startsWith('Flat')) {
        // FlatPhysical -> FlatPHYSICAL
        normalizedKey = 'Flat' + key.slice(4).toUpperCase();
      } else if (/^[A-Z][a-z]+$/.test(key)) {
        // Title case single word (Physical, Magic, etc.) -> uppercase
        normalizedKey = key.toUpperCase();
      }
      result[normalizedKey] = value;
    }
    return result;
  };

  // If data already has 'primary' wrapper
  if (raw.primary) {
    return {
      primary: normalizeKeys(raw.primary),
      bonus: raw.bonus ? { ...raw.bonus, ...normalizeKeys(raw.bonus) } : { active: false }
    };
  }

  // Otherwise, App sent flat structure - normalize both structure and keys
  // Check if raw has any resistance keys directly (title case or uppercase)
  const damageTypesLower = ['physical', 'magic', 'fire', 'lightning', 'dark'];
  const hasDirectKeys = Object.keys(raw).some(key => {
    const lower = key.toLowerCase().replace('flat', '');
    return damageTypesLower.includes(lower);
  });

  if (hasDirectKeys) {
    // Normalize flat structure into expected format with uppercase keys
    debug(`Normalizing flat resistance structure for ${actor.name}`);
    const normalizedRaw = normalizeKeys(raw);
    return {
      primary: normalizedRaw,
      bonus: raw.bonus ? { ...raw.bonus, ...normalizeKeys(raw.bonus) } : { active: false }
    };
  }

  // Return normalized if structure is unrecognized
  return { primary: normalizeKeys(raw), bonus: { active: false } };
}

/**
 * Get NPC resistance tiers from system data
 * Returns { PHYSICAL: tier, MAGIC: tier, ... } or null if not an NPC
 */
export function getNPCResistances(actor) {
  if (!actor || actor.type !== 'npc') return null;
  const res = actor.system?.resistances;
  if (!res) return null;
  return {
    PHYSICAL: parseInt(res.PHYSICAL) || 0,
    MAGIC: parseInt(res.MAGIC) || 0,
    FIRE: parseInt(res.FIRE) || 0,
    LIGHTNING: parseInt(res.LIGHTNING) || 0,
    DARK: parseInt(res.DARK) || 0
  };
}

/* ========================================
   Vulnerability System
   ======================================== */

/**
 * Get all active vulnerabilities on an actor
 * @param {Actor} actor - The target actor
 * @returns {Array} Array of vulnerability objects
 */
export function getActorVulnerabilities(actor) {
  if (!actor) return [];
  return actor.getFlag(MODULE, 'vulnerabilities') || [];
}

/* ========================================
   Protection System (CF4)
   ======================================== */

/**
 * Get all active protections on an actor
 * @param {Actor} actor - The target actor
 * @returns {Object} { damage: [], buildup: [], condition: [] }
 */
export function getActorProtections(actor) {
  if (!actor) return { damage: [], buildup: [], condition: [] };
  return {
    damage: actor.getFlag(MODULE, 'protections.damage') || [],
    buildup: actor.getFlag(MODULE, 'protections.buildup') || [],
    condition: actor.getFlag(MODULE, 'protections.condition') || []
  };
}

/**
 * Apply damage protection to an actor
 * @param {Actor} actor - The target actor
 * @param {Object} protection - The protection to apply
 * @param {string} sourceId - ID of the macro granting this
 * @param {string} sourceName - Name of the macro (for display)
 * @param {number} currentRound - Current combat round
 * @returns {Object} { applied, protection, flagUpdates }
 */
export function applyDamageProtectionToActor(actor, protection, sourceId, sourceName, currentRound) {
  if (!actor || !protection) return { applied: false };

  const existing = actor.getFlag(MODULE, 'protections.damage') || [];
  const newProt = {
    id: foundry.utils.randomID(),
    type: protection.type || 'PHYSICAL',
    tiers: parseInt(protection.tiers) || 0,
    flat: parseInt(protection.flat) || 0,
    diceCount: parseInt(protection.diceCount) || 0,
    diceSides: parseInt(protection.diceSides) || 0,
    percentage: parseInt(protection.percentage) || 0,
    percentageTiming: protection.percentageTiming || 'INITIAL',
    durationTurns: parseInt(protection.durationTurns) || 0,
    durationAttacks: parseInt(protection.durationAttacks) || 0,
    stacking: protection.stacking || 'OVERWRITE',
    sourceId,
    sourceName,
    appliedRound: currentRound,
    remainingTurns: parseInt(protection.durationTurns) || 0,
    remainingAttacks: parseInt(protection.durationAttacks) || 0
  };

  let updated;
  if (newProt.stacking === 'OVERWRITE') {
    // Remove existing protection of same type from same source
    const filtered = existing.filter(p => !(p.type === newProt.type && p.sourceId === sourceId));
    updated = [...filtered, newProt];
    debug(`Overwrote damage protection ${newProt.type} from ${sourceName} on ${actor.name}`);
  } else {
    // Append mode - add to existing
    updated = [...existing, newProt];
    debug(`Appended damage protection ${newProt.type} from ${sourceName} on ${actor.name}`);
  }

  return {
    applied: true,
    protection: newProt,
    flagUpdates: { 'protections.damage': updated }
  };
}

/**
 * Apply buildup protection to an actor
 */
export function applyBuildupProtectionToActor(actor, protection, sourceId, sourceName, currentRound) {
  if (!actor || !protection) return { applied: false };

  const existing = actor.getFlag(MODULE, 'protections.buildup') || [];
  const newProt = {
    id: foundry.utils.randomID(),
    type: protection.type || 'BLEED',
    flat: parseInt(protection.flat) || 0,
    diceCount: parseInt(protection.diceCount) || 0,
    diceSides: parseInt(protection.diceSides) || 0,
    percentage: parseInt(protection.percentage) || 0,
    percentageTiming: protection.percentageTiming || 'INITIAL',
    durationTurns: parseInt(protection.durationTurns) || 0,
    durationAttacks: parseInt(protection.durationAttacks) || 0,
    stacking: protection.stacking || 'OVERWRITE',
    sourceId,
    sourceName,
    appliedRound: currentRound,
    remainingTurns: parseInt(protection.durationTurns) || 0,
    remainingAttacks: parseInt(protection.durationAttacks) || 0
  };

  let updated;
  if (newProt.stacking === 'OVERWRITE') {
    const filtered = existing.filter(p => !(p.type === newProt.type && p.sourceId === sourceId));
    updated = [...filtered, newProt];
    debug(`Overwrote buildup protection ${newProt.type} from ${sourceName} on ${actor.name}`);
  } else {
    updated = [...existing, newProt];
    debug(`Appended buildup protection ${newProt.type} from ${sourceName} on ${actor.name}`);
  }

  return {
    applied: true,
    protection: newProt,
    flagUpdates: { 'protections.buildup': updated }
  };
}

/**
 * Apply condition immunity protection to an actor
 */
export function applyConditionProtectionToActor(actor, protection, sourceId, sourceName, currentRound) {
  if (!actor || !protection) return { applied: false };

  const existing = actor.getFlag(MODULE, 'protections.condition') || [];
  const newProt = {
    id: foundry.utils.randomID(),
    condition: protection.condition || 'Dazed',
    durationTurns: parseInt(protection.durationTurns) || 0,
    durationAttacks: parseInt(protection.durationAttacks) || 0,
    sourceId,
    sourceName,
    appliedRound: currentRound,
    remainingTurns: parseInt(protection.durationTurns) || 0,
    remainingAttacks: parseInt(protection.durationAttacks) || 0
  };

  // Condition immunity: overwrite same condition from same source
  const filtered = existing.filter(p => !(p.condition === newProt.condition && p.sourceId === sourceId));
  const updated = [...filtered, newProt];
  debug(`Applied condition protection ${newProt.condition} from ${sourceName} on ${actor.name}`);

  return {
    applied: true,
    protection: newProt,
    flagUpdates: { 'protections.condition': updated }
  };
}

/**
 * Get combined damage protection for a specific damage type
 *
 * TIMING BEHAVIOR:
 * - INITIAL (Before Reductions): Protection tiers/flat COMBINE with resistance tiers/flat
 *   into a single calculation. This is the default and most natural mode.
 * - FINAL (After Reductions): Protection applies as a SEPARATE layer after resistance
 *   is already calculated. Use for temporary buffs that shouldn't stack with armor.
 *
 * @param {Actor} actor - The target actor
 * @param {string} damageType - Damage type to check
 * @returns {Object} { initial: {...}, final: {...}, protections }
 */
export function getDamageProtectionForType(actor, damageType) {
  const protections = getActorProtections(actor).damage;

  // Separate data by timing
  const initial = { tiers: 0, flat: 0, diceTotal: 0, percentage: 0 };
  const final = { tiers: 0, flat: 0, diceTotal: 0, percentage: 0 };
  const matchingProtections = [];

  for (const p of protections) {
    if (p.type !== damageType) continue;

    // Check if protection is still active
    const turnsOK = p.durationTurns === 0 || p.remainingTurns > 0;
    const attacksOK = p.durationAttacks === 0 || p.remainingAttacks > 0;
    if (!turnsOK && p.durationTurns > 0) continue;
    if (!attacksOK && p.durationAttacks > 0) continue;

    // Default timing is INITIAL (Before Reductions) as it's the most natural mode
    const timing = p.percentageTiming || 'INITIAL';
    const target = timing === 'INITIAL' ? initial : final;

    target.tiers += p.tiers || 0;
    target.flat += p.flat || 0;
    target.percentage += p.percentage || 0;

    // Roll dice if present
    if (p.diceCount > 0 && p.diceSides > 0) {
      const roll = new Roll(`${p.diceCount}d${p.diceSides}`);
      roll.evaluateSync();
      target.diceTotal += roll.total;
    }

    matchingProtections.push(p);
  }

  // Cap percentages at 100
  initial.percentage = Math.min(100, initial.percentage);
  final.percentage = Math.min(100, final.percentage);

  debug(`getDamageProtectionForType: actor=${actor?.name}, type=${damageType}, initial=[t${initial.tiers},f${initial.flat},d${initial.diceTotal},p${initial.percentage}%], final=[t${final.tiers},f${final.flat},d${final.diceTotal},p${final.percentage}%]`);

  return { initial, final, protections: matchingProtections };
}

/**
 * Get combined buildup protection for a specific status type
 *
 * TIMING BEHAVIOR (same as damage protection):
 * - INITIAL (Before Reductions): Percentage applied first, then flat+dice
 *   combined with any override reductions. Default timing.
 * - FINAL (After Reductions): Applied as separate layer after overrides.
 *
 * Note: Buildup has no tiers from character app (only thresholds).
 * Protection provides the only tier/flat reductions for buildup.
 */
export function getBuildupProtectionForType(actor, statusType) {
  const protections = getActorProtections(actor).buildup;

  // Separate data by timing
  const initial = { flat: 0, diceTotal: 0, percentage: 0 };
  const final = { flat: 0, diceTotal: 0, percentage: 0 };
  const matchingProtections = [];

  for (const p of protections) {
    if (p.type !== statusType) continue;

    const turnsOK = p.durationTurns === 0 || p.remainingTurns > 0;
    const attacksOK = p.durationAttacks === 0 || p.remainingAttacks > 0;
    if (!turnsOK && p.durationTurns > 0) continue;
    if (!attacksOK && p.durationAttacks > 0) continue;

    // Default timing is INITIAL (Before Reductions)
    const timing = p.percentageTiming || 'INITIAL';
    const target = timing === 'INITIAL' ? initial : final;

    target.flat += p.flat || 0;
    target.percentage += p.percentage || 0;

    if (p.diceCount > 0 && p.diceSides > 0) {
      const roll = new Roll(`${p.diceCount}d${p.diceSides}`);
      roll.evaluateSync();
      target.diceTotal += roll.total;
    }

    matchingProtections.push(p);
  }

  initial.percentage = Math.min(100, initial.percentage);
  final.percentage = Math.min(100, final.percentage);

  debug(`getBuildupProtectionForType: actor=${actor?.name}, type=${statusType}, initial=[f${initial.flat},d${initial.diceTotal},p${initial.percentage}%], final=[f${final.flat},d${final.diceTotal},p${final.percentage}%]`);

  return { initial, final, protections: matchingProtections };
}

/**
 * Check if actor has condition immunity
 */
export function hasConditionImmunityProtection(actor, conditionName) {
  const protections = getActorProtections(actor).condition;

  for (const p of protections) {
    if (p.condition !== conditionName) continue;

    const turnsOK = p.durationTurns === 0 || p.remainingTurns > 0;
    const attacksOK = p.durationAttacks === 0 || p.remainingAttacks > 0;
    if (!turnsOK && p.durationTurns > 0) continue;
    if (!attacksOK && p.durationAttacks > 0) continue;

    return { immune: true, protection: p };
  }

  return { immune: false, protection: null };
}

/**
 * Decrement protection durations (called on attacks)
 * @param {Actor} actor - The target actor
 * @param {string} protectionType - 'damage' or 'buildup'
 * @param {string} subType - The damage/buildup type that was hit
 * @param {Array} protectionIds - IDs of protections to decrement
 * @returns {Object} { flagUpdates }
 */
export function decrementProtectionAttacks(actor, protectionType, subType, protectionIds) {
  if (!actor) return { flagUpdates: {} };

  const key = `protections.${protectionType}`;
  const protections = actor.getFlag(MODULE, key) || [];
  const updated = [];

  for (const p of protections) {
    if (protectionIds.includes(p.id)) {
      if (p.durationAttacks > 0 && p.remainingAttacks > 0) {
        p.remainingAttacks = Math.max(0, p.remainingAttacks - 1);
        debug(`Decremented ${protectionType} protection ${p.id} attacks: ${p.remainingAttacks} remaining`);
      }
    }
    // Only keep if still has duration
    const turnsOK = p.durationTurns === 0 || p.remainingTurns > 0;
    const attacksOK = p.durationAttacks === 0 || p.remainingAttacks > 0;
    if (turnsOK || attacksOK) {
      updated.push(p);
    } else {
      debug(`Protection ${p.id} expired (attacks), removing`);
    }
  }

  return { flagUpdates: { [key]: updated } };
}

/**
 * Decrement protection turn durations (called at end of round)
 * @param {Actor} actor - The target actor
 * @returns {Object} { expired, remaining, flagUpdates }
 */
export function tickProtectionDurations(actor) {
  if (!actor) return { expired: [], remaining: [], flagUpdates: {} };

  const result = { expired: [], remaining: [], flagUpdates: {} };

  for (const protType of ['damage', 'buildup', 'condition']) {
    const key = `protections.${protType}`;
    const protections = actor.getFlag(MODULE, key) || [];
    const remaining = [];

    for (const p of protections) {
      if (p.durationTurns > 0 && p.remainingTurns > 0) {
        p.remainingTurns = Math.max(0, p.remainingTurns - 1);
      }

      const turnsOK = p.durationTurns === 0 || p.remainingTurns > 0;
      const attacksOK = p.durationAttacks === 0 || p.remainingAttacks > 0;

      if (turnsOK || attacksOK) {
        remaining.push(p);
        result.remaining.push(p);
      } else {
        result.expired.push(p);
        debug(`Protection ${p.id} expired (turns), removing`);
      }
    }

    result.flagUpdates[key] = remaining;
  }

  if (result.expired.length > 0) {
    debug(`Expired ${result.expired.length} protections on ${actor.name}`);
  }

  return result;
}

/**
 * Remove a protection from an actor by ID
 */
export function removeProtectionFromActor(actor, protectionId, protectionType) {
  if (!actor || !protectionId) return { removed: false };

  const key = `protections.${protectionType}`;
  const existing = actor.getFlag(MODULE, key) || [];
  const filtered = existing.filter(p => p.id !== protectionId);

  if (filtered.length === existing.length) {
    return { removed: false };
  }

  return {
    removed: true,
    flagUpdates: { [key]: filtered }
  };
}

/**
 * Apply a vulnerability debuff to an actor
 * @param {Actor} actor - The target actor
 * @param {Object} vulnerability - The vulnerability to apply
 * @param {string} sourceActorId - ID of the actor applying this
 * @param {number} currentRound - Current combat round
 * @returns {Object} { applied, vulnerability, flagUpdates }
 */
export function applyVulnerabilityToActor(actor, vulnerability, sourceActorId, currentRound) {
  if (!actor || !vulnerability) return { applied: false };

  const existing = getActorVulnerabilities(actor);
  const newVuln = {
    id: foundry.utils.randomID(),
    type: vulnerability.type || 'PHYSICAL',
    tiers: parseInt(vulnerability.tiers) || 1,
    duration: parseInt(vulnerability.duration) || 3,
    timing: vulnerability.timing || 'before',
    stacking: vulnerability.stacking || false,
    sourceActorId,
    appliedRound: currentRound
  };

  // Check for existing vulnerability of same type from same source
  const existingIdx = existing.findIndex(v =>
    v.type === newVuln.type && v.sourceActorId === sourceActorId
  );

  let updated;
  if (existingIdx >= 0 && !newVuln.stacking) {
    // Refresh duration instead of stacking
    existing[existingIdx].duration = newVuln.duration;
    existing[existingIdx].appliedRound = currentRound;
    updated = [...existing];
    debug(`Refreshed vulnerability ${newVuln.type} on ${actor.name}`);
  } else {
    updated = [...existing, newVuln];
    debug(`Applied vulnerability ${newVuln.type} (${newVuln.tiers} tiers) to ${actor.name}`);
  }

  return {
    applied: true,
    vulnerability: newVuln,
    flagUpdates: { vulnerabilities: updated }
  };
}

/**
 * Remove a vulnerability from an actor by ID
 * @param {Actor} actor - The target actor
 * @param {string} vulnId - ID of the vulnerability to remove
 * @returns {Object} { removed, flagUpdates }
 */
export function removeVulnerabilityFromActor(actor, vulnId) {
  if (!actor || !vulnId) return { removed: false };

  const existing = getActorVulnerabilities(actor);
  const filtered = existing.filter(v => v.id !== vulnId);

  if (filtered.length === existing.length) {
    return { removed: false };
  }

  return {
    removed: true,
    flagUpdates: { vulnerabilities: filtered }
  };
}

/**
 * Get combined vulnerability effect for a specific damage type
 * @param {Actor} actor - The target actor
 * @param {string} damageType - Damage type to check
 * @param {string} timing - 'before' or 'after' (relative to damage)
 * @returns {Object} { tiers }
 */
export function getVulnerabilityForDamageType(actor, damageType) {
  const vulns = getActorVulnerabilities(actor);
  let tiers = 0;

  // Sum all vulnerabilities for this damage type
  // Note: 'timing' field determines when vulnerability is APPLIED during the attack that creates it,
  // but once applied, all vulnerabilities affect subsequent damage calculations
  for (const v of vulns) {
    if (v.type === damageType) {
      tiers += parseInt(v.tiers) || 0;
    }
  }

  debug(`getVulnerabilityForDamageType: actor=${actor?.name}, type=${damageType}, tiers=${tiers}`);
  return { tiers };
}

/**
 * Decrement vulnerability durations at end of round
 * @param {Actor} actor - The target actor
 * @param {number} currentRound - Current combat round
 * @returns {Object} { expired, remaining, flagUpdates }
 */
export function tickVulnerabilityDurations(actor, currentRound) {
  if (!actor) return { expired: [], remaining: [], flagUpdates: {} };

  const existing = getActorVulnerabilities(actor);
  const expired = [];
  const remaining = [];

  for (const v of existing) {
    v.duration = Math.max(0, v.duration - 1);
    if (v.duration <= 0) {
      expired.push(v);
    } else {
      remaining.push(v);
    }
  }

  if (expired.length > 0) {
    debug(`Expired ${expired.length} vulnerabilities on ${actor.name}`);
  }

  return {
    expired,
    remaining,
    flagUpdates: { vulnerabilities: remaining }
  };
}

/**
 * Calculate monster damage after resistance tiers
 * Formula: 25% reduction per tier, range -8 to +8
 * Tier 4+ (100%+) = heals instead of damage
 * Negative tiers = MORE damage taken
 */
export function calculateMonsterDamage(baseDamage, resistanceTier) {
  if (baseDamage <= 0) return { final: 0, reduction: 0, healed: false };

  // Each tier = 25% reduction
  const reductionPercent = resistanceTier * CONFIG.MONSTER_RESISTANCE.PERCENT_PER_TIER;

  if (reductionPercent >= 100) {
    // Tier 4+: Healing instead of damage
    const healPercent = reductionPercent - 100;
    const healAmount = Math.floor(baseDamage * (healPercent / 100));
    return { final: -healAmount, reduction: baseDamage + healAmount, healed: true };
  } else if (reductionPercent < 0) {
    // Negative tiers: MORE damage (floor the final result)
    const damageMultiplier = (100 + Math.abs(reductionPercent)) / 100;
    const finalDamage = Math.floor(baseDamage * damageMultiplier);
    return { final: finalDamage, reduction: baseDamage - finalDamage, healed: false };
  } else {
    // Normal reduction - floor the FINAL damage, not the reduction
    // 22 damage at 25% reduction = floor(22 * 0.75) = floor(16.5) = 16
    const damageMultiplier = (100 - reductionPercent) / 100;
    const finalDamage = Math.floor(baseDamage * damageMultiplier);
    const reduction = baseDamage - finalDamage;
    return { final: finalDamage, reduction, healed: false };
  }
}

/**
 * Calculate player damage after resistance (tier + flat)
 * Formula: Tier 1=10%, Tier 2=20%, Tier 3=30% (capped)
 * Tiers beyond 3 overflow to flat reduction
 */
export function calculatePlayerDamage(baseDamage, tierResistance, flatResistance) {
  if (baseDamage <= 0) return { final: 0, percentReduction: 0, flatReduction: 0 };

  let effectiveTier = tierResistance;
  let effectiveFlat = flatResistance || 0;

  // First 3 tiers each grant +1 flat bonus
  const tierBonusFlat = tierResistance > 0 ? Math.min(tierResistance, CONFIG.PLAYER_RESISTANCE.TIER_MAX) : 0;
  effectiveFlat += tierBonusFlat;

  // Handle tier overflow to flat (Tier 4+ becomes Tier 3 + extra flat)
  if (effectiveTier > CONFIG.PLAYER_RESISTANCE.TIER_MAX) {
    effectiveFlat += (effectiveTier - CONFIG.PLAYER_RESISTANCE.TIER_MAX);
    effectiveTier = CONFIG.PLAYER_RESISTANCE.TIER_MAX;
  }

  // Calculate percentage reduction
  let percentReduction;
  if (effectiveTier >= 3) percentReduction = CONFIG.PLAYER_RESISTANCE.TIER_3_PERCENT;
  else if (effectiveTier === 2) percentReduction = CONFIG.PLAYER_RESISTANCE.TIER_2_PERCENT;
  else if (effectiveTier === 1) percentReduction = CONFIG.PLAYER_RESISTANCE.TIER_1_PERCENT;
  else if (effectiveTier === 0) percentReduction = 0;
  else percentReduction = effectiveTier * 10; // Negative: 10% MORE per tier

  // Apply percentage (floor the FINAL damage, not the reduction amount)
  let damage = baseDamage;
  let percentAmount = 0;
  if (percentReduction > 0) {
    // Reduce damage - floor the final result
    const damageMultiplier = (100 - percentReduction) / 100;
    damage = Math.floor(baseDamage * damageMultiplier);
    percentAmount = baseDamage - damage;
  } else if (percentReduction < 0) {
    // Increase damage (negative resistance) - floor the final result
    const damageMultiplier = (100 + Math.abs(percentReduction)) / 100;
    damage = Math.floor(baseDamage * damageMultiplier);
    percentAmount = damage - baseDamage;
  }

  // Apply flat reduction (minimum 0 damage)
  const flatAmount = Math.min(damage, Math.max(0, effectiveFlat));
  damage = Math.max(0, damage - flatAmount);

  return { final: damage, percentReduction: percentAmount, flatReduction: flatAmount };
}

/**
 * Get status buildup tracking data for an actor
 */
export function getActorStatusBuildup(actor) {
  if (!actor) return _defaultBuildupState();
  const stored = actor.getFlag(MODULE, 'statusBuildup');
  if (!stored) return _defaultBuildupState();
  // Merge with defaults to fill in any missing statuses
  const result = _defaultBuildupState();
  for (const key of Object.keys(result)) {
    if (stored[key]) result[key] = { ...result[key], ...stored[key] };
  }
  return result;
}

function _defaultBuildupState() {
  return {
    Bleed:  { ...CONFIG.DEFAULT_BUILDUP },
    Poison: { ...CONFIG.DEFAULT_BUILDUP },
    Toxic:  { ...CONFIG.DEFAULT_BUILDUP },
    Frost:  { ...CONFIG.DEFAULT_BUILDUP },
    Curse:  { ...CONFIG.DEFAULT_BUILDUP },
    Poise:  { ...CONFIG.DEFAULT_POISE_BUILDUP }
  };
}

/**
 * Get active conditions on an actor
 */
export function getActorActiveConditions(actor) {
  if (!actor) return {};
  return actor.getFlag(MODULE, 'activeConditions') || {};
}

/**
 * Check if a specific condition is currently active
 */
export function isConditionActive(actor, conditionName) {
  const conditions = getActorActiveConditions(actor);
  return conditions[conditionName]?.active === true;
}

/**
 * Get status thresholds (from App sync or defaults)
 */
function getActorThresholds(actor) {
  if (!actor) return { ...CONFIG.DEFAULT_THRESHOLDS };
  const synced = actor.getFlag(MODULE, 'combat.statusThresholds');
  return synced || { ...CONFIG.DEFAULT_THRESHOLDS };
}

/* ========================================
   Calculation Functions
   ======================================== */

/**
 * Calculate final damage after resistances, immunities, and overrides
 * Routes to monster or player formula based on actor type
 * @param {number} rawAmount - Raw damage before reductions
 * @param {string} damageType - PHYSICAL, MAGIC, FIRE, LIGHTNING, DARK, or TRUE
 * @param {Actor} targetActor - Foundry Actor receiving damage
 * @param {Object} options - Optional: { piercingTiers, vulnerabilityTiers }
 * @returns {Object} Detailed result
 */
export function calculateDamage(rawAmount, damageType, targetActor, options = {}) {
  const { piercingTiers = 0, piercingAllTiers = false, vulnerabilityTiers = 0 } = options;

  const result = {
    final: rawAmount,
    raw: rawAmount,
    damageType,
    resistanceReduction: 0,
    protectionReduction: 0,
    overrideReduction: 0,
    immune: false,
    bypassed: false,
    frostbitten: false,
    healed: false,
    usedProtections: [],
    breakdown: []
  };

  if (rawAmount <= 0) {
    result.final = 0;
    return result;
  }

  // TRUE damage bypasses everything
  if (damageType === 'TRUE') {
    result.bypassed = true;
    result.breakdown.push('TRUE damage — bypasses all reductions');
    return result;
  }

  // FP/AP drain bypasses all resistances (targets FP/AP instead of HP)
  if (damageType === 'FP' || damageType === 'AP') {
    result.bypassed = true;
    result.breakdown.push(`${damageType} drain — bypasses all reductions`);
    return result;
  }

  // Frostbitten: all damage becomes TRUE
  if (isConditionActive(targetActor, 'Frostbitten')) {
    result.bypassed = true;
    result.frostbitten = true;
    result.breakdown.push('Frostbitten — all damage treated as TRUE');
    return result;
  }

  const settings = getActorCombatSettings(targetActor);

  // Damage immunity check
  if (settings.damageImmunities[damageType]) {
    result.final = 0;
    result.immune = true;
    result.breakdown.push(`Immune to ${damageType} damage`);
    return result;
  }

  let damage = rawAmount;
  const isNPC = targetActor?.type === 'npc';

  // Get protection data (separated by timing)
  const protection = getDamageProtectionForType(targetActor, damageType);
  const hasInitialProt = protection.initial.tiers > 0 || protection.initial.flat > 0 ||
                         protection.initial.diceTotal > 0 || protection.initial.percentage > 0;
  const hasFinalProt = protection.final.tiers > 0 || protection.final.flat > 0 ||
                       protection.final.diceTotal > 0 || protection.final.percentage > 0;

  // Track total protection reduction for breakdown
  let totalProtectionReduction = 0;
  const beforeAllReductions = damage;

  // ==========================================
  // STEP 1: INITIAL Protection Percentage (Before Reductions)
  // Applied first, before any resistance calculation
  // ==========================================
  if (protection.initial.percentage > 0) {
    const pctReduction = Math.floor(damage * protection.initial.percentage / 100);
    damage = damage - pctReduction;
    totalProtectionReduction += pctReduction;
    result.breakdown.push(`Protection %: -${pctReduction} (${protection.initial.percentage}% before reductions)`);
  }

  // ==========================================
  // STEP 2: Resistance + INITIAL Protection (Combined)
  // INITIAL protection tiers/flat COMBINE with resistance for one calculation
  // ==========================================
  if (isNPC) {
    // Monster resistance formula: 25% per tier
    const npcResist = getNPCResistances(targetActor);
    let tier = npcResist?.[damageType] || 0;

    // Add INITIAL protection tiers to NPC resistance tier
    if (hasInitialProt && protection.initial.tiers > 0) {
      tier += protection.initial.tiers;
      result.breakdown.push(`Protection Tiers: +${protection.initial.tiers} (combined with resistance)`);
    }

    // Apply vulnerability (can go negative)
    tier = tier - vulnerabilityTiers;
    if (vulnerabilityTiers > 0) {
      result.breakdown.push(`Vulnerability: -${vulnerabilityTiers} tier${vulnerabilityTiers > 1 ? 's' : ''}`);
    }

    // Apply piercing (floors at 0, or bypasses all if piercingAllTiers)
    if (piercingAllTiers) {
      tier = 0;
      result.breakdown.push('Piercing: All tiers bypassed');
    } else if (piercingTiers > 0) {
      const prePiercing = tier;
      tier = Math.max(0, tier - piercingTiers);
      if (prePiercing !== tier) {
        result.breakdown.push(`Piercing: -${prePiercing - tier} tier${prePiercing - tier > 1 ? 's' : ''} (floored at 0)`);
      }
    }

    const monsterResult = calculateMonsterDamage(damage, tier);
    result.resistanceReduction = monsterResult.reduction;
    result.healed = monsterResult.healed;
    damage = monsterResult.final;

    if (monsterResult.healed) {
      result.breakdown.push(`Monster Resist: Tier ${tier} (${tier * 25}%) — HEALS ${Math.abs(damage)} HP`);
    } else if (tier !== 0) {
      const sign = tier > 0 ? '-' : '+';
      result.breakdown.push(`Monster Resist: Tier ${tier} (${sign}${Math.abs(tier * 25)}%)`);
    }

    // Apply INITIAL protection flat + dice AFTER tier-based reduction for NPCs
    const initialFlat = (protection.initial.flat || 0) + (protection.initial.diceTotal || 0);
    if (initialFlat > 0) {
      const flatReduction = Math.min(damage, initialFlat);
      damage = Math.max(0, damage - initialFlat);
      totalProtectionReduction += flatReduction;
      if (flatReduction > 0) {
        const parts = [];
        if (protection.initial.flat > 0) parts.push(`flat ${protection.initial.flat}`);
        if (protection.initial.diceTotal > 0) parts.push(`dice ${protection.initial.diceTotal}`);
        result.breakdown.push(`Protection Flat: -${flatReduction} (${parts.join(', ')})`);
      }
    }
  } else {
    // Player resistance formula: tier + flat from App sync
    const resistances = getActorResistances(targetActor);
    const primary = resistances?.primary || {};
    const bonus = resistances?.bonus || {};
    const bonusActive = bonus.active || false;

    // Get base tier and flat for this damage type
    let combinedTier = parseInt(primary[damageType]) || 0;
    let combinedFlat = parseInt(primary[`Flat${damageType}`]) || 0;

    if (bonusActive) {
      combinedTier += parseInt(bonus[damageType]) || 0;
      combinedFlat += parseInt(bonus[`Flat${damageType}`]) || 0;
    }

    // Add INITIAL protection tiers/flat to resistance (they combine before calculation)
    if (hasInitialProt) {
      if (protection.initial.tiers > 0) {
        combinedTier += protection.initial.tiers;
      }
      combinedFlat += (protection.initial.flat || 0) + (protection.initial.diceTotal || 0);

      if (protection.initial.tiers > 0 || protection.initial.flat > 0 || protection.initial.diceTotal > 0) {
        const parts = [];
        if (protection.initial.tiers > 0) parts.push(`+${protection.initial.tiers} tiers`);
        if (protection.initial.flat > 0) parts.push(`+${protection.initial.flat} flat`);
        if (protection.initial.diceTotal > 0) parts.push(`+${protection.initial.diceTotal} dice`);
        result.breakdown.push(`Protection (combined): ${parts.join(', ')}`);
      }
    }

    // Apply vulnerability (reduces tier)
    combinedTier = combinedTier - vulnerabilityTiers;
    if (vulnerabilityTiers > 0) {
      result.breakdown.push(`Vulnerability: -${vulnerabilityTiers} tier${vulnerabilityTiers > 1 ? 's' : ''}`);
    }

    // Apply piercing to tier (floors at 0, or bypasses all if piercingAllTiers)
    if (piercingAllTiers) {
      combinedTier = 0;
      result.breakdown.push('Piercing: All tiers bypassed');
    } else if (piercingTiers > 0) {
      const prePiercing = combinedTier;
      combinedTier = Math.max(0, combinedTier - piercingTiers);
      if (prePiercing !== combinedTier) {
        result.breakdown.push(`Piercing: -${prePiercing - combinedTier} tier${prePiercing - combinedTier > 1 ? 's' : ''}`);
      }
    }

    // Calculate player damage with combined tier + flat (handles overflow automatically)
    const beforeResist = damage;
    const playerResult = calculatePlayerDamage(damage, combinedTier, combinedFlat);
    result.resistanceReduction = playerResult.percentReduction + playerResult.flatReduction;
    damage = playerResult.final;

    // Track how much of the reduction was from protection vs base resistance
    if (hasInitialProt) {
      // Estimate protection contribution for breakdown
      totalProtectionReduction = beforeResist - damage - result.resistanceReduction;
      if (totalProtectionReduction < 0) totalProtectionReduction = 0;
    }

    if (playerResult.percentReduction > 0 || playerResult.flatReduction > 0) {
      result.breakdown.push(`Resistance: -${result.resistanceReduction} (tier ${Math.min(3, Math.max(0, combinedTier))}, flat ${Math.max(0, combinedFlat)}${combinedTier > 3 ? `, +${combinedTier - 3} overflow` : ''})`);
    }
  }

  // ==========================================
  // STEP 3: FINAL Protection (After Reductions - Separate Layer)
  // Applied as a completely separate reduction step
  // ==========================================
  if (hasFinalProt) {
    const beforeFinalProt = damage;

    // 3a. FINAL percentage first
    if (protection.final.percentage > 0) {
      const pctReduction = Math.floor(damage * protection.final.percentage / 100);
      damage = Math.max(0, damage - pctReduction);
      if (pctReduction > 0) {
        result.breakdown.push(`Protection % (after): -${pctReduction} (${protection.final.percentage}%)`);
      }
    }

    // 3b. FINAL tiers (player-style: tier 1=10%, 2=20%, 3=30%, overflow to flat)
    let finalTiers = protection.final.tiers;
    let finalTierFlat = 0;
    if (finalTiers > 3) {
      finalTierFlat = finalTiers - 3;
      finalTiers = 3;
    }
    if (finalTiers > 0) {
      const tierPercent = finalTiers * 10;
      const tierReduction = Math.floor(damage * tierPercent / 100);
      damage = Math.max(0, damage - tierReduction);
      result.breakdown.push(`Protection Tiers (after): -${tierReduction} (${finalTiers} tiers = ${tierPercent}%)`);
    }

    // 3c. FINAL flat + overflow from tiers + dice
    const totalFinalFlat = (protection.final.flat || 0) + finalTierFlat + (protection.final.diceTotal || 0);
    if (totalFinalFlat > 0) {
      const flatReduction = Math.min(damage, totalFinalFlat);
      damage = Math.max(0, damage - totalFinalFlat);
      if (flatReduction > 0) {
        const parts = [];
        if (protection.final.flat > 0) parts.push(`flat ${protection.final.flat}`);
        if (finalTierFlat > 0) parts.push(`tier overflow ${finalTierFlat}`);
        if (protection.final.diceTotal > 0) parts.push(`dice ${protection.final.diceTotal}`);
        result.breakdown.push(`Protection Flat (after): -${flatReduction} (${parts.join(', ')})`);
      }
    }

    totalProtectionReduction += (beforeFinalProt - damage);
  }

  // Set final protection reduction
  result.protectionReduction = totalProtectionReduction;
  if (protection.protections.length > 0) {
    result.usedProtections = protection.protections.map(p => p.id);
  }

  // Apply actor combat overrides (after resistance)
  const overrides = settings.overrides.damage[damageType];
  if (overrides) {
    const beforeOverride = damage;
    const flat = parseInt(overrides.flatReduction) || 0;
    const pct = parseInt(overrides.percentReduction) || 0;

    if (flat > 0) damage = Math.max(0, damage - flat);
    if (pct > 0) damage = Math.floor(damage * (1 - pct / 100));

    const overrideReduction = beforeOverride - damage;
    if (overrideReduction > 0) {
      result.overrideReduction = overrideReduction;
      result.breakdown.push(`Override: -${overrideReduction} (flat ${flat}, ${pct}%)`);
    }
  }

  result.final = damage;
  return result;
}

/**
 * Calculate status buildup after immunities and overrides, check threshold trigger
 * @param {number} rawAmount - Raw buildup amount
 * @param {string} statusName - Bleed, Poison, Toxic, Frost, Curse, or Poise
 * @param {Actor} targetActor - Foundry Actor receiving buildup
 * @param {number} currentRound - Current combat round for once-per-round check
 * @returns {Object} Detailed result
 */
export function calculateStatusBuildup(rawAmount, statusName, targetActor, currentRound) {
  const result = {
    final: 0,
    raw: rawAmount,
    statusName,
    newTotal: 0,
    threshold: 0,
    triggered: false,
    triggerEffect: null,
    immune: false,
    blocked: false,
    conditionImmune: false,
    overrideReduction: 0,
    protectionReduction: 0,
    usedProtections: [],
    breakdown: []
  };

  if (rawAmount <= 0) return result;

  const settings = getActorCombatSettings(targetActor);

  // Status effect immunity
  if (settings.statusEffectImmunities[statusName]) {
    result.immune = true;
    result.breakdown.push(`Immune to ${statusName} buildup`);
    return result;
  }

  // Check if triggered condition is currently active (immune to further buildup)
  const triggeredCondition = STATUS_TRIGGER_MAP[statusName];
  if (triggeredCondition && isConditionActive(targetActor, triggeredCondition)) {
    result.blocked = true;
    result.breakdown.push(`${triggeredCondition} active — immune to ${statusName} buildup`);
    return result;
  }

  // Staggered blocks further Poise buildup
  if (statusName === 'Poise' && isConditionActive(targetActor, 'Staggered')) {
    result.blocked = true;
    result.breakdown.push('Staggered — immune to Poise buildup');
    return result;
  }

  // Once-per-round check
  const buildup = getActorStatusBuildup(targetActor);
  const statusData = buildup[statusName] || { current: 0, lastTriggeredRound: -1 };
  if (statusData.lastTriggeredRound === currentRound) {
    result.blocked = true;
    result.breakdown.push(`${statusName} already triggered this round`);
    return result;
  }

  // Apply override reductions (percentage first, then flat)
  let amount = rawAmount;
  const overrides = settings.overrides.statusBuildup[statusName];
  if (overrides) {
    const flat = parseInt(overrides.flatReduction) || 0;
    const pct = parseInt(overrides.percentReduction) || 0;
    const before = amount;
    // Percentage reduction applied first
    if (pct > 0) amount = Math.floor(amount * (1 - pct / 100));
    // Then flat reduction
    if (flat > 0) amount = Math.max(0, amount - flat);
    result.overrideReduction = before - amount;
    if (result.overrideReduction > 0) {
      result.breakdown.push(`Override: -${result.overrideReduction} (${pct}% then -${flat} flat)`);
    }
  }

  // CF4: Apply buildup protection
  // Note: Buildup has no tiers from character app (only thresholds)
  // Protection provides flat/dice/percentage reductions
  const protection = getBuildupProtectionForType(targetActor, statusName.toUpperCase());
  const hasInitialProt = protection.initial.flat > 0 || protection.initial.diceTotal > 0 || protection.initial.percentage > 0;
  const hasFinalProt = protection.final.flat > 0 || protection.final.diceTotal > 0 || protection.final.percentage > 0;

  if (hasInitialProt || hasFinalProt) {
    const beforeProt = amount;

    // INITIAL protection (Before Reductions - applied with/before overrides)
    if (hasInitialProt) {
      // 1. INITIAL percentage first
      if (protection.initial.percentage > 0) {
        const pctReduction = Math.floor(amount * protection.initial.percentage / 100);
        amount = amount - pctReduction;
        result.breakdown.push(`Protection %: -${pctReduction} (${protection.initial.percentage}%)`);
      }

      // 2. INITIAL flat + dice
      const initialFlat = (protection.initial.flat || 0) + (protection.initial.diceTotal || 0);
      if (initialFlat > 0) {
        const flatReduction = Math.min(amount, initialFlat);
        amount = Math.max(0, amount - initialFlat);
        if (flatReduction > 0) {
          const parts = [];
          if (protection.initial.flat > 0) parts.push(`flat ${protection.initial.flat}`);
          if (protection.initial.diceTotal > 0) parts.push(`dice ${protection.initial.diceTotal}`);
          result.breakdown.push(`Protection Flat: -${flatReduction} (${parts.join(', ')})`);
        }
      }
    }

    // FINAL protection (After Reductions - separate layer)
    if (hasFinalProt) {
      // 1. FINAL percentage first
      if (protection.final.percentage > 0) {
        const pctReduction = Math.floor(amount * protection.final.percentage / 100);
        amount = Math.max(0, amount - pctReduction);
        if (pctReduction > 0) {
          result.breakdown.push(`Protection % (after): -${pctReduction} (${protection.final.percentage}%)`);
        }
      }

      // 2. FINAL flat + dice
      const finalFlat = (protection.final.flat || 0) + (protection.final.diceTotal || 0);
      if (finalFlat > 0) {
        const flatReduction = Math.min(amount, finalFlat);
        amount = Math.max(0, amount - finalFlat);
        if (flatReduction > 0) {
          const parts = [];
          if (protection.final.flat > 0) parts.push(`flat ${protection.final.flat}`);
          if (protection.final.diceTotal > 0) parts.push(`dice ${protection.final.diceTotal}`);
          result.breakdown.push(`Protection Flat (after): -${flatReduction} (${parts.join(', ')})`);
        }
      }
    }

    result.protectionReduction = beforeProt - amount;
    result.usedProtections = protection.protections.map(p => p.id);
  }

  if (amount <= 0) {
    result.breakdown.push('Buildup reduced to 0 by overrides/protection');
    return result;
  }

  result.final = amount;
  const currentTotal = statusData.current || 0;
  result.newTotal = currentTotal + amount;

  // Check threshold
  const thresholds = getActorThresholds(targetActor);
  result.threshold = thresholds[statusName] || CONFIG.DEFAULT_THRESHOLDS[statusName] || 10;

  // Check if actor is immune to the triggered condition
  // If immune, cap buildup at threshold-1 (never triggers, no damage)
  const triggeredConditionName = STATUS_TRIGGER_MAP[statusName];
  if (triggeredConditionName && settings.statusConditionImmunities[triggeredConditionName]) {
    const maxBuildup = result.threshold - 1;
    if (result.newTotal > maxBuildup) {
      // Cap at threshold-1
      const cappedAmount = Math.max(0, maxBuildup - currentTotal);
      result.final = cappedAmount;
      result.newTotal = currentTotal + cappedAmount;
      result.conditionImmune = true;
      result.breakdown.push(`Immune to ${triggeredConditionName} — buildup capped at ${maxBuildup}`);
      return result;
    }
  }

  if (result.newTotal >= result.threshold) {
    result.triggered = true;
    result.triggerEffect = getStatusTriggerEffect(statusName);
    result.breakdown.push(`Threshold ${result.threshold} reached! ${statusName} triggers`);
  } else {
    result.breakdown.push(`${statusName}: ${currentTotal} + ${amount} = ${result.newTotal} / ${result.threshold}`);
  }

  return result;
}

/**
 * Calculate restoration (healing, FP/AP restore, buildup reduction, cures)
 * @param {Object} component - { type, amount, allowOverMax, statusEffect, conditions, statusEffects }
 * @param {Actor} targetActor - Actor receiving restoration
 * @returns {Object} Detailed result
 */
export function calculateRestoration(component, targetActor) {
  const type = component.type;
  const rawAmount = parseInt(component.amount) || 0;
  const settings = getActorCombatSettings(targetActor);
  const healingOverrides = settings.overrides.healing;

  const result = {
    type,
    raw: rawAmount,
    final: 0,
    capped: false,
    inverted: false,
    breakdown: []
  };

  if (type === 'heal-hp' || type === 'restore-fp' || type === 'restore-ap') {
    let amount = rawAmount;

    // Apply healing overrides (only for heal-hp, but extend to FP/AP for consistency)
    // Formula: roll + floor(roll * percentage/100) + flat
    if (type === 'heal-hp') {
      const pctMod = parseInt(healingOverrides.percentModifier) || 0;
      const flatBonus = parseInt(healingOverrides.flatBonus) || 0;
      const pctBonus = pctMod !== 0 ? Math.floor(amount * (pctMod / 100)) : 0;
      amount = amount + pctBonus + flatBonus;

      // Invert healing (becomes damage)
      if (healingOverrides.invertHealing) {
        result.inverted = true;
        result.final = -Math.abs(amount);
        result.breakdown.push(`Healing inverted — deals ${Math.abs(amount)} damage instead`);
        return result;
      }
    }

    // Cap at max if not allowOverMax
    if (!component.allowOverMax && targetActor) {
      const resourceKey = type === 'heal-hp' ? 'hp' : type === 'restore-fp' ? 'fp' : 'ap';
      const current = targetActor.system?.[resourceKey]?.value ?? 0;
      const max = targetActor.system?.[resourceKey]?.max ?? 0;
      const room = Math.max(0, max - current);
      if (amount > room) {
        amount = room;
        result.capped = true;
        result.breakdown.push(`Capped at ${amount} (${max} max - ${current} current)`);
      }
    }

    result.final = Math.max(0, amount);
    if (!result.capped) {
      result.breakdown.push(`${_restorationLabel(type)}: ${result.final}`);
    }
    return result;
  }

  if (type === 'reduce-buildup') {
    const statusName = component.statusEffect;
    const buildup = getActorStatusBuildup(targetActor);
    const current = buildup[statusName]?.current || 0;
    result.final = Math.min(rawAmount, current);
    result.breakdown.push(`Reduce ${statusName}: ${current} - ${result.final} = ${current - result.final}`);
    result.statusEffect = statusName;
    return result;
  }

  if (type === 'cure-condition') {
    result.conditions = component.conditions || [];
    result.breakdown.push(`Cure conditions: ${result.conditions.join(', ') || 'none'}`);
    return result;
  }

  if (type === 'cure-effect') {
    result.statusEffects = component.statusEffects || [];
    result.breakdown.push(`Cure effects: ${result.statusEffects.join(', ') || 'none'}`);
    return result;
  }

  return result;
}

function _restorationLabel(type) {
  const labels = {
    'heal-hp': 'Heal HP', 'restore-fp': 'Restore FP', 'restore-ap': 'Restore AP'
  };
  return labels[type] || type;
}

/**
 * Roll a DC check for a status condition
 * @param {number} dc - Base DC value
 * @param {number} bonus - Resolved bonus to add to DC
 * @param {Actor} targetActor - Actor making the save
 * @returns {Object} { roll, total, dc, totalDC, passed, bonusApplied }
 */
export async function rollStatusConditionDC(dc, bonus, targetActor) {
  const totalDC = dc + (bonus || 0);
  const roll = new Roll('1d20');
  await roll.evaluate();

  return {
    roll,
    rollTotal: roll.total,
    dc,
    bonus: bonus || 0,
    totalDC,
    passed: roll.total >= totalDC,
    breakdown: `1d20 (${roll.total}) vs DC ${totalDC}${bonus ? ` (${dc}+${bonus})` : ''} — ${roll.total >= totalDC ? 'PASS' : 'FAIL'}`
  };
}

/* ========================================
   Status Trigger Effects
   ======================================== */

/**
 * Get the triggered effect details for a status
 */
export function getStatusTriggerEffect(statusName) {
  const effects = {
    Bleed: {
      condition: 'BledOut',
      type: 'bleedOut',
      hpPercent: 20,
      description: 'Bled Out: 20% max HP as true damage. Next turn: spend 2 AP to staunch or take 10% max HP.'
    },
    Poison: {
      condition: 'Poisoned',
      type: 'dot',
      hpPercent: 5,
      duration: 10,
      description: 'Poisoned: 5% max HP true damage at turn start for 10 rounds.'
    },
    Toxic: {
      condition: 'BadlyPoisoned',
      type: 'dot',
      hpPercent: 10,
      duration: 10,
      description: 'Badly Poisoned: 10% max HP true damage at turn start for 10 rounds.'
    },
    Frost: {
      condition: 'Frostbitten',
      type: 'frostbitten',
      duration: 2,
      apReduction: 2,
      description: 'Frostbitten: All damage becomes TRUE for 2 rounds. Max AP reduced by 2. Poise recovery prevented.'
    },
    Curse: {
      condition: 'Cursed',
      type: 'curse',
      requiresRuling: true,
      setHPToZero: true,
      description: 'Cursed: GM ruling required. If approved, HP and Temp HP set to 0.'
    },
    Poise: {
      condition: 'Staggered',
      type: 'staggered',
      description: 'Staggered: Immune to further poise buildup until resolved.'
    }
  };
  return effects[statusName] || null;
}

/* ========================================
   Apply Functions
   ======================================== */

/**
 * Apply damage to an actor - returns update data for batching
 * @param {Actor} actor - Target actor
 * @param {number} amount - Final damage to apply (already calculated)
 * @param {string} damageType - For logging
 * @returns {Object} { updates, injured, dead, breakdown }
 */
export function applyDamageToActor(actor, amount, damageType) {
  if (!actor || amount === 0) return { updates: {}, injured: false, dead: false, breakdown: [] };

  // Handle negative amounts as healing (from tier 5+ resistance)
  if (amount < 0) {
    const healAmount = Math.abs(amount);
    const currentHP = actor.system?.hp?.value ?? 0;
    const maxHP = actor.system?.hp?.max ?? 0;
    const newHP = Math.min(maxHP, currentHP + healAmount);
    const actualHeal = newHP - currentHP;
    const breakdown = [`${damageType} Resistance Heal: ${currentHP} + ${actualHeal} = ${newHP} HP`];
    return {
      updates: { 'system.hp.value': newHP },
      injured: false,
      dead: false,
      breakdown,
      healed: actualHeal
    };
  }

  // FP drain — reduce FP instead of HP
  if (damageType === 'FP') {
    const currentFP = actor.system?.fp?.value ?? 0;
    const newFP = Math.max(0, currentFP - amount);
    const breakdown = [`FP Drain: ${currentFP} - ${amount} = ${newFP} FP`];
    return { updates: { 'system.fp.value': newFP }, injured: false, dead: false, breakdown };
  }

  // AP drain — reduce AP instead of HP
  if (damageType === 'AP') {
    const currentAP = actor.system?.ap?.value ?? 0;
    const newAP = Math.max(0, currentAP - amount);
    const breakdown = [`AP Drain: ${currentAP} - ${amount} = ${newAP} AP`];
    return { updates: { 'system.ap.value': newAP }, injured: false, dead: false, breakdown };
  }

  const currentHP = actor.system?.hp?.value ?? 0;
  const maxHP = actor.system?.hp?.max ?? 0;
  const currentTemp = actor.system?.hp?.temp ?? 0;
  const breakdown = [];
  const updates = {};

  let remainingDamage = amount;

  // Consume temp HP first
  if (currentTemp > 0 && remainingDamage > 0) {
    const tempConsumed = Math.min(currentTemp, remainingDamage);
    const newTemp = currentTemp - tempConsumed;
    remainingDamage -= tempConsumed;
    updates['system.hp.temp'] = newTemp;
    breakdown.push(`${damageType}: Temp HP ${currentTemp} - ${tempConsumed} = ${newTemp}`);
  }

  // Apply remaining damage to regular HP
  if (remainingDamage > 0) {
    const newHP = Math.max(0, currentHP - remainingDamage);
    updates['system.hp.value'] = newHP;
    breakdown.push(`${damageType}: HP ${currentHP} - ${remainingDamage} = ${newHP}`);
  } else if (currentTemp > 0) {
    // All damage absorbed by temp HP
    breakdown.push(`${damageType}: All ${amount} damage absorbed by Temp HP`);
  }

  const finalHP = updates['system.hp.value'] ?? currentHP;

  // Check Injured indicator (HP <= 50% max)
  const injured = maxHP > 0 && finalHP <= maxHP * CONFIG.COMBAT.INJURED_THRESHOLD && finalHP > 0;
  const dead = finalHP <= 0;

  if (injured) breakdown.push('Injured threshold reached');
  if (dead) breakdown.push('HP reduced to 0');

  return { updates, injured, dead, breakdown };
}

/**
 * Apply status buildup to an actor - returns update data for batching
 * @param {Actor} actor - Target actor
 * @param {string} statusName - Status effect name
 * @param {number} amount - Final buildup amount (already calculated)
 * @param {number} currentRound - Current combat round
 * @param {boolean} triggered - Whether threshold was reached
 * @returns {Object} { flagUpdates, conditionToApply, triggerEffect, breakdown }
 */
export function applyBuildupToActor(actor, statusName, amount, currentRound, triggered) {
  const buildup = getActorStatusBuildup(actor);
  const statusData = buildup[statusName] || { current: 0, lastTriggeredRound: -1 };
  const breakdown = [];
  let conditionToApply = null;
  let triggerEffect = null;

  const flagUpdates = {};
  const flagPath = `statusBuildup.${statusName}`;

  if (triggered) {
    // Reset buildup on trigger
    flagUpdates[`${flagPath}.current`] = 0;
    flagUpdates[`${flagPath}.lastTriggeredRound`] = currentRound;

    triggerEffect = getStatusTriggerEffect(statusName);
    conditionToApply = triggerEffect?.condition || null;

    breakdown.push(`${statusName} triggered! Buildup reset to 0.`);

    // Poise special tracking
    if (statusName === 'Poise') {
      flagUpdates[`${flagPath}.instanceCount`] = (statusData.instanceCount || 0) + 1;
      flagUpdates[`${flagPath}.totalDamage`] = (statusData.totalDamage || 0) + amount;
    }
  } else {
    flagUpdates[`${flagPath}.current`] = (statusData.current || 0) + amount;
    breakdown.push(`${statusName} buildup: ${statusData.current || 0} + ${amount} = ${(statusData.current || 0) + amount}`);

    // Poise instance tracking even when not triggered
    if (statusName === 'Poise') {
      flagUpdates[`${flagPath}.instanceCount`] = (statusData.instanceCount || 0) + 1;
      flagUpdates[`${flagPath}.totalDamage`] = (statusData.totalDamage || 0) + amount;
    }
  }

  return { flagUpdates, conditionToApply, triggerEffect, breakdown };
}

/**
 * Apply restoration to an actor - returns update data for batching
 * @param {Actor} actor - Target actor
 * @param {Object} calcResult - Result from calculateRestoration()
 * @returns {Object} { updates, flagUpdates, conditionsRemoved, effectsCleared, breakdown }
 */
export function applyRestorationToActor(actor, calcResult) {
  const updates = {};
  const flagUpdates = {};
  const conditionsRemoved = [];
  const effectsCleared = [];
  const breakdown = [];

  const type = calcResult.type;
  const amount = calcResult.final;

  if (type === 'heal-hp') {
    if (calcResult.inverted) {
      // Inverted healing = damage
      const currentHP = actor.system?.hp?.value ?? 0;
      updates['system.hp.value'] = Math.max(0, currentHP + amount); // amount is negative
      breakdown.push(`Inverted heal: ${currentHP} + (${amount}) = ${Math.max(0, currentHP + amount)} HP`);
    } else {
      const currentHP = actor.system?.hp?.value ?? 0;
      updates['system.hp.value'] = currentHP + amount;
      breakdown.push(`Heal HP: ${currentHP} + ${amount} = ${currentHP + amount}`);
    }
  }

  if (type === 'restore-fp') {
    const current = actor.system?.fp?.value ?? 0;
    updates['system.fp.value'] = current + amount;
    breakdown.push(`Restore FP: ${current} + ${amount} = ${current + amount}`);
  }

  if (type === 'restore-ap') {
    const current = actor.system?.ap?.value ?? 0;
    updates['system.ap.value'] = current + amount;
    breakdown.push(`Restore AP: ${current} + ${amount} = ${current + amount}`);
  }

  if (type === 'reduce-buildup' && calcResult.statusEffect) {
    const statusName = calcResult.statusEffect;
    const buildup = getActorStatusBuildup(actor);
    const current = buildup[statusName]?.current || 0;
    const newVal = Math.max(0, current - amount);
    flagUpdates[`statusBuildup.${statusName}.current`] = newVal;
    breakdown.push(`Reduce ${statusName}: ${current} - ${amount} = ${newVal}`);
  }

  if (type === 'cure-condition' && calcResult.conditions?.length > 0) {
    const activeConditions = getActorActiveConditions(actor);
    for (const cond of calcResult.conditions) {
      if (activeConditions[cond]?.active) {
        flagUpdates[`activeConditions.${cond}.active`] = false;
        flagUpdates[`activeConditions.${cond}.remainingRounds`] = 0;
        conditionsRemoved.push(cond);
      }
    }
    if (conditionsRemoved.length > 0) {
      breakdown.push(`Cured: ${conditionsRemoved.join(', ')}`);
    }
  }

  if (type === 'cure-effect' && calcResult.statusEffects?.length > 0) {
    for (const statusName of calcResult.statusEffects) {
      // Reset buildup
      flagUpdates[`statusBuildup.${statusName}.current`] = 0;
      // Remove triggered condition
      const triggeredCond = STATUS_TRIGGER_MAP[statusName];
      if (triggeredCond) {
        flagUpdates[`activeConditions.${triggeredCond}.active`] = false;
        flagUpdates[`activeConditions.${triggeredCond}.remainingRounds`] = 0;
        conditionsRemoved.push(triggeredCond);
      }
      effectsCleared.push(statusName);
    }
    if (effectsCleared.length > 0) {
      breakdown.push(`Cured effects: ${effectsCleared.join(', ')}`);
    }
  }

  return { updates, flagUpdates, conditionsRemoved, effectsCleared, breakdown };
}

/**
 * Apply a status condition to an actor - returns update data for batching
 * @param {Actor} actor - Target actor
 * @param {string} conditionName - Condition to apply
 * @param {number|null} duration - Rounds remaining (null = indefinite)
 * @param {number} appliedRound - Combat round when applied
 * @param {Object} options - Additional options
 * @param {number} options.stacks - Number of stacks to apply (for stackable conditions)
 * @param {boolean} options.stacking - If true, add stacks; if false, replace stacks
 * @returns {Object} { flagUpdates, applied, immune, breakdown }
 */
export function applyConditionToActor(actor, conditionName, duration, appliedRound, options = {}) {
  const settings = getActorCombatSettings(actor);
  const breakdown = [];
  const {
    stacks = 1,
    stacking = false,
    sourceId = 'unknown',
    sourceName = 'Unknown',
    casterId = 'unknown',
    casterName = 'Unknown'
  } = options;

  // Check condition immunity
  if (settings.statusConditionImmunities[conditionName]) {
    breakdown.push(`Immune to ${conditionName}`);
    return { flagUpdates: {}, applied: false, immune: true, breakdown };
  }

  // CF4: Check condition protection immunity
  const conditionProtection = hasConditionImmunityProtection(actor, conditionName);
  if (conditionProtection.immune) {
    breakdown.push(`Protected from ${conditionName} (${conditionProtection.protection.sourceName})`);
    return {
      flagUpdates: {},
      applied: false,
      immune: true,
      protectionUsed: conditionProtection.protection.id,
      breakdown
    };
  }

  const flagUpdates = {};

  // Check if this is a stackable condition (Frenzy, Exhaustion)
  const isStackableCondition = CONFIG.CONDITION_NUMBER_TYPE?.[conditionName] === 'stacks';

  if (isStackableCondition) {
    // Get existing condition data
    const existingConditions = actor.getFlag(CONFIG.MODULE_ID, 'activeConditions') || {};
    const existingCondition = existingConditions[conditionName] || {};
    const existingEntries = existingCondition.stackEntries || [];

    // New stack entry with source AND caster tracking
    // Both are tracked so the same macro used by different casters creates separate entries
    const newEntry = {
      stacks: stacks,
      remainingRounds: duration || null,
      appliedRound: appliedRound || 0,
      sourceId: sourceId,
      sourceName: sourceName,
      casterId: casterId,
      casterName: casterName
    };

    let newStackEntries;
    if (stacking) {
      // Always append new entry (stacking = true means "add more")
      newStackEntries = [...existingEntries, newEntry];
      breakdown.push(`${conditionName} +${stacks} stacks${duration ? ` (${duration} rounds)` : ''} [${casterName}: ${sourceName}]`);
    } else {
      // Non-stacking: replace only entries from the SAME source AND caster
      // This prevents Monster A's Rage from being wiped by Monster B's Rage (same macro, different caster)
      const otherEntries = existingEntries.filter(e => !(e.sourceId === sourceId && e.casterId === casterId));
      newStackEntries = [...otherEntries, newEntry];

      if (otherEntries.length < existingEntries.length) {
        breakdown.push(`${conditionName} refreshed ${stacks} stacks${duration ? ` (${duration} rounds)` : ''} [${casterName}: ${sourceName}]`);
      } else {
        breakdown.push(`${conditionName} ${stacks} stacks${duration ? ` (${duration} rounds)` : ''} [${casterName}: ${sourceName}]`);
      }
    }

    // Calculate total stacks
    const totalStacks = newStackEntries.reduce((sum, e) => sum + e.stacks, 0);

    flagUpdates[`activeConditions.${conditionName}`] = {
      active: true,
      stackEntries: newStackEntries,
      totalStacks: totalStacks
    };
  } else {
    // Non-stackable condition - original behavior
    flagUpdates[`activeConditions.${conditionName}`] = {
      active: true,
      remainingRounds: duration || null,
      appliedRound: appliedRound || 0
    };

    // Staggered grants poise buildup immunity
    if (conditionName === 'Staggered') {
      flagUpdates[`activeConditions.${conditionName}.immuneToPoise`] = true;
    }

    breakdown.push(`${conditionName} applied${duration ? ` (${duration} rounds)` : ' (indefinite)'}`);
  }

  return { flagUpdates, applied: true, immune: false, breakdown };
}

/**
 * Batch-apply all flag updates to an actor
 * Collects individual flagUpdates objects and writes them in one update call
 * @param {Actor} actor - Target actor
 * @param {Object} systemUpdates - Direct system data updates (hp, fp, ap)
 * @param {Object} flagUpdates - Nested flag path updates
 */
export async function commitActorUpdates(actor, systemUpdates = {}, flagUpdates = {}) {
  debug(`commitActorUpdates called for ${actor?.name}: system=${JSON.stringify(systemUpdates)}, flags=${JSON.stringify(flagUpdates)}`);
  if (!actor) {
    debug('No actor provided to commitActorUpdates');
    return;
  }

  const updateData = { ...systemUpdates };

  // Convert flag paths to Foundry update format (dot-notation)
  for (const [path, value] of Object.entries(flagUpdates)) {
    updateData[`flags.${MODULE}.${path}`] = value;
  }

  if (Object.keys(updateData).length > 0) {
    debug(`Calling actor.update with: ${JSON.stringify(updateData)}`);
    try {
      await actor.update(updateData);
      debug(`Successfully applied updates to "${actor.name}"`);
    } catch (err) {
      console.error(`Failed to update actor "${actor.name}":`, err);
    }
  } else {
    debug(`No updates to apply for "${actor.name}"`);
  }
}

/**
 * Build a formatted chat message for damage/combat results
 * @param {Object} results - Combined results from calculate functions
 * @returns {string} HTML string
 */
export function buildChatBreakdown(results) {
  const lines = [];

  if (results.damageResults?.length > 0) {
    for (const dmg of results.damageResults) {
      const color = CONFIG.DAMAGE_TYPE_COLORS[dmg.damageType] || '#c0c0c0';
      let line = `<span style="color:${color};font-weight:bold">${dmg.damageType}</span>: ${dmg.final}`;
      if (dmg.immune) line += ' (IMMUNE)';
      if (dmg.bypassed) line += ' (BYPASSED)';
      if (dmg.resistanceReduction > 0) line += ` <span style="color:#888">(-${dmg.resistanceReduction} resist)</span>`;
      if (dmg.overrideReduction > 0) line += ` <span style="color:#888">(-${dmg.overrideReduction} override)</span>`;
      lines.push(line);
    }
  }

  if (results.buildupResults?.length > 0) {
    for (const bu of results.buildupResults) {
      let line = `${bu.statusName}: +${bu.final}`;
      if (bu.triggered) line += ' <strong>TRIGGERED!</strong>';
      else line += ` (${bu.newTotal}/${bu.threshold})`;
      if (bu.immune) line = `${bu.statusName}: IMMUNE`;
      if (bu.blocked) line = `${bu.statusName}: BLOCKED`;
      lines.push(line);
    }
  }

  if (results.conditionResults?.length > 0) {
    for (const cond of results.conditionResults) {
      if (cond.immune) lines.push(`${cond.name}: IMMUNE`);
      else if (cond.applied) lines.push(`${cond.name} applied${cond.duration ? ` (${cond.duration} rnd)` : ''}`);
    }
  }

  if (results.restorationResults?.length > 0) {
    for (const rest of results.restorationResults) {
      lines.push(rest.breakdown.join(', '));
    }
  }

  return lines.map(l => `<div class="combat-breakdown-line">${l}</div>`).join('');
}