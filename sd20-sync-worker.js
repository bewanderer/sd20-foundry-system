/**
 * SD20 Sync - SharedWorker
 * Relays messages between SD20 App and Foundry VTT
 * Both tabs must load this worker from the same origin (Foundry's module folder)
 */

const connections = [];

console.log('[SD20 SharedWorker] Worker initialized');

onconnect = (e) => {
  const port = e.ports[0];

  console.log('[SD20 SharedWorker] New connection established, total:', connections.length + 1);
  connections.push(port);

  port.onmessage = (event) => {
    const message = event.data;

    // Basic validation
    if (!message || !message.type) {
      console.warn('[SD20 SharedWorker] Invalid message received:', message);
      return;
    }

    console.log('[SD20 SharedWorker] Relaying message:', message.type, 'from:', message.source || 'unknown');

    // Relay message to all other connected tabs
    connections.forEach(conn => {
      if (conn !== port) {
        try {
          conn.postMessage(message);
        } catch (err) {
          console.error('[SD20 SharedWorker] Failed to relay message:', err);
        }
      }
    });
  };

  port.onclose = () => {
    console.log('[SD20 SharedWorker] Connection closed');
    const index = connections.indexOf(port);
    if (index > -1) {
      connections.splice(index, 1);
    }
    console.log('[SD20 SharedWorker] Remaining connections:', connections.length);
  };

  // Start listening
  port.start();
};