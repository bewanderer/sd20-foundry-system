import { CONFIG } from './config.js';
import { log, warn } from './utils.js';
import { canSeeActorName } from './permissions.js';
import { showDelayTurnDialog } from './delayTurnDialog.js';

const SETTING_STATE = 'initiativeModalState';
const MODAL_ID = 'sd20-init-modal';

const DEFAULT_STATE = {
  x: null,
  y: null,
  orientation: 'horizontal',
  isOpen: true
};

const SLIDE_MS = 250;
const POOF_MS = 300;
const ROUND_FADE_MS = 250;
const SAVE_DEBOUNCE_MS = 400;

export function registerInitiativeModalSettings() {
  game.settings.register(CONFIG.MODULE_ID, SETTING_STATE, {
    scope: 'client',
    config: false,
    type: Object,
    default: DEFAULT_STATE
  });
}

class InitiativeModal {
  constructor() {
    this.element = null;
    this._state = { ...DEFAULT_STATE };
    this._userHidThisCombat = false;
    this._renderScheduled = false;
    this._lastTurn = null;
    this._lastRound = null;
    this._animLock = false;
    this._saveTimer = null;
    this._dragOrigin = null;
    this._boundDragMove = null;
    this._boundDragEnd = null;
  }

  init() {
    this._loadState();
    this._registerHooks();
    this._tryAutoOpen();
    Hooks.on('canvasReady', () => this._tryAutoOpen());
  }

  _tryAutoOpen() {
    if (this.element) return;
    if (this._userHidThisCombat) return;
    if (game.combat?.started) this.open();
  }

  _loadState() {
    try {
      const stored = game.settings.get(CONFIG.MODULE_ID, SETTING_STATE) || {};
      this._state = { ...DEFAULT_STATE, ...stored };
    } catch {
      this._state = { ...DEFAULT_STATE };
    }
  }

