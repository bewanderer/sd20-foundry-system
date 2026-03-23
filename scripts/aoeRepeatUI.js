/**
 * AoE Repeat Button UI
 * Floating buttons above persistent/permanent AoE templates
 * Allows GM and caster to re-trigger primary/secondary/both effects
 * Supports drag-to-move, low idle opacity, and persistence across page refresh
 */

import { log, debug } from './utils.js';
import { isTokenInHighlightedCells } from './aoeGridHighlight.js';

/** Map of templateId -> DOM container element */
const _buttonContainers = new Map();

/** Map of templateId -> { x, y } manual drag offset (viewport px) */
const _dragOffsets = new Map();

/** Reference to the render hook ID for cleanup */
let _canvasHookId = null;

/**
 * Register the AoE repeat button system
 * Sets up hooks for template creation, deletion, and canvas movement
 */
export function registerAoERepeatUI() {
  debug('registerAoERepeatUI called');

  // When templates are created on the scene
  Hooks.on('createMeasuredTemplate', (template) => {
    debug(`createMeasuredTemplate hook fired for ${template.id}`);
    _onTemplateCreated(template);
  });

  // When templates are deleted
  Hooks.on('deleteMeasuredTemplate', (template) => {
    _removeButtons(template.id);
  });

  // When templates are updated (e.g., duration change)
  Hooks.on('updateMeasuredTemplate', (template) => {
    _onTemplateUpdated(template);
  });

  // When canvas is ready, scan for existing qualifying templates (handles page refresh)
  Hooks.on('canvasReady', () => {
    debug('canvasReady hook fired - refreshing AoE buttons');
    _refreshAll();
    _startPositionUpdates();
  });

  // When scene changes, clean up all buttons
  Hooks.on('canvasTearDown', () => {
    _destroyAll();
  });

  debug('AoE repeat button UI registered');

  // If canvas is already ready during registration (common during module init),
  // immediately refresh to catch any existing templates
  if (canvas?.ready) {
    debug('Canvas already ready - performing immediate refresh');
    _refreshAll();
    _startPositionUpdates();
  }
}

/* -------------------------------------------- */
/*  Template Lifecycle Handlers                  */
/* -------------------------------------------- */

function _onTemplateCreated(template) {
  if (!_shouldShowButtons(template)) return;
  _createButtons(template);
}

function _onTemplateUpdated(template) {
  const existing = _buttonContainers.has(template.id);
  const shouldShow = _shouldShowButtons(template);

  if (shouldShow && !existing) {
    _createButtons(template);
  } else if (!shouldShow && existing) {
    _removeButtons(template.id);
  }
}

/**
 * Determine if repeat buttons should be shown for this template
 * - Must have souls-d20 flags
 * - Duration must be > 0 (persistent) or -1 (permanent) -- NOT 0 (one-shot)
 * - Must have macroData with combat or secondaryCombat
 * - Current user must be GM or the caster
 */
function _shouldShowButtons(template) {
  const flags = template.flags?.['souls-d20'];
  if (!flags) {
    debug(`_shouldShowButtons: No souls-d20 flags on template ${template.id}`);
    return false;
  }

  // Convert duration to number to handle both string and number cases
  const duration = Number(flags.duration);
  if (duration === 0 || isNaN(duration)) {
    debug(`_shouldShowButtons: Duration invalid (${flags.duration} → ${duration}) on template ${template.id}`);
    return false;
  }

  const macroData = flags.macroData;
  if (!macroData) {
    debug(`_shouldShowButtons: No macroData on template ${template.id}`);
    return false;
  }

  // Must have at least one combat effect configured
  const hasPrimary = macroData.combat && (
    macroData.combat.damageTypes?.length || macroData.combat.statusEffects?.length ||
    macroData.combat.statusConditions?.length || macroData.combat.restoration?.length
  );
  const hasSecondary = macroData.secondaryCombat && (
    macroData.secondaryCombat.damageTypes?.length || macroData.secondaryCombat.statusEffects?.length ||
    macroData.secondaryCombat.statusConditions?.length || macroData.secondaryCombat.restoration?.length
  );
  if (!hasPrimary && !hasSecondary) {
    debug(`_shouldShowButtons: No combat effects configured on template ${template.id} (hasPrimary=${hasPrimary}, hasSecondary=${hasSecondary})`);
    return false;
  }

  // Permission check: GM or caster
  if (game.user.isGM) {
    debug(`_shouldShowButtons: User is GM, showing buttons for template ${template.id}`);
    return true;
  }

  const casterActorId = flags.casterActorId;
  if (!casterActorId) {
    debug(`_shouldShowButtons: No casterActorId on template ${template.id}`);
    return false;
  }
  const actor = game.actors.get(casterActorId);
  const isOwner = actor?.isOwner || false;
  debug(`_shouldShowButtons: Permission check for template ${template.id}: caster=${casterActorId}, isOwner=${isOwner}`);
  return isOwner;
}

