/**
 * Souls D20 Communication Manager
 * Handles communication between Foundry and SD20 App via WebSocket relay
 *
 * For development: run "node sd20-relay-server.js" in the SD20 Projects folder
 * Both App and Foundry connect to ws://localhost:8080
 */

import { CONFIG } from './config.js';
import { log, warn, error, debug, validateMessage } from './utils.js';

export class BroadcastChannelManager {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.messageHandlers = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;

    this.init();
  }

  /**
   * Initialize WebSocket connection to relay server
   */
  init() {
    try {
      log('Connecting to WebSocket relay:', CONFIG.WEBSOCKET_URL);

      this.socket = new WebSocket(CONFIG.WEBSOCKET_URL);

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

      this.socket.onclose = () => {
        warn('WebSocket relay disconnected');
        this.connected = false;
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
    // Log for debugging
    log('Received message:', message);

    if (!validateMessage(message)) {
      return;
    }

    debug('Received valid message:', message);

    // Handle handshake
    if (message.type === CONFIG.MESSAGE_TYPES.APP_HANDSHAKE) {
      this.handleHandshake(message.data);
      // Also notify any registered handlers
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        handler(message.data, message);
      }
      return;
    }

    // Route message to registered handlers
    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message.data, message);
    } else {
      // Some handlers are temporary (e.g. combat:response-data), so use debug not warn
      debug('No handler registered for message type:', message.type);
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

  /**
   * Register message handler
   */
  on(messageType, handler) {
    this.messageHandlers.set(messageType, handler);
    debug(`Registered handler for: ${messageType}`);
  }

  /**
   * Unregister message handler
   */
  off(messageType) {
    this.messageHandlers.delete(messageType);
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
