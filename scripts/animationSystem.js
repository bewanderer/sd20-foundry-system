/**
 * Animation System
 * Handles visual animation playback for macros and status effects.
 * Requires Sequencer module and optionally JB2A for animation assets.
 *
 * This system is entirely optional - gameplay functions without it.
 * All animation calls gracefully fail if modules aren't installed.
 */

import { log, debug } from './utils.js';
import { STATUS_ANIMATIONS } from './animationConfig.js';

// ============================================================
// MODULE DETECTION
// ============================================================

/**
 * Check if Sequencer module is installed and active
 * @returns {boolean}
 */
export function isSequencerAvailable() {
  return game.modules.get('sequencer')?.active === true;
}

/**
 * Check if JB2A is installed (either free or patreon version)
 * @returns {boolean}
 */
export function isJB2AAvailable() {
  return game.modules.get('jb2a_patreon')?.active === true ||
         game.modules.get('JB2A_DnD5e')?.active === true;
}

/**
 * Check if animation system is fully available and enabled
 * @returns {boolean}
 */
export function isAnimationSystemAvailable() {
  if (!isSequencerAvailable()) return false;

  // Check user setting (will be registered in init)
  try {
    return game.settings.get('souls-d20', 'enableAnimations') !== false;
  } catch {
    // Setting not registered yet, default to true
    return true;
  }
}

/**
 * Get animation speed multiplier from settings
 * @returns {number}
 */
function getAnimationSpeed() {
  try {
    return game.settings.get('souls-d20', 'animationSpeed') || 1.0;
  } catch {
    return 1.0;
  }
}

// ============================================================
// ANIMATION DATABASE HELPERS
// ============================================================

/**
 * Check if an animation file exists in Sequencer database
 * @param {string} file - Animation database key (e.g., "jb2a.fire_bolt.orange")
 * @returns {boolean}
 */
export function animationExists(file) {
  if (!isSequencerAvailable() || !file) return false;

  try {
    return Sequencer.Database.entryExists(file);
  } catch {
    return false;
  }
}

// Cache for available animations (expensive to build)
let _animationCache = null;
let _animationCacheTime = 0;
const ANIMATION_CACHE_DURATION = 300000; // 5 minutes (expensive operation)

/**
 * Get all available animations from Sequencer database
 * Uses Sequencer's getAllFileEntries for efficient retrieval
 * @param {string} [prefix='jb2a'] - Database prefix to filter by
 * @returns {Array<{key: string, label: string}>}
 */
export function getAvailableAnimations(prefix = 'jb2a') {
  if (!isSequencerAvailable()) return [];

  // Return cached result if still valid
  const now = Date.now();
  if (_animationCache && (now - _animationCacheTime) < ANIMATION_CACHE_DURATION) {
    return _animationCache;
  }

  try {
    let allPaths = [];

    // Use Sequencer's flattenedEntries - it's an array of path strings
    if (Sequencer.Database.flattenedEntries) {
      const entriesArray = Array.from(Sequencer.Database.flattenedEntries);

      // Filter to entries starting with the system prefix (typically 'jb2a.')
      allPaths = entriesArray
        .filter(e => typeof e === 'string' && e.startsWith(prefix + '.'));
    }

    _animationCache = allPaths.map(path => ({
      key: path,
      label: formatAnimationLabel(path)
    }));
    _animationCacheTime = now;

    log(`Cached ${_animationCache.length} animation paths`);
    return _animationCache;
  } catch (err) {
    console.warn('SD20: Failed to get animations from database', err);
    return [];
  }
}

/**
 * Format animation database key for display
 * @param {string} key - Database key (e.g., "jb2a.fire_bolt.orange")
 * @returns {string} Formatted label (e.g., "Fire Bolt - Orange")
 */
export function formatAnimationLabel(key) {
  if (!key) return '';

  const parts = key.split('.');
  // Remove 'jb2a' prefix if present
  if (parts[0] === 'jb2a') parts.shift();

  return parts
    .map(p => p.replace(/_/g, ' '))
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' - ');
}

/**
 * Resolve animation database key to actual file path
 * @param {string} databaseKey - Animation database key
 * @returns {string|null} File path or null if not found
 */
