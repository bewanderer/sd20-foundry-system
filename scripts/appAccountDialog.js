import { warn } from './utils.js';
import {
  isSignedIn,
  getBoundUsername,
  getBoundUserUuid,
  redeemPairingCode,
  logout
} from './appAuth.js';

const { DialogV2 } = foundry.applications.api;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function renderSignedIn() {
  const username = getBoundUsername();
  const userUuid = getBoundUserUuid();
  const shortUuid = userUuid ? `${userUuid.slice(0, 8)}...` : '';
  return `
    <div class="souls-d20 sd20-account-dialog">
      <p class="sd20-account-row">
        Signed in as <strong>${escapeHtml(username)}</strong>
      </p>
      <p class="sd20-account-row sd20-account-uuid">
        Account ID: <code>${escapeHtml(shortUuid)}</code>
      </p>
      <p class="sd20-account-hint">
        Foundry uses this account to load your characters and apply live updates from the SD20 App. Signing out clears the saved token; you can sign back in any time.
      </p>
      <button type="button" class="sd20-auth-signout">Sign out</button>
    </div>
  `;
}

function renderSignedOut(errorMessage) {
  const error = errorMessage
    ? `<p class="sd20-auth-error">${escapeHtml(errorMessage)}</p>`
    : '';
  return `
    <div class="souls-d20 sd20-account-dialog sd20-auth-view">
      <p class="sd20-account-hint">
        Pair Foundry with your SD20 App account so it can load your characters and receive live updates.
      </p>
      <ol class="sd20-auth-steps">
        <li>Open the SD20 App and sign in (Patreon or password, whichever you normally use).</li>
        <li>Click <strong>Pair with Foundry</strong> in the App and copy the 8-character code.</li>
        <li>Paste the code below. It works once and expires in 10 minutes.</li>
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

function swapContent(root, html) {
  const container = root.querySelector('.dialog-content')
    ?? root.querySelector('.window-content')
    ?? root;
  if (!container) return;
  const existing = container.querySelector('.sd20-account-dialog');
  if (existing) {
    existing.outerHTML = html;
  } else {
    container.insertAdjacentHTML('afterbegin', html);
  }
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

function bindSignInHandlers(root) {
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
    swapContent(root, renderSignedIn());
    bindSignedInHandlers(root);
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

function bindSignedInHandlers(root) {
  const signoutBtn = root.querySelector('.sd20-auth-signout');
  signoutBtn?.addEventListener('click', async () => {
    await logout();
    swapContent(root, renderSignedOut(null));
    bindSignInHandlers(root);
  });
}

export async function openAppAccountDialog() {
  await DialogV2.wait({
    window: { title: 'SD20 App Account' },
    position: { width: 420 },
    content: isSignedIn() ? renderSignedIn() : renderSignedOut(null),
    buttons: [
      { action: 'close', label: 'Close', default: true }
    ],
    render: (_event, dialog) => {
      const root = resolveRootElement(dialog);
      if (!root) {
        warn('appAccountDialog: could not resolve dialog root element');
        return;
      }
      if (isSignedIn()) {
        bindSignedInHandlers(root);
      } else {
        bindSignInHandlers(root);
      }
    }
  });
}
