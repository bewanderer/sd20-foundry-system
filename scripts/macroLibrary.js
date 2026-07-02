/**
 * Macro Library
 * Personal macro storage for each user - persists across sessions via user flags
 * Allows users to save, organize, and reuse macros across different Actors
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';
import { normalizeMacroEntries } from './macroNormalize.js';

// Storage constants
const FLAG_KEY = 'macroLibrary';
const LIBRARY_MAX = 1000;
const LIBRARY_WARN = 900;

/**
 * Initialize library storage setting (legacy - kept for migration)
 * Must be called during 'init' hook
 */
export function registerLibrarySettings() {
  // Legacy client setting - kept for migration support
  game.settings.register(CONFIG.MODULE_ID, 'macroLibrary', {
    name: 'Macro Library (Legacy)',
    hint: 'Legacy macro library storage - migrated to user flags',
    scope: 'client',
    config: false,
    type: Object,
    default: { macros: [], version: 1 }
  });

  log('Macro library settings registered');
}

/**
 * Get the current user's macro library from user flags
 */
export function getLibrary() {
  const data = game.user.getFlag(CONFIG.MODULE_ID, FLAG_KEY);
  return data || { macros: [], version: 1 };
}

/**
 * Save the macro library to user flags
 */
export async function saveLibrary(libraryData) {
  await game.user.setFlag(CONFIG.MODULE_ID, FLAG_KEY, libraryData);
}

/**
 * Migrate legacy client-setting library to user flags (one-time)
 */
async function migrateFromClientSettings() {
  try {
    const legacy = game.settings.get(CONFIG.MODULE_ID, 'macroLibrary');
    if (legacy?.macros?.length > 0) {
      const existing = getLibrary();
      if (!existing.macros?.length) {
        // Migrate: add _appOriginal snapshots to existing macros
        for (const macro of legacy.macros) {
          if (!macro._appOriginal && macro.source === CONFIG.MACRO_SOURCES?.APP) {
            macro._appOriginal = _createAppSnapshot(macro);
          }
        }
        await saveLibrary(legacy);
        log(`Migrated ${legacy.macros.length} macros from client settings to user flags`);
        // Clear the legacy setting
        await game.settings.set(CONFIG.MODULE_ID, 'macroLibrary', { macros: [], version: 1 });
      }
    }
  } catch (e) {
    debug('No legacy library to migrate or migration error:', e);
  }
}

/**
 * Create a snapshot of editable fields for _appOriginal
 */
function _createAppSnapshot(macro) {
  return {
    name: macro.name,
    description: macro.description,
    icon: macro.icon,
    apCost: macro.apCost,
    fpCost: macro.fpCost,
    dice: macro.dice ? foundry.utils.deepClone(macro.dice) : [],
    range: macro.range,
    scalingBonus: macro.scalingBonus,
    damageTypes: macro.damageTypes ? foundry.utils.deepClone(macro.damageTypes) : undefined,
    category: macro.category,
    type: macro.type,
    source: macro.source,
    id: macro.id,
    sourceId: macro.sourceId
  };
}

/**
 * Add a macro to the library
 * Creates a deep copy with a unique library ID and stores _appOriginal
 */