export function resolveAnimationPath(databaseKey) {
  if (!isSequencerAvailable() || !databaseKey) return null;

  try {
    const entry = Sequencer.Database.getEntry(databaseKey);
    return entry?.file || null;
  } catch {
    return null;
  }
}

// ============================================================
// CORE PLAYBACK FUNCTIONS
// ============================================================

/**
 * Play a status effect animation on a token
 * @param {Token} token - Token to play animation on
 * @param {string} conditionName - Condition name (e.g., "BledOut", "Poisoned")
 * @param {boolean} [isTick=false] - Is this a DoT tick animation (turn start)
 * @returns {Promise<void>}
 */
export async function playStatusAnimation(token, conditionName, isTick = false) {
  if (!isAnimationSystemAvailable()) return;
  if (!token) return;

  const key = isTick ? `${conditionName}Tick` : conditionName;
  const config = STATUS_ANIMATIONS[key];

  if (!config?.file) {
    debug(`No animation configured for status: ${key}`);
    return;
  }

  // Check if animation file exists
  if (!animationExists(config.file)) {
    console.warn(`SD20: Animation not found: ${config.file}`);
    return;
  }

  try {
    const seq = new Sequence();

    seq.effect()
       .file(config.file)
       .atLocation(token)
       .scaleToObject(config.scale || 1.0)
       .belowTokens(config.belowToken || false);

    await seq.play();
    debug(`Played status animation: ${key} on ${token.name}`);
  } catch (err) {
    console.warn(`SD20: Status animation failed for ${conditionName}`, err);
  }
}

/**
 * Play multiple status tick animations rapidly (all within duration of one animation)
 * Used for DoT ticks and staunch bleeding - plays all animations simultaneously
 * @param {Token} token - Token to play animations on
 * @param {string[]} conditionNames - Array of condition names (e.g., ["Poisoned", "BadlyPoisoned"])
 * @returns {Promise<void>}
 */
export async function playRapidStatusAnimations(token, conditionNames) {
  if (!isAnimationSystemAvailable()) return;
  if (!token || !conditionNames?.length) return;

  // Collect valid animations
  const animations = [];
  for (const conditionName of conditionNames) {
    const key = `${conditionName}Tick`;
    const config = STATUS_ANIMATIONS[key];

    if (!config?.file) {
      debug(`No tick animation configured for: ${key}`);
      continue;
    }

    if (!animationExists(config.file)) {
      console.warn(`SD20: Animation not found: ${config.file}`);
      continue;
    }

    animations.push({ key, config });
  }

  if (animations.length === 0) return;

  try {
    const seq = new Sequence();

    // Play all animations simultaneously (no waitUntilFinished between them)
    for (const { config } of animations) {
      seq.effect()
         .file(config.file)
         .atLocation(token)
         .scaleToObject(config.scale || 1.0)
         .belowTokens(config.belowToken || false);
    }

    await seq.play();
    debug(`Played ${animations.length} rapid status animations on ${token.name}: ${animations.map(a => a.key).join(', ')}`);
  } catch (err) {
    console.warn('SD20: Rapid status animation failed', err);
  }
}

/**
 * Get location info string for debug logging
 * @private
 */
function _getLocationInfo(obj) {
  if (!obj) return 'null';
  if (obj.x !== undefined && obj.y !== undefined) {
    // Raw coordinates or PlaceableObject
    const x = obj.x ?? obj.document?.x ?? obj.center?.x;
    const y = obj.y ?? obj.document?.y ?? obj.center?.y;
    const name = obj.name || obj.document?.name || 'point';
    return `${name} @ (${Math.round(x)}, ${Math.round(y)})`;
  }
  return String(obj);
}

/**
 * Get grid cell info from pixel coordinates
 * @private
 */
function _getGridCellInfo(x, y) {
  if (!canvas.grid) return '';
  try {
    const offset = canvas.grid.getOffset({ x, y });
    return `[grid: row=${offset.i}, col=${offset.j}]`;
  } catch {
    return '';
  }
}

/**
 * Play macro animation sequence
 * Sequencing order: Cast → wait → Projectile/Impact (per target) → wait → Area
 * @param {Object} options - Animation options
 * @param {Token} options.caster - Caster token
 * @param {Token[]} [options.targets=[]] - Target tokens
 * @param {MeasuredTemplate} [options.template] - AoE template (if applicable)
 * @param {Object} options.animConfig - Animation configuration from macro
 * @param {boolean} [options.isHidden=false] - Is the template hidden from players
 * @param {Object} [options.gridTarget=null] - Grid target point {x, y} for non-targeting macros
 * @param {number} [options.exclusionRadius=0] - Inner radius to exclude from AoE (in grid units/ft)
 * @returns {Promise<void>}
 */
