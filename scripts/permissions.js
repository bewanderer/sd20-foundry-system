import { CONFIG } from './config.js';

const MODULE = CONFIG.MODULE_ID;

export function canEditActor(actor) {
  if (!actor) return false;
  return game.user.isGM || actor.isOwner;
}

export function canSeeActorName(actor) {
  if (!actor) return false;
  if (game.user.isGM) return true;
  if (actor.isOwner) return true;
  return actor.getFlag(MODULE, 'nameRevealed') === true;
}

export function maskedActorName(actor) {
  return canSeeActorName(actor) ? actor.name : '???';
}

export function postMaskedChat(actor, buildContent) {
  if (canSeeActorName(actor)) {
    ChatMessage.create({
      content: buildContent(actor.name),
      speaker: { alias: actor.name }
    });
    return;
  }
  const ownerIds = Object.entries(actor.ownership || {})
    .filter(([id, level]) => id !== 'default' && level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
    .map(([id]) => id);
  const insiders = [...new Set([...ownerIds, ...game.users.filter(u => u.isGM).map(u => u.id)])];
  const outsiders = game.users.map(u => u.id).filter(id => !insiders.includes(id));

  if (insiders.length > 0) {
    ChatMessage.create({
      content: buildContent(actor.name),
      speaker: { alias: actor.name },
      whisper: insiders
    });
  }
  if (outsiders.length > 0) {
    ChatMessage.create({
      content: buildContent('???'),
      speaker: { alias: '???' },
      whisper: outsiders
    });
  }
}
