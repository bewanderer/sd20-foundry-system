/**
 * Custom Macro Builder
 * No-code macro creation tool with visual builder
 */

import { CONFIG } from './config.js';
import { log, debug, REST_FORMULA_SOURCES, resolveMaxUses } from './utils.js';
import { createCustomMacro } from './macroManager.js';
import { addMacroToLibrary } from './macroLibrary.js';
import {
  isAnimationSystemAvailable, getAvailableAnimations, formatAnimationLabel,
  animationExists, previewAnimation
} from './animationSystem.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Common icons for macro selection
const MACRO_ICONS = [
  { icon: 'fa-solid fa-sword', label: 'Sword' },
  { icon: 'fa-solid fa-axe-battle', label: 'Axe' },
  { icon: 'fa-solid fa-bow-arrow', label: 'Bow' },
  { icon: 'fa-solid fa-crosshairs', label: 'Crosshairs' },
  { icon: 'fa-solid fa-wand-sparkles', label: 'Wand' },
  { icon: 'fa-solid fa-fire', label: 'Fire' },
  { icon: 'fa-solid fa-bolt-lightning', label: 'Lightning' },
  { icon: 'fa-solid fa-snowflake', label: 'Frost' },
  { icon: 'fa-solid fa-ghost', label: 'Spirit' },
  { icon: 'fa-solid fa-skull', label: 'Dark' },
  { icon: 'fa-solid fa-sun', label: 'Holy' },
  { icon: 'fa-solid fa-shield', label: 'Shield' },
  { icon: 'fa-solid fa-heart', label: 'Heal' },
  { icon: 'fa-solid fa-person-running', label: 'Movement' },
  { icon: 'fa-solid fa-eye', label: 'Vision' },
  { icon: 'fa-solid fa-hand-fist', label: 'Unarmed' },
  { icon: 'fa-solid fa-dagger', label: 'Dagger' },
  { icon: 'fa-solid fa-staff', label: 'Staff' },
  { icon: 'fa-solid fa-burst', label: 'Burst' },
  { icon: 'fa-solid fa-star', label: 'Star' }
];

// Default row templates for combat components
const DEFAULT_DAMAGE_TYPE = { type: 'PHYSICAL', diceCount: 1, diceSides: 6, flatBonus: 0, scalingSource: 'none', weaponHand: 'mainHand', piercing: { tiers: 0, allTiers: false, expanded: false }, manualScalingEntries: [] };
const DEFAULT_STATUS_EFFECT = { name: 'Bleed', diceCount: 1, diceSides: 6, flatBonus: 0, scalingSource: 'none', weaponHand: 'mainHand', manualScalingEntries: [] };
const DEFAULT_STATUS_CONDITION = { name: 'Dazed', duration: 0, noSave: false, dc: 0, dcBonusSource: 'none', saveType: '', stacks: 1, stacking: false };
const DEFAULT_RESTORATION = { type: 'heal-hp', diceCount: 1, diceSides: 6, flatBonus: 0, scalingSource: 'none', weaponHand: 'mainHand', allowOverMax: false, statusEffect: 'Bleed', conditions: [], statusEffects: [], manualScalingEntries: [] };
const DEFAULT_VULNERABILITY = { type: 'PHYSICAL', tiers: 1, flatTiers: 0, duration: 3, timing: 'before', stacking: false };

// CF4: Protection system defaults
const DEFAULT_DAMAGE_PROTECTION = {
  type: 'PHYSICAL',
  tiers: 0,
  flat: 0,
  diceCount: 0,
  diceSides: 0,
  percentage: 0,
  percentageTiming: 'INITIAL',  // Default: combine with resistance
  durationTurns: 0,
  durationAttacks: 0,
  applyToCaster: false,
  applyToTarget: true,
  stacking: 'OVERWRITE',
  scalingSource: 'none',
  weaponHand: 'mainHand',
  manualScalingEntries: []
};
const DEFAULT_BUILDUP_PROTECTION = {
  type: 'BLEED',
  flat: 0,
  diceCount: 0,
  diceSides: 0,
  percentage: 0,
  percentageTiming: 'INITIAL',  // Default: apply before overrides
  durationTurns: 0,
  durationAttacks: 0,
  applyToCaster: false,
  applyToTarget: true,
  stacking: 'OVERWRITE',
  scalingSource: 'none',
  weaponHand: 'mainHand',
  manualScalingEntries: []
};
const DEFAULT_CONDITION_PROTECTION = {
  condition: 'Dazed',
  durationTurns: 0,
  durationAttacks: 0,
  applyToCaster: false,
  applyToTarget: true
};

/**
 * Custom Macro Builder Dialog
 * Handles both custom macro creation and editing App-sourced macros
 */