export async function playMacroAnimation({ caster, targets = [], template, animConfig, isHidden = false, gridTarget = null, exclusionRadius = 0 }) {
  if (!isAnimationSystemAvailable()) {
    debug('Animation system not available, skipping');
    return;
  }
  if (!animConfig?.enabled) {
    debug('Animation not enabled in config, skipping');
    return;
  }
  if (!caster) {
    debug('No caster token provided, skipping animation');
    return;
  }

  // Hidden templates = hidden animations for non-GM
  if (isHidden && !game.user.isGM) {
    debug('Hidden template animation, non-GM user, skipping');
    return;
  }

  const speed = getAnimationSpeed();
  const casterPos = caster.center || { x: caster.x, y: caster.y };

  // For AoE attacks, determine the projectile origin (template origin, not caster)
  // This is where projectiles should originate from for AoE spells
  const templateOrigin = template ? { x: template.x, y: template.y } : null;

  // Detailed debug logging
  debug('═══════════════════════════════════════════════════════');
  debug('ANIMATION PLAYBACK START');
  debug(`  Caster: ${_getLocationInfo(caster)} ${_getGridCellInfo(casterPos.x, casterPos.y)}`);
  debug(`  Speed multiplier: ${speed}`);
  debug(`  Targets: ${targets.length}`);
  targets.forEach((t, i) => {
    const pos = t.center || { x: t.x, y: t.y };
    debug(`    [${i}] ${_getLocationInfo(t)} ${_getGridCellInfo(pos.x, pos.y)}`);
  });
  if (template) {
    debug(`  Template: ${template.document?.t || 'unknown'} @ (${Math.round(template.x)}, ${Math.round(template.y)}) ${_getGridCellInfo(template.x, template.y)}`);
    debug(`    Distance: ${template.document?.distance || 0}, Direction: ${template.document?.direction || 0}`);
    debug(`  Projectile origin: template @ (${Math.round(templateOrigin.x)}, ${Math.round(templateOrigin.y)})`);
  } else {
    debug(`  Projectile origin: caster @ (${Math.round(casterPos.x)}, ${Math.round(casterPos.y)})`);
  }
  if (gridTarget) {
    debug(`  Grid target: (${Math.round(gridTarget.x)}, ${Math.round(gridTarget.y)}) ${_getGridCellInfo(gridTarget.x, gridTarget.y)}`);
  }
  if (exclusionRadius > 0) {
    debug(`  Exclusion radius: ${exclusionRadius} ft`);
  }
  debug(`  Animation config:`);
  debug(`    Cast: ${animConfig.cast?.file || 'none'} (scale: ${animConfig.cast?.scale || 1.0}, duration: ${animConfig.cast?.duration || 'auto'})`);
  debug(`    Projectile: ${animConfig.projectile?.file || 'none'} (scale: ${animConfig.projectile?.scale || 1.0}, duration: ${animConfig.projectile?.duration || 'auto'})`);
  debug(`    Impact: ${animConfig.impact?.file || 'none'} (scale: ${animConfig.impact?.scale || 1.0}, duration: ${animConfig.impact?.duration || 'auto'})`);
  debug(`    Area: ${animConfig.area?.file || 'none'} (scale: ${animConfig.area?.scale || 1.0}, duration: ${animConfig.area?.duration || 'auto'})`);
  debug('───────────────────────────────────────────────────────');

  // Animation overlap: very tight for seamless transitions
  // Negative value = start next animation before current finishes
  const OVERLAP_MS = -100; // Tighter overlap for smoother flow

  // Check for simultaneous mode
  const simultaneousProjectile = animConfig.projectile?.simultaneous || false;
  const simultaneousImpact = animConfig.impact?.simultaneous || false;

  try {
    const seq = new Sequence();
    let hasAddedEffect = false;
    let lastEffect = null;

    // PHASE 1: Cast animation (on caster)
    if (animConfig.cast?.file && animationExists(animConfig.cast.file)) {
      debug(`[CAST] Playing: ${animConfig.cast.file} at caster`);
      lastEffect = seq.effect()
         .file(animConfig.cast.file)
         .atLocation(caster)
         .scaleToObject(animConfig.cast.scale || 1.0)
         .playbackRate(speed);

      // Apply duration if specified
      if (animConfig.cast.duration && Number(animConfig.cast.duration) > 0) {
        lastEffect.duration(Number(animConfig.cast.duration));
        debug(`[CAST] Duration set to ${animConfig.cast.duration}ms`);
      }

      hasAddedEffect = true;

      // Wait for cast to finish before next phase
      const hasNextPhase = animConfig.projectile?.file || animConfig.impact?.file || animConfig.area?.file || targets.length > 0 || gridTarget || template;
      if (hasNextPhase) {
        lastEffect.waitUntilFinished(OVERLAP_MS);
        debug(`[CAST] Waiting with ${OVERLAP_MS}ms overlap before next phase`);
      }
    }

    // PHASE 2: Projectile + Impact (per target or to grid target/template)
    const hasProjectile = animConfig.projectile?.file && animationExists(animConfig.projectile.file);
    const hasImpact = animConfig.impact?.file && animationExists(animConfig.impact.file);

    // Filter targets by exclusion radius
    let validTargets = targets;
    if (exclusionRadius > 0 && templateOrigin && targets.length > 0) {
      const exclusionPx = exclusionRadius * (canvas.dimensions?.distancePixels || 1);
      validTargets = targets.filter(target => {
        const targetPos = target.center || { x: target.x, y: target.y };
        const dist = Math.hypot(targetPos.x - templateOrigin.x, targetPos.y - templateOrigin.y);
        if (dist < exclusionPx) {
          debug(`[TARGETS] Skipping target ${target.name} - within exclusion radius (dist: ${Math.round(dist)}px, exclusion: ${Math.round(exclusionPx)}px)`);
          return false;
        }
        return true;
      });
    }

    if (validTargets.length > 0 && (hasProjectile || hasImpact)) {
      // Target-based animations
      // Projectile ALWAYS plays before Impact
      // Each phase has its own simultaneous setting:
      // - Simultaneous: all animations play at once
      // - Sequential: animations play one after another
      debug(`[TARGETS] Processing ${validTargets.length} targets`);
      debug(`  Projectile mode: ${simultaneousProjectile ? 'simultaneous' : 'sequential'}`);
      debug(`  Impact mode: ${simultaneousImpact ? 'simultaneous' : 'sequential'}`);

      const origin = template ? templateOrigin : caster;

      // PHASE: Projectiles (always before impacts)
      if (hasProjectile) {
        if (simultaneousProjectile) {
          // All projectiles fire at once
          debug(`[PROJECTILE] Playing ${validTargets.length} projectiles simultaneously`);
          for (let i = 0; i < validTargets.length; i++) {
            const target = validTargets[i];
            const effect = seq.effect()
               .file(animConfig.projectile.file)
               .atLocation(origin)
               .stretchTo(target)
               .scale(animConfig.projectile.scale || 1.0)
               .playbackRate(speed);

            if (animConfig.projectile.duration && Number(animConfig.projectile.duration) > 0) {
              effect.duration(Number(animConfig.projectile.duration));
            }

            lastEffect = effect;
            hasAddedEffect = true;
          }
        } else {
          // Projectiles fire one after another (sequential)
          debug(`[PROJECTILE] Playing ${validTargets.length} projectiles sequentially`);
          for (let i = 0; i < validTargets.length; i++) {
            const target = validTargets[i];
            const effect = seq.effect()
               .file(animConfig.projectile.file)
               .atLocation(origin)
               .stretchTo(target)
               .scale(animConfig.projectile.scale || 1.0)
               .playbackRate(speed);

            if (animConfig.projectile.duration && Number(animConfig.projectile.duration) > 0) {
              effect.duration(Number(animConfig.projectile.duration));
            }

            // Wait between sequential projectiles (except last one if impacts follow)
            if (i < validTargets.length - 1) {
              effect.waitUntilFinished(OVERLAP_MS);
            }

            lastEffect = effect;
            hasAddedEffect = true;
          }
        }

        // Wait for projectile phase to complete before impact phase
        if (hasImpact && lastEffect) {
          lastEffect.waitUntilFinished(OVERLAP_MS);
        }
      }

      // PHASE: Impacts (always after projectiles)
      if (hasImpact) {
        if (simultaneousImpact) {
          // All impacts play at once
          debug(`[IMPACT] Playing ${validTargets.length} impacts simultaneously`);
          for (let i = 0; i < validTargets.length; i++) {
            const target = validTargets[i];
            const effect = seq.effect()
               .file(animConfig.impact.file)
               .atLocation(target)
               .scaleToObject(animConfig.impact.scale || 1.0)
               .playbackRate(speed);

            if (animConfig.impact.duration && Number(animConfig.impact.duration) > 0) {
              effect.duration(Number(animConfig.impact.duration));
            }

            lastEffect = effect;
            hasAddedEffect = true;
          }
        } else {
          // Impacts play one after another (sequential)
          debug(`[IMPACT] Playing ${validTargets.length} impacts sequentially`);
          for (let i = 0; i < validTargets.length; i++) {
            const target = validTargets[i];
            const effect = seq.effect()
               .file(animConfig.impact.file)
               .atLocation(target)
               .scaleToObject(animConfig.impact.scale || 1.0)
               .playbackRate(speed);

            if (animConfig.impact.duration && Number(animConfig.impact.duration) > 0) {
              effect.duration(Number(animConfig.impact.duration));
            }

            // Wait between sequential impacts (except last one)
            if (i < validTargets.length - 1) {
              effect.waitUntilFinished(OVERLAP_MS);
            }

            lastEffect = effect;
            hasAddedEffect = true;
          }
        }
      }
    } else if (gridTarget && (hasProjectile || hasImpact)) {
      // Grid target (no targeting system, but user selected a location)
      debug(`[GRID TARGET] Using grid target at (${Math.round(gridTarget.x)}, ${Math.round(gridTarget.y)})`);

      if (hasProjectile) {
        debug(`[PROJECTILE] Playing: ${animConfig.projectile.file} from caster to grid target`);
        lastEffect = seq.effect()
           .file(animConfig.projectile.file)
           .atLocation(caster)
           .stretchTo(gridTarget)
           .scale(animConfig.projectile.scale || 1.0)
           .playbackRate(speed);

        if (animConfig.projectile.duration && Number(animConfig.projectile.duration) > 0) {
          lastEffect.duration(Number(animConfig.projectile.duration));
        }

        hasAddedEffect = true;

        if (hasImpact) {
          lastEffect.waitUntilFinished(OVERLAP_MS);
        }
      }

      if (hasImpact) {
        debug(`[IMPACT] Playing: ${animConfig.impact.file} at grid target`);
        lastEffect = seq.effect()
           .file(animConfig.impact.file)
           .atLocation(gridTarget)
           .scale(animConfig.impact.scale || 1.0)
           .playbackRate(speed);

        if (animConfig.impact.duration && Number(animConfig.impact.duration) > 0) {
          lastEffect.duration(Number(animConfig.impact.duration));
        }

        hasAddedEffect = true;
      }
    }

    // Wait before area animation if projectile/impact (95% overlap)
    if (hasAddedEffect && lastEffect && animConfig.area?.file) {
      lastEffect.waitUntilFinished(OVERLAP_MS);
      debug(`[SEQUENCE] Waiting with ${OVERLAP_MS}ms overlap before area animation`);
    }

    // PHASE 3: Area animation (on template or grid target)
    // Always plays from center regardless of exclusion zones
    if (animConfig.area?.file && animationExists(animConfig.area.file)) {
      const areaTarget = template || gridTarget;
      if (areaTarget) {
        // Get template position - handle both Document and PlaceableObject
        // MeasuredTemplateDocument has x/y directly, PlaceableObject has it in .document
        const templateX = template?.x ?? template?.document?.x ?? 0;
        const templateY = template?.y ?? template?.document?.y ?? 0;

        if (template) {
          // Use explicit coordinates from template center for reliable placement
          const areaPos = { x: templateX, y: templateY };
          debug(`[AREA] Playing: ${animConfig.area.file} at template center (${Math.round(templateX)}, ${Math.round(templateY)})`);

          const baseScale = animConfig.area.scale || 1.0;

          seq.effect()
             .file(animConfig.area.file)
             .atLocation(areaPos)
             .scale(baseScale)
             .playbackRate(speed);

          if (animConfig.area.duration && Number(animConfig.area.duration) > 0) {
            // Duration is handled by Sequencer automatically
          }

          hasAddedEffect = true;
        } else {
          // Grid target (no template)
          debug(`[AREA] Playing: ${animConfig.area.file} at grid target (${Math.round(gridTarget.x)}, ${Math.round(gridTarget.y)})`);

          seq.effect()
             .file(animConfig.area.file)
             .atLocation(gridTarget)
             .scale(animConfig.area.scale || 1.0)
             .playbackRate(speed);

          hasAddedEffect = true;
        }
      } else {
        debug(`[AREA] Skipping area animation - no template or grid target`);
      }
    }

    if (!hasAddedEffect) {
      debug('No animation effects were added to sequence');
      debug('═══════════════════════════════════════════════════════');
      return;
    }

    await seq.play();
    debug('ANIMATION PLAYBACK COMPLETE');
    debug('═══════════════════════════════════════════════════════');
  } catch (err) {
    console.warn('SD20: Macro animation failed', err);
    debug(`Animation error: ${err.message}`);
  }
}


