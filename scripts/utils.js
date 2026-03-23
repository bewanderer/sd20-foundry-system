/**
 * Souls D20 Utility Functions
 */

import { CONFIG } from './config.js';

/**
 * Get debug mode setting
 */
function isDebugMode() {
  return game.settings.get(CONFIG.MODULE_ID, 'debugMode');
}

/**
 * Log message to console
 */
export function log(message, ...args) {
  console.log(`${CONFIG.MODULE_NAME} |`, message, ...args);
}

/**
 * Log warning to console
 */
export function warn(message, ...args) {
  console.warn(`${CONFIG.MODULE_NAME} |`, message, ...args);
}

/**
 * Log error to console
 */
export function error(message, ...args) {
  console.error(`${CONFIG.MODULE_NAME} |`, message, ...args);
}

/**
 * Log debug message (only if debug mode enabled)
 */
export function debug(message, ...args) {
  if (isDebugMode()) {
    console.debug(`${CONFIG.MODULE_NAME} | [DEBUG]`, message, ...args);
  }
}

/**
 * Find token by character UUID
 * Checks Actor flags first, then Token flags (for migration compatibility)
 */
export function findTokenByUUID(uuid) {
  if (!canvas?.tokens) return null;

  return canvas.tokens.placeables.find(token => {
    // Check system data first, then legacy flags
    const actorUUID = token.actor?.system?.characterUUID;
    const flagUUID = token.actor?.getFlag(CONFIG.MODULE_ID, 'characterUUID')
      || token.document.getFlag(CONFIG.MODULE_ID, 'characterUUID');
    return actorUUID === uuid || flagUUID === uuid;
  });
}

/**
 * Get character UUID from token
 * Checks Actor flags first, then Token flags (for migration compatibility)
 */
export function getTokenCharacterUUID(token) {
  // Check system data first, then legacy flags
  return token.actor?.system?.characterUUID
    || token.actor?.getFlag(CONFIG.MODULE_ID, 'characterUUID')
    || token.document.getFlag(CONFIG.MODULE_ID, 'characterUUID');
}

/**
 * Set character UUID on Actor (via token)
 * Stores on Actor for persistence across token deletion/recreation
 */
export async function setTokenCharacterUUID(token, uuid) {
  const actor = token.actor;
  if (!actor) {
    warn('Cannot set character UUID - token has no actor');
    return;
  }
  await actor.update({ 'system.characterUUID': uuid });
  log(`Actor "${actor.name}" linked to character ${uuid}`);
}

/**
 * Validate message structure from BroadcastChannel
 */
export function validateMessage(message) {
  if (!message || typeof message !== 'object') {
    warn('Invalid message received:', message);
    return false;
  }

  if (!message.type) {
    warn('Message missing type field:', message);
    return false;
  }

  return true;
}

/**
 * Source options for rest ability formula builder.
 * Each value maps to a path on actor.system.
 */
export const REST_FORMULA_SOURCES = [
  { value: 'stat:vitality', label: 'Vitality' },
  { value: 'stat:endurance', label: 'Endurance' },
  { value: 'stat:strength', label: 'Strength' },
  { value: 'stat:dexterity', label: 'Dexterity' },
  { value: 'stat:attunement', label: 'Attunement' },
  { value: 'stat:intelligence', label: 'Intelligence' },
  { value: 'stat:faith', label: 'Faith' },
  { value: 'statMod:vitality', label: 'Vitality Mod' },
  { value: 'statMod:endurance', label: 'Endurance Mod' },
  { value: 'statMod:strength', label: 'Strength Mod' },
  { value: 'statMod:dexterity', label: 'Dexterity Mod' },
  { value: 'statMod:attunement', label: 'Attunement Mod' },
  { value: 'statMod:intelligence', label: 'Intelligence Mod' },
  { value: 'statMod:faith', label: 'Faith Mod' },
  { value: 'skill:Athletics', label: 'Athletics' },
  { value: 'skill:Acrobatics', label: 'Acrobatics' },
  { value: 'skill:Perception', label: 'Perception' },
  { value: 'skill:FireKeeping', label: 'Fire Keeping' },
  { value: 'skill:Sanity', label: 'Sanity' },
  { value: 'skill:Stealth', label: 'Stealth' },
  { value: 'skill:Precision', label: 'Precision' },
  { value: 'skill:Diplomacy', label: 'Diplomacy' },
  { value: 'knowledge:Magics', label: 'Magics' },
  { value: 'knowledge:WorldHistory', label: 'World History' },
  { value: 'knowledge:Monsters', label: 'Monsters' },
  { value: 'knowledge:Cosmic', label: 'Cosmic' },
  { value: 'maxHP', label: 'Max HP' },
  { value: 'maxFP', label: 'Max FP' },
  { value: 'maxAP', label: 'Max AP' },
  { value: 'level', label: 'Level' },
  { value: 'flat', label: 'Flat Number' }
];

