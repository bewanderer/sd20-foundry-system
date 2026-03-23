/**
 * All Macros Manager
 * Full-featured dialog for managing all macros across all sets
 * Features: Search, filters, available/unavailable toggles, delete
 */

import { CONFIG } from './config.js';
import { log, debug, resolveMaxUses } from './utils.js';
import { getActiveMacroBar } from './macroBar.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * All Macros Manager Dialog
 */
export class AllMacrosManager extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(macroBar, options = {}) {
    super(options);
    this.macroBar = macroBar;
    this.searchQuery = '';
    this.filterCategory = 'all';
    this.filterSet = 'all';
    this._searchDebounceTimer = null;
    this._expandedSets = new Set();
    this._selectionMode = false;
    this._selectedMacros = new Map(); // Map of setId:macroId -> true
  }

  static DEFAULT_OPTIONS = {
    id: 'sd20-all-macros-manager',
    classes: ['sd20-all-macros-dialog'],
    tag: 'form',
    window: {
      title: 'SD20 - All Macros Manager',
      resizable: true
    },
    position: {
      width: 700,
      height: 600
    },
    form: {
      handler: null,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      toggleSet: AllMacrosManager.#onToggleSet,
      editSetName: AllMacrosManager.#onEditSetName,
      deleteSet: AllMacrosManager.#onDeleteSet,
      editMacro: AllMacrosManager.#onEditMacro,
      deleteMacro: AllMacrosManager.#onDeleteMacro,
      addMacroToSet: AllMacrosManager.#onAddMacroToSet,
      addSet: AllMacrosManager.#onAddSet,
      importFromLibrary: AllMacrosManager.#onImportFromLibrary,
      toggleSelectionMode: AllMacrosManager.#onToggleSelectionMode,
      selectAllVisible: AllMacrosManager.#onSelectAllVisible,
      deselectAll: AllMacrosManager.#onDeselectAll,
      resetToAppDefaults: AllMacrosManager.#onResetToAppDefaults
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/all-macros-manager.html',
      scrollable: ['.sets-container']
    }
  };

  async _prepareContext() {
    const macroBar = this.macroBar;
    if (!macroBar) return { sets: [], categories: CONFIG.MACRO_CATEGORIES };

    const sets = macroBar.setOrder.map(setId => {
      const setData = macroBar.macroSets[setId];
      if (!setData) return null;

      const macrosByCategory = {};
      for (const cat of CONFIG.MACRO_CATEGORIES) {
        macrosByCategory[cat.id] = [];
      }

      for (const macro of (setData.macros || [])) {
        if (!macro) continue;

        if (this.searchQuery) {
          const query = this.searchQuery.toLowerCase();
          const nameMatch = macro.name?.toLowerCase().includes(query);
          const descMatch = macro.description?.toLowerCase().includes(query);
          if (!nameMatch && !descMatch) continue;
        }

        const categoryId = macroBar._getMacroCategory(macro);
        if (this.filterCategory !== 'all' && categoryId !== this.filterCategory) continue;

        if (macrosByCategory[categoryId]) {
          const selectionKey = `${setId}:${macro.id}`;
          // Resolve rest ability max uses if present
          const token = canvas.tokens?.get(this.macroBar?.tokenId);
          const actor = token?.actor;
          const restAbilityData = macro.restAbility ? {
            ...macro.restAbility,
            maxUsesResolved: resolveMaxUses(macro.restAbility, actor)
          } : null;
          macrosByCategory[categoryId].push({
            ...macro,
            restAbility: restAbilityData,
            available: macro.available !== false,
            isAppMacro: !!macro.appSourceId,
            isModified: !!macro.modified,
            selected: this._selectedMacros.has(selectionKey),
            selectionKey
          });
        }
      }

      let visibleCount = 0;
      for (const cat of Object.values(macrosByCategory)) {
        visibleCount += cat.length;
      }

      return {
        id: setId,
        name: setData.name,
        active: setData.active !== false,
        macroCount: (setData.macros || []).filter(m => m).length,
        visibleCount,
        macrosByCategory,
        expanded: this._expandedSets.has(setId)
      };
    }).filter(s => s);

    const filteredSets = this.filterSet === 'all'
      ? sets
      : sets.filter(s => s.id === this.filterSet);

    // Count selected modified app macros (only these can be reset)
    let selectedResetCount = 0;
    for (const [key] of this._selectedMacros) {
      const [setId, macroId] = key.split(':');
      const setData = this.macroBar?.macroSets[setId];
      const macro = setData?.macros?.find(m => m?.id === macroId);
      if (macro?.appSourceId && macro?.modified) {
        selectedResetCount++;
      }
    }

    return {
      sets: filteredSets,
      allSets: sets,
      categories: CONFIG.MACRO_CATEGORIES,
      searchQuery: this.searchQuery,
      filterCategory: this.filterCategory,
      filterSet: this.filterSet,
      selectionMode: this._selectionMode,
      selectedCount: this._selectedMacros.size,
      selectedResetCount
    };
  }

  /**
   * Attach non-action listeners after render
   */
  _onRender(context, options) {
    super._onRender(context, options);

    const html = this.element;

    // Search input with debounce
    const searchInput = html.querySelector('.macro-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (event) => {
        if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => {
          this.searchQuery = event.target.value;
          this.render();
        }, 300);
      });
    }

    // Filter dropdowns
    const filterCategory = html.querySelector('.filter-category');
    if (filterCategory) {
      filterCategory.addEventListener('change', (event) => {
        this.filterCategory = event.target.value;
        this.render();
      });
    }

    const filterSet = html.querySelector('.filter-set');
    if (filterSet) {
      filterSet.addEventListener('change', (event) => {
        this.filterSet = event.target.value;
        this.render();
      });
    }

    // Set available toggles (checkboxes)
    html.querySelectorAll('.set-available-toggle').forEach(toggle => {
      toggle.addEventListener('change', async (event) => {
        event.stopPropagation();
        const section = event.target.closest('.set-section');
        const setId = section?.dataset.setId;
        const isAvailable = event.target.checked;

        if (this.macroBar?.macroSets[setId]) {
          this.macroBar.macroSets[setId].active = isAvailable;
          await this.macroBar.saveMacroSets();
          this.macroBar.render();
        }
      });
    });

    // Macro available toggles (checkboxes)
    html.querySelectorAll('.macro-available-toggle').forEach(toggle => {
      toggle.addEventListener('change', async (event) => {
        event.stopPropagation();
        const macroId = event.target.dataset.macroId;
        const section = event.target.closest('.set-section');
        const setId = section?.dataset.setId;
        const isAvailable = event.target.checked;

        if (!this.macroBar || !setId || !macroId) return;

        const setData = this.macroBar.macroSets[setId];
        if (!setData?.macros) return;

        const macro = setData.macros.find(m => m?.id === macroId);
        if (macro) {
          macro.available = isAvailable;
          await this.macroBar.saveMacroSets();
          this.macroBar.render();
        }
      });
    });

    // Macro tooltips
    html.querySelectorAll('.macro-item').forEach(item => {
      item.addEventListener('mouseenter', this._onMacroHover.bind(this));
      item.addEventListener('mouseleave', this._onMacroLeave.bind(this));
    });

    // Selection checkboxes (in selection mode)
    html.querySelectorAll('.macro-selection-toggle').forEach(toggle => {
      toggle.addEventListener('change', (event) => {
        event.stopPropagation();
        const selectionKey = event.target.dataset.selectionKey;
        if (!selectionKey) return;

        if (event.target.checked) {
          this._selectedMacros.set(selectionKey, true);
        } else {
          this._selectedMacros.delete(selectionKey);
        }
        this.render();
      });
    });
  }

  /* -------------------------------------------- */
  /*  Action Handlers                             */
  /* -------------------------------------------- */

  /**
   * Toggle set expand/collapse
   */
  static #onToggleSet(event, target) {
    // Don't toggle if clicking on checkbox or buttons
    if (event.target.closest('input, button')) return;

    const section = target.closest('.set-section');
    const setId = section?.dataset.setId;
    if (!setId) return;

    if (this._expandedSets.has(setId)) {
      this._expandedSets.delete(setId);
    } else {
      this._expandedSets.add(setId);
    }

    section.classList.toggle('expanded');
  }

  /**
   * Edit set name
   */
  static async #onEditSetName(event, target) {
    event.stopPropagation();
    const setId = target.dataset.setId;
    const currentName = target.dataset.setName;

    if (!this.macroBar || !setId) return;

    const content = `
      <form>
        <div class="form-group">
          <label>Set Name</label>
          <input type="text" name="setName" value="${currentName}" maxlength="20" autofocus />
        </div>
      </form>
    `;

    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'Edit Set Name' },
      content,
      ok: {
        label: 'Save',
        icon: 'fa-solid fa-check',
        callback: (event, button) => {
          return button.form.elements.setName.value?.trim();
        }
      }
    });

    if (result && this.macroBar.macroSets[setId]) {
      this.macroBar.macroSets[setId].name = result;
      await this.macroBar.saveMacroSets();
      this.macroBar.render();
      this.render();
      ui.notifications.info(`Renamed set to "${result}"`);
    }
  }

  /**
   * Delete set
   */
  static async #onDeleteSet(event, target) {
    event.stopPropagation();
    const setId = target.dataset.setId;
    const setName = target.dataset.setName;

    if (!this.macroBar || !setId) return;

    if (this.macroBar.setOrder.length <= 1) {
      ui.notifications.warn('Cannot delete the last macro set');
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Macro Set' },
      content: `<p>Are you sure you want to delete the set "<strong>${setName}</strong>"?</p><p>All macros in this set will be removed.</p>`
    });

    if (!confirmed) return;

    const orderIndex = this.macroBar.setOrder.indexOf(setId);
    if (orderIndex >= 0) {
      this.macroBar.setOrder.splice(orderIndex, 1);
    }

    delete this.macroBar.macroSets[setId];

    if (this.macroBar.activeSet === setId) {
      this.macroBar.activeSet = this.macroBar.setOrder[0];
    }

    await this.macroBar.saveMacroSets();
    this.macroBar.render();
    this.render();
    ui.notifications.info(`Deleted set "${setName}"`);
  }

  /**
   * Edit macro via custom macro builder
   */
  static async #onEditMacro(event, target) {
    event.stopPropagation();
    const macroId = target.dataset.macroId;
    const section = target.closest('.set-section');
    const setId = section?.dataset.setId;

    if (!this.macroBar || !setId || !macroId) return;

    const setData = this.macroBar.macroSets[setId];
    if (!setData?.macros) return;

    const macroIndex = setData.macros.findIndex(m => m?.id === macroId);
    if (macroIndex < 0) return;

    const macro = setData.macros[macroIndex];

    if (game.sd20?.openCustomMacroBuilder) {
      const previousActiveSet = this.macroBar.activeSet;
      this.macroBar.activeSet = setId;

      game.sd20.openCustomMacroBuilder(this.macroBar, macroIndex, macro, {
        onClose: () => {
          this.macroBar.activeSet = previousActiveSet;
          this.render();
        }
      });
    } else {
      ui.notifications.warn('Custom macro builder not available');
    }
  }

  /**
   * Delete macro from set
   */
  static async #onDeleteMacro(event, target) {
    event.stopPropagation();
    const macroId = target.dataset.macroId;
    const macroName = target.dataset.macroName;
    const section = target.closest('.set-section');
    const setId = section?.dataset.setId;

    if (!this.macroBar || !setId || !macroId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Macro' },
      content: `<p>Are you sure you want to delete "<strong>${macroName}</strong>" from this set?</p>`
    });

    if (!confirmed) return;

    const setData = this.macroBar.macroSets[setId];
    if (!setData?.macros) return;

    const index = setData.macros.findIndex(m => m?.id === macroId);
    if (index >= 0) {
      setData.macros.splice(index, 1);
      await this.macroBar.saveMacroSets();
      this.macroBar.render();
      this.render();
      ui.notifications.info(`Deleted "${macroName}"`);
    }
  }

  /**
   * Add macro to set - opens macro builder directly (no dialog)
   */
  static async #onAddMacroToSet(event, target) {
    const section = target.closest('.set-section');
    const setId = section?.dataset.setId;

    if (!this.macroBar || !setId) {
      ui.notifications.warn('No macro set selected.');
      return;
    }

    // Open macro builder directly to create a new custom macro
    if (game.sd20?.openCustomMacroBuilder) {
      const newMacro = {
        id: foundry.utils.randomID(),
        name: 'New Macro',
        macroCategory: 'custom',
        source: 'custom'
      };
      const self = this;
      game.sd20.openCustomMacroBuilder(this.macroBar, -1, newMacro, {
        setId: setId,
        onSave: () => {
          self.render();
        }
      });
    } else {
      ui.notifications.error('Macro Builder not available');
    }
  }

  /**
   * Add macro to set (legacy - shows dialog with options)
   */
  static async #onAddMacro(event, target) {
    // Get set ID from section (if clicked from within a set) or use active set (if clicked from footer)
    const section = target.closest('.set-section');
    const setId = section?.dataset.setId || this.macroBar?.activeSet;

    if (!this.macroBar || !setId) {
      ui.notifications.warn('No macro set selected. Please create a set first.');
      return;
    }

    // Check for available macros from the App
    const availableMacros = this.macroBar.availableMacros || [];
    const hasAppMacros = availableMacros.length > 0;

    // Build dialog content
    let content = '<div class="sd20-add-macro-list">';

    // Always show "Create Custom Macro" option at the top
    content += `
      <div class="add-macro-item create-custom" data-action="create-custom">
        <i class="fa-solid fa-plus-circle"></i>
        <span class="macro-name">Create Custom Macro</span>
        <span class="macro-costs"><span class="hint">Open Macro Builder</span></span>
      </div>
    `;

    // Add separator and App macros if available
    if (hasAppMacros) {
      content += '<hr class="add-macro-divider" />';
      content += '<div class="add-macro-section-label">From SD20 App:</div>';
      for (const macro of availableMacros) {
        content += `
          <div class="add-macro-item" data-macro-id="${macro.id}">
            <i class="${macro.icon || 'fa-solid fa-star'}"></i>
            <span class="macro-name">${macro.name}</span>
            <span class="macro-costs">
              ${macro.apCost ? `<span class="ap">${macro.apCost} AP</span>` : ''}
              ${macro.fpCost ? `<span class="fp">${macro.fpCost} FP</span>` : ''}
            </span>
          </div>
        `;
      }
    }
    content += '</div>';

    // Using DialogV2 with custom render callback
    const dialog = new foundry.applications.api.DialogV2({
      window: { title: 'Add Macro to Set' },
      content,
      buttons: [{
        action: 'cancel',
        icon: 'fa-solid fa-times',
        label: 'Cancel'
      }]
    });

    const self = this;
    dialog.addEventListener('render', () => {
      // Handle "Create Custom Macro" click
      dialog.element.querySelector('.add-macro-item.create-custom')?.addEventListener('click', () => {
        dialog.close();
        // Open macro builder to create a new custom macro
        if (game.sd20?.openCustomMacroBuilder) {
          // Create an empty macro shell with default category 'custom'
          const newMacro = {
            id: foundry.utils.randomID(),
            name: 'New Macro',
            macroCategory: 'custom',
            source: 'custom'
          };
          // macroIndex -1 indicates a new macro (will be added to set)
          game.sd20.openCustomMacroBuilder(self.macroBar, -1, newMacro, {
            setId: setId,
            onSave: () => {
              self.render();
            }
          });
        } else {
          ui.notifications.error('Macro Builder not available');
        }
      });

      // Handle App macro item clicks
      dialog.element.querySelectorAll('.add-macro-item[data-macro-id]').forEach(item => {
        item.addEventListener('click', async () => {
          const macroId = item.dataset.macroId;
          const macro = availableMacros.find(m => m.id === macroId);
          if (macro) {
            const setData = self.macroBar.macroSets[setId];
            if (setData) {
              if (!setData.macros) setData.macros = [];
              setData.macros.push({ ...macro, available: true });
              await self.macroBar.saveMacroSets();
              self.macroBar.render();
              self.render();
              ui.notifications.info(`Added "${macro.name}"`);
            }
          }
          dialog.close();
        });
      });
    });

    dialog.render({ force: true });
  }

  /**
   * Add a new macro set
   */
  static async #onAddSet() {
    const content = `
      <form>
        <div class="form-group">
          <label>Set Name</label>
          <input type="text" name="setName" value="New Set" maxlength="20" autofocus />
        </div>
      </form>
    `;

    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'Add New Macro Set' },
      content,
      ok: {
        label: 'Create',
        icon: 'fa-solid fa-plus',
        callback: (event, button) => {
          return button.form.elements.setName.value?.trim() || 'New Set';
        }
      }
    });

    if (result && this.macroBar) {
      await this.macroBar._addNewSet(result);
      this.render();
    }
  }

  /**
   * Import from library
   */
  static #onImportFromLibrary() {
    if (game.sd20?.openMacroCopyDialog) {
      game.sd20.openMacroCopyDialog(this.macroBar);
    } else {
      ui.notifications.warn('Import dialog not available');
    }
  }

  /**
   * Toggle selection mode
   */
  static #onToggleSelectionMode() {
    this._selectionMode = !this._selectionMode;
    if (!this._selectionMode) {
      this._selectedMacros.clear();
    }
    this.render();
  }

  /**
   * Select all visible macros
   */
  static #onSelectAllVisible() {
    // Get all visible macro items from the current render
    const html = this.element;
    html.querySelectorAll('.macro-selection-toggle').forEach(toggle => {
      const selectionKey = toggle.dataset.selectionKey;
      if (selectionKey) {
        this._selectedMacros.set(selectionKey, true);
      }
    });
    this.render();
  }

  /**
   * Deselect all macros
   */
  static #onDeselectAll() {
    this._selectedMacros.clear();
    this.render();
  }

  /**
   * Reset selected macros to app defaults
   */
  static async #onResetToAppDefaults() {
    if (!this.macroBar || this._selectedMacros.size === 0) return;

    // Collect macros that can be reset (app macros that are modified)
    const toReset = [];
    for (const [key] of this._selectedMacros) {
      const [setId, macroId] = key.split(':');
      const setData = this.macroBar.macroSets[setId];
      if (!setData?.macros) continue;

      const macroIndex = setData.macros.findIndex(m => m?.id === macroId);
      if (macroIndex < 0) continue;

      const macro = setData.macros[macroIndex];
      if (macro.appSourceId && macro.modified) {
        toReset.push({ setId, macroIndex, macro });
      }
    }

    if (toReset.length === 0) {
      ui.notifications.warn('No modified app macros selected to reset');
      return;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Reset to App Defaults' },
      content: `<p>Reset <strong>${toReset.length}</strong> macro(s) to their original app defaults?</p><p>This will remove all user modifications.</p>`
    });

    if (!confirmed) return;

    // Get fresh app macros
    const availableMacros = this.macroBar.availableMacros || [];
    let resetCount = 0;

    for (const { setId, macroIndex, macro } of toReset) {
      const freshMacro = availableMacros.find(m => m.id === macro.appSourceId);
      if (!freshMacro) {
        debug(`No fresh macro found for appSourceId: ${macro.appSourceId}`);
        continue;
      }

      // Replace with fresh copy, preserve hotkey
      const resetMacro = {
        ...freshMacro,
        hotkey: macro.hotkey,
        appSourceId: macro.appSourceId,
        available: macro.available
        // Note: no 'modified' flag = back to app defaults
      };

      this.macroBar.macroSets[setId].macros[macroIndex] = resetMacro;
      resetCount++;
    }

    if (resetCount > 0) {
      await this.macroBar.saveMacroSets();
      this.macroBar.render();
      this._selectedMacros.clear();
      this._selectionMode = false;
      this.render();
      ui.notifications.info(`Reset ${resetCount} macro(s) to app defaults`);
    }
  }

  /* -------------------------------------------- */
  /*  Tooltip Handlers                            */
  /* -------------------------------------------- */

  _onMacroHover(event) {
    const element = event.currentTarget;

    const name = element.dataset.macroName;
    const desc = element.dataset.macroDesc;
    const icon = element.dataset.macroIcon || 'fa-solid fa-star';
    const apCost = element.dataset.macroAp;
    const fpCost = element.dataset.macroFp;
    const range = element.dataset.macroRange;
    const diceData = element.dataset.macroDice;
    const scalingBonus = element.dataset.macroScaling;

    // Build dice display
    let diceStr = '';
    if (diceData) {
      try {
        const dice = JSON.parse(diceData);
        if (Array.isArray(dice) && dice.length > 0) {
          diceStr = dice.map(d => {
            const sides = d.value || d.sides;
            return `${d.count}d${sides} ${d.type || ''}`;
          }).join(' + ');
        }
      } catch (e) { /* ignore parse errors */ }
    }

    let tooltipHTML = `
      <div class="sd20-macro-tooltip">
        <div class="tooltip-header">
          <i class="${icon}"></i>
          <span>${name}</span>
        </div>
    `;

    if (desc) tooltipHTML += `<div class="tooltip-desc">${desc}</div>`;

    tooltipHTML += `<div class="tooltip-stats">`;
    if (apCost) tooltipHTML += `<span class="stat-ap">${apCost} AP</span>`;
    if (fpCost) tooltipHTML += `<span class="stat-fp">${fpCost} FP</span>`;
    if (range) tooltipHTML += `<span class="stat-range">${range}</span>`;
    tooltipHTML += `</div>`;

    if (diceStr) tooltipHTML += `<div class="tooltip-dice">${diceStr}</div>`;

    if (scalingBonus && scalingBonus !== '0') {
      const sign = Number(scalingBonus) > 0 ? '+' : '';
      tooltipHTML += `<div class="tooltip-scaling">Scaling: ${sign}${scalingBonus}</div>`;
    }

    tooltipHTML += `</div>`;

    this._hideTooltip();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = tooltipHTML;
    const tooltipEl = wrapper.firstElementChild;
    tooltipEl.style.position = 'fixed';
    tooltipEl.style.left = '-9999px';
    tooltipEl.style.top = '-9999px';
    tooltipEl.style.visibility = 'hidden';

    document.body.appendChild(tooltipEl);

    requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      const tooltipHeight = tooltipEl.offsetHeight || 100;
      const tooltipWidth = tooltipEl.offsetWidth || 200;

      let leftPos = rect.right + 8;
      if (leftPos + tooltipWidth > window.innerWidth - 10) {
        leftPos = rect.left - tooltipWidth - 8;
      }

      let topPos = Math.max(10, rect.top);
      if (topPos + tooltipHeight > window.innerHeight - 10) {
        topPos = window.innerHeight - tooltipHeight - 10;
      }

      tooltipEl.style.left = leftPos + 'px';
      tooltipEl.style.top = topPos + 'px';
      tooltipEl.style.visibility = 'visible';
    });
  }

  _onMacroLeave() {
    this._hideTooltip();
  }

  _hideTooltip() {
    document.querySelectorAll('.sd20-macro-tooltip').forEach(el => el.remove());
  }
}

