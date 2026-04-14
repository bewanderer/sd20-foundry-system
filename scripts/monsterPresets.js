/**
 * Monster Preset System
 * Searchable preset selector for NPC actors with category grouping.
 */

const MODULE_ID = 'souls-d20';
let _presetsData = null;

async function loadPresets() {
  if (_presetsData) return _presetsData;
  try {
    const response = await fetch(`systems/${MODULE_ID}/data/monster-presets.json`);
    _presetsData = await response.json();
    console.log(`[SD20] Loaded ${_presetsData.presets.length} monster presets`);
  } catch (err) {
    console.error('[SD20] Failed to load monster presets:', err);
    _presetsData = { version: '1.0', categories: [], presets: [] };
  }
  return _presetsData;
}

function getSelectedPreset(actor) {
  return actor.getFlag(MODULE_ID, 'monsterPreset') || 'None';
}

function _buildDefaultChecks(stats) {
  const macros = [];
  const emptyCombat = { damageTypes: [], statusEffects: [], statusConditions: [], restoration: [], vulnerabilities: [], damageProtection: [], buildupProtection: [], conditionProtection: [], triggerOnCast: false };

  const dexMod = stats.dexterity?.mod || 0;
  macros.push({
    id: 'check-initiative', type: 'skill-check', name: 'Initiative',
    description: `1d20 + ${dexMod} (DEX)`, icon: 'fa-solid fa-bolt',
    source: 'custom', macroCategory: 'initiative', macroSet: 1,
    apCost: 0, fpCost: 0, simpleRoll: { diceCount: 1, diceSides: 20, bonus: dexMod },
    scalingBonus: 0, available: true, showDescriptionToPlayers: true,
    combat: {...emptyCombat}, secondaryCombat: {...emptyCombat},
  });

  const statNames = ['vitality', 'endurance', 'strength', 'dexterity', 'attunement', 'intelligence', 'faith'];
  for (const stat of statNames) {
    const mod = stats[stat]?.mod || 0;
    const label = stat.charAt(0).toUpperCase() + stat.slice(1);
    macros.push({
      id: `check-stat-${stat}`, type: 'skill-check', name: `${label} Check`,
      description: `1d20 + ${mod} (${label.substring(0, 3).toUpperCase()})`,
      icon: 'fa-solid fa-dumbbell', source: 'custom', macroCategory: 'statChecks', macroSet: 1,
      apCost: 0, fpCost: 0, simpleRoll: { diceCount: 1, diceSides: 20, bonus: mod },
      scalingBonus: 0, available: true, showDescriptionToPlayers: true,
      combat: {...emptyCombat}, secondaryCombat: {...emptyCombat},
    });
  }

  const skillFormulas = {
    'Athletics': ['strength', 'endurance'], 'Acrobatics': ['dexterity', 'endurance'],
    'Perception': ['intelligence', 'endurance'], 'FireKeeping': ['faith', 'endurance'],
    'Sanity': ['strength', 'attunement'], 'Stealth': ['dexterity', 'attunement'],
    'Precision': ['intelligence', 'attunement'], 'Diplomacy': ['faith', 'attunement'],
  };
  for (const [skill, [stat1, stat2]] of Object.entries(skillFormulas)) {
    const total = (stats[stat1]?.mod || 0) + (stats[stat2]?.mod || 0);
    macros.push({
      id: `check-skill-${skill.toLowerCase()}`, type: 'skill-check', name: skill,
      description: `1d20 + ${total}`, icon: 'fa-solid fa-dice-d20',
      source: 'custom', macroCategory: 'skillChecks', macroSet: 1,
      apCost: 0, fpCost: 0, simpleRoll: { diceCount: 1, diceSides: 20, bonus: total },
      scalingBonus: 0, available: true, showDescriptionToPlayers: true,
      combat: {...emptyCombat}, secondaryCombat: {...emptyCombat},
    });
  }

  return macros;
}

async function applyPreset(actor, presetName) {
  const data = await loadPresets();
  const preset = data.presets.find(p => p.name === presetName);
  if (!preset) return;

  const stats = {};
  for (const [key, val] of Object.entries(preset.stats)) {
    stats[key] = { value: val.value, mod: val.mod };
  }

  const macroSetId = 'set-1';
  const macroSets = {
    activeSet: macroSetId,
    setOrder: [macroSetId],
    sets: {
      [macroSetId]: {
        id: macroSetId,
        name: presetName,
        macros: _buildDefaultChecks(stats).concat(preset.macros.map(m => ({...m}))),
        active: true
      }
    }
  };

  await actor.update({
    'system.hp.value': preset.hp, 'system.hp.max': preset.hp,
    'system.fp.value': preset.fp, 'system.fp.max': preset.fp,
    'system.ap.value': preset.ap, 'system.ap.max': preset.ap,
    'system.stats': stats,
    'system.skillBonuses': preset.skillBonuses,
    'system.resistances': preset.resistances,
    'system.macroSets': macroSets,
    'prototypeToken.width': preset.tokenSize,
    'prototypeToken.height': preset.tokenSize,
  });

  await actor.setFlag(MODULE_ID, 'combat.statusThresholds', preset.statusThresholds);

  const immunities = preset.immunities || {};
  const combatSettings = {};
  if (immunities.statusEffects?.length) {
    combatSettings.statusEffectImmunities = {};
    for (const eff of immunities.statusEffects) combatSettings.statusEffectImmunities[eff] = true;
  }
  if (immunities.conditions?.length) {
    combatSettings.statusConditionImmunities = {};
    for (const cond of immunities.conditions) combatSettings.statusConditionImmunities[cond] = true;
  }
  if (immunities.damage?.length) {
    combatSettings.damageImmunities = {};
    for (const dmg of immunities.damage) combatSettings.damageImmunities[dmg] = true;
  }
  if (Object.keys(combatSettings).length > 0) {
    const existing = actor.getFlag(MODULE_ID, 'combatSettings') || {};
    await actor.setFlag(MODULE_ID, 'combatSettings', { ...existing, ...combatSettings });
  }

  if (preset.behavior) {
    await actor.setFlag(MODULE_ID, 'combat.behavior', preset.behavior);
  }

  await actor.setFlag(MODULE_ID, 'monsterPreset', presetName);

  if (game.sd20?.macroBar?.actorId === actor.id) {
    game.sd20.macroBar.initialize();
  }
}

