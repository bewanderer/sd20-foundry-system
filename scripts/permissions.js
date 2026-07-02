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
  if (actor.getFlag(MODULE, 'nameRevealed') === true) return true;
  // For unlinked NPC tokens combatSettings writes the flag into the token's
  // delta. The synthetic actor's getFlag is supposed to merge that delta in,
  // but in some Foundry V13 builds the merge does not surface the delta value
  // for this specific flag. Read the delta directly as a second check so the
  // toggle reliably reveals the name for macros and status chat alike.
  const tokenDoc = actor.token;
  if (tokenDoc?.delta) {
    const deltaFlag = foundry.utils.getProperty(tokenDoc.delta, `flags.${MODULE}.nameRevealed`);
    if (deltaFlag === true) return true;
  }
  return false;
}

export function maskedActorName(actor) {
  return canSeeActorName(actor) ? actor.name : '???';
}

// Single public message with a placeholder span the render hook in souls-d20.js
// rewrites per viewer. The span carries the actor's UUID so the hook resolves
// to the same actor instance the toggle was set on - including the synthetic
// actor for unlinked NPC tokens where nameRevealed lives in the token delta,
// not on the base actor. We also embed token + scene IDs on the speaker so
// the hook can find the synthetic actor for the speaker header too (without
// those, the hook falls back to game.actors.get which never sees the delta).
export function postMaskedChat(actor, buildContent, options = {}) {
  if (!actor) return;
  const tagged = `<span data-mask-actor="${actor.uuid}">${actor.name}</span>`;
  const content = buildContent(tagged);

  let speaker = options.speaker;
  if (!speaker) {
    speaker = { alias: actor.name, actor: actor.id };
    const tokenDoc = actor.token;
    if (tokenDoc) {
      speaker.token = tokenDoc.id;
      speaker.scene = tokenDoc.parent?.id;
    }
  }

  const messageData = { content, speaker };

  // Bug 15: whisper mode for monster recovery chat. Only GMs and the actor's
  // owners see the message. Other players see nothing at all. Passed by
  // combatTracker.applyPassiveRegeneration; other callers stay public-masked.
  if (options.whisperToOwner) {
    const recipients = new Set();
    for (const user of game.users) {
      if (user.isGM) {
        recipients.add(user.id);
        continue;
      }
      try {
        if (actor.testUserPermission(user, 'OWNER')) {
          recipients.add(user.id);
        }
      } catch { /* skip */ }
    }
    messageData.whisper = Array.from(recipients);
    messageData.rollMode = 'gmroll';
  }

  return ChatMessage.create(messageData);
}
