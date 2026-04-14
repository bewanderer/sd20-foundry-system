/**
 * Souls D20 Game System
 * Main entry point
 */

// Import system components
import { CONFIG as SD20_CONFIG } from './config.js';
import { SD20ActorSheet } from './sd20-actor-sheet.js';
import { BroadcastChannelManager } from './broadcastChannel.js';
import { log } from './utils.js';
import { registerTokenConfigTab } from './tokenConfig.js';
import { registerCharacterSyncHandlers } from './characterSync.js';
import { initializeStatusIndicator, destroyStatusIndicator } from './statusIndicator.js';
import { registerTurnIndicator, registerTurnIndicatorSettings } from './turnIndicator.js';
import { registerCombatTracker, registerCombatTrackerSettings } from './combatTracker.js';
import { registerMacroManager } from './macroManager.js';
import { registerMacroBar, registerMacroBarKeybindings, showMacroBar, closeMacroBar, getActiveMacroBar } from './macroBar.js';
import { buildApiObject } from './sd20Api.js';
import { registerCustomMacroBuilder } from './customMacroBuilder.js';
import { registerMacroBarControls, registerMacroBarControlSettings } from './macroBarControls.js';
import { registerAllMacrosManager } from './allMacrosManager.js';
import { registerLibrarySettings, registerMacroLibrary } from './macroLibrary.js';
import { registerMacroCopyDialog } from './macroCopyDialog.js';
import { registerTokenHUD } from './tokenHUD.js';
import { registerMovementTracker, registerMovementPreHook } from './movementTracker.js';
import { runMigration, registerMigrationSettings } from './migration.js';
import * as damageSystem from './damageSystem.js';
import { registerCombatSettings, openCombatSettings } from './combatSettings.js';
import { registerTokenStatusIcons, syncTokenStatusIcons, debugActorStatus, cleanupActorStatus } from './tokenStatusIcons.js';
import { registerStatusPanel } from './statusPanel.js';
import { registerTokenResourceBars } from './tokenResourceBars.js';
import * as threatSystem from './threatSystem.js';
import { registerRulingPanel, openRulingPanel, closeRulingPanel, toggleRulingPanel } from './rulingPanel.js';
import * as targetingSystem from './targetingSystem.js';
import { registerAoEGridHighlight } from './aoeGridHighlight.js';
import { registerAoERepeatUI } from './aoeRepeatUI.js';
import { registerAnimationSettings, initAnimationSystem, animationAPI } from './animationSystem.js';

