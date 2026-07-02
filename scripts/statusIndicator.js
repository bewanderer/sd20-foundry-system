/**
 * Connection Status Indicator
 * Minimal, non-intrusive indicator at top-center of screen
 * Shows full status briefly on change, then minimizes to just an icon
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';

let statusElement = null;
let connectionCheckInterval = null;
let minimizeTimeout = null;
let lastHeartbeat = 0;
let currentState = 'red'; // 'green' | 'yellow' | 'red'

// Bug 3 + Optimization 5: ngrok flaps regularly on longer sessions. Raise the
// heartbeat timeout to 30s so a brief drop does not flip the pill to red while
// the reconnect logic is still trying.
const CONNECTION_TIMEOUT = 30000;
const MINIMIZE_DELAY = 5000; // Show full status for 5 seconds before minimizing

/**
 * Initialize status indicator
 */
export function initializeStatusIndicator() {
  createStatusElement();
  registerConnectionHandlers();
  startConnectionCheck();

  log('Status indicator initialized');
}

/**
 * Create the status indicator DOM element
 */
function createStatusElement() {
  statusElement = document.createElement('div');
  statusElement.className = 'souls-d20-status disconnected minimized';
  statusElement.innerHTML = '<i class="fas fa-unlink"></i><span class="status-text">SD20 App Disconnected</span>';
  statusElement.title = 'Click to check connection';

  statusElement.addEventListener('click', () => {
    checkConnection();
  });

  document.body.appendChild(statusElement);
}

/**
 * Register handlers for connection events
 */
function registerConnectionHandlers() {
  const bcm = game.sd20.broadcastChannel;

  bcm.on(CONFIG.MESSAGE_TYPES.APP_HANDSHAKE, () => {
    lastHeartbeat = Date.now();
    setConnected('green');
  });

  bcm.on(CONFIG.MESSAGE_TYPES.APP_HEARTBEAT, () => {
    // Tracked by handleMessage wrapper
  });

  const originalHandleMessage = bcm.handleMessage.bind(bcm);
  bcm.handleMessage = (message) => {
    if (message?.source === 'app') {
      lastHeartbeat = Date.now();
      setConnected('green');
    }
    originalHandleMessage(message);
  };
}

/**
 * Start periodic connection check
 */
function startConnectionCheck() {
  connectionCheckInterval = setInterval(() => {
    const timeSinceHeartbeat = Date.now() - lastHeartbeat;

    // Bug 3: heartbeat aged out. If broadcastChannel is still trying to
    // reconnect we stay yellow (already set by onclose). If the WS is
    // considered up but no heartbeat is arriving, promote to yellow so the
    // user sees something is off before the reconnect finishes.
    if (lastHeartbeat > 0 && timeSinceHeartbeat > CONNECTION_TIMEOUT) {
      if (currentState === 'green') {
        setConnected('yellow');
      }
    }
  }, 5000);
}

/**
 * Manually check connection by sending ping
 */
function checkConnection() {
  debug('Manual connection check triggered');
  showFull();
  game.sd20.broadcastChannel.send(CONFIG.MESSAGE_TYPES.FOUNDRY_READY, {
    timestamp: Date.now(),
    ping: true
  });
}

/**
 * Show full status (icon + text)
 */
function showFull() {
  if (!statusElement) return;

  statusElement.classList.remove('minimized');
  statusElement.classList.add('full');

  // Clear any existing minimize timeout
  if (minimizeTimeout) {
    clearTimeout(minimizeTimeout);
  }

  // Schedule minimize after delay
  minimizeTimeout = setTimeout(() => {
    minimize();
  }, MINIMIZE_DELAY);
}

/**
 * Minimize to just icon
 */
function minimize() {
  if (!statusElement) return;

  statusElement.classList.remove('full');
  statusElement.classList.add('minimized');
}

/**
 * Set connection status and update UI.
 *
 * Bug 3: three-state model. Accepts either the new string states
 * ('green' | 'yellow' | 'red') or the legacy boolean (true = green, false = red).
 * Green means fully connected with fresh heartbeat. Yellow means we know the
 * link is impaired (WS closed and reconnecting, or heartbeat stale). Red means
 * we have given up (max reconnects exhausted, or auth rejected).
 *
 * Exported so broadcastChannel.js can force the state on close and on reconnect
 * failure without waiting for the periodic check.
 */
export function setConnected(state) {
  if (!statusElement) return;

  // Legacy boolean -> new state
  if (state === true) state = 'green';
  else if (state === false) state = 'red';
  if (state !== 'green' && state !== 'yellow' && state !== 'red') return;

  if (currentState === state) return;
  const prev = currentState;
  currentState = state;

  const bcm = game.sd20.broadcastChannel;
  if (bcm) bcm.connected = (state === 'green');

  statusElement.classList.remove('connected', 'disconnected', 'sd20-status-green', 'sd20-status-yellow', 'sd20-status-red');

  if (state === 'green') {
    statusElement.classList.add('connected', 'sd20-status-green');
    statusElement.innerHTML = '<i class="fas fa-link"></i><span class="status-text">SD20 App Connected</span>';
    if (prev !== 'green' && game.user.isGM) {
      ui.notifications.info('SD20 App connected');
    }
  } else if (state === 'yellow') {
    statusElement.classList.add('disconnected', 'sd20-status-yellow');
    statusElement.innerHTML = '<i class="fas fa-plug"></i><span class="status-text">SD20 App Reconnecting</span>';
  } else {
    statusElement.classList.add('disconnected', 'sd20-status-red');
    statusElement.innerHTML = '<i class="fas fa-unlink"></i><span class="status-text">SD20 App Disconnected</span>';
    if (prev !== 'red' && game.user.isGM) {
      ui.notifications.warn('SD20 App disconnected');
    }
  }

  // Show full status on state change
  showFull();
}

/**
 * Clean up status indicator
 */
export function destroyStatusIndicator() {
  if (connectionCheckInterval) {
    clearInterval(connectionCheckInterval);
    connectionCheckInterval = null;
  }

  if (minimizeTimeout) {
    clearTimeout(minimizeTimeout);
    minimizeTimeout = null;
  }

  if (statusElement) {
    statusElement.remove();
    statusElement = null;
  }
}
