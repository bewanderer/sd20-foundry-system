/**
 * Souls D20 Module Configuration
 */

export const CONFIG = {
  // Module metadata
  MODULE_ID: 'souls-d20',
  MODULE_NAME: 'Souls D20',

  // WebSocket relay server for cross-origin communication
  // Development: run "node sd20-relay-server.js" locally
  // Production: hosted on Railway
  WEBSOCKET_URL: 'wss://sd20-relay.up.railway.app',

  // Message types
  MESSAGE_TYPES: {
    // Foundry → App
    FOUNDRY_READY: 'foundry:ready',
    CHARACTER_REQUEST_ALL: 'characters:request-all',
    CHARACTER_REQUEST: 'character:request',
    CHARACTER_REQUEST_LINKED: 'characters:request-linked',  // Request specific linked UUIDs
    DAMAGE_APPLIED: 'combat:damage-applied',
    ACTION_PERFORMED: 'combat:action-performed',
    COMBAT_DATA_REQUEST: 'combat:request-data',

    // App → Foundry
    APP_HANDSHAKE: 'app:handshake',
    APP_HEARTBEAT: 'app:heartbeat',
    CHARACTER_RESPONSE_ALL: 'characters:response-all',
    CHARACTER_RESPONSE: 'character:response',
    CHARACTER_RESPONSE_LINKED: 'characters:response-linked',  // Response with linked character data
    CHARACTER_UPDATE: 'character:update',
    ACTION_VALIDATED: 'combat:action-validated',
    COMBAT_DATA_RESPONSE: 'combat:response-data',

    // Threat system (Foundry internal socket messages)
    THREAT_EVENT: 'combat:threat-event',
    DEFENDER_RESPONSE: 'combat:defender-response',
    RULING_RESULT: 'combat:ruling-result',
    CREATE_THREAT_EVENT: 'combat:create-threat-event',
    CREATE_RESTORATION_EVENT: 'combat:create-restoration-event',

    // GM proxy updates (for players without permission)
    GM_UPDATE_REQUEST: 'gm:update-request'
  },

  // Macro types
  MACRO_TYPES: {
    WEAPON_ATTACK: 'weapon-attack',
    SPELL: 'spell',
    SPIRIT: 'spirit',
    WEAPON_SKILL: 'weapon-skill',
    SKILL_CHECK: 'skill-check',
    CUSTOM: 'custom'
  },

  // Macro sources
  MACRO_SOURCES: {
    APP: 'app',
    CUSTOM: 'custom',
    TOGGLED: 'toggled'
  },

  // Scaling grade multipliers
  SCALING_GRADES: {
    'E': 0.5,
    'D': 1.0,
    'C': 1.5,
    'B': 2.0,
    'A': 2.5,
    'S': 3.0,
    'SS': 4.0,
    'SSS': 4.5
  },

  // Grade upgrade order (for two-handing bonus)
  GRADE_ORDER: ['E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'],

  // Scaling fractions (for manual scaling entries)
  SCALING_FRACTIONS: {
    'full': 1.0,
    'half': 0.5,
    'third': 0.33,
    'quarter': 0.25
  },

  // Stat abbreviations to full names mapping
  STAT_ABBREV_TO_FULL: {
    str: 'strength',
    dex: 'dexterity',
    vit: 'vitality',
    end: 'endurance',
    att: 'attunement',
    int: 'intelligence',
    fai: 'faith'
  },

  // Resource tracking
  RESOURCES: {
    HP: 'hp',
    FP: 'fp',
    AP: 'ap'
  },

  // Damage types
  DAMAGE_TYPES: {
    PHYSICAL: 'PHYSICAL',
    MAGIC: 'MAGIC',
    FIRE: 'FIRE',
    LIGHTNING: 'LIGHTNING',
    DARK: 'DARK',
    TRUE: 'TRUE',
    FP: 'FP',
    AP: 'AP'
  },

  // Damage type display colors for chat cards, tooltips, and ruling panel
  DAMAGE_TYPE_COLORS: {
    PHYSICAL: '#c0c0c0',
    MAGIC: '#7b68ee',
    FIRE: '#ff4500',
    LIGHTNING: '#ffd700',
    DARK: '#8b008b',
    TRUE: '#ffffff',
    FP: '#00bcd4',
    AP: '#ffab00'
  },

  // Status effect (buildup) display colors
  STATUS_EFFECT_COLORS: {
    Bleed: '#dc143c',     // Crimson red
    Poison: '#32cd32',    // Lime green
    Toxic: '#9400d3',     // Dark violet
    Frost: '#87ceeb',     // Sky blue
    Curse: '#4b0082',     // Indigo
    Poise: '#ffd700'      // Gold
  },

  // Restoration type display colors
  RESTORATION_COLORS: {
    'heal-hp': '#4caf50',       // Green (healing)
    'restore-fp': '#00bcd4',    // Cyan (FP color)
    'restore-ap': '#ffab00',    // Amber (AP color)
    'reduce-buildup': '#87ceeb', // Light blue
    'cure-condition': '#9c27b0', // Purple
    'cure-effect': '#e91e63'     // Pink
  },

  // Condition display colors (default purple for most)
  CONDITION_COLORS: {
    default: '#9c27b0',          // Purple
    Dazed: '#ffeb3b',            // Yellow (warning)
    Staggered: '#ff9800',        // Orange
    Frenzy: '#f44336',           // Red (danger)
    Berserk: '#b71c1c',          // Dark red
    Exhaustion: '#795548',       // Brown
    BledOut: '#dc143c',          // Crimson
    Poisoned: '#32cd32',         // Lime green
    BadlyPoisoned: '#9400d3',    // Dark violet
    Frostbitten: '#87ceeb',      // Sky blue
    Cursed: '#4b0082'            // Indigo
  },

  // Protection type colors (combines damage + status for protection display)
  PROTECTION_COLORS: {
    // Damage protections use damage colors
    PHYSICAL: '#c0c0c0',
    MAGIC: '#7b68ee',
    FIRE: '#ff4500',
    LIGHTNING: '#ffd700',
    DARK: '#8b008b',
    // Status buildup protections
    BLEED: '#dc143c',
    POISON: '#32cd32',
    TOXIC: '#9400d3',
    FROST: '#87ceeb',
    CURSE: '#4b0082',
    POISE: '#ffd700'
  },

  // Status effects (buildup system)
  STATUS_EFFECTS: {
    BLEED: 'Bleed',
    POISON: 'Poison',
    TOXIC: 'Toxic',
    FROST: 'Frost',
    CURSE: 'Curse',
    POISE: 'Poise'
  },

  // Status conditions (full list including effect-triggered ones)
  // Values are internal IDs used as keys elsewhere
  STATUS_CONDITIONS: {
    GRAPPLED: 'Grappled',
    RESTRAINED: 'Restrained',
    PRONE: 'Prone',
    MOUNTING: 'Mounting',
    IMPAIRED_VISION: 'ImpairedVision',
    DEAFENED: 'Deafened',
    DAZED: 'Dazed',
    LIMB_FRACTURE: 'LimbFracture',
    LOCKED_UP: 'LockedUp',
    STAGGERED: 'Staggered',
    FRENZY: 'Frenzy',
    BERSERK: 'Berserk',
    EXHAUSTION: 'Exhaustion',
    BLED_OUT: 'BledOut',
    POISONED: 'Poisoned',
    BADLY_POISONED: 'BadlyPoisoned',
    FROSTBITTEN: 'Frostbitten',
    CURSED: 'Cursed'
  },

  // Effect-triggered conditions (from buildup system) - should ONLY be cured via cure-effect
  // These conditions are triggered when buildup reaches threshold; cure-effect resets buildup too
  EFFECT_TRIGGERED_CONDITIONS: {
    BLED_OUT: 'BledOut',
    POISONED: 'Poisoned',
    BADLY_POISONED: 'BadlyPoisoned',
    FROSTBITTEN: 'Frostbitten',
    CURSED: 'Cursed',
    STAGGERED: 'Staggered'
  },

  // Curable conditions (for cure-condition) - excludes effect-triggered conditions
  // Use cure-effect for BledOut, Poisoned, BadlyPoisoned, Frostbitten, Cursed, Staggered
  CURABLE_CONDITIONS: {
    GRAPPLED: 'Grappled',
    RESTRAINED: 'Restrained',
    PRONE: 'Prone',
    MOUNTING: 'Mounting',
    IMPAIRED_VISION: 'ImpairedVision',
    DEAFENED: 'Deafened',
    DAZED: 'Dazed',
    LIMB_FRACTURE: 'LimbFracture',
    LOCKED_UP: 'LockedUp',
    FRENZY: 'Frenzy',
    BERSERK: 'Berserk',
    EXHAUSTION: 'Exhaustion'
  },

  // Display names for status conditions (human-readable)
  CONDITION_DISPLAY_NAMES: {
    Grappled: 'Grappled',
    Restrained: 'Restrained',
    Prone: 'Prone',
    Mounting: 'Mounting',
    ImpairedVision: 'Impaired Vision',
    Deafened: 'Deafened',
    Dazed: 'Dazed',
    LimbFracture: 'Limb Fracture',
    LockedUp: 'Locked Up',
    Staggered: 'Staggered',
    Frenzy: 'Frenzy',
    Berserk: 'Berserk',
    Exhaustion: 'Exhaustion',
    BledOut: 'Bled Out',
    Poisoned: 'Poisoned',
    BadlyPoisoned: 'Badly Poisoned',
    Frostbitten: 'Frostbitten',
    Cursed: 'Cursed'
  },

  // Special indicators (not conditions, just visual)
  INDICATORS: {
    INJURED: 'Injured'
  },

  // What each condition's number on the token icon represents
  CONDITION_NUMBER_TYPE: {
    Bleed: 'buildup', Poison: 'buildup', Toxic: 'buildup',
    Frost: 'buildup', Curse: 'buildup', Poise: 'buildup',
    Dazed: 'duration', Berserk: 'duration',
    Poisoned: 'duration', BadlyPoisoned: 'duration', Frostbitten: 'duration',
    Frenzy: 'stacks', Exhaustion: 'stacks'
  },

  // Restoration component types
  RESTORATION_TYPES: {
    HEAL_HP: 'heal-hp',
    RESTORE_FP: 'restore-fp',
    RESTORE_AP: 'restore-ap',
    REDUCE_BUILDUP: 'reduce-buildup',
    CURE_CONDITION: 'cure-condition',
    CURE_EFFECT: 'cure-effect'
  },

  // CF4: Protection damage types (TRUE excluded - bypasses all protection)
  PROTECTION_DAMAGE_TYPES: {
    PHYSICAL: 'PHYSICAL',
    MAGIC: 'MAGIC',
    FIRE: 'FIRE',
    LIGHTNING: 'LIGHTNING',
    DARK: 'DARK'
  },

  // CF4: Protection buildup types (same as STATUS_EFFECTS)
  PROTECTION_BUILDUP_TYPES: {
    BLEED: 'BLEED',
    POISON: 'POISON',
    TOXIC: 'TOXIC',
    FROST: 'FROST',
    CURSE: 'CURSE',
    POISE: 'POISE'
  },

  // CF4: Protection timing - controls how protection interacts with resistance
  // INITIAL (Before Reductions): Protection tiers/flat COMBINE with character resistance
  //   - This is the default and most natural behavior (armor stacks with buffs)
  //   - Percentage applied first, then combined tier+flat calculation
  // FINAL (After Reductions): Protection applies as SEPARATE layer after resistance
  //   - Use for temporary effects that shouldn't stack with armor
  PERCENTAGE_TIMING: {
    INITIAL: 'INITIAL',  // Combine with resistance (default)
    FINAL: 'FINAL'       // Separate layer after resistance
  },

  // CF4: Protection stacking behavior
  STACKING_BEHAVIOR: {
    APPEND: 'APPEND',
    OVERWRITE: 'OVERWRITE'
  },

  // Threat event component types
  COMPONENT_TYPES: {
    DAMAGE: 'damage',
    STATUS_BUILDUP: 'status-buildup',
    STATUS_CONDITION: 'status-condition',
    VULNERABILITY: 'vulnerability',
    HEAL_HP: 'heal-hp',
    RESTORE_FP: 'restore-fp',
    RESTORE_AP: 'restore-ap',
    REDUCE_BUILDUP: 'reduce-buildup',
    CURE_CONDITION: 'cure-condition',
    CURE_EFFECT: 'cure-effect',
    // CF4: Protection component types
    DAMAGE_PROTECTION: 'damage-protection',
    BUILDUP_PROTECTION: 'buildup-protection',
    CONDITION_PROTECTION: 'condition-protection'
  },

  // For ruling panel / chat color coding
  HARMFUL_COMPONENTS: ['damage', 'status-buildup', 'status-condition', 'vulnerability'],
  POSITIVE_COMPONENTS: ['heal-hp', 'restore-fp', 'restore-ap', 'reduce-buildup', 'cure-condition', 'cure-effect', 'damage-protection', 'buildup-protection', 'condition-protection'],

  // Ruling states for threat event components
  RULING_STATES: {
    PENDING: 'pending',
    APPROVED: 'approved',
    DENIED: 'denied',
    AUTO_SUCCEED: 'auto-succeed',
    AUTO_FAIL: 'auto-fail'
  },

  // Defender response states
  DEFENDER_RESPONSES: {
    PENDING: null,
    ACCEPT: 'accept',
    REACT: 'react'
  },

  // Default status thresholds when app data is not synced
  DEFAULT_THRESHOLDS: {
    Bleed: 10,
    Poison: 10,
    Toxic: 10,
    Frost: 10,
    Curse: 10,
    Poise: 5
  },

  // Default buildup state per status effect
  DEFAULT_BUILDUP: { current: 0, lastTriggeredRound: -1 },

  // Poise has extra tracking fields
  DEFAULT_POISE_BUILDUP: { current: 0, lastTriggeredRound: -1, instanceCount: 0, totalDamage: 0 },

  // Player resistance tier multipliers (tier 1=10%, 2=20%, 3=30% max)
  // Tiers beyond 3 overflow to flat reduction in the App
  TIER_MULTIPLIERS: {
    0: 1.0, 1: 0.90, 2: 0.80, 3: 0.70
  },

  // Monster resistance: 25% per tier, range -8 to +8
  // Positive tiers reduce damage, negative tiers increase damage
  // Tier 5+ (>100% reduction) causes healing instead of damage
  MONSTER_RESISTANCE: {
    TIER_MIN: -8,
    TIER_MAX: 8,
    PERCENT_PER_TIER: 25  // 25% reduction per tier
  },

  // Player resistance: 10%/20%/30% capped, with overflow to flat
  PLAYER_RESISTANCE: {
    TIER_MAX: 3,          // Max tier for percentage (30%)
    TIER_1_PERCENT: 10,
    TIER_2_PERCENT: 20,
    TIER_3_PERCENT: 30,
    OVERFLOW_TO_FLAT: true  // Tiers beyond 3 become flat reduction
  },

  // Combat settings
  COMBAT: {
    DEFAULT_AP: 8,
    WALK_AP_PER_HEX: 1,     // 1 hex (5ft) = 1 AP
    SPRINT_HEX_PER_AP: 2,   // 2 hexes (10ft) = 1 AP, ceil for odd
    MAX_UNDO_STACK: 10,
    DEFENDER_TIMEOUT: 60000, // 60s default for defender response popup
    INJURED_THRESHOLD: 0.5   // HP ratio for Injured indicator
  },

  // Macro bar categories - order determines display order and hotkey mapping (1-9, 0)
  MACRO_CATEGORIES: [
    { id: 'mainHand', name: 'Main Hand', icon: 'fa-solid fa-sword', hotkey: '1' },
    { id: 'offHand', name: 'Off Hand', icon: 'fa-solid fa-shield', hotkey: '2' },
    { id: 'sorcery', name: 'Sorcery', icon: 'fa-solid fa-staff', hotkey: '3' },
    { id: 'hex', name: 'Hex', icon: 'fa-solid fa-skull', hotkey: '4' },
    { id: 'miracle', name: 'Miracle', icon: 'fa-solid fa-sun', hotkey: '5' },
    { id: 'pyromancy', name: 'Pyromancy', icon: 'fa-solid fa-fire', hotkey: '6' },
    { id: 'spirits', name: 'Spirits', icon: 'fa-brands fa-phoenix-framework', hotkey: '7' },
    { id: 'skills', name: 'Skills', icon: 'fa-solid fa-hand', hotkey: '8' },
    { id: 'abilities', name: 'Abilities', icon: 'fa-solid fa-sparkles', hotkey: '9' },
    { id: 'initiative', name: 'Initiative', icon: 'fa-solid fa-bolt', hotkey: null },
    { id: 'skillChecks', name: 'Skill Checks', icon: 'fa-solid fa-dice-d20', hotkey: null },
    { id: 'knowledgeChecks', name: 'Knowledge', icon: 'fa-solid fa-book-open', hotkey: null },
    { id: 'statChecks', name: 'Stat Checks', icon: 'fa-solid fa-dumbbell', hotkey: null },
    { id: 'custom', name: 'Custom', icon: 'fa-solid fa-star', hotkey: '0' }
  ]
};
