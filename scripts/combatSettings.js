/**
 * Combat Settings Modal
 * Per-actor configuration for immunities, overrides, and recovery auras.
 * Stored on actor flags at flags.souls-d20.combatSettings.
 */

import { CONFIG } from './config.js';
import { getActorCombatSettings } from './damageSystem.js';
import { log } from './utils.js';
import { getActiveMacroBar } from './macroBar.js';

const { HandlebarsApplicationMixin, ApplicationV2, DialogV2 } = foundry.applications.api;

export class CombatSettingsDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    // Store token reference for unlinked token support
    this.token = options.token || null;
    // For unlinked tokens, save to the token document instead of the base actor
    this.isUnlinkedToken = this.token && !this.token.document.actorLink;

    // Default to Resources tab for NPCs, Immunities for PCs
    this._activeTab = actor.type === 'npc' ? 'resources' : 'immunities';
    // Pending edits (unsaved form state) - cleared on save/reset/close
    this._pendingSettings = null;
    this._pendingNPCResistances = null;
    this._pendingNPCStatusThresholds = null;
    this._pendingNPCStats = null;
    this._pendingNPCSkillBonuses = null;
    this._pendingNPCResources = null;
    this._pendingBehaviorNotes = null;
  }

  static DEFAULT_OPTIONS = {
    id: 'sd20-combat-settings',
    classes: ['sd20-combat-settings'],
    window: {
      title: 'Combat Settings',
      icon: 'fa-solid fa-shield-halved',
      resizable: true,
      minimizable: true
    },
    position: { width: 740, height: 620 }, // Numeric pixels required by ApplicationV2, but CSS rem override below
    actions: {
      switchTab: CombatSettingsDialog.#onSwitchTab,
      saveSettings: CombatSettingsDialog.#onSave,
      resetDefaults: CombatSettingsDialog.#onReset
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/combat-settings.html',
      scrollable: ['.cs-tab-body']
    }
  };

  get title() {
    return `Combat Settings — ${this.actor.name}`;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    if (!el) return;

    // Add event listeners for resource inputs (immediate save to actor)
    el.querySelectorAll('.cs-resource-input[data-resource]').forEach(input => {
      input.addEventListener('change', async (e) => {
        const resource = e.target.dataset.resource;
        const value = parseInt(e.target.value) || 0;
        const update = {};

        if (resource === 'hp') {
          const maxHP = this.actor.system.hp.max;
          if (value > maxHP) {
            // Overflow becomes Temp HP
            const overflow = value - maxHP;
            const currentTemp = this.actor.system.hp.temp || 0;
            update['system.hp.value'] = maxHP;
            update['system.hp.temp'] = currentTemp + overflow;
          } else {
            update['system.hp.value'] = Math.max(0, value);
          }
        } else if (resource === 'fp') {
          update['system.fp.value'] = Math.max(0, Math.min(value, this.actor.system.fp.max));
        } else if (resource === 'ap') {
          update['system.ap.value'] = Math.max(0, Math.min(value, this.actor.system.ap.max));
        } else if (resource === 'tempHP') {
          update['system.hp.temp'] = Math.max(0, value);
        }

        if (Object.keys(update).length > 0) {
          await this.actor.update(update);
          // Re-render to update the bar visuals
          this.render();
        }
      });
    });

    // Live updates for NPC stats -> skills (update skill totals in real-time)
    if (this.actor.type === 'npc') {
      this._setupLiveStatUpdates(el);
    }

    // Setup "All" checkbox locking for aura affects sections
    this._setupAllCheckboxLocking(el);
  }

  /**
   * Set up "All" checkbox behavior - when "All" is checked, disable/lock other checkboxes
   */
  _setupAllCheckboxLocking(el) {
    // Find all checkbox grids that have an "All" checkbox
    const allCheckboxes = el.querySelectorAll('input[name$=".all"]');

    allCheckboxes.forEach(allCb => {
      const grid = allCb.closest('.cs-checkbox-grid');
      if (!grid) return;

      // Get all other checkboxes in this grid (not the "All" one)
      const otherCheckboxes = grid.querySelectorAll('input[type="checkbox"]:not([name$=".all"])');

      // Function to update locked state
      const updateLocked = () => {
        const isAllChecked = allCb.checked;
        otherCheckboxes.forEach(cb => {
          cb.disabled = isAllChecked;
          // Clear other checkboxes when "All" is checked (All itself represents all being selected)
          // This provides a clean slate when "All" is unchecked
          if (isAllChecked) {
            cb.checked = false;
          }
          // Add visual styling for disabled state
          cb.closest('.cs-checkbox')?.classList.toggle('disabled', isAllChecked);
        });
      };

      // Initialize state on render
      updateLocked();

      // Listen for changes
      allCb.addEventListener('change', updateLocked);
    });
  }

  /**
   * Set up live update listeners for NPC stat and skill bonus inputs
   * Updates displayed skill totals and stat modifiers immediately on input
   */
  _setupLiveStatUpdates(el) {
    // Skill formulas: { skillName: [stat1, stat2] }
    const SKILL_FORMULAS = {
      Athletics: ['strength', 'endurance'],
      Acrobatics: ['dexterity', 'endurance'],
      Perception: ['intelligence', 'endurance'],
      FireKeeping: ['faith', 'endurance'],
      Sanity: ['strength', 'attunement'],
      Stealth: ['dexterity', 'attunement'],
      Precision: ['intelligence', 'attunement'],
      Diplomacy: ['faith', 'attunement']
    };

    // Helper: get stat value from input or default
    const getStatValue = (stat) => {
      const input = el.querySelector(`input[name="npcStat.${stat}"]`);
      return input ? (parseInt(input.value) || 10) : 10;
    };

    // Helper: compute stat mod
    const getStatMod = (stat) => Math.floor((getStatValue(stat) - 10) / 2);

    // Helper: get skill bonus from input
    const getSkillBonus = (skill) => {
      const input = el.querySelector(`input[name="npcSkillBonus.${skill}"]`);
      return input ? (parseInt(input.value) || 0) : 0;
    };

    // Helper: update all skill totals
    const updateAllSkills = () => {
      for (const [skill, [stat1, stat2]] of Object.entries(SKILL_FORMULAS)) {
        const total = getStatMod(stat1) + getStatMod(stat2) + getSkillBonus(skill);
        const totalEl = el.querySelector(`.cs-skill-row:has(input[name="npcSkillBonus.${skill}"]) .cs-skill-total`);
        if (totalEl) totalEl.textContent = `(${total})`;
      }
    };

    // Helper: update stat modifier display
    const updateStatMod = (stat) => {
      const mod = getStatMod(stat);
      const modEl = el.querySelector(`.cs-stat-row:has(input[name="npcStat.${stat}"]) .cs-stat-mod`);
      if (modEl) {
        modEl.textContent = (mod >= 0 ? '+' : '') + mod;
        modEl.classList.toggle('negative', mod < 0);
      }
    };

    // Listen for stat changes
    el.querySelectorAll('input[name^="npcStat."]').forEach(input => {
      input.addEventListener('input', (e) => {
        const stat = e.target.name.replace('npcStat.', '');
        updateStatMod(stat);
        updateAllSkills();
      });
    });

    // Listen for skill bonus changes
    el.querySelectorAll('input[name^="npcSkillBonus."]').forEach(input => {
      input.addEventListener('input', () => {
        updateAllSkills();
      });
    });
  }

  async _prepareContext(options) {
    // Use pending edits if available, otherwise load from actor
    const settings = this._pendingSettings ?? getActorCombatSettings(this.actor);
    const isNPC = this.actor.type === 'npc';

    // NPC resistance tiers - use pending if available
    const npcResistances = isNPC
      ? (this._pendingNPCResistances ?? this.actor.system.resistances)
      : null;

    // NPC status thresholds - stored at flags.souls-d20.combat.statusThresholds
    const npcStatusThresholds = isNPC
      ? (this._pendingNPCStatusThresholds ?? this.actor.getFlag(CONFIG.MODULE_ID, 'combat.statusThresholds') ?? { ...CONFIG.DEFAULT_THRESHOLDS })
      : null;

    // NPC stats - use pending if available, with computed mods
    let npcStats = null;
    let npcStatMods = null;
    let npcSkills = null;
    let npcSkillBonuses = null;
    if (isNPC) {
      // Get raw stats (pending or from actor)
      const rawStats = this._pendingNPCStats ?? this.actor.system.stats ?? {};
      npcStats = {
        vitality: rawStats.vitality?.value ?? rawStats.vitality ?? 10,
        endurance: rawStats.endurance?.value ?? rawStats.endurance ?? 10,
        strength: rawStats.strength?.value ?? rawStats.strength ?? 10,
        dexterity: rawStats.dexterity?.value ?? rawStats.dexterity ?? 10,
        attunement: rawStats.attunement?.value ?? rawStats.attunement ?? 10,
        intelligence: rawStats.intelligence?.value ?? rawStats.intelligence ?? 10,
        faith: rawStats.faith?.value ?? rawStats.faith ?? 10
      };

      // Compute stat mods: floor((stat - 10) / 2)
      npcStatMods = {};
      for (const [stat, val] of Object.entries(npcStats)) {
        npcStatMods[stat] = Math.floor((val - 10) / 2);
      }

      // Get skill bonuses (pending or from actor)
      npcSkillBonuses = this._pendingNPCSkillBonuses ?? this.actor.system.skillBonuses ?? {
        Athletics: 0, Acrobatics: 0, Perception: 0, FireKeeping: 0,
        Sanity: 0, Stealth: 0, Precision: 0, Diplomacy: 0
      };

      // Compute skills from mods + bonuses
      // Athletics = Str Mod + End Mod + Flat Bonus
      // Acrobatics = Dex Mod + End Mod + Flat Bonus
      // Perception = Int Mod + End Mod + Flat Bonus
      // Firekeeping = Fai Mod + End Mod + Flat Bonus
      // Sanity = Str Mod + Att Mod + Flat Bonus
      // Stealth = Dex Mod + Att Mod + Flat Bonus
      // Precision = Int Mod + Att Mod + Flat Bonus
      // Diplomacy = Fai Mod + Att Mod + Flat Bonus
      npcSkills = {
        Athletics: npcStatMods.strength + npcStatMods.endurance + (npcSkillBonuses.Athletics || 0),
        Acrobatics: npcStatMods.dexterity + npcStatMods.endurance + (npcSkillBonuses.Acrobatics || 0),
        Perception: npcStatMods.intelligence + npcStatMods.endurance + (npcSkillBonuses.Perception || 0),
        FireKeeping: npcStatMods.faith + npcStatMods.endurance + (npcSkillBonuses.FireKeeping || 0),
        Sanity: npcStatMods.strength + npcStatMods.attunement + (npcSkillBonuses.Sanity || 0),
        Stealth: npcStatMods.dexterity + npcStatMods.attunement + (npcSkillBonuses.Stealth || 0),
        Precision: npcStatMods.intelligence + npcStatMods.attunement + (npcSkillBonuses.Precision || 0),
        Diplomacy: npcStatMods.faith + npcStatMods.attunement + (npcSkillBonuses.Diplomacy || 0)
      };
    }

    // Resource values - use pending if available (for NPC Resources tab preservation across tabs)
    const pendingRes = this._pendingNPCResources;
    const hp = {
      value: pendingRes?.hp?.value ?? this.actor.system.hp?.value ?? 0,
      max: pendingRes?.hp?.max ?? this.actor.system.hp?.max ?? 1,
      temp: pendingRes?.hp?.temp ?? this.actor.system.hp?.temp ?? 0
    };
    const fp = {
      value: pendingRes?.fp?.value ?? this.actor.system.fp?.value ?? 0,
      max: pendingRes?.fp?.max ?? this.actor.system.fp?.max ?? 1
    };
    const ap = {
      value: pendingRes?.ap?.value ?? this.actor.system.ap?.value ?? 0,
      max: pendingRes?.ap?.max ?? this.actor.system.ap?.max ?? 1
    };

    // Resource bar percentages for Token UI tab
    const hpPercent = Math.min(100, Math.max(0, (hp.value / (hp.max || 1)) * 100));
    const fpPercent = Math.min(100, Math.max(0, (fp.value / (fp.max || 1)) * 100));
    const apPercent = Math.min(100, Math.max(0, (ap.value / (ap.max || 1)) * 100));
    const tempHP = hp.temp || 0;
    const tempHPPercent = Math.min(100 - hpPercent, Math.max(0, (tempHP / (hp.max || 1)) * 100));

    // Create actor-like object with pending resources for template
    const actorForTemplate = {
      ...this.actor,
      system: {
        ...this.actor.system,
        hp: hp,
        fp: fp,
        ap: ap
      }
    };

    // Behavior notes for NPCs (pending or from flag)
    const behaviorNotes = isNPC
      ? (this._pendingBehaviorNotes ?? this.actor.getFlag(CONFIG.MODULE_ID, 'behaviorNotes') ?? '')
      : '';

    return {
      activeTab: this._activeTab,
      settings,
      isNPC,
      isUnlinkedToken: this.isUnlinkedToken,
      npcResistances,
      npcStatusThresholds,
      npcStats,
      npcStatMods,
      npcSkills,
      npcSkillBonuses,
      behaviorNotes,
      resistanceTierMin: CONFIG.MONSTER_RESISTANCE.TIER_MIN,
      resistanceTierMax: CONFIG.MONSTER_RESISTANCE.TIER_MAX,
      damageTypes: Object.values(CONFIG.DAMAGE_TYPES).filter(t => t !== 'TRUE' && t !== 'FP' && t !== 'AP'),
      damageColors: CONFIG.DAMAGE_TYPE_COLORS,
      statusEffects: Object.values(CONFIG.STATUS_EFFECTS),
      statusConditions: Object.values(CONFIG.STATUS_CONDITIONS),
      actor: actorForTemplate,
      hpPercent,
      fpPercent,
      apPercent,
      tempHP,
      tempHPPercent
    };
  }

  // Read all form values into a settings object
  _readFormData() {
    const el = this.element;
    if (!el) return null;

    // Start with pending settings if available, otherwise load from actor
    // This preserves edits from other tabs
    const settings = this._pendingSettings
      ? JSON.parse(JSON.stringify(this._pendingSettings))  // Deep clone pending
      : getActorCombatSettings(this.actor);

    // Checkboxes for immunities and tokenUI
    el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const name = cb.name;
      if (!name) return;
      const parts = name.split('.');
      if (parts.length === 2) {
        // e.g. damageImmunities.Physical or tokenUI.showHP
        if (settings[parts[0]]) settings[parts[0]][parts[1]] = cb.checked;
      } else if (parts.length === 3) {
        // e.g. overrides.healing.invertHealing
        if (settings[parts[0]]?.[parts[1]]) settings[parts[0]][parts[1]][parts[2]] = cb.checked;
      } else if (parts.length === 4) {
        // e.g. overrides.statusRecovery.preventRecoveryTargets.Bleed
        // Initialize the targets object if needed
        if (!settings[parts[0]]) settings[parts[0]] = {};
        if (!settings[parts[0]][parts[1]]) settings[parts[0]][parts[1]] = {};
        if (!settings[parts[0]][parts[1]][parts[2]]) settings[parts[0]][parts[1]][parts[2]] = {};
        settings[parts[0]][parts[1]][parts[2]][parts[3]] = cb.checked;
      }
    });

    // Number inputs for overrides (skip npcResistance inputs)
    el.querySelectorAll('input[type="number"]').forEach(input => {
      const name = input.name;
      if (!name || name.startsWith('npcResistance.')) return;
      const parts = name.split('.');
      const val = parseFloat(input.value) || 0;
      if (parts.length === 3) {
        // e.g. overrides.healing.flatBonus
        if (settings[parts[0]]?.[parts[1]]) settings[parts[0]][parts[1]][parts[2]] = val;
      } else if (parts.length === 4) {
        // e.g. overrides.damage.Physical.flatReduction
        if (settings[parts[0]]?.[parts[1]]?.[parts[2]]) settings[parts[0]][parts[1]][parts[2]][parts[3]] = val;
      }
    });

    return settings;
  }

  // Read NPC resistance tier values from form
  _readNPCResistances() {
    const el = this.element;
    if (!el || this.actor.type !== 'npc') return null;

    // Start with pending resistances if available
    const resistances = this._pendingNPCResistances
      ? { ...this._pendingNPCResistances }
      : {};

    el.querySelectorAll('input[name^="npcResistance."]').forEach(input => {
      const type = input.name.replace('npcResistance.', '');
      const val = parseInt(input.value) || 0;
      // Clamp to valid range
      const clamped = Math.max(CONFIG.MONSTER_RESISTANCE.TIER_MIN, Math.min(CONFIG.MONSTER_RESISTANCE.TIER_MAX, val));
      resistances[type] = clamped;
    });

    return resistances;
  }

  // Read NPC resource values (HP/FP/AP max and current) from form
  _readNPCResources() {
    const el = this.element;
    if (!el || this.actor.type !== 'npc') return null;

    const resources = {};

    el.querySelectorAll('input[name^="npcResources."]').forEach(input => {
      const name = input.name.replace('npcResources.', '');
      const parts = name.split('.');
      const val = parseInt(input.value) || 0;

      if (parts.length === 2) {
        // e.g. hp.value, hp.max, fp.value, fp.max
        if (!resources[parts[0]]) resources[parts[0]] = {};
        resources[parts[0]][parts[1]] = Math.max(0, val);
      }
    });

    return resources;
  }

  // Read NPC status thresholds from form
  _readNPCStatusThresholds() {
    const el = this.element;
    if (!el || this.actor.type !== 'npc') return null;

    // Start with pending or defaults
    const thresholds = this._pendingNPCStatusThresholds
      ? { ...this._pendingNPCStatusThresholds }
      : { ...CONFIG.DEFAULT_THRESHOLDS };

    el.querySelectorAll('input[name^="npcThreshold."]').forEach(input => {
      const effect = input.name.replace('npcThreshold.', '');
      const val = parseInt(input.value) || 0;
      thresholds[effect] = Math.max(1, val); // Minimum threshold of 1
    });

    return thresholds;
  }

  // Read NPC stats from form
  _readNPCStats() {
    const el = this.element;
    if (!el || this.actor.type !== 'npc') return null;

    // Start with pending or defaults
    const stats = this._pendingNPCStats
      ? { ...this._pendingNPCStats }
      : { vitality: 10, endurance: 10, strength: 10, dexterity: 10, attunement: 10, intelligence: 10, faith: 10 };

    el.querySelectorAll('input[name^="npcStat."]').forEach(input => {
      const stat = input.name.replace('npcStat.', '');
      const val = parseInt(input.value) || 10;
      stats[stat] = Math.max(1, val); // Minimum stat of 1
    });

    return stats;
  }

  // Read NPC skill bonuses from form
  _readNPCSkillBonuses() {
    const el = this.element;
    if (!el || this.actor.type !== 'npc') return null;

    // Start with pending or defaults
    const bonuses = this._pendingNPCSkillBonuses
      ? { ...this._pendingNPCSkillBonuses }
      : { Athletics: 0, Acrobatics: 0, Perception: 0, FireKeeping: 0, Sanity: 0, Stealth: 0, Precision: 0, Diplomacy: 0 };

    el.querySelectorAll('input[name^="npcSkillBonus."]').forEach(input => {
      const skill = input.name.replace('npcSkillBonus.', '');
      const val = parseInt(input.value) || 0;
      bonuses[skill] = val;
    });

    return bonuses;
  }

  // Read behavior notes from form
  _readBehaviorNotes() {
    const el = this.element;
    if (!el || this.actor.type !== 'npc') return null;

    const textarea = el.querySelector('textarea[name="behaviorNotes"]');
    if (!textarea) return this._pendingBehaviorNotes ?? '';

    return textarea.value || '';
  }

  static #onSwitchTab(event, target) {
    const tab = target.dataset.tab;
    if (!tab || tab === this._activeTab) return;

    // Save current form state before switching tabs
    this._pendingSettings = this._readFormData();
    if (this.actor.type === 'npc') {
      this._pendingNPCResistances = this._readNPCResistances();
      this._pendingNPCStatusThresholds = this._readNPCStatusThresholds();
      this._pendingNPCStats = this._readNPCStats();
      this._pendingNPCSkillBonuses = this._readNPCSkillBonuses();
      this._pendingNPCResources = this._readNPCResources();
      this._pendingBehaviorNotes = this._readBehaviorNotes();
    }

    this._activeTab = tab;
    this.render();
  }

  static async #onSave() {
    const settings = this._readFormData();
    if (!settings) return;

    // For unlinked tokens, save to the token document's delta
    // For base actors (actor sheet), save to the actor directly
    if (this.isUnlinkedToken && this.token) {
      await this._saveToUnlinkedToken(settings);
    } else {
      await this._saveToActor(settings);
    }

    // Clear pending edits
    this._pendingSettings = null;
    this._pendingNPCResistances = null;
    this._pendingNPCStatusThresholds = null;
    this._pendingNPCStats = null;
    this._pendingNPCSkillBonuses = null;
    this._pendingNPCResources = null;
    this._pendingBehaviorNotes = null;

    log(`Combat settings saved for ${this.actor.name}${this.isUnlinkedToken ? ' (unlinked token)' : ''}`);
    ui.notifications.info(`Combat settings saved for ${this.actor.name}${this.isUnlinkedToken ? ' (token)' : ''}`);

    // Regenerate macros if macro bar is showing this token/actor
    const activeMacroBar = getActiveMacroBar();
    if (activeMacroBar) {
      // Check if the macro bar matches this token (for unlinked) or actor (for linked)
      const matchesToken = this.isUnlinkedToken && this.token && activeMacroBar.tokenId === this.token.id;
      const matchesActor = !this.isUnlinkedToken && activeMacroBar.actorId === this.actor.id;

      if (matchesToken || matchesActor) {
        // For NPCs without App link, regenerate macros to reflect new combat settings
        if (!activeMacroBar.characterUUID && this.actor.type === 'npc') {
          const token = this.token || canvas.tokens.get(activeMacroBar.tokenId);
          if (token) {
            await activeMacroBar._generateBasicMacrosForActor(token.actor, token, true);
          }
        }
        activeMacroBar.render();
      }
    }

    this.close();
  }

  /**
   * Save settings to the base actor (for actor sheets or linked tokens)
   */
  async _saveToActor(settings) {
    // Save combat settings to flags
    await this.actor.setFlag(CONFIG.MODULE_ID, 'combatSettings', settings);

    // Save NPC-specific data to system
    if (this.actor.type === 'npc') {
      const updateData = {};

      // Save resistance tiers
      const npcResistances = this._readNPCResistances();
      if (npcResistances) {
        updateData['system.resistances'] = npcResistances;
      }

      // Save resources (HP/FP/AP max and current values)
      const npcResources = this._readNPCResources();
      if (npcResources) {
        if (npcResources.hp) {
          if (npcResources.hp.max !== undefined) updateData['system.hp.max'] = npcResources.hp.max;
          if (npcResources.hp.value !== undefined) updateData['system.hp.value'] = Math.min(npcResources.hp.value, npcResources.hp.max || this.actor.system.hp.max);
          if (npcResources.hp.temp !== undefined) updateData['system.hp.temp'] = npcResources.hp.temp;
        }
        if (npcResources.fp) {
          if (npcResources.fp.max !== undefined) updateData['system.fp.max'] = npcResources.fp.max;
          if (npcResources.fp.value !== undefined) updateData['system.fp.value'] = Math.min(npcResources.fp.value, npcResources.fp.max || this.actor.system.fp.max);
        }
        if (npcResources.ap) {
          if (npcResources.ap.max !== undefined) updateData['system.ap.max'] = npcResources.ap.max;
          if (npcResources.ap.value !== undefined) updateData['system.ap.value'] = Math.min(npcResources.ap.value, npcResources.ap.max || this.actor.system.ap.max);
        }
      }

      // Save status thresholds to combat flags
      const npcStatusThresholds = this._readNPCStatusThresholds();
      if (npcStatusThresholds) {
        await this.actor.setFlag(CONFIG.MODULE_ID, 'combat.statusThresholds', npcStatusThresholds);
      }

      // Save stats to system.stats (with value and computed mod)
      const npcStats = this._readNPCStats();
      if (npcStats) {
        for (const [stat, val] of Object.entries(npcStats)) {
          updateData[`system.stats.${stat}.value`] = val;
          updateData[`system.stats.${stat}.mod`] = Math.floor((val - 10) / 2);
        }
      }

      // Save skill bonuses to system.skillBonuses
      const npcSkillBonuses = this._readNPCSkillBonuses();
      if (npcSkillBonuses) {
        updateData['system.skillBonuses'] = npcSkillBonuses;
      }

      // Save behavior notes to flag
      const behaviorNotes = this._readBehaviorNotes();
      if (behaviorNotes !== null) {
        await this.actor.setFlag(CONFIG.MODULE_ID, 'behaviorNotes', behaviorNotes);
      }

      if (Object.keys(updateData).length > 0) {
        await this.actor.update(updateData);
      }
    }
  }

  /**
   * Save settings to an unlinked token's document (delta data)
   */
  async _saveToUnlinkedToken(settings) {
    const tokenDoc = this.token.document;

    // Build update for token document's actorData delta
    const deltaUpdate = {};

    // Save combat settings to token delta flags
    // V13: Use delta.flags.* so synthetic actor can read via actor.getFlag()
    deltaUpdate[`delta.flags.${CONFIG.MODULE_ID}.combatSettings`] = settings;

    // Save NPC-specific data
    if (this.actor.type === 'npc') {
      // Save resistance tiers
      const npcResistances = this._readNPCResistances();
      if (npcResistances) {
        deltaUpdate['delta.system.resistances'] = npcResistances;
      }

      // Save resources (Foundry V13 uses delta.system.* for token deltas)
      const npcResources = this._readNPCResources();
      if (npcResources) {
        if (npcResources.hp) {
          if (npcResources.hp.max !== undefined) deltaUpdate['delta.system.hp.max'] = npcResources.hp.max;
          if (npcResources.hp.value !== undefined) deltaUpdate['delta.system.hp.value'] = Math.min(npcResources.hp.value, npcResources.hp.max || this.actor.system.hp.max);
          if (npcResources.hp.temp !== undefined) deltaUpdate['delta.system.hp.temp'] = npcResources.hp.temp;
        }
        if (npcResources.fp) {
          if (npcResources.fp.max !== undefined) deltaUpdate['delta.system.fp.max'] = npcResources.fp.max;
          if (npcResources.fp.value !== undefined) deltaUpdate['delta.system.fp.value'] = Math.min(npcResources.fp.value, npcResources.fp.max || this.actor.system.fp.max);
        }
        if (npcResources.ap) {
          if (npcResources.ap.max !== undefined) deltaUpdate['delta.system.ap.max'] = npcResources.ap.max;
          if (npcResources.ap.value !== undefined) deltaUpdate['delta.system.ap.value'] = Math.min(npcResources.ap.value, npcResources.ap.max || this.actor.system.ap.max);
        }
      }

      // Save status thresholds
      // V13: Use delta.flags.* so synthetic actor can read via actor.getFlag()
      const npcStatusThresholds = this._readNPCStatusThresholds();
      if (npcStatusThresholds) {
        deltaUpdate[`delta.flags.${CONFIG.MODULE_ID}.combat.statusThresholds`] = npcStatusThresholds;
      }

      // Save stats (Foundry V13 uses delta.system.* for token deltas)
      const npcStats = this._readNPCStats();
      if (npcStats) {
        for (const [stat, val] of Object.entries(npcStats)) {
          deltaUpdate[`delta.system.stats.${stat}.value`] = val;
          deltaUpdate[`delta.system.stats.${stat}.mod`] = Math.floor((val - 10) / 2);
        }
      }

      // Save skill bonuses
      const npcSkillBonuses = this._readNPCSkillBonuses();
      if (npcSkillBonuses) {
        deltaUpdate['delta.system.skillBonuses'] = npcSkillBonuses;
      }

      // Save behavior notes
      // V13: Use delta.flags.* so synthetic actor can read via actor.getFlag()
      const behaviorNotes = this._readBehaviorNotes();
      if (behaviorNotes !== null) {
        deltaUpdate[`delta.flags.${CONFIG.MODULE_ID}.behaviorNotes`] = behaviorNotes;
      }
    }

    // Apply all delta updates to the token document
    if (Object.keys(deltaUpdate).length > 0) {
      await tokenDoc.update(deltaUpdate);
    }
  }

  static async #onReset() {
    const confirmed = await DialogV2.confirm({
      window: { title: 'Reset Combat Settings' },
      content: `<p>Reset all combat settings for <strong>${this.actor.name}</strong> to defaults?</p>`,
      yes: { label: 'Reset', icon: 'fa-solid fa-rotate-left' },
      no: { label: 'Cancel' }
    });
    if (!confirmed) return;

    // Clear pending edits first
    this._pendingSettings = null;
    this._pendingNPCResistances = null;
    this._pendingNPCStatusThresholds = null;
    this._pendingNPCStats = null;
    this._pendingNPCSkillBonuses = null;
    this._pendingNPCResources = null;
    this._pendingBehaviorNotes = null;

    // Preserve tokenUI settings when resetting
    const currentSettings = getActorCombatSettings(this.actor);
    const preservedTokenUI = currentSettings.tokenUI;

    // Reset combat settings flag (removes all saved settings)
    await this.actor.unsetFlag(CONFIG.MODULE_ID, 'combatSettings');

    // Restore tokenUI settings (they should not reset)
    if (preservedTokenUI) {
      await this.actor.setFlag(CONFIG.MODULE_ID, 'combatSettings', { tokenUI: preservedTokenUI });
    }

    // For NPCs, also reset resistance tiers, stats, skill bonuses, and status thresholds
    if (this.actor.type === 'npc') {
      // Reset resistance tiers and stats
      const defaultStats = {
        vitality: { value: 10, mod: 0 },
        endurance: { value: 10, mod: 0 },
        strength: { value: 10, mod: 0 },
        dexterity: { value: 10, mod: 0 },
        attunement: { value: 10, mod: 0 },
        intelligence: { value: 10, mod: 0 },
        faith: { value: 10, mod: 0 }
      };
      const defaultSkillBonuses = {
        Athletics: 0, Acrobatics: 0, Perception: 0, FireKeeping: 0,
        Sanity: 0, Stealth: 0, Precision: 0, Diplomacy: 0
      };

      await this.actor.update({
        'system.resistances': {
          PHYSICAL: 0,
          MAGIC: 0,
          FIRE: 0,
          LIGHTNING: 0,
          DARK: 0
        },
        'system.stats': defaultStats,
        'system.skillBonuses': defaultSkillBonuses
      });

      // Reset status thresholds to defaults
      await this.actor.setFlag(CONFIG.MODULE_ID, 'combat.statusThresholds', { ...CONFIG.DEFAULT_THRESHOLDS });
    }

    log(`Combat settings reset for ${this.actor.name}`);
    ui.notifications.info(`Combat settings reset for ${this.actor.name}`);

    // Re-render to show default values
    this.render();
  }
}

