/**
 * Token Configuration - SD20 Character Tab
 * Adds dedicated tab to token config for character linking
 */

import { CONFIG } from './config.js';
import { log, getTokenCharacterUUID } from './utils.js';
import { showCharacterSelector } from './linkDialog.js';

/**
 * Register token config tab hook
 */
export function registerTokenConfigTab() {
  Hooks.on('renderTokenConfig', async (app, html, data) => {
    await addSD20Tab(app, html, data);
  });

  log('Token config tab registered');
}

/**
 * Helper: create a DOM element from an HTML string
 */
function htmlToElement(htmlString) {
  const t = document.createElement('template');
  t.innerHTML = htmlString.trim();
  return t.content.firstElementChild;
}

/**
 * Add SD20 Character tab to token config
 */
async function addSD20Tab(app, html, data) {
  log('addSD20Tab called');

  const obj = app.object ?? app.document;
  if (!obj) {
    log('No object found on app');
    return;
  }

  // Get token document
  const tokenDoc = obj.document ?? obj;

  // Skip prototype tokens - they're not placed on a scene
  if (!tokenDoc.parent || !(tokenDoc.parent instanceof Scene)) {
    log('Skipping prototype token');
    return;
  }

  // Get actor for this token (Actor-based storage)
  const actor = tokenDoc.actor;

  // Check system data first, then legacy flags
  const linkedUUID = actor?.system?.characterUUID
    || actor?.getFlag(CONFIG.MODULE_ID, 'characterUUID')
    || tokenDoc.getFlag(CONFIG.MODULE_ID, 'characterUUID');
  const linkedCharacter = linkedUUID ? game.sd20.characters[linkedUUID] : null;

  // Create tab button
  const tabButton = htmlToElement(`
    <a class="item" data-tab="sd20-character">
      <i class="fas fa-link"></i> SD20 Character
    </a>
  `);

  // Create tab content based on link status
  const actorName = actor?.name || 'Unknown Actor';
  const hasActor = !!actor;
  const tabContent = htmlToElement(`
    <div class="tab" data-tab="sd20-character">
      <div class="souls-d20 souls-d20-token-config">
        ${linkedCharacter ? createLinkedCharacterHTML(linkedCharacter, actorName) : createUnlinkedHTML(hasActor)}
      </div>
    </div>
  `);

  // Get the app's element (the actual dialog window)
  const appEl = app.element instanceof HTMLElement ? app.element : app.element[0] ?? app.element;

  // Find tab navigation in the app element
  const tabNavItems = appEl.querySelectorAll('nav.sheet-tabs a');
  const lastTabNav = tabNavItems.length ? tabNavItems[tabNavItems.length - 1] : null;
  log('Tab nav found:', lastTabNav ? 1 : 0);

  if (lastTabNav) {
    lastTabNav.insertAdjacentElement('afterend', tabButton);
  } else {
    log('Could not find tab navigation');
    return;
  }

  // Add tab content after last tab content
  const allTabs = appEl.querySelectorAll('.tab[data-tab]');
  const lastTab = allTabs.length ? allTabs[allTabs.length - 1] : null;
  log('Last tab found:', lastTab ? 1 : 0);
  if (lastTab) {
    lastTab.insertAdjacentElement('afterend', tabContent);
  }

  // Set up tab click handler for the custom tab
  tabButton.addEventListener('click', (event) => {
    event.preventDefault();

    // Deactivate all tabs
    appEl.querySelectorAll('nav.sheet-tabs a').forEach(a => a.classList.remove('active'));
    appEl.querySelectorAll('.tab[data-tab]').forEach(tab => tab.classList.remove('active'));

    // Activate the custom tab
    tabButton.classList.add('active');
    tabContent.classList.add('active');
  });

  // When OTHER tabs are clicked, deactivate the custom tab
  appEl.querySelectorAll('nav.sheet-tabs a:not([data-tab="sd20-character"])').forEach(otherTab => {
    otherTab.addEventListener('click', () => {
      tabButton.classList.remove('active');
      tabContent.classList.remove('active');
    });
  });

  // Activate event listeners
  activateSD20TabListeners(appEl, tokenDoc, app);
}

