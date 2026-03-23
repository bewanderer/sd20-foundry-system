/**
 * SD20 Script API
 * Helper functions for custom macro scripts and console use.
 * All functions are registered on game.sd20.api and injected as 'sd20' in custom scripts.
 */

import { debug } from './utils.js';
import { resolveTargets } from './targetingSystem.js';
import { chainMacro, getActiveMacroBar } from './macroBar.js';

const { DialogV2 } = foundry.applications.api;

// Execution context: set before running a custom script, cleared after
let _context = {
  casterToken: null,
  macro: null
};

/* ========================================
   Context Management
   ======================================== */

/** Set execution context before running a custom script */
export function setExecutionContext(casterToken, macro) {
  _context = { casterToken, macro };
}

/** Clear execution context after script completes */
export function clearExecutionContext() {
  _context = { casterToken: null, macro: null };
}

/* ========================================
   Core API Functions
   ======================================== */

/** Returns the caster's token object (from script context or selected token) */
function getCaster() {
  if (_context.casterToken) return _context.casterToken;
  // Fallback for console use: first controlled token
  const controlled = canvas.tokens?.controlled?.[0];
  if (!controlled) {
    console.warn('sd20.getCaster: no caster token in context and no token selected');
    return null;
  }
  return controlled;
}

/** Returns the caster's actor document */
function getCasterActor() {
  const token = getCaster();
  return token?.actor || null;
}

/**
 * Open targeting UI and return selected target tokens.
 * @param {Object} options - { mode: 'single'|'aoe'|'self', maxTargets: number, includeSelf: boolean }
 * @returns {Token[]} Array of target tokens (empty if cancelled)
 */
async function apiResolveTargets(options = {}) {
  const caster = getCaster();
  if (!caster) {
    console.warn('sd20.resolveTargets: no caster token available');
    return [];
  }

  const macro = {
    targeting: {
      isTargetMacro: true,
      mode: options.mode || 'single',
      maxTargets: options.maxTargets || 1,
      includeSelf: options.includeSelf || false
    },
    aoe: options.aoe || {}
  };

  const macroBar = getActiveMacroBar();
  const createAoEFn = macroBar
    ? (m, t) => macroBar._createAOETemplate(m, t)
    : null;

  const result = await resolveTargets(macro, caster, createAoEFn);
  if (result.cancelled) return [];
  return result.targets || [];
}

/**
 * Roll dice and return the result.
 * @param {string} formula - Dice formula like '2d6+3'
 * @param {Object} options - { label: string } for display purposes
 * @returns {{ roll: Roll, total: number, formula: string }}
 */
async function roll(formula, options = {}) {
  try {
    const r = new Roll(formula);
    await r.evaluate();
    return { roll: r, total: r.total, formula };
  } catch (err) {
    console.warn(`sd20.roll: invalid formula "${formula}":`, err.message);
    return { roll: null, total: 0, formula };
  }
}

/**
 * Resolve weapon scaling bonus from a caster token's character data.
 * @param {string} hand - 'mainHand' or 'offHand'
 * @param {Token} casterToken - The caster token
 * @returns {number} Scaling bonus value
 */
function _resolveWeaponScaling(hand, casterToken) {
  if (hand !== 'mainHand' && hand !== 'offHand') return 0;
  const actor = casterToken?.actor;
  const uuid = actor?.getFlag?.('souls-d20', 'characterUUID');
  if (uuid) {
    const character = game.sd20?.characters?.[uuid];
    const weapon = hand === 'mainHand' ? character?.mainHand : character?.offHand;
    if (weapon?.scalingBonus !== undefined) return weapon.scalingBonus;
  }
  // Fallback: stored actor data
  const stored = actor?.system?.equippedWeapons?.[hand];
  if (stored?.scalingBonus !== undefined) return stored.scalingBonus;
  return 0;
}

/**
 * Build a dice formula with optional weapon scaling bonus.
 * @param {string} formula - Base formula like '2d6+3'
 * @param {Object} options - { scaling: 'mainHand'|'offHand' }
 * @param {Token} casterToken - The caster token
 * @returns {string} Modified formula
 */
function _applyScaling(formula, options, casterToken) {
  if (!options.scaling) return formula;
  const bonus = _resolveWeaponScaling(options.scaling, casterToken);
  if (bonus === 0) return formula;
  return bonus > 0 ? `${formula} + ${bonus}` : `${formula} - ${Math.abs(bonus)}`;
}