// Singleton map: one dialog per actor/token
// Key is actor.id for linked tokens and actor sheets, or token.id for unlinked tokens
const openDialogs = new Map();

/**
 * Open the combat settings dialog for an actor
 * @param {Actor} actor - The actor (can be synthetic from token.actor)
 * @param {Token} [token] - Optional token reference. If provided and unlinked,
 *                          settings will be saved to the token document.
 */
export function openCombatSettings(actor, token = null) {
  if (!actor) return;

  // Determine if this is an unlinked token
  const isUnlinked = token && !token.document.actorLink;

  // Use token ID as key for unlinked tokens, actor ID otherwise
  const dialogKey = isUnlinked ? `token:${token.id}` : `actor:${actor.id}`;

  const existing = openDialogs.get(dialogKey);
  if (existing && existing.rendered) {
    existing.bringToFront();
    return;
  }

  const dialog = new CombatSettingsDialog(actor, { token });
  openDialogs.set(dialogKey, dialog);
  dialog.addEventListener('close', () => openDialogs.delete(dialogKey));
  dialog.render({ force: true });
}

/**
 * Register the combat settings entry point
 * Note: SD20ActorSheet has its own Combat Settings button in window controls.
 * Token-level access is via the token HUD (registered in tokenHUD.js).
 */
export function registerCombatSettings() {
  log('Combat settings registered');
}