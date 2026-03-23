/**
 * Status Panel
 * Displays and allows editing of status buildup and conditions for a token.
 *
 * Features:
 * - Two tabs: Buildup and Conditions
 * - Buildup tab: editable inputs for current/threshold
 * - Conditions tab: toggleable conditions with duration
 * - Permissions: owner can edit, GM can edit all, others view only
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';
import { syncTokenStatusIcons } from './tokenStatusIcons.js';
import {
  applyConditionToActor, commitActorUpdates, getStatusTriggerEffect, applyDamageToActor,
  getActorProtections, removeProtectionFromActor
} from './damageSystem.js';
import { refreshActorTokenBars } from './tokenResourceBars.js';
import { playStatusAnimation } from './animationSystem.js';

const MODULE = CONFIG.MODULE_ID;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Buildup status effects
const BUILDUP_EFFECTS = ['Bleed', 'Poison', 'Toxic', 'Frost', 'Curse', 'Poise'];

// Mapping of buildup effects to their triggered conditions
const BUILDUP_TO_CONDITION = {
  Bleed: 'BledOut',
  Poison: 'Poisoned',
  Toxic: 'BadlyPoisoned',
  Frost: 'Frostbitten',
  Poise: 'Staggered',
  Curse: 'Cursed'
};

// Reverse mapping: triggered condition -> originating buildup
// When a condition is removed, reset the buildup's lastTriggeredRound so it can accumulate again
const CONDITION_TO_BUILDUP = {
  BledOut: 'Bleed',
  Poisoned: 'Poison',
  BadlyPoisoned: 'Toxic',
  Frostbitten: 'Frost',
  Cursed: 'Curse',
  Staggered: 'Poise'
};

// Conditions that can be toggled
const CONDITIONS = Object.values(CONFIG.STATUS_CONDITIONS);

/**
 * Status Panel Application
 */
export class StatusPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(token, options = {}) {
    // Set unique ID per token to allow multiple panels open simultaneously
    super({ ...options, id: `sd20-status-panel-${token.id}` });
    this.token = token;
    this.actor = token.actor;
    this._activeTab = 'buildup';
    this._scrollPositions = { buildup: 0, conditions: 0, vulnerabilities: 0, protections: 0 };
    this._expandedStacks = new Set(); // Track which stack details panels are expanded
    this._expandedVulns = new Set(); // Track which vulnerability details panels are expanded
    this._expandedProts = new Set(); // CF4: Track which protection details panels are expanded