/**
 * Create damage threat events against targets.
 * @param {Token|Token[]} targets - Target token(s)
 * @param {string} formula - Dice formula like '2d12+0'
 * @param {Object} options - { type: 'PHYSICAL', scaling: 'mainHand', flatBonus: 0 }
 * @returns {{ roll: Roll, total: number }}
 */
async function damage(targets, formula, options = {}) {
  const caster = getCaster();
  if (!caster) { console.warn('sd20.damage: no caster token'); return null; }

  const targetsArr = _ensureArray(targets);
  if (!targetsArr.length) { console.warn('sd20.damage: no targets'); return null; }

  const scaledFormula = _applyScaling(formula, options, caster);
  const r = new Roll(scaledFormula);
  await r.evaluate();

  const combatResults = {
    damageRolls: [{ type: options.type || 'PHYSICAL', total: r.total, formula: scaledFormula, roll: r }],
    buildupRolls: [],
    conditionRolls: [],
    restorationRolls: []
  };

  const macro = _context.macro || { name: 'Script', id: 'script-api' };
  const messageData = _buildChatMessageData(caster, macro, combatResults);

  for (const target of targetsArr) {
    game.sd20?.threatSystem?.createThreatEvent(caster, target, macro, combatResults, messageData);
  }

  return { roll: r, total: r.total };
}

/**
 * Create buildup threat events against targets.
 * @param {Token|Token[]} targets - Target token(s)
 * @param {string} statusName - Status effect name like 'Poison'
 * @param {string} formula - Dice formula like '1d6+5'
 * @param {Object} options - { scaling: 'mainHand' }
 * @returns {{ roll: Roll, total: number }}
 */
async function buildup(targets, statusName, formula, options = {}) {
  const caster = getCaster();
  if (!caster) { console.warn('sd20.buildup: no caster token'); return null; }

  const targetsArr = _ensureArray(targets);
  if (!targetsArr.length) { console.warn('sd20.buildup: no targets'); return null; }

  const scaledFormula = _applyScaling(formula, options, caster);
  const r = new Roll(scaledFormula);
  await r.evaluate();

  const combatResults = {
    damageRolls: [],
    buildupRolls: [{ name: statusName, total: r.total, formula: scaledFormula, roll: r }],
    conditionRolls: [],
    restorationRolls: []
  };

  const macro = _context.macro || { name: 'Script', id: 'script-api' };
  const messageData = _buildChatMessageData(caster, macro, combatResults);

  for (const target of targetsArr) {
    game.sd20?.threatSystem?.createThreatEvent(caster, target, macro, combatResults, messageData);
  }

  return { roll: r, total: r.total };
}

/**
 * Create condition threat events against targets.
 * @param {Token|Token[]} targets - Target token(s)
 * @param {string} conditionName - Condition name like 'Dazed'
 * @param {Object} options - { duration: 2, dc: 14, dcBonus: 'weaponScaling' }
 */
async function condition(targets, conditionName, options = {}) {
  const caster = getCaster();
  if (!caster) { console.warn('sd20.condition: no caster token'); return null; }

  const targetsArr = _ensureArray(targets);
  if (!targetsArr.length) { console.warn('sd20.condition: no targets'); return null; }

  // Resolve DC bonus
  let dcBonusResolved = 0;
  if (options.dcBonus) {
    dcBonusResolved = _resolveDCBonus(options.dcBonus, caster);
  }

  const combatResults = {
    damageRolls: [],
    buildupRolls: [],
    conditionRolls: [{
      name: conditionName,
      duration: options.duration || 0,
      dc: options.dc || 0,
      dcBonusSource: options.dcBonus || 'none',
      dcBonusResolved
    }],
    restorationRolls: []
  };

  const macro = _context.macro || { name: 'Script', id: 'script-api' };
  const messageData = _buildChatMessageData(caster, macro, combatResults);

  for (const target of targetsArr) {
    game.sd20?.threatSystem?.createThreatEvent(caster, target, macro, combatResults, messageData);
  }

  return { conditionName, duration: options.duration, dc: options.dc };
}

/**
 * Create restoration events for targets.
 * @param {Token|Token[]} targets - Target token(s)
 * @param {string} formula - Dice formula like '2d8+3'
 * @param {Object} options - { type: 'heal-hp', allowOverMax: false, statusEffect, conditions, statusEffects }
 * @returns {{ roll: Roll, total: number }}
 */
