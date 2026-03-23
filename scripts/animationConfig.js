/**
 * Animation Configuration
 * Default animation mappings for status effects and conditions.
 *
 * These use JB2A animation database keys. Users can customize these
 * or the system will gracefully skip if animations aren't found.
 *
 * Animation database keys format: "jb2a.category.subcategory.variant"
 * Full list available at: https://jb2a.com/Library_Preview/
 */

// ============================================================
// STATUS EFFECT ANIMATIONS
// ============================================================

/**
 * Default animations for status conditions
 * Key = condition name or "ConditionTick" for DoT animations
 */
export const STATUS_ANIMATIONS = {
  // ─────────────────────────────────────────────────────────
  // Buildup Threshold Triggers (play when condition activates)
  // ─────────────────────────────────────────────────────────

  BledOut: {
    file: 'jb2a.liquid.splash02.red',
    scale: 1.5,
    belowToken: false,
    description: 'Blood splash when Bleed threshold reached'
  },

  Poisoned: {
    file: 'jb2a.markers.poison.dark_green.02',
    scale: 1.2,
    belowToken: false,
    description: 'Poison marker when Poison threshold reached'
  },

  BadlyPoisoned: {
    file: 'jb2a.markers.poison.dark_green.01',
    scale: 1.4,
    belowToken: false,
    description: 'Poison marker when Toxic threshold reached'
  },

  Frostbitten: {
    file: 'jb2a.impact.frost.white.01',
    scale: 1.3,
    belowToken: false,
    description: 'Frost impact when Frost threshold reached'
  },

  Staggered: {
    file: 'jb2a.falling_rocks.top.1x1',
    scale: 1.0,
    belowToken: false,
    description: 'Falling rocks when Poise threshold reached'
  },

  Cursed: {
    file: 'jb2a.condition.curse.01.004.red',
    scale: 1.5,
    belowToken: false,
    description: 'Curse condition when Curse threshold reached (after GM approval)'
  },

  // ─────────────────────────────────────────────────────────
  // DoT Tick Animations (play at turn start for active DoTs)
  // These play rapidly when multiple ticks occur
  // ─────────────────────────────────────────────────────────

  PoisonedTick: {
    file: 'jb2a.markers.poison.dark_green.02',
    scale: 0.8,
    belowToken: false,
    rapidPlayback: true, // Multiple ticks play in duration of one
    description: 'Poison tick damage at turn start'
  },

  BadlyPoisonedTick: {
    file: 'jb2a.markers.poison.dark_green.01',
    scale: 1.0,
    belowToken: false,
    rapidPlayback: true,
    description: 'Bad poison tick damage at turn start'
  },

  // Staunch bleeding animation (when user doesn't staunch and takes damage)
  StaunchBleedingTick: {
    file: 'jb2a.liquid.splash02.red',
    scale: 1.0,
    belowToken: false,
    rapidPlayback: true,
    description: 'Bleeding damage when not staunched'
  },

  // ─────────────────────────────────────────────────────────
  // Other Conditions (if manually applied or via macro)
  // ─────────────────────────────────────────────────────────

  Dazed: {
    file: 'jb2a.dizzy_stars.200px.blueorange',
    scale: 1.0,
    belowToken: false,
    description: 'Stars when Dazed condition applied'
  },

  Prone: {
    file: 'jb2a.impact.ground_crack.white.01',
    scale: 0.8,
    belowToken: true,
    description: 'Ground impact when knocked Prone'
  }
};

// ============================================================
// DAMAGE TYPE ANIMATIONS (for macro builder defaults)
// ============================================================

/**
 * Suggested animations by damage type
 * Used as defaults when creating macros in the builder
 */
export const DAMAGE_TYPE_ANIMATIONS = {
  PHYSICAL: {
    impact: 'jb2a.melee_generic.slash.01.orange',
    description: 'Physical attack impact'
  },

  MAGIC: {
    projectile: 'jb2a.magic_missile.purple',
    impact: 'jb2a.impact.purple.01',
    description: 'Magic attack'
  },

  FIRE: {
    projectile: 'jb2a.fire_bolt.orange',
    impact: 'jb2a.explosion.01.orange',
    area: 'jb2a.ground_cracks.orange.01',
    description: 'Fire attack'
  },

  LIGHTNING: {
    projectile: 'jb2a.chain_lightning.primary.blue',
    impact: 'jb2a.static_electricity.01.blue',
    description: 'Lightning attack'
  },

  DARK: {
    projectile: 'jb2a.eldritch_blast.purple',
    impact: 'jb2a.impact.purple.01',
    description: 'Dark attack'
  },

  TRUE: {
    impact: 'jb2a.divine_smite.caster.dark_purple',
    description: 'True damage (bypasses all)'
  }
};

