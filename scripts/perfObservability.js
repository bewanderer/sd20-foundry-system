/**
 * Performance observability.
 *
 * When debug mode is on, `perfTime` in utils.js emits `perf-metric` messages
 * on the SD20 socket channel. Every client receives them; the GM logs them
 * to console with the player's Foundry user name so the GM can see whose
 * latency spike is happening without asking each player to open F12.
 *
 * All measurement is gated on the debug flag. Default OFF. A dropped metric
 * never impacts gameplay.
 */

import { CONFIG } from './config.js';
import { debug } from './utils.js';

const CHANNEL = `system.${CONFIG.MODULE_ID}`;

export function registerPerfObservability() {
  if (!game.socket) return;

  game.socket.on(CHANNEL, (payload) => {
    if (!payload || payload.type !== 'perf-metric') return;
    // Only the GM surfaces cross-player timings. Players still see their own
    // measurements in their own console via perfTime's own debug log.
    if (!game.user?.isGM) return;
    const who = payload.playerFoundryName || 'unknown';
    const metric = payload.metric || 'metric';
    const value = payload.value;
    console.debug(`${CONFIG.MODULE_NAME} | [PERF][${who}] ${metric}: ${value}ms`);
  });

  debug('Perf observability registered');
}
