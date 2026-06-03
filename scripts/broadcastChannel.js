/**
 * Souls D20 Communication Manager
 * Handles communication between Foundry and SD20 App via WebSocket relay
 *
 * For development: run "node sd20-relay-server.js" in the SD20 Projects folder
 * Both App and Foundry connect to ws://localhost:8080
 */

import { CONFIG } from './config.js';
import { log, warn, error, debug, validateMessage } from './utils.js';
import { getToken } from './appAuth.js';

export class BroadcastChannelManager {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.messageHandlers = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    this.authClosed = false;

    Hooks.on('sd20.appAuth.changed', ({ signedIn }) => {
      this.reconnectForAuthChange(signedIn);
    });

    this.init();
  }

  reconnectForAuthChange(signedIn) {
    this.authClosed = false;
    this.reconnectAttempts = 0;
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
      this.connected = false;
    }
    if (signedIn) {
      this.init();
    }
  }

  /**
   * Initialize WebSocket connection to relay server
   */
  init() {
    const token = getToken();
    if (!token) {
      log('No paired App token; relay connect deferred until pairing.');
      return;
    }

    try {
      const connectUrl = `${CONFIG.WEBSOCKET_URL}?token=${encodeURIComponent(token)}`;
      log('Connecting to WebSocket relay (authenticated)');

      this.socket = new WebSocket(connectUrl);

      this.socket.onopen = () => {
        log('WebSocket relay connected');
        this.reconnectAttempts = 0;

        // Announce Foundry is ready
        this.send(CONFIG.MESSAGE_TYPES.FOUNDRY_READY, {
          timestamp: Date.now(),
          version: game.version
        });
      };

      this.socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (err) {
          error('Failed to parse WebSocket message:', err);
        }
      };

      this.socket.onclose = (event) => {
        warn('WebSocket relay disconnected (code', event.code, ')');
        this.connected = false;
        // 4401: relay rejected the token; reconnect happens on next pairing.
        if (event.code === 4401) {
          this.authClosed = true;
          warn('Relay rejected token; pair again from the SD20 App.');
          return;
        }
        this.attemptReconnect();
      };

      this.socket.onerror = (err) => {
        error('WebSocket error - is the relay server running? (node sd20-relay-server.js)');
      };

    } catch (err) {
      error('Failed to initialize WebSocket:', err);
    }
  }

  /**
   * Attempt to reconnect after disconnect
   */
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      error('Max reconnect attempts reached. Please restart the relay server.');
      return;
    }

    this.reconnectAttempts++;
    log(`Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(() => {
      this.init();
    }, this.reconnectDelay);
  }

  /**
   * Handle incoming messages
   */
  handleMessage(message) {
    log('Received message:', message);
    if (!validateMessage(message)) return;
    debug('Received valid message:', message);

    if (message.type === CONFIG.MESSAGE_TYPES.APP_HANDSHAKE) {
      this.handleHandshake(message.data);
    }

    this._dispatch(message.type, message);
  }

  _dispatch(type, message) {
    const handlers = this.messageHandlers.get(type);
    if (!handlers || handlers.size === 0) {
      debug('No handler registered for message type:', type);
      return;
    }
    for (const handler of Array.from(handlers)) {
      try {
        handler(message.data, message);
      } catch (err) {
        error(`Handler for ${type} threw:`, err);
      }
    }
  }

  /**
   * Handle handshake from SD20 App
   */
  handleHandshake(data) {
    log('Handshake received, setting connected = true');
    this.connected = true;
    log('SD20 App connected!', data);

    // Request all character data
    this.send(CONFIG.MESSAGE_TYPES.CHARACTER_REQUEST_ALL, {
      timestamp: Date.now()
    });

    // Show notification to GM
    if (game.user.isGM) {
      ui.notifications.info('SD20 App connected');
    }
  }

  /**
   * Send message via WebSocket
   */
  send(type, data = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      warn('WebSocket not connected');
      return false;
    }

    const message = {
      type,
      data,
      timestamp: Date.now(),
      source: 'foundry'
    };

    try {
      this.socket.send(JSON.stringify(message));
      debug('Sent message:', message);
      return true;
    } catch (err) {
      error('Failed to send message:', err);
      return false;
    }
  }

  // Multiple consumers can register handlers for the same message type.
  // Each registers its OWN function; off() removes only that specific handler
  // so other consumers' subscriptions survive. Pass no handler to off() to
  // clear every subscription for that type (legacy callers).
  on(messageType, handler) {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, new Set());
    }
    this.messageHandlers.get(messageType).add(handler);
    debug(`Registered handler for: ${messageType}`);
  }

  off(messageType, handler) {
    const handlers = this.messageHandlers.get(messageType);
    if (!handlers) return;
    if (handler) {
      handlers.delete(handler);
      if (handlers.size === 0) this.messageHandlers.delete(messageType);
    } else {
      this.messageHandlers.delete(messageType);
    }
    debug(`Unregistered handler for: ${messageType}`);
  }

  /**
   * Close WebSocket connection
   */
  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      this.connected = false;
      log('WebSocket connection closed');
    }
  }

  /**
   * Check if connected to SD20 App
   */
  isConnected() {
    return this.connected;
  }
}