// Global state for active grid selection (prevents softlock)
let _activeGridSelection = null;

/**
 * Cancel any active grid selection (call before starting new macro execution)
 */
export function cancelActiveGridSelection() {
  if (_activeGridSelection) {
    debug('[GRID SELECT] Cancelling active selection due to new action');
    _activeGridSelection.cancel();
    _activeGridSelection = null;
  }
}

/**
 * Check if grid selection is currently active
 */
export function isGridSelectionActive() {
  return _activeGridSelection !== null;
}

/**
 * Prompt user to select a grid location for animation targeting
 * Used when a macro has animations but no targeting system
 * @param {Token} caster - The caster token (for reference)
 * @returns {Promise<{x: number, y: number}|null>} Grid point or null if cancelled
 */
export async function selectAnimationTarget(caster) {
  if (!canvas.ready) return null;

  // Cancel any existing selection first
  cancelActiveGridSelection();

  return new Promise((resolve) => {
    // Show notification to guide user
    ui.notifications.info('Click on the canvas to select animation target location. Press Escape to cancel.');

    const casterPos = caster?.center || { x: caster?.x || 0, y: caster?.y || 0 };
    debug(`[GRID SELECT] Waiting for user to select target (caster at ${Math.round(casterPos.x)}, ${Math.round(casterPos.y)})`);

    // Create a blocking overlay that captures all clicks
    const overlay = new PIXI.Graphics();
    overlay.beginFill(0x000000, 0.01); // Nearly transparent but captures events
    overlay.drawRect(0, 0, canvas.dimensions.width, canvas.dimensions.height);
    overlay.endFill();
    overlay.interactive = true;
    overlay.cursor = 'crosshair';
    canvas.stage.addChild(overlay);

    // Create preview line from caster to cursor
    let previewLine = null;
    if (caster) {
      previewLine = new PIXI.Graphics();
      previewLine.lineStyle(2, 0x00ff00, 0.7);
      canvas.stage.addChild(previewLine);
    }

    let isCleanedUp = false;

    // Cleanup function
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      _activeGridSelection = null;

      overlay.off('pointermove', onMouseMove);
      overlay.off('pointerdown', onClick);
      document.removeEventListener('keydown', onKeyDown);

      if (overlay.parent) {
        canvas.stage.removeChild(overlay);
      }
      overlay.destroy();

      if (previewLine?.parent) {
        canvas.stage.removeChild(previewLine);
        previewLine.destroy();
      }
    };

    // Store cancel function for external cancellation
    _activeGridSelection = {
      cancel: () => {
        cleanup();
        resolve(null);
      }
    };

    // Track mouse movement for preview
    const onMouseMove = (event) => {
      if (!previewLine || !caster || isCleanedUp) return;
      const pos = event.data?.getLocalPosition(canvas.stage) || canvas.mousePosition;
      if (!pos) return;

      previewLine.clear();
      previewLine.lineStyle(2, 0x00ff00, 0.7);
      previewLine.moveTo(casterPos.x, casterPos.y);
      previewLine.lineTo(pos.x, pos.y);

      // Draw target circle
      previewLine.lineStyle(2, 0x00ff00, 0.7);
      previewLine.drawCircle(pos.x, pos.y, 20);
    };

    // Handle click to select location
    const onClick = (event) => {
      if (isCleanedUp) return;
      event.stopPropagation();

      // Get position from event or canvas mouse position
      let pos = event.data?.getLocalPosition(canvas.stage);
      if (!pos) {
        pos = canvas.mousePosition;
      }

      cleanup();
      debug(`[GRID SELECT] User selected location: (${Math.round(pos.x)}, ${Math.round(pos.y)}) ${_getGridCellInfo(pos.x, pos.y)}`);
      resolve({ x: pos.x, y: pos.y });
    };

    // Handle escape to cancel
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !isCleanedUp) {
        cleanup();
        debug('[GRID SELECT] User cancelled selection');
        ui.notifications.warn('Animation target selection cancelled');
        resolve(null);
      }
    };

    // Register event listeners on overlay (not canvas.stage)
    overlay.on('pointermove', onMouseMove);
    overlay.on('pointerdown', onClick);
    document.addEventListener('keydown', onKeyDown);
  });
}

