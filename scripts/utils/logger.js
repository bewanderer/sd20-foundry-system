/**
 * Item 8 (Batch C): Foundry-side structured logger.
 *
 * Mirrors the App-side logger at SD20 App/mixins/logger.ts. Level gated by
 * the debugMode setting (existing) at 'debug', otherwise 'info'. Every line
 * is prefixed with [SD20][<tag>][<ISO timestamp>].
 *
 * Existing utils.js exports (log, debug, warn, error) continue to work.
 * New call sites should prefer this logger.
 */

import { CONFIG } from '../config.js';

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function _currentLevel() {
  try {
    const debugOn = game.settings?.get(CONFIG.MODULE_ID, 'debugMode');
    return debugOn ? LEVEL_ORDER.debug : LEVEL_ORDER.info;
  } catch {
    return LEVEL_ORDER.info;
  }
}

function _emit(level, tag, message, args) {
  if (LEVEL_ORDER[level] < _currentLevel()) return;
  const ts = new Date().toISOString();
  const prefix = `[SD20][${tag}][${ts}]`;
  const fn = level === 'debug' ? console.debug
    : level === 'info' ? console.log
    : level === 'warn' ? console.warn
    : console.error;
  fn(prefix, message, ...args);
}

export const logger = {
  debug(tag, message, ...args) { _emit('debug', tag, message, args); },
  info(tag, message, ...args) { _emit('info', tag, message, args); },
  warn(tag, message, ...args) { _emit('warn', tag, message, args); },
  error(tag, message, ...args) { _emit('error', tag, message, args); },
};