/**
 * Generate HTML for linked character display
 */
function createLinkedCharacterHTML(character, actorName) {
  return `
    <div class="linked-character">
      <h3>Currently Linked</h3>
      <p class="actor-info">Actor: <strong>${actorName}</strong></p>
      <div class="character-card">
        <div class="character-name">${character.name}</div>
        <div class="character-stats">
          <span>Level ${character.level || '?'}</span>
          <span>HP: ${character.currentHP ?? '?'}/${character.maxHP ?? '?'}</span>
          <span>FP: ${character.currentFP ?? '?'}/${character.maxFP ?? '?'}</span>
        </div>
      </div>
      <div class="button-group">
        <button type="button" class="sd20-change-character">
          <i class="fas fa-sync"></i> Change Character
        </button>
        <button type="button" class="sd20-unlink-character">
          <i class="fas fa-unlink"></i> Unlink
        </button>
      </div>
    </div>
  `;
}

/**
 * Generate HTML for unlinked token
 */
function createUnlinkedHTML(hasActor) {
  if (!hasActor) {
    return `
      <div class="no-link">
        <p class="warning"><i class="fas fa-exclamation-triangle"></i> This token has no Actor.</p>
        <p>SD20 features require tokens to be linked to an Actor. Create or link an Actor first.</p>
      </div>
    `;
  }
  return `
    <div class="no-link">
      <p>This Actor is not linked to an SD20 character.</p>
      <button type="button" class="sd20-link-character">
        <i class="fas fa-link"></i> Link to Character
      </button>
    </div>
  `;
}

/**
 * Activate event listeners for SD20 tab buttons
 */
function activateSD20TabListeners(html, tokenDoc, app) {
  // Link button (for unlinked tokens)
  const linkBtn = html.querySelector('.sd20-link-character');
  if (linkBtn) {
    linkBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      await showCharacterSelector(tokenDoc, app);
    });
  }

  // Change button (for linked tokens)
  const changeBtn = html.querySelector('.sd20-change-character');
  if (changeBtn) {
    changeBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      await showCharacterSelector(tokenDoc, app);
    });
  }

  // Unlink button
  const unlinkBtn = html.querySelector('.sd20-unlink-character');
  if (unlinkBtn) {
    unlinkBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      await unlinkTokenDoc(tokenDoc);
      app.render(true);
    });
  }
}

/**
 * Unlink Actor from SD20 character
 * Removes characterUUID and macroSets from Actor flags
 */
async function unlinkTokenDoc(tokenDoc) {
  const actor = tokenDoc.actor;

  // Get UUID from system data, then legacy flags
  const characterUUID = actor?.system?.characterUUID
    || actor?.getFlag(CONFIG.MODULE_ID, 'characterUUID')
    || tokenDoc.getFlag(CONFIG.MODULE_ID, 'characterUUID');

  if (!characterUUID) return;

  // Unlink from Actor if present
  if (actor) {
    if (!actor.isOwner) {
      ui.notifications.error('You do not have permission to modify this Actor');
      return;
    }
    await actor.update({ 'system.characterUUID': '' });
    ui.notifications.info(`Actor "${actor.name}" unlinked from SD20 character`);
    log(`Actor "${actor.name}" unlinked from character ${characterUUID}`);
  } else {
    // Legacy: unlink from token if no actor
    await tokenDoc.unsetFlag(CONFIG.MODULE_ID, 'characterUUID');
    ui.notifications.info('Token unlinked from SD20 character');
    log(`Token "${tokenDoc.name}" unlinked from character ${characterUUID}`);
  }

  // Remove from character storage
  if (game.sd20?.characters[characterUUID]) {
    delete game.sd20.characters[characterUUID];
  }
}