/**
 * Register All Macros Manager
 */
export function registerAllMacrosManager() {
  game.sd20 = game.sd20 || {};

  /**
   * Open All Macros Manager
   * @param {Actor} [actor] - Optional actor to manage macros for (from actor sheet).
   *                          If not provided, uses the active macro bar from selected token.
   */
  game.sd20.openAllMacrosManager = (actor) => {
    // If actor provided (from actor sheet), create a virtual macro bar for it
    if (actor) {
      // Create a minimal macro bar interface for managing base actor macros
      const virtualMacroBar = new ActorMacroBarProxy(actor);
      new AllMacrosManager(virtualMacroBar).render({ force: true });
      return;
    }

    // Otherwise use active macro bar from selected token
    const macroBar = getActiveMacroBar();
    if (!macroBar) {
      ui.notifications.warn('Select a token first');
      return;
    }
    new AllMacrosManager(macroBar).render({ force: true });
  };

  log('All Macros Manager registered');
}

/**
 * Proxy class that provides macro bar interface for base actors (opened from actor sheet).
 * This allows managing macros on base actors that will be copied to new unlinked tokens.
 */
class ActorMacroBarProxy {
  constructor(actor) {
    this.actor = actor;
    this.actorId = actor.id;
    this.tokenId = null; // No token
    this.characterUUID = actor.system?.characterUUID || null;
    this.isUnlinked = false; // Base actor is always "linked" to itself
    this.isReadOnly = !actor.isOwner;
    this.availableMacros = [];

    // Load macro sets from actor
    const savedData = actor.system?.macroSets;
    if (savedData?.setOrder) {
      this.activeSet = savedData.activeSet || savedData.setOrder[0];
      this.macroSets = savedData.sets || {};
      this.setOrder = savedData.setOrder || [];
    } else {
      // Initialize default sets
      this._initializeDefaultSets();
    }
  }

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