/**
 * Resolve a single formula source value from actor data.
 */
function _resolveFormulaSource(source, flatValue, actor) {
  if (!source || source === 'flat') return parseInt(flatValue) || 0;

  const sys = actor?.system;
  if (!sys) return 0;

  if (source === 'level') return parseInt(sys.level) || 0;
  if (source === 'maxHP') return parseInt(sys.hp?.max) || 0;
  if (source === 'maxFP') return parseInt(sys.fp?.max) || 0;
  if (source === 'maxAP') return parseInt(sys.ap?.max) || 0;

  const [type, name] = source.split(':');
  if (type === 'stat') return parseInt(sys.stats?.[name]?.value) || 0;
  if (type === 'statMod') return parseInt(sys.stats?.[name]?.mod) || 0;
  if (type === 'skill') return parseInt(sys.skills?.[name]) || 0;
  if (type === 'knowledge') return parseInt(sys.knowledge?.[name]) || 0;
  return 0;
}

/**
 * Resolve the max uses for a rest ability from actor data.
 * Supports flat values and chained formula terms (up to 3).
 * Always floors the result. Minimum 0.
 * @param {Object} restAbility - restAbility config from macro
 * @param {Object} actor - Foundry Actor document
 * @returns {number}
 */
export function resolveMaxUses(restAbility, actor) {
  if (!restAbility?.type) return Infinity;

  const maxUses = restAbility.maxUses;
  if (!maxUses) return 0;
  if (maxUses.mode === 'flat') return Math.max(0, parseInt(maxUses.flat) || 0);

  // Formula mode: evaluate up to 3 chained terms
  // Uses proper math precedence: × and ÷ before + and −
  // Each term is floored individually before chaining
  const terms = maxUses.terms || [];
  if (terms.length === 0) return 0;

  // Step 1: Resolve all term values (with per-term operations, floored)
  const values = [];
  const chains = []; // chains[i] is the operator BEFORE values[i+1]

  for (let i = 0; i < terms.length && i < 3; i++) {
    const term = terms[i];
    let termValue = _resolveFormulaSource(term.source, term.flatValue, actor);

    // Apply per-term operation (multiply or divide by modifier)
    if (term.operation === 'multiply') {
      termValue = termValue * (parseInt(term.modifier) || 1);
    } else if (term.operation === 'divide') {
      const divisor = parseInt(term.modifier) || 1;
      if (divisor !== 0) termValue = termValue / divisor;
    }

    // Floor each term individually
    values.push(Math.floor(termValue));

    // Store chain operator (for terms after the first)
    if (i > 0) {
      chains.push(term.chain || 'add');
    }
  }

  if (values.length === 1) return Math.max(0, values[0]);

  // Step 2: First pass - process × and ÷ (higher precedence)
  // Work on copies to collapse multiply/divide operations
  let processedValues = [...values];
  let processedChains = [...chains];

  let j = 0;
  while (j < processedChains.length) {
    const op = processedChains[j];
    if (op === 'multiply' || op === 'divide') {
      const left = processedValues[j];
      const right = processedValues[j + 1];
      let result;
      if (op === 'multiply') {
        result = left * right;
      } else {
        result = right !== 0 ? Math.floor(left / right) : 0;
      }
      // Replace left value with result, remove right value and this operator
      processedValues.splice(j, 2, result);
      processedChains.splice(j, 1);
      // Don't increment j - check same position again in case of chained ×/÷
    } else {
      j++;
    }
  }

  // Step 3: Second pass - process + and − (lower precedence, left to right)
  let result = processedValues[0];
  for (let k = 0; k < processedChains.length; k++) {
    const op = processedChains[k];
    const val = processedValues[k + 1];
    if (op === 'add') result += val;
    else if (op === 'subtract') result -= val;
  }

  return Math.max(0, Math.floor(result));
}

/**
 * Sanitize user input to prevent XSS
 */
export function sanitizeInput(input) {
  if (typeof input !== 'string') return input;

  const div = document.createElement('div');
  div.textContent = input;
  return div.innerHTML;
}
