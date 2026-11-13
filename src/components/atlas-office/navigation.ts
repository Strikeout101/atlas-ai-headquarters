import { AGENT_RADIUS, WORLD_BOUNDS, canOccupy, type FloorId, type FloorPoint } from "./layout";

const CELL = 0.2;
const COLS = Math.ceil((WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX) / CELL) + 1;
const ROWS = Math.ceil((WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ) / CELL) + 1;

/** One walkability grid per floor, built on first use. */
const blockedGrids = new Map<FloorId, Uint8Array>();

function cellX(col: number): number {
  return WORLD_BOUNDS.minX + col * CELL;
}

function cellZ(row: number): number {
  return WORLD_BOUNDS.minZ + row * CELL;
}

function grid(floor: FloorId): Uint8Array {
  const cached = blockedGrids.get(floor);
  if (cached) return cached;
  const blocked = new Uint8Array(COLS * ROWS);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      blocked[row * COLS + col] = canOccupy(cellX(col), cellZ(row), AGENT_RADIUS, floor) ? 0 : 1;
    }
  }
  blockedGrids.set(floor, blocked);
  return blocked;
}

function nearestFreeCell(x: number, z: number, floor: FloorId): number | null {
  const blocked = grid(floor);
  const col0 = Math.round((x - WORLD_BOUNDS.minX) / CELL);
  const row0 = Math.round((z - WORLD_BOUNDS.minZ) / CELL);
  for (let radius = 0; radius < 12; radius++) {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let row = row0 - radius; row <= row0 + radius; row++) {
      for (let col = col0 - radius; col <= col0 + radius; col++) {
        if (row < 0 || col < 0 || row >= ROWS || col >= COLS) continue;
        if (Math.max(Math.abs(row - row0), Math.abs(col - col0)) !== radius) continue;
        const index = row * COLS + col;
        if (blocked[index]) continue;
        const distance = Math.hypot(cellX(col) - x, cellZ(row) - z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** True when an agent can walk straight from a to b without touching an obstacle. */
export function hasClearLine(a: FloorPoint, b: FloorPoint, floor: FloorId = "director"): boolean {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.ceil(length / 0.08));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!canOccupy(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, AGENT_RADIUS, floor)) return false;
  }
  return true;
}

class MinHeap {
  private items: Array<[number, number]> = [];
  get size() {
    return this.items.length;
  }
  push(priority: number, value: number) {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop(): number {
    const items = this.items;
    const top = items[0][1];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

const NEIGHBOURS: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * Returns walkable waypoints from `from` to `to`, ending exactly at `to`.
 * Uses A* over a 20 cm grid, then removes waypoints that have a clear line of sight.
 */
export function findPath(from: FloorPoint, to: FloorPoint, floor: FloorId = "director"): FloorPoint[] {
  if (hasClearLine(from, to, floor)) return [to];
  const start = nearestFreeCell(from[0], from[1], floor);
  const goal = nearestFreeCell(to[0], to[1], floor);
  if (start === null || goal === null) return [to];

  const blocked = grid(floor);
  const goalCol = goal % COLS;
  const goalRow = Math.floor(goal / COLS);
  const cost = new Float32Array(COLS * ROWS).fill(Infinity);
  const previous = new Int32Array(COLS * ROWS).fill(-1);
  const open = new MinHeap();
  cost[start] = 0;
  open.push(0, start);
  while (open.size > 0) {
    const current = open.pop();
    if (current === goal) break;
    const col = current % COLS;
    const row = Math.floor(current / COLS);
    for (const [dc, dr, stepCost] of NEIGHBOURS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const next = nr * COLS + nc;
      if (blocked[next]) continue;
      if (dc !== 0 && dr !== 0 && (blocked[row * COLS + nc] || blocked[nr * COLS + col])) continue;
      const nextCost = cost[current] + stepCost;
      if (nextCost >= cost[next]) continue;
      cost[next] = nextCost;
      previous[next] = current;
      open.push(nextCost + Math.hypot(goalCol - nc, goalRow - nr), next);
    }
  }
  if (start !== goal && previous[goal] === -1) return [to];

  const cells: FloorPoint[] = [];
  for (let cell = goal; cell !== -1; cell = previous[cell]) {
    cells.push([cellX(cell % COLS), cellZ(Math.floor(cell / COLS))]);
    if (cell === start) break;
  }
  cells.reverse();
  cells.push(to);

  const smoothed: FloorPoint[] = [];
  let anchor: FloorPoint = from;
  let index = 0;
  while (index < cells.length) {
    let furthest = index;
    for (let probe = cells.length - 1; probe > index; probe--) {
      if (hasClearLine(anchor, cells[probe], floor)) {
        furthest = probe;
        break;
      }
    }
    smoothed.push(cells[furthest]);
    anchor = cells[furthest];
    index = furthest + 1;
  }
  return smoothed;
}
