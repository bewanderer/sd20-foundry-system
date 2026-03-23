/**
 * Macro Bar Controls
 * Toggle buttons for SD20 and Foundry macro bars in the UI controls
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';
import { showMacroBar, closeMacroBar } from './macroBar.js';

/**
 * Register settings for macro bar visibility (call during init)
 */
export function registerMacroBarControlSettings() {
  // Register settings for macro bar visibility
  game.settings.register(CONFIG.MODULE_ID, 'showSD20MacroBar', {
    name: 'Show SD20 Macro Bar',
    hint: 'Toggle visibility of the SD20 macro bar when a linked token is selected',
    scope: 'client',
    config: false, // Hidden from settings menu, controlled via UI button
    type: Boolean,
    default: true,
    onChange: (value) => {
      if (value) {
        // Show macro bar if a linked token is selected
        const linkedToken = canvas.tokens?.controlled?.find(t =>
          t.actor?.system?.characterUUID || t.document.getFlag(CONFIG.MODULE_ID, 'characterUUID')
        );
        if (linkedToken) {
          showMacroBar(linkedToken);
        }
      } else {
        closeMacroBar();
      }
      // Update button active state
      updateControlButtonStates();
    }
  });

  game.settings.register(CONFIG.MODULE_ID, 'showFoundryMacroBar', {
    name: 'Show Foundry Macro Bar',
    hint: 'Toggle visibility of the default Foundry macro bar',
    scope: 'client',
    config: false, // Hidden from settings menu, controlled via UI button
    type: Boolean,
    default: false, // Off by default as requested
    onChange: (value) => {
      toggleFoundryMacroBar(value);
      updateControlButtonStates();
    }
  });

  // Add control buttons to the UI - this hook fires early, so register it during init
  Hooks.on('getSceneControlButtons', (controls) => {
    debug('getSceneControlButtons hook fired', controls);

    // v13 passes an object with controls property, v11-v12 passes array directly
    const controlsArray = Array.isArray(controls) ? controls : (controls.controls || []);

    // Find the token controls group (v13: 'tokens', v11-v12: 'token')
    let tokenControls = controlsArray.find(c => c.name === 'tokens' || c.name === 'token');
    if (!tokenControls) {
      debug('Token controls not found, checking all controls:', controlsArray.map(c => c.name));
      return;
    }

    debug('Found token controls, adding buttons');

    // Add SD20 macro bar toggle - use button: true so it doesn't deselect the active tool
    tokenControls.tools.push({
      name: 'sd20-macro-toggle',
      title: 'Toggle SD20 Macro Bar',
      icon: 'fa-solid fa-gamepad',
      button: true,
      onClick: () => {
        const current = game.settings.get(CONFIG.MODULE_ID, 'showSD20MacroBar');
        game.settings.set(CONFIG.MODULE_ID, 'showSD20MacroBar', !current);
      }
    });

    // Add Foundry macro bar toggle - use button: true so it doesn't deselect the active tool
    tokenControls.tools.push({
      name: 'foundry-macro-toggle',
      title: 'Toggle Foundry Macro Bar',
      icon: 'fa-solid fa-bookmark',
      button: true,
      onClick: () => {
        const current = game.settings.get(CONFIG.MODULE_ID, 'showFoundryMacroBar');
        game.settings.set(CONFIG.MODULE_ID, 'showFoundryMacroBar', !current);
      }
    });

    // Add Macro Library button - always accessible
    tokenControls.tools.push({
      name: 'sd20-macro-library',
      title: 'SD20 Macro Library',
      icon: 'fa-solid fa-book',
      button: true,
      onClick: () => {
        if (game.sd20?.openMacroLibrary) {
          game.sd20.openMacroLibrary();
        }
      }
    });
  });

  // Add Macro Library button to the sidebar tab nav
  // Foundry v12+ uses <nav id="sidebar-tabs"> with <menu> > <li> > <button> structure
  Hooks.on('renderSidebar', (app, html) => {
    _injectSidebarLibraryButton();
  });

  // Also try on ready in case renderSidebar already fired
  Hooks.once('ready', () => {
    setTimeout(() => _injectSidebarLibraryButton(), 500);
  });

  log('Macro bar control settings and hook registered');
}

