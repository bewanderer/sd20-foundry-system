import { log, warn } from './utils.js';
import {
  isSignedIn,
  getBoundUsername,
  redeemPairingCode,
  logout,
  fetchOwnedCharacters
} from './appAuth.js';

const { DialogV2 } = foundry.applications.api;

export async function linkCharacterToToken(tokenDoc, uuid, characters, configApp = null) {
  const character = characters.find(c => c.uuid === uuid);
  if (!character) {
    warn('Character not found:', uuid);
    return false;
  }

  const actorId = tokenDoc.actor?.id;
  if (!actorId) {
    ui.notifications.error('Token must be linked to an Actor to use SD20 features');
    warn('Cannot link character - token has no actor');
    return false;
  }

  const actor = game.actors.get(actorId);
  if (!actor) {
    ui.notifications.error('Actor not found in world');
    warn('Cannot link character - actor not found in game.actors');
    return false;
  }

  if (!actor.isOwner) {
    ui.notifications.error('You do not have permission to modify this Actor');
    warn('Cannot link character - user does not own actor');
    return false;
  }

  log(`Saving characterUUID to Actor: actorId=${actor.id}, actorName="${actor.name}", uuid=${uuid}`);
  await actor.update({ 'system.characterUUID': uuid });

  if (tokenDoc.name === 'Token' || tokenDoc.name.includes('Token')) {
    await tokenDoc.update({ name: character.name });
  }

  ui.notifications.info(`Actor "${actor.name}" linked to SD20 character "${character.name}"`);
  log(`Actor "${actor.name}" (id=${actor.id}) linked to character "${character.name}" (${uuid})`);

  if (configApp) configApp.render(true);
  _refreshAllUIForActor(actor, tokenDoc);
  return true;
}

function _refreshAllUIForActor(actor, tokenDoc) {
  if (actor.sheet?.rendered) actor.sheet.render(true);

  const tokens = canvas.tokens?.placeables?.filter(t => t.actor?.id === actor.id) || [];
  for (const token of tokens) {
    if (canvas.hud?.token?.object?.id === token.id) {
      canvas.hud.token.render(true);
    }
    token.refresh();
  }

  Hooks.callAll('sd20CharacterLinkChanged', actor, tokenDoc);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function renderSignInForm(errorMessage) {
  const error = errorMessage
    ? `<p class="sd20-auth-error">${escapeHtml(errorMessage)}</p>`
    : '';
  return `
    <div class="souls-d20 souls-d20-character-selector sd20-auth-view">
      <p class="selector-heading">Pair with your SD20 App account to load your characters.</p>
      <ol class="sd20-auth-steps">
        <li>Open the SD20 App and sign in with your usual account.</li>
        <li>Click <strong>Pair with Foundry</strong> in the App and copy the 8-character code.</li>
        <li>Paste the code below. The code is valid for 10 minutes and works once.</li>
      </ol>
      <div class="sd20-auth-form">
        <label>
          <span>Pairing code</span>
          <input type="text" name="sd20-pairing-code" spellcheck="false" autocapitalize="characters" autocomplete="off" placeholder="ABCD-2345" />
        </label>
        ${error}
        <button type="button" class="sd20-auth-submit">Pair</button>
      </div>
    </div>
  `;
}

function renderCharacterList(characters) {
  const username = getBoundUsername();
  const header = `
    <div class="sd20-auth-status">
      <span>Signed in as <strong>${escapeHtml(username)}</strong></span>
      <button type="button" class="sd20-auth-signout">Sign out</button>
    </div>
  `;

  if (!characters || characters.length === 0) {
    return `
      <div class="souls-d20 souls-d20-character-selector">
        ${header}
        <p class="no-characters">No characters on this account yet. Create one in the SD20 App, then reopen this dialog.</p>
      </div>
    `;
  }

  return `
    <div class="souls-d20 souls-d20-character-selector">
      ${header}
      <p class="selector-heading">Select a character to link to this token:</p>
      <div class="character-list">
        ${characters.map(char => `
          <div class="character-item" data-uuid="${escapeHtml(char.uuid)}">
            <div class="character-name">${escapeHtml(char.name)}</div>
            <div class="character-info">
              <span>Level ${escapeHtml(char.level ?? '?')}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function normalizeCharacterPayload(list) {
  return (list || []).map(c => ({
    uuid: c.id ?? c.uuid,
    name: c.name,
    level: c.level
  })).filter(c => c.uuid && c.name);
}

function resolveRootElement(htmlOrApp) {
  if (htmlOrApp instanceof HTMLElement) return htmlOrApp;
  if (htmlOrApp?.element instanceof HTMLElement) return htmlOrApp.element;
  if (htmlOrApp?.[0] instanceof HTMLElement) return htmlOrApp[0];
  return null;
}

function findDialogInstance(root) {
  if (!root) return null;
  return Object.values(foundry.applications.instances || {})
    .find(a => a.element === root) ?? null;
}

export async function showCharacterSelector(tokenDoc, configApp) {
  const state = {
    characters: [],
    mode: isSignedIn() ? 'list' : 'auth',
    pendingError: null
  };

  if (state.mode === 'list') {
    const result = await fetchOwnedCharacters();
    if (!result.ok) {
      if (result.status === 401) {
        state.mode = 'auth';
        state.pendingError = 'Your sign-in expired. Please sign in again.';
      } else {
        ui.notifications.warn(`Could not load characters: ${result.error}`);
        return;
      }
    } else {
      state.characters = normalizeCharacterPayload(result.characters);
    }
  }

  await DialogV2.wait({
    window: { title: 'Link SD20 Character' },
    position: { width: 420 },
    content: state.mode === 'auth'
      ? renderSignInForm(state.pendingError)
      : renderCharacterList(state.characters),
    buttons: [
      {
        action: 'link',
        label: 'Link Selected',
        icon: 'fa-solid fa-link',
        default: true,
        callback: async (_event, _btn, dialog) => {
          if (state.mode !== 'list') return false;
          const root = resolveRootElement(dialog);
          const selected = root?.querySelector('.character-item.selected');
          const uuid = selected?.dataset.uuid;
          if (!uuid) {
            ui.notifications.warn('Select a character first.');
            return false;
          }
          await linkCharacterToToken(tokenDoc, uuid, state.characters, configApp);
          return true;
        }
      },
      { action: 'cancel', label: 'Cancel' }
    ],
    render: (_event, dialog) => {
      const root = resolveRootElement(dialog);
      if (!root) {
        warn('linkDialog: could not resolve dialog root element');
        return;
      }
      attachHandlers(root, state, tokenDoc, configApp);
    }
  });
}

function attachHandlers(root, state, tokenDoc, configApp) {
  if (state.mode === 'auth') {
    bindSignInHandlers(root, state, tokenDoc, configApp);
    return;
  }
  bindCharacterListHandlers(root, state, tokenDoc, configApp);
}

function findLinkButton(root) {
  const dialogRoot = root.closest('dialog') || root.ownerDocument || root;
  return dialogRoot.querySelector('button[data-action="link"]');
}

function bindSignInHandlers(root, state, tokenDoc, configApp) {
  // The Link Selected button doesn't apply until the user has paired and the
  // character list is showing. Hide it so it's not even visible during the
  // pairing-code form.
  const linkBtn = findLinkButton(root);
  if (linkBtn) linkBtn.style.display = 'none';

  const submit = root.querySelector('.sd20-auth-submit');
  const codeInput = root.querySelector('input[name="sd20-pairing-code"]');

  const handleSubmit = async () => {
    const code = codeInput?.value;
    if (!submit) return;
    submit.disabled = true;
    submit.textContent = 'Pairing...';
    const result = await redeemPairingCode(code);
    submit.disabled = false;
    submit.textContent = 'Pair';

    if (!result.ok) {
      showAuthError(root, result.error);
      return;
    }
    await transitionToList(root, state, tokenDoc, configApp);
  };

  submit?.addEventListener('click', handleSubmit);
  codeInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      handleSubmit();
    }
  });
  codeInput?.focus();
}