/**
 * Check if a macro's animation config requires a target location
 * (i.e., has projectile, impact, or area animations)
 * @param {Object} animConfig - Animation configuration
 * @returns {boolean}
 */
export function animationNeedsTarget(animConfig) {
  if (!animConfig?.enabled) return false;
  return !!(animConfig.projectile?.file || animConfig.impact?.file || animConfig.area?.file);
}

/**
 * Play a simple animation at a location (for custom scripts)
 * @param {Object} options - Animation options
 * @param {string} options.file - Animation database key
 * @param {Token|Object} options.location - Token or {x, y} point
 * @param {number} [options.scale=1.0] - Scale multiplier
 * @param {boolean} [options.belowTokens=false] - Play below tokens
 * @returns {Promise<void>}
 */
export async function playAnimationAt({ file, location, scale = 1.0, belowTokens = false }) {
  if (!isAnimationSystemAvailable()) return;
  if (!file || !location) return;

  if (!animationExists(file)) {
    console.warn(`SD20: Animation not found: ${file}`);
    return;
  }

  try {
    await new Sequence()
      .effect()
      .file(file)
      .atLocation(location)
      .scaleToObject(scale)
      .belowTokens(belowTokens)
      .play();
  } catch (err) {
    console.warn('SD20: Animation playback failed', err);
  }
}