// ============================================================
// HEALING/RESTORATION ANIMATIONS
// ============================================================

export const RESTORATION_ANIMATIONS = {
  heal: {
    file: 'jb2a.healing_generic.200px.green',
    scale: 1.0,
    belowToken: false,
    description: 'HP healing effect'
  },

  cureCondition: {
    file: 'jb2a.healing_generic.200px.yellow',
    scale: 0.8,
    belowToken: false,
    description: 'Condition cure effect'
  },

  restoreFP: {
    file: 'jb2a.healing_generic.200px.blue',
    scale: 0.8,
    belowToken: false,
    description: 'FP restoration effect'
  }
};

// ============================================================
// ANIMATION PRESETS (for macro builder quick selection)
// ============================================================

/**
 * Pre-configured animation presets for common macro types
 * Users can select these in the Animation tab for quick setup
 */
export const ANIMATION_PRESETS = {
  'Melee Attack': {
    cast: null,
    projectile: null,
    impact: { file: 'jb2a.melee_generic.slash.01.orange', scale: 1.0 },
    area: null
  },

  'Ranged Attack': {
    cast: null,
    projectile: { file: 'jb2a.arrow.physical.white.01', scale: 1.0 },
    impact: { file: 'jb2a.impact.arrow.01', scale: 1.0 },
    area: null
  },

  'Fire Spell': {
    cast: { file: 'jb2a.magic_signs.circle.02.evocation.intro.red', scale: 1.0 },
    projectile: { file: 'jb2a.fire_bolt.orange', scale: 1.0 },
    impact: { file: 'jb2a.explosion.01.orange', scale: 1.2 },
    area: { file: 'jb2a.ground_cracks.orange.01', scale: 1.0 }
  },

  'Ice Spell': {
    cast: { file: 'jb2a.magic_signs.circle.02.evocation.intro.blue', scale: 1.0 },
    projectile: { file: 'jb2a.ray_of_frost.blue', scale: 1.0 },
    impact: { file: 'jb2a.impact.frost.blue.01', scale: 1.2 },
    area: null
  },

  'Lightning Spell': {
    cast: { file: 'jb2a.magic_signs.circle.02.evocation.intro.yellow', scale: 1.0 },
    projectile: { file: 'jb2a.chain_lightning.primary.blue', scale: 1.0 },
    impact: { file: 'jb2a.static_electricity.01.blue', scale: 1.2 },
    area: null
  },

  'Dark Magic': {
    cast: { file: 'jb2a.magic_signs.circle.02.necromancy.intro.dark_purple', scale: 1.0 },
    projectile: { file: 'jb2a.eldritch_blast.purple', scale: 1.0 },
    impact: { file: 'jb2a.impact.purple.01', scale: 1.2 },
    area: null
  },

  'Healing': {
    cast: { file: 'jb2a.magic_signs.circle.02.abjuration.intro.green', scale: 1.0 },
    projectile: null,
    impact: { file: 'jb2a.healing_generic.200px.green', scale: 1.0 },
    area: null
  },

  'Buff/Shield': {
    cast: { file: 'jb2a.magic_signs.circle.02.abjuration.intro.blue', scale: 1.0 },
    projectile: null,
    impact: { file: 'jb2a.shield.01.intro.blue', scale: 1.2 },
    area: null
  }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Get animation preset by name
 * @param {string} presetName - Preset name
 * @returns {Object|null} Animation configuration or null
 */
export function getAnimationPreset(presetName) {
  return ANIMATION_PRESETS[presetName] || null;
}

/**
 * Get suggested animations for a damage type
 * @param {string} damageType - Damage type (e.g., "FIRE", "PHYSICAL")
 * @returns {Object|null} Suggested animations or null
 */
export function getAnimationsForDamageType(damageType) {
  return DAMAGE_TYPE_ANIMATIONS[damageType?.toUpperCase()] || null;
}

/**
 * Get list of all preset names
 * @returns {string[]} Array of preset names
 */
export function getPresetNames() {
  return Object.keys(ANIMATION_PRESETS);
}