async function heal(targets, formula, options = {}) {
  const caster = getCaster();
  if (!caster) { console.warn('sd20.heal: no caster token'); return null; }

  const targetsArr = _ensureArray(targets);
  if (!targetsArr.length) { console.warn('sd20.heal: no targets'); return null; }

  const scaledFormula = _applyScaling(formula, options, caster);
  const r = new Roll(scaledFormula);
  await r.evaluate();

  const combatResults = {
    damageRolls: [],
    buildupRolls: [],
    conditionRolls: [],
    restorationRolls: [{
      type: options.type || 'heal-hp',
      total: r.total,
      formula: scaledFormula,
      allowOverMax: options.allowOverMax || false,
      statusEffect: options.statusEffect || null,
      conditions: options.conditions || [],
      statusEffects: options.statusEffects || []
    }]
  };

  const macro = _context.macro || { name: 'Script', id: 'script-api' };
  const messageData = _buildChatMessageData(caster, macro, combatResults);

  for (const target of targetsArr) {
    game.sd20?.threatSystem?.createRestorationEvent(caster, target, macro, combatResults, messageData);
  }

  return { roll: r, total: r.total };
}

/**
 * Post a chat message.
 * @param {string} content - HTML or text content
 * @param {Object} options - { whisper: string[], speaker: Object }
 */
async function chat(content, options = {}) {
  const caster = getCaster();
  const messageData = {
    content,
    speaker: options.speaker || (caster ? ChatMessage.getSpeaker({ token: caster.document }) : {}),
  };
  if (options.whisper) {
    messageData.whisper = options.whisper;
  }
  try {
    await ChatMessage.create(messageData);
  } catch (err) {
    console.warn('sd20.chat: failed to create message:', err.message);
  }
}

/**
 * Get tokens whose center falls inside a MeasuredTemplate.
 * @param {string} templateId - The MeasuredTemplate document ID
 * @returns {Token[]} Array of tokens inside the template
 */
function getTokensInTemplate(templateId) {
  const templateDoc = canvas.scene?.templates?.get(templateId);
  if (!templateDoc) {
    console.warn(`sd20.getTokensInTemplate: template "${templateId}" not found`);
    return [];
  }

  // Get the PIXI object for shape hit-testing
  const templateObject = templateDoc.object;
  if (!templateObject?.shape) {
    console.warn('sd20.getTokensInTemplate: template has no shape');
    return [];
  }

  const tokens = [];
  for (const token of canvas.tokens.placeables) {
    // Use token center point
    const center = token.center;
    // Convert to template-local coordinates
    const localX = center.x - templateObject.document.x;
    const localY = center.y - templateObject.document.y;
    if (templateObject.shape.contains(localX, localY)) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Show a prompt dialog and return the chosen option.
 * @param {string} title - Dialog title
 * @param {Object} options - { content: string, choices: string[] }
 * @returns {string|null} The chosen option label, or null if cancelled
 */
async function prompt(title, options = {}) {
  const choices = options.choices || ['OK'];
  const buttons = choices.map((label, i) => ({
    action: `choice-${i}`,
    label,
    default: i === 0
  }));

  const result = await DialogV2.wait({
    window: { title },
    content: options.content ? `<p>${options.content}</p>` : '',
    buttons,
    close: () => null
  });

  if (result === null || result === undefined) return null;
  // result is the action string like 'choice-0'
  const idx = parseInt(result.replace('choice-', ''));
  return choices[idx] ?? null;
}

/* ========================================
   Internal Helpers
   ======================================== */

function _ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

/** Resolve DC bonus from a source string */
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

/** Build a basic chat message data object for threat events */
function _buildChatMessageData(casterToken, macro, combatResults) {
  return {
    speaker: ChatMessage.getSpeaker({ token: casterToken.document }),
    content: `<div class="sd20-macro-chat"><strong>${macro.name || 'Script'}</strong></div>`,
    flags: {
      'souls-d20': {
        combatResults,
        macroId: macro.id,
        macroName: macro.name,
        actorId: casterToken.actor?.id
      }
    }
  };
}

/* ========================================
   API Object Builder
   ======================================== */

/**
 * Build the complete sd20 API object.
 * Called once during system registration, merged with existing api entries.
 * @returns {Object} API functions
 */
export function buildApiObject() {
  return {
    getCaster,
    getCasterActor,
    resolveTargets: apiResolveTargets,
    roll,
    damage,
    buildup,
    condition,
    heal,
    chat,
    chainMacro,
    getTokensInTemplate,
    prompt
  };
}