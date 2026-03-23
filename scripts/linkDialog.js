/**
 * Character Link Dialog
 * Requests and displays characters from SD20 App for token linking
 */

import { CONFIG } from './config.js';
import { log, warn, debug } from './utils.js';

const { DialogV2 } = foundry.applications.api;

/**
 * Request characters from SD20 App via BroadcastChannel
 * Returns a promise that resolves with character array
 */
export function requestCharactersFromApp() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      warn('Timeout waiting for character data from SD20 App');
      resolve([]);
    }, 5000);

    // Handler for character response
    const handler = (data) => {
      clearTimeout(timeout);
      game.sd20.broadcastChannel.off(CONFIG.MESSAGE_TYPES.CHARACTER_RESPONSE_ALL);

      // Store characters in module namespace
      if (data.characters) {
        data.characters.forEach(char => {
          game.sd20.characters[char.uuid] = char;
        });
      }

      debug(`Received ${data.characters?.length || 0} characters from App`);
      resolve(data.characters || []);
    };

    // Register handler and send request
    game.sd20.broadcastChannel.on(CONFIG.MESSAGE_TYPES.CHARACTER_RESPONSE_ALL, handler);
    game.sd20.broadcastChannel.send(CONFIG.MESSAGE_TYPES.CHARACTER_REQUEST_ALL, {
      timestamp: Date.now()
    });
  });
}

/**
 * Link character to token's Actor (not the token itself)
 * Macros and character link persist across token deletion/recreation
 */
export async function linkCharacterToToken(tokenDoc, uuid, characters, configApp = null) {
  const character = characters.find(c => c.uuid === uuid);
  if (!character) {
    warn('Character not found:', uuid);
    return false;
  }

  // Get the actor ID from the token
  const actorId = tokenDoc.actor?.id;
  if (!actorId) {
    ui.notifications.error('Token must be linked to an Actor to use SD20 features');
    warn('Cannot link character - token has no actor');
    return false;
  }

  // IMPORTANT: Fetch the Actor from game.actors to get the actual world Actor
  // tokenDoc.actor may be a synthetic/embedded actor that doesn't persist flags
  const actor = game.actors.get(actorId);
  if (!actor) {
    ui.notifications.error('Actor not found in world');
    warn('Cannot link character - actor not found in game.actors');
    return false;
  }

  // Check if user owns the actor
  if (!actor.isOwner) {
    ui.notifications.error('You do not have permission to modify this Actor');
    warn('Cannot link character - user does not own actor');
    return false;
  }

  // Save characterUUID to Actor system data
  log(`Saving characterUUID to Actor: actorId=${actor.id}, actorName="${actor.name}", uuid=${uuid}`);
  await actor.update({ 'system.characterUUID': uuid });

  // Verify it was saved
  const freshActor = game.actors.get(actorId);
  const savedUUID = freshActor?.system?.characterUUID;
  log(`Verified saved characterUUID on Actor: ${savedUUID}`);

  // Update token name if it's generic
  if (tokenDoc.name === 'Token' || tokenDoc.name.includes('Token')) {
    await tokenDoc.update({ name: character.name });
  }

  ui.notifications.info(`Actor "${actor.name}" linked to SD20 character "${character.name}"`);
  log(`Actor "${actor.name}" (id=${actor.id}) linked to character "${character.name}" (${uuid})`);

  // Re-render config if provided
  if (configApp) {
    configApp.render(true);
  }

  // Force immediate UI updates across all relevant elements
  _refreshAllUIForActor(actor, tokenDoc);

  return true;
}

/**
 * Force refresh of all UI elements for an actor after link/unlink
 * @param {Actor} actor - The actor that was linked/unlinked
 * @param {TokenDocument} tokenDoc - The token document
 */
function _refreshAllUIForActor(actor, tokenDoc) {
  // Refresh actor sheet if open
  if (actor.sheet?.rendered) {
    actor.sheet.render(true);
  }

  // Refresh all tokens for this actor on the current scene
  const tokens = canvas.tokens?.placeables?.filter(t => t.actor?.id === actor.id) || [];
  for (const token of tokens) {
    // Refresh token HUD if it's displayed for this token
    if (canvas.hud?.token?.object?.id === token.id) {
      canvas.hud.token.render(true);
    }
    // Refresh token appearance
    token.refresh();
  }

  // Trigger a hook that other modules can listen to
  Hooks.callAll('sd20CharacterLinkChanged', actor, tokenDoc);
}

/**
 * Generate HTML for character list display
 */
export function generateCharacterListHTML(characters) {
  if (!characters || characters.length === 0) {
    return `
      <div class="souls-d20 souls-d20-character-selector">
        <p class="no-characters">No characters available. Make sure SD20 App is open and connected.</p>
      </div>
    `;
  }

  return `
    <div class="souls-d20 souls-d20-character-selector">
      <p class="selector-heading">Select a character from SD20 App:</p>
      <div class="character-list">
        ${characters.map(char => `
          <div class="character-item" data-uuid="${char.uuid}">
            <div class="character-name">${char.name}</div>
            <div class="character-info">
              <span>Level ${char.level || '?'}</span>
              <span>Max HP: ${char.maxHP ?? '?'}</span>
              <span>Max FP: ${char.maxFP ?? '?'}</span>
              <span>Max AP: ${char.maxAP ?? '?'}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Show character selector dialog
 */
export async function showCharacterSelector(tokenDoc, configApp) {
  const characters = await requestCharactersFromApp();

  if (characters.length === 0) {
    ui.notifications.warn('No characters available. Make sure SD20 App is open and connected.');
    return;
  }

  const selectedUUID = await DialogV2.prompt({
    window: { title: 'Select SD20 Character' },
    position: { width: 400 },
    content: generateCharacterListHTML(characters),
    ok: {
      label: 'Link Selected',
      icon: 'fa-solid fa-link',
      callback: (_event, btn) => {
        const container = btn.closest('.application') || btn.closest('.dialog-content');
        const selected = container?.querySelector('.character-item.selected');
        return selected?.dataset.uuid || null;
      }
    },
    render: (_event, html) => {
      // V13 DialogV2 render event: html may be the ApplicationV2 instance itself
      let el;
      if (html instanceof HTMLElement) {
        el = html;
      } else if (html?.element instanceof HTMLElement) {
        el = html.element;
      } else if (html?.[0] instanceof HTMLElement) {
        el = html[0];
      } else {
        console.warn('SD20 | Could not resolve render element:', html);
        return;
      }
      const items = el.querySelectorAll('.character-item');

      items.forEach(item => {
        // Single click to select
        item.addEventListener('click', () => {
          items.forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
        });

        // Double-click to link immediately
        item.addEventListener('dblclick', async () => {
          const uuid = item.dataset.uuid;
          await linkCharacterToToken(tokenDoc, uuid, characters, configApp);
          // Close the dialog
          const appEl = item.closest('.application');
          const appId = appEl?.dataset?.appid || appEl?.id;
          if (appId) {
            const appInstance = Object.values(foundry.applications.instances).find(a => a.element === appEl)
              || ui.windows?.[appId];
            appInstance?.close();
          }
        });
      });
    }
  });

  if (selectedUUID) {
    await linkCharacterToToken(tokenDoc, selectedUUID, characters, configApp);
  }
}