function showAuthError(root, message) {
  const existing = root.querySelector('.sd20-auth-error');
  if (existing) {
    existing.textContent = message;
    return;
  }
  const form = root.querySelector('.sd20-auth-form');
  const submit = root.querySelector('.sd20-auth-submit');
  if (!form || !submit) return;
  const p = document.createElement('p');
  p.className = 'sd20-auth-error';
  p.textContent = message;
  form.insertBefore(p, submit);
}

function bindCharacterListHandlers(root, state, tokenDoc, configApp) {
  const items = root.querySelectorAll('.character-item');
  const linkBtn = findLinkButton(root);
  if (linkBtn) {
    linkBtn.style.display = '';
    linkBtn.disabled = true;
  }

  items.forEach(item => {
    item.addEventListener('click', () => {
      items.forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      if (linkBtn) linkBtn.disabled = false;
    });
    item.addEventListener('dblclick', async () => {
      const uuid = item.dataset.uuid;
      await linkCharacterToToken(tokenDoc, uuid, state.characters, configApp);
      findDialogInstance(root)?.close();
    });
  });

  const signoutBtn = root.querySelector('.sd20-auth-signout');
  signoutBtn?.addEventListener('click', async () => {
    await logout();
    state.mode = 'auth';
    state.characters = [];
    state.pendingError = null;
    swapContent(root, renderSignInForm(null));
    bindSignInHandlers(root, state, tokenDoc, configApp);
  });
}

async function transitionToList(root, state, tokenDoc, configApp) {
  swapContent(root, '<p class="sd20-auth-loading">Loading characters...</p>');
  const result = await fetchOwnedCharacters();
  if (!result.ok) {
    state.pendingError = result.error;
    swapContent(root, renderSignInForm(result.error));
    bindSignInHandlers(root, state, tokenDoc, configApp);
    return;
  }
  state.characters = normalizeCharacterPayload(result.characters);
  state.mode = 'list';
  state.pendingError = null;
  swapContent(root, renderCharacterList(state.characters));
  bindCharacterListHandlers(root, state, tokenDoc, configApp);
}

function swapContent(root, html) {
  const container = root.querySelector('.dialog-content')
    ?? root.querySelector('.window-content')
    ?? root;
  if (!container) return;
  const existing = container.querySelector('.souls-d20-character-selector, .sd20-auth-loading');
  if (existing) {
    existing.outerHTML = html;
  } else {
    container.insertAdjacentHTML('afterbegin', html);
  }
}