/**
 * Play projectile animation from one point to another
 * @param {Object} options - Animation options
 * @param {string} options.file - Animation database key
 * @param {Token|Object} options.from - Origin token or {x, y} point
 * @param {Token|Object} options.to - Destination token or {x, y} point
 * @param {number} [options.scale=1.0] - Scale multiplier
 * @returns {Promise<void>}
 */
export async function playProjectile({ file, from, to, scale = 1.0 }) {
  if (!isAnimationSystemAvailable()) return;
  if (!file || !from || !to) return;

  if (!animationExists(file)) {
    console.warn(`SD20: Animation not found: ${file}`);
    return;
  }

  try {
    await new Sequence()
      .effect()
      .file(file)
      .atLocation(from)
      .stretchTo(to)
      .scale(scale)
      .play();
  } catch (err) {
    console.warn('SD20: Projectile animation failed', err);
  }
}

/**
 * Preview an animation in a popup dialog
 * @param {string} file - Animation database key
 * @returns {Promise<void>}
 */
export async function previewAnimation(file) {
  if (!isSequencerAvailable()) {
    ui.notifications.warn('Sequencer module required for animation preview');
    return;
  }

  if (!file) return;

  if (!animationExists(file)) {
    ui.notifications.warn(`Animation not found: ${file}`);
    return;
  }

  // Resolve the database key to an actual file path
  let filePath;
  try {
    const entry = Sequencer.Database.getEntry(file);
    // Entry can be various formats depending on JB2A version and animation type
    if (typeof entry === 'string') {
      filePath = entry;
    } else if (Array.isArray(entry)) {
      // Array of paths - use first valid one
      filePath = entry.find(p => typeof p === 'string') || (entry[0]?.file);
    } else if (entry && typeof entry === 'object') {
      // Object - could have file, filepath, path, or other properties
      if (entry.file) {
        filePath = typeof entry.file === 'string' ? entry.file : entry.file[0];
      } else if (entry.filepath) {
        filePath = entry.filepath;
      } else if (entry.path) {
        filePath = entry.path;
      } else {
        // Try to get any string property that looks like a path
        const values = Object.values(entry);
        filePath = values.find(v => typeof v === 'string' && (v.endsWith('.webm') || v.endsWith('.webp')));
      }
    }
  } catch (err) {
    console.warn('SD20: Could not resolve animation path', file, err);
    ui.notifications.warn(`Animation preview error: ${err.message || 'Unknown error'}`);
    return;
  }

  if (!filePath) {
    ui.notifications.warn(`Could not resolve animation path for: ${file}`);
    return;
  }

  // Create preview dialog with video using DialogV2
  const label = formatAnimationLabel(file);
  const dialogContent = `
    <div class="sd20-animation-preview-dialog">
      <video autoplay muted loop class="animation-preview-video">
        <source src="${filePath}" type="video/webm">
        Your browser does not support video playback.
      </video>
      <div class="animation-preview-label">${label}</div>
      <div class="animation-preview-path">${file}</div>
    </div>
  `;

  const { DialogV2 } = foundry.applications.api;

  await DialogV2.prompt({
    window: {
      title: 'Animation Preview',
      icon: 'fa-solid fa-film'
    },
    position: { width: 350 },
    content: dialogContent,
    ok: {
      icon: 'fa-solid fa-times',
      label: 'Close'
    },
    rejectClose: false
  });
}