  _saveState() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        game.settings.set(CONFIG.MODULE_ID, SETTING_STATE, this._state);
      } catch (err) {
        warn('Failed to save initiative modal state', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  _registerHooks() {
    Hooks.on('combatStart', this._onCombatStart.bind(this));
    Hooks.on('deleteCombat', this._onCombatEnd.bind(this));
    Hooks.on('updateCombat', this._onCombatUpdate.bind(this));
    Hooks.on('createCombatant', () => this.scheduleRender());
    Hooks.on('updateCombatant', () => this.scheduleRender());
    Hooks.on('deleteCombatant', () => this.scheduleRender());
    Hooks.on('sightRefresh', () => this.scheduleRender());
    Hooks.on('lightingRefresh', () => this.scheduleRender());
    Hooks.on('updateToken', this._onTokenUpdate.bind(this));
    Hooks.on('updateActor', this._onActorUpdate.bind(this));
  }

  _onCombatStart(combat) {
    this._userHidThisCombat = false;
    this._lastTurn = combat?.turn ?? null;
    this._lastRound = combat?.round ?? null;
    this.open();
  }

  _onCombatEnd() {
    this._lastTurn = null;
    this._lastRound = null;
    this.close({ remember: false });
  }

  _onCombatUpdate(combat, changed) {
    if (!this.element && game.combat?.started && !this._userHidThisCombat) {
      this.open();
    }
    if (!('turn' in changed) && !('round' in changed)) {
      this.scheduleRender();
      return;
    }
    if (!this.element) {
      this._lastTurn = combat.turn;
      this._lastRound = combat.round;
      return;
    }

    const prevRound = this._lastRound;
    const newRound = combat.round;
    const turnAdvanced = (typeof changed.turn === 'number') && (typeof this._lastTurn === 'number');
    const forward = turnAdvanced ? changed.turn > this._lastTurn : true;
    const roundChanged = newRound !== prevRound && prevRound !== null;

    this._lastTurn = combat.turn;
    this._lastRound = combat.round;

    if (roundChanged && turnAdvanced) {
      this._animateTurnAdvance(forward).then(() =>
        this._animateRoundChange(prevRound, newRound, forward)
      );
    } else if (roundChanged) {
      this._animateRoundChange(prevRound, newRound, forward);
    } else if (turnAdvanced) {
      this._animateTurnAdvance(forward);
    } else {
      this.scheduleRender();
    }
  }

  _onTokenUpdate(tokenDoc, change) {
    if (!game.combat?.combatants?.some(c => c.tokenId === tokenDoc.id)) return;
    if (change.hidden !== undefined
      || change.x !== undefined
      || change.y !== undefined
      || foundry.utils.hasProperty(change, `flags.${CONFIG.MODULE_ID}.nameRevealed`)
      || foundry.utils.hasProperty(change, `delta.flags.${CONFIG.MODULE_ID}.nameRevealed`)) {
      this.scheduleRender();
    }
  }

  _onActorUpdate(actor, change) {
    if (foundry.utils.hasProperty(change, `flags.${CONFIG.MODULE_ID}.nameRevealed`)) {
      this.scheduleRender();
    }
  }

  open() {
    if (!game.combat?.started) return;
    if (this.element) {
      this.scheduleRender();
      return;
    }
    this._state.isOpen = true;
    this._saveState();
    this._build();
    this._updateToggleState(true);
    this.scheduleRender();
  }

  close({ remember = true } = {}) {
    if (remember) {
      this._userHidThisCombat = true;
      this._state.isOpen = false;
      this._saveState();
    }
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
    this._updateToggleState(false);
  }

  toggle() {
    if (!game.combat?.started) {
      ui.notifications.warn('No active combat encounter.');
      return;
    }
    if (this.element) {
      this.close({ remember: true });
    } else {
      this._userHidThisCombat = false;
      this.open();
    }
  }

  isOpen() { return !!this.element; }

  _updateToggleState(modalOpen) {
    const sidebarBtn = document.querySelector('.sd20-init-tab');
    if (sidebarBtn) sidebarBtn.classList.toggle('is-active', modalOpen);
  }

  _build() {
    const el = document.createElement('div');
    el.id = MODAL_ID;
    el.classList.add('sd20-init-modal', `is-${this._state.orientation}`);
    el.innerHTML = `
      <div class="im-meta">
        <button type="button" class="im-flip" title="Flip orientation" aria-label="Flip orientation">
          <i class="fa-solid fa-rotate"></i>
        </button>
        <div class="im-round" title="Round">
          <span class="im-round-label">Round</span>
          <span class="im-round-num">${game.combat?.round ?? 0}</span>
        </div>
      </div>
      <div class="im-track" role="list"></div>
      <div class="im-controls"></div>
    `;
    document.body.appendChild(el);
    this.element = el;
    this._applyPosition();
    this._wireEvents();
  }

  _applyPosition() {
    if (!this.element) return;
    const { x, y } = this._state;
    if (x === null || y === null) {
      this.element.style.left = '50%';
      this.element.style.top = '4rem';
      this.element.style.transform = 'translateX(-50%)';
    } else {
      const w = this.element.offsetWidth || 320;
      const h = this.element.offsetHeight || 72;
      const cx = Math.max(0, Math.min(x, window.innerWidth - w));
      const cy = Math.max(0, Math.min(y, window.innerHeight - h));
      this.element.style.left = `${cx}px`;
      this.element.style.top = `${cy}px`;
      this.element.style.transform = 'none';
    }
  }

  _wireEvents() {
    this.element.querySelector('.im-meta')?.addEventListener('pointerdown', this._onPointerDown.bind(this));
    this.element.querySelector('.im-flip')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.flipOrientation();
    });
  }

  scheduleRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this.render();
    });
  }

  render() {
    if (!this.element || !game.combat?.started) return;
    const combat = game.combat;

    const roundEl = this.element.querySelector('.im-round-num');
    if (roundEl && !this._animLock) roundEl.textContent = `${combat.round ?? 0}`;

    const track = this.element.querySelector('.im-track');
    const controlsEl = this.element.querySelector('.im-controls');
    if (!track || !controlsEl) return;

    const { current, completed } = this._getDisplayParticipants();
    const activeId = combat.combatant?.id ?? null;

    const parts = [];
    parts.push(...current.map(p => this._renderCell(p, activeId)));
    parts.push(`<div class="im-divider" title="End of round"></div>`);
    parts.push(...completed.map(p => this._renderCell(p, activeId)));
    track.innerHTML = parts.join('');
    track.querySelectorAll('.im-cell').forEach(cell => this._wireCellEvents(cell));

    const activeData = [...current, ...completed].find(p => p.combatantId === activeId);
    const controlsHtml = activeData ? this._renderActiveControls(activeData) : '';
    controlsEl.innerHTML = controlsHtml;
    controlsEl.classList.toggle('is-empty', !controlsHtml);
    if (activeData) {
      controlsEl.querySelectorAll('.im-btn').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._onControl(btn.dataset.action, activeData.combatantId);
        });
      });
    }
  }

  _renderCell(p, activeId) {
    const classes = ['im-cell'];
    if (p.combatantId === activeId) classes.push('is-active');
    if (p.defeated) classes.push('is-defeated');
    if (p.hidden) classes.push('is-unseen');

    const img = p.hidden
      ? `<div class="im-img im-img-unknown"><i class="fa-solid fa-question"></i></div>`
      : `<div class="im-img" style="background-image:url('${p.image}')"></div>`;

    const name = `<span class="im-name">${p.displayName}</span>`;

    return `
      <div class="${classes.join(' ')}" data-combatant-id="${p.combatantId}" title="${p.tooltip}" role="listitem">
        ${img}
        ${name}
      </div>
    `;
  }

  _renderActiveControls(p) {
    const btns = [];
    if (p.canGmControl) {
      btns.push(`<button type="button" class="im-btn im-btn-prev" data-action="prev" title="Previous turn" aria-label="Previous turn"><i class="fa-solid fa-backward-step"></i></button>`);
    }
    if (p.canEndTurn) {
      btns.push(`<button type="button" class="im-btn im-btn-end" data-action="end" title="End turn" aria-label="End turn"><i class="fa-solid fa-flag-checkered"></i></button>`);
    }
    if (p.canDelay) {
      btns.push(`<button type="button" class="im-btn im-btn-delay" data-action="delay" title="Delay turn" aria-label="Delay turn"><i class="fa-solid fa-hourglass-half"></i></button>`);
    }
    if (p.canGmControl) {
      btns.push(`<button type="button" class="im-btn im-btn-next" data-action="next" title="Next turn" aria-label="Next turn"><i class="fa-solid fa-forward-step"></i></button>`);
    }
    return btns.join('');
  }

  _wireCellEvents(cell) {
    const combatantId = cell.dataset.combatantId;
    cell.addEventListener('mouseenter', () => this._onHover(combatantId, true));
    cell.addEventListener('mouseleave', () => this._onHover(combatantId, false));
  }

  _getDisplayParticipants() {
    const combat = game.combat;
    if (!combat) return { current: [], completed: [] };
    const isGM = game.user.isGM;

    const all = combat.turns.filter(c => c.initiative !== null && c.initiative !== undefined);
    const activeId = combat.combatant?.id ?? null;
    const activeIdx = activeId ? all.findIndex(c => c.id === activeId) : -1;

    const currentSlice = activeIdx >= 0 ? all.slice(activeIdx) : all;
    const completedSlice = activeIdx >= 0 ? all.slice(0, activeIdx) : [];

    const buildCell = (c) => {
      const tokenDoc = c.token;
      const placedToken = tokenDoc ? canvas.tokens?.get(tokenDoc.id) : null;
      const visibleOnCanvas = placedToken ? placedToken.visible : true;
      const unseen = !visibleOnCanvas && !isGM;

      const actor = c.actor;
      const nameRevealed = actor ? canSeeActorName(actor) : true;

      let displayName;
      let nameForTooltip;
      if (unseen) { displayName = '?'; nameForTooltip = 'Unknown'; }
      else if (!nameRevealed) { displayName = '???'; nameForTooltip = 'Unknown'; }
      else { displayName = c.name; nameForTooltip = c.name; }

      const initVal = (c.initiative === null || c.initiative === undefined) ? '?' : Math.floor(c.initiative);
      const tooltip = `Initiative ${initVal}: ${nameForTooltip}`;

      const image = tokenDoc?.texture?.src
        || tokenDoc?.img
        || actor?.img
        || 'icons/svg/mystery-man.svg';

      const isMyCombatant = !!c.actor?.isOwner;
      const isActive = activeId === c.id;

      return {
        combatantId: c.id,
        tokenId: tokenDoc?.id ?? null,
        displayName,
        tooltip,
        image,
        hidden: unseen,
        defeated: c.defeated === true,
        canGmControl: isGM,
        canEndTurn: isGM || (isMyCombatant && isActive),
        canDelay: !isGM && isMyCombatant && isActive
      };
    };

    return {
      current: currentSlice.map(buildCell),
      completed: completedSlice.map(buildCell)
    };
  }

  async _onControl(action, combatantId) {
    const combat = game.combat;
    if (!combat) return;
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) return;

    switch (action) {
      case 'prev':
        if (game.user.isGM) await combat.previousTurn();
        break;
      case 'next':
        if (game.user.isGM) await combat.nextTurn();
        break;
      case 'end':
        if (game.user.isGM || combatant.actor?.isOwner) await combat.nextTurn();
        break;
      case 'delay':
        await showDelayTurnDialog(combatant, combat);
        break;
    }
  }

  _onHover(combatantId, isHovering) {
    const combat = game.combat;
    if (!combat) return;
    const c = combat.combatants.get(combatantId);
    if (!c?.token) return;
    const placed = canvas.tokens?.get(c.token.id);
    if (!placed || !placed.visible) return;
    if (isHovering) placed._onHoverIn(new PointerEvent('pointerenter'), { hoverOutOthers: false });
    else placed._onHoverOut(new PointerEvent('pointerleave'));
  }

  _onPointerDown(ev) {
    if (ev.target.closest('button')) return;
    if (ev.button !== 0) return;
    this._startDrag(ev);
  }

  _startDrag(ev) {
    if (!this.element) return;
    ev.preventDefault();
    const rect = this.element.getBoundingClientRect();
    this.element.style.left = `${rect.left}px`;
    this.element.style.top = `${rect.top}px`;
    this.element.style.transform = 'none';
    this._dragOrigin = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    this._boundDragMove = this._onDragMove.bind(this);
    this._boundDragEnd = this._onDragEnd.bind(this);
    window.addEventListener('pointermove', this._boundDragMove);
    window.addEventListener('pointerup', this._boundDragEnd);
    this.element.classList.add('is-dragging');
  }

  _onDragMove(ev) {
    if (!this.element || !this._dragOrigin) return;
    const w = this.element.offsetWidth;
    const h = this.element.offsetHeight;
    const cx = Math.max(0, Math.min(ev.clientX - this._dragOrigin.x, window.innerWidth - w));
    const cy = Math.max(0, Math.min(ev.clientY - this._dragOrigin.y, window.innerHeight - h));
    this.element.style.left = `${cx}px`;
    this.element.style.top = `${cy}px`;
    this._state.x = cx;
    this._state.y = cy;
  }

  _onDragEnd() {
    window.removeEventListener('pointermove', this._boundDragMove);
    window.removeEventListener('pointerup', this._boundDragEnd);
    this._dragOrigin = null;
    if (this.element) this.element.classList.remove('is-dragging');
    this._saveState();
  }

  flipOrientation() {
    if (!this.element) return;
    const next = this._state.orientation === 'horizontal' ? 'vertical' : 'horizontal';
    this._state.orientation = next;
    this.element.classList.remove('is-horizontal', 'is-vertical');
    this.element.classList.add(`is-${next}`);
    this._saveState();
    this.scheduleRender();
  }

  async _animateTurnAdvance(forward) {
    if (this._animLock || !this.element) {
      this.scheduleRender();
      return;
    }
    this._animLock = true;
    const track = this.element.querySelector('.im-track');

    if (forward) {
      const oldActive = track?.querySelector('.im-cell.is-active');
      if (oldActive) {
        oldActive.classList.add('is-poofing-forward');
        await wait(POOF_MS);
      }
    }

    this.render();

    const newActive = track?.querySelector('.im-cell.is-active');
    if (newActive) {
      newActive.classList.add(forward ? 'is-arriving-forward' : 'is-arriving-back');
      await wait(SLIDE_MS);
      newActive.classList.remove('is-arriving-forward', 'is-arriving-back');
    }
    this._animLock = false;
  }

  async _animateRoundChange(prevRound, newRound, forward) {
    const wrap = this.element?.querySelector('.im-round');
    const num = this.element?.querySelector('.im-round-num');
    if (!wrap || !num) return;
    this._animLock = true;
    num.textContent = `${prevRound}`;
    wrap.classList.add(forward ? 'is-round-out-fwd' : 'is-round-out-back');
    await wait(ROUND_FADE_MS);
    num.textContent = `${newRound}`;
    wrap.classList.remove('is-round-out-fwd', 'is-round-out-back');
    wrap.classList.add(forward ? 'is-round-in-fwd' : 'is-round-in-back');
    await wait(ROUND_FADE_MS);
    wrap.classList.remove('is-round-in-fwd', 'is-round-in-back');
    this._animLock = false;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const instance = new InitiativeModal();

export function initInitiativeModal() {
  instance.init();
  log('Initiative modal initialized');
}

export function toggleInitiativeModal() {
  instance.toggle();
}

export function getInitiativeModal() {
  return instance;
}
