export type Facing = "front" | "right" | "left" | "back";

/** Row order in public/sprites/director/director-walk.png (3 columns × 4 rows). */
export const DIRECTOR_SHEET = {
  url: "/sprites/director/director-walk.png",
  columns: 3,
  rows: 4,
  rowByFacing: { front: 0, right: 1, left: 2, back: 3 } as Record<Facing, number>,
  /** Visible character height inside a 384 px frame, used to size the plane. */
  frameAspect: 256 / 384,
  contentHeightRatio: 351 / 384,
  footPaddingRatio: 8 / 384,
  idleColumn: 1,
} as const;

/** Walk cycle columns: step, pass, other step, pass. */
const WALK_CYCLE = [0, 1, 2, 1];
export const STRIDE_METRES = 0.34;

/**
 * Chooses which way the sprite should face on screen.
 * `heading` is the character's world-space facing; `view` is the camera's
 * horizontal look direction (camera → character). Both are x/z vectors.
 * A small hysteresis keeps diagonal movement from flickering between rows.
 */
export function facingFromView(
  headingX: number,
  headingZ: number,
  viewX: number,
  viewZ: number,
  previous: Facing = "front",
  hysteresis = 0.15,
): Facing {
  const headingLength = Math.hypot(headingX, headingZ);
  const viewLength = Math.hypot(viewX, viewZ);
  if (headingLength < 1e-6 || viewLength < 1e-6) return previous;
  const hx = headingX / headingLength;
  const hz = headingZ / headingLength;
  const vx = viewX / viewLength;
  const vz = viewZ / viewLength;
  // Camera right on the floor plane is view × up = (-vz, vx).
  const away = hx * vx + hz * vz;
  const right = hx * -vz + hz * vx;
  const candidate: Facing =
    Math.abs(away) >= Math.abs(right) ? (away > 0 ? "back" : "front") : right > 0 ? "right" : "left";
  if (candidate === previous) return previous;
  const previousScore =
    previous === "back" ? away : previous === "front" ? -away : previous === "right" ? right : -right;
  const candidateScore =
    candidate === "back" ? away : candidate === "front" ? -away : candidate === "right" ? right : -right;
  return candidateScore - previousScore > hysteresis ? candidate : previous;
}

/** Sheet column for the current walk distance; idle uses the standing pose. */
export function walkColumn(distanceTravelled: number, moving: boolean): number {
  if (!moving) return DIRECTOR_SHEET.idleColumn;
  const step = Math.floor(Math.max(0, distanceTravelled) / STRIDE_METRES) % WALK_CYCLE.length;
  return WALK_CYCLE[step];
}

/** UV offset (three.js, flipY) for a frame in the sheet. */
export function sheetOffset(column: number, row: number): [number, number] {
  return [column / DIRECTOR_SHEET.columns, 1 - (row + 1) / DIRECTOR_SHEET.rows];
}

/** Frame keys for the existing agent sprite set (`/sprites/{n}-{D|L|R}-{i}.png`). */
export type AgentFrame = "D-1" | "D-2" | "D-3" | "L-1" | "R-1";
const AGENT_WALK_DOWN: AgentFrame[] = ["D-1", "D-2", "D-1", "D-3"];

export function agentFrame(facing: Facing, distanceTravelled: number, moving: boolean): AgentFrame {
  if (!moving) return "D-1";
  if (facing === "left") return "L-1";
  if (facing === "right") return "R-1";
  const step = Math.floor(Math.max(0, distanceTravelled) / STRIDE_METRES) % AGENT_WALK_DOWN.length;
  return AGENT_WALK_DOWN[step];
}