// ============================================================
// PUBLIC API (exposed on sd20 global)
// ============================================================

/**
 * Animation API for custom scripts
 * Access via: sd20.animation
 */
export const animationAPI = {
  /**
   * Check if animation system is available
   */
  isAvailable: isAnimationSystemAvailable,

  /**
   * Check if a specific animation exists
   */
  exists: animationExists,

  /**
   * Get list of available animations
   */
  getAvailable: getAvailableAnimations,

  /**
   * Play animation at a location
   */
  playAt: playAnimationAt,

  /**
   * Play projectile animation
   */
  playProjectile: playProjectile,

  /**
   * Play status effect animation
   */
  playStatus: playStatusAnimation,

  /**
   * Play multiple status tick animations rapidly (simultaneously)
   */
  playRapidStatus: playRapidStatusAnimations,

  /**
   * Play full macro animation sequence
   */
  playMacro: playMacroAnimation,

  /**
   * Preview animation (client-only)
   */
  preview: previewAnimation,

  /**
   * Format animation key for display
   */
  formatLabel: formatAnimationLabel,

  /**
   * Resolve database key to file path
   */
  resolvePath: resolveAnimationPath,

  /**
   * Prompt user to select a grid location for animation target
   */
  selectTarget: selectAnimationTarget,

  /**
   * Check if animation config requires a target location
   */
  needsTarget: animationNeedsTarget,

  /**
   * Cancel any active grid selection
   */
  cancelSelection: cancelActiveGridSelection,

  /**
   * Check if grid selection is currently active
   */
  isSelectionActive: isGridSelectionActive
};

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Register animation system settings
 * Called from souls-d20.js during init
 */
export function registerAnimationSettings() {
  game.settings.register('souls-d20', 'enableAnimations', {
    name: 'Enable Animations',
    hint: 'Enable visual animations for macros and status effects. Requires Sequencer module.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register('souls-d20', 'animationSpeed', {
    name: 'Animation Speed',
    hint: 'Playback speed multiplier for animations (0.5 = half speed, 2.0 = double speed).',
    scope: 'client',
    config: true,
    type: Number,
    range: { min: 0.5, max: 2.0, step: 0.1 },
    default: 1.0
  });

  log('Animation settings registered');
}

/**
 * Initialize animation system
 * Called from souls-d20.js during ready
 */
export function initAnimationSystem() {
  if (isSequencerAvailable()) {
    log(`Animation system ready (Sequencer detected)`);

    if (isJB2AAvailable()) {
      // Delay database check to ensure Sequencer is fully loaded
      setTimeout(() => {
        const animCount = getAvailableAnimations('jb2a').length;
        debug(`JB2A database loaded with ${animCount} top-level categories`);
      }, 1000);
      log('JB2A detected - animations available');
    } else {
      log('JB2A not detected - animations may be limited');
    }
  } else {
    log('Sequencer not detected - animation system disabled');
  }
}
