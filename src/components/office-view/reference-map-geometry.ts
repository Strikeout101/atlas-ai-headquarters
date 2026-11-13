/**
 * The reference office is authored in a fixed 1672 × 941 world. The lower glass
 * facade is scenery; actors occupy the upper cutaway floor only. Keeping these
 * coordinates independent of canvas size makes camera zoom and pointer hit
 * testing deterministic.
 */
export const MAP_WIDTH = 1672;
export const MAP_HEIGHT = 941;

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeskAnchor extends MapPoint {
  id: string;
  approachX: number;
  approachY: number;
  row: "north" | "south";
}

export interface RoomZone extends MapRect {
  id: "executive" | "conference" | "kitchenette" | "arcade" | "lounge" | "elevator";
  interactAt: MapPoint;
}

export const FLOOR_BOUNDS: Readonly<MapRect> = { x: 78, y: 200, width: 1516, height: 462 };

export const DESK_ANCHORS: readonly DeskAnchor[] = [
  { id: "north-1", x: 371, y: 401, approachX: 371, approachY: 438, row: "north" },
  { id: "north-2", x: 607, y: 401, approachX: 607, approachY: 438, row: "north" },
  { id: "north-3", x: 851, y: 401, approachX: 953, approachY: 438, row: "north" },
  { id: "north-4", x: 1088, y: 401, approachX: 1088, approachY: 438, row: "north" },
  { id: "north-5", x: 1334, y: 401, approachX: 1334, approachY: 438, row: "north" },
  { id: "south-1", x: 339, y: 631, approachX: 339, approachY: 550, row: "south" },
  { id: "south-2", x: 595, y: 631, approachX: 595, approachY: 550, row: "south" },
  { id: "south-3", x: 850, y: 631, approachX: 850, approachY: 550, row: "south" },
  { id: "south-4", x: 1106, y: 631, approachX: 1106, approachY: 550, row: "south" },
  { id: "south-5", x: 1369, y: 631, approachX: 1369, approachY: 550, row: "south" },
] as const;

export const ROOM_ZONES: readonly RoomZone[] = [
  { id: "executive", x: 478, y: 89, width: 301, height: 212, interactAt: { x: 630, y: 280 } },
  { id: "conference", x: 800, y: 89, width: 510, height: 212, interactAt: { x: 1050, y: 281 } },
  { id: "kitchenette", x: 107, y: 295, width: 98, height: 192, interactAt: { x: 226, y: 390 } },
  { id: "arcade", x: 199, y: 157, width: 56, height: 108, interactAt: { x: 267, y: 236 } },
  { id: "lounge", x: 671, y: 411, width: 622, height: 130, interactAt: { x: 950, y: 540 } },
  { id: "elevator", x: 1328, y: 89, width: 133, height: 129, interactAt: { x: 1394, y: 236 } },
] as const;

export const INTERACTION_ANCHORS = {
  meetingTable: { x: 1053, y: 270 },
  executiveDesk: { x: 638, y: 275 },
  kitchenette: { x: 226, y: 390 },
  arcade: { x: 267, y: 236 },
  foosball: { x: 484, y: 540 },
  elevator: { x: 1394, y: 236 },
  lounge: { x: 950, y: 540 },
  ceoSpawn: { x: 838, y: 541 },
  meetingSeats: [
    { x: 945, y: 249 },
    { x: 998, y: 249 },
    { x: 1052, y: 249 },
    { x: 1107, y: 249 },
    { x: 1160, y: 249 },
    { x: 1210, y: 216 },
  ],
} as const;

