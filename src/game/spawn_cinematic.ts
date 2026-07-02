// First-spawn camera cinematic, pure math (no DOM): the camera opens high and
// far, one full turn behind the gameplay yaw, circles the spawn while it
// descends, and lands exactly on the normal gameplay pose. main.ts feeds
// elapsed seconds in and applies the returned pose to the input camera each
// frame; tests/spawn_cinematic.test.ts locks the start/landing/continuity
// contract.

export interface CameraPose {
  yaw: number;
  pitch: number;
  dist: number;
}

export interface SpawnCinematic {
  durationSec: number;
  turns: number; // full camera turns around the spawn
  startDist: number; // the orbit opens far ...
  startPitch: number; // ... and high, looking down at the spawn
  end: CameraPose; // gameplay pose the cinematic lands on exactly
}

// startDist stays inside the wheel-zoom range input.ts allows (3..22) so the
// whole path uses camera poses the player could reach themselves.
export function spawnCinematicFor(end: CameraPose): SpawnCinematic {
  return { durationSec: 9, turns: 1, startDist: 22, startPitch: 0.55, end };
}

// The yaw eases over the whole run (gentle start, slow landing) while the
// descent (dist + pitch) holds the high wide shot for the opening stretch and
// only settles onto the character in the back stretch.
const DESCENT_START = 0.45;

export function spawnCinematicPose(
  elapsedSec: number,
  c: SpawnCinematic,
): CameraPose & { done: boolean } {
  const p = clamp01(elapsedSec / c.durationSec);
  const orbit = easeInOutSine(p);
  const descent = easeInOutCubic(clamp01((p - DESCENT_START) / (1 - DESCENT_START)));
  return {
    yaw: c.end.yaw - (1 - orbit) * c.turns * Math.PI * 2,
    pitch: c.startPitch + (c.end.pitch - c.startPitch) * descent,
    dist: c.startDist + (c.end.dist - c.startDist) * descent,
    done: elapsedSec >= c.durationSec,
  };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function easeInOutSine(x: number): number {
  return 0.5 - Math.cos(Math.PI * x) / 2;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}
