/**
 * Macro Copy Dialog
 * Modal for selecting and importing macros from the library to an Actor's macro bar.
 * Mirrors the Macro Library UI but only exposes import-related actions (no edit/delete/clear).
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';
import { getLibrary, getMacroCopyFromLibrary } from './macroLibrary.js';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export class MacroCopyDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'sd20-macro-copy-dialog',
    classes: ['sd20-macro-library-dialog'],
    tag: 'form',
    window: {
      title: 'Import from Library',
      icon: 'fa-solid fa-download',
      resizable: true,
      contentClasses: []
    },
    position: {
      width: 700,
      height: 550
    },
    form: {
      handler: null,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      toggleCategory: MacroCopyDialog.#onToggleCategory,
      toggleMacro: MacroCopyDialog.#onToggleMacro,
      importSelected: MacroCopyDialog.#onImportSelected,
      importSingle: MacroCopyDialog.#onImportSingle
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/macro-copy-dialog.html',
      scrollable: ['.library-content']
    }
  };

  constructor(macroBar, options = {}) {
    super(options);
    this.macroBar = macroBar;
    this.searchQuery = '';
    this.filterCategory = 'all';
    this.filterActor = 'all';
    this.selectedMacros = new Set();
    this._expandedCategories = new Set();
    this._searchDebounceTimer = null;
  }

  async _prepareContext() {
    const library = getLibrary();
    let macros = library.macros || [];

    // Collect unique actor names for the filter dropdown
    const actorNamesSet = new Set();
    for (const m of library.macros) {
      if (m.sourceActor) actorNamesSet.add(m.sourceActor);
    }
    const actorNames = [...actorNamesSet].sort();

    // Apply search filter
    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      macros = macros.filter(m => {
        const nameMatch = m.name?.toLowerCase().includes(query);
        const descMatch = m.description?.toLowerCase().includes(query);
        const sourceMatch = m.sourceActor?.toLowerCase().includes(query);
        return nameMatch || descMatch || sourceMatch;
      });
    }

    // Apply category filter
    if (this.filterCategory !== 'all') {
      macros = macros.filter(m => this._getMacroCategory(m) === this.filterCategory);
    }

    // Apply actor filter
    if (this.filterActor !== 'all') {
      macros = macros.filter(m => m.sourceActor === this.filterActor);
    }

    // Group by category with selection state
    const categoryGroups = [];
    for (const cat of CONFIG.MACRO_CATEGORIES) {
      const catMacros = [];
      for (const macro of macros) {
        if (this._getMacroCategory(macro) === cat.id) {
          catMacros.push({
            ...macro,
            selected: this.selectedMacros.has(macro.libraryId)
          });
        }
      }
      if (catMacros.length > 0) {
        categoryGroups.push({
          id: cat.id,
          name: cat.name,
          icon: cat.icon,
          macros: catMacros,
          macroCount: catMacros.length,
          expanded: this._expandedCategories.has(cat.id)
        });
      }
    }

    const allSelected = macros.length > 0 && macros.every(m => this.selectedMacros.has(m.libraryId));

    return {
      categoryGroups,
      categories: CONFIG.MACRO_CATEGORIES,
      actorNames,
      totalCount: library.macros?.length || 0,
      filteredCount: macros.length,
      selectedCount: this.selectedMacros.size,
      searchQuery: this.searchQuery,
      filterCategory: this.filterCategory,
      filterActor: this.filterActor,
      allSelected
    };
  }

  _getMacroCategory(macro) {
    if (macro.macroCategory) return macro.macroCategory;
    if (macro.linkedSlot === 'mainHand') return 'mainHand';
    if (macro.linkedSlot === 'offHand') return 'offHand';

    if (macro.type === CONFIG.MACRO_TYPES.SPELL) {
      const cat = (macro.category || '').toUpperCase();
      if (cat === 'SORCERY') return 'sorcery';
      if (cat === 'HEX') return 'hex';
      if (cat === 'MIRACLE') return 'miracle';
      if (cat === 'PYROMANCY') return 'pyromancy';
      return 'sorcery';
    }

    if (macro.type === CONFIG.MACRO_TYPES.SPIRIT) return 'spirits';
    if (macro.type === CONFIG.MACRO_TYPES.WEAPON_SKILL) return 'skills';
    if (macro.type === CONFIG.MACRO_TYPES.CUSTOM || macro.source === CONFIG.MACRO_SOURCES.CUSTOM) {
      return 'custom';
    }

    return 'custom';
  }

  _onRender(context, options) {
    super._onRender(context, options);

    const html = this.element;

    // Search input with debounce
    const searchInput = html.querySelector('.library-search-input');
    if (searchInput) {
      if (this.searchQuery) {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }

      searchInput.addEventListener('input', (event) => {
        if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => {
          this.searchQuery = event.target.value;
          this.render();
        }, 300);
      });
    }

    // Category filter dropdown
    const filterSelect = html.querySelector('.filter-category');
    if (filterSelect) {
      filterSelect.addEventListener('change', (event) => {
        this.filterCategory = event.target.value;
        this.render();
      });
    }

    // Actor filter dropdown
    const actorFilter = html.querySelector('.filter-actor');
    if (actorFilter) {
      actorFilter.addEventListener('change', (event) => {
        this.filterActor = event.target.value;
        this.render();
      });
    }

    // Select-all checkbox
    const selectAllCb = html.querySelector('.select-all-checkbox');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', (event) => {
        const allItems = html.querySelectorAll('.macro-select-checkbox');
        if (event.target.checked) {
          allItems.forEach(cb => this.selectedMacros.add(cb.dataset.libraryId));
        } else {
          allItems.forEach(cb => this.selectedMacros.delete(cb.dataset.libraryId));
        }
        this.render();
      });
    }

    // Individual macro checkboxes
    html.querySelectorAll('.macro-select-checkbox').forEach(cb => {
      cb.addEventListener('change', (event) => {
        event.stopPropagation();
        const libraryId = event.target.dataset.libraryId;
        if (event.target.checked) {
          this.selectedMacros.add(libraryId);
        } else {
          this.selectedMacros.delete(libraryId);
        }
        this.render();
      });
    });

    // Macro tooltips
    html.querySelectorAll('.library-macro-item').forEach(item => {
      item.addEventListener('mouseenter', this._onMacroHover.bind(this));
      item.addEventListener('mouseleave', this._onMacroLeave.bind(this));
    });
  }

  /* -------------------------------------------- */
  /*  Action Handlers                             */
  /* -------------------------------------------- */

  static #onToggleCategory(_event, target) {
    if (_event.target.closest('input, button')) return;

    const section = target.closest('.library-category-section');
    const catId = section?.dataset.categoryId;
    if (!catId) return;

    if (this._expandedCategories.has(catId)) {
      this._expandedCategories.delete(catId);
    } else {
      this._expandedCategories.add(catId);
    }

    section.classList.toggle('expanded');
  }

  static #onToggleMacro(_event, target) {
    if (_event.target.classList.contains('macro-select-checkbox')) return;
    if (_event.target.closest('button')) return;

    const libraryId = target.dataset.libraryId;
    if (this.selectedMacros.has(libraryId)) {
      this.selectedMacros.delete(libraryId);
    } else {
      this.selectedMacros.add(libraryId);
    }
    this.render();
  }

  static async #onImportSingle(_event, target) {
    const libraryId = target.dataset.libraryId;

    const macroCopy = getMacroCopyFromLibrary(libraryId);
    if (!macroCopy) {
      ui.notifications.error('Macro not found in library');
      return;
    }

    if (!this.macroBar) {
      ui.notifications.error('No macro bar available');
      return;
    }

    await this.macroBar.addMacroToSlot(null, macroCopy);
    ui.notifications.info(`Imported "${macroCopy.name}" to macro bar`);
  }

  static async #onImportSelected() {
    if (this.selectedMacros.size === 0) {
      ui.notifications.warn('No macros selected');
      return;
    }

    if (!this.macroBar) {
      ui.notifications.error('No macro bar available');
      return;
    }

    let imported = 0;
    for (const libraryId of this.selectedMacros) {
      const macroCopy = getMacroCopyFromLibrary(libraryId);
      if (macroCopy) {
        await this.macroBar.addMacroToSlot(null, macroCopy);
        imported++;
      }
    }

    if (imported > 0) {
      ui.notifications.info(`Imported ${imported} macro${imported > 1 ? 's' : ''} to macro bar`);
      this.selectedMacros.clear();
      this.render();
    } else {
      ui.notifications.warn('No macros could be imported');
    }
  }

  /* -------------------------------------------- */
  /*  Tooltip Handlers                            */
  /* -------------------------------------------- */

  _onMacroHover(event) {
    const element = event.currentTarget;

    const name = element.dataset.macroName;
    const desc = element.dataset.macroDesc || '';
    const icon = element.dataset.macroIcon || 'fa-solid fa-star';
    const apCost = element.dataset.macroAp;
    const fpCost = element.dataset.macroFp;
    const sourceActor = element.dataset.sourceActor;

    let tooltipHTML = `
      <div class="sd20-macro-tooltip">
        <div class="tooltip-header">
          <i class="${icon}"></i>
          <span>${name}</span>
        </div>
    `;

    if (desc) {
      tooltipHTML += `<div class="tooltip-desc">${desc}</div>`;
    }

    tooltipHTML += `<div class="tooltip-stats">`;
    if (apCost) tooltipHTML += `<span class="stat-ap">${apCost} AP</span>`;
    if (fpCost) tooltipHTML += `<span class="stat-fp">${fpCost} FP</span>`;
    tooltipHTML += `</div>`;

    if (sourceActor) {
      tooltipHTML += `<div class="tooltip-source">From: ${sourceActor}</div>`;
    }

    tooltipHTML += `</div>`;

    this._hideTooltip();

    const tooltip = document.createElement('div');
    tooltip.innerHTML = tooltipHTML;
    const tooltipEl = tooltip.firstElementChild;
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
 * Open the macro copy dialog
 */
export function openMacroCopyDialog(macroBar) {
  if (!macroBar) {
    ui.notifications.warn('Select a linked token first');
    return;
  }
  new MacroCopyDialog(macroBar).render({ force: true });
}

/**
 * Register macro copy dialog
 */
export function registerMacroCopyDialog() {
  game.sd20 = game.sd20 || {};
  game.sd20.openMacroCopyDialog = openMacroCopyDialog;

  log('Macro copy dialog registered');
}