/** Opaque furniture and wall strips, not rugs or transparent panes. */
export const WALK_OBSTACLES: readonly MapRect[] = [
  // The front glass wall has a central doorway in each room.
  { x: 475, y: 294, width: 146, height: 9 },
  { x: 649, y: 294, width: 130, height: 9 },
  { x: 475, y: 89, width: 9, height: 214 },
  { x: 771, y: 89, width: 9, height: 214 },
  { x: 798, y: 294, width: 245, height: 9 },
  { x: 1072, y: 294, width: 239, height: 9 },
  { x: 798, y: 89, width: 9, height: 214 },
  { x: 1303, y: 89, width: 9, height: 214 },
  { x: 548, y: 169, width: 183, height: 53 },
  { x: 900, y: 177, width: 290, height: 54 },
  { x: 1327, y: 89, width: 134, height: 129 },
  { x: 198, y: 156, width: 54, height: 108 },
  { x: 108, y: 297, width: 96, height: 189 },
  // North workstation furniture and occupied chairs.
  { x: 288, y: 344, width: 168, height: 78 },
  { x: 529, y: 344, width: 169, height: 78 },
  { x: 769, y: 344, width: 166, height: 78 },
  { x: 1005, y: 344, width: 172, height: 78 },
  { x: 1257, y: 344, width: 167, height: 78 },
  // Social furniture. Rugs are deliberately omitted.
  { x: 427, y: 445, width: 111, height: 80 },
  { x: 736, y: 431, width: 158, height: 95 },
  { x: 923, y: 451, width: 59, height: 64 },
  { x: 999, y: 434, width: 48, height: 83 },
  { x: 1123, y: 435, width: 164, height: 84 },
  // South workstation furniture and occupied chairs.
  { x: 252, y: 576, width: 178, height: 83 },
  { x: 505, y: 576, width: 185, height: 83 },
  { x: 766, y: 576, width: 183, height: 83 },
  { x: 1021, y: 576, width: 185, height: 83 },
  { x: 1286, y: 576, width: 176, height: 83 },
] as const;

export function isInsideRect(point: MapPoint, rect: MapRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** Circle-vs-rectangle occupancy prevents an actor's center from clipping art. */
export function isWalkable(point: MapPoint, radius = 8): boolean {
  if (
    point.x < FLOOR_BOUNDS.x + radius ||
    point.x > FLOOR_BOUNDS.x + FLOOR_BOUNDS.width - radius ||
    point.y < FLOOR_BOUNDS.y + radius ||
    point.y > FLOOR_BOUNDS.y + FLOOR_BOUNDS.height - radius
  )
    return false;

  // The cutaway floor widens toward the front of the building. Keep actor
  // centers inside its visible side rails instead of the rectangular map box.
  const floorT = Math.max(0, Math.min(1, (point.y - 200) / 462));
  const leftRail = 173 + (82 - 173) * floorT;
  const rightRail = 1494 + (1586 - 1494) * floorT;
  if (point.x < leftRail + radius || point.x > rightRail - radius) return false;

  for (const rect of WALK_OBSTACLES) {
    const closestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.width));
    const closestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.height));
    const dx = point.x - closestX;
    const dy = point.y - closestY;
    if (dx * dx + dy * dy < radius * radius) return false;
  }
  return true;
}

const NAV_STEP = 16;
const GRID_COLS = Math.floor(FLOOR_BOUNDS.width / NAV_STEP) + 1;
const GRID_ROWS = Math.floor(FLOOR_BOUNDS.height / NAV_STEP) + 1;
const GRID_SIZE = GRID_COLS * GRID_ROWS;

function cellPoint(index: number): MapPoint {
  return {
    x: FLOOR_BOUNDS.x + (index % GRID_COLS) * NAV_STEP,
    y: FLOOR_BOUNDS.y + Math.floor(index / GRID_COLS) * NAV_STEP,
  };
}

function nearestWalkableCell(point: MapPoint, radius: number): number | null {
  const col = Math.max(0, Math.min(GRID_COLS - 1, Math.round((point.x - FLOOR_BOUNDS.x) / NAV_STEP)));
  const row = Math.max(0, Math.min(GRID_ROWS - 1, Math.round((point.y - FLOOR_BOUNDS.y) / NAV_STEP)));
  const maxRing = Math.max(GRID_COLS, GRID_ROWS);
  for (let ring = 0; ring <= maxRing; ring++) {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let y = Math.max(0, row - ring); y <= Math.min(GRID_ROWS - 1, row + ring); y++) {
      for (let x = Math.max(0, col - ring); x <= Math.min(GRID_COLS - 1, col + ring); x++) {
        if (Math.max(Math.abs(x - col), Math.abs(y - row)) !== ring) continue;
        const index = y * GRID_COLS + x;
        const candidate = cellPoint(index);
        if (!isWalkable(candidate, radius)) continue;
        const distance = (point.x - candidate.x) ** 2 + (point.y - candidate.y) ** 2;
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

function lineIsWalkable(from: MapPoint, to: MapPoint, radius: number): boolean {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const samples = Math.ceil(distance / 6);
  for (let i = 0; i <= samples; i++) {
    const t = samples === 0 ? 0 : i / samples;
    if (!isWalkable({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, radius)) return false;
  }
  return true;
}

/**
 * A* path over the floor. Furniture anchors may be inside their own collision
 * footprint; in that case the first/last segment connects to the nearest free
 * cell so a visitor visibly enters or exits the chair area. An empty result
 * means no traversable route exists.
 */
export function findWalkPath(from: MapPoint, to: MapPoint, radius = 8): MapPoint[] {
  const start = nearestWalkableCell(from, radius);
  const goal = nearestWalkableCell(to, radius);
  if (start === null || goal === null) return [];
  if (start === goal) return [from, to];

  const cost = new Float64Array(GRID_SIZE);
  cost.fill(Infinity);
  const parent = new Int32Array(GRID_SIZE);
  parent.fill(-1);
  const closed = new Uint8Array(GRID_SIZE);
  const open: Array<{ index: number; score: number }> = [];
  const goalPoint = cellPoint(goal);
  const heuristic = (index: number) => {
    const point = cellPoint(index);
    return Math.hypot(point.x - goalPoint.x, point.y - goalPoint.y);
  };
  cost[start] = 0;
  open.push({ index: start, score: heuristic(start) });

  while (open.length > 0) {
    // This map has under 4,000 cells and paths are event-driven. Avoid a heap
    // dependency while keeping the routing code easy to audit.
    let minAt = 0;
    for (let i = 1; i < open.length; i++) if (open[i].score < open[minAt].score) minAt = i;
    const current = open.splice(minAt, 1)[0].index;
    if (closed[current]) continue;
    if (current === goal) break;
    closed[current] = 1;
    const cx = current % GRID_COLS;
    const cy = Math.floor(current / GRID_COLS);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_COLS || ny >= GRID_ROWS) continue;
        const next = ny * GRID_COLS + nx;
        if (closed[next] || !isWalkable(cellPoint(next), radius)) continue;
        // No diagonal squeeze through two furniture corners.
        if (dx !== 0 && dy !== 0) {
          if (!isWalkable(cellPoint(cy * GRID_COLS + nx), radius)) continue;
          if (!isWalkable(cellPoint(ny * GRID_COLS + cx), radius)) continue;
        }
        const tentative = cost[current] + NAV_STEP * (dx && dy ? Math.SQRT2 : 1);
        if (tentative >= cost[next]) continue;
        parent[next] = current;
        cost[next] = tentative;
        open.push({ index: next, score: tentative + heuristic(next) });
      }
    }
  }

  if (parent[goal] === -1) return [];
  const cells: MapPoint[] = [];
  for (let current = goal; current !== -1; current = parent[current]) cells.push(cellPoint(current));
  cells.reverse();

  // Collapse grid zigzags only when the direct segment stays in walkable space.
  const simplified: MapPoint[] = [];
  for (let i = 0; i < cells.length; ) {
    simplified.push(cells[i]);
    let farthest = i + 1;
    for (let j = cells.length - 1; j > i + 1; j--) {
      if (lineIsWalkable(cells[i], cells[j], radius)) {
        farthest = j;
        break;
      }
    }
    i = farthest;
  }
  if (simplified[simplified.length - 1] !== cells[cells.length - 1]) simplified.push(cells[cells.length - 1]);
  return [from, ...simplified, to];
}