/* -------------------------------------------- */
/*  Button Creation and Positioning              */
/* -------------------------------------------- */

function _createButtons(template) {
  const flags = template.flags?.['souls-d20'];
  if (!flags?.macroData) return;

  // Remove existing if any
  _removeButtons(template.id);

  const container = document.createElement('div');
  container.classList.add('sd20-aoe-repeat-buttons');
  container.dataset.templateId = template.id;

  // Drag handle (label doubles as drag target)
  const label = document.createElement('div');
  label.classList.add('aoe-repeat-label');
  label.textContent = flags.macroData.name || 'AoE';
  label.title = 'Drag to reposition';
  label.style.cursor = 'grab';
  container.appendChild(label);

  // Create the trigger buttons
  const buttonRow = document.createElement('div');
  buttonRow.classList.add('aoe-repeat-row');

  const macroData = flags.macroData;
  const hasPrimary = macroData.combat && (
    macroData.combat.damageTypes?.length || macroData.combat.statusEffects?.length ||
    macroData.combat.statusConditions?.length || macroData.combat.restoration?.length
  );
  const hasSecondary = macroData.secondaryCombat && (
    macroData.secondaryCombat.damageTypes?.length || macroData.secondaryCombat.statusEffects?.length ||
    macroData.secondaryCombat.statusConditions?.length || macroData.secondaryCombat.restoration?.length
  );

  if (hasPrimary) {
    buttonRow.appendChild(_createTriggerButton('Primary', 'fa-solid fa-swords', 'primary', template));
  }
  if (hasSecondary) {
    buttonRow.appendChild(_createTriggerButton('Secondary', 'fa-solid fa-wand-sparkles', 'secondary', template));
  }
  if (hasPrimary && hasSecondary) {
    buttonRow.appendChild(_createTriggerButton('Both', 'fa-solid fa-layer-group', 'both', template));
  }

  container.appendChild(buttonRow);

  // Set up drag behavior on the label
  _setupDrag(label, container, template.id);

  // Append directly to body to avoid CSS containment issues from ancestor elements
  document.body.appendChild(container);

  _buttonContainers.set(template.id, container);

  // Initial position update and start tracking loop
  _updatePosition(template.id);
  _startRenderLoop();
}

function _createTriggerButton(label, icon, effectChoice, template) {
  const btn = document.createElement('button');
  btn.classList.add('aoe-repeat-btn');
  btn.dataset.effect = effectChoice;
  btn.innerHTML = `<i class="${icon}"></i> ${label}`;
  btn.title = `Trigger ${label} effects`;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _showSubMenu(btn, effectChoice, template);
  });

  return btn;
}

/* -------------------------------------------- */
/*  Drag Support                                 */
/* -------------------------------------------- */

function _setupDrag(handle, container, templateId) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onMove = (e) => {
    if (!dragging) return;

    const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;

    const dx = clientX - startX;
    const dy = clientY - startY;

    container.style.left = `${startLeft + dx}px`;
    container.style.top = `${startTop + dy}px`;
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = 'grab';
    container.classList.remove('dragging');

    // Remove all listeners
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);

    // Store the offset from the default (template-anchored) position
    const defaultPos = _getDefaultPosition(templateId, container);
    if (defaultPos) {
      const currentLeft = parseFloat(container.style.left) || 0;
      const currentTop = parseFloat(container.style.top) || 0;
      _dragOffsets.set(templateId, {
        x: currentLeft - defaultPos.x,
        y: currentTop - defaultPos.y
      });
    }
  };

  const startDrag = (e) => {
    // Already dragging, ignore
    if (dragging) return;

    // Only left mouse button for mouse events
    if (e.type === 'mousedown' && e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    dragging = true;

    // Get coordinates (mouse or touch)
    startX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;

    const rect = container.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    handle.style.cursor = 'grabbing';
    container.classList.add('dragging');

    // Attach document-level listeners
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  };

  // Use mousedown for mouse/mousepad
  handle.addEventListener('mousedown', startDrag);
  // Use touchstart for touch devices
  handle.addEventListener('touchstart', startDrag, { passive: false });
}