// ApplicationV2 Preset Selector
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MonsterPresetSelector extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.searchQuery = '';
    this._selectedPresetName = null;
  }

  static DEFAULT_OPTIONS = {
    id: 'sd20-monster-preset-selector',
    classes: ['sd20-all-macros-dialog'],
    tag: 'form',
    window: {
      title: 'SD20 - Monster Presets',
      resizable: true
    },
    position: {
      width: 1200,
      height: 650
    },
    form: {
      handler: MonsterPresetSelector.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      applyPreset: MonsterPresetSelector.#onApplyPreset
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/monster-preset-selector.html',
      scrollable: ['.preset-list-container']
    }
  };

  async _prepareContext() {
    const data = await loadPresets();
    const currentPreset = getSelectedPreset(this.actor);

    const grouped = {};
    for (const cat of data.categories) {
      grouped[cat] = [];
    }

    for (const preset of data.presets) {
      const cat = preset.category || 'Monstrosities';
      if (!grouped[cat]) grouped[cat] = [];

      const abilityCount = preset.macros.filter(m => m.macroCategory === 'abilities').length;

      grouped[cat].push({
        name: preset.name,
        size: preset.size,
        hp: preset.hp,
        fp: preset.fp,
        ap: preset.ap,
        tokenSize: preset.tokenSize,
        abilityCount,
        isCurrent: preset.name === currentPreset,
        isSelected: preset.name === this._selectedPresetName,
      });
    }

    const categories = data.categories
      .filter(cat => grouped[cat]?.length > 0)
      .map(cat => ({ name: cat, presets: grouped[cat] }));

    return {
      categories,
      currentPreset: currentPreset !== 'None' ? currentPreset : null,
      hasSelection: !!this._selectedPresetName,
    };
  }

  _onRender() {
    const el = this.element;

    // Search input - filter DOM rows instead of re-rendering
    const searchInput = el.querySelector('.preset-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase();
        el.querySelectorAll('.preset-row').forEach(row => {
          const name = (row.dataset.presetName || '').toLowerCase();
          row.style.display = (!query || name.includes(query)) ? '' : 'none';
        });
        // Hide empty columns
        el.querySelectorAll('.preset-column').forEach(col => {
          const allRows = col.querySelectorAll('.preset-row');
          const hiddenRows = col.querySelectorAll('.preset-row[style*="none"]');
          col.style.display = (allRows.length > 0 && allRows.length === hiddenRows.length) ? 'none' : '';
        });
      });
    }

    // Preset row click to select
    el.querySelectorAll('.preset-row').forEach(row => {
      row.addEventListener('click', () => {
        const name = row.dataset.presetName;
        this._selectedPresetName = name;
        el.querySelectorAll('.preset-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        // Enable apply button
        const applyBtn = el.querySelector('.apply-btn');
        if (applyBtn) applyBtn.classList.remove('disabled');
        this._updateInfoPanel(el, name);
      });
    });
  }

  async _updateInfoPanel(el, presetName) {
    const infoPanel = el.querySelector('.preset-info-panel');
    if (!infoPanel) return;

    const data = await loadPresets();
    const preset = data.presets.find(p => p.name === presetName);
    if (!preset) {
      infoPanel.innerHTML = '<span class="info-empty">Select a preset to see details.</span>';
      return;
    }

    const abilityCount = preset.macros.filter(m => m.macroCategory === 'abilities').length;
    const res = Object.entries(preset.resistances)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`)
      .join(', ') || 'None';

    const thresholds = preset.statusThresholds || {};
    const poise = thresholds.Poise || 0;

    infoPanel.innerHTML = `
      <div class="info-name">${preset.name}</div>
      <div class="info-row">
        <span class="info-stat"><span class="label">HP</span> ${preset.hp}</span>
        <span class="info-stat"><span class="label">FP</span> ${preset.fp}</span>
        <span class="info-stat"><span class="label">AP</span> ${preset.ap}</span>
        <span class="info-stat"><span class="label">Size</span> ${preset.size}</span>
        <span class="info-stat"><span class="label">Abilities</span> ${abilityCount}</span>
        <span class="info-stat"><span class="label">Poise</span> ${poise}</span>
        <span class="info-stat"><span class="label">Res</span> ${res}</span>
      </div>
    `;
  }

  static async #onApplyPreset() {
    const presetName = this._selectedPresetName;
    const currentPreset = getSelectedPreset(this.actor);

    if (!presetName) {
      ui.notifications.warn('Select a preset first.');
      return;
    }

    if (presetName === 'None') return;

    if (presetName === currentPreset) {
      ui.notifications.info('This preset is already applied. Select a different preset first to re-apply.');
      return;
    }

    await applyPreset(this.actor, presetName);
    ui.notifications.info(`Applied preset: ${presetName}`);
    this.actor.sheet?.render();
    this.render();
  }

  static async #onSubmit() {
    // Handled by apply button action
  }
}

export function openPresetSelector(actor) {
  if (actor.type !== 'npc') {
    ui.notifications.warn('Monster presets are only available for NPC actors');
    return;
  }
  new MonsterPresetSelector(actor).render(true);
}