// Initialize system
Hooks.once('init', () => {
  log('Initializing Souls D20 system...');

  // Set initiative formula: 1d20 + dexterity modifier
  CONFIG.Combat.initiative = {
    formula: '1d20 + @stats.dexterity.mod',
    decimals: 0
  };

  // Hide core turn marker with transparent image (replaced by custom PIXI glow ring)
  CONFIG.Combat.fallbackTurnMarker = 'systems/souls-d20/assets/turn-marker.png';

  // Replace Foundry's default status effects with SD20 conditions
  // These appear in the Token HUD right-click status effects panel
  // Note: These are visual-only for player use; actual tracking is in actor flags
  // IMPORTANT: Foundry V12+ uses 'img' instead of deprecated 'icon'
  CONFIG.statusEffects = [
    // Buildup statuses (different icons from their triggered conditions)
    { id: 'Bleed', name: 'Bleed', img: 'icons/svg/blood.svg' },
    { id: 'Poison', name: 'Poison', img: 'icons/svg/poison.svg' },
    { id: 'Toxic', name: 'Toxic', img: 'icons/svg/biohazard.svg' },
    { id: 'Frost', name: 'Frost', img: 'icons/svg/frozen.svg' },
    { id: 'Poise', name: 'Poise Damage', img: 'icons/svg/shield.svg' },
    // Triggered conditions (unique icons from their buildup sources)
    { id: 'BledOut', name: 'Bled Out', img: 'icons/svg/degen.svg' },
    { id: 'Poisoned', name: 'Poisoned', img: 'icons/svg/stoned.svg' },
    { id: 'BadlyPoisoned', name: 'Badly Poisoned', img: 'icons/svg/acid.svg' },
    { id: 'Frostbitten', name: 'Frostbitten', img: 'icons/svg/ice-shield.svg' },
    { id: 'Staggered', name: 'Staggered', img: 'icons/svg/unconscious.svg' },
    // Other conditions
    { id: 'Dazed', name: 'Dazed', img: 'icons/svg/daze.svg' },
    { id: 'Berserk', name: 'Berserk', img: 'icons/svg/fire.svg' },
    { id: 'Frenzy', name: 'Frenzy', img: 'icons/svg/terror.svg' },
    { id: 'Exhaustion', name: 'Exhaustion', img: 'icons/svg/sleep.svg' },
    { id: 'Grappled', name: 'Grappled', img: 'icons/svg/net.svg' },
    { id: 'Restrained', name: 'Restrained', img: 'icons/svg/padlock.svg' },
    { id: 'Prone', name: 'Prone', img: 'icons/svg/falling.svg' },
    { id: 'Mounting', name: 'Mounting', img: 'icons/svg/anchor.svg' },
    { id: 'ImpairedVision', name: 'Impaired Vision', img: 'icons/svg/blind.svg' },
    { id: 'Deafened', name: 'Deafened', img: 'icons/svg/deaf.svg' },
    { id: 'LimbFracture', name: 'Limb Fracture', img: 'icons/svg/bones.svg' },
    { id: 'LockedUp', name: 'Locked Up', img: 'icons/svg/paralysis.svg' },
    // Buffs
    { id: 'WeaponBuff1', name: 'Weapon Buff 1', img: 'icons/svg/sword.svg' },
    { id: 'WeaponBuff2', name: 'Weapon Buff 2', img: 'icons/svg/combat.svg' },
    { id: 'RestorationBuff', name: 'Restoration Buff', img: 'icons/svg/regen.svg' },
    { id: 'DefensiveBuff', name: 'Defensive Buff', img: 'icons/svg/aura.svg' },
    // Debuffs
    { id: 'DefenseDebuff', name: 'Defense Debuff', img: 'icons/svg/hazard.svg' },
    { id: 'OffenseDebuff', name: 'Offense Debuff', img: 'icons/svg/lightning.svg' },
    { id: 'RestorationDebuff', name: 'Restoration Debuff', img: 'icons/svg/radiation.svg' },
    // Manual visual-only statuses
    { id: 'SlowAction', name: 'Slow Action', img: 'icons/svg/clockwork.svg' },
    { id: 'Marked', name: 'Marked', img: 'icons/svg/target.svg' },
    { id: 'Hidden', name: 'Hidden', img: 'icons/svg/invisible.svg' },
    // Standard states
    { id: 'dead', name: 'Dead', img: 'icons/svg/skull.svg' }
  ];

  // Override combat sorting: delayed combatants go last among same initiative
  const OriginalCombat = CONFIG.Combat.documentClass;
  class SD20Combat extends OriginalCombat {
    _sortCombatants(a, b) {
      const initA = a.initiative ?? -Infinity;
      const initB = b.initiative ?? -Infinity;
      const initDiff = initB - initA;
      if (initDiff !== 0) return initDiff;

      // Same initiative: delayed combatants go last
      const aDelayed = a.getFlag('souls-d20', 'delayed') ? 1 : 0;
      const bDelayed = b.getFlag('souls-d20', 'delayed') ? 1 : 0;
      if (aDelayed !== bDelayed) return aDelayed - bDelayed;

      // Both delayed or both not: sort alphabetically
      return (a.name || '').localeCompare(b.name || '');
    }
  }
  CONFIG.Combat.documentClass = SD20Combat;

  // Register the actor sheet
  foundry.documents.collections.Actors.unregisterSheet('core', foundry.appv1.sheets.ActorSheet);
  foundry.documents.collections.Actors.registerSheet('souls-d20', SD20ActorSheet, { makeDefault: true });

  // Register Handlebars helpers
  Handlebars.registerHelper('json', function(context) {
    return JSON.stringify(context);
  });

  Handlebars.registerHelper('includes', function(array, value) {
    if (!Array.isArray(array)) return false;
    return array.includes(value);
  });

  Handlebars.registerHelper('or', function() {
    // Last argument is the Handlebars options object
    for (let i = 0; i < arguments.length - 1; i++) {
      if (arguments[i]) return true;
    }
    return false;
  });

  Handlebars.registerHelper('lt', function(a, b) {
    return a < b;
  });

  Handlebars.registerHelper('gte', function(a, b) {
    return a >= b;
  });

  Handlebars.registerHelper('lowercase', function(str) {
    return (str || '').toLowerCase();
  });

  Handlebars.registerHelper('percent', function(current, max) {
    if (!max || max <= 0) return 0;
    return Math.min(100, Math.max(0, (current / max) * 100));
  });

  // Format saveType for display (e.g., "stat:vitality" -> "Vitality", "skill:Athletics" -> "Athletics")
  Handlebars.registerHelper('formatSaveType', function(saveType) {
    if (!saveType) return '';
    const label = saveType.includes(':') ? saveType.split(':')[1] : saveType;
    return label.charAt(0).toUpperCase() + label.slice(1);
  });

  // Sum helper for adding multiple values (used in protection section counts)
  Handlebars.registerHelper('sum', function(...args) {
    // Last argument is the Handlebars options object, so exclude it
    return args.slice(0, -1).reduce((total, n) => total + (parseInt(n) || 0), 0);
  });

  // Register system settings
  game.settings.register('souls-d20', 'debugMode', {
    name: 'Debug Mode',
    hint: 'Enable verbose console logging for debugging',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false
  });

  // Register turn indicator settings
  registerTurnIndicatorSettings();

  // Register combat tracker settings
  registerCombatTrackerSettings();

  // Register macro bar keybindings (must be during init)
  registerMacroBarKeybindings();

  // Register macro bar control settings and hook (must be during init for getSceneControlButtons)
  registerMacroBarControlSettings();

  // Register macro library settings (must be during init)
  registerLibrarySettings();

  // Register migration settings
  registerMigrationSettings();

  // Register animation system settings
  registerAnimationSettings();

  // Register movement pre-hook early (needs to capture position before move)
  registerMovementPreHook();

  // Default new scenes to hex grid (type 4 = hex columns odd)
  Hooks.on('preCreateScene', (scene, data) => {
    if (data.grid?.type === undefined) {
      scene.updateSource({ 'grid.type': 4 });
    }
  });

  log('Souls D20 system initialized');
});

