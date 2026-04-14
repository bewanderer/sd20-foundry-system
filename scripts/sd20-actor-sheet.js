// Minimal SD20 Actor Sheet - character data is managed in the SD20 App

import { openCombatSettings } from './combatSettings.js';
import { openPresetSelector } from './monsterPresets.js';

const { HandlebarsApplicationMixin } = foundry.applications.api;
const ActorSheetV2 = foundry.applications.sheets.ActorSheetV2;

export class SD20ActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  static DEFAULT_OPTIONS = {
    classes: ['sd20', 'sheet', 'actor'],
    position: {
      width: 400,
      height: 300
    },
    window: {
      resizable: true
    },
    actions: {
      openCombatSettings: SD20ActorSheet.#onOpenCombatSettings,
      openAllMacros: SD20ActorSheet.#onOpenAllMacros,
      openMonsterPresets: SD20ActorSheet.#onOpenMonsterPresets
    }
  };

  static PARTS = {
    body: {
      template: 'systems/souls-d20/templates/actor-sheet.html'
    }
  };

  static #onOpenCombatSettings() {
    // Accessible to GM or actor owner
    if (game.user.isGM || this.actor.isOwner) {
      openCombatSettings(this.actor);
    } else {
      ui.notifications.warn('You do not have permission to access Combat Settings');
    }
  }

  static #onOpenAllMacros() {
    // Accessible to GM or actor owner
    if (game.user.isGM || this.actor.isOwner) {
      if (game.sd20?.openAllMacrosManager) {
        game.sd20.openAllMacrosManager(this.actor);
      } else {
        ui.notifications.error('All Macros Manager not available');
      }
    } else {
      ui.notifications.warn('You do not have permission to access All Macros');
    }
  }

  static #onOpenMonsterPresets() {
    if (this.actor.type !== 'npc') {
      ui.notifications.warn('Monster presets are only available for NPC actors');
      return;
    }
    if (game.user.isGM || this.actor.isOwner) {
      openPresetSelector(this.actor);
    } else {
      ui.notifications.warn('You do not have permission to access Monster Presets');
    }
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.system = this.actor.system;
    context.actor = this.actor;
    context.isNPC = this.actor.type === 'npc';
    return context;
  }
}