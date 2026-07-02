/**
 * Bug 4: per-entry source tagging for combat sub-arrays inside macros.
 *
 * Every entry in damageTypes / statusEffects / statusConditions / restoration
 * (and their secondaryCombat counterparts) is stamped with:
 *   - id: stable random id, assigned once and preserved thereafter
 *   - _source: 'app' | 'custom'
 *
 * The re-link merge in macroBar._mergeCombatArray uses id (not the entry's
 * type/name identity) so player renames or damage-type changes do not
 * create duplicates. _source lets us keep player additions untouched by
 * incoming App data.
 *
 * Migration: on first read of a legacy macro that has no ids, we assign them.
 * Idempotent - re-running on already-tagged data is a no-op.
 */

const COMBAT_ARRAY_KEYS = [
  'damageTypes',
  'statusEffects',
  'statusConditions',
  'restoration',
];

const CF4_ARRAY_KEYS = [
  'damageProtection',
  'buildupProtection',
  'conditionProtection',
  'vulnerabilities',
];

function _tagEntries(arr, defaultSource) {
  if (!Array.isArray(arr)) return;
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.id) entry.id = foundry.utils.randomID();
    if (!entry._source) entry._source = defaultSource;
  }
}

/**
 * Normalize a single macro's combat entries in place. Returns the macro.
 * @param {object} macro       The macro object.
 * @param {string} defaultSource 'app' or 'custom' - applied to entries lacking a _source.
 */
export function normalizeMacroEntries(macro, defaultSource = 'custom') {
  if (!macro || typeof macro !== 'object') return macro;

  const primary = macro.combat;
  if (primary && typeof primary === 'object') {
    for (const key of COMBAT_ARRAY_KEYS) _tagEntries(primary[key], defaultSource);
    for (const key of CF4_ARRAY_KEYS) _tagEntries(primary[key], defaultSource);
  }
  const secondary = macro.secondaryCombat;
  if (secondary && typeof secondary === 'object') {
    for (const key of COMBAT_ARRAY_KEYS) _tagEntries(secondary[key], defaultSource);
    for (const key of CF4_ARRAY_KEYS) _tagEntries(secondary[key], defaultSource);
  }

  return macro;
}

/**
 * Normalize every macro in a macroSets object. Useful for migration and for
 * one-shot passes over full actor macro data.
 */
export function normalizeMacroSets(macroSets, defaultSource = 'custom') {
  if (!macroSets || typeof macroSets !== 'object') return macroSets;
  const sets = macroSets.sets || {};
  for (const setKey of Object.keys(sets)) {
    const set = sets[setKey];
    if (!set || !Array.isArray(set.macros)) continue;
    for (const macro of set.macros) {
      if (!macro) continue;
      // Prefer the macro's own source when known, else the caller default.
      const source = macro.source === 'app' ? 'app' : (macro.source === 'custom' ? 'custom' : defaultSource);
      normalizeMacroEntries(macro, source);
    }
  }
  return macroSets;
}
