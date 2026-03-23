/**
 * Targeting System
 * Handles target selection for macro execution: single-target, AoE, and self modes.
 * Provides a targeting bar UI and AoE token detection.
 */

import { CONFIG } from './config.js';
import { debug } from './utils.js';
import { isTokenInHighlightedCells } from './aoeGridHighlight.js';

/**
 * Resolve targets for a macro based on its targeting configuration.
 * @param {Object} macro - The macro with targeting settings
 * @param {Token} casterToken - The token casting the macro
 * @param {Function} createAoEFn - Async function to place AoE template (from macroBar)
 * @param {MeasuredTemplate|null} constraintTemplate - Optional pre-placed AoE template to constrain single-target selection
 * @returns {Promise<{targets: Token[], cancelled: boolean, template: MeasuredTemplate|null}>}
 */
export async function resolveTargets(macro, casterToken, createAoEFn, constraintTemplate = null) {
  const targeting = macro.targeting;
  if (!targeting?.isTargetMacro) {
    return { targets: [], cancelled: false, template: null };
  }

  switch (targeting.mode) {
    case 'single':
      return _resolveSingle(targeting.maxTargets || 1, targeting.includeSelf, casterToken, constraintTemplate, macro);
    case 'aoe':
      return _resolveAoE(macro, casterToken, targeting.includeSelf, createAoEFn);
    case 'self':
      return _resolveSelf(casterToken);
    default:
      return { targets: [], cancelled: false, template: null };
  }
}

/* ========================================
   Single Target Mode
   ======================================== */

/**
 * Show targeting bar and let user click tokens to select up to maxTargets.
 * If constraintTemplate is provided, only allow selecting tokens inside that AoE.
 * @param {number} maxTargets - Maximum targets allowed
 * @param {boolean} includeSelf - Whether caster can target themselves
 * @param {Token} casterToken - The caster token
 * @param {MeasuredTemplate|null} constraintTemplate - Optional AoE template to constrain selection
 * @param {Object} macro - The macro being executed (for exclusion radius)
 */
function _resolveSingle(maxTargets, includeSelf, casterToken, constraintTemplate = null, macro = null) {
  return new Promise(async (resolve) => {
    const selected = new Set();
    const highlights = new Map(); // tokenId -> PIXI highlight

    // If a constraint template exists, pre-compute which tokens are valid targets
    let validTokenIds = null;
    if (constraintTemplate) {
      // Wait for template to be fully rendered
      await new Promise(r => setTimeout(r, 100));
      const tokensInAoE = await _detectTokensInTemplate(constraintTemplate);
      validTokenIds = new Set(tokensInAoE.map(t => t.id));
      debug(`Single-target constrained to ${validTokenIds.size} tokens in AoE`);
    }

    // Build the targeting bar UI
    const bar = _createTargetingBar(maxTargets);

    // Click handler for tokens on the canvas
    function onTokenClick(event) {
      // Prevent Foundry's default token selection from deselecting controlled token
      event.stopPropagation();
      event.preventDefault?.();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();

      // event.currentTarget is the Token object in Foundry's PIXI layer
      const clickedToken = event.currentTarget;
      if (!clickedToken?.id) return;

      // Exclude caster unless includeSelf is on
      if (!includeSelf && clickedToken.id === casterToken.id) {
        ui.notifications.warn('Cannot target self with this macro');
        return;
      }

      // If constrained to AoE, check if token is within the template
      if (validTokenIds && !validTokenIds.has(clickedToken.id)) {
        ui.notifications.warn('Target is outside the AoE area');
        return;
      }

      if (selected.has(clickedToken.id)) {
        // Deselect
        selected.delete(clickedToken.id);
        _removeHighlight(clickedToken, highlights);
      } else {
        if (selected.size >= maxTargets) {
          ui.notifications.warn(`Maximum ${maxTargets} target(s) allowed`);
          return;
        }
        selected.add(clickedToken.id);
        _addHighlight(clickedToken, highlights);
      }

      bar.updateCount(selected.size);
    }

    // Register click handlers on all tokens
    const tokens = canvas.tokens.placeables;
    for (const t of tokens) {
      t.on('pointerdown', onTokenClick);
    }

    function cleanup() {
      // Remove click handlers
      for (const t of canvas.tokens.placeables) {
        t.off('pointerdown', onTokenClick);
      }
      // Remove highlights
      for (const [tokenId, gfx] of highlights) {
        const tok = canvas.tokens.get(tokenId);
        if (tok && gfx) {
          gfx.destroy();
        }
      }
      highlights.clear();
      // Remove bar
      bar.destroy();
    }

    // Confirm handler
    bar.onConfirm = () => {
      if (selected.size === 0) {
        ui.notifications.warn('No targets selected - macro will execute without targets');
      }
      cleanup();
      const targetTokens = [];
      for (const id of selected) {
        const tok = canvas.tokens.get(id);
        if (tok) targetTokens.push(tok);
      }
      resolve({ targets: targetTokens, cancelled: false, template: null });
    };

    // Cancel handler
    bar.onCancel = () => {
      cleanup();
      resolve({ targets: [], cancelled: true, template: null });
    };

    // Escape key to cancel
    function onKeydown(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKeydown);
        bar.onCancel();
      }
    }
    document.addEventListener('keydown', onKeydown);
  });
}

/* ========================================
   AoE Target Mode
   ======================================== */

/**
 * Place AoE template, then auto-detect tokens inside it.
 */