// Set up system when Foundry is ready
Hooks.once('ready', async () => {
  log('Souls D20 system ready');

  // Initialize system namespace
  game.sd20 = game.sd20 || {};
  game.sd20.characters = {};

  // Initialize BroadcastChannel communication
  game.sd20.broadcastChannel = new BroadcastChannelManager();

  // Register token config tab for character linking
  registerTokenConfigTab();

  // Register character sync handlers
  registerCharacterSyncHandlers();

  // Initialize connection status indicator
  initializeStatusIndicator();

  // Register combat tracker enhancements
  registerTurnIndicator();
  registerCombatTracker();

  // Register macro system
  registerMacroManager();
  registerMacroBar();
  registerCustomMacroBuilder();
  registerMacroBarControls();
  registerAllMacrosManager();
  registerMacroLibrary();
  registerMacroCopyDialog();
  registerTokenHUD();
  registerMovementTracker();
  registerCombatSettings();
  registerTokenStatusIcons();
  registerStatusPanel();
  registerTokenResourceBars();
  threatSystem.registerThreatSocket();
  registerRulingPanel();
  registerAoERepeatUI();
  registerAoEGridHighlight();

  // Initialize animation system (checks for Sequencer/JB2A)
  initAnimationSystem();

  // Expose utility functions for GM commands
  game.sd20.damageSystem = damageSystem;
  game.sd20.threatSystem = threatSystem;
  game.sd20.targetingSystem = targetingSystem;
  game.sd20.openCombatSettings = openCombatSettings;
  game.sd20.syncTokenStatusIcons = syncTokenStatusIcons;
  game.sd20.debugActorStatus = debugActorStatus; // Debug: inspect status flags
  game.sd20.cleanupActorStatus = cleanupActorStatus; // Clean up orphaned status data
  game.sd20.openRulingPanel = openRulingPanel;
  game.sd20.closeRulingPanel = closeRulingPanel;
  game.sd20.toggleRulingPanel = toggleRulingPanel;
  game.sd20.showMacroBar = showMacroBar;
  game.sd20.closeMacroBar = closeMacroBar;
  game.sd20.getActiveMacroBar = getActiveMacroBar;

  // Script API: functions available inside custom macro scripts via sd20.*
  game.sd20.api = buildApiObject();

  // Animation API: sd20.animation.*
  game.sd20.animation = animationAPI;

  // Run data migration if needed (flags -> system data)
  await runMigration();

  // ============================================================
  // ==================== TESTING ADDITION TO HOOK ==============
  // ============================================================
  log('BroadcastChannel initialized, waiting for SD20 App...');

  // Hide GM-only descriptions in chat messages for non-GM players
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (!game.user.isGM) {
      html.querySelectorAll('.macro-card-description.gm-only').forEach(node => node.remove());
    }
  });

  // Set NPC tokens to be unlinked by default (each token gets independent data)
  Hooks.on('preCreateActor', (actor) => {
    if (actor.type === 'npc') {
      // Set prototype token to unlinked so each placed token has independent data
      actor.updateSource({
        'prototypeToken.actorLink': false,
        'prototypeToken.appendNumber': true,
        'prototypeToken.prependAdjective': false
      });
      log(`Set NPC "${actor.name}" prototype token to unlinked`);
    }
  });

  // Hook to create default macros for NPCs on actor creation
  Hooks.on('createActor', async (actor, options, userId) => {
    // Only process if this is the user who created the actor
    if (game.user.id !== userId) return;
    // Only process NPC actors
    if (actor.type !== 'npc') return;
    // Skip if actor already has macro data
    if (actor.system?.macroSets || actor.getFlag('souls-d20', 'macroSets')) return;

    // Create default NPC macros for skill checks, stat checks, and initiative
    const defaultMacros = createDefaultNPCMacros();

    // Save to actor system data
    await actor.update({
      'system.macroSets': {
        activeSet: 'set-1',
        setOrder: ['set-1'],
        sets: {
          'set-1': {
            id: 'set-1',
            name: 'Default',
            macros: defaultMacros,
            active: true
          }
        }
      }
    });

    log(`Created default macros for NPC: ${actor.name}`);
  });

  // ============================================================
  // Unlinked Token Data Isolation
  // When an unlinked NPC token is created, copy actor data to token delta
  // This ensures the token is independent from base actor changes
  // ============================================================
  Hooks.on('createToken', async (tokenDoc, options, userId) => {
    // Only process for the user who created the token
    if (userId !== game.user.id) return;

    // Only process unlinked tokens
    if (tokenDoc.actorLink) return;

    // Only process NPC tokens
    const actor = tokenDoc.actor;
    if (!actor || actor.type !== 'npc') return;

    log(`Copying actor data to unlinked token: ${tokenDoc.name}`);

    const updateData = {};

    // Copy combat settings from actor flags
    const combatSettings = actor.getFlag(SD20_CONFIG.MODULE_ID, 'combatSettings');
    if (combatSettings) {
      updateData[`flags.${SD20_CONFIG.MODULE_ID}.combatSettings`] = foundry.utils.deepClone(combatSettings);
    }

    // Copy status thresholds
    const statusThresholds = actor.getFlag(SD20_CONFIG.MODULE_ID, 'combat.statusThresholds');
    if (statusThresholds) {
      updateData[`flags.${SD20_CONFIG.MODULE_ID}.combat.statusThresholds`] = foundry.utils.deepClone(statusThresholds);
    }

    // Copy macro sets from actor system data
    const macroSets = actor.system?.macroSets;
    if (macroSets) {
      updateData[`flags.${SD20_CONFIG.MODULE_ID}.macroSets`] = foundry.utils.deepClone(macroSets);
    }

    // Copy relevant system data to actorData delta (stats, skill bonuses, resistances)
    if (actor.system?.stats) {
      updateData['delta.system.stats'] = foundry.utils.deepClone(actor.system.stats);
    }
    if (actor.system?.skillBonuses) {
      updateData['delta.system.skillBonuses'] = foundry.utils.deepClone(actor.system.skillBonuses);
    }
    if (actor.system?.resistances) {
      updateData['delta.system.resistances'] = foundry.utils.deepClone(actor.system.resistances);
    }

    // Copy resources (HP, FP, AP) to delta for independent tracking per token
    if (actor.system?.hp) {
      updateData['delta.system.hp'] = foundry.utils.deepClone(actor.system.hp);
    }
    if (actor.system?.fp) {
      updateData['delta.system.fp'] = foundry.utils.deepClone(actor.system.fp);
    }
    if (actor.system?.ap) {
      updateData['delta.system.ap'] = foundry.utils.deepClone(actor.system.ap);
    }

    // Copy behavior notes for independent NPC behavior tracking
    const behaviorNotes = actor.getFlag(SD20_CONFIG.MODULE_ID, 'behaviorNotes');
    if (behaviorNotes) {
      updateData[`flags.${SD20_CONFIG.MODULE_ID}.behaviorNotes`] = behaviorNotes;
    }

    // Apply all queued updates
    if (Object.keys(updateData).length > 0) {
      await tokenDoc.update(updateData);
      log(`Unlinked token "${tokenDoc.name}" now has independent data`);
    }
  });
});

