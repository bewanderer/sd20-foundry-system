# Souls D20 - Foundry VTT System

**A full-system tabletop RPG inspired by Elden Ring and Soulsborne games.**

> This is a **beta release (v0.9.0)**. Expect rough edges and ongoing improvements. Feedback and bug reports are welcome on our Discord!

[![Discord](https://img.shields.io/badge/Discord-Join%20Us-5865F2?logo=discord&logoColor=white)](https://discord.gg/ruckQQxp)

---

## What is Souls D20?

Souls D20 is a tabletop RPG system built from the ground up. It brings the strategic, high-stakes combat of Soulsborne games to the tabletop with deep character customization, weapon proficiency trees, destined traits, and a dynamic combat system.

## Character App (Required)

Souls D20 pairs with the **SD20 Character App** - a web-based companion for character creation and management.

**Character App:** [soulsd20-character-app.vercel.app](https://soulsd20-character-app.vercel.app)

The Character App handles:
- Character creation (backgrounds, lineages, bloodlines, stat allocation)
- Level-up progression (stat increases, knowledge skills, weapon proficiency trees)
- Spell, spirit, and weapon skill management
- Equipment and inventory tracking
- Real-time sync with Foundry during game sessions
- Notes, Combat information and much more

Characters created in the app sync directly to Foundry tokens, keeping stats, equipment, and resources up to date in real time. The Character App and Foundry must be open in the same browser at this stage of development!

## Features

- **Strategic Combat** - Action Point based combat with a reaction based system so you can influence the flow of battle even outside of your own turn
- **Weapon Proficiency Trees** - 23 weapon categories with unlockable feats at milestone levels
- **Destiny Traits** - Character-defining abilities obtained with Fate Points
- **Spell & Spirit System** - Learn, attune, and cast spells, weapon skills or summon spirits
- **Custom Macro System** - Build macros for attacks, spells, and abilities with automatic damage calculation & dynamic targeting
- **Animation Support** - Spell and attack animations via JB2A integration
- **Damage Pipeline** - Full damage calculation with scaling, resistances, and modifier support
- **Combat Tracker** - Turn management with AP tracking, status effects, and poise
- **Real-Time Sync** - Character data flows between the Character App and Foundry

## Requirements

- **Foundry VTT** v11 or later (verified on v13)
- **SD20 Character App** - [soulsd20-character-app.vercel.app](https://soulsd20-character-app.vercel.app)

## Recommended Modules

These modules are optional but enhance the experience:

| Module | What it adds |
|--------|-------------|
| **Sequencer** | Enables spell and ability animations |
| **JB2A - Jules & Ben's Animated Assets** | Animation library for spells, attacks, and effects |
| **socketlib** | Allows players to sync character data with their own tokens |

Install these from Foundry's built-in module browser.

## Installation

1. Open Foundry VTT setup screen
2. Go to **Game Systems** > **Install System**
3. Search for **"Souls D20"** or paste the manifest URL:
   ```
   https://raw.githubusercontent.com/bewanderer/sd20-foundry-system/main/system.json
   ```
4. Click **Install**
5. Create a new world using the Souls D20 system

## Getting Started

1. Create an account on the [Character App](https://soulsd20-character-app.vercel.app)
2. Create your character (choose background, lineage, allocate stats)
3. Complete the mandatory Level 1 level-up
4. Open Foundry and create a world with the Souls D20 system
5. Create an actor, place a token on the scene
6. Link your character to the token using one of these methods:
   - Right-click the token > Token Config > SD20 tab > Link to Character
   - Or click the token and use the chain icon button below the macro bar
7. Your character data syncs automatically

## Questions & Feedback

Join our Discord for help, bug reports, and discussion:

**[discord.gg/ruckQQxp](https://discord.gg/ruckQQxp)**

---

*Souls D20 is a standalone system. It is not affiliated with or endorsed by FromSoftware or Bandai Namco.*
