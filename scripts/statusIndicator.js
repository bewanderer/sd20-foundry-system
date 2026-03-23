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

const CONNECTION_TIMEOUT = 15000;
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
    setConnected(true);
  });

  bcm.on(CONFIG.MESSAGE_TYPES.APP_HEARTBEAT, () => {
    // Tracked by handleMessage wrapper
  });

  const originalHandleMessage = bcm.handleMessage.bind(bcm);
  bcm.handleMessage = (message) => {
    if (message?.source === 'app') {
      lastHeartbeat = Date.now();
      setConnected(true);
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

    if (lastHeartbeat > 0 && timeSinceHeartbeat > CONNECTION_TIMEOUT) {
      setConnected(false);
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
 * Set connection status and update UI
 */
function setConnected(connected) {
  if (!statusElement) return;

  const bcm = game.sd20.broadcastChannel;
  const wasConnected = bcm.connected;

  // No change, don't update UI
  if (wasConnected === connected) return;

  bcm.connected = connected;

  if (connected) {
    statusElement.classList.remove('disconnected');
    statusElement.classList.add('connected');
    statusElement.innerHTML = '<i class="fas fa-link"></i><span class="status-text">SD20 App Connected</span>';

    if (game.user.isGM) {
      ui.notifications.info('SD20 App connected');
    }
  } else {
    statusElement.classList.remove('connected');
    statusElement.classList.add('disconnected');
    statusElement.innerHTML = '<i class="fas fa-unlink"></i><span class="status-text">SD20 App Disconnected</span>';

    if (game.user.isGM) {
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