/* -------------------------------------------- */
/*  Sub-Menu (All in AoE / Pick Targets)         */
/* -------------------------------------------- */

function _showSubMenu(anchorBtn, effectChoice, template) {
  // Remove any existing submenu
  document.querySelectorAll('.aoe-repeat-submenu').forEach(el => el.remove());

  const submenu = document.createElement('div');
  submenu.classList.add('aoe-repeat-submenu');

  const allBtn = document.createElement('button');
  allBtn.classList.add('aoe-submenu-btn');
  allBtn.innerHTML = '<i class="fa-solid fa-users"></i> All in AoE';
  allBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    submenu.remove();
    _triggerRepeat(template, effectChoice, 'all');
  });

  const pickBtn = document.createElement('button');
  pickBtn.classList.add('aoe-submenu-btn');
  pickBtn.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Pick Targets';
  pickBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    submenu.remove();
    _triggerRepeat(template, effectChoice, 'pick');
  });

  submenu.appendChild(allBtn);
  submenu.appendChild(pickBtn);

  // Position submenu below the button
  const rect = anchorBtn.getBoundingClientRect();
  submenu.style.position = 'fixed';
  submenu.style.left = `${rect.left}px`;
  submenu.style.top = `${rect.bottom + 2}px`;
  submenu.style.zIndex = '1000';

  document.body.appendChild(submenu);

  // Close on outside click
  const closeHandler = (e) => {
    if (!submenu.contains(e.target) && e.target !== anchorBtn) {
      submenu.remove();
      document.removeEventListener('pointerdown', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 0);
}

/* -------------------------------------------- */
/*  Repeat Execution (self-contained, no MacroBar needed) */
/* -------------------------------------------- */

async function _triggerRepeat(template, effectChoice, targetMode) {
  const flags = template.flags?.['souls-d20'];
  if (!flags?.macroData) {
    ui.notifications.warn('No macro data stored on this AoE template');
    return;
  }

  // Find caster token from template flags (works regardless of which actor is selected)
  const casterToken = canvas.tokens.get(flags.casterTokenId);
  if (!casterToken) {
    ui.notifications.warn('Caster token not found on this scene');
    return;
  }

  // Get max targets from stored macro targeting settings
  // Only apply maxTargets limit if targeting mode was 'single' (user manually picks from AoE)
  // For 'aoe' mode, all tokens in the AoE should be valid targets for repeat execution
  const targetingMode = flags.macroData?.targeting?.mode;
  const maxTargets = (targetingMode === 'single' && flags.macroData?.targeting?.maxTargets)
    ? flags.macroData.targeting.maxTargets
    : Infinity;

  let targets = [];

  if (targetMode === 'all') {
    targets = await _detectTokensInAoE(template);
    if (targets.length === 0) {
      ui.notifications.info('No tokens found in the AoE area');
      return;
    }
    // Respect max targets limit - take closest tokens to AoE origin if over limit
    if (maxTargets < Infinity && targets.length > maxTargets) {
      const tx = template.x;
      const ty = template.y;
      targets.sort((a, b) => {
        const distA = Math.hypot(a.center.x - tx, a.center.y - ty);
        const distB = Math.hypot(b.center.x - tx, b.center.y - ty);
        return distA - distB;
      });
      targets = targets.slice(0, maxTargets);
      ui.notifications.info(`Limited to ${maxTargets} closest target(s) as per macro settings`);
    }
  } else if (targetMode === 'pick') {
    const allInAoE = await _detectTokensInAoE(template);
    if (allInAoE.length === 0) {
      ui.notifications.info('No tokens found in the AoE area to pick from');
      return;
    }
    targets = await _pickTargetsFromList(allInAoE, maxTargets);
    if (!targets || targets.length === 0) return;
  }

  debug(`AoE repeat: ${effectChoice} for ${targets.length} targets (${targetMode})`);
  await _executeRepeat(flags.macroData, effectChoice, targets, casterToken);
}

/**
 * Execute AoE repeat effects (standalone, no MacroBar dependency)
 * Rolls combat components, builds chat card, creates threat events
 */
async function _executeRepeat(macroData, effectChoice, targets, casterToken) {
  if (!targets?.length) return;

  const combat = _getSelectedCombat(macroData, effectChoice);
  const hasCombat = combat && (
    combat.damageTypes?.length || combat.statusEffects?.length ||
    combat.statusConditions?.length || combat.restoration?.length
  );
  if (!hasCombat) return;

  // Roll all combat components
  const allRolls = [];
  const combatResults = { damageRolls: [], buildupRolls: [], conditionRolls: [], restorationRolls: [] };

  for (const dmg of (combat.damageTypes || [])) {
    const result = await _rollComponent(dmg, casterToken);
    combatResults.damageRolls.push(result);
    if (result.roll) allRolls.push(result.roll);
  }
  for (const eff of (combat.statusEffects || [])) {
    const result = await _rollComponent(eff, casterToken);
    combatResults.buildupRolls.push(result);
    if (result.roll) allRolls.push(result.roll);
  }
  for (const cond of (combat.statusConditions || [])) {
    const result = { ...cond };
    if (cond.dc && cond.dc > 0) {
      result.dcDisplay = cond.dc;
      result.dcBonus = _resolveDCBonus(cond.dcBonusSource, casterToken);
      result.totalDC = (result.dcDisplay || 0) + (result.dcBonus || 0);
    }
    combatResults.conditionRolls.push(result);
  }
  for (const rest of (combat.restoration || [])) {
    const result = await _rollComponent(rest, casterToken);
    result.type = rest.type;
    result.allowOverMax = rest.allowOverMax || false;
    result.statusEffect = rest.statusEffect;
    result.conditions = rest.conditions || [];
    result.statusEffects = rest.statusEffects || [];
    combatResults.restorationRolls.push(result);
  }

  const hasHarmful = combatResults.damageRolls?.length || combatResults.buildupRolls?.length || combatResults.conditionRolls?.length;
  const hasRestoration = combatResults.restorationRolls?.length;

  // Build chat card
  const repeatLabel = effectChoice === 'both' ? 'Both' : effectChoice === 'secondary' ? 'Secondary' : 'Primary';
  const fakeForChat = { ...macroData, name: `${macroData.name} (${repeatLabel} Repeat)`, combat };
  const content = _buildRepeatChatHTML(fakeForChat, combatResults);

  const messageData = {
    speaker: ChatMessage.getSpeaker({ token: casterToken.document }),
    content,
    rolls: allRolls,
    flags: {
      'souls-d20': {
        combatResults,
        macroId: macroData.id,
        macroName: macroData.name,
        actorId: casterToken.actor?.id,
        isAoERepeat: true
      }
    }
  };

  // Create threat/restoration events or post chat
  const usesThreatSystem = game.sd20?.threatSystem && (hasHarmful || hasRestoration);
  if (!usesThreatSystem) {
    await ChatMessage.create(messageData);
  }

  if (game.sd20?.threatSystem) {
    for (const targetToken of targets) {
      if (hasHarmful) {
        game.sd20.threatSystem.createThreatEvent(casterToken, targetToken, fakeForChat, combatResults, messageData);
      }
      if (hasRestoration) {
        game.sd20.threatSystem.createRestorationEvent(casterToken, targetToken, fakeForChat, combatResults, messageData);
      }
    }
  }

  debug(`AoE repeat: ${repeatLabel} effects triggered for ${targets.length} target(s)`);
}

/* -------------------------------------------- */
/*  Combat Helpers (standalone)                  */
/* -------------------------------------------- */

/** Select combat data based on effect choice */
function _getSelectedCombat(macroData, choice) {
  const primary = macroData.combat || {};
  const secondary = macroData.secondaryCombat || {};
  if (choice === 'secondary') return secondary;
  if (choice === 'both') return {
    damageTypes: [...(primary.damageTypes || []), ...(secondary.damageTypes || [])],
    statusEffects: [...(primary.statusEffects || []), ...(secondary.statusEffects || [])],
    statusConditions: [...(primary.statusConditions || []), ...(secondary.statusConditions || [])],
    restoration: [...(primary.restoration || []), ...(secondary.restoration || [])]
  };
  return primary;
}

/** Roll a single combat component (damage, buildup, or restoration) */
async function _rollComponent(component, casterToken) {
  const result = { ...component, total: 0, formula: '', roll: null };
  const parts = [];

  const count = parseInt(component.diceCount) || 0;
  const sides = parseInt(component.diceSides) || 6;
  if (count > 0) parts.push(`${count}d${sides}`);

  const flat = parseInt(component.flatBonus) || 0;
  if (flat !== 0) parts.push(flat > 0 ? `${flat}` : `${flat}`);

  // Weapon scaling (resolved from caster token's actor data)
  if (component.scalingSource === 'weapon') {
    const hand = component.weaponHand || 'mainHand';
    const wpnScaling = _resolveWeaponScaling(hand, casterToken);
    if (wpnScaling !== 0) {
      parts.push(wpnScaling > 0 ? `${wpnScaling}` : `${wpnScaling}`);
      result.weaponScalingApplied = wpnScaling;
      result.weaponHandUsed = hand;
    }
  } else if (component.scalingSource === 'manual' && component.manualScaling) {
    const manual = parseInt(component.manualScaling) || 0;
    if (manual !== 0) parts.push(`${manual}`);
  }

  if (parts.length === 0) return result;

  result.formula = parts.join(' + ').replace(/\+ -/g, '- ');
  const roll = new Roll(result.formula);
  await roll.evaluate();
  result.roll = roll;
  result.total = roll.total;
  result.rollHTML = await roll.render();
  return result;
}

/** Resolve weapon scaling bonus from caster token's character/actor data */
function _resolveWeaponScaling(scalingLink, casterToken) {
  if (scalingLink !== 'mainHand' && scalingLink !== 'offHand') return 0;

  // Try SD20 App character data first
  const charUUID = casterToken?.actor?.getFlag?.('souls-d20', 'characterUUID');
  if (charUUID) {
    const character = game.sd20?.characters?.[charUUID];
    const weapon = scalingLink === 'mainHand' ? character?.mainHand : character?.offHand;
    if (weapon?.scalingBonus !== undefined) return weapon.scalingBonus;
  }

  // Fallback to stored actor system data
  const stored = casterToken?.actor?.system?.equippedWeapons?.[scalingLink];
  if (stored?.scalingBonus !== undefined) return stored.scalingBonus;
  return 0;
}

/** Resolve DC bonus from a stat/skill/knowledge/weapon source */
function _resolveDCBonus(source, casterToken) {
  if (!source || source === 'none') return 0;
  if (source === 'weaponScaling') return _resolveWeaponScaling('mainHand', casterToken);

  const actor = casterToken?.actor;
  if (!actor) return 0;

  const [type, name] = source.split(':');
  if (type === 'stat') return actor.system?.stats?.[name]?.mod || 0;
  if (type === 'skill') return actor.system?.skills?.[name] || 0;
  if (type === 'knowledge') return actor.system?.knowledge?.[name] || 0;
  return 0;
}

/** Build chat card HTML for AoE repeat (same format as macro cards) */
function _buildRepeatChatHTML(macro, combatResults) {
  let html = `<div class="sd20-macro-card">`;

  // Header
  html += `<div class="macro-card-header">`;
  html += `<i class="${macro.icon || 'fa-solid fa-star'}"></i>`;
  html += `<span class="macro-card-name">${macro.name}</span>`;
  html += `</div>`;

  // Damage rolls
  if (combatResults.damageRolls?.length > 0) {
    html += `<div class="combat-section harmful">`;
    for (const dmg of combatResults.damageRolls) {
      const color = CONFIG.DAMAGE_TYPE_COLORS?.[dmg.type] || '#c0c0c0';
      html += `<div class="combat-component damage-row">`;
      html += `<span class="damage-type-label" style="color:${color}">${dmg.type || 'Physical'}</span>`;
      html += `<span class="damage-formula">${dmg.formula || '0'}</span>`;
      html += `<span class="damage-total">= ${dmg.total}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Status buildup + conditions
  const hasBuildup = combatResults.buildupRolls?.length > 0;
  const hasConditions = combatResults.conditionRolls?.length > 0;
  if (hasBuildup || hasConditions) {
    html += `<div class="combat-section harmful">`;
    for (const eff of (combatResults.buildupRolls || [])) {
      html += `<div class="combat-component buildup-row">`;
      html += `<span class="buildup-label">${eff.name || 'Buildup'}</span>`;
      html += `<span class="buildup-formula">${eff.formula || '0'}</span>`;
      html += `<span class="buildup-total">= ${eff.total}</span>`;
      html += `</div>`;
    }
    for (const cond of (combatResults.conditionRolls || [])) {
      html += `<div class="combat-component condition-row">`;
      html += `<span class="condition-label">${cond.name}</span>`;
      if (cond.duration) html += `<span class="condition-duration">${cond.duration} rnd</span>`;
      if (cond.totalDC) html += `<span class="condition-dc">DC ${cond.totalDC}</span>`;
      else html += `<span class="condition-auto">Auto</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Restoration
  if (combatResults.restorationRolls?.length > 0) {
    html += `<div class="combat-section positive">`;
    for (const rest of combatResults.restorationRolls) {
      html += `<div class="combat-component restoration-row">`;
      const typeLabels = {
        'heal-hp': 'Heal HP', 'restore-fp': 'Restore FP', 'restore-ap': 'Restore AP',
        'reduce-buildup': `Reduce ${rest.statusEffect || 'Buildup'}`,
        'cure-condition': `Cure: ${(rest.conditions || []).join(', ') || 'None'}`,
        'cure-effect': `Cure: ${(rest.statusEffects || []).join(', ') || 'None'}`
      };
      html += `<span class="restoration-label">${typeLabels[rest.type] || rest.type}</span>`;
      if (rest.formula) {
        html += `<span class="restoration-formula">${rest.formula}</span>`;
        html += `<span class="restoration-total">= ${rest.total}</span>`;
      }
      if (rest.allowOverMax) html += `<span class="restoration-overmax">Over Max</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/**
 * Detect tokens whose grid cell is within the highlighted cells of an AoE template.
 * Uses grid cell-based detection for accurate targeting that matches the visual overlay.
 */
async function _detectTokensInAoE(template) {
  const tokens = canvas.tokens.placeables;
  const results = [];

  // Wait a bit for the template to be fully set up
  await new Promise(resolve => setTimeout(resolve, 50));

  for (const token of tokens) {
    // Use cell-based detection - token is in AoE if its center cell is highlighted
    if (isTokenInHighlightedCells(token, template)) {
      results.push(token);
    }
  }

  return results;
}

/**
 * Show a simple dialog to pick from detected AoE targets
 * @param {Token[]} availableTokens - Tokens to choose from
 * @param {number} maxTargets - Maximum number of targets allowed (Infinity for unlimited)
 */
async function _pickTargetsFromList(availableTokens, maxTargets = Infinity) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    // If max targets is limited, only check the first N by default
    const defaultChecked = maxTargets < Infinity ? Math.min(maxTargets, availableTokens.length) : availableTokens.length;
    const tokenList = availableTokens.map((t, i) =>
      `<label class="aoe-pick-target">
        <input type="checkbox" value="${t.id}" ${i < defaultChecked ? 'checked' : ''} />
        <span>${t.name || 'Unknown'}</span>
      </label>`
    ).join('');

    const limitText = maxTargets < Infinity ? `<p class="aoe-pick-limit">Max targets: ${maxTargets}</p>` : '';

    const dialog = new foundry.applications.api.DialogV2({
      window: { title: 'Pick AoE Targets' },
      content: `${limitText}<div class="aoe-pick-list">${tokenList}</div>`,
      buttons: [
        {
          action: 'confirm',
          icon: 'fa-solid fa-check',
          label: 'Confirm',
          callback: (event, button) => {
            const checked = button.form?.querySelectorAll('input[type="checkbox"]:checked') || [];
            const selectedIds = [];
            checked.forEach(cb => selectedIds.push(cb.value));
            // Enforce max targets limit
            const limitedIds = maxTargets < Infinity ? selectedIds.slice(0, maxTargets) : selectedIds;
            if (selectedIds.length > maxTargets) {
              ui.notifications.warn(`Selection limited to ${maxTargets} target(s)`);
            }
            const selected = availableTokens.filter(t => limitedIds.includes(t.id));
            done(selected);
          }
        },
        {
          action: 'cancel',
          icon: 'fa-solid fa-times',
          label: 'Cancel',
          callback: () => done(null)
        }
      ],
      close: () => done(null)
    });
    dialog.render({ force: true });
  });
}

/* -------------------------------------------- */
/*  Position Updates (Screen-Space Clamping)      */
/* -------------------------------------------- */

function _startPositionUpdates() {
  if (_canvasHookId) Hooks.off('canvasPan', _canvasHookId);
  _canvasHookId = Hooks.on('canvasPan', () => _updateAllPositions());

  // Also update on initial load
  _updateAllPositions();

  // Use a render tick loop for smooth tracking during pan/zoom animations
  _startRenderLoop();
}

function _updateAllPositions() {
  for (const templateId of _buttonContainers.keys()) {
    _updatePosition(templateId);
  }
}

/**
 * Compute the default (template-anchored) position for a button container.
 * Returns { x, y } in viewport pixels or null if template not found.
 */
function _getDefaultPosition(templateId, container) {
  const template = canvas.scene?.templates?.get(templateId);
  if (!template) return null;

  const canvasX = template.x ?? 0;
  const canvasY = template.y ?? 0;

  // Transform via PIXI world matrix
  const t = canvas.stage.worldTransform;
  let screenX = (canvasX * t.a) + (canvasY * t.c) + t.tx;
  let screenY = (canvasX * t.b) + (canvasY * t.d) + t.ty;

  // Offset by the canvas element's position in the viewport
  const canvasRect = canvas.app.view.getBoundingClientRect();
  screenX += canvasRect.left;
  screenY += canvasRect.top;

  // Get container size for clamping
  const rect = container.getBoundingClientRect();
  const width = rect.width || 150;
  const height = rect.height || 60;
  const margin = 10;

  // Position above the template origin
  const targetX = screenX - (width / 2);
  const targetY = screenY - height - 40;

  const clampedX = Math.max(margin, Math.min(targetX, window.innerWidth - width - margin));
  const clampedY = Math.max(margin, Math.min(targetY, window.innerHeight - height - margin));

  return { x: clampedX, y: clampedY };
}

function _updatePosition(templateId) {
  const container = _buttonContainers.get(templateId);
  if (!container) return;

  // Don't update position while dragging - the drag handler manages position
  if (container.classList.contains('dragging')) return;

  const template = canvas.scene?.templates?.get(templateId);
  if (!template) {
    _removeButtons(templateId);
    return;
  }

  const defaultPos = _getDefaultPosition(templateId, container);
  if (!defaultPos) return;

  // Apply manual drag offset if user repositioned
  const offset = _dragOffsets.get(templateId);
  const finalX = defaultPos.x + (offset?.x || 0);
  const finalY = defaultPos.y + (offset?.y || 0);

  container.style.left = `${finalX}px`;
  container.style.top = `${finalY}px`;
}

/** Render loop for smooth position tracking during pan/zoom */
let _rafId = null;
function _startRenderLoop() {
  if (_rafId) cancelAnimationFrame(_rafId);
  function tick() {
    if (_buttonContainers.size > 0) {
      _updateAllPositions();
      _rafId = requestAnimationFrame(tick);
    } else {
      _rafId = null;
    }
  }
  if (_buttonContainers.size > 0) {
    _rafId = requestAnimationFrame(tick);
  }
}

/* -------------------------------------------- */
/*  Cleanup                                      */
/* -------------------------------------------- */

function _removeButtons(templateId) {
  const container = _buttonContainers.get(templateId);
  if (container) {
    container.remove();
    _buttonContainers.delete(templateId);
  }
  _dragOffsets.delete(templateId);
}

function _refreshAll() {
  _destroyAll();
  if (!canvas.scene?.templates) {
    debug('AoE refresh: No canvas.scene.templates available');
    return;
  }

  const allTemplates = Array.from(canvas.scene.templates);
  debug(`AoE refresh: Found ${allTemplates.length} templates on scene`);

  for (const template of allTemplates) {
    const flags = template.flags?.['souls-d20'];
    const shouldShow = _shouldShowButtons(template);
    debug(`AoE refresh: Template ${template.id} - hasFlags=${!!flags}, duration=${flags?.duration}, shouldShow=${shouldShow}`);
    if (shouldShow) {
      _createButtons(template);
    }
  }
}

function _destroyAll() {
  for (const [id, container] of _buttonContainers) {
    container.remove();
  }
  _buttonContainers.clear();
  _dragOffsets.clear();
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  document.querySelectorAll('.aoe-repeat-submenu').forEach(el => el.remove());
}
