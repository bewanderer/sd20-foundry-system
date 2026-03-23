/**
 * GM Ruling Panel
 * ApplicationV2 window for reviewing and ruling on threat events.
 * Only accessible to GMs.
 */

import { CONFIG } from './config.js';
import { log, debug } from './utils.js';
import {
  getAllPendingEvents, getPendingCount, clearAllEvents,
  resolveComponent, resolveAllComponents, setRulingPanel
} from './threatSystem.js';

const { HandlebarsApplicationMixin, ApplicationV2, DialogV2 } = foundry.applications.api;

// Singleton instance
let _instance = null;

export class RulingPanel extends HandlebarsApplicationMixin(ApplicationV2) {

  // Idle fade timer
  _idleTimer = null;
  _isIdle = false;
  static IDLE_TIMEOUT = 5000; // 5 seconds before fading

  static DEFAULT_OPTIONS = {
    id: 'sd20-ruling-panel',
    classes: ['sd20-ruling-panel'],
    window: {
      title: 'GM Ruling Panel',
      icon: 'fa-solid fa-gavel',
      resizable: true,
      minimizable: true
    },
    position: { width: 420, height: 500 },
    actions: {
      approveComp: RulingPanel.#onApproveComp,
      denyComp: RulingPanel.#onDenyComp,
      autoSucceed: RulingPanel.#onAutoSucceed,
      autoFail: RulingPanel.#onAutoFail,
      approveAll: RulingPanel.#onApproveAll,
      denyAll: RulingPanel.#onDenyAll,
      clearAll: RulingPanel.#onClearAll
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/ruling-panel.html',
      scrollable: ['.ruling-events']
    }
  };

  async _prepareContext(options) {
    const events = getAllPendingEvents();

    return {
      events,
      pendingCount: getPendingCount(),
      harmfulTypes: CONFIG.HARMFUL_COMPONENTS,
      damageColors: CONFIG.DAMAGE_TYPE_COLORS
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    if (!el) return;

    // Set up idle fade behavior
    this._resetIdleTimer();

    // Wake up on any interaction
    el.addEventListener('mouseenter', () => this._wakeUp());
    el.addEventListener('mousemove', () => this._wakeUp());
    el.addEventListener('click', () => this._wakeUp());
    el.addEventListener('mouseleave', () => this._startIdleTimer());
  }

  _onClose(options) {
    // Clear idle timer on close
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    super._onClose?.(options);
  }

  /**
   * Reset and restart the idle timer
   */
  _resetIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
    }
    this._wakeUp();
    this._startIdleTimer();
  }

  /**
   * Start the idle timer countdown
   */
  _startIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
    }
    this._idleTimer = setTimeout(() => this._goIdle(), RulingPanel.IDLE_TIMEOUT);
  }

  /**
   * Transition to idle (faded) state
   */
  _goIdle() {
    this._isIdle = true;
    this.element?.classList.add('ruling-idle');
  }

  /**
   * Wake up from idle state
   */
  _wakeUp() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
    }
    this._isIdle = false;
    this.element?.classList.remove('ruling-idle');
  }

  /**
   * Called when new events arrive - wake up the panel
   */
  onNewEvent() {
    this._wakeUp();
    this._startIdleTimer();
  }

  // Per-component actions
  static async #onApproveComp(event, target) {
    // Disable button immediately to prevent double-clicking
    target.disabled = true;
    const eventId = target.dataset.eventId;
    const compId = target.dataset.compId;
    await resolveComponent(eventId, compId, CONFIG.RULING_STATES.APPROVED);
  }

  static async #onDenyComp(event, target) {
    target.disabled = true;
    const eventId = target.dataset.eventId;
    const compId = target.dataset.compId;
    await resolveComponent(eventId, compId, CONFIG.RULING_STATES.DENIED);
  }

  static async #onAutoSucceed(event, target) {
    target.disabled = true;
    const eventId = target.dataset.eventId;
    const compId = target.dataset.compId;
    await resolveComponent(eventId, compId, CONFIG.RULING_STATES.AUTO_SUCCEED);
  }

  static async #onAutoFail(event, target) {
    target.disabled = true;
    const eventId = target.dataset.eventId;
    const compId = target.dataset.compId;
    await resolveComponent(eventId, compId, CONFIG.RULING_STATES.AUTO_FAIL);
  }

  // Bulk actions
  static async #onApproveAll(event, target) {
    // Disable button and all component buttons for this event
    target.disabled = true;
    const eventEl = target.closest('.ruling-event');
    eventEl?.querySelectorAll('.ruling-btn').forEach(btn => btn.disabled = true);
    const eventId = target.dataset.eventId;
    await resolveAllComponents(eventId, CONFIG.RULING_STATES.APPROVED);
  }

  static async #onDenyAll(event, target) {
    target.disabled = true;
    const eventEl = target.closest('.ruling-event');
    eventEl?.querySelectorAll('.ruling-btn').forEach(btn => btn.disabled = true);
    const eventId = target.dataset.eventId;
    await resolveAllComponents(eventId, CONFIG.RULING_STATES.DENIED);
  }

  static async #onClearAll() {
    const confirmed = await DialogV2.confirm({
      window: { title: 'Clear Ruling Pool' },
      content: '<p>Clear all pending threat events? They will be voided as if never happened.</p>',
      yes: { label: 'Clear All', icon: 'fa-solid fa-trash' },
      no: { label: 'Cancel' }
    });
    if (!confirmed) return;
    clearAllEvents();
  }
}