/**
 * Apply initial states and set up runtime hooks (call during ready)
 */
export function registerMacroBarControls() {
  // Apply initial Foundry macro bar state
  const showFoundry = game.settings.get(CONFIG.MODULE_ID, 'showFoundryMacroBar');
  toggleFoundryMacroBar(showFoundry);

  // Also apply after canvas ready (to ensure hotbar element exists)
  Hooks.on('canvasReady', () => {
    const showFoundry = game.settings.get(CONFIG.MODULE_ID, 'showFoundryMacroBar');
    toggleFoundryMacroBar(showFoundry);
  });

  log('Macro bar controls initialized');
}

/**
 * Toggle visibility of Foundry's default macro hotbar
 */
function toggleFoundryMacroBar(show) {
  const hotbar = document.getElementById('hotbar');
  if (hotbar) {
    hotbar.style.display = show ? '' : 'none';
  }
}

/**
 * Update control button active states (called after settings change)
 */
function updateControlButtonStates() {
  // Force re-render of controls to update toggle states
  if (ui.controls) {
    ui.controls.render();
  }
}

/**
 * Inject the Macro Library button into the sidebar tab navigation
 * Matches whatever structure Foundry uses: <menu><li><button> or <a> items
 */
function _injectSidebarLibraryButton() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Already injected?
  if (sidebar.querySelector('.sd20-library-tab')) return;

  // Try to find the tab container — could be <menu>, <nav>, or similar
  const tabNav = sidebar.querySelector('nav#sidebar-tabs')
    || sidebar.querySelector('#sidebar-tabs')
    || sidebar.querySelector('nav.tabs');
  if (!tabNav) return;

  // Detect the structure: does it use <menu> > <li> > <button> or flat <a> items?
  const menu = tabNav.querySelector('menu');

  if (menu) {
    // Modern Foundry structure: <menu> > <li> > <button>
    const li = document.createElement('li');
    li.classList.add('sd20-library-tab');

    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.dataset.tooltip = 'SD20 Macro Library';
    btn.setAttribute('aria-label', 'SD20 Macro Library');
    btn.innerHTML = '<i class="fa-solid fa-book"></i>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (game.sd20?.openMacroLibrary) {
        game.sd20.openMacroLibrary();
      }
    });

    li.appendChild(btn);
    menu.appendChild(li);

    // GM Ruling Panel button (GM only, right after Macro Library)
    if (game.user?.isGM) {
      const rulingLi = document.createElement('li');
      rulingLi.classList.add('sd20-ruling-tab');

      const rulingBtn = document.createElement('button');
      rulingBtn.setAttribute('type', 'button');
      rulingBtn.dataset.tooltip = 'GM Ruling Panel';
      rulingBtn.setAttribute('aria-label', 'GM Ruling Panel');
      rulingBtn.innerHTML = '<i class="fa-solid fa-gavel"></i>';
      rulingBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (game.sd20?.openRulingPanel) {
          game.sd20.openRulingPanel();
        }
      });

      rulingLi.appendChild(rulingBtn);
      menu.appendChild(rulingLi);
    }
  } else {
    // Fallback: flat <a> items
    const libraryBtn = document.createElement('a');
    libraryBtn.classList.add('item', 'sd20-library-tab');
    libraryBtn.dataset.tooltip = 'SD20 Macro Library';
    libraryBtn.innerHTML = '<i class="fa-solid fa-book"></i>';
    libraryBtn.style.cursor = 'pointer';
    libraryBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (game.sd20?.openMacroLibrary) {
        game.sd20.openMacroLibrary();
      }
    });

    tabNav.appendChild(libraryBtn);

    // GM Ruling Panel button (GM only, right after Macro Library)
    if (game.user?.isGM) {
      const rulingBtn = document.createElement('a');
      rulingBtn.classList.add('item', 'sd20-ruling-tab');
      rulingBtn.dataset.tooltip = 'GM Ruling Panel';
      rulingBtn.innerHTML = '<i class="fa-solid fa-gavel"></i>';
      rulingBtn.style.cursor = 'pointer';
      rulingBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (game.sd20?.openRulingPanel) {
          game.sd20.openRulingPanel();
        }
      });

      tabNav.appendChild(rulingBtn);
    }
  }

  debug('Macro Library button injected into sidebar');
}