    // Bound click-outside handler for cleanup
    this._onClickOutside = this._handleClickOutside.bind(this);
  }

  /**
   * Handle clicks outside the panel - close if click is outside
   */
  _handleClickOutside(event) {
    if (!this.element) return;
    // Check if click is outside the panel element
    if (!this.element.contains(event.target)) {
      this.close();
    }
  }

  /**
   * Clean up when panel is closed
   */
  _onClose(options) {
    // Remove click-outside listener
    document.removeEventListener('pointerdown', this._onClickOutside);
    super._onClose?.(options);
  }

  static DEFAULT_OPTIONS = {
    // Note: id is set dynamically in constructor via options to be unique per token
    classes: ['sd20-status-panel'],
    window: {
      title: 'Status Panel',
      icon: 'fa-solid fa-bars-progress',
      resizable: false
    },
    position: { width: 320, height: 'auto' },
    actions: {
      switchTab: StatusPanel.#onSwitchTab,
      toggleCondition: StatusPanel.#onToggleCondition,
      toggleStackDetails: StatusPanel.#onToggleStackDetails,
      removeStackEntry: StatusPanel.#onRemoveStackEntry,
      resetBuildup: StatusPanel.#onResetBuildup,
      resetConditions: StatusPanel.#onResetConditions,
      toggleVulnDetails: StatusPanel.#onToggleVulnDetails,
      removeVulnerability: StatusPanel.#onRemoveVulnerability,
      resetVulnerabilities: StatusPanel.#onResetVulnerabilities,
      // CF4: Protection actions
      toggleProtDetails: StatusPanel.#onToggleProtDetails,
      removeProtection: StatusPanel.#onRemoveProtection,
      resetProtections: StatusPanel.#onResetProtections,
      close: StatusPanel.#onClose
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/status-panel.html'
    }
  };

  get title() {
    return `Status — ${this.token.name}`;
  }

  /**
   * Check if user can edit this panel
   */
  get canEdit() {
    if (game.user.isGM) return true;
    return this.actor?.isOwner || false;
  }

  /**
   * Save scroll positions and expanded states before re-render
   */
  _preRender(context, options) {
    super._preRender?.(context, options);
    const el = this.element;
    if (!el) return;

    // Save scroll position from the actual scrollable lists (they have overflow-y: auto)
    const buildupList = el.querySelector('.buildup-list');
    const conditionsList = el.querySelector('.conditions-list');
    const vulnsList = el.querySelector('.vulnerabilities-list');

    if (buildupList) {
      this._scrollPositions.buildup = buildupList.scrollTop;
    }
    if (conditionsList) {
      this._scrollPositions.conditions = conditionsList.scrollTop;
    }
    if (vulnsList) {
      this._scrollPositions.vulnerabilities = vulnsList.scrollTop;
    }

    // Save which stack details panels are expanded
    this._expandedStacks.clear();
    el.querySelectorAll('.stacks-details-panel:not(.hidden)').forEach(panel => {
      const condName = panel.dataset.conditionDetails;
      if (condName) this._expandedStacks.add(condName);
    });

    // Save which vulnerability details panels are expanded
    this._expandedVulns.clear();
    el.querySelectorAll('.vuln-details-panel:not(.hidden)').forEach(panel => {
      const vulnType = panel.dataset.vulnDetails;
      if (vulnType) this._expandedVulns.add(vulnType);
    });

    // CF4: Save protections scroll position
    const protsList = el.querySelector('.protections-list');
    if (protsList) {
      this._scrollPositions.protections = protsList.scrollTop;
    }

    // CF4: Save which protection details panels are expanded
    this._expandedProts.clear();
    el.querySelectorAll('.prot-details-panel:not(.hidden)').forEach(panel => {
      const protKey = panel.dataset.protDetails;
      if (protKey) this._expandedProts.add(protKey);
    });
  }

  async _prepareContext() {
    const actor = this.actor;
    if (!actor) return { hasData: false };

    const canEdit = this.canEdit;

    // Get buildup data
    const buildup = actor.getFlag(MODULE, 'statusBuildup') || {};
    const thresholds = actor.getFlag(MODULE, 'combat.statusThresholds') || CONFIG.DEFAULT_THRESHOLDS;

    // For owners/GMs: show all buildup effects
    // For non-owners: only show effects with current > 0
    let buildupData;
    if (canEdit) {
      buildupData = BUILDUP_EFFECTS.map(name => ({
        name,
        current: buildup[name]?.current || 0,
        threshold: thresholds[name] || CONFIG.DEFAULT_THRESHOLDS[name] || 100
      }));
    } else {
      // Non-owners only see active buildups (current > 0) with just the current value
      buildupData = BUILDUP_EFFECTS
        .filter(name => (buildup[name]?.current || 0) > 0)
        .map(name => ({
          name,
          current: buildup[name]?.current || 0,
          threshold: null // Hide threshold from non-owners
        }));
    }

    // Get conditions data
    const activeConditions = actor.getFlag(MODULE, 'activeConditions') || {};

    // For owners/GMs: show all conditions
    // For non-owners: only show active conditions
    // Boolean conditions (no duration/stacks display): Staggered, Cursed only
    // Stackable conditions (show stacks): Frenzy, Exhaustion
    // All other conditions: show duration
    const BOOLEAN_CONDITIONS = ['Staggered', 'Cursed'];
    const STACKABLE_CONDITIONS = ['Frenzy', 'Exhaustion'];
    const mapCondition = (name) => {
      const condData = activeConditions[name] || {};
      const isStackable = STACKABLE_CONDITIONS.includes(name);
      const isBoolean = BOOLEAN_CONDITIONS.includes(name);
      return {
        name,
        active: condData.active || false,
        duration: condData.remainingRounds ?? null,
        totalStacks: condData.totalStacks ?? null,
        stackEntries: condData.stackEntries ?? null,
        isStackable,
        showDuration: !isStackable && !isBoolean,
        showStacks: isStackable
      };
    };

    let conditionsData;
    if (canEdit) {
      conditionsData = CONDITIONS.map(mapCondition);
    } else {
      // Non-owners only see active conditions
      conditionsData = CONDITIONS
        .filter(name => activeConditions[name]?.active)
        .map(mapCondition);
    }

    // For canEdit users, always show the full list
    // For non-owners, only show if there's something active
    const showBuildupList = canEdit || buildupData.length > 0;
    const showConditionsList = canEdit || conditionsData.length > 0;

    // Get vulnerabilities data - group by damage type
    const vulns = actor.getFlag(MODULE, 'vulnerabilities') || [];

    const vulnsByType = {};
    for (const v of vulns) {
      if (!vulnsByType[v.type]) {
        vulnsByType[v.type] = {
          type: v.type,
          color: CONFIG.DAMAGE_TYPE_COLORS[v.type] || '#fff',
          entries: [],
          totalTiers: 0
        };
      }
      // Add source name from actor if available
      const sourceActor = game.actors?.get(v.sourceActorId);
      vulnsByType[v.type].entries.push({
        ...v,
        sourceName: sourceActor?.name || v.sourceActorId || 'Unknown'
      });
      vulnsByType[v.type].totalTiers += v.tiers || 0;
    }

    const vulnerabilitiesData = Object.values(vulnsByType);
    const showVulnerabilitiesList = canEdit || vulnerabilitiesData.length > 0;

    // CF4: Get protections data - group by type
    const protections = getActorProtections(actor);

    // Group damage protections by type
    const damageProtByType = {};
    for (const p of (protections.damage || [])) {
      if (!damageProtByType[p.type]) {
        damageProtByType[p.type] = {
          type: p.type,
          color: CONFIG.PROTECTION_COLORS[p.type] || '#fff',
          entries: [],
          totalTiers: 0,
          totalFlat: 0
        };
      }
      damageProtByType[p.type].entries.push({
        ...p,
        sourceName: p.sourceName || 'Unknown'
      });
      damageProtByType[p.type].totalTiers += p.tiers || 0;
      damageProtByType[p.type].totalFlat += p.flat || 0;
    }

    // Group buildup protections by type
    const buildupProtByType = {};
    for (const p of (protections.buildup || [])) {
      if (!buildupProtByType[p.type]) {
        buildupProtByType[p.type] = {
          type: p.type,
          color: CONFIG.PROTECTION_COLORS[p.type] || '#fff',
          entries: [],
          totalFlat: 0
        };
      }
      buildupProtByType[p.type].entries.push({
        ...p,
        sourceName: p.sourceName || 'Unknown'
      });
      buildupProtByType[p.type].totalFlat += p.flat || 0;
    }

    // Group condition protections
    const conditionProtByType = {};
    for (const p of (protections.condition || [])) {
      if (!conditionProtByType[p.condition]) {
        conditionProtByType[p.condition] = {
          condition: p.condition,
          entries: []
        };
      }
      conditionProtByType[p.condition].entries.push({
        ...p,
        sourceName: p.sourceName || 'Unknown'
      });
    }

    const protectionsData = {
      damage: Object.values(damageProtByType),
      buildup: Object.values(buildupProtByType),
      condition: Object.values(conditionProtByType)
    };
    const hasAnyProtection = protectionsData.damage.length > 0 ||
                             protectionsData.buildup.length > 0 ||
                             protectionsData.condition.length > 0;
    const showProtectionsList = canEdit || hasAnyProtection;

    return {
      hasData: true,
      activeTab: this._activeTab,
      canEdit,
      buildup: buildupData,
      conditions: conditionsData,
      vulnerabilities: vulnerabilitiesData,
      protections: protectionsData,
      tokenId: this.token.id,
      showBuildupList,
      showConditionsList,
      showVulnerabilitiesList,
      showProtectionsList
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    if (!el) return;

    // Add click-outside-to-close listener (with delay to avoid closing from the opening click)
    // Remove any existing listener first to avoid duplicates on re-render
    document.removeEventListener('pointerdown', this._onClickOutside);
    setTimeout(() => {
      document.addEventListener('pointerdown', this._onClickOutside);
    }, 100);

    // Restore scroll position to the actual scrollable lists
    const buildupList = el.querySelector('.buildup-list');
    const conditionsList = el.querySelector('.conditions-list');
    const vulnsList = el.querySelector('.vulnerabilities-list');

    if (buildupList && this._scrollPositions.buildup !== undefined) {
      buildupList.scrollTop = this._scrollPositions.buildup;
      requestAnimationFrame(() => {
        buildupList.scrollTop = this._scrollPositions.buildup;
      });
    }

    if (conditionsList && this._scrollPositions.conditions !== undefined) {
      conditionsList.scrollTop = this._scrollPositions.conditions;
      requestAnimationFrame(() => {
        conditionsList.scrollTop = this._scrollPositions.conditions;
      });
    }

    if (vulnsList && this._scrollPositions.vulnerabilities !== undefined) {
      vulnsList.scrollTop = this._scrollPositions.vulnerabilities;
      requestAnimationFrame(() => {
        vulnsList.scrollTop = this._scrollPositions.vulnerabilities;
      });
    }

    // Restore expanded stack details panels
    for (const condName of this._expandedStacks) {
      const panel = el.querySelector(`.stacks-details-panel[data-condition-details="${condName}"]`);
      const btn = el.querySelector(`.stacks-expand-btn[data-condition="${condName}"]`);
      if (panel) {
        panel.classList.remove('hidden');
        // Update chevron icon
        const chevron = btn?.querySelector('i');
        if (chevron) {
          chevron.classList.remove('fa-chevron-right');
          chevron.classList.add('fa-chevron-down');
        }
      }
    }

    // Restore expanded vulnerability details panels
    for (const vulnType of this._expandedVulns) {
      const panel = el.querySelector(`.vuln-details-panel[data-vuln-details="${vulnType}"]`);
      const btn = el.querySelector(`.vuln-expand-btn[data-vuln-type="${vulnType}"]`);
      if (panel) {
        panel.classList.remove('hidden');
        // Update chevron icon
        const chevron = btn?.querySelector('i');
        if (chevron) {
          chevron.classList.remove('fa-chevron-right');
          chevron.classList.add('fa-chevron-down');
        }
      }
    }

    // CF4: Restore protections scroll position
    const protsList = el.querySelector('.protections-list');
    if (protsList && this._scrollPositions.protections !== undefined) {
      protsList.scrollTop = this._scrollPositions.protections;
      requestAnimationFrame(() => {
        protsList.scrollTop = this._scrollPositions.protections;
      });
    }

    // CF4: Restore expanded protection details panels
    for (const protKey of this._expandedProts) {
      const panel = el.querySelector(`.prot-details-panel[data-prot-details="${protKey}"]`);
      const btn = el.querySelector(`.prot-expand-btn[data-prot-key="${protKey}"]`);
      if (panel) {
        panel.classList.remove('hidden');
        // Update chevron icon
        const chevron = btn?.querySelector('i');
        if (chevron) {
          chevron.classList.remove('fa-chevron-right');
          chevron.classList.add('fa-chevron-down');
        }
      }
    }

    if (!this.canEdit) return;

    // Add change listeners for buildup inputs
    el.querySelectorAll('.buildup-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const name = e.target.dataset.effect;
        const value = parseInt(e.target.value) || 0;
        await this._updateBuildup(name, Math.max(0, value));
      });
    });

    // Add change listeners for condition duration inputs
    el.querySelectorAll('.condition-duration-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const name = e.target.dataset.condition;
        const value = e.target.value === '' ? null : parseInt(e.target.value);
        await this._updateConditionDuration(name, value);
      });
    });

    // Add change listeners for stack entry inputs (stacks and duration)
    el.querySelectorAll('.stack-entry-stacks-input, .stack-entry-duration-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const conditionName = e.target.dataset.condition;
        const entryIndex = parseInt(e.target.dataset.entryIndex);
        const field = e.target.dataset.field;
        const value = e.target.value === '' ? null : parseInt(e.target.value);
        await this._updateStackEntry(conditionName, entryIndex, field, value);
      });
    });

    // Add change listeners for vulnerability entry inputs (tiers and duration)
    el.querySelectorAll('.vuln-entry-tiers-input, .vuln-entry-duration-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const vulnId = e.target.dataset.vulnId;
        const field = e.target.dataset.field;
        const value = parseInt(e.target.value) || 0;
        await this._updateVulnerability(vulnId, field, value);
      });
    });

    // CF4: Add change listeners for protection entry inputs
    el.querySelectorAll('.prot-entry-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        const protId = e.target.dataset.protId;
        const protCategory = e.target.dataset.protCategory; // 'damage', 'buildup', or 'condition'
        const field = e.target.dataset.field;
        const value = parseInt(e.target.value) || 0;
        await this._updateProtection(protCategory, protId, field, value);
      });
    });
  }

  /**
   * Update a buildup value
   * If value >= threshold, triggers the full event pipeline (condition + trigger damage)
   */
  async _updateBuildup(effectName, value) {
    if (!this.canEdit || !this.actor) return;

    const actor = this.actor;
    const thresholds = actor.getFlag(MODULE, 'combat.statusThresholds') || CONFIG.DEFAULT_THRESHOLDS;
    const threshold = thresholds[effectName] || CONFIG.DEFAULT_THRESHOLDS[effectName] || 100;

    // Capture the previous value before any changes (for revert on GM denial)
    const currentBuildup = actor.getFlag(MODULE, 'statusBuildup') || {};
    const previousValue = currentBuildup[effectName]?.current || 0;

    // Check if buildup reaches or exceeds threshold - trigger full event pipeline
    if (value >= threshold) {
      const conditionName = BUILDUP_TO_CONDITION[effectName];
      if (conditionName) {
        const conditions = actor.getFlag(MODULE, 'activeConditions') || {};
        // Only trigger if not already active
        if (!conditions[conditionName]?.active) {
          // Get trigger effect data (includes damage, duration, etc.)
          const triggerEffect = getStatusTriggerEffect(effectName);

          // If requiresRuling, show confirmation dialog to GM
          if (triggerEffect?.requiresRuling) {
            const approved = await this._showRulingDialog(effectName, conditionName, triggerEffect, actor);
            if (!approved) {
              // GM denied - revert to previous value (before the change that exceeded threshold)
              // Re-render the panel to show the reverted value
              this.render();
              syncTokenStatusIcons(this.token);
              log(`${effectName} threshold reached but GM denied ruling for ${actor.name} - reverted to ${previousValue}`);
              return;
            }
          }

          const currentRound = game.combat?.round || 0;

          // Apply condition through the proper system
          const condResult = applyConditionToActor(actor, conditionName, triggerEffect?.duration || null, currentRound);

          // Build flag updates: condition + reset buildup to 0
          const flagUpdates = {
            ...condResult.flagUpdates,
            [`statusBuildup.${effectName}.current`]: 0
          };

          // Build system updates for any trigger damage
          let systemUpdates = {};

          // Apply trigger damage (e.g., BledOut = 20% max HP as TRUE damage)
          if (triggerEffect?.hpPercent && triggerEffect.type !== 'dot') {
            const maxHP = actor.system?.hp?.max || 0;
            const triggerDamage = Math.floor(maxHP * (triggerEffect.hpPercent / 100));
            if (triggerDamage > 0) {
              const dmgResult = applyDamageToActor(actor, triggerDamage, 'TRUE');
              systemUpdates = { ...systemUpdates, ...(dmgResult.updates || {}) };
              log(`${effectName} trigger dealt ${triggerDamage} TRUE damage to ${actor.name}`);
            }
          }

          // Curse special case: set HP and temp HP to 0
          if (triggerEffect?.setHPToZero) {
            systemUpdates['system.hp.value'] = 0;
            systemUpdates['system.hp.temp'] = 0;
            log(`${effectName} triggered - ${actor.name} HP and Temp HP set to 0`);
          }

          // Commit all updates at once
          await commitActorUpdates(actor, systemUpdates, flagUpdates);

          // Play status animation for the triggered condition
          if (condResult.applied && this.token) {
            playStatusAnimation(this.token, conditionName);
          }

          // Post chat message about the trigger
          ChatMessage.create({
            content: `<div class="sd20-status-trigger">
              <strong>${actor.name}</strong> - ${effectName} threshold reached!<br>
              <em>${conditionName}</em> applied.
              ${triggerEffect?.description ? `<br><small>${triggerEffect.description}</small>` : ''}
            </div>`,
            speaker: { alias: actor.name }
          });

          log(`${effectName} reached threshold (${value}/${threshold}) - ${conditionName} triggered for ${actor.name}`);

          // Re-render to show updated state
          this.render();

          // Sync visuals
          syncTokenStatusIcons(this.token);
          refreshActorTokenBars(actor);
          return;
        }
      }
    }

    // Normal update (threshold not reached) - just set the buildup value
    const buildup = actor.getFlag(MODULE, 'statusBuildup') || {};
    buildup[effectName] = buildup[effectName] || {};
    buildup[effectName].current = value;
    await actor.setFlag(MODULE, 'statusBuildup', buildup);

    syncTokenStatusIcons(this.token);
    log(`Updated ${effectName} buildup to ${value} for ${actor.name}`);
  }

  /**
   * Update a condition's duration
   */
  async _updateConditionDuration(conditionName, duration) {
    if (!this.canEdit || !this.actor) return;

    const conditions = this.actor.getFlag(MODULE, 'activeConditions') || {};
    if (!conditions[conditionName]) return;

    conditions[conditionName].remainingRounds = duration;
    await this.actor.setFlag(MODULE, 'activeConditions', conditions);
    syncTokenStatusIcons(this.token);
    log(`Updated ${conditionName} duration to ${duration} for ${this.actor.name}`);
  }

  /**
   * Update a specific stack entry's stacks or duration
   */
  async _updateStackEntry(conditionName, entryIndex, field, value) {
    if (!this.canEdit || !this.actor) return;
    if (!conditionName || isNaN(entryIndex) || !field) return;

    const conditions = this.actor.getFlag(MODULE, 'activeConditions') || {};
    const condData = conditions[conditionName];
    if (!condData?.stackEntries || entryIndex >= condData.stackEntries.length) return;

    const entry = condData.stackEntries[entryIndex];

    if (field === 'stacks') {
      // Update stacks - minimum 1
      const newStacks = Math.max(1, value || 1);
      entry.stacks = newStacks;
      // Recalculate total stacks
      condData.totalStacks = condData.stackEntries.reduce((sum, e) => sum + (e.stacks || 0), 0);
      log(`Updated ${conditionName} entry ${entryIndex} stacks to ${newStacks} for ${this.actor.name}. New total: ${condData.totalStacks}`);
    } else if (field === 'duration') {
      // Update duration - null means indefinite
      entry.remainingRounds = value;
      log(`Updated ${conditionName} entry ${entryIndex} duration to ${value ?? '∞'} for ${this.actor.name}`);
    }

    await this.actor.setFlag(MODULE, 'activeConditions', conditions);
    syncTokenStatusIcons(this.token);
  }

  /**
   * Update a vulnerability entry's tiers or duration
   */
  async _updateVulnerability(vulnId, field, value) {
    if (!this.canEdit || !this.actor) return;
    if (!vulnId || !field) return;

    const vulns = this.actor.getFlag(MODULE, 'vulnerabilities') || [];
    const vuln = vulns.find(v => v.id === vulnId);
    if (!vuln) return;

    if (field === 'tiers') {
      vuln.tiers = Math.max(0, value);
      log(`Updated vulnerability ${vulnId} tiers to ${vuln.tiers} for ${this.actor.name}`);
    } else if (field === 'duration') {
      vuln.duration = Math.max(0, value);
      log(`Updated vulnerability ${vulnId} duration to ${vuln.duration} for ${this.actor.name}`);
    }

    await this.actor.setFlag(MODULE, 'vulnerabilities', vulns);
    syncTokenStatusIcons(this.token);
  }

  /**
   * CF4: Update a protection entry's field
   */
  async _updateProtection(category, protId, field, value) {
    if (!this.canEdit || !this.actor) return;
    if (!category || !protId || !field) return;

    const protections = getActorProtections(this.actor);
    const protArray = protections[category];
    if (!protArray) return;

    const prot = protArray.find(p => p.id === protId);
    if (!prot) return;

    // Update the specified field
    if (field === 'tiers') {
      prot.tiers = Math.max(0, value);
    } else if (field === 'flat') {
      prot.flat = Math.max(0, value);
    } else if (field === 'remainingTurns') {
      prot.remainingTurns = value > 0 ? value : null;
    } else if (field === 'remainingAttacks') {
      prot.remainingAttacks = value > 0 ? value : null;
    }

    await this.actor.setFlag(MODULE, `protections.${category}`, protArray);
    log(`Updated protection ${protId} ${field} to ${value} for ${this.actor.name}`);
  }

  /**
   * Toggle a condition on/off
   */
  async _toggleCondition(conditionName) {
    if (!this.canEdit || !this.actor) return;

    const STACKABLE_CONDITIONS = ['Frenzy', 'Exhaustion'];
    const conditions = this.actor.getFlag(MODULE, 'activeConditions') || {};
    const isActive = conditions[conditionName]?.active || false;

    if (isActive) {
      // Deactivate - use delete syntax to completely remove condition data
      // This avoids flag merge issues where stackEntries arrays persist
      await this.actor.update({
        [`flags.${MODULE}.activeConditions.-=${conditionName}`]: null
      });

      // Reset buildup's lastTriggeredRound so it can accumulate again immediately
      const buildupName = CONDITION_TO_BUILDUP[conditionName];
      if (buildupName) {
        const buildup = this.actor.getFlag(MODULE, 'statusBuildup') || {};
        if (buildup[buildupName]) {
          buildup[buildupName].lastTriggeredRound = -1;
          await this.actor.setFlag(MODULE, 'statusBuildup', buildup);
        }
      }
    } else {
      // Activate
      if (STACKABLE_CONDITIONS.includes(conditionName)) {
        // Stackable conditions: initialize with 1 stack, 1 round duration
        const currentRound = game.combat?.round || 0;
        conditions[conditionName] = {
          active: true,
          stackEntries: [{
            stacks: 1,
            remainingRounds: 1,
            appliedRound: currentRound,
            sourceId: 'manual',
            sourceName: 'Manual',
            casterId: game.user.id,
            casterName: game.user.name
          }],
          totalStacks: 1
        };
      } else {
        // Non-stackable conditions: no duration (indefinite)
        conditions[conditionName] = { active: true, remainingRounds: null };
      }
      await this.actor.setFlag(MODULE, 'activeConditions', conditions);
    }

    syncTokenStatusIcons(this.token);
    this.render();
    log(`Toggled ${conditionName} to ${!isActive} for ${this.actor.name}`);
  }

  /**
   * Show a GM ruling dialog for effects that require approval (e.g., Curse)
   * @param {string} effectName - The buildup effect name (e.g., 'Curse')
   * @param {string} conditionName - The condition to apply (e.g., 'Cursed')
   * @param {object} triggerEffect - The trigger effect data from damageSystem
   * @param {Actor} actor - The actor being affected
   * @returns {Promise<boolean>} - True if approved, false if denied
   */
  async _showRulingDialog(effectName, conditionName, triggerEffect, actor) {
    // Only GM can make rulings
    if (!game.user.isGM) {
      ui.notifications.warn(`${effectName} requires GM ruling. Please wait for the GM to decide.`);
      return false;
    }

    const { DialogV2 } = foundry.applications.api;

    // Build description of what will happen
    let effectDescription = `<strong>${conditionName}</strong> will be applied.`;
    if (triggerEffect?.setHPToZero) {
      effectDescription += `<br><em style="color: #f44336;">HP and Temp HP will be set to 0.</em>`;
    }
    if (triggerEffect?.description) {
      effectDescription += `<br><small>${triggerEffect.description}</small>`;
    }

    const result = await DialogV2.confirm({
      window: {
        title: `GM Ruling Required: ${effectName}`,
        icon: 'fa-solid fa-gavel'
      },
      content: `
        <div class="sd20-ruling-dialog">
          <p><strong>${actor.name}</strong> has reached the <strong>${effectName}</strong> threshold!</p>
          <p>This effect requires your ruling before it can be applied.</p>
          <hr>
          <p>${effectDescription}</p>
          <hr>
          <p>Do you approve this effect?</p>
        </div>
      `,
      yes: {
        label: 'Approve',
        icon: 'fa-solid fa-check',
        callback: () => true
      },
      no: {
        label: 'Deny',
        icon: 'fa-solid fa-xmark',
        callback: () => false
      },
      rejectClose: false,
      modal: true
    });

    // If dialog was closed without choice, treat as denied
    return result === true;
  }

  static #onSwitchTab(event, target) {
    const tab = target.dataset.tab;
    if (!tab || tab === this._activeTab) return;
    this._activeTab = tab;
    this.render();
  }

  static #onToggleCondition(event, target) {
    const condition = target.dataset.condition;
    if (condition) {
      this._toggleCondition(condition);
    }
  }

  static async #onResetBuildup() {
    if (!this.canEdit || !this.actor) return;
    // Reset all buildup values to 0
    const buildup = this.actor.getFlag(MODULE, 'statusBuildup') || {};
    for (const effect of BUILDUP_EFFECTS) {
      if (buildup[effect]) {
        buildup[effect].current = 0;
      }
    }
    await this.actor.setFlag(MODULE, 'statusBuildup', buildup);
    syncTokenStatusIcons(this.token);
    this.render();
    log(`Reset all buildup for ${this.actor.name}`);
  }

  static async #onResetConditions() {
    if (!this.canEdit || !this.actor) return;
    // Use Foundry's delete syntax (-=) to completely remove each active condition
    // This avoids flag merge issues where stackEntries arrays persist
    const conditions = this.actor.getFlag(MODULE, 'activeConditions') || {};
    const deleteUpdate = {};
    for (const name of CONDITIONS) {
      if (conditions[name]?.active) {
        deleteUpdate[`flags.${MODULE}.activeConditions.-=${name}`] = null;
      }
    }
    if (Object.keys(deleteUpdate).length > 0) {
      await this.actor.update(deleteUpdate);
    }
    syncTokenStatusIcons(this.token);
    this.render();
    log(`Reset all conditions for ${this.actor.name}`);
  }

  static #onClose() {
    this.close();
  }

  /**
   * Toggle visibility of stack details panel for a condition
   */
  static #onToggleStackDetails(event, target) {
    const conditionName = target.dataset.condition;
    if (!conditionName) return;

    const el = this.element;
    if (!el) return;

    // Find the details panel for this condition
    const detailsPanel = el.querySelector(`.stacks-details-panel[data-condition-details="${conditionName}"]`);
    if (!detailsPanel) return;

    // Toggle visibility
    const isHidden = detailsPanel.classList.contains('hidden');
    detailsPanel.classList.toggle('hidden', !isHidden);

    // Rotate the chevron icon
    const chevron = target.querySelector('i');
    if (chevron) {
      chevron.classList.toggle('fa-chevron-right', !isHidden);
      chevron.classList.toggle('fa-chevron-down', isHidden);
    }
  }

  /**
   * Remove a specific stack entry from a condition
   */
  static async #onRemoveStackEntry(event, target) {
    if (!this.canEdit || !this.actor) return;

    const conditionName = target.dataset.condition;
    const entryIndex = parseInt(target.dataset.entryIndex);
    if (!conditionName || isNaN(entryIndex)) return;

    const conditions = this.actor.getFlag(MODULE, 'activeConditions') || {};
    const condData = conditions[conditionName];
    if (!condData?.stackEntries || entryIndex >= condData.stackEntries.length) return;

    // Remove the entry at the specified index
    const removedEntry = condData.stackEntries[entryIndex];
    const removedStacks = removedEntry.stacks || 0;
    condData.stackEntries.splice(entryIndex, 1);

    // Recalculate total stacks
    const newTotalStacks = condData.stackEntries.reduce((sum, e) => sum + (e.stacks || 0), 0);

    // If no stacks remain, deactivate the condition using delete syntax
    if (newTotalStacks <= 0 || condData.stackEntries.length === 0) {
      // Use delete syntax to completely remove condition data
      await this.actor.update({
        [`flags.${MODULE}.activeConditions.-=${conditionName}`]: null
      });
    } else {
      condData.totalStacks = newTotalStacks;
      await this.actor.setFlag(MODULE, 'activeConditions', conditions);
    }

    syncTokenStatusIcons(this.token);
    this.render();
    log(`Removed stack entry (${removedStacks} stacks) from ${conditionName} for ${this.actor.name}. New total: ${newTotalStacks}`);
  }

  /**
   * Toggle visibility of vulnerability details panel
   */
  static #onToggleVulnDetails(event, target) {
    const vulnType = target.dataset.vulnType;
    if (!vulnType) return;

    const el = this.element;
    if (!el) return;

    // Find the details panel for this vulnerability type
    const detailsPanel = el.querySelector(`.vuln-details-panel[data-vuln-details="${vulnType}"]`);
    if (!detailsPanel) return;

    // Toggle visibility
    const isHidden = detailsPanel.classList.contains('hidden');
    detailsPanel.classList.toggle('hidden', !isHidden);

    // Rotate the chevron icon
    const chevron = target.querySelector('i');
    if (chevron) {
      chevron.classList.toggle('fa-chevron-right', !isHidden);
      chevron.classList.toggle('fa-chevron-down', isHidden);
    }
  }

  /**
   * Remove a specific vulnerability by ID
   */
  static async #onRemoveVulnerability(event, target) {
    if (!this.canEdit || !this.actor) return;

    const vulnId = target.dataset.vulnId;
    if (!vulnId) return;

    const vulns = this.actor.getFlag(MODULE, 'vulnerabilities') || [];
    const filtered = vulns.filter(v => v.id !== vulnId);

    if (filtered.length === vulns.length) return; // Nothing removed

    await this.actor.setFlag(MODULE, 'vulnerabilities', filtered);
    syncTokenStatusIcons(this.token);
    this.render();
    log(`Removed vulnerability ${vulnId} from ${this.actor.name}`);
  }

  /**
   * Reset all vulnerabilities
   */
  static async #onResetVulnerabilities() {
    if (!this.canEdit || !this.actor) return;

    // Use delete syntax to completely remove vulnerabilities flag
    await this.actor.update({
      [`flags.${MODULE}.-=vulnerabilities`]: null
    });
    syncTokenStatusIcons(this.token);
    this.render();
    log(`Reset all vulnerabilities for ${this.actor.name}`);
  }

  /**
   * CF4: Toggle visibility of protection details panel
   */
  static #onToggleProtDetails(event, target) {
    const protKey = target.dataset.protKey;
    if (!protKey) return;

    const el = this.element;
    if (!el) return;

    // Find the details panel for this protection type
    const detailsPanel = el.querySelector(`.prot-details-panel[data-prot-details="${protKey}"]`);
    if (!detailsPanel) return;

    // Toggle visibility
    const isHidden = detailsPanel.classList.contains('hidden');
    detailsPanel.classList.toggle('hidden', !isHidden);

    // Rotate the chevron icon
    const chevron = target.querySelector('i');
    if (chevron) {
      chevron.classList.toggle('fa-chevron-right', !isHidden);
      chevron.classList.toggle('fa-chevron-down', isHidden);
    }
  }

  /**
   * CF4: Remove a specific protection by ID
   */
  static async #onRemoveProtection(event, target) {
    if (!this.canEdit || !this.actor) return;

    const protId = target.dataset.protId;
    const protCategory = target.dataset.protCategory;
    if (!protId || !protCategory) return;

    await removeProtectionFromActor(this.actor, protCategory, protId);
    syncTokenStatusIcons(this.token);
    this.render();
    log(`Removed ${protCategory} protection ${protId} from ${this.actor.name}`);
  }

  /**
   * CF4: Reset all protections
   */
  static async #onResetProtections() {
    if (!this.canEdit || !this.actor) return;

    // Use delete syntax to completely remove protections flag
    await this.actor.update({
      [`flags.${MODULE}.-=protections`]: null
    });
    syncTokenStatusIcons(this.token);
    this.render();
    log(`Reset all protections for ${this.actor.name}`);
  }

  // Singleton map: one panel per token
  static _openPanels = new Map();

  /**
   * Open status panel for a token
   */
  static open(token) {
    if (!token) return;

    const existing = StatusPanel._openPanels.get(token.id);
    if (existing && existing.rendered) {
      existing.bringToFront();
      return existing;
    }

    const panel = new StatusPanel(token);
    StatusPanel._openPanels.set(token.id, panel);
    panel.addEventListener('close', () => StatusPanel._openPanels.delete(token.id));

    // Position near the token
    const tokenRect = token.bounds;
    const canvasRect = canvas.app.view.getBoundingClientRect();
    const scale = canvas.stage.scale.x;
    const tokenScreenX = (tokenRect.x * scale) + canvasRect.left + (canvas.stage.pivot.x * -scale) + (canvas.stage.position.x);
    const tokenScreenY = (tokenRect.y * scale) + canvasRect.top + (canvas.stage.pivot.y * -scale) + (canvas.stage.position.y);

    panel.render({
      force: true,
      position: {
        left: tokenScreenX + (tokenRect.width * scale) + 10,
        top: tokenScreenY
      }
    });

    return panel;
  }
}

/**
 * Register status panel (called from souls-d20.js)
 */
export function registerStatusPanel() {
  // Real-time updates: re-render open panels when actor flags change
  Hooks.on('updateActor', (actor, changes) => {
    // Check if relevant flags changed
    const flagsChanged = changes?.flags?.[MODULE];
    if (!flagsChanged) return;

    const buildupChanged = flagsChanged.statusBuildup !== undefined;
    const conditionsChanged = flagsChanged.activeConditions !== undefined;
    const thresholdsChanged = flagsChanged.combat?.statusThresholds !== undefined;
    const vulnerabilitiesChanged = flagsChanged.vulnerabilities !== undefined;
    const protectionsChanged = flagsChanged.protections !== undefined; // CF4

    if (!buildupChanged && !conditionsChanged && !thresholdsChanged && !vulnerabilitiesChanged && !protectionsChanged) return;

    // Find any open panels for tokens linked to this actor and re-render them
    for (const [tokenId, panel] of StatusPanel._openPanels) {
      if (panel.actor?.id === actor.id && panel.rendered) {
        panel.render();
      }
    }
  });

  debug('Status panel registered');
}