/* ========================================
   Singleton + Registration
   ======================================== */

/**
 * Get or create the singleton ruling panel
 */
function getInstance() {
  if (!_instance) {
    _instance = new RulingPanel();
    setRulingPanel(_instance);
  }
  return _instance;
}

export function openRulingPanel() {
  if (!game.user.isGM) return;
  const panel = getInstance();
  panel.render({ force: true });
}

export function closeRulingPanel() {
  if (_instance?.rendered) _instance.close();
}

export function toggleRulingPanel() {
  if (_instance?.rendered) {
    closeRulingPanel();
  } else {
    openRulingPanel();
  }
}

/**
 * Register the ruling panel access points
 */
export function registerRulingPanel() {
  if (!game.user.isGM) return;

  // Initialize singleton so threatSystem can notify it
  getInstance();

  // Add scene control button with badge
  Hooks.on('getSceneControlButtons', (controls) => {
    // Foundry v12 changed the structure - controls may be an object with .tokens property
    // or it could be accessed via iteration
    let tokenControls;

    try {
      if (Array.isArray(controls)) {
        tokenControls = controls.find(c => c.name === 'token');
      } else if (controls.tokens) {
        // v12 might have direct property access
        tokenControls = controls.tokens;
      } else if (typeof controls[Symbol.iterator] === 'function') {
        // Iterable (like Map values)
        for (const control of controls) {
          if (control.name === 'token') {
            tokenControls = control;
            break;
          }
        }
      } else {
        // Try to find token in object properties
        tokenControls = controls.token || Object.values(controls).find(c => c?.name === 'token');
      }
    } catch (err) {
      console.warn('SD20: Could not find token controls for ruling panel button:', err);
      return;
    }

    if (!tokenControls) return;

    // Ensure tools array exists
    if (!tokenControls.tools) tokenControls.tools = [];

    tokenControls.tools.push({
      name: 'sd20-ruling-panel',
      title: 'GM Ruling Panel',
      icon: 'fa-solid fa-gavel',
      button: true,
      onClick: () => toggleRulingPanel()
    });
  });

  // Keybinding registration must happen during init, so register a setting-based shortcut
  // For now, expose on game.sd20 and let users bind via Foundry keybindings if desired

  log('Ruling panel registered');
}