export class CustomMacroBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  // Restricted categories that only allow editing name and modifier
  static RESTRICTED_CATEGORIES = ['initiative', 'skillChecks', 'knowledgeChecks', 'statChecks'];

  constructor(macroBar, slotIndex = null, existingMacro = null, options = {}) {
    // Determine category before super() to set correct window size
    const category = options.defaultCategory || CustomMacroBuilder._detectMacroCategoryStatic(existingMacro) || 'custom';
    const isRestricted = CustomMacroBuilder.RESTRICTED_CATEGORIES.includes(category);

    // Restricted categories get a smaller window (but tall enough for all fields + footer)
    if (isRestricted) {
      options.position = { width: 420, height: 440 };
    }

    super(options);
    this.macroBar = macroBar;
    this.slotIndex = slotIndex;
    this.existingMacro = existingMacro;
    this.isAppMacro = existingMacro?.source === CONFIG.MACRO_SOURCES.APP;
    this.originalMacro = existingMacro ? JSON.parse(JSON.stringify(existingMacro)) : null;
    // Store the unmodified app version for "Reset to App Defaults"
    // Priority: 1) appOriginalOverride from options, 2) stored appOriginalData on macro, 3) match from macroBar, 4) null
    this._appOriginal = null;
    if (options.appOriginalOverride) {
      this._appOriginal = JSON.parse(JSON.stringify(options.appOriginalOverride));
    } else if (existingMacro?.appOriginalData) {
      // Use the stored original app data from the macro itself
      this._appOriginal = JSON.parse(JSON.stringify(existingMacro.appOriginalData));
    } else if (this.isAppMacro && macroBar?.availableMacros) {
      // Fallback: try to find in available macros
      const matchId = existingMacro.sourceId || existingMacro.id;
      const appVersion = macroBar.availableMacros.find(m =>
        m.id === existingMacro.id || m.sourceId === matchId || m.id === matchId
      );
      if (appVersion) this._appOriginal = JSON.parse(JSON.stringify(appVersion));
    }
    this.diceEntries = this._initializeDice(existingMacro);
    this.defaultCategory = options.defaultCategory || this._detectMacroCategory(existingMacro) || 'custom';
    this._onCloseCallback = options.onClose || null;
    // Library edit mode
    this._isLibraryEdit = options.isLibraryEdit || false;
    this._libraryId = options.libraryId || null;
    this._onSaveCallback = options.onSave || null;

    // Combat configuration arrays
    // For app macros, convert legacy dice[] format to combat.damageTypes format
    let appDamageTypes = existingMacro?.combat?.damageTypes;
    if (!appDamageTypes?.length && existingMacro?.dice?.length) {
      // Convert dice array to damageTypes format with proper scaling support
      appDamageTypes = existingMacro.dice.map((d, i) => {
        // Try to get manual scaling entries from corresponding combat entry if available
        const combatEntry = existingMacro.combat?.damageTypes?.[i];
        const manualScalingEntries = combatEntry?.manualScalingEntries || [];
        const hasManualEntries = manualScalingEntries.length > 0;
        return {
          type: d.type || 'PHYSICAL',
          diceCount: d.count || 1,
          diceSides: d.sides || d.value || 6,
          flatBonus: 0,
          scalingSource: hasManualEntries ? 'manual' : (existingMacro.scalingBonus ? 'weapon' : 'none'),
          weaponHand: existingMacro.linkedSlot || 'mainHand',
          manualScalingEntries: manualScalingEntries
        };
      });
    }
    this.combatDamageTypes = this._initCombatArray(appDamageTypes, DEFAULT_DAMAGE_TYPE);
    this.combatStatusEffects = this._initCombatArray(existingMacro?.combat?.statusEffects, DEFAULT_STATUS_EFFECT);
    this.combatStatusConditions = this._initCombatArray(existingMacro?.combat?.statusConditions, DEFAULT_STATUS_CONDITION);
    this.combatRestoration = this._initCombatArray(existingMacro?.combat?.restoration, DEFAULT_RESTORATION);
    // Secondary combat configuration arrays (for secondary effects tab)
    this.secondaryCombatDamageTypes = this._initCombatArray(existingMacro?.secondaryCombat?.damageTypes, DEFAULT_DAMAGE_TYPE);
    this.secondaryCombatStatusEffects = this._initCombatArray(existingMacro?.secondaryCombat?.statusEffects, DEFAULT_STATUS_EFFECT);
    this.secondaryCombatStatusConditions = this._initCombatArray(existingMacro?.secondaryCombat?.statusConditions, DEFAULT_STATUS_CONDITION);
    this.secondaryCombatRestoration = this._initCombatArray(existingMacro?.secondaryCombat?.restoration, DEFAULT_RESTORATION);
    // Vulnerability arrays (apply resistance debuffs to targets)
    this.combatVulnerabilities = this._initCombatArray(existingMacro?.combat?.vulnerabilities, DEFAULT_VULNERABILITY);
    this.secondaryCombatVulnerabilities = this._initCombatArray(existingMacro?.secondaryCombat?.vulnerabilities, DEFAULT_VULNERABILITY);

    // CF4: Protection arrays (grant defensive buffs)
    this.combatDamageProtection = this._initCombatArray(existingMacro?.combat?.damageProtection, DEFAULT_DAMAGE_PROTECTION);
    this.combatBuildupProtection = this._initCombatArray(existingMacro?.combat?.buildupProtection, DEFAULT_BUILDUP_PROTECTION);
    this.combatConditionProtection = this._initCombatArray(existingMacro?.combat?.conditionProtection, DEFAULT_CONDITION_PROTECTION);
    this.secondaryCombatDamageProtection = this._initCombatArray(existingMacro?.secondaryCombat?.damageProtection, DEFAULT_DAMAGE_PROTECTION);
    this.secondaryCombatBuildupProtection = this._initCombatArray(existingMacro?.secondaryCombat?.buildupProtection, DEFAULT_BUILDUP_PROTECTION);
    this.secondaryCombatConditionProtection = this._initCombatArray(existingMacro?.secondaryCombat?.conditionProtection, DEFAULT_CONDITION_PROTECTION);

    // Trigger-on-cast flags (whether each effect fires when macro is initially cast)
    this._primaryTriggerOnCast = existingMacro?.combat?.triggerOnCast ?? true;
    this._secondaryTriggerOnCast = existingMacro?.secondaryCombat?.triggerOnCast ?? false;

    // Active combat effects tab (preserved across re-renders)
    this._activeCombatTab = 'primary';

    // Track which combat sections are expanded (preserved across re-renders)
    this._expandedSections = new Set();
    if (appDamageTypes?.length) this._expandedSections.add('damageTypes');
    if (existingMacro?.combat?.statusEffects?.length) this._expandedSections.add('statusEffects');
    if (existingMacro?.combat?.statusConditions?.length) this._expandedSections.add('statusConditions');
    if (existingMacro?.combat?.restoration?.length) this._expandedSections.add('restoration');
    if (existingMacro?.secondaryCombat?.damageTypes?.length) this._expandedSections.add('secondaryDamageTypes');
    if (existingMacro?.secondaryCombat?.statusEffects?.length) this._expandedSections.add('secondaryStatusEffects');
    if (existingMacro?.secondaryCombat?.statusConditions?.length) this._expandedSections.add('secondaryStatusConditions');
    if (existingMacro?.secondaryCombat?.restoration?.length) this._expandedSections.add('secondaryRestoration');
    if (existingMacro?.combat?.vulnerabilities?.length) this._expandedSections.add('vulnerabilities');
    if (existingMacro?.secondaryCombat?.vulnerabilities?.length) this._expandedSections.add('secondaryVulnerabilities');
    // CF4: Protection expanded sections
    if (existingMacro?.combat?.damageProtection?.length || existingMacro?.combat?.buildupProtection?.length || existingMacro?.combat?.conditionProtection?.length) this._expandedSections.add('protection');
    if (existingMacro?.secondaryCombat?.damageProtection?.length || existingMacro?.secondaryCombat?.buildupProtection?.length || existingMacro?.secondaryCombat?.conditionProtection?.length) this._expandedSections.add('secondaryProtection');

    // Track targeting state (preserved across re-renders)
    this._targeting = {
      isTargetMacro: existingMacro?.targeting?.isTargetMacro || false,
      mode: existingMacro?.targeting?.mode || 'single',
      maxTargets: existingMacro?.targeting?.maxTargets || 1,
      includeSelf: existingMacro?.targeting?.includeSelf || false
    };

    // Track AoE state (preserved across re-renders)
    this._aoe = {
      shape: existingMacro?.aoe?.shape || '',
      sizeMin: existingMacro?.aoe?.sizeMin || 0,
      sizeMax: existingMacro?.aoe?.sizeMax || 0,
      originateSelf: existingMacro?.aoe?.originateSelf || false,
      followsCaster: existingMacro?.aoe?.followsCaster || false,
      coneAngle: existingMacro?.aoe?.coneAngle || 90,
      lineWidth: existingMacro?.aoe?.lineWidth || 5,
      exclusionRadius: existingMacro?.aoe?.exclusionRadius || 0,
      playerVisibility: existingMacro?.aoe?.playerVisibility || 'hidden'
    };

    // Track AoE duration separately (not in aoe object)
    this._aoeDuration = existingMacro?.aoeDuration || 0;
    this._aoePermanent = existingMacro?.aoePermanent || false;

    // Rest ability state (SR/LR uses tracking)
    this._restAbility = {
      type: existingMacro?.restAbility?.type || null,
      maxUses: {
        mode: existingMacro?.restAbility?.maxUses?.mode || 'flat',
        flat: existingMacro?.restAbility?.maxUses?.flat ?? 3,
        terms: existingMacro?.restAbility?.maxUses?.terms || [
          { source: 'flat', flatValue: 0, operation: 'none', modifier: 0 }
        ]
      },
      currentUses: existingMacro?.restAbility?.currentUses ?? null
    };

    // Script editing state
    this._scriptEditingEnabled = existingMacro?.scriptEdited || false;
    this._scriptEdited = existingMacro?.scriptEdited || false;
    this._customScript = existingMacro?.customScript || '';

    // Animation state
    this._activeMainTab = 'combat'; // 'combat' or 'animation'
    this._animation = {
      enabled: existingMacro?.animation?.enabled ?? false,
      cast: existingMacro?.animation?.cast || { file: '', scale: 1.0, duration: null },
      projectile: existingMacro?.animation?.projectile || { file: '', scale: 1.0, duration: null, simultaneous: false },
      impact: existingMacro?.animation?.impact || { file: '', scale: 1.0, duration: null, simultaneous: false },
      area: existingMacro?.animation?.area || { file: '', scale: 1.0, duration: null }
    };

    // Basic form fields state (preserved across re-renders to prevent field reset on tab swap)
    this._basicFields = {
      name: existingMacro?.name || '',
      description: existingMacro?.description || '',
      flavor: existingMacro?.flavor || '',
      icon: existingMacro?.icon || 'fa-solid fa-star',
      category: existingMacro?.category || this.defaultCategory,
      keywords: existingMacro?.keywords || '',
      showDescriptionToPlayers: existingMacro?.showDescriptionToPlayers ?? true,
      apCost: existingMacro?.apCost ?? 0,
      fpCost: existingMacro?.fpCost ?? 0,
      hpCost: existingMacro?.hpCost ?? 0,
      otherCost: existingMacro?.otherCost || '',
      range: existingMacro?.range ?? 0,
      scalingBonus: existingMacro?.scalingBonus ?? 0,
      scalingLink: existingMacro?.scalingLink || 'none',
      simpleRoll: {
        diceCount: existingMacro?.simpleRoll?.diceCount ?? null,
        diceSides: existingMacro?.simpleRoll?.diceSides ?? null,
        bonus: existingMacro?.simpleRoll?.bonus ?? 0
      }
    };

    // Check if this is a restricted category (limited editing)
    this._isRestrictedCategory = isRestricted;
    // Track edit mode state for restricted category (locks category selection)
    this._isRestrictedEditMode = isRestricted && !!existingMacro;

    // Check if this macro is for an NPC (monsters use stat scaling instead of weapon scaling)
    const actor = macroBar?.actorId ? game.actors.get(macroBar.actorId) : null;
    this.isNPC = actor?.type === 'npc';

    console.log('SD20 CustomMacroBuilder: existingMacro =', existingMacro);
    console.log('SD20 CustomMacroBuilder: isAppMacro =', this.isAppMacro);
    console.log('SD20 CustomMacroBuilder: isNPC =', this.isNPC);
  }

  static DEFAULT_OPTIONS = {
    id: 'sd20-custom-macro-builder',
    classes: ['sd20-macro-builder-dialog'],
    tag: 'form',
    window: {
      title: 'Macro Editor',
      resizable: true
    },
    position: {
      width: 1350,
      height: 850
    },
    form: {
      handler: CustomMacroBuilder.#onFormSubmit,
      submitOnChange: false,
      closeOnSubmit: false // Handle closing manually after validation passes
    },
    actions: {
      selectIcon: CustomMacroBuilder.#onSelectIcon,
      addDice: CustomMacroBuilder.#onAddDice,
      removeDice: CustomMacroBuilder.#onRemoveDice,
      resetOriginal: CustomMacroBuilder.#onResetOriginal,
      cancel: CustomMacroBuilder.#onCancel,
      toggleCombatSection: CustomMacroBuilder.#onToggleCombatSection,
      addDamageType: CustomMacroBuilder.#onAddDamageType,
      removeDamageType: CustomMacroBuilder.#onRemoveDamageType,
      togglePiercing: CustomMacroBuilder.#onTogglePiercing,
      addStatusEffect: CustomMacroBuilder.#onAddStatusEffect,
      removeStatusEffect: CustomMacroBuilder.#onRemoveStatusEffect,
      addStatusCondition: CustomMacroBuilder.#onAddStatusCondition,
      removeStatusCondition: CustomMacroBuilder.#onRemoveStatusCondition,
      addRestoration: CustomMacroBuilder.#onAddRestoration,
      removeRestoration: CustomMacroBuilder.#onRemoveRestoration,
      addVulnerability: CustomMacroBuilder.#onAddVulnerability,
      removeVulnerability: CustomMacroBuilder.#onRemoveVulnerability,
      // CF4: Protection event handlers
      addDamageProtection: CustomMacroBuilder.#onAddDamageProtection,
      removeDamageProtection: CustomMacroBuilder.#onRemoveDamageProtection,
      addBuildupProtection: CustomMacroBuilder.#onAddBuildupProtection,
      removeBuildupProtection: CustomMacroBuilder.#onRemoveBuildupProtection,
      addConditionProtection: CustomMacroBuilder.#onAddConditionProtection,
      removeConditionProtection: CustomMacroBuilder.#onRemoveConditionProtection,
      resetToBuilder: CustomMacroBuilder.#onResetToBuilder,
      // Manual scaling entry handlers
      addManualScaling: CustomMacroBuilder.#onAddManualScaling,
      removeManualScaling: CustomMacroBuilder.#onRemoveManualScaling
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/custom-macro-builder.html'
    }
  };

  get title() {
    if (this.existingMacro) {
      return this.isAppMacro ? `Edit: ${this.existingMacro.name}` : 'Edit Custom Macro';
    }
    return 'Create Custom Macro';
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // Override Foundry's inline px sizing with rem for responsive scaling
    // 1350px × 850px at 16px base = 84.4rem × 53.1rem
    if (!this._isRestrictedCategory) {
      el.style.width = '84.4rem';
      el.style.height = '53.1rem';
    } else {
      // Restricted: 420px × 440px = 26.3rem × 27.5rem
      el.style.width = '26.3rem';
      el.style.height = '27.5rem';
    }

    // Category change listener (for create mode only - switches between restricted/full layout)
    const categorySelect = el.querySelector('select[name="macroCategory"]');
    if (categorySelect && !this._isRestrictedEditMode) {
      categorySelect.addEventListener('change', () => {
        const newCategory = categorySelect.value;
        const wasRestricted = this._isRestrictedCategory;
        const isNowRestricted = CustomMacroBuilder.RESTRICTED_CATEGORIES.includes(newCategory);

        // Update tracking
        this.defaultCategory = newCategory;
        this._isRestrictedCategory = isNowRestricted;

        // If switching between restricted and non-restricted, re-render (rem sizing applied in _onRender)
        if (wasRestricted !== isNowRestricted) {
          if (isNowRestricted) {
            this.setPosition({ width: 420, height: 440 });
          }
          this.render();
        }
      });
    }

    // Show/hide scaling bonus input based on scalingLink selection
    const scalingSelect = el.querySelector('select[name="scalingLink"]');
    const bonusGroup = el.querySelector('.scaling-bonus-group');
    if (scalingSelect && bonusGroup) {
      scalingSelect.addEventListener('change', () => {
        bonusGroup.style.display = scalingSelect.value === 'manual' ? '' : 'none';
      });
    }

    // Show/hide cone angle, line width, exclusion radius, and area animation based on AOE shape selection
    const shapeSelect = el.querySelector('select[name="aoe.shape"]');
    const coneAngleGroup = el.querySelector('.aoe-cone-angle');
    const lineWidthGroup = el.querySelector('.aoe-line-width');
    const exclusionRadiusGroup = el.querySelector('.aoe-exclusion-radius');
    const playerVisibilityGroup = el.querySelector('.aoe-player-visibility');
    const areaAnimationSlot = el.querySelector('.animation-slot[data-slot="area"]');
    if (shapeSelect) {
      const updateShapeFields = () => {
        const shape = shapeSelect.value;
        if (coneAngleGroup) coneAngleGroup.style.display = shape === 'cone' ? '' : 'none';
        if (lineWidthGroup) lineWidthGroup.style.display = shape === 'line' ? '' : 'none';
        if (exclusionRadiusGroup) exclusionRadiusGroup.classList.toggle('hidden', !shape);
        if (playerVisibilityGroup) playerVisibilityGroup.classList.toggle('hidden', !shape);

        // Show Area Animation slot only when shape is hex or circle
        const showAreaAnimation = shape === 'hex' || shape === 'circle';
        if (areaAnimationSlot) {
          areaAnimationSlot.style.display = showAreaAnimation ? '' : 'none';

          // Clear area animation when shape changes away from hex/circle
          if (!showAreaAnimation && this._animation?.area) {
            this._animation.area = { file: '', scale: 1.0, duration: null };
            // Update the UI inputs
            const fileInput = areaAnimationSlot.querySelector('input[name="animation.area.file"]');
            const scaleInput = areaAnimationSlot.querySelector('input[name="animation.area.scale"]');
            const durationInput = areaAnimationSlot.querySelector('input[name="animation.area.duration"]');
            if (fileInput) fileInput.value = '';
            if (scaleInput) scaleInput.value = '1.0';
            if (durationInput) durationInput.value = '';
          }
        }
      };
      shapeSelect.addEventListener('change', updateShapeFields);
    }

    // Permanent checkbox disables duration turns input
    const permanentCb = el.querySelector('input[name="aoePermanent"]');
    const durationInput = el.querySelector('input[name="aoeDuration"]');
    if (permanentCb && durationInput) {
      permanentCb.addEventListener('change', () => {
        durationInput.disabled = permanentCb.checked;
        if (permanentCb.checked) durationInput.value = '';
      });
    }

    // Targeting section toggle and mode switching
    const targetingToggle = el.querySelector('input[name="targeting.isTargetMacro"]');
    const targetingOptions = el.querySelector('.targeting-options');
    const targetingModeSelect = el.querySelector('select[name="targeting.mode"]');
    const maxTargetsGroup = el.querySelector('.targeting-max-targets');
    const includeSelfGroup = el.querySelector('.targeting-include-self');

    if (targetingToggle && targetingOptions) {
      targetingToggle.addEventListener('change', () => {
        targetingOptions.style.display = targetingToggle.checked ? '' : 'none';
      });
    }
    if (targetingModeSelect) {
      const maxTargetsInput = el.querySelector('input[name="targeting.maxTargets"]');
      const includeSelfCheckbox = el.querySelector('input[name="targeting.includeSelf"]');

      targetingModeSelect.addEventListener('change', () => {
        const mode = targetingModeSelect.value;
        if (maxTargetsGroup) maxTargetsGroup.style.display = mode === 'single' ? '' : 'none';
        if (includeSelfGroup) includeSelfGroup.style.display = mode === 'self' ? 'none' : '';

        // Clear/reset values when switching modes
        if (mode !== 'single' && maxTargetsInput) {
          maxTargetsInput.value = 1; // Reset to default
        }
        if (mode === 'self' && includeSelfCheckbox) {
          includeSelfCheckbox.checked = false;
        }

        // Update tracked targeting state
        this._targeting.mode = mode;
      });
    }

    // Show/hide "Follows Caster" based on "Originate from caster" checkbox
    const originateSelfCb = el.querySelector('input[name="aoe.originateSelf"]');
    const followsCasterGroup = el.querySelector('.aoe-follows-caster');
    if (originateSelfCb && followsCasterGroup) {
      originateSelfCb.addEventListener('change', () => {
        followsCasterGroup.classList.toggle('hidden', !originateSelfCb.checked);
        // Uncheck follows caster if originate self is unchecked
        if (!originateSelfCb.checked) {
          const followsCasterCb = el.querySelector('input[name="aoe.followsCaster"]');
          if (followsCasterCb) followsCasterCb.checked = false;
        }
      });
    }

    // Damage type dropdown change - hide/show piercing for TRUE, FP, AP (they bypass resistance)
    const NO_PIERCING_TYPES = ['TRUE', 'FP', 'AP'];
    el.querySelectorAll('.damage-type-select').forEach(select => {
      select.addEventListener('change', () => {
        const damageItem = select.closest('.combat-damage-item');
        if (!damageItem) return;
        const type = select.value;
        const piercingBtn = damageItem.querySelector('.piercing-toggle-btn');
        const piercingRow = damageItem.querySelector('.piercing-row');
        const shouldHide = NO_PIERCING_TYPES.includes(type);

        if (piercingBtn) {
          piercingBtn.classList.toggle('hidden', shouldHide);
        }
        if (piercingRow) {
          piercingRow.classList.toggle('no-piercing', shouldHide);
          if (shouldHide) {
            piercingRow.classList.add('hidden');
          }
        }
      });
    });

    // Main tab switching (Combat vs Animation)
    el.querySelectorAll('.main-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._saveCombatFormState();
        this._saveAnimationFormState();
        this._saveTargetingFormState();
        this._activeMainTab = btn.dataset.maintab;
        this.render();
      });
    });

    // Combat effects tab switching (Primary vs Secondary)
    el.querySelectorAll('.combat-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._saveCombatFormState();
        this._activeCombatTab = btn.dataset.tab;
        this.render();
      });
    });

    // Animation searchable dropdown
    this._setupAnimationDropdowns(el);

    // Animation preview buttons
    el.querySelectorAll('.animation-preview-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slot = btn.dataset.slot;
        const fileInput = el.querySelector(`input[name="animation.${slot}.file"]`);
        const file = fileInput?.value;
        if (file) {
          await previewAnimation(file);
        } else {
          ui.notifications.warn('No animation file selected');
        }
      });
    });

    // Animation file input change - validate and show label
    el.querySelectorAll('.animation-file-input').forEach(input => {
      input.addEventListener('change', () => {
        const file = input.value;
        const label = input.parentElement?.querySelector('.animation-file-label');
        if (label) {
          label.textContent = file ? formatAnimationLabel(file) : 'None selected';
          label.classList.toggle('has-value', !!file);
        }
        // Validate if animation exists
        if (file && !animationExists(file)) {
          input.classList.add('invalid');
          input.title = 'Animation not found in database';
        } else {
          input.classList.remove('invalid');
          input.title = '';
        }
      });
    });

    // Restoration type dropdown change - toggle dynamic fields per row
    el.querySelectorAll('.restoration-type-select').forEach(select => {
      select.addEventListener('change', () => {
        const row = select.closest('.combat-restoration-row');
        if (!row) return;
        const type = select.value;
        row.dataset.restorationType = type;
        const diceFields = row.querySelector('.restoration-dice-fields');
        const overMax = row.querySelector('.restoration-overmax');
        const buildupTarget = row.querySelector('.restoration-buildup-target');
        const cureConditions = row.querySelector('.restoration-cure-conditions');
        const cureEffects = row.querySelector('.restoration-cure-effects');

        const hasDice = !['cure-condition', 'cure-effect'].includes(type);
        const showOverMax = ['heal-hp', 'restore-fp', 'restore-ap'].includes(type);
        const showBuildup = type === 'reduce-buildup';
        const showCureCond = type === 'cure-condition';
        const showCureEff = type === 'cure-effect';

        if (diceFields) diceFields.style.display = hasDice ? '' : 'none';
        if (overMax) overMax.style.display = showOverMax ? '' : 'none';
        if (buildupTarget) buildupTarget.style.display = showBuildup ? '' : 'none';
        if (cureConditions) cureConditions.style.display = showCureCond ? '' : 'none';
        if (cureEffects) cureEffects.style.display = showCureEff ? '' : 'none';
      });
    });

    // Scaling source change - show/hide weapon hand dropdown and manual scaling container
    el.querySelectorAll('.scaling-source-select').forEach(select => {
      select.addEventListener('change', () => {
        const row = select.closest('.combat-component-row') || select.closest('.restoration-dice-fields');
        if (!row) return;
        const weaponHandSelect = row.querySelector('.weapon-hand-select');
        if (weaponHandSelect) {
          weaponHandSelect.style.display = select.value === 'weapon' ? '' : 'none';
        }
        // Show/hide manual scaling container
        const item = select.closest('.combat-damage-item, .combat-buildup-item, .combat-restoration-row, .damage-protection-item, .buildup-protection-item');
        if (item) {
          const manualContainer = item.querySelector('.manual-scaling-container');
          if (manualContainer) {
            manualContainer.classList.toggle('hidden', select.value !== 'manual');
          }
        }
      });
    });

    // Manual scaling mode change - show/hide grade select and update titles based on mode (graded vs flat)
    el.querySelectorAll('.scaling-mode-select').forEach(select => {
      select.addEventListener('change', () => {
        const row = select.closest('.manual-scaling-row');
        if (!row) return;
        const isFlat = select.value === 'flat';

        // Hide/show grade dropdown
        const gradeSelect = row.querySelector('.scaling-grade-select');
        if (gradeSelect) {
          gradeSelect.classList.toggle('hidden', isFlat);
        }

        // Update stat dropdown title to reflect mode
        const statSelect = row.querySelector('.scaling-stat-select');
        if (statSelect) {
          statSelect.title = isFlat ? 'Uses raw stat value' : 'Uses stat modifier';
        }
      });
    });

    // Prevent duplicate stats in manual scaling entries
    el.querySelectorAll('.scaling-stat-select').forEach(select => {
      // Store the previous value to revert if needed
      select.dataset.prevValue = select.value;

      select.addEventListener('change', () => {
        const container = select.closest('.manual-scaling-container');
        if (!container) return;

        const newStat = select.value;
        const currentRow = select.closest('.manual-scaling-row');

        // Check if this stat is already used by another entry in the same container
        const otherRows = container.querySelectorAll('.manual-scaling-row');
        for (const row of otherRows) {
          if (row === currentRow) continue;
          const otherStatSelect = row.querySelector('.scaling-stat-select');
          if (otherStatSelect && otherStatSelect.value === newStat) {
            // Duplicate found - revert to previous value
            ui.notifications.warn(`${newStat.charAt(0).toUpperCase() + newStat.slice(1)} is already used in this scaling entry.`);
            select.value = select.dataset.prevValue;
            return;
          }
        }

        // Valid change - update the stored value
        select.dataset.prevValue = newStat;
      });
    });

    // Piercing "Ignore All" checkbox - disable/enable tiers dropdown
    el.querySelectorAll('.piercing-all-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        const piercingRow = checkbox.closest('.piercing-row');
        if (!piercingRow) return;
        const tiersSelect = piercingRow.querySelector('.select-piercing-tiers');
        if (tiersSelect) {
          tiersSelect.disabled = checkbox.checked;
          if (checkbox.checked) tiersSelect.value = '0';
        }
      });
    });

    // No Save checkbox - disable/enable DC fields for status conditions
    el.querySelectorAll('.no-save-toggle input[type="checkbox"]').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        const optionsRow = checkbox.closest('.condition-row-options');
        if (!optionsRow) return;
        const isNoSave = checkbox.checked;
        // Toggle disabled class and attribute on DC-related fields
        optionsRow.querySelectorAll('.save-dc-label, .save-dc-input').forEach(field => {
          field.classList.toggle('disabled', isNoSave);
          if (field.tagName === 'INPUT' || field.tagName === 'SELECT') {
            field.disabled = isNoSave;
          }
        });
        // When NoSave is checked, reset DC fields to default values
        if (isNoSave) {
          const dcInput = optionsRow.querySelector('input[name*=".dc"]');
          const dcBonusSelect = optionsRow.querySelector('select[name*=".dcBonusSource"]');
          const saveTypeSelect = optionsRow.querySelector('select[name*=".saveType"]');
          if (dcInput) dcInput.value = 0;
          if (dcBonusSelect) dcBonusSelect.value = 'none';
          if (saveTypeSelect) saveTypeSelect.value = '';
        }
      });
    });

    // Condition type select - toggle stacks row visibility for Frenzy/Exhaustion
    const STACKABLE_CONDITIONS = ['Frenzy', 'Exhaustion'];
    el.querySelectorAll('.condition-type-select').forEach(select => {
      select.addEventListener('change', () => {
        const conditionItem = select.closest('.combat-condition-item');
        if (!conditionItem) return;
        const stacksRow = conditionItem.querySelector('.condition-row-stacks');
        if (!stacksRow) return;
        const isStackable = STACKABLE_CONDITIONS.includes(select.value);
        stacksRow.classList.toggle('hidden', !isStackable);
      });
    });

    // Script editing system
    const scriptCheckbox = el.querySelector('.script-enable-checkbox');
    const scriptTextarea = el.querySelector('.script-textarea');

    if (scriptCheckbox && scriptTextarea) {
      // Checkbox toggles textarea editability
      scriptCheckbox.addEventListener('change', () => {
        this._scriptEditingEnabled = scriptCheckbox.checked;
        scriptTextarea.readOnly = !scriptCheckbox.checked;
      });

      // Textarea input: detect first edit to lock builder
      scriptTextarea.addEventListener('input', () => {
        if (!this._scriptEditingEnabled) return;
        this._customScript = scriptTextarea.value;

        // First edit flips scriptEdited and locks builder (re-render for warning banner + lock)
        if (!this._scriptEdited) {
          this._scriptEdited = true;
          this._saveCombatFormState();
          this.render();
        }
      });
    }

    // Live script preview: update textarea when builder fields change (only if script not edited)
    if (scriptTextarea && !this._scriptEdited) {
      const updatePreview = () => {
        if (this._scriptEdited) return;
        this._saveCombatFormState();
        const name = el.querySelector('input[name="name"]')?.value || '';
        const aoe = {
          shape: el.querySelector('select[name="aoe.shape"]')?.value || '',
          sizeMin: parseInt(el.querySelector('input[name="aoe.sizeMin"]')?.value) || 0,
          sizeMax: parseInt(el.querySelector('input[name="aoe.sizeMax"]')?.value) || 0
        };
        scriptTextarea.value = this._generateScript({ name, aoe });
      };

      // Listen on all builder columns (basic, combat, targeting) for changes
      el.querySelectorAll('.col-basic, .col-combat, .col-targeting').forEach(col => {
        col.addEventListener('input', updatePreview);
        col.addEventListener('change', updatePreview);
      });
    }

    // Script expand/collapse toggle
    const expandBtn = el.querySelector('.script-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        const columns = el.querySelector('.builder-columns');
        if (!columns) return;
        const isExpanded = columns.classList.toggle('script-expanded');
        const icon = expandBtn.querySelector('i');
        if (icon) {
          icon.className = isExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        }
        expandBtn.title = isExpanded ? 'Shrink script editor' : 'Expand script editor';
      });
    }

    // Rest ability UI listeners
    const restTypeSelect = el.querySelector('.rest-type-select');
    const restUsesConfig = el.querySelector('.rest-uses-config');
    const restFlatConfig = el.querySelector('.rest-flat-config');
    const restFormulaConfig = el.querySelector('.rest-formula-config');

    if (restTypeSelect && restUsesConfig) {
      restTypeSelect.addEventListener('change', () => {
        this._restAbility.type = restTypeSelect.value || null;
        restUsesConfig.classList.toggle('hidden', !restTypeSelect.value);
      });
    }

    // Mode toggle: flat vs formula
    el.querySelectorAll('input[name="restAbility.maxUses.mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const mode = radio.value;
        this._restAbility.maxUses.mode = mode;
        if (restFlatConfig) restFlatConfig.classList.toggle('hidden', mode === 'formula');
        if (restFormulaConfig) restFormulaConfig.classList.toggle('hidden', mode !== 'formula');
      });
    });

    // Source dropdown change: show/hide flat value input
    el.querySelectorAll('.source-select').forEach(select => {
      select.addEventListener('change', () => {
        const term = select.closest('.formula-term');
        if (!term) return;
        const flatInput = term.querySelector('.flat-value-input');
        if (flatInput) flatInput.classList.toggle('hidden', select.value !== 'flat');
      });
    });

    // Operation dropdown change: show/hide modifier input
    el.querySelectorAll('.operation-select').forEach(select => {
      select.addEventListener('change', () => {
        const term = select.closest('.formula-term');
        if (!term) return;
        const modInput = term.querySelector('.modifier-input');
        if (modInput) modInput.classList.toggle('hidden', select.value === 'none');
      });
    });

    // Add term button
    const addTermBtn = el.querySelector('.add-term-btn');
    if (addTermBtn) {
      addTermBtn.addEventListener('click', () => {
        // Save current terms from DOM first, THEN add new term
        this._saveRestAbilityState();
        if (this._restAbility.maxUses.terms.length >= 3) return;
        this._restAbility.maxUses.terms.push({
          chain: 'add',
          source: 'flat',
          flatValue: 0,
          operation: 'none',
          modifier: 0
        });
        this.render();
      });
    }

    // Remove term buttons
    el.querySelectorAll('.remove-term-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Save current state BEFORE removing (to preserve other form values)
        this._saveRestAbilityState();
        const index = parseInt(btn.dataset.index);
        if (index > 0 && index < this._restAbility.maxUses.terms.length) {
          this._restAbility.maxUses.terms.splice(index, 1);
          this.render();
        }
      });
    });
  }

  _onClose(options) {
    // Clean up dropdown portal elements
    if (this._dropdownCleanup) {
      this._dropdownCleanup.forEach(cleanup => cleanup());
      this._dropdownCleanup = [];
    }
    if (this._onCloseCallback) this._onCloseCallback();
    super._onClose(options);
  }

  _detectMacroCategory(macro) {
    return CustomMacroBuilder._detectMacroCategoryStatic(macro);
  }

  /**
   * Static version of category detection for use before instance creation
   */
  static _detectMacroCategoryStatic(macro) {
    if (!macro) return null;
    if (macro.linkedSlot === 'mainHand') return 'mainHand';
    if (macro.linkedSlot === 'offHand') return 'offHand';
    if (macro.type === CONFIG.MACRO_TYPES.SPELL) {
      const cat = (macro.category || '').toLowerCase();
      if (['sorcery', 'hex', 'miracle', 'pyromancy'].includes(cat)) return cat;
      return 'sorcery';
    }
    if (macro.type === CONFIG.MACRO_TYPES.SPIRIT) return 'spirits';
    if (macro.type === CONFIG.MACRO_TYPES.WEAPON_SKILL) return 'skills';
    if (macro.macroCategory) return macro.macroCategory;
    return 'custom';
  }

  _initializeDice(macro) {
    if (!macro?.dice || macro.dice.length === 0) {
      return [{ count: 1, sides: 6, type: 'PHYSICAL' }];
    }
    return macro.dice.map(d => ({
      count: d.count || 1,
      sides: d.sides || d.value || 6,
      type: d.type || 'PHYSICAL'
    }));
  }

  _initCombatArray(existing, defaultTemplate) {
    if (!existing || !Array.isArray(existing) || existing.length === 0) return [];
    return existing.map(item => {
      const merged = { ...defaultTemplate, ...item };
      // Deep merge piercing object if present in default
      if (defaultTemplate.piercing) {
        merged.piercing = { ...defaultTemplate.piercing, ...item.piercing };
      }
      // Deep copy manualScalingEntries array if present
      if (defaultTemplate.manualScalingEntries !== undefined) {
        merged.manualScalingEntries = item.manualScalingEntries
          ? item.manualScalingEntries.map(e => ({ ...e }))
          : [];
      }
      return merged;
    });
  }

  async _prepareContext() {
    // Use tracked basic fields (preserved across re-renders) instead of existingMacro
    // This prevents field values from resetting when switching tabs
    const data = {
      // Basic fields from tracked state
      name: this._basicFields.name,
      description: this._basicFields.description,
      flavor: this._basicFields.flavor,
      icon: this._basicFields.icon,
      category: this._basicFields.category,
      keywords: this._basicFields.keywords,
      showDescriptionToPlayers: this._basicFields.showDescriptionToPlayers,
      apCost: this._basicFields.apCost,
      fpCost: this._basicFields.fpCost,
      hpCost: this._basicFields.hpCost,
      otherCost: this._basicFields.otherCost,
      range: this._basicFields.range,
      scalingBonus: this._basicFields.scalingBonus,
      scalingLink: this._basicFields.scalingLink,
      simpleRoll: this._basicFields.simpleRoll,
      // These come from other tracked state or existingMacro
      dice: this.diceEntries,
      statusEffect: this.existingMacro?.statusEffect || { name: '', duration: 0, stacks: 1 },
      customScript: this._customScript,
      scriptEdited: this._scriptEdited
    };

    // Generate line width options: 5, 10, 15, ... 100
    const lineWidthOptions = [];
    for (let w = 5; w <= 100; w += 5) lineWidthOptions.push(w);

    // Condition options for cure-condition (excludes effect-triggered conditions like Poisoned, BledOut)
    const conditionOptions = Object.values(CONFIG.CURABLE_CONDITIONS);
    // Effect options from config
    const effectOptions = Object.values(CONFIG.STATUS_EFFECTS);

    // DC bonus sources - stats, stat mods, skills, knowledge for dropdown
    // Stat keys must match template.json: vitality, endurance, strength, dexterity, attunement, intelligence, faith
    const dcBonusSources = [];
    const statNames = ['vitality', 'endurance', 'strength', 'dexterity', 'attunement', 'intelligence', 'faith'];
    const statLabels = ['Vitality', 'Endurance', 'Strength', 'Dexterity', 'Attunement', 'Intelligence', 'Faith'];
    // Stats (raw values)
    statNames.forEach((s, i) => dcBonusSources.push({ value: `statValue:${s}`, label: statLabels[i] }));
    // Stat Mods (calculated modifiers)
    statNames.forEach((s, i) => dcBonusSources.push({ value: `statMod:${s}`, label: `${statLabels[i]} Mod` }));
    // Skills from SD20 App
    const skillNames = ['Athletics', 'Acrobatics', 'Perception', 'FireKeeping', 'Sanity', 'Stealth', 'Precision', 'Diplomacy'];
    skillNames.forEach(s => dcBonusSources.push({ value: `skill:${s}`, label: `${s}` }));
    // Knowledge from SD20 App
    const knowledgeNames = ['Magics', 'WorldHistory', 'Monsters', 'Cosmic'];
    knowledgeNames.forEach(k => dcBonusSources.push({ value: `knowledge:${k}`, label: `${k}` }));

    // Restricted categories only allow editing name and scalingBonus
    const isRestrictedCategory = CustomMacroBuilder.RESTRICTED_CATEGORIES.includes(this.defaultCategory);

    // Monster scaling sources (for NPC macros - stat or statMod instead of weapon scaling)
    const monsterScalingSources = [
      { value: 'none', label: 'None' },
      { value: 'manual', label: 'Manual' },
      { value: 'stat:vitality', label: 'Vitality' },
      { value: 'statMod:vitality', label: 'Vitality Mod' },
      { value: 'stat:endurance', label: 'Endurance' },
      { value: 'statMod:endurance', label: 'Endurance Mod' },
      { value: 'stat:strength', label: 'Strength' },
      { value: 'statMod:strength', label: 'Strength Mod' },
      { value: 'stat:dexterity', label: 'Dexterity' },
      { value: 'statMod:dexterity', label: 'Dexterity Mod' },
      { value: 'stat:attunement', label: 'Attunement' },
      { value: 'statMod:attunement', label: 'Attunement Mod' },
      { value: 'stat:intelligence', label: 'Intelligence' },
      { value: 'statMod:intelligence', label: 'Intelligence Mod' },
      { value: 'stat:faith', label: 'Faith' },
      { value: 'statMod:faith', label: 'Faith Mod' }
    ];

    return {
      ...data,
      dice: this.diceEntries,
      isAppMacro: this.isAppMacro,
      isEditing: !!this.existingMacro,
      macroCategory: this.defaultCategory,
      isRestrictedCategory,
      isRestrictedEditMode: this._isRestrictedEditMode,
      lineWidthOptions,
      conditionOptions,
      effectOptions,
      dcBonusSources,
      combat: {
        damageTypes: this.combatDamageTypes,
        statusEffects: this.combatStatusEffects,
        statusConditions: this.combatStatusConditions,
        restoration: this.combatRestoration,
        vulnerabilities: this.combatVulnerabilities,
        // CF4: Protection arrays
        damageProtection: this.combatDamageProtection,
        buildupProtection: this.combatBuildupProtection,
        conditionProtection: this.combatConditionProtection,
        triggerOnCast: this._primaryTriggerOnCast
      },
      secondaryCombat: {
        damageTypes: this.secondaryCombatDamageTypes,
        statusEffects: this.secondaryCombatStatusEffects,
        statusConditions: this.secondaryCombatStatusConditions,
        restoration: this.secondaryCombatRestoration,
        vulnerabilities: this.secondaryCombatVulnerabilities,
        // CF4: Protection arrays
        damageProtection: this.secondaryCombatDamageProtection,
        buildupProtection: this.secondaryCombatBuildupProtection,
        conditionProtection: this.secondaryCombatConditionProtection,
        triggerOnCast: this._secondaryTriggerOnCast
      },
      activeCombatTab: this._activeCombatTab,
      // Use tracked targeting state (preserved across re-renders)
      targeting: this._targeting,
      // Use tracked AoE state (preserved across re-renders)
      aoe: this._aoe,
      aoeDuration: this._aoeDuration,
      aoePermanent: this._aoePermanent,
      // Pass expanded section states for template
      expandedSections: {
        damageTypes: this._expandedSections.has('damageTypes'),
        statusEffects: this._expandedSections.has('statusEffects'),
        statusConditions: this._expandedSections.has('statusConditions'),
        restoration: this._expandedSections.has('restoration'),
        vulnerabilities: this._expandedSections.has('vulnerabilities'),
        protection: this._expandedSections.has('protection'),
        'secondaryDamageTypes': this._expandedSections.has('secondaryDamageTypes'),
        'secondaryStatusEffects': this._expandedSections.has('secondaryStatusEffects'),
        'secondaryStatusConditions': this._expandedSections.has('secondaryStatusConditions'),
        'secondaryRestoration': this._expandedSections.has('secondaryRestoration'),
        'secondaryVulnerabilities': this._expandedSections.has('secondaryVulnerabilities'),
        'secondaryProtection': this._expandedSections.has('secondaryProtection')
      },
      // Script state
      scriptEditingEnabled: this._scriptEditingEnabled,
      scriptEdited: this._scriptEdited,
      scriptPreview: this._scriptEdited ? this._customScript : this._generateScript(data),
      // Rest ability state
      restAbility: this._restAbility,
      restFormulaSources: REST_FORMULA_SOURCES,
      // GM check for visibility options
      isGM: game.user.isGM,
      // NPC macros use stat scaling instead of weapon scaling
      isNPC: this.isNPC,
      monsterScalingSources,
      // Animation state
      activeMainTab: this._activeMainTab,
      animation: this._animation,
      animationAvailable: isAnimationSystemAvailable(),
      // Available animations from Sequencer database (for autocomplete)
      availableAnimations: isAnimationSystemAvailable() ? getAvailableAnimations() : [],
      // Pass targeting state for animation hint text
      targeting: this._targeting
    };
  }


  /**
   * Generate a human-readable script preview from the current builder state
   * @param {Object} data - The merged macro data object
   * @returns {string} Formatted JavaScript script
   */
  _generateScript(data) {
    const lines = [];
    lines.push('// Auto-generated by SD20 Macro Builder');
    lines.push(`// Macro: ${data.name || 'Untitled'} | Category: ${this.defaultCategory}`);
    lines.push('const caster = sd20.getCaster();');

    // Targeting
    const t = this._targeting;
    if (t.isTargetMacro) {
      const opts = [`mode: '${t.mode}'`];
      if (t.mode === 'single' && t.maxTargets > 1) opts.push(`maxTargets: ${t.maxTargets}`);
      if (t.includeSelf) opts.push('includeSelf: true');
      lines.push(`const targets = await sd20.resolveTargets({ ${opts.join(', ')} });`);
    }
    lines.push('');

    // Primary effects
    const primary = {
      damageTypes: this.combatDamageTypes,
      statusEffects: this.combatStatusEffects,
      statusConditions: this.combatStatusConditions,
      restoration: this.combatRestoration,
      triggerOnCast: this._primaryTriggerOnCast
    };
    const secondary = {
      damageTypes: this.secondaryCombatDamageTypes,
      statusEffects: this.secondaryCombatStatusEffects,
      statusConditions: this.secondaryCombatStatusConditions,
      restoration: this.secondaryCombatRestoration,
      triggerOnCast: this._secondaryTriggerOnCast
    };

    const hasPrimary = this._combatHasEffects(primary);
    const hasSecondary = this._combatHasEffects(secondary);

    if (hasPrimary) {
      if (hasSecondary) lines.push('// Primary Effects');
      this._generateCombatLines(lines, primary, t.isTargetMacro);
    }

    if (hasSecondary) {
      lines.push('');
      lines.push('// Secondary Effects');
      this._generateCombatLines(lines, secondary, t.isTargetMacro);
    }

    // AoE
    const aoe = data.aoe || {};
    if (aoe.shape && (aoe.sizeMin > 0 || aoe.sizeMax > 0)) {
      lines.push('');
      lines.push(`// AoE: ${aoe.shape} ${aoe.sizeMin}${aoe.sizeMax !== aoe.sizeMin ? '-' + aoe.sizeMax : ''}ft`);
    }

    return lines.join('\n');
  }

  /** Check if a combat config has any effects */
  _combatHasEffects(combat) {
    return !!(combat.damageTypes?.length || combat.statusEffects?.length ||
      combat.statusConditions?.length || combat.restoration?.length);
  }

  /** Generate script lines for a combat config (primary or secondary) */
  _generateCombatLines(lines, combat, hasTargets) {
    const targetArg = hasTargets ? 'targets, ' : '';

    for (const dmg of (combat.damageTypes || [])) {
      const formula = this._buildFormulaString(dmg);
      const opts = [`type: '${dmg.type || 'PHYSICAL'}'`];
      if (dmg.scalingSource === 'weapon') opts.push(`scaling: '${dmg.weaponHand || 'mainHand'}'`);
      lines.push(`await sd20.damage(${targetArg}'${formula}', { ${opts.join(', ')} });`);
    }

    for (const eff of (combat.statusEffects || [])) {
      const formula = this._buildFormulaString(eff);
      const opts = [];
      if (eff.scalingSource === 'weapon') opts.push(`scaling: '${eff.weaponHand || 'mainHand'}'`);
      const optsStr = opts.length ? `, { ${opts.join(', ')} }` : '';
      lines.push(`await sd20.buildup(${targetArg}'${eff.name || 'Buildup'}', '${formula}'${optsStr});`);
    }

    for (const cond of (combat.statusConditions || [])) {
      const opts = [];
      if (cond.duration) opts.push(`duration: ${cond.duration}`);
      if (cond.dc) opts.push(`dc: ${cond.dc}`);
      if (cond.dcBonusSource && cond.dcBonusSource !== 'none') opts.push(`dcBonus: '${cond.dcBonusSource}'`);
      const optsStr = opts.length ? `, { ${opts.join(', ')} }` : '';
      lines.push(`await sd20.condition(${targetArg}'${cond.name || 'Condition'}'${optsStr});`);
    }

    for (const rest of (combat.restoration || [])) {
      const formula = this._buildFormulaString(rest);
      const opts = [`type: '${rest.type || 'heal-hp'}'`];
      if (rest.allowOverMax) opts.push('allowOverMax: true');
      if (rest.statusEffect) opts.push(`statusEffect: '${rest.statusEffect}'`);
      if (rest.conditions?.length) opts.push(`conditions: [${rest.conditions.map(c => `'${c}'`).join(', ')}]`);
      if (rest.statusEffects?.length) opts.push(`statusEffects: [${rest.statusEffects.map(e => `'${e}'`).join(', ')}]`);
      lines.push(`await sd20.heal(${targetArg}'${formula}', { ${opts.join(', ')} });`);
    }
  }

  /** Build a dice formula string like '2d12+3' from a component */
  _buildFormulaString(component) {
    const parts = [];
    const count = parseInt(component.diceCount) || 0;
    const sides = parseInt(component.diceSides) || 6;
    if (count > 0) parts.push(`${count}d${sides}`);
    const flat = parseInt(component.flatBonus) || 0;
    if (flat > 0) parts.push(`${flat}`);
    else if (flat < 0) parts.push(`${flat}`);
    return parts.join('+').replace(/\+-/g, '-') || '0';
  }

  /* -------------------------------------------- */
  /*  Action Handlers                             */
  /* -------------------------------------------- */

  static #onSelectIcon() {
    this._showIconPicker();
  }

  static #onAddDice() {
    this.diceEntries.push({ count: 1, sides: 6, type: 'PHYSICAL' });
    this.render();
  }

  static #onRemoveDice(event, target) {
    const index = parseInt(target.dataset.index);
    this.diceEntries.splice(index, 1);
    if (this.diceEntries.length === 0) {
      this.diceEntries.push({ count: 1, sides: 6, type: 'PHYSICAL' });
    }
    this.render();
  }

  static async #onResetOriginal() {
    if (!this.existingMacro?.id) {
      ui.notifications.warn('No macro to reset');
      return;
    }

    // Prefer the app original (captured at open time from fresh app data)
    const resetSource = this._appOriginal || this.originalMacro;

    if (!resetSource) {
      ui.notifications.warn('No original values to reset to');
      return;
    }

    // Convert legacy dice[] format to combat.damageTypes if needed (same as constructor)
    let resetDamageTypes = resetSource.combat?.damageTypes;
    if (!resetDamageTypes?.length && resetSource.dice?.length) {
      // Convert dice array to damageTypes format with proper scaling support
      resetDamageTypes = resetSource.dice.map((d, i) => {
        // Try to get manual scaling entries from corresponding combat entry if available
        const combatEntry = resetSource.combat?.damageTypes?.[i];
        const manualScalingEntries = combatEntry?.manualScalingEntries || [];
        const hasManualEntries = manualScalingEntries.length > 0;
        return {
          type: d.type || 'PHYSICAL',
          diceCount: d.count || 1,
          diceSides: d.sides || d.value || 6,
          flatBonus: 0,
          scalingSource: hasManualEntries ? 'manual' : (resetSource.scalingBonus ? 'weapon' : 'none'),
          weaponHand: resetSource.linkedSlot || 'mainHand',
          manualScalingEntries: manualScalingEntries
        };
      });
    }

    const currentId = this.existingMacro.id;
    this.existingMacro = JSON.parse(JSON.stringify(resetSource));
    this.existingMacro.id = currentId;

    // Reset basic fields (these are what the form actually renders from)
    this._basicFields = {
      name: resetSource.name || '',
      description: resetSource.description || '',
      flavor: resetSource.flavor || '',
      icon: resetSource.icon || 'fa-solid fa-star',
      category: resetSource.category || this.defaultCategory,
      keywords: resetSource.keywords || '',
      apCost: resetSource.apCost ?? 0,
      fpCost: resetSource.fpCost ?? 0,
      hpCost: resetSource.hpCost ?? 0,
      otherCost: resetSource.otherCost || '',
      range: resetSource.range ?? 0,
      scalingBonus: resetSource.scalingBonus ?? 0,
      scalingLink: resetSource.scalingLink || 'none',
      simpleRoll: {
        diceCount: resetSource.simpleRoll?.diceCount ?? null,
        diceSides: resetSource.simpleRoll?.diceSides ?? null,
        bonus: resetSource.simpleRoll?.bonus ?? 0
      }
    };

    this.diceEntries = this._initializeDice(resetSource);
    this.combatDamageTypes = this._initCombatArray(resetDamageTypes, DEFAULT_DAMAGE_TYPE);
    this.combatStatusEffects = this._initCombatArray(resetSource.combat?.statusEffects, DEFAULT_STATUS_EFFECT);
    this.combatStatusConditions = this._initCombatArray(resetSource.combat?.statusConditions, DEFAULT_STATUS_CONDITION);
    this.combatRestoration = this._initCombatArray(resetSource.combat?.restoration, DEFAULT_RESTORATION);
    this.secondaryCombatDamageTypes = this._initCombatArray(resetSource.secondaryCombat?.damageTypes, DEFAULT_DAMAGE_TYPE);
    this.secondaryCombatStatusEffects = this._initCombatArray(resetSource.secondaryCombat?.statusEffects, DEFAULT_STATUS_EFFECT);
    this.secondaryCombatStatusConditions = this._initCombatArray(resetSource.secondaryCombat?.statusConditions, DEFAULT_STATUS_CONDITION);
    this.secondaryCombatRestoration = this._initCombatArray(resetSource.secondaryCombat?.restoration, DEFAULT_RESTORATION);
    this.combatVulnerabilities = this._initCombatArray(resetSource.combat?.vulnerabilities, DEFAULT_VULNERABILITY);
    this.secondaryCombatVulnerabilities = this._initCombatArray(resetSource.secondaryCombat?.vulnerabilities, DEFAULT_VULNERABILITY);
    this._primaryTriggerOnCast = resetSource.combat?.triggerOnCast ?? true;
    this._secondaryTriggerOnCast = resetSource.secondaryCombat?.triggerOnCast ?? false;
    // Reset rest ability
    this._restAbility = resetSource.restAbility ? JSON.parse(JSON.stringify(resetSource.restAbility)) : {
      type: null,
      maxUses: { mode: 'flat', flat: 1, terms: [{ source: 'flat', flatValue: 1, operation: 'none', modifier: 0 }] },
      currentUses: null  // null so it defaults to maxUses at runtime
    };
    // Reset targeting
    this._targeting = {
      isTargetMacro: resetSource.targeting?.isTargetMacro || false,
      mode: resetSource.targeting?.mode || 'single',
      maxTargets: resetSource.targeting?.maxTargets || 1,
      includeSelf: resetSource.targeting?.includeSelf || false
    };
    // Reset AoE
    this._aoe = {
      shape: resetSource.aoe?.shape || '',
      sizeMin: resetSource.aoe?.sizeMin || 0,
      sizeMax: resetSource.aoe?.sizeMax || 0,
      originateSelf: resetSource.aoe?.originateSelf || false,
      followsCaster: resetSource.aoe?.followsCaster || false,
      coneAngle: resetSource.aoe?.coneAngle || 90,
      lineWidth: resetSource.aoe?.lineWidth || 5,
      exclusionRadius: resetSource.aoe?.exclusionRadius || 0,
      playerVisibility: resetSource.aoe?.playerVisibility || 'hidden'
    };
    this._aoeDuration = resetSource.aoeDuration || 0;
    this._aoePermanent = resetSource.aoePermanent || false;
    // Reset animation
    this._animation = {
      enabled: resetSource.animation?.enabled ?? false,
      cast: resetSource.animation?.cast || { file: '', scale: 1.0, duration: null },
      projectile: resetSource.animation?.projectile || { file: '', scale: 1.0, duration: null, simultaneous: false },
      impact: resetSource.animation?.impact || { file: '', scale: 1.0, duration: null, simultaneous: false },
      area: resetSource.animation?.area || { file: '', scale: 1.0, duration: null }
    };
    // Reset script
    this._scriptEditingEnabled = false;
    this._scriptEdited = false;
    this._customScript = resetSource.customScript || '';
    this.defaultCategory = this._detectMacroCategory(resetSource) || 'custom';
    this.existingMacro.modified = false;
    this.existingMacro.editedFields = []; // Clear field-level tracking on reset

    // Update expanded sections to show reset data
    this._expandedSections = new Set();
    if (this.combatDamageTypes.length) this._expandedSections.add('damageTypes');
    if (this.combatStatusEffects.length) this._expandedSections.add('statusEffects');
    if (this.combatStatusConditions.length) this._expandedSections.add('statusConditions');
    if (this.combatRestoration.length) this._expandedSections.add('restoration');
    if (this.combatVulnerabilities.length) this._expandedSections.add('vulnerabilities');
    if (this.secondaryCombatDamageTypes.length) this._expandedSections.add('secondaryDamageTypes');
    if (this.secondaryCombatStatusEffects.length) this._expandedSections.add('secondaryStatusEffects');
    if (this.secondaryCombatStatusConditions.length) this._expandedSections.add('secondaryStatusConditions');
    if (this.secondaryCombatRestoration.length) this._expandedSections.add('secondaryRestoration');
    if (this.secondaryCombatVulnerabilities.length) this._expandedSections.add('secondaryVulnerabilities');

    // Force complete DOM rebuild by closing and re-rendering
    // This is necessary because Foundry's ApplicationV2 preserves form values during normal re-renders
    // Set flag to prevent form submission during render
    this._isResetting = true;
    await this.close();
    await this.render({ force: true });
    this._isResetting = false;
    ui.notifications.info('Reset to original App values');
  }

  static #onCancel() {
    this.close();
  }

  // Combat section toggle
  static #onToggleCombatSection(event, target) {
    const section = target.closest('.combat-section');
    if (!section) return;
    const icon = section.querySelector('.toggle-icon');
    // Use class-based toggle for reliable state tracking
    const isOpen = section.classList.contains('expanded');
    section.classList.toggle('expanded', !isOpen);
    if (icon) {
      icon.classList.toggle('fa-chevron-up', !isOpen);
      icon.classList.toggle('fa-chevron-down', isOpen);
    }
  }

  static #onAddDamageType(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatDamageTypes : this.combatDamageTypes;
    arr.push({ ...DEFAULT_DAMAGE_TYPE });
    this.render();
  }

  static #onRemoveDamageType(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatDamageTypes : this.combatDamageTypes;
    arr.splice(index, 1);
    this.render();
  }

  static #onTogglePiercing(event, target) {
    const index = parseInt(target.dataset.index);
    const isSecondary = target.dataset.secondary === 'true';
    this._saveCombatFormState();
    const arr = isSecondary ? this.secondaryCombatDamageTypes : this.combatDamageTypes;
    if (arr[index]) {
      if (!arr[index].piercing) {
        arr[index].piercing = { tiers: 0, allTiers: false, expanded: false };
      }
      arr[index].piercing.expanded = !arr[index].piercing.expanded;
    }
    this.render();
  }

  static #onAddStatusEffect(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatStatusEffects : this.combatStatusEffects;
    arr.push({ ...DEFAULT_STATUS_EFFECT });
    this.render();
  }

  static #onRemoveStatusEffect(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatStatusEffects : this.combatStatusEffects;
    arr.splice(index, 1);
    this.render();
  }

  static #onAddStatusCondition(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatStatusConditions : this.combatStatusConditions;
    arr.push({ ...DEFAULT_STATUS_CONDITION });
    this.render();
  }

  static #onRemoveStatusCondition(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatStatusConditions : this.combatStatusConditions;
    arr.splice(index, 1);
    this.render();
  }

  static #onAddRestoration(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatRestoration : this.combatRestoration;
    arr.push({ ...DEFAULT_RESTORATION });
    this.render();
  }

  static #onRemoveRestoration(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatRestoration : this.combatRestoration;
    arr.splice(index, 1);
    this.render();
  }

  static #onAddVulnerability(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatVulnerabilities : this.combatVulnerabilities;
    arr.push({ ...DEFAULT_VULNERABILITY });
    this.render();
  }

  static #onRemoveVulnerability(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatVulnerabilities : this.combatVulnerabilities;
    arr.splice(index, 1);
    this.render();
  }

  // CF4: Protection event handlers
  static #onAddDamageProtection(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatDamageProtection : this.combatDamageProtection;
    arr.push({ ...DEFAULT_DAMAGE_PROTECTION });
    this.render();
  }

  static #onRemoveDamageProtection(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatDamageProtection : this.combatDamageProtection;
    arr.splice(index, 1);
    this.render();
  }

  static #onAddBuildupProtection(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatBuildupProtection : this.combatBuildupProtection;
    arr.push({ ...DEFAULT_BUILDUP_PROTECTION });
    this.render();
  }

  static #onRemoveBuildupProtection(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatBuildupProtection : this.combatBuildupProtection;
    arr.splice(index, 1);
    this.render();
  }

  static #onAddConditionProtection(event, target) {
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatConditionProtection : this.combatConditionProtection;
    arr.push({ ...DEFAULT_CONDITION_PROTECTION });
    this.render();
  }

  static #onRemoveConditionProtection(event, target) {
    const index = parseInt(target.dataset.index);
    this._saveCombatFormState();
    const arr = target.closest('[data-combat-tab="secondary"]') ? this.secondaryCombatConditionProtection : this.combatConditionProtection;
    arr.splice(index, 1);
    this.render();
  }

  // Manual scaling entry handlers
  static #onAddManualScaling(event, target) {
    const componentType = target.dataset.component; // 'damageTypes', 'statusEffects', 'restoration', etc.
    const componentIndex = parseInt(target.dataset.componentIndex);
    const isSecondary = target.closest('[data-combat-tab="secondary"]') !== null;

    this._saveCombatFormState();

    // Get the correct array based on component type and primary/secondary
    let arr;
    switch (componentType) {
      case 'damageTypes':
        arr = isSecondary ? this.secondaryCombatDamageTypes : this.combatDamageTypes;
        break;
      case 'statusEffects':
        arr = isSecondary ? this.secondaryCombatStatusEffects : this.combatStatusEffects;
        break;
      case 'restoration':
        arr = isSecondary ? this.secondaryCombatRestoration : this.combatRestoration;
        break;
      case 'damageProtection':
        arr = isSecondary ? this.secondaryCombatDamageProtection : this.combatDamageProtection;
        break;
      case 'buildupProtection':
        arr = isSecondary ? this.secondaryCombatBuildupProtection : this.combatBuildupProtection;
        break;
      default:
        return;
    }

    if (arr[componentIndex]) {
      if (!arr[componentIndex].manualScalingEntries) {
        arr[componentIndex].manualScalingEntries = [];
      }

      // All available stats in preferred order
      const allStats = ['strength', 'dexterity', 'vitality', 'endurance', 'attunement', 'intelligence', 'faith'];

      // Find stats already used in this entry
      const usedStats = new Set(arr[componentIndex].manualScalingEntries.map(e => e.stat));

      // Find the first available stat
      const availableStat = allStats.find(s => !usedStats.has(s));

      if (!availableStat) {
        // All 7 stats are used - show warning
        ui.notifications.warn('All stats are already used in this scaling entry.');
        return;
      }

      // Add new entry with the first available stat
      arr[componentIndex].manualScalingEntries.push({
        mode: 'graded',
        grade: 'D',
        stat: availableStat,
        fraction: 'full'
      });
    }

    this.render();
  }

  static #onRemoveManualScaling(event, target) {
    const componentType = target.dataset.component;
    const componentIndex = parseInt(target.dataset.componentIndex);
    const entryIndex = parseInt(target.dataset.entryIndex);
    const isSecondary = target.closest('[data-combat-tab="secondary"]') !== null;

    this._saveCombatFormState();

    // Get the correct array based on component type and primary/secondary
    let arr;
    switch (componentType) {
      case 'damageTypes':
        arr = isSecondary ? this.secondaryCombatDamageTypes : this.combatDamageTypes;
        break;
      case 'statusEffects':
        arr = isSecondary ? this.secondaryCombatStatusEffects : this.combatStatusEffects;
        break;
      case 'restoration':
        arr = isSecondary ? this.secondaryCombatRestoration : this.combatRestoration;
        break;
      case 'damageProtection':
        arr = isSecondary ? this.secondaryCombatDamageProtection : this.combatDamageProtection;
        break;
      case 'buildupProtection':
        arr = isSecondary ? this.secondaryCombatBuildupProtection : this.combatBuildupProtection;
        break;
      default:
        return;
    }

    if (arr[componentIndex]?.manualScalingEntries) {
      arr[componentIndex].manualScalingEntries.splice(entryIndex, 1);
    }

    this.render();
  }

  static async #onResetToBuilder() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Reset to Builder' },
      content: '<p>This will discard your script edits and regenerate the script from builder fields. Continue?</p>',
      yes: { label: 'Reset', icon: 'fa-solid fa-rotate-left' },
      no: { label: 'Cancel' }
    });
    if (!confirmed) return;

    this._scriptEditingEnabled = false;
    this._scriptEdited = false;
    this._customScript = '';
    this.render();
    ui.notifications.info('Script reset to builder-generated preview');
  }

  /**
   * Read combat arrays from the DOM for a given field prefix
   * @param {string} prefix - 'combat' or 'secondaryCombat'
   * @param {Object} arrays - { damageTypes, statusEffects, statusConditions, restoration }
   * @returns {Object} Updated arrays read from form inputs
   */
  _readCombatArraysFromDOM(prefix, arrays) {
    const el = this.element;
    if (!el) return arrays;

    // Helper to read manual scaling entries for a component
    const readManualScalingEntries = (componentType, componentIndex) => {
      const entries = [];
      let entryIndex = 0;
      while (true) {
        const modeSelect = el.querySelector(`[name="${prefix}.${componentType}[${componentIndex}].manualScalingEntries[${entryIndex}].mode"]`);
        if (!modeSelect) break;
        entries.push({
          mode: modeSelect.value || 'graded',
          grade: el.querySelector(`[name="${prefix}.${componentType}[${componentIndex}].manualScalingEntries[${entryIndex}].grade"]`)?.value || 'D',
          stat: el.querySelector(`[name="${prefix}.${componentType}[${componentIndex}].manualScalingEntries[${entryIndex}].stat"]`)?.value || 'strength',
          fraction: el.querySelector(`[name="${prefix}.${componentType}[${componentIndex}].manualScalingEntries[${entryIndex}].fraction"]`)?.value || 'full'
        });
        entryIndex++;
      }
      return entries;
    };

    const damageTypes = arrays.damageTypes.map((entry, i) => ({
      type: el.querySelector(`[name="${prefix}.damageTypes[${i}].type"]`)?.value || entry.type,
      diceCount: parseInt(el.querySelector(`[name="${prefix}.damageTypes[${i}].diceCount"]`)?.value) || entry.diceCount,
      diceSides: parseInt(el.querySelector(`[name="${prefix}.damageTypes[${i}].diceSides"]`)?.value) || entry.diceSides,
      flatBonus: parseInt(el.querySelector(`[name="${prefix}.damageTypes[${i}].flatBonus"]`)?.value) || 0,
      scalingSource: el.querySelector(`[name="${prefix}.damageTypes[${i}].scalingSource"]`)?.value || entry.scalingSource,
      weaponHand: el.querySelector(`[name="${prefix}.damageTypes[${i}].weaponHand"]`)?.value || entry.weaponHand || 'mainHand',
      piercing: {
        tiers: parseInt(el.querySelector(`[name="${prefix}.damageTypes[${i}].piercing.tiers"]`)?.value) || 0,
        allTiers: el.querySelector(`[name="${prefix}.damageTypes[${i}].piercing.allTiers"]`)?.checked || false,
        expanded: entry.piercing?.expanded || false
      },
      manualScalingEntries: readManualScalingEntries('damageTypes', i)
    }));

    const statusEffects = arrays.statusEffects.map((entry, i) => ({
      name: el.querySelector(`[name="${prefix}.statusEffects[${i}].name"]`)?.value || entry.name,
      diceCount: parseInt(el.querySelector(`[name="${prefix}.statusEffects[${i}].diceCount"]`)?.value) || entry.diceCount,
      diceSides: parseInt(el.querySelector(`[name="${prefix}.statusEffects[${i}].diceSides"]`)?.value) || entry.diceSides,
      flatBonus: parseInt(el.querySelector(`[name="${prefix}.statusEffects[${i}].flatBonus"]`)?.value) || 0,
      scalingSource: el.querySelector(`[name="${prefix}.statusEffects[${i}].scalingSource"]`)?.value || entry.scalingSource,
      weaponHand: el.querySelector(`[name="${prefix}.statusEffects[${i}].weaponHand"]`)?.value || entry.weaponHand || 'mainHand',
      manualScalingEntries: readManualScalingEntries('statusEffects', i)
    }));

    const statusConditions = arrays.statusConditions.map((entry, i) => ({
      name: el.querySelector(`[name="${prefix}.statusConditions[${i}].name"]`)?.value || entry.name,
      duration: parseInt(el.querySelector(`[name="${prefix}.statusConditions[${i}].duration"]`)?.value) || 0,
      noSave: el.querySelector(`[name="${prefix}.statusConditions[${i}].noSave"]`)?.checked || false,
      dc: parseInt(el.querySelector(`[name="${prefix}.statusConditions[${i}].dc"]`)?.value) || 0,
      dcBonusSource: el.querySelector(`[name="${prefix}.statusConditions[${i}].dcBonusSource"]`)?.value || 'none',
      saveType: el.querySelector(`[name="${prefix}.statusConditions[${i}].saveType"]`)?.value || '',
      stacks: parseInt(el.querySelector(`[name="${prefix}.statusConditions[${i}].stacks"]`)?.value) || 1,
      stacking: el.querySelector(`[name="${prefix}.statusConditions[${i}].stacking"]`)?.checked || false
    }));

    const restoration = arrays.restoration.map((entry, i) => {
      const type = el.querySelector(`[name="${prefix}.restoration[${i}].type"]`)?.value || entry.type;
      const result = {
        type,
        diceCount: parseInt(el.querySelector(`[name="${prefix}.restoration[${i}].diceCount"]`)?.value) || entry.diceCount,
        diceSides: parseInt(el.querySelector(`[name="${prefix}.restoration[${i}].diceSides"]`)?.value) || entry.diceSides,
        flatBonus: parseInt(el.querySelector(`[name="${prefix}.restoration[${i}].flatBonus"]`)?.value) || 0,
        scalingSource: el.querySelector(`[name="${prefix}.restoration[${i}].scalingSource"]`)?.value || entry.scalingSource,
        weaponHand: el.querySelector(`[name="${prefix}.restoration[${i}].weaponHand"]`)?.value || entry.weaponHand || 'mainHand',
        allowOverMax: el.querySelector(`[name="${prefix}.restoration[${i}].allowOverMax"]`)?.checked || false,
        statusEffect: el.querySelector(`[name="${prefix}.restoration[${i}].statusEffect"]`)?.value || entry.statusEffect,
        conditions: [],
        statusEffects: [],
        manualScalingEntries: readManualScalingEntries('restoration', i)
      };
      el.querySelectorAll(`[name="${prefix}.restoration[${i}].conditions[]"]:checked`).forEach(cb => {
        result.conditions.push(cb.value);
      });
      el.querySelectorAll(`[name="${prefix}.restoration[${i}].statusEffects[]"]:checked`).forEach(cb => {
        result.statusEffects.push(cb.value);
      });
      return result;
    });

    const vulnerabilities = (arrays.vulnerabilities || []).map((entry, i) => ({
      type: el.querySelector(`[name="${prefix}.vulnerabilities[${i}].type"]`)?.value || entry.type,
      tiers: parseInt(el.querySelector(`[name="${prefix}.vulnerabilities[${i}].tiers"]`)?.value) || entry.tiers,
      flatTiers: parseInt(el.querySelector(`[name="${prefix}.vulnerabilities[${i}].flatTiers"]`)?.value) || 0,
      duration: parseInt(el.querySelector(`[name="${prefix}.vulnerabilities[${i}].duration"]`)?.value) || entry.duration,
      timing: el.querySelector(`[name="${prefix}.vulnerabilities[${i}].timing"]`)?.value || entry.timing,
      stacking: el.querySelector(`[name="${prefix}.vulnerabilities[${i}].stacking"]`)?.checked || false
    }));

    // CF4: Protection arrays
    const damageProtection = (arrays.damageProtection || []).map((entry, i) => ({
      type: el.querySelector(`[name="${prefix}.damageProtection[${i}].type"]`)?.value || entry.type,
      tiers: parseInt(el.querySelector(`[name="${prefix}.damageProtection[${i}].tiers"]`)?.value) || entry.tiers || 0,
      flat: parseInt(el.querySelector(`[name="${prefix}.damageProtection[${i}].flat"]`)?.value) || entry.flat || 0,
      diceCount: parseInt(el.querySelector(`[name="${prefix}.damageProtection[${i}].diceCount"]`)?.value) || entry.diceCount || 0,
      diceSides: parseInt(el.querySelector(`[name="${prefix}.damageProtection[${i}].diceSides"]`)?.value) || entry.diceSides || 0,
      percentage: parseInt(el.querySelector(`[name="${prefix}.damageProtection[${i}].percentage"]`)?.value) || entry.percentage || 0,
      percentageTiming: el.querySelector(`[name="${prefix}.damageProtection[${i}].percentageTiming"]`)?.value || entry.percentageTiming || 'INITIAL',
      durationTurns: parseInt(el.querySelector(`[name="${prefix}.damageProtection[${i}].durationTurns"]`)?.value) || entry.durationTurns || 0,
      durationAttacks: parseInt(el.querySelector(`[name="${prefix}.damageProtection[${i}].durationAttacks"]`)?.value) || entry.durationAttacks || 0,
      applyToCaster: el.querySelector(`[name="${prefix}.damageProtection[${i}].applyToCaster"]`)?.checked || false,
      applyToTarget: el.querySelector(`[name="${prefix}.damageProtection[${i}].applyToTarget"]`)?.checked ?? true,
      stacking: el.querySelector(`[name="${prefix}.damageProtection[${i}].stacking"]`)?.value || entry.stacking || 'OVERWRITE',
      scalingSource: el.querySelector(`[name="${prefix}.damageProtection[${i}].scalingSource"]`)?.value || entry.scalingSource || 'none',
      weaponHand: el.querySelector(`[name="${prefix}.damageProtection[${i}].weaponHand"]`)?.value || entry.weaponHand || 'mainHand'
    }));

    const buildupProtection = (arrays.buildupProtection || []).map((entry, i) => ({
      type: el.querySelector(`[name="${prefix}.buildupProtection[${i}].type"]`)?.value || entry.type,
      flat: parseInt(el.querySelector(`[name="${prefix}.buildupProtection[${i}].flat"]`)?.value) || entry.flat || 0,
      diceCount: parseInt(el.querySelector(`[name="${prefix}.buildupProtection[${i}].diceCount"]`)?.value) || entry.diceCount || 0,
      diceSides: parseInt(el.querySelector(`[name="${prefix}.buildupProtection[${i}].diceSides"]`)?.value) || entry.diceSides || 0,
      percentage: parseInt(el.querySelector(`[name="${prefix}.buildupProtection[${i}].percentage"]`)?.value) || entry.percentage || 0,
      percentageTiming: el.querySelector(`[name="${prefix}.buildupProtection[${i}].percentageTiming"]`)?.value || entry.percentageTiming || 'INITIAL',
      durationTurns: parseInt(el.querySelector(`[name="${prefix}.buildupProtection[${i}].durationTurns"]`)?.value) || entry.durationTurns || 0,
      durationAttacks: parseInt(el.querySelector(`[name="${prefix}.buildupProtection[${i}].durationAttacks"]`)?.value) || entry.durationAttacks || 0,
      applyToCaster: el.querySelector(`[name="${prefix}.buildupProtection[${i}].applyToCaster"]`)?.checked || false,
      applyToTarget: el.querySelector(`[name="${prefix}.buildupProtection[${i}].applyToTarget"]`)?.checked ?? true,
      stacking: el.querySelector(`[name="${prefix}.buildupProtection[${i}].stacking"]`)?.value || entry.stacking || 'OVERWRITE',
      scalingSource: el.querySelector(`[name="${prefix}.buildupProtection[${i}].scalingSource"]`)?.value || entry.scalingSource || 'none',
      weaponHand: el.querySelector(`[name="${prefix}.buildupProtection[${i}].weaponHand"]`)?.value || entry.weaponHand || 'mainHand'
    }));

    const conditionProtection = (arrays.conditionProtection || []).map((entry, i) => ({
      condition: el.querySelector(`[name="${prefix}.conditionProtection[${i}].condition"]`)?.value || entry.condition,
      durationTurns: parseInt(el.querySelector(`[name="${prefix}.conditionProtection[${i}].durationTurns"]`)?.value) || entry.durationTurns || 0,
      durationAttacks: parseInt(el.querySelector(`[name="${prefix}.conditionProtection[${i}].durationAttacks"]`)?.value) || entry.durationAttacks || 0,
      applyToCaster: el.querySelector(`[name="${prefix}.conditionProtection[${i}].applyToCaster"]`)?.checked || false,
      applyToTarget: el.querySelector(`[name="${prefix}.conditionProtection[${i}].applyToTarget"]`)?.checked ?? true
    }));

    return { damageTypes, statusEffects, statusConditions, restoration, vulnerabilities, damageProtection, buildupProtection, conditionProtection };
  }

  /**
   * Capture current combat form values before re-render (so user edits aren't lost)
   */
  _saveCombatFormState() {
    const el = this.element;
    if (!el) return;

    // Read primary combat arrays
    const primary = this._readCombatArraysFromDOM('combat', {
      damageTypes: this.combatDamageTypes,
      statusEffects: this.combatStatusEffects,
      statusConditions: this.combatStatusConditions,
      restoration: this.combatRestoration,
      vulnerabilities: this.combatVulnerabilities,
      // CF4: Protection arrays
      damageProtection: this.combatDamageProtection,
      buildupProtection: this.combatBuildupProtection,
      conditionProtection: this.combatConditionProtection
    });
    this.combatDamageTypes = primary.damageTypes;
    this.combatStatusEffects = primary.statusEffects;
    this.combatStatusConditions = primary.statusConditions;
    this.combatRestoration = primary.restoration;
    this.combatVulnerabilities = primary.vulnerabilities;
    // CF4: Protection arrays
    this.combatDamageProtection = primary.damageProtection;
    this.combatBuildupProtection = primary.buildupProtection;
    this.combatConditionProtection = primary.conditionProtection;

    // Read secondary combat arrays
    const secondary = this._readCombatArraysFromDOM('secondaryCombat', {
      damageTypes: this.secondaryCombatDamageTypes,
      statusEffects: this.secondaryCombatStatusEffects,
      statusConditions: this.secondaryCombatStatusConditions,
      restoration: this.secondaryCombatRestoration,
      vulnerabilities: this.secondaryCombatVulnerabilities,
      // CF4: Protection arrays
      damageProtection: this.secondaryCombatDamageProtection,
      buildupProtection: this.secondaryCombatBuildupProtection,
      conditionProtection: this.secondaryCombatConditionProtection
    });
    this.secondaryCombatDamageTypes = secondary.damageTypes;
    this.secondaryCombatStatusEffects = secondary.statusEffects;
    this.secondaryCombatStatusConditions = secondary.statusConditions;
    this.secondaryCombatRestoration = secondary.restoration;
    this.secondaryCombatVulnerabilities = secondary.vulnerabilities;
    // CF4: Protection arrays
    this.secondaryCombatDamageProtection = secondary.damageProtection;
    this.secondaryCombatBuildupProtection = secondary.buildupProtection;
    this.secondaryCombatConditionProtection = secondary.conditionProtection;

    // Save trigger-on-cast flags
    this._primaryTriggerOnCast = el.querySelector('input[name="combat.triggerOnCast"]')?.checked ?? this._primaryTriggerOnCast;
    this._secondaryTriggerOnCast = el.querySelector('input[name="secondaryCombat.triggerOnCast"]')?.checked ?? this._secondaryTriggerOnCast;

    // Save targeting state
    const targetingToggle = el.querySelector('input[name="targeting.isTargetMacro"]');
    const targetingMode = el.querySelector('select[name="targeting.mode"]');
    const maxTargets = el.querySelector('input[name="targeting.maxTargets"]');
    const includeSelf = el.querySelector('input[name="targeting.includeSelf"]');

    this._targeting = {
      isTargetMacro: targetingToggle?.checked || false,
      mode: targetingMode?.value || 'single',
      maxTargets: parseInt(maxTargets?.value) || 1,
      includeSelf: includeSelf?.checked || false
    };

    // Save expanded section states
    el.querySelectorAll('.combat-section.collapsible').forEach(section => {
      const sectionName = section.dataset.section;
      if (section.classList.contains('expanded')) {
        this._expandedSections.add(sectionName);
      } else {
        this._expandedSections.delete(sectionName);
      }
    });

    // Save basic form fields (name, costs, etc.)
    this._saveBasicFormState();

    // Save rest ability state
    this._saveRestAbilityState();

    // Save animation state
    this._saveAnimationFormState();

    // Save targeting/AoE state
    this._saveTargetingFormState();
  }

  /**
   * Capture current animation form values before re-render
   */
  _saveAnimationFormState() {
    const el = this.element;
    if (!el) return;

    // Animation enabled checkbox
    const enabledCb = el.querySelector('input[name="animation.enabled"]');
    if (enabledCb) this._animation.enabled = enabledCb.checked;

    // Animation slots
    ['cast', 'projectile', 'impact', 'area'].forEach(slot => {
      const fileInput = el.querySelector(`input[name="animation.${slot}.file"]`);
      const scaleInput = el.querySelector(`input[name="animation.${slot}.scale"]`);
      const durationInput = el.querySelector(`input[name="animation.${slot}.duration"]`);

      if (fileInput) this._animation[slot].file = fileInput.value || '';
      if (scaleInput) this._animation[slot].scale = parseFloat(scaleInput.value) || 1.0;
      if (durationInput) {
        const val = durationInput.value;
        this._animation[slot].duration = val === '' || val === 'auto' ? null : parseFloat(val);
      }
    });

    // Area exclusion respect checkbox
    const exclusionCb = el.querySelector('input[name="animation.area.respectExclusion"]');
    if (exclusionCb) this._animation.area.respectExclusion = exclusionCb.checked;

    // Simultaneous checkboxes for projectile and impact
    const projectileSimultaneous = el.querySelector('input[name="animation.projectile.simultaneous"]');
    if (projectileSimultaneous) this._animation.projectile.simultaneous = projectileSimultaneous.checked;

    const impactSimultaneous = el.querySelector('input[name="animation.impact.simultaneous"]');
    if (impactSimultaneous) this._animation.impact.simultaneous = impactSimultaneous.checked;
  }

  /**
   * Capture current targeting and AoE form values before re-render
   */
  _saveTargetingFormState() {
    const el = this.element;
    if (!el) return;

    // Targeting fields
    const isTargetCb = el.querySelector('input[name="targeting.isTargetMacro"]');
    const modeSelect = el.querySelector('select[name="targeting.mode"]');
    const maxTargetsInput = el.querySelector('input[name="targeting.maxTargets"]');
    const includeSelfCb = el.querySelector('input[name="targeting.includeSelf"]');

    if (isTargetCb) this._targeting.isTargetMacro = isTargetCb.checked;
    if (modeSelect) this._targeting.mode = modeSelect.value;
    if (maxTargetsInput) this._targeting.maxTargets = parseInt(maxTargetsInput.value) || 1;
    if (includeSelfCb) this._targeting.includeSelf = includeSelfCb.checked;

    // AoE fields
    const shapeSelect = el.querySelector('select[name="aoe.shape"]');
    const sizeMinInput = el.querySelector('input[name="aoe.sizeMin"]');
    const sizeMaxInput = el.querySelector('input[name="aoe.sizeMax"]');
    const originateSelfCb = el.querySelector('input[name="aoe.originateSelf"]');
    const followsCasterCb = el.querySelector('input[name="aoe.followsCaster"]');
    const coneAngleInput = el.querySelector('input[name="aoe.coneAngle"]');
    const lineWidthSelect = el.querySelector('select[name="aoe.lineWidth"]');
    const exclusionRadiusInput = el.querySelector('input[name="aoe.exclusionRadius"]');
    const playerVisibilitySelect = el.querySelector('select[name="aoe.playerVisibility"]');

    if (shapeSelect) this._aoe.shape = shapeSelect.value;
    if (sizeMinInput) this._aoe.sizeMin = parseInt(sizeMinInput.value) || 0;
    if (sizeMaxInput) this._aoe.sizeMax = parseInt(sizeMaxInput.value) || 0;
    if (originateSelfCb) this._aoe.originateSelf = originateSelfCb.checked;
    if (followsCasterCb) this._aoe.followsCaster = followsCasterCb.checked;
    if (coneAngleInput) this._aoe.coneAngle = parseInt(coneAngleInput.value) || 90;
    if (lineWidthSelect) this._aoe.lineWidth = parseInt(lineWidthSelect.value) || 5;
    if (exclusionRadiusInput) this._aoe.exclusionRadius = parseInt(exclusionRadiusInput.value) || 0;
    if (playerVisibilitySelect) this._aoe.playerVisibility = playerVisibilitySelect.value;

    // AoE duration
    const durationInput = el.querySelector('input[name="aoeDuration"]');
    const permanentCb = el.querySelector('input[name="aoePermanent"]');
    if (durationInput) this._aoeDuration = parseInt(durationInput.value) || 0;
    if (permanentCb) this._aoePermanent = permanentCb.checked;
  }

  /**
   * Capture basic form field values before re-render (prevents field reset on tab swap)
   */
  _saveBasicFormState() {
    const el = this.element;
    if (!el) return;

    // Basic info fields
    const nameInput = el.querySelector('input[name="name"]');
    const descInput = el.querySelector('textarea[name="description"]');
    const flavorInput = el.querySelector('textarea[name="flavor"]');
    const iconSelect = el.querySelector('select[name="icon"]');
    const categorySelect = el.querySelector('select[name="category"]');
    const keywordsInput = el.querySelector('input[name="keywords"]');

    if (nameInput) this._basicFields.name = nameInput.value;
    if (descInput) this._basicFields.description = descInput.value;
    if (flavorInput) this._basicFields.flavor = flavorInput.value;
    if (iconSelect) this._basicFields.icon = iconSelect.value;
    if (categorySelect) this._basicFields.category = categorySelect.value;
    if (keywordsInput) this._basicFields.keywords = keywordsInput.value;
    const showDescCb = el.querySelector('input[name="showDescriptionToPlayers"]');
    if (showDescCb) this._basicFields.showDescriptionToPlayers = showDescCb.checked;

    // Cost fields
    const apInput = el.querySelector('input[name="apCost"]');
    const fpInput = el.querySelector('input[name="fpCost"]');
    const hpInput = el.querySelector('input[name="hpCost"]');
    const otherInput = el.querySelector('input[name="otherCost"]');

    if (apInput) this._basicFields.apCost = parseInt(apInput.value) || 0;
    if (fpInput) this._basicFields.fpCost = parseInt(fpInput.value) || 0;
    if (hpInput) this._basicFields.hpCost = parseInt(hpInput.value) || 0;
    if (otherInput) this._basicFields.otherCost = otherInput.value;

    // Range and scaling
    const rangeInput = el.querySelector('input[name="range"]');
    const scalingBonusInput = el.querySelector('input[name="scalingBonus"]');
    const scalingLinkSelect = el.querySelector('select[name="scalingLink"]');

    if (rangeInput) this._basicFields.range = parseInt(rangeInput.value) || 0;
    if (scalingBonusInput) this._basicFields.scalingBonus = parseInt(scalingBonusInput.value) || 0;
    if (scalingLinkSelect) this._basicFields.scalingLink = scalingLinkSelect.value;

    // Simple roll fields
    const simpleCountInput = el.querySelector('input[name="simpleRoll.diceCount"]');
    const simpleSidesInput = el.querySelector('input[name="simpleRoll.diceSides"]');
    const simpleBonusInput = el.querySelector('input[name="simpleRoll.bonus"]');

    if (simpleCountInput) {
      const val = simpleCountInput.value;
      this._basicFields.simpleRoll.diceCount = val === '' ? null : parseInt(val);
    }
    if (simpleSidesInput) {
      const val = simpleSidesInput.value;
      this._basicFields.simpleRoll.diceSides = val === '' ? null : parseInt(val);
    }
    if (simpleBonusInput) {
      this._basicFields.simpleRoll.bonus = parseInt(simpleBonusInput.value) || 0;
    }
  }

  /**
   * Setup searchable animation dropdowns
   * @param {HTMLElement} el - The application element
   */
  _setupAnimationDropdowns(el) {
    // Get available animations (cached in animationSystem.js)
    const availableAnimations = isAnimationSystemAvailable() ? getAvailableAnimations() : [];
    debug(`Animation dropdowns setup: ${availableAnimations.length} animations available`);
    if (availableAnimations.length === 0) return;

    const MAX_VISIBLE = 30;

    // Track clicks inside dropdown (to prevent blur from closing it)
    let isSelectingItem = false;

    // Setup each animation file input
    el.querySelectorAll('.animation-file-input').forEach(input => {
      const slot = input.dataset.slot;

      // Create a NEW dropdown element that will be appended to body
      // This avoids overflow:hidden clipping from parent containers
      const dropdown = document.createElement('div');
      dropdown.className = 'animation-dropdown-portal';
      dropdown.dataset.slot = slot;

      debug(`Setting up dropdown for slot: ${slot}`);

      // Apply inline styles to dropdown - positioned fixed to escape overflow containers
      Object.assign(dropdown.style, {
        display: 'none',
        position: 'fixed',
        maxHeight: '450px',
        width: '300px',
        overflowY: 'auto',
        background: '#1a1a1a',
        border: '1px solid #c9aa71',
        borderRadius: '4px',
        zIndex: '100000',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.6)'
      });

      // Append to body so it's not clipped by overflow:hidden parents
      document.body.appendChild(dropdown);

      // Helper to position and show dropdown
      const showDropdown = () => {
        const rect = input.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 2}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${rect.width}px`;
        dropdown.style.display = 'block';
        debug(`Showing dropdown for ${slot} at (${rect.left}, ${rect.bottom})`);
      };
      const hideDropdown = () => {
        dropdown.style.display = 'none';
      };

      // Clean up dropdown when builder closes
      this._dropdownCleanup = this._dropdownCleanup || [];
      this._dropdownCleanup.push(() => dropdown.remove());

      // Populate dropdown with filtered results
      const populateDropdown = (filter = '') => {
        const filterLower = filter.toLowerCase();
        let filtered = availableAnimations;

        if (filterLower) {
          // Filter by search term (match anywhere in the path)
          filtered = availableAnimations.filter(a =>
            a.key.toLowerCase().includes(filterLower) ||
            a.label.toLowerCase().includes(filterLower)
          );
        }

        // Limit results
        const limited = filtered.slice(0, MAX_VISIBLE);

        // Build dropdown HTML with inline styles
        let html = '';
        if (filtered.length > MAX_VISIBLE) {
          html += `<div style="padding: 0.4rem 0.6rem; font-size: 0.65rem; color: #888; background: #111; border-bottom: 1px solid #333; position: sticky; top: 0;">${filtered.length} results - showing first ${MAX_VISIBLE}. Type to narrow.</div>`;
        }

        if (limited.length === 0) {
          html += '<div style="padding: 0.6rem; font-size: 0.7rem; color: #888; text-align: center; font-style: italic;">No animations found</div>';
        } else {
          limited.forEach(anim => {
            html += `<div class="animation-dropdown-item" data-key="${anim.key}" title="${anim.key}" style="padding: 0.5rem 0.6rem; font-size: 0.7rem; font-family: monospace; color: #fff; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #1a1a1a; border-bottom: 1px solid #333;">${anim.label}</div>`;
          });
        }

        dropdown.innerHTML = html;

        // Add hover effects and click handlers to items
        dropdown.querySelectorAll('.animation-dropdown-item').forEach(item => {
          item.addEventListener('mouseenter', () => {
            item.style.background = '#c9aa71';
            item.style.color = '#000';
          });
          item.addEventListener('mouseleave', () => {
            item.style.background = '#1a1a1a';
            item.style.color = '#fff';
          });
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isSelectingItem = true;
            const key = item.dataset.key;
            input.value = key;
            // Update animation state
            if (this._animation && this._animation[slot]) {
              this._animation[slot].file = key;
            }
            // Close dropdown
            hideDropdown();
            // Validate
            if (!animationExists(key)) {
              input.classList.add('invalid');
            } else {
              input.classList.remove('invalid');
            }
            // Reset flag after a tick
            setTimeout(() => { isSelectingItem = false; }, 50);
          });
        });
      };

      // Show dropdown on focus
      input.addEventListener('focus', () => {
        populateDropdown(input.value);
        showDropdown();
      });

      // Filter on input
      input.addEventListener('input', () => {
        populateDropdown(input.value);
        showDropdown();
      });

      // Hide dropdown on blur (only if not selecting an item)
      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (!isSelectingItem) {
            hideDropdown();
          }
        }, 150);
      });

      // Keyboard navigation
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          hideDropdown();
          input.blur();
        } else if (e.key === 'ArrowDown' && dropdown.style.display !== 'none') {
          e.preventDefault();
          const first = dropdown.querySelector('.animation-dropdown-item');
          if (first) {
            first.style.background = '#c9aa71';
            first.style.color = '#000';
          }
        } else if (e.key === 'Enter') {
          // Select first visible item on Enter
          const first = dropdown.querySelector('.animation-dropdown-item');
          if (first && dropdown.style.display !== 'none') {
            e.preventDefault();
            input.value = first.dataset.key;
            if (this._animation && this._animation[slot]) {
              this._animation[slot].file = first.dataset.key;
            }
            hideDropdown();
            input.blur();
          }
        }
      });
    });
  }

  /**
   * Capture current rest ability form values before re-render
   */
  _saveRestAbilityState() {
    const el = this.element;
    if (!el) return;

    const typeSelect = el.querySelector('.rest-type-select');
    if (typeSelect) {
      this._restAbility.type = typeSelect.value || null;
    }

    const modeFlat = el.querySelector('input[name="restAbility.maxUses.mode"][value="flat"]');
    const modeFormula = el.querySelector('input[name="restAbility.maxUses.mode"][value="formula"]');
    if (modeFlat?.checked) this._restAbility.maxUses.mode = 'flat';
    else if (modeFormula?.checked) this._restAbility.maxUses.mode = 'formula';

    const flatInput = el.querySelector('input[name="restAbility.maxUses.flat"]');
    if (flatInput) {
      this._restAbility.maxUses.flat = parseInt(flatInput.value) || 3;
    }

    // Read formula terms from DOM
    const termEls = el.querySelectorAll('.formula-term');
    const terms = [];
    termEls.forEach((termEl, i) => {
      const term = {
        source: termEl.querySelector('.source-select')?.value || 'flat',
        flatValue: parseInt(termEl.querySelector('.flat-value-input')?.value) || 0,
        operation: termEl.querySelector('.operation-select')?.value || 'none',
        modifier: parseInt(termEl.querySelector('.modifier-input')?.value) || 0
      };
      if (i > 0) {
        term.chain = termEl.querySelector('.chain-select')?.value || 'add';
      }
      terms.push(term);
    });
    if (terms.length > 0) {
      this._restAbility.maxUses.terms = terms;
    }
  }

  /**
   * Form submission handler (replaces _updateObject)
   */
  static async #onFormSubmit(event, form, formData) {
    // Skip form submission during reset (render() triggers form submission)
    if (this._isResetting) {
      return false;
    }

    const fd = formData.object;

    // Validate AoE configuration (if shape is selected, size must be provided)
    const aoeShape = fd['aoe.shape'] || '';
    const aoeSizeMin = parseInt(fd['aoe.sizeMin']) || 0;
    const aoeSizeMax = parseInt(fd['aoe.sizeMax']) || 0;

    if (aoeShape && aoeSizeMin <= 0 && aoeSizeMax <= 0) {
      ui.notifications.warn('AoE shape is selected but no size is provided. Please enter a minimum or maximum size (in feet).');
      return false;
    }

    // Validate targeting configuration
    const isTargetMacro = fd['targeting.isTargetMacro'] === 'on' || fd['targeting.isTargetMacro'] === true;
    const targetingMode = fd['targeting.mode'] || 'single';
    const maxTargets = parseInt(fd['targeting.maxTargets']) || 1;

    if (isTargetMacro) {
      // Single target mode requires at least 1 max target
      if (targetingMode === 'single' && maxTargets < 1) {
        ui.notifications.warn('Single target mode requires at least 1 max target');
        return false;
      }

      // AoE mode requires AoE shape to be set
      if (targetingMode === 'aoe') {
        const aoeShape = fd['aoe.shape'] || '';
        if (!aoeShape) {
          ui.notifications.warn('AoE targeting mode requires an AoE shape to be selected');
          return false;
        }
        const aoeSizeMin = parseInt(fd['aoe.sizeMin']) || 0;
        const aoeSizeMax = parseInt(fd['aoe.sizeMax']) || 0;
        if (aoeSizeMin <= 0 && aoeSizeMax <= 0) {
          ui.notifications.warn('AoE targeting mode requires a valid AoE size');
          return false;
        }
      }
    }

    // Legacy dice entries - no longer used, replaced by combat.damageTypes
    // Clear legacy dice array to prevent it from being converted back on re-edit
    const dice = [];

    // Parse combat configuration from form
    this._saveCombatFormState();
    const combat = {
      damageTypes: this.combatDamageTypes.length ? this.combatDamageTypes : [],
      statusEffects: this.combatStatusEffects.length ? this.combatStatusEffects : [],
      statusConditions: this.combatStatusConditions.length ? this.combatStatusConditions : [],
      restoration: this.combatRestoration.length ? this.combatRestoration : [],
      vulnerabilities: this.combatVulnerabilities.length ? this.combatVulnerabilities : [],
      // CF4: Protection arrays
      damageProtection: this.combatDamageProtection.length ? this.combatDamageProtection : [],
      buildupProtection: this.combatBuildupProtection.length ? this.combatBuildupProtection : [],
      conditionProtection: this.combatConditionProtection.length ? this.combatConditionProtection : [],
      triggerOnCast: this._primaryTriggerOnCast
    };
    const secondaryCombat = {
      damageTypes: this.secondaryCombatDamageTypes.length ? this.secondaryCombatDamageTypes : [],
      statusEffects: this.secondaryCombatStatusEffects.length ? this.secondaryCombatStatusEffects : [],
      statusConditions: this.secondaryCombatStatusConditions.length ? this.secondaryCombatStatusConditions : [],
      restoration: this.secondaryCombatRestoration.length ? this.secondaryCombatRestoration : [],
      vulnerabilities: this.secondaryCombatVulnerabilities.length ? this.secondaryCombatVulnerabilities : [],
      // CF4: Protection arrays
      damageProtection: this.secondaryCombatDamageProtection.length ? this.secondaryCombatDamageProtection : [],
      buildupProtection: this.secondaryCombatBuildupProtection.length ? this.secondaryCombatBuildupProtection : [],
      conditionProtection: this.secondaryCombatConditionProtection.length ? this.secondaryCombatConditionProtection : [],
      triggerOnCast: this._secondaryTriggerOnCast
    };

    // Calculate edited fields BEFORE building macroData for use with for 'modified' flag
    const editedFields = this.isAppMacro ? this._calculateEditedFields(fd, combat) : [];
    const isModified = this.isAppMacro && editedFields.length > 0;

    const macroData = {
      id: this.existingMacro?.id || `custom-${foundry.utils.randomID()}`,
      type: this.existingMacro?.type || CONFIG.MACRO_TYPES.CUSTOM,
      name: fd.name || 'Custom Macro',
      description: fd.description || '',
      apCost: parseInt(fd.apCost) || 0,
      fpCost: parseInt(fd.fpCost) || 0,
      icon: fd.icon || 'fa-solid fa-star',
      dice,
      combat,
      secondaryCombat,
      scalingLink: fd.scalingLink || 'none',
      scalingBonus: (fd.scalingLink === 'mainHand' || fd.scalingLink === 'offHand')
        ? 0  // resolved at runtime from equipped weapon
        : (parseInt(fd.scalingBonus) || this.existingMacro?.scalingBonus || 0),
      range: parseInt(fd.range) || 0,
      aoeDuration: (fd.aoePermanent === 'on' || fd.aoePermanent === true) ? -1 : (parseInt(fd.aoeDuration) || 0),
      aoePermanent: fd.aoePermanent === 'on' || fd.aoePermanent === true,
      statusEffect: {
        name: fd['statusEffect.name'] || '',
        duration: parseInt(fd['statusEffect.duration']) || 0,
        stacks: parseInt(fd['statusEffect.stacks']) || 1
      },
      aoe: {
        shape: fd['aoe.shape'] || '',
        sizeMin: parseInt(fd['aoe.sizeMin']) || 0,
        sizeMax: parseInt(fd['aoe.sizeMax']) || 0,
        originateSelf: fd['aoe.originateSelf'] === 'on' || fd['aoe.originateSelf'] === true,
        followsCaster: fd['aoe.followsCaster'] === 'on' || fd['aoe.followsCaster'] === true,
        coneAngle: parseInt(fd['aoe.coneAngle']) || 90,
        lineWidth: parseInt(fd['aoe.lineWidth']) || 5,
        exclusionRadius: parseInt(fd['aoe.exclusionRadius']) || 0,
        playerVisibility: fd['aoe.playerVisibility'] || 'hidden'
      },
      targeting: {
        isTargetMacro: fd['targeting.isTargetMacro'] === 'on' || fd['targeting.isTargetMacro'] === true,
        mode: fd['targeting.mode'] || 'single',
        maxTargets: parseInt(fd['targeting.maxTargets']) || 1,
        includeSelf: fd['targeting.includeSelf'] === 'on' || fd['targeting.includeSelf'] === true
      },
      customScript: this._scriptEdited ? this._customScript : null,
      scriptEdited: this._scriptEdited,
      macroSet: this.macroBar?.activeSet || 1,
      source: this.isAppMacro ? CONFIG.MACRO_SOURCES.APP : CONFIG.MACRO_SOURCES.CUSTOM,
      sourceId: this.existingMacro?.sourceId || null,
      linkedSlot: this._getLinkedSlot(fd.macroCategory, this.existingMacro?.linkedSlot),
      modified: isModified,
      editedFields: editedFields,
      // Preserve the stored app original for "Reset to App Defaults"
      appOriginalData: this.isAppMacro ? (this._appOriginal || this.existingMacro?.appOriginalData || null) : null,
      attackType: this.existingMacro?.attackType || null,
      weaponType: this.existingMacro?.weaponType || null,
      // Preserve catalyst info for spell/spirit grouping
      catalystId: this.existingMacro?.catalystId || null,
      catalystSlot: this.existingMacro?.catalystSlot || null,
      showDescriptionToPlayers: this._basicFields.showDescriptionToPlayers ?? true,
      macroCategory: fd.macroCategory || 'custom',
      category: this._getSpellCategory(fd.macroCategory, this.existingMacro?.category),
      // Simple roll (optional XdY + bonus, ignored if diceSides is not set)
      simpleRoll: {
        diceCount: parseInt(fd['simpleRoll.diceCount']) || null,
        diceSides: parseInt(fd['simpleRoll.diceSides']) || null,
        bonus: parseInt(fd['simpleRoll.bonus']) || 0
      },
      // Rest ability (SR/LR with use tracking)
      restAbility: this._restAbility,
      // Animation configuration
      animation: this._animation.enabled ? {
        enabled: true,
        cast: this._animation.cast.file ? { ...this._animation.cast } : null,
        projectile: this._animation.projectile.file ? { ...this._animation.projectile } : null,
        impact: this._animation.impact.file ? { ...this._animation.impact } : null,
        area: this._animation.area.file ? { ...this._animation.area } : null
      } : null
    };

    // Library edit mode - save via callback instead of macro bar
    if (this._isLibraryEdit && this._onSaveCallback) {
      await this._onSaveCallback(macroData);
      this.close(); // Close after successful save
      return;
    }

    const macro = macroData;

    if (this.macroBar) {
      // For new macros, pass null to append; for edits, use the existing slot
      // slotIndex of -1 means "new macro from All Macros Manager" - treat as null to append
      const slot = (this.slotIndex === -1 || !this.existingMacro) ? null : (this.slotIndex ?? null);
      await this.macroBar.addMacroToSlot(slot, macro);
      const action = this.existingMacro ? 'updated' : 'created';
      ui.notifications.info(`Macro "${macro.name}" ${action}`);

      if (!this.existingMacro) {
        const token = canvas.tokens.get(this.macroBar.tokenId);
        const actor = token?.actor;
        const sourceName = actor?.name || 'Unknown Actor';
        await addMacroToLibrary(macro, sourceName);
        debug(`Auto-added "${macro.name}" to library`);
      }
    }

    // Close the builder after successful save (validation passed)
    this.close();
  }

  /* -------------------------------------------- */
  /*  Helper Methods                              */
  /* -------------------------------------------- */

  _showIconPicker() {
    const iconsHtml = MACRO_ICONS.map(({ icon, label }) => `
      <div class="icon-option" data-icon="${icon}" title="${label}">
        <i class="${icon}"></i>
      </div>
    `).join('');

    const content = `
      <div class="sd20-icon-picker">
        <p>Select an icon:</p>
        <div class="icon-grid">${iconsHtml}</div>
        <div class="custom-icon">
          <label>Or enter custom FontAwesome class:</label>
          <input type="text" name="customIcon" placeholder="fa-solid fa-star" />
        </div>
      </div>
    `;

    const dialog = new foundry.applications.api.DialogV2({
      window: { title: 'Select Icon' },
      content,
      buttons: [
        {
          action: 'select',
          icon: 'fa-solid fa-check',
          label: 'Select',
          callback: (event, button) => {
            const customIcon = button.form?.querySelector('[name="customIcon"]')?.value;
            if (customIcon) this._setIcon(customIcon);
          }
        },
        {
          action: 'cancel',
          icon: 'fa-solid fa-times',
          label: 'Cancel'
        }
      ]
    });

    dialog.addEventListener('render', () => {
      dialog.element.querySelectorAll('.icon-option').forEach(opt => {
        opt.addEventListener('click', () => {
          this._setIcon(opt.dataset.icon);
          dialog.close();
        });
      });
    });

    dialog.render({ force: true });
  }

  _setIcon(icon) {
    const el = this.element;
    const input = el.querySelector('[name="icon"]');
    const preview = el.querySelector('.icon-preview i');
    const nameSpan = el.querySelector('.icon-name');
    if (input) input.value = icon;
    if (preview) preview.className = icon;
    if (nameSpan) nameSpan.textContent = icon;
  }

  _getLinkedSlot(category, existingLinkedSlot) {
    if (category === 'mainHand') return 'mainHand';
    if (category === 'offHand') return 'offHand';
    return existingLinkedSlot || null;
  }

  _getSpellCategory(macroCategory, existingCategory) {
    const spellCategories = ['sorcery', 'hex', 'miracle', 'pyromancy'];
    if (spellCategories.includes(macroCategory)) {
      return macroCategory.toUpperCase();
    }
    return existingCategory || null;
  }

  /**
   * Track edits to a combat array (damageTypes, statusEffects, etc.) at entry level.
   * Uses identity-based keys (type/name) to track which specific entries were edited.
   * @param {Array} currentEntries - Current entries in the form
   * @param {Array} originalEntries - Original entries from App
   * @param {string} fieldPrefix - Field prefix (e.g., 'combat.damageTypes')
   * @param {string} identityKey - Key for identity matching ('type' or 'name')
   * @param {Array} editedFields - Array to push edited field keys into
   */
  _trackCombatArrayEdits(currentEntries, originalEntries, fieldPrefix, identityKey, editedFields) {
    // Build map of original entries by identity
    const originalByIdentity = new Map();
    originalEntries.forEach((entry, index) => {
      const key = entry[identityKey];
      if (key) originalByIdentity.set(key, { entry, index });
    });

    // Build map of current entries by identity
    const currentByIdentity = new Map();
    currentEntries.forEach((entry, index) => {
      const key = entry[identityKey];
      if (key) currentByIdentity.set(key, { entry, index });
    });

    // Check each current entry against original
    for (const [identity, { entry: currentEntry, index }] of currentByIdentity) {
      const original = originalByIdentity.get(identity);

      if (!original) {
        // New entry added by user - mark as edited using identity key
        editedFields.push(`${fieldPrefix}:${identity}`);
      } else {
        // Entry exists in both - check if it was modified
        if (JSON.stringify(currentEntry) !== JSON.stringify(original.entry)) {
          // Entry was modified - track by identity
          editedFields.push(`${fieldPrefix}:${identity}`);
        }
      }
    }

    // Check for entries that were in original but removed by user
    // (Not tracked as "edited" - removal means user wants it gone)
  }

  /**
   * Calculate which fields have been edited compared to the original app data.
   * Only tracks meaningful changes, not dynamic values like scalingBonus.
   * Compares fresh each time - if value matches original, it's NOT edited.
   */
  _calculateEditedFields(fd, combat) {
    const original = this._appOriginal;

    // If no original app data, nothing is "edited" relative to app
    if (!original) return [];

    const editedFields = [];

    // === BASIC INFO SECTION ===
    if (fd.name !== original.name) editedFields.push('name');
    if (fd.description !== (original.description || '')) editedFields.push('description');
    if ((parseInt(fd.apCost) || 0) !== (original.apCost || 0)) editedFields.push('apCost');
    if ((parseInt(fd.fpCost) || 0) !== (original.fpCost || 0)) editedFields.push('fpCost');
    if ((parseInt(fd.range) || 0) !== (original.range || 0)) editedFields.push('range');
    if (fd.icon !== (original.icon || 'fa-solid fa-star')) editedFields.push('icon');
    if (fd.flavor !== (original.flavor || '')) editedFields.push('flavor');
    if (fd.keywords !== (original.keywords || '')) editedFields.push('keywords');

    // === PRIMARY COMBAT SECTION ===
    // Track edits at entry level using identity-based keys (type/name)
    const originalCombat = original.combat || {};

    // Track damageTypes edits by type identity (PHYSICAL, FIRE, etc.)
    this._trackCombatArrayEdits(
      combat.damageTypes || [],
      originalCombat.damageTypes || [],
      'combat.damageTypes',
      'type',
      editedFields
    );

    // Track statusEffects edits by name identity (Bleed, Poison, etc.)
    this._trackCombatArrayEdits(
      combat.statusEffects || [],
      originalCombat.statusEffects || [],
      'combat.statusEffects',
      'name',
      editedFields
    );

    // Track statusConditions edits by name identity
    this._trackCombatArrayEdits(
      combat.statusConditions || [],
      originalCombat.statusConditions || [],
      'combat.statusConditions',
      'name',
      editedFields
    );

    // Track restoration edits by type identity (heal-hp, restore-fp, etc.)
    this._trackCombatArrayEdits(
      combat.restoration || [],
      originalCombat.restoration || [],
      'combat.restoration',
      'type',
      editedFields
    );

    // Vulnerabilities - simple section-level tracking (not from App typically)
    if (JSON.stringify(combat.vulnerabilities) !== JSON.stringify(originalCombat.vulnerabilities || [])) {
      editedFields.push('combat.vulnerabilities');
    }

    // === SECONDARY COMBAT SECTION ===
    const secondaryCombat = {
      damageTypes: this.secondaryCombatDamageTypes || [],
      statusEffects: this.secondaryCombatStatusEffects || [],
      statusConditions: this.secondaryCombatStatusConditions || [],
      restoration: this.secondaryCombatRestoration || [],
      vulnerabilities: this.secondaryCombatVulnerabilities || []
    };
    const originalSecondary = original.secondaryCombat || {};
    if (JSON.stringify(secondaryCombat.damageTypes) !== JSON.stringify(originalSecondary.damageTypes || [])) {
      editedFields.push('secondaryCombat.damageTypes');
    }
    if (JSON.stringify(secondaryCombat.statusEffects) !== JSON.stringify(originalSecondary.statusEffects || [])) {
      editedFields.push('secondaryCombat.statusEffects');
    }
    if (JSON.stringify(secondaryCombat.statusConditions) !== JSON.stringify(originalSecondary.statusConditions || [])) {
      editedFields.push('secondaryCombat.statusConditions');
    }
    if (JSON.stringify(secondaryCombat.restoration) !== JSON.stringify(originalSecondary.restoration || [])) {
      editedFields.push('secondaryCombat.restoration');
    }

    // === ANIMATION SECTION ===
    if (JSON.stringify(this._animation) !== JSON.stringify(original.animation || {})) {
      editedFields.push('animation');
    }

    // === TARGETING SECTION ===
    if (JSON.stringify(this._targeting) !== JSON.stringify(original.targeting || {})) {
      editedFields.push('targeting');
    }

    // === AOE SECTION ===
    if (JSON.stringify(this._aoe) !== JSON.stringify(original.aoe || {})) {
      editedFields.push('aoe');
    }

    // === SCRIPT SECTION ===
    if (this._scriptEdited && this._customScript !== (original.customScript || '')) {
      editedFields.push('customScript');
    }

    return editedFields;
  }

  _findEmptySlot() {
    if (!this.macroBar) return 0;
    const currentSet = this.macroBar.macroSets[this.macroBar.activeSet] || [];
    for (let i = 0; i < 10; i++) {
      if (!currentSet[i]) return i;
    }
    return 0;
  }
}

/**
 * Open the custom macro builder
 */
export function openCustomMacroBuilder(macroBar, slotIndex = null, existingMacro = null, options = {}) {
  new CustomMacroBuilder(macroBar, slotIndex, existingMacro, options).render({ force: true });
}

/**
 * Register custom macro builder settings and helpers
 */
export function registerCustomMacroBuilder() {
  game.sd20 = game.sd20 || {};
  game.sd20.openCustomMacroBuilder = openCustomMacroBuilder;

  log('Custom macro builder registered');
}