async function _resolveAoE(macro, casterToken, includeSelf, createAoEFn) {
  // Place the AoE template using the macroBar's existing placement system
  const template = await createAoEFn(macro, casterToken);
  if (!template) {
    // User cancelled placement
    return { targets: [], cancelled: true, template: null };
  }

  // Wait a frame for the template to be fully rendered on canvas
  await new Promise(resolve => requestAnimationFrame(resolve));

  // Detect tokens inside the placed template
  const detected = await _detectTokensInTemplate(template);

  // Filter out caster if not includeSelf
  const targets = includeSelf
    ? detected
    : detected.filter(t => t.id !== casterToken.id);

  debug(`AoE targeting: detected ${detected.length} tokens, ${targets.length} after self filter`);

  return { targets, cancelled: false, template };
}

/**
 * Detect all tokens whose grid cell is within the highlighted cells of a MeasuredTemplate.
 * Uses grid cell-based detection for accurate targeting that matches the visual overlay.
 */
async function _detectTokensInTemplate(template) {
  const tokens = canvas.tokens.placeables;
  const results = [];

  // Get the template document (might be passed as object or document)
  const templateDoc = template.document || template;

  // Wait a bit for the template to be fully set up
  await new Promise(resolve => setTimeout(resolve, 50));

  for (const token of tokens) {
    // Use cell-based detection - token is in AoE if its center cell is highlighted
    if (isTokenInHighlightedCells(token, templateDoc)) {
      results.push(token);
      debug(`Token "${token.name}" detected in AoE (grid cell match)`);
    }
  }

  debug(`AoE token detection found ${results.length} tokens (cell-based)`);
  return results;
}

/* ========================================
   Self Target Mode
   ======================================== */

function _resolveSelf(casterToken) {
  return Promise.resolve({
    targets: [casterToken],
    cancelled: false,
    template: null
  });
}

/* ========================================
   Targeting Bar UI
   ======================================== */

/**
 * Create the targeting bar overlay at the top of the screen.
 * Returns an object with updateCount, onConfirm, onCancel, and destroy methods.
 */
function _createTargetingBar(maxTargets) {
  const bar = document.createElement('div');
  bar.id = 'sd20-targeting-bar';
  bar.innerHTML = `
    <span class="targeting-label">Select targets:</span>
    <span class="targeting-count">0 / ${maxTargets}</span>
    <button type="button" class="targeting-btn targeting-confirm" title="Confirm targets">
      <i class="fa-solid fa-check"></i> Confirm
    </button>
    <button type="button" class="targeting-btn targeting-cancel" title="Cancel macro">
      <i class="fa-solid fa-xmark"></i> Cancel
    </button>
  `;
  document.body.appendChild(bar);

  const countEl = bar.querySelector('.targeting-count');
  const confirmBtn = bar.querySelector('.targeting-confirm');
  const cancelBtn = bar.querySelector('.targeting-cancel');

  const state = {
    onConfirm: () => {},
    onCancel: () => {},
    updateCount(n) {
      countEl.textContent = `${n} / ${maxTargets}`;
    },
    destroy() {
      bar.remove();
    }
  };

  confirmBtn.addEventListener('click', () => state.onConfirm());
  cancelBtn.addEventListener('click', () => state.onCancel());

  return state;
}

/* ========================================
   Token Highlight Ring
   ======================================== */

function _addHighlight(token, highlights) {
  const gfx = new PIXI.Graphics();
  gfx.name = 'sd20TargetHighlight';
  const r = Math.max(token.w, token.h) / 2;
  gfx.lineStyle(3, 0xff4444, 0.9);
  gfx.drawCircle(token.w / 2, token.h / 2, r + 4);
  token.addChild(gfx);
  highlights.set(token.id, gfx);
}

function _removeHighlight(token, highlights) {
  const gfx = highlights.get(token.id);
  if (gfx) {
    gfx.destroy();
    highlights.delete(token.id);
  }
}

/* ========================================
   AoE Re-targeting (for existing templates)
   ======================================== */

/**
 * Re-detect tokens inside an existing AoE template without redrawing.
 * Useful for refreshing target list when tokens have moved or been added/removed.
 * @param {string} templateId - The ID of the MeasuredTemplate document
 * @param {string|null} excludeTokenId - Optional token ID to exclude (e.g., caster)
 * @returns {Promise<Token[]>} Array of tokens detected inside the template
 */
export async function retargetAoETemplate(templateId, excludeTokenId = null) {
  // Find the template document
  const template = canvas.templates.get(templateId);
  if (!template) {
    debug(`retargetAoETemplate: Template ${templateId} not found`);
    return [];
  }

  // Use the existing detection function
  const detected = await _detectTokensInTemplate(template.document);

  // Filter out excluded token if specified
  const targets = excludeTokenId
    ? detected.filter(t => t.id !== excludeTokenId)
    : detected;

  debug(`AoE re-targeting: detected ${targets.length} tokens in template ${templateId}`);
  return targets;
}

/**
 * Get all tokens currently inside an AoE template (synchronous version).
 * Uses grid cell-based detection for accurate targeting that matches the visual overlay.
 * @param {MeasuredTemplate} templateObject - The template object from canvas
 * @param {string|null} excludeTokenId - Optional token ID to exclude
 * @returns {Token[]} Array of tokens detected inside the template
 */
export function getTokensInTemplate(templateObject, excludeTokenId = null) {
  const templateDoc = templateObject?.document || templateObject;
  if (!templateDoc) {
    debug('getTokensInTemplate: No template document');
    return [];
  }

  const tokens = canvas.tokens.placeables;
  const results = [];

  for (const token of tokens) {
    // Skip excluded token
    if (excludeTokenId && token.id === excludeTokenId) continue;

    // Use cell-based detection - token is in AoE if its center cell is highlighted
    if (isTokenInHighlightedCells(token, templateDoc)) {
      results.push(token);
    }
  }

  return results;
}