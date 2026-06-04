import { CONFIG } from './config.js';
import { debug, warn, log } from './utils.js';
import { postMaskedChat, canSeeActorName } from './permissions.js';

const { DialogV2 } = foundry.applications.api;

function maskedCombatantName(c) {
  if (!c?.actor) return c?.name ?? '???';
  return canSeeActorName(c.actor) ? c.name : '???';
}

export async function showDelayTurnDialog(combatant, combat) {
  const validPositions = getValidDelayPositions(combatant, combat);

  if (validPositions.length === 0) {
    ui.notifications.warn('No valid delay positions available');
    return;
  }

  const optionsHtml = validPositions.map((pos, i) => `
    <label class="delay-option">
      <input type="radio" name="delayInit" value="${pos.initiative}" ${i === 0 ? 'checked' : ''} />
      <span class="delay-initiative">${pos.displayInit}</span>
      <span class="delay-label">${pos.label}</span>
    </label>
  `).join('');

  const content = `
    <div class="sd20-delay-dialog">
      <p>Delay to initiative (you act last at chosen value):</p>
      <div class="delay-options">
        ${optionsHtml}
      </div>
    </div>
  `;

  const result = await DialogV2.confirm({
    window: { title: 'Delay Turn' },
    content,
    yes: {
      label: 'Confirm Delay',
      icon: 'fa-solid fa-check',
      callback: (_event, button) => {
        const form = button.closest('.dialog-form, .window-content, .application');
        const checked = form?.querySelector('input[name="delayInit"]:checked');
        return checked ? parseFloat(checked.value) : null;
      }
    },
    no: {
      label: 'Cancel',
      icon: 'fa-solid fa-times'
    }
  });

  if (result !== null && result !== undefined && result !== false) {
    await executeDelayTurn(combatant, combat, result);
  }
}

export function getValidDelayPositions(delayingCombatant, combat) {
  const positions = [];
  const sortedCombatants = combat.turns;
  const currentInit = delayingCombatant.initiative;
  const seenInitiatives = new Set();

  for (const c of sortedCombatants) {
    if (c.id === delayingCombatant.id) continue;
    if (c.initiative === null || c.initiative === undefined) continue;
    const init = Math.floor(c.initiative);
    if (init >= currentInit) continue;
    if (seenInitiatives.has(init)) continue;
    seenInitiatives.add(init);

    const atThisInit = sortedCombatants.filter(
      x => x.id !== delayingCombatant.id &&
           Math.floor(x.initiative) === init
    );
    const names = atThisInit.map(maskedCombatantName).join(', ');

    positions.push({
      initiative: init,
      displayInit: init,
      label: `After ${names}`
    });
  }

  if (currentInit > 0 && !seenInitiatives.has(0)) {
    positions.push({
      initiative: 0,
      displayInit: 0,
      label: 'Dead last (initiative 0)'
    });
  }

  positions.sort((a, b) => b.initiative - a.initiative);
  return positions;
}

export async function executeDelayTurn(combatant, combat, newInitiative) {
  const displayInit = Math.max(0, Math.ceil(newInitiative));

  game.socket.emit(`system.${CONFIG.MODULE_ID}`, {
    type: 'delayTurn',
    combatId: combat.id,
    combatantId: combatant.id,
    newInitiative
  });

  debug(`Sent delay request for ${combatant.name} to initiative ${newInitiative}`);
  ui.notifications.info(`${combatant.name} delayed to initiative ${displayInit}`);
}

export async function gmExecuteDelay(data, requesterId) {
  const combat = game.combats.get(data.combatId);
  const combatant = combat?.combatants.get(data.combatantId);
  if (!combat || !combatant) {
    log('Delay turn: combat or combatant not found', data);
    return;
  }

  if (requesterId && requesterId !== game.user.id) {
    const requester = game.users.get(requesterId);
    const isRequesterGM = !!requester?.isGM;
    const requesterOwns = combatant.actor?.testUserPermission(requester, 'OWNER');
    if (!isRequesterGM && !requesterOwns) {
      warn(`Rejected delayTurn from user ${requesterId} for combatant ${combatant.name} (not owner)`);
      return;
    }
  }

  const originalInit = combatant.initiative;
  const existingOriginal = combatant.getFlag(CONFIG.MODULE_ID, 'originalInitiative');
  if (existingOriginal === undefined) {
    await combatant.setFlag(CONFIG.MODULE_ID, 'originalInitiative', originalInit);
  }

  const currentTurnIndex = combat.turn;
  const nextCombatant = combat.turns[currentTurnIndex + 1] || combat.turns[0];
  const nextCombatantId = nextCombatant?.id;

  await combatant.update({
    initiative: data.newInitiative,
    [`flags.${CONFIG.MODULE_ID}.delayed`]: true
  });

  let newTurnIndex = combat.turns.findIndex(c => c.id === nextCombatantId);
  if (newTurnIndex === -1) newTurnIndex = 0;
  await combat.update({ turn: newTurnIndex });

  debug(`GM executed delay: ${combatant.name} from ${originalInit} to ${data.newInitiative}`);

  if (combatant.actor) {
    postMaskedChat(combatant.actor, (displayName) =>
      `<strong>${displayName}</strong> delays their turn to initiative ${data.newInitiative}.`
    );
  }
}