/**
 * Create default macro set for NPCs (skill checks, stat checks, initiative)
 */
function createDefaultNPCMacros() {
  const macros = [];
  let idx = 0;

  // Stats
  const stats = ['vitality', 'endurance', 'strength', 'dexterity', 'attunement', 'intelligence', 'faith'];

  // Skills with their stat formulas
  const skills = [
    { name: 'Athletics', stats: ['strength', 'endurance'] },
    { name: 'Acrobatics', stats: ['dexterity', 'endurance'] },
    { name: 'Perception', stats: ['intelligence', 'endurance'] },
    { name: 'FireKeeping', stats: ['faith', 'endurance'] },
    { name: 'Sanity', stats: ['strength', 'attunement'] },
    { name: 'Stealth', stats: ['dexterity', 'attunement'] },
    { name: 'Precision', stats: ['intelligence', 'attunement'] },
    { name: 'Diplomacy', stats: ['faith', 'attunement'] }
  ];

  // Initiative macro
  macros.push({
    id: `npc-init-${idx++}`,
    name: 'Initiative',
    icon: 'fa-solid fa-bolt',
    macroCategory: 'initiative',
    type: 'custom',
    simpleRoll: { diceCount: 1, diceSides: 20, bonus: 0 },
    dcBonus: 'stat:dexterity',
    source: 'custom'
  });

  // Stat check macros
  for (const stat of stats) {
    const displayName = stat.charAt(0).toUpperCase() + stat.slice(1);
    macros.push({
      id: `npc-stat-${idx++}`,
      name: `${displayName} Check`,
      icon: 'fa-solid fa-dice-d20',
      macroCategory: 'statChecks',
      type: 'custom',
      simpleRoll: { diceCount: 1, diceSides: 20, bonus: 0 },
      dcBonus: `stat:${stat}`,
      source: 'custom'
    });
  }

  // Skill check macros
  for (const skill of skills) {
    macros.push({
      id: `npc-skill-${idx++}`,
      name: skill.name,
      icon: 'fa-solid fa-person-running',
      macroCategory: 'skillChecks',
      type: 'custom',
      simpleRoll: { diceCount: 1, diceSides: 20, bonus: 0 },
      dcBonus: `skill:${skill.name}`,
      source: 'custom'
    });
  }

  return macros;
}

// Clean up on system shutdown
Hooks.once('close', () => {
  if (game.sd20?.broadcastChannel) {
    game.sd20.broadcastChannel.close();
  }
  destroyStatusIndicator();
  log('Souls D20 system closed');
});