export async function addMacroToLibrary(macro, sourceName = 'Unknown') {
  const library = getLibrary();

  // Check library cap
  if (library.macros.length >= LIBRARY_MAX) {
    ui.notifications.error(`Macro library is full (${LIBRARY_MAX} macros). Remove some macros before adding more.`);
    return null;
  }

  // Warn when approaching cap
  if (library.macros.length >= LIBRARY_WARN) {
    ui.notifications.warn(`Macro library has ${library.macros.length}/${LIBRARY_MAX} macros.`);
  }

  // Create library copy with unique ID
  const libraryMacro = {
    ...foundry.utils.deepClone(macro),
    libraryId: `lib-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    sourceActor: sourceName,
    addedAt: Date.now()
  };

  // Store full _appOriginal snapshot for Reset to App Defaults
  if (!libraryMacro._appOriginal) {
    libraryMacro._appOriginal = foundry.utils.deepClone(macro);
    // Clean library metadata from the snapshot
    delete libraryMacro._appOriginal.libraryId;
    delete libraryMacro._appOriginal.sourceActor;
    delete libraryMacro._appOriginal.addedAt;
    delete libraryMacro._appOriginal._appOriginal;
  }

  // Check if macro with same original ID already exists
  const existingIndex = library.macros.findIndex(m => m.id === macro.id);
  if (existingIndex >= 0) {
    // Update existing entry but preserve the original _appOriginal
    const existingOriginal = library.macros[existingIndex]._appOriginal;
    library.macros[existingIndex] = libraryMacro;
    if (existingOriginal) {
      library.macros[existingIndex]._appOriginal = existingOriginal;
    }
    debug(`Updated macro "${macro.name}" in library`);
  } else {
    library.macros.push(libraryMacro);
    debug(`Added macro "${macro.name}" to library`);
  }

  await saveLibrary(library);
  return libraryMacro;
}

/**
 * Add multiple macros to the library in a single batch operation
 * Much faster than calling addMacroToLibrary repeatedly
 */
export async function addMacrosToLibraryBatch(macros, sourceName = 'Unknown') {
  if (!macros?.length) return [];

  const library = getLibrary();
  const results = [];

  // Check library cap
  if (library.macros.length + macros.length > LIBRARY_MAX) {
    ui.notifications.error(`Cannot add ${macros.length} macros - library would exceed ${LIBRARY_MAX} limit.`);
    return [];
  }

  // Warn when approaching cap
  if (library.macros.length + macros.length > LIBRARY_WARN) {
    ui.notifications.warn(`Macro library will have ${library.macros.length + macros.length}/${LIBRARY_MAX} macros.`);
  }

  for (const macro of macros) {
    // Create library copy with unique ID
    const libraryMacro = {
      ...foundry.utils.deepClone(macro),
      libraryId: `lib-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      sourceActor: sourceName,
      addedAt: Date.now()
    };

    // Store full _appOriginal snapshot for Reset to App Defaults
    if (!libraryMacro._appOriginal) {
      libraryMacro._appOriginal = foundry.utils.deepClone(macro);
      delete libraryMacro._appOriginal.libraryId;
      delete libraryMacro._appOriginal.sourceActor;
      delete libraryMacro._appOriginal.addedAt;
      delete libraryMacro._appOriginal._appOriginal;
    }

    // Check if macro with same original ID already exists
    const existingIndex = library.macros.findIndex(m => m.id === macro.id);
    if (existingIndex >= 0) {
      const existingOriginal = library.macros[existingIndex]._appOriginal;
      library.macros[existingIndex] = libraryMacro;
      if (existingOriginal) {
        library.macros[existingIndex]._appOriginal = existingOriginal;
      }
    } else {
      library.macros.push(libraryMacro);
    }

    results.push(libraryMacro);
  }

  // Single save operation for all macros
  await saveLibrary(library);
  debug(`Batch added ${results.length} macros to library`);

  return results;
}

/**
 * Remove a macro from the library by its libraryId
 */
export async function removeMacroFromLibrary(libraryId) {
  const library = getLibrary();
  const index = library.macros.findIndex(m => m.libraryId === libraryId);

  if (index >= 0) {
    const removed = library.macros.splice(index, 1)[0];
    await saveLibrary(library);
    debug(`Removed macro "${removed.name}" from library`);
    return true;
  }
  return false;
}

/**
 * Update a macro in the library
 */
export async function updateLibraryMacro(libraryId, updates) {
  const library = getLibrary();
  const macro = library.macros.find(m => m.libraryId === libraryId);

  if (macro) {
    // Preserve _appOriginal when updating
    const appOriginal = macro._appOriginal;
    Object.assign(macro, updates);
    if (appOriginal) macro._appOriginal = appOriginal;
    await saveLibrary(library);
    debug(`Updated library macro "${macro.name}"`);
    return macro;
  }
  return null;
}

/**
 * Get a copy of a library macro for use on an Actor
 * Returns a new macro without the libraryId (so it's independent)
 */
export function getMacroCopyFromLibrary(libraryId) {
  const library = getLibrary();
  const macro = library.macros.find(m => m.libraryId === libraryId);

  if (!macro) return null;

  // Create independent copy without library metadata
  const copy = foundry.utils.deepClone(macro);
  delete copy.libraryId;
  delete copy.sourceActor;
  delete copy.addedAt;
  delete copy._appOriginal;

  // Generate new unique ID to avoid conflicts
  copy.id = `${copy.id}-${Date.now()}`;

  return copy;
}

/**
 * Show actor selection dialog for copying macros
 * Returns the selected actor or null if cancelled
 */
async function promptActorSelection() {
  // Get all actors the user owns or has permission to modify
  const actors = game.actors.filter(a => a.isOwner);

  if (actors.length === 0) {
    ui.notifications.warn('No linked SD20 actors found. Link an actor to a character first.');
    return null;
  }

  // Build select options HTML
  const optionsHtml = actors.map(a =>
    `<option value="${a.id}">${a.name}</option>`
  ).join('');

  const content = `
    <form class="sd20-actor-select-form">
      <div style="margin-bottom: 0.75rem;">
        <label style="display: block; margin-bottom: 0.25rem; font-weight: bold;">Select Actor:</label>
        <select name="actorId" style="width: 100%; padding: 0.4rem;">
          ${optionsHtml}
        </select>
      </div>
    </form>
  `;

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: 'Copy to Actor' },
    content,
    ok: {
      label: 'Copy',
      icon: 'fa-solid fa-copy',
      callback: (event, button) => {
        const form = button.closest('.dialog-content')?.querySelector('form')
          || button.form
          || event.target.closest('.application')?.querySelector('form');
        if (!form) return null;
        const actorId = form.querySelector('[name="actorId"]')?.value;
        return actorId ? game.actors.get(actorId) : null;
      }
    }
  });

  return result || null;
}

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * Macro Library UI - ApplicationV2 for viewing/managing the library
 * Layout mirrors All Macros Manager: collapsible category groups, scrollable content
 */