  async saveMacroSets() {
    if (this.isReadOnly) return;

    await this.actor.update({
      'system.macroSets': {
        activeSet: this.activeSet,
        sets: this.macroSets,
        setOrder: this.setOrder
      }
    });
  }

  render() {
    // No visual rendering needed - AllMacrosManager handles UI
  }

  // Provide the grouped macros for display (same format as MacroBar)
  get groupedMacros() {
    const activeSetData = this.macroSets[this.activeSet];
    if (!activeSetData?.macros) return {};

    const grouped = {};
    for (const macro of activeSetData.macros) {
      if (!macro) continue;
      const category = this._getMacroCategory(macro);
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(macro);
    }
    return grouped;
  }

  /**
   * Determine which category a macro belongs to
   * (Matches MacroBar._getMacroCategory)
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
    if (macro.type === CONFIG.MACRO_TYPES?.SPELL) {
      const cat = (macro.category || '').toUpperCase();
      if (cat === 'SORCERY') return 'sorcery';
      if (cat === 'HEX') return 'hex';
      if (cat === 'MIRACLE') return 'miracle';
      if (cat === 'PYROMANCY') return 'pyromancy';
      return 'sorcery';
    }

    // Spirits
    if (macro.type === CONFIG.MACRO_TYPES?.SPIRIT) {
      return 'spirits';
    }

    // Weapon skills
    if (macro.type === CONFIG.MACRO_TYPES?.WEAPON_SKILL) {
      return 'skills';
    }

    // Custom macros
    if (macro.type === CONFIG.MACRO_TYPES?.CUSTOM || macro.source === CONFIG.MACRO_SOURCES?.CUSTOM) {
      return 'custom';
    }

    // Default to custom
    return 'custom';
  }

  /**
   * Add a new macro set
   * @param {string} name - Optional name for the set
   */
  async _addNewSet(name = null) {
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
    ui.notifications.info(`Created new set "${setName}"`);
  }

  /**
   * Add a macro to a specific slot in the active set
   * @param {number|null} slot - The slot index, or null to append
   * @param {object} macro - The macro data to add
   */
  async addMacroToSlot(slot, macro) {
    const setData = this.macroSets[this.activeSet];
    if (!setData) {
      console.warn('SD20 | ActorMacroBarProxy: Cannot add macro - active set not found');
      return;
    }

    if (!setData.macros) {
      setData.macros = [];
    }

    if (slot !== null && slot !== undefined) {
      // Expand array if needed to fit the slot
      while (setData.macros.length <= slot) {
        setData.macros.push(null);
      }
      setData.macros[slot] = macro;
    } else {
      // Append to end
      setData.macros.push(macro);
    }

    await this.saveMacroSets();
  }

  /**
   * Remove a macro from a specific slot in the active set
   * @param {number} slot - The slot index to clear
   */
  async removeMacroFromSlot(slot) {
    const setData = this.macroSets[this.activeSet];
    if (!setData?.macros) return;

    if (slot >= 0 && slot < setData.macros.length) {
      setData.macros[slot] = null;
      await this.saveMacroSets();
    }
  }
}