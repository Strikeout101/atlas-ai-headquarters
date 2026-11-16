import type { Agent, AgentRole, Department } from "../../types";

/**
 * ATLAS floor plan, matching the AI Office Map (reference-map-geometry.ts) in metres.
 * x runs west → east, z runs north (back wall) → south (window wall). y is up.
 * Rendering, collision, agent seats and interactions all read from this file.
 */

/** Axis-aligned footprint on the floor plane, centred on (x, z). */
export interface FloorRect {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export type FloorPoint = [number, number];

/**
 * The building has two floors with the same footprint and the same x/z coordinates: the Director's floor and the
 * floor below it, which repeats the plan without the executive office. Only the floor the Director is on is drawn.
 */
export type FloorId = "director" | "lower";
export const FLOOR_INFO: Record<FloorId, { label: string; level: number }> = {
  director: { label: "Director's Floor", level: 2 },
  lower: { label: "Lower Floor", level: 1 },
};
/** Storey height (slab to slab), used to lower the view of the city from the floor below. */
export const STOREY_HEIGHT = 3.6;
export function otherFloor(floor: FloorId): FloorId {
  return floor === "director" ? "lower" : "director";
}

/** Inner faces of the building's outer walls. */
export const FLOOR = { minX: -11.5, maxX: 11.5, minZ: -6.5, maxZ: 6.5, ceiling: 3.2 } as const;

export const PLAYER_RADIUS = 0.28;
export const AGENT_RADIUS = 0.12;

/** Limits for the player's centre point. */
export const WORLD_BOUNDS = {
  minX: FLOOR.minX + PLAYER_RADIUS,
  maxX: FLOOR.maxX - PLAYER_RADIUS,
  minZ: FLOOR.minZ + PLAYER_RADIUS,
  maxZ: FLOOR.maxZ - PLAYER_RADIUS,
} as const;

/**
 * The glass rooms. The conference room stands against the back wall with its door in its south (front) wall. The
 * Director's executive office fills the south-west corner: solid outer wall to the west, the window wall to the
 * south, glass to the east and north, with the door in the north wall. Only the Director's floor has it.
 */
export const ROOMS = {
  executive: { minX: FLOOR.minX, maxX: -6.0, minZ: 1.7, maxZ: FLOOR.maxZ, doorX: -6.75 },
  conference: { minX: -0.3, maxX: 7.6, minZ: FLOOR.minZ, maxZ: -2.2, doorX: 3.65 },
} as const;
export const DOOR_WIDTH = 1.2;
const GLASS = 0.08;

/** A glass wall running east-west at `z` from `minX` to `maxX`, split by a doorway centred on `doorX`. */
function wallWithDoor(minX: number, maxX: number, z: number, doorX: number): FloorRect[] {
  const doorWest = doorX - DOOR_WIDTH / 2;
  const doorEast = doorX + DOOR_WIDTH / 2;
  return [
    { x: (minX + doorWest) / 2, z, width: doorWest - minX, depth: GLASS },
    { x: (doorEast + maxX) / 2, z, width: maxX - doorEast, depth: GLASS },
  ];
}

const CONFERENCE_DEPTH = ROOMS.conference.maxZ - FLOOR.minZ;
const CONFERENCE_CENTER_Z = (ROOMS.conference.maxZ + FLOOR.minZ) / 2;
const CONFERENCE_WALLS: FloorRect[] = [
  { x: ROOMS.conference.minX, z: CONFERENCE_CENTER_Z, width: GLASS, depth: CONFERENCE_DEPTH },
  { x: ROOMS.conference.maxX, z: CONFERENCE_CENTER_Z, width: GLASS, depth: CONFERENCE_DEPTH },
  ...wallWithDoor(ROOMS.conference.minX, ROOMS.conference.maxX, ROOMS.conference.maxZ, ROOMS.conference.doorX),
];
const EXECUTIVE_WALLS: FloorRect[] = [
  {
    x: ROOMS.executive.maxX,
    z: (ROOMS.executive.minZ + ROOMS.executive.maxZ) / 2,
    width: GLASS,
    depth: ROOMS.executive.maxZ - ROOMS.executive.minZ,
  },
  ...wallWithDoor(ROOMS.executive.minX, ROOMS.executive.maxX, ROOMS.executive.minZ, ROOMS.executive.doorX),
];

/** Glass partitions on the Director's floor; the gap in each room's door wall is the doorway. */
export const GLASS_WALLS: FloorRect[] = [...CONFERENCE_WALLS, ...EXECUTIVE_WALLS];
/** The floor below has the conference room but no executive office. */
const LOWER_GLASS_WALLS: FloorRect[] = CONFERENCE_WALLS;
export const GLASS_WALLS_BY_FLOOR: Record<FloorId, FloorRect[]> = { director: GLASS_WALLS, lower: LOWER_GLASS_WALLS };

/** Workstations: north row then south row, west to east, as on the AI Office Map. */
export const DESK_WIDTH = 1.7;
export const DESK_DEPTH = 0.8;
export const DESKS: FloorPoint[] = [
  [-7.9, 0],
  [-4.1, 0],
  [-0.15, 0],
  [3.7, 0],
  [7.6, 0],
  [-8.4, 4.8],
  [-4.2, 4.8],
  [-0.15, 4.8],
  [4.0, 4.8],
  [8.2, 4.8],
];
export const DESKS_PER_ROW = 5;
/** Desk 5 stands where the executive office is upstairs, so it is only on the floor below. */
export const DESK_INDICES_BY_FLOOR: Record<FloorId, readonly number[]> = {
  director: DESKS.map((_, i) => i).filter((i) => i !== 5),
  lower: DESKS.map((_, i) => i),
};
/**
 * How far the hips travel back from where a character stands when it sits (Sitting_Enter in the shared animation
 * library, measured from the agent and Director GLBs). A character sits by standing this far in front of a chair,
 * facing away from it, and lowering itself back onto the seat.
 */
export const SIT_BACK = 0.28;
/** Agents sit south of their desk, facing the monitors on the north edge. This is where they stand to sit down. */
export const SEAT_OFFSET = 0.55;
/** Desk chairs stand where a seated agent's hips land; must match art/blender/build_atlas_furniture.py. */
export const DESK_CHAIR_OFFSET = SEAT_OFFSET + SIT_BACK;
export function deskSeat(index: number): FloorPoint {
  const [x, z] = DESKS[index];
  return [x, z + SEAT_OFFSET];
}
/** Facing (radians, 0 = +z) of an agent seated at a desk: toward the monitors. */
export const DESK_SEAT_YAW = Math.PI;

/**
 * Corner sofa in the north-west corner (build_atlas_furniture.py): its back along the west wall, the chaise along
 * the north wall. Two footprints, because the L leaves the corner in front of the main seat open.
 */
const CORNER_SOFA = { x: -10.6, z: -5.11 } as const;

/** Solid furniture on both floors. Rendering and collision both read from these. */
const SHARED_FURNITURE = {
  // The procedural meeting table (4.6 x 1.15 m) plus a small margin. Its chairs stand clear of it.
  conferenceTable: { x: 3.65, z: -4.4, width: 4.8, depth: 1.2 },
  // Faces east, its back to the west wall.
  arcade: { x: -11.05, z: -3.2, width: 0.9, depth: 0.75 },
  cornerSofa: { x: CORNER_SOFA.x - 0.39, z: CORNER_SOFA.z, width: 0.98, depth: 2.74 },
  cornerSofaChaise: { x: CORNER_SOFA.x + 0.49, z: CORNER_SOFA.z - 0.675, width: 0.78, depth: 1.05 },
  kitchenCounter: { x: -11.15, z: 0, width: 0.7, depth: 1.95 },
  trashCan: { x: -11.1, z: 1.3, width: 0.4, depth: 0.4 },
  foosball: { x: -7.8, z: -4.4, width: 1.5, depth: 1.16 },
  sofa: { x: 0, z: 2.5, width: 2.4, depth: 0.9 },
  coffeeTable: { x: 0, z: 3.7, width: 1.2, depth: 0.6 },
  // Arc lamp base behind the sofa; the arc and shade reach over it (build_atlas_furniture.py).
  floorLamp: { x: -0.35, z: 1.75, width: 0.42, depth: 0.42 },
  armchair: { x: 1.9, z: 3.1, width: 0.95, depth: 0.95 },
  loungePlant: { x: 3.3, z: 2.6, width: 0.6, depth: 0.6 },
  beanbagWest: { x: 5.6, z: 3.4, width: 0.95, depth: 0.95 },
  beanbagNorth: { x: 6.4, z: 2.6, width: 0.95, depth: 0.95 },
  beanbagEast: { x: 7.2, z: 3.4, width: 0.95, depth: 0.95 },
  beanbagTable: { x: 6.4, z: 3.35, width: 0.5, depth: 0.5 },
  plantSouthEast: { x: 10.9, z: 5.9, width: 0.7, depth: 0.7 },
  plantKitchen: { x: -11.0, z: -1.9, width: 0.6, depth: 0.6 },
} satisfies Record<string, FloorRect>;

/**
 * The executive office (Director's floor only). The Director sits with his back to the bookshelf on the west wall,
 * facing east across his desk toward the guest armchairs; the windows are on his right.
 */
export const EXECUTIVE_FURNITURE = {
  executiveDesk: { x: -9.37, z: 4.1, width: 1.12, depth: 2.1 },
  bookshelf: { x: -11.28, z: 4.1, width: 0.46, depth: 2.4 },
  guestChairNorth: { x: -8.2, z: 3.55, width: 0.74, depth: 0.8 },
  guestChairSouth: { x: -8.2, z: 4.65, width: 0.74, depth: 0.8 },
  loungeChair: { x: -6.75, z: 5.85, width: 0.95, depth: 0.95 },
  plantExecutive: { x: -11.0, z: 6.0, width: 0.5, depth: 0.5 },
} satisfies Record<string, FloorRect>;

/** Where the executive office used to be, next to the conference room: open floor with a pool table upstairs. */
const POOL_TABLE = { poolTable: { x: -2.85, z: -4.5, width: 2.2, depth: 1.3 } } satisfies Record<string, FloorRect>;

/**
 * On the floor below, the pool table's corner is a lounge nook instead: a sofa against the back wall facing south,
 * a coffee table, two armchairs facing the sofa, an angled lounge chair and plants. The south-west corner (the
 * executive office upstairs) has desk 5 and a plant.
 */
export const LOWER_NOOK = {
  sofa: { x: -2.85, z: -5.95, width: 2.4, depth: 0.9 },
  coffeeTable: { x: -2.85, z: -4.75, width: 1.2, depth: 0.6 },
  armchairWest: { x: -3.4, z: -3.5, width: 0.8, depth: 0.74 },
  armchairEast: { x: -2.3, z: -3.5, width: 0.8, depth: 0.74 },
  loungeChair: { x: -4.7, z: -5.5, width: 0.95, depth: 0.95 },
  plantWest: { x: -5.0, z: -6.1, width: 0.5, depth: 0.5 },
  plantEast: { x: -0.8, z: -6.0, width: 0.6, depth: 0.6 },
} satisfies Record<string, FloorRect>;
const LOWER_ONLY_FURNITURE = {
  ...LOWER_NOOK,
  plantSouthWest: { x: -10.9, z: 5.9, width: 0.7, depth: 0.7 },
} satisfies Record<string, FloorRect>;

/** Everything solid on the Director's floor, by name. */
export const FURNITURE = { ...SHARED_FURNITURE, ...EXECUTIVE_FURNITURE, ...POOL_TABLE };
export const FURNITURE_BY_FLOOR: Record<FloorId, Record<string, FloorRect>> = {
  director: FURNITURE,
  lower: { ...SHARED_FURNITURE, ...LOWER_ONLY_FURNITURE },
};

export const ELEVATOR = { x: 9.3, z: FLOOR.minZ, width: 2.0 } as const;
/**
 * Where the Director steps out of the elevator after changing floors, facing into the room (yaw π looks south).
 * Far enough from the back wall for the camera boom behind him, still inside the elevator's interaction zone.
 */
export const ELEVATOR_ARRIVAL = { x: ELEVATOR.x, z: -4.3, yaw: Math.PI } as const;

function deskObstacles(floor: FloorId): FloorRect[] {
  return DESK_INDICES_BY_FLOOR[floor].map((i) => ({
    x: DESKS[i][0],
    z: DESKS[i][1],
    width: DESK_WIDTH,
    depth: DESK_DEPTH,
  }));
}
export const OBSTACLES_BY_FLOOR: Record<FloorId, FloorRect[]> = {
  director: [...Object.values(FURNITURE_BY_FLOOR.director), ...deskObstacles("director"), ...GLASS_WALLS],
  lower: [...Object.values(FURNITURE_BY_FLOOR.lower), ...deskObstacles("lower"), ...LOWER_GLASS_WALLS],
};
export const OBSTACLES: FloorRect[] = OBSTACLES_BY_FLOOR.director;

export function canOccupy(x: number, z: number, radius = PLAYER_RADIUS, floor: FloorId = "director"): boolean {
  if (x < FLOOR.minX + radius || x > FLOOR.maxX - radius || z < FLOOR.minZ + radius || z > FLOOR.maxZ - radius) {
    return false;
  }
  return !OBSTACLES_BY_FLOOR[floor].some(
    (obstacle) =>
      Math.abs(x - obstacle.x) < obstacle.width / 2 + radius && Math.abs(z - obstacle.z) < obstacle.depth / 2 + radius,
  );
}

/** Things the third-person camera cannot pass: the floor edges, glass walls and the tall bookshelf.
 * Desks and low furniture are ignored because the camera rides above them. */
const CAMERA_OBSTACLES: Record<FloorId, FloorRect[]> = {
  director: [...GLASS_WALLS, FURNITURE.bookshelf],
  lower: LOWER_GLASS_WALLS,
};
export function cameraCanOccupy(x: number, z: number, radius = 0.15, floor: FloorId = "director"): boolean {
  if (x < FLOOR.minX + radius || x > FLOOR.maxX - radius || z < FLOOR.minZ + radius || z > FLOOR.maxZ - radius) {
    return false;
  }
  return !CAMERA_OBSTACLES[floor].some(
    (obstacle) =>
      Math.abs(x - obstacle.x) < obstacle.width / 2 + radius && Math.abs(z - obstacle.z) < obstacle.depth / 2 + radius,
  );
}

/**
 * The Director's seat at the executive desk: where he stands to sit down (facing the desk, east, +x) and the chair
 * behind him. The executive desk's west edge is at x = -9.93, so his knees go under it.
 */
export const EXECUTIVE_SEAT = { x: -10.07, z: 4.1, yaw: Math.PI / 2 } as const;
/** Executive chair position; must match art/blender/build_atlas_furniture.py. */
export const EXECUTIVE_CHAIR: FloorPoint = [
  EXECUTIVE_SEAT.x - SIT_BACK * Math.sin(EXECUTIVE_SEAT.yaw),
  EXECUTIVE_SEAT.z - SIT_BACK * Math.cos(EXECUTIVE_SEAT.yaw),
];

/** Where the camera settles when the Director sits down at the executive computer: over his right shoulder
 * (he faces +x, so his right is +z, toward the windows), looking at the monitor. */
export const EXECUTIVE_CAMERA = {
  position: [-10.75, 1.78, 4.47] as [number, number, number],
  lookAt: [-9.22, 1.02, 4.1] as [number, number, number],
};

export type InteractionId =
  | "monitor"
  | "minutes"
  | "arcade"
  | "kitchenette"
  | "foosball"
  | "pool"
  | "elevator"
  | "lounge";

export interface InteractionZone {
  id: InteractionId;
  x: number;
  z: number;
  radius: number;
  label: string;
}

/** Fixed interaction points, in priority order. Desks are handled separately. */
export const INTERACTION_ZONES: InteractionZone[] = [
  { id: "monitor", x: -10.4, z: 4.1, radius: 0.95, label: "use the executive desktop" },
  { id: "minutes", x: 3.65, z: -4.4, radius: 2.7, label: "read the meeting minutes" },
  { id: "arcade", x: -10.2, z: -3.2, radius: 1.2, label: "toggle the arcade lights" },
  { id: "kitchenette", x: -10.3, z: 0, radius: 1.3, label: "grab a coffee" },
  { id: "foosball", x: -7.8, z: -4.4, radius: 1.45, label: "play foosball" },
  { id: "pool", x: -2.85, z: -4.5, radius: 2.0, label: "shoot some pool" },
  { id: "elevator", x: ELEVATOR.x, z: -5.4, radius: 1.3, label: "take the elevator down" },
  { id: "lounge", x: 0, z: 3.5, radius: 1.6, label: "relax in the lounge" },
];
const DESK_INTERACT_RADIUS = 0.85;

export type FloorInteraction = { kind: "zone"; zone: InteractionZone } | { kind: "desk"; deskIndex: number } | null;

/** Zones that only exist on the Director's floor: the executive desktop, the meeting minutes and the pool table. */
const DIRECTOR_ONLY_ZONES: ReadonlySet<InteractionId> = new Set(["monitor", "minutes", "pool"]);

/**
 * The interaction available where the Director stands. The meeting-minutes zone only counts while a meeting is
 * active, and only on the Director's floor, where meetings are held; the floor below has no executive desktop or
 * pool table. Agents (aimed with the crosshair) are resolved by the controller.
 */
export function findInteraction(
  x: number,
  z: number,
  meetingActive: boolean,
  floor: FloorId = "director",
): FloorInteraction {
  const inZone = (zone: InteractionZone) => Math.hypot(x - zone.x, z - zone.z) < zone.radius;
  const upstairs = floor === "director";
  const monitor = INTERACTION_ZONES[0];
  if (upstairs && inZone(monitor)) return { kind: "zone", zone: monitor };
  const minutes = INTERACTION_ZONES[1];
  if (upstairs && meetingActive && inZone(minutes)) return { kind: "zone", zone: minutes };
  const deskIndex = DESK_INDICES_BY_FLOOR[floor].find((i) => {
    const [sx, sz] = deskSeat(i);
    return Math.hypot(x - sx, z - sz) < DESK_INTERACT_RADIUS;
  });
  if (deskIndex !== undefined) return { kind: "desk", deskIndex };
  const zone = INTERACTION_ZONES.slice(2).find(
    (candidate) => (upstairs || !DIRECTOR_ONLY_ZONES.has(candidate.id)) && inZone(candidate),
  );
  if (zone?.id === "elevator" && !upstairs) return { kind: "zone", zone: { ...zone, label: "take the elevator up" } };
  return zone ? { kind: "zone", zone } : null;
}

/**
 * Meeting attendees sit in the conference set's twelve chairs: north row west to east, then south row.
 * MEETING_SEATS are where they stand to sit down, facing the table; the chairs are SIT_BACK further out.
 */
/** Chair spacing along the meeting table; must match art/blender/build_atlas_furniture.py. */
const CONFERENCE_CHAIR_OFFSETS = [-1.85, -1.11, -0.37, 0.37, 1.11, 1.85];
const MEETING_SEAT_Z = 0.76;
/** Distance of the conference chairs from the table's centre line; must match build_atlas_furniture.py. */
export const CONFERENCE_CHAIR_Z = MEETING_SEAT_Z + SIT_BACK;
export const MEETING_SEATS: FloorPoint[] = [
  ...CONFERENCE_CHAIR_OFFSETS.map((dx): FloorPoint => [3.65 + dx, -4.4 - MEETING_SEAT_Z]),
  ...CONFERENCE_CHAIR_OFFSETS.map((dx): FloorPoint => [3.65 + dx, -4.4 + MEETING_SEAT_Z]),
];
export function meetingSeatPosition(seatIndex: number): FloorPoint {
  return MEETING_SEATS[meetingSeatIndex(seatIndex)];
}
function meetingSeatIndex(seatIndex: number): number {
  return Math.max(0, Math.floor(seatIndex)) % MEETING_SEATS.length;
}
/** Facing of a seated meeting attendee: the north row faces south (+z), the south row north. */
export function meetingSeatYaw(seatIndex: number): number {
  return meetingSeatIndex(seatIndex) < CONFERENCE_CHAIR_OFFSETS.length ? 0 : Math.PI;
}

/** Agents summoned to the executive office stand east of the guest armchairs, facing the Director's desk. */
export const CEO_VISIT_SPOTS: FloorPoint[] = [
  [-7.3, 3.5],
  [-7.3, 4.7],
  [-6.6, 3.0],
  [-6.6, 4.1],
  [-7.3, 2.6],
  [-6.6, 4.9],
];

/** Agents on break spread around the lounge, foosball table and beanbags. */
export const LOUNGE_SPOTS: FloorPoint[] = [
  [-0.9, 4.0],
  [0.9, 4.0],
  [5.6, 2.55],
  [7.2, 2.55],
  [-7.8, -5.15],
  [-7.8, -3.65],
  [6.4, 4.1],
  [2.9, 3.6],
];

/** What an agent does at a break or waiting spot: sit down, use something (coffee machine, foosball) or stand. */
export type SpotAction = "sit" | "coffee" | "foosball" | "stand";

export interface ActivitySpot {
  /** Where the agent stands; for "sit", where it stands to sit down (the seat is SIT_BACK behind). */
  point: FloorPoint;
  /** Facing (radians, 0 = +z), for every action but "stand". */
  yaw: number;
  action: SpotAction;
}

/** The espresso machine on the kitchenette counter (build_atlas_furniture.py). */
export const ESPRESSO_MACHINE: [number, number, number] = [-11.1, 0.92, -0.55];

/**
 * Where agents on a break go, in order of preference: the sofa (it faces south; seats 0.7 m apart), the coffee
 * machine, the lounge chair (faces west), the foosball table, then standing spots by the beanbags.
 */
export const BREAK_SPOTS: ActivitySpot[] = [
  { point: [0, 2.6 + SIT_BACK], yaw: 0, action: "sit" },
  { point: [ESPRESSO_MACHINE[0] + 0.65, ESPRESSO_MACHINE[2]], yaw: -Math.PI / 2, action: "coffee" },
  { point: [-0.7, 2.6 + SIT_BACK], yaw: 0, action: "sit" },
  { point: [1.9 - SIT_BACK, 3.1], yaw: -Math.PI / 2, action: "sit" },
  { point: [0.7, 2.6 + SIT_BACK], yaw: 0, action: "sit" },
  { point: [-7.8, -5.15], yaw: 0, action: "foosball" },
  { point: [-7.8, -3.65], yaw: Math.PI, action: "foosball" },
  ...LOUNGE_SPOTS.filter(([x]) => x > 4).map((point): ActivitySpot => ({ point, yaw: 0, action: "stand" })),
  { point: [-0.9, 4.15], yaw: 0, action: "stand" },
  { point: [0.9, 4.15], yaw: 0, action: "stand" },
];

/** The nook's seats on the floor below: three on the sofa (faces south) and the two armchairs (face north). */
export const NOOK_BREAK_SPOTS: ActivitySpot[] = [
  { point: [LOWER_NOOK.sofa.x, LOWER_NOOK.sofa.z + 0.1 + SIT_BACK], yaw: 0, action: "sit" },
  { point: [LOWER_NOOK.armchairWest.x, LOWER_NOOK.armchairWest.z - SIT_BACK], yaw: Math.PI, action: "sit" },
  { point: [LOWER_NOOK.sofa.x - 0.7, LOWER_NOOK.sofa.z + 0.1 + SIT_BACK], yaw: 0, action: "sit" },
  { point: [LOWER_NOOK.armchairEast.x, LOWER_NOOK.armchairEast.z - SIT_BACK], yaw: Math.PI, action: "sit" },
  { point: [LOWER_NOOK.sofa.x + 0.7, LOWER_NOOK.sofa.z + 0.1 + SIT_BACK], yaw: 0, action: "sit" },
];

/** Break spots per floor. Downstairs, the main lounge and the nook take turns so both fill up. */
export const BREAK_SPOTS_BY_FLOOR: Record<FloorId, ActivitySpot[]> = {
  director: BREAK_SPOTS,
  lower: BREAK_SPOTS.flatMap((spot, i) => (i < NOOK_BREAK_SPOTS.length ? [spot, NOOK_BREAK_SPOTS[i]] : [spot])),
};

/**
 * Agents without a desk take two seats on the corner sofa first (its main seat faces east; the hips land about
 * 0.5 m out from the west wall).
 */
export const WAITING_SEATS: ActivitySpot[] = [
  { point: [-11.0 + SIT_BACK, -4.25], yaw: Math.PI / 2, action: "sit" },
  { point: [-11.0 + SIT_BACK, -4.95], yaw: Math.PI / 2, action: "sit" },
];

/** Keyboard and mouse on each desk, relative to the desk centre (x, top surface y, z); see build_atlas_furniture.py. */
export const DESK_KEYBOARD: [number, number, number] = [-0.05, 0.77, 0.31];
export const DESK_MOUSE: [number, number, number] = [0.34, 0.77, 0.31];

/** Agents without a desk on either floor wait around the corner sofa, arcade and foosball on the floor below. */
export const HOT_DESK_SPOTS: FloorPoint[] = [
  [-9.4, -2.4],
  [-8.5, -2.4],
  [-7.6, -2.4],
  [-6.7, -2.4],
  [-9.1, -4.6],
  [-6.4, -4.4],
  [-9.1, -5.6],
  [-6.4, -5.4],
  [-9.4, -1.5],
  [-6.2, -1.5],
  [-5.8, -2.4],
  [-8.5, -1.5],
];
export const HOT_DESK_COUNT = HOT_DESK_SPOTS.length;
export function hotDeskSpot(index: number): FloorPoint {
  const [x, z] = HOT_DESK_SPOTS[index % HOT_DESK_COUNT];
  // Later rounds step a little to either side so agents do not stand on each other.
  const round = Math.floor(index / HOT_DESK_COUNT) % 3;
  return [x + [0, 0.3, -0.3][round], z];
}

const ROLE_ORDER: Record<AgentRole, number> = { vp: -1, team_leader: 0, senior: 1, junior: 2, intern: 3 };

export interface DepartmentPod {
  departmentId: string | null;
  floor: FloorId;
  /** Consecutive desks in one row. A department split across rows gets one pod per row. */
  deskIndices: number[];
  /** Where the department's sign hangs. */
  center: FloorPoint;
}

export interface DeskAssignment {
  seats: Map<string, FloorPoint>;
  /** Desk index (into DESKS, the same on both floors) for each seated agent. */
  desks: Map<string, number>;
  /** The floor of each seated agent's desk. */
  floors: Map<string, FloorId>;
  overflow: string[];
  pods: DepartmentPod[];
}

/** Desks fill the Director's floor first, then the floor below. */
const DESK_FLOORS: FloorId[] = ["director", "lower"];

/**
 * One agent per desk. Leaders are seated first, then seniors, juniors and interns, each in department order:
 * the Director's floor fills first, then the floor below, and the rest overflow. On each floor seated agents are laid out department by department along the rows so each department
 * forms a pod.
 */
export function assignDeskSeats(agents: Agent[], departments: Department[]): DeskAssignment {
  const order = new Map(departments.map((department) => [department.id, department.sort_order]));
  const departmentRank = (agent: Agent) =>
    agent.department_id && order.has(agent.department_id) ? (order.get(agent.department_id) ?? 0) : Infinity;
  const byPriority = [...agents].sort(
    (a, b) =>
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) ||
      departmentRank(a) - departmentRank(b) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  const capacity = DESK_FLOORS.reduce((total, floor) => total + DESK_INDICES_BY_FLOOR[floor].length, 0);
  const overflow = byPriority.slice(capacity).map((agent) => agent.id);

  const seats = new Map<string, FloorPoint>();
  const desks = new Map<string, number>();
  const floors = new Map<string, FloorId>();
  const pods: DepartmentPod[] = [];
  let taken = 0;
  DESK_FLOORS.forEach((floor) => {
    const floorDesks = DESK_INDICES_BY_FLOOR[floor];
    const layoutOrder = byPriority
      .slice(taken, taken + floorDesks.length)
      .sort(
        (a, b) =>
          departmentRank(a) - departmentRank(b) ||
          (a.department_id ?? "").localeCompare(b.department_id ?? "") ||
          (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
    taken += floorDesks.length;
    const floorStart = pods.length;
    layoutOrder.forEach((agent, slot) => {
      const deskIndex = floorDesks[slot];
      seats.set(agent.id, deskSeat(deskIndex));
      desks.set(agent.id, deskIndex);
      floors.set(agent.id, floor);
      const departmentId = agent.department_id && order.has(agent.department_id) ? agent.department_id : null;
      const previous = pods.length > floorStart ? pods[pods.length - 1] : undefined;
      const sameRow =
        previous && Math.floor(previous.deskIndices[0] / DESKS_PER_ROW) === Math.floor(deskIndex / DESKS_PER_ROW);
      if (previous && previous.departmentId === departmentId && sameRow) previous.deskIndices.push(deskIndex);
      else pods.push({ departmentId, floor, deskIndices: [deskIndex], center: [0, 0] });
    });
  });
  for (const pod of pods) {
    const xs = pod.deskIndices.map((index) => DESKS[index][0]);
    pod.center = [(Math.min(...xs) + Math.max(...xs)) / 2, DESKS[pod.deskIndices[0]][1]];
  }
  return { seats, desks, floors, overflow, pods };
}

export interface OfficePose {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  /** The floor the Director is on; the Director's floor when unset. */
  floor?: FloorId;
}

/** The Director arrives in the corridor in front of the glass rooms, with open floor behind the camera. */
export const DEFAULT_OFFICE_POSE: OfficePose = { x: 1.8, z: -1.25, yaw: 0, pitch: 0.12 };