export class MacroLibraryDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.searchQuery = '';
    this.filterCategory = 'all';
    this.filterActor = 'all';
    this.selectedMacros = new Set();
    this._expandedCategories = new Set();
    this._searchDebounceTimer = null;
  }

  static DEFAULT_OPTIONS = {
    id: 'sd20-macro-library',
    classes: ['sd20-macro-library-dialog'],
    tag: 'form',
    window: {
      title: 'SD20 - Macro Library',
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
      toggleCategory: MacroLibraryDialog.#onToggleCategory,
      copyToActor: MacroLibraryDialog.#onCopyToActor,
      deleteMacro: MacroLibraryDialog.#onDeleteMacro,
      editMacro: MacroLibraryDialog.#onEditMacro,
      clearLibrary: MacroLibraryDialog.#onClearLibrary,
      bulkCopyToActor: MacroLibraryDialog.#onBulkCopyToActor,
      duplicateMacro: MacroLibraryDialog.#onDuplicateMacro
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/macro-library.html',
      scrollable: ['.library-content']
    }
  };

  async _prepareContext() {
    const library = getLibrary();

    // Walk every actor the user owns and pull each macro out of its macroSets.
    // Aggregated entries are tagged so the handlers can route Edit and Delete
    // back to the source actor instead of the per-user library storage.
    const aggregated = [];
    const ownedActors = game.actors?.filter(a => a.testUserPermission(game.user, 'OWNER')) || [];
    for (const actor of ownedActors) {
      const sets = actor.system?.macroSets?.sets;
      if (!sets || typeof sets !== 'object') continue;
      for (const setData of Object.values(sets)) {
        if (!Array.isArray(setData?.macros)) continue;
        for (const macro of setData.macros) {
          if (!macro || !macro.id) continue;
          aggregated.push({
            ...macro,
            libraryId: `agg:${actor.id}:${macro.id}`,
            sourceActor: actor.name,
            _aggregatedFromActor: actor.id,
            _aggregatedMacroId: macro.id
          });
        }
      }
    }

    // Actor entries win over library entries with the same macro id.
    const seenIds = new Set(aggregated.map(m => m.id));
    const libraryEntries = (library.macros || []).filter(m => !seenIds.has(m.id));
    let macros = [...aggregated, ...libraryEntries];

    // Collect unique actor names for the filter dropdown (library + aggregated)
    const actorNamesSet = new Set();
    for (const m of macros) {
      if (m.sourceActor) actorNamesSet.add(m.sourceActor);
    }
    const actorNames = [...actorNamesSet].sort();

    const combinedTotalCount = macros.length;

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

    // Group by category, include selection state
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

    // Check if all visible macros are selected
    const allSelected = macros.length > 0 && macros.every(m => this.selectedMacros.has(m.libraryId));

    return {
      categoryGroups,
      categories: CONFIG.MACRO_CATEGORIES,
      actorNames,
      totalCount: combinedTotalCount,
      filteredCount: macros.length,
      selectedCount: this.selectedMacros.size,
      searchQuery: this.searchQuery,
      filterCategory: this.filterCategory,
      filterActor: this.filterActor,
      allSelected,
      libraryMax: LIBRARY_MAX
    };
  }

  /**
   * Determine macro category (same logic as MacroBar)
   */
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

  /**
   * Re-render when an owned actor's macroSets change so aggregated entries
   * stay in step with edits made elsewhere (actor sheet, other clients).
   */
  _onActorUpdate(actor, changes) {
    if (!this.rendered) return;
    if (!actor?.testUserPermission?.(game.user, 'OWNER')) return;
    if (!changes?.system || !('macroSets' in changes.system)) return;
    this.render();
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._actorUpdateHook = this._onActorUpdate.bind(this);
    Hooks.on('updateActor', this._actorUpdateHook);
  }

  _onClose(options) {
    if (this._actorUpdateHook) {
      Hooks.off('updateActor', this._actorUpdateHook);
      this._actorUpdateHook = null;
    }
    super._onClose?.(options);
  }

  /**
   * Attach non-action listeners after render
   */
  _onRender(context, options) {
    super._onRender(context, options);

    const html = this.element;

    // Search input with debounce - preserve focus and cursor position
    const searchInput = html.querySelector('.library-search-input');
    if (searchInput) {
      // Restore focus if search was active
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

  /**
   * Toggle category expand/collapse (like set toggle in All Macros Manager)
   */
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

  /**
   * Copy macro from library to an Actor's macro bar (with actor prompt)
   */
  static async #onCopyToActor(_event, target) {
    const libraryId = target.dataset.libraryId;
    const macroCopy = _resolveAggregatedOrLibraryCopy(libraryId);
    if (!macroCopy) {
      ui.notifications.error('Macro source no longer exists.');
      return;
    }

    const actor = await promptActorSelection();
    if (!actor) return;

    // Get or create macro bar for the selected actor
    const macroBar = _getMacroBarForActor(actor);
    if (!macroBar) {
      ui.notifications.error(`Cannot access macro bar for "${actor.name}"`);
      return;
    }

    await macroBar.addMacroToSlot(null, macroCopy);
    ui.notifications.info(`Added "${macroCopy.name}" to ${actor.name}'s macro bar`);
  }

  /**
   * Bulk copy selected macros to an Actor's macro bar (with actor prompt)
   */
  static async #onBulkCopyToActor() {
    if (this.selectedMacros.size === 0) {
      ui.notifications.warn('No macros selected');
      return;
    }

    const actor = await promptActorSelection();
    if (!actor) return;

    const macroBar = _getMacroBarForActor(actor);
    if (!macroBar) {
      ui.notifications.error(`Cannot access macro bar for "${actor.name}"`);
      return;
    }

    let copied = 0;
    for (const libraryId of this.selectedMacros) {
      const macroCopy = _resolveAggregatedOrLibraryCopy(libraryId);
      if (macroCopy) {
        await macroBar.addMacroToSlot(null, macroCopy);
        copied++;
      }
    }

    if (copied > 0) {
      ui.notifications.info(`Added ${copied} macro${copied > 1 ? 's' : ''} to ${actor.name}'s macro bar`);
      this.selectedMacros.clear();
      this.render();
    } else {
      ui.notifications.warn('No macros could be copied');
    }
  }

  /**
   * Delete macro from library
   */
  static async #onDeleteMacro(_event, target) {
    const libraryId = target.dataset.libraryId;
    const macroName = target.dataset.macroName;

    // Aggregated entry: delete from the actor's macroSets, not the library flag.
    if (libraryId?.startsWith('agg:')) {
      const [, actorId, macroId] = libraryId.split(':');
      const actor = game.actors.get(actorId);
      if (!actor) {
        ui.notifications.error('Source actor for this macro was not found.');
        return;
      }
      const confirmed = await DialogV2.confirm({
        window: { title: 'Delete from Actor' },
        content: `<p>Remove "<strong>${macroName}</strong>" from <strong>${actor.name}</strong>'s macro sets?</p><p>This deletes the macro on the actor. All token copies and other owners will lose it.</p>`
      });
      if (!confirmed) return;

      const fresh = foundry.utils.deepClone(actor.system?.macroSets || {});
      let removed = false;
      for (const setData of Object.values(fresh.sets || {})) {
        const idx = (setData.macros || []).findIndex(m => m?.id === macroId);
        if (idx >= 0) {
          setData.macros.splice(idx, 1);
          removed = true;
          break;
        }
      }
      if (removed) {
        await actor.update({ 'system.macroSets': fresh });
        this.selectedMacros.delete(libraryId);
        ui.notifications.info(`Removed "${macroName}" from ${actor.name}`);
        this.render();
      } else {
        ui.notifications.warn('Macro was already removed.');
        this.render();
      }
      return;
    }

    const confirmed = await DialogV2.confirm({
      window: { title: 'Delete from Library' },
      content: `<p>Are you sure you want to remove "<strong>${macroName}</strong>" from your library?</p>`
    });

    if (!confirmed) return;

    const removed = await removeMacroFromLibrary(libraryId);
    if (removed) {
      this.selectedMacros.delete(libraryId);
      ui.notifications.info(`Removed "${macroName}" from library`);
      this.render();
    }
  }

  /**
   * Duplicate a macro in the library
   */
  static async #onDuplicateMacro(_event, target) {
    const libraryId = target.dataset.libraryId;
    const library = getLibrary();

    // Aggregated entries are not in the library; turn the duplicate into a
    // personal-library copy so the user has their own editable version that
    // does not affect the source actor.
    let original = null;
    let originalIndex = library.macros.length;
    if (libraryId?.startsWith('agg:')) {
      const [, actorId, macroId] = libraryId.split(':');
      const actor = game.actors.get(actorId);
      const sets = actor?.system?.macroSets?.sets;
      for (const setData of Object.values(sets || {})) {
        const found = (setData.macros || []).find(m => m?.id === macroId);
        if (found) {
          original = found;
          break;
        }
      }
      if (!original) {
        ui.notifications.error('Source macro no longer exists on the actor.');
        return;
      }
    } else {
      original = library.macros.find(m => m.libraryId === libraryId);
      if (!original) {
        ui.notifications.error('Macro not found in library');
        return;
      }
      originalIndex = library.macros.indexOf(original);
    }

    // Check library cap
    if (library.macros.length >= LIBRARY_MAX) {
      ui.notifications.error(`Macro library is full (${LIBRARY_MAX} macros).`);
      return;
    }

    const copy = {
      ...foundry.utils.deepClone(original),
      libraryId: `lib-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      name: `${original.name} Copy`,
      addedAt: Date.now()
    };
    delete copy._aggregatedFromActor;
    delete copy._aggregatedMacroId;

    // Insert right after the original (or at the end for aggregated sources)
    library.macros.splice(originalIndex + 1, 0, copy);

    await saveLibrary(library);
    ui.notifications.info(`Duplicated "${original.name}"`);
    this.render();
  }

  /**
   * Edit library macro - opens builder with _appOriginal for reset
   */
  static async #onEditMacro(_event, target) {
    const libraryId = target.dataset.libraryId;

    if (!game.sd20?.openCustomMacroBuilder) {
      ui.notifications.warn('Custom macro builder not available');
      return;
    }

    // Aggregated entries live on an owned actor, not in the library flag.
    // Open the builder against the actor's macro so saves go back to the
    // canonical actor.system.macroSets and all owners see the change.
    if (libraryId?.startsWith('agg:')) {
      const [, actorId, macroId] = libraryId.split(':');
      const actor = game.actors.get(actorId);
      if (!actor) {
        ui.notifications.error('Source actor for this macro was not found.');
        return;
      }
      const macroSetsClone = foundry.utils.deepClone(actor.system?.macroSets || {});
      let sourceMacro = null;
      for (const setData of Object.values(macroSetsClone.sets || {})) {
        const found = (setData.macros || []).find(m => m?.id === macroId);
        if (found) { sourceMacro = found; break; }
      }
      if (!sourceMacro) {
        ui.notifications.error('Macro was removed from the source actor.');
        this.render();
        return;
      }

      const self = this;
      game.sd20.openCustomMacroBuilder(null, null, sourceMacro, {
        isLibraryEdit: true,
        libraryId: null,
        aggregatedActor: actor,
        appOriginalOverride: sourceMacro._appOriginal || null,
        onSave: async (updatedMacro) => {
          const fresh = foundry.utils.deepClone(actor.system?.macroSets || {});
          let replaced = false;
          for (const setData of Object.values(fresh.sets || {})) {
            const idx = (setData.macros || []).findIndex(m => m?.id === macroId);
            if (idx >= 0) {
              setData.macros[idx] = updatedMacro;
              replaced = true;
              break;
            }
          }
          if (!replaced) {
            ui.notifications.warn('Macro was removed from the source actor while editing.');
            self.render();
            return;
          }
          await actor.update({ 'system.macroSets': fresh });
          ui.notifications.info(`Updated "${updatedMacro.name}" on ${actor.name}`);
          self.render();
        }
      });
      return;
    }

    const library = getLibrary();
    const macro = library.macros.find(m => m.libraryId === libraryId);

    if (!macro) {
      ui.notifications.error('Macro not found in library');
      return;
    }

    // Pass the stored _appOriginal so Reset to App Defaults works without needing an active macro bar
    const macroBar = game.sd20?.getActiveMacroBar?.();

    game.sd20.openCustomMacroBuilder(macroBar, null, macro, {
      isLibraryEdit: true,
      libraryId: libraryId,
      appOriginalOverride: macro._appOriginal || null,
      onSave: async (updatedMacro) => {
        await updateLibraryMacro(libraryId, updatedMacro);
        this.render();
        ui.notifications.info(`Updated "${updatedMacro.name}" in library`);
      }
    });
  }

  /**
   * Clear entire library
   */
  static async #onClearLibrary() {
    const library = getLibrary();
    if (!library.macros?.length) {
      ui.notifications.info('Library is already empty');
      return;
    }

    const confirmed = await DialogV2.confirm({
      window: { title: 'Clear Library' },
      content: `<p>Are you sure you want to clear your entire macro library?</p><p>This will remove <strong>${library.macros.length}</strong> macros and cannot be undone.</p>`
    });

    if (!confirmed) return;

    await saveLibrary({ macros: [], version: 1 });
    this.selectedMacros.clear();
    ui.notifications.info('Macro library cleared');
    this.render();
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
 * Resolve a copy of a macro by the synthetic library id used in the dialog.
 * Aggregated ids look like `agg:<actorId>:<macroId>`; library ids are the
 * actual libraryId stored on the user-flag entry.
 */
function _resolveAggregatedOrLibraryCopy(libraryId) {
  if (!libraryId) return null;
  if (libraryId.startsWith('agg:')) {
    const [, actorId, macroId] = libraryId.split(':');
    const actor = game.actors.get(actorId);
    const sets = actor?.system?.macroSets?.sets;
    if (!sets) return null;
    for (const setData of Object.values(sets)) {
      const found = (setData.macros || []).find(m => m?.id === macroId);
      if (found) {
        const copy = foundry.utils.deepClone(found);
        delete copy.libraryId;
        delete copy._aggregatedFromActor;
        delete copy._aggregatedMacroId;
        copy.id = `${found.id}-${Date.now()}`;
        return copy;
      }
    }
    return null;
  }
  return getMacroCopyFromLibrary(libraryId);
}

/**
 * Helper: get macro bar instance for a specific actor
 * Uses the active macro bar if it matches, otherwise creates a temporary reference
 */
function _getMacroBarForActor(actor) {
  const activeMacroBar = game.sd20?.getActiveMacroBar?.();
  if (activeMacroBar?.actor?.id === actor.id) {
    return activeMacroBar;
  }

  // For other actors, find or use their macro bar
  // The macro bar stores data on the actor, so the active bar's addMacroToSlot
  // by temporarily pointing it at the actor - but that's fragile.
  // Instead, directly update the actor's macro sets
  return {
    async addMacroToSlot(slot, macro) {
      const macroSets = foundry.utils.deepClone(actor.system?.macroSets || {});
      const activeSet = macroSets.activeSet || 'default';
      if (!macroSets.sets) macroSets.sets = {};
      if (!macroSets.sets[activeSet]) macroSets.sets[activeSet] = { macros: [], name: 'Default' };
      // Ensure setOrder exists (required for macro bar to load data correctly)
      if (!macroSets.setOrder) macroSets.setOrder = [activeSet];

      const setData = macroSets.sets[activeSet];
      if (!setData.macros) setData.macros = [];

      // Bug 4: this proxy path skips the primary macroBar and would otherwise
      // land untagged entries on the actor. Normalize before writing.
      const defaultSource = macro?.source === CONFIG.MACRO_SOURCES.APP ? 'app' : 'custom';
      normalizeMacroEntries(macro, defaultSource);

      if (slot !== null && slot !== undefined) {
        while (setData.macros.length <= slot) setData.macros.push(null);
        setData.macros[slot] = macro;
      } else {
        setData.macros.push(macro);
      }

      await actor.update({ 'system.macroSets': macroSets });
    }
  };
}

/**
 * Open the macro library dialog
 */
export function openMacroLibrary() {
  new MacroLibraryDialog().render({ force: true });
}

/**
 * Register macro library
 */
export function registerMacroLibrary() {
  game.sd20 = game.sd20 || {};
  game.sd20.openMacroLibrary = openMacroLibrary;
  game.sd20.addMacroToLibrary = addMacroToLibrary;
  game.sd20.getLibrary = getLibrary;

  // Migrate from legacy client settings if needed
  migrateFromClientSettings();

  log('Macro library registered');
}