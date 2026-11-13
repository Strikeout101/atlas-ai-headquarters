import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, AgentRole, Department, MeetingPresence } from "../../types";
import {
  AGENT_RADIUS,
  CEO_VISIT_SPOTS,
  DEFAULT_OFFICE_POSE,
  DESKS,
  DESK_INDICES_BY_FLOOR,
  ELEVATOR_ARRIVAL,
  EXECUTIVE_FURNITURE,
  DESK_CHAIR_OFFSET,
  DESK_DEPTH,
  EXECUTIVE_CHAIR,
  EXECUTIVE_SEAT,
  BREAK_SPOTS,
  BREAK_SPOTS_BY_FLOOR,
  LOWER_NOOK,
  NOOK_BREAK_SPOTS,
  FLOOR,
  FURNITURE,
  WAITING_SEATS,
  SIT_BACK,
  DESKS_PER_ROW,
  DOOR_WIDTH,
  HOT_DESK_COUNT,
  INTERACTION_ZONES,
  LOUNGE_SPOTS,
  MEETING_SEATS,
  ROOMS,
  assignDeskSeats,
  canOccupy,
  cameraCanOccupy,
  deskSeat,
  findInteraction,
  hotDeskSpot,
  meetingSeatPosition,
  meetingSeatYaw,
  type FloorPoint,
} from "./layout";
import { findPath, hasClearLine } from "./navigation";
import { agentFrame, facingFromView, sheetOffset, walkColumn } from "./spriteFacing";
import { planAgents } from "./agentActivity";
import { ALL_LOOKS, AGENT_LOOKS, buildLookMap, lookForSprite, modelUrl, portraitUrl } from "./agentLooks";

function department(id: string, sortOrder: number): Department {
  return {
    id,
    name: id,
    name_ko: id,
    icon: "",
    color: "#888888",
    description: null,
    prompt: null,
    sort_order: sortOrder,
    created_at: 0,
  };
}

function agent(id: string, departmentId: string | null, role: AgentRole = "junior", status: Agent["status"] = "idle") {
  return {
    id,
    name: id,
    name_ko: id,
    department_id: departmentId,
    role,
    cli_provider: "claude",
    avatar_emoji: "",
    personality: null,
    status,
    current_task_id: null,
    stats_tasks_done: 0,
    stats_xp: 0,
    created_at: 0,
  } as Agent;
}

const SIX_DEPARTMENTS = ["planning", "dev", "design", "qa", "devsecops", "operations"].map((id, i) =>
  department(id, i + 1),
);
/** Mirrors the default company: 14 agents across six departments. */
const DEFAULT_COMPANY: Agent[] = [
  agent("p-lead", "planning", "team_leader"),
  agent("p-1", "planning", "senior"),
  agent("d-lead", "dev", "team_leader"),
  agent("d-1", "dev", "senior"),
  agent("d-2", "dev"),
  agent("g-lead", "design", "team_leader"),
  agent("g-1", "design"),
  agent("q-lead", "qa", "team_leader"),
  agent("q-1", "qa", "senior"),
  agent("q-2", "qa"),
  agent("s-lead", "devsecops", "team_leader"),
  agent("s-1", "devsecops", "senior"),
  agent("o-lead", "operations", "team_leader"),
  agent("o-1", "operations", "senior"),
];

/** Desks on both floors: desk 5 is downstairs only, where the executive office is upstairs. */
const CAPACITY = DESK_INDICES_BY_FLOOR.director.length + DESK_INDICES_BY_FLOOR.lower.length;

describe("ATLAS desk assignment", () => {
  it("leaves desk 5 off the Director's floor, where the executive office is", () => {
    expect(DESK_INDICES_BY_FLOOR.director).not.toContain(5);
    expect(DESK_INDICES_BY_FLOOR.lower).toHaveLength(DESKS.length);
    const [x, z] = DESKS[5];
    expect(canOccupy(x, z, AGENT_RADIUS, "lower")).toBe(false);
    const { desks, floors } = assignDeskSeats(DEFAULT_COMPANY, SIX_DEPARTMENTS);
    for (const [id, desk] of desks) if (desk === 5) expect(floors.get(id)).toBe("lower");
  });

  it("seats leaders and seniors on the Director's floor and the rest at desks on the floor below", () => {
    const { seats, floors, overflow } = assignDeskSeats(DEFAULT_COMPANY, SIX_DEPARTMENTS);
    expect(seats.size).toBe(DEFAULT_COMPANY.length);
    expect(overflow).toEqual([]);
    const upstairs = DEFAULT_COMPANY.filter((a) => floors.get(a.id) === "director");
    expect(upstairs.length).toBe(DESK_INDICES_BY_FLOOR.director.length);
    for (const leader of DEFAULT_COMPANY.filter((a) => a.role === "team_leader"))
      expect(floors.get(leader.id)).toBe("director");
    for (const a of DEFAULT_COMPANY.filter((a) => floors.get(a.id) === "lower")) expect(a.role).not.toBe("team_leader");
  });

  it("sends agents beyond both floors' desks to the waiting area", () => {
    const crowd = [...DEFAULT_COMPANY, ...Array.from({ length: 9 }, (_, i) => agent(`extra-${i}`, "dev", "intern"))];
    const { seats, overflow } = assignDeskSeats(crowd, SIX_DEPARTMENTS);
    expect(seats.size).toBe(CAPACITY);
    expect(overflow.length).toBe(crowd.length - CAPACITY);
    for (const id of overflow) expect(crowd.find((a) => a.id === id)!.role).toBe("intern");
  });

  it("keeps each department on consecutive desks in one row on each floor", () => {
    const { pods } = assignDeskSeats(DEFAULT_COMPANY, SIX_DEPARTMENTS);
    for (const floor of ["director", "lower"] as const) {
      const order = pods
        .filter((pod) => pod.floor === floor)
        .map((pod) => SIX_DEPARTMENTS.findIndex((d) => d.id === pod.departmentId));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
    for (const pod of pods) {
      expect(new Set(pod.deskIndices.map((i) => Math.floor(i / DESKS_PER_ROW))).size).toBe(1);
      pod.deskIndices.forEach((index, i) => i > 0 && expect(index).toBe(pod.deskIndices[i - 1] + 1));
    }
  });

  it("puts every seat on walkable floor", () => {
    const { seats } = assignDeskSeats(DEFAULT_COMPANY, SIX_DEPARTMENTS);
    for (const [x, z] of seats.values()) expect(canOccupy(x, z, AGENT_RADIUS), `${x},${z}`).toBe(true);
  });

  it("groups agents without a known department after the others", () => {
    const { pods } = assignDeskSeats([agent("x", null), agent("y", "qa")], SIX_DEPARTMENTS);
    expect(pods.map((pod) => pod.departmentId)).toEqual(["qa", null]);
  });
});

describe("ATLAS spots", () => {
  it("keeps meeting, visit, lounge and waiting spots walkable and reachable", () => {
    const spots: FloorPoint[] = [
      ...MEETING_SEATS,
      ...CEO_VISIT_SPOTS,
      ...LOUNGE_SPOTS,
      ...Array.from({ length: HOT_DESK_COUNT * 3 }, (_, i) => hotDeskSpot(i)),
    ];
    for (const [x, z] of spots) {
      expect(canOccupy(x, z, AGENT_RADIUS), `${x},${z}`).toBe(true);
      const path = findPath(deskSeat(0), [x, z]);
      expect(path[path.length - 1]).toEqual([x, z]);
    }
  });

  it("gives every waiting agent its own spot", () => {
    const keys = new Set(Array.from({ length: HOT_DESK_COUNT * 3 }, (_, i) => hotDeskSpot(i).join(":")));
    expect(keys.size).toBe(HOT_DESK_COUNT * 3);
  });

  it("starts the Director on open floor with room for the camera behind", () => {
    expect(canOccupy(DEFAULT_OFFICE_POSE.x, DEFAULT_OFFICE_POSE.z)).toBe(true);
    for (let back = 0; back <= 3; back += 0.25) {
      expect(canOccupy(DEFAULT_OFFICE_POSE.x + 0.42, DEFAULT_OFFICE_POSE.z + back, 0.12), `${back}`).toBe(true);
    }
  });
});

describe("ATLAS navigation", () => {
  function pathIsWalkable(from: FloorPoint, path: FloorPoint[]) {
    let previous = from;
    for (const point of path) {
      expect(hasClearLine(previous, point), `${previous} -> ${point}`).toBe(true);
      previous = point;
    }
  }

  it("walks from a desk through the conference doorway to a meeting seat", () => {
    const from = deskSeat(5);
    const to = meetingSeatPosition(0);
    const path = findPath(from, to);
    expect(path[path.length - 1]).toEqual(to);
    pathIsWalkable(from, path);
    const doorX = ROOMS.conference.doorX;
    expect(
      path.some(([x, z]) => Math.abs(x - doorX) < DOOR_WIDTH / 2 && Math.abs(z - ROOMS.conference.maxZ) < 0.6),
    ).toBe(true);
  });

  it("reaches the executive office from the lounge", () => {
    const from = LOUNGE_SPOTS[0];
    const to = CEO_VISIT_SPOTS[0];
    const path = findPath(from, to);
    expect(path[path.length - 1]).toEqual(to);
    pathIsWalkable(from, path);
  });

  it("goes straight when nothing is in the way", () => {
    expect(findPath([0, 1.6], [2, 1.6])).toEqual([[2, 1.6]]);
  });
});

describe("ATLAS interactions", () => {
  it("offers the executive desktop from behind the desk", () => {
    expect(findInteraction(-10.4, 4.1, false)).toMatchObject({ kind: "zone", zone: { id: "monitor" } });
    expect(canOccupy(-10.4, 4.1)).toBe(true);
  });
  it("offers meeting minutes only while a meeting is active", () => {
    expect(findInteraction(3.65, -2.9, true)).toMatchObject({ kind: "zone", zone: { id: "minutes" } });
    expect(findInteraction(3.65, -2.9, false)).toBe(null);
  });
  it("offers a desk's department at its seat", () => {
    const [x, z] = deskSeat(7);
    expect(findInteraction(x, z + 0.3, false)).toEqual({ kind: "desk", deskIndex: 7 });
  });
  it("offers the arcade, kitchenette, foosball and elevator", () => {
    expect(findInteraction(-10.2, -3.2, false)).toMatchObject({ zone: { id: "arcade" } });
    expect(findInteraction(-10.0, 0, false)).toMatchObject({ zone: { id: "kitchenette" } });
    expect(findInteraction(-7.8, -3.4, false)).toMatchObject({ zone: { id: "foosball" } });
    expect(findInteraction(-2.85, -3.3, false)).toMatchObject({ zone: { id: "pool" } });
    expect(findInteraction(9.3, -5.6, false)).toMatchObject({ zone: { id: "elevator" } });
  });
  it("can reach every interaction point on foot", () => {
    for (const zone of INTERACTION_ZONES) {
      const reachable = Array.from({ length: 24 }, (_, i) => {
        const angle = (i / 24) * Math.PI * 2;
        return [
          zone.x + Math.cos(angle) * zone.radius * 0.7,
          zone.z + Math.sin(angle) * zone.radius * 0.7,
        ] as FloorPoint;
      }).some(([x, z]) => canOccupy(x, z));
      expect(reachable || canOccupy(zone.x, zone.z), zone.id).toBe(true);
    }
  });
});

describe("Director sprite facing", () => {
  // Camera behind the player looking toward -z.
  const view: [number, number] = [0, -1];
  it("shows the back when walking away from the camera", () => {
    expect(facingFromView(0, -1, ...view)).toBe("back");
  });
  it("shows the front when walking toward the camera", () => {
    expect(facingFromView(0, 1, ...view, "back")).toBe("front");
  });
  it("shows the matching side when strafing", () => {
    expect(facingFromView(1, 0, ...view)).toBe("right");
    expect(facingFromView(-1, 0, ...view)).toBe("left");
  });
  it("stays on the current row through near-diagonal movement", () => {
    expect(facingFromView(1, -0.95, ...view, "back")).toBe("back");
    expect(facingFromView(1, -0.6, ...view, "back")).toBe("right");
  });
  it("cycles step, pass, step, pass by distance and stands still when idle", () => {
    expect([0, 0.35, 0.7, 1.05, 1.4].map((d) => walkColumn(d, true))).toEqual([0, 1, 2, 1, 0]);
    expect(walkColumn(3, false)).toBe(1);
  });
  it("maps sheet cells to texture offsets", () => {
    expect(sheetOffset(0, 0)).toEqual([0, 0.75]);
    expect(sheetOffset(2, 3)).toEqual([2 / 3, 0]);
  });
  it("uses side frames for agents walking sideways", () => {
    expect(agentFrame("left", 0, true)).toBe("L-1");
    expect(agentFrame("front", 0.4, true)).toBe("D-2");
    expect(agentFrame("right", 0, false)).toBe("D-1");
  });
});

describe("ATLAS activity plan", () => {
  const base = {
    agents: DEFAULT_COMPANY,
    departments: SIX_DEPARTMENTS,
    tasks: [],
    subAgents: [],
    meetingPresence: [] as MeetingPresence[],
    ceoVisits: new Map(),
    now: 1_000,
  };

  it("sends meeting attendees to their conference seat until the meeting ends", () => {
    const presence: MeetingPresence = { agent_id: "d-1", seat_index: 3, phase: "kickoff", task_id: null, until: 2_000 };
    const during = planAgents({ ...base, meetingPresence: [presence] }).plans.get("d-1")!;
    expect(during.activity).toBe("meeting");
    expect(during.target).toEqual(meetingSeatPosition(3));
    const after = planAgents({ ...base, meetingPresence: [presence], now: 3_000 }).plans.get("d-1")!;
    expect(after.target).toEqual(after.home);
  });

  it("brings summoned agents to the executive office and break agents to the lounge", () => {
    const agents = DEFAULT_COMPANY.map((a) => (a.id === "q-2" ? { ...a, status: "break" as const } : a));
    const visits = new Map([["g-1", { seatIndex: 1, phase: "review" as const, until: 5_000 }]]);
    const { plans } = planAgents({ ...base, agents, ceoVisits: visits });
    expect(plans.get("g-1")!.target).toEqual(CEO_VISIT_SPOTS[1]);
    expect(plans.get("q-2")!.activity).toBe("break");
    expect(plans.get("q-2")!.target).toEqual(BREAK_SPOTS[0].point);
    const later = planAgents({ ...base, agents, ceoVisits: visits, now: 6_000 }).plans.get("g-1")!;
    expect(later.target).toEqual(later.home);
  });

  it("reports the current task title and working sub-agents", () => {
    const agents = DEFAULT_COMPANY.map((a) =>
      a.id === "d-lead" ? { ...a, status: "working" as const, current_task_id: "t1" } : a,
    );
    const { plans } = planAgents({
      ...base,
      agents,
      tasks: [{ id: "t1", title: "Ship login" } as never],
      subAgents: [
        { id: "s1", parentAgentId: "d-lead", task: "x", status: "working" },
        { id: "s2", parentAgentId: "d-lead", task: "y", status: "done" },
      ],
    });
    expect(plans.get("d-lead")).toMatchObject({ activity: "working", taskTitle: "Ship login", activeSubAgents: 1 });
  });
});

describe("ATLAS sitting", () => {
  const base = {
    agents: DEFAULT_COMPANY,
    departments: SIX_DEPARTMENTS,
    tasks: [],
    subAgents: [],
    meetingPresence: [] as MeetingPresence[],
    ceoVisits: new Map(),
    now: 1_000,
  };

  it("seats agents with a desk at it, the first two without one in the reception chairs, the rest standing", () => {
    const crowd = [...DEFAULT_COMPANY, ...Array.from({ length: 10 }, (_, i) => agent(`extra-${i}`, "dev", "intern"))];
    const { plans } = planAgents({ ...base, agents: crowd });
    const atDesks = [...plans.values()].filter((plan) => plan.deskIndex !== null);
    expect(atDesks.length).toBe(CAPACITY);
    for (const plan of atDesks) {
      expect(plan.sit).toEqual({ yaw: Math.PI });
      expect(plan.target).toEqual(deskSeat(plan.deskIndex as number));
    }
    const reception = [...plans.values()].filter((plan) => plan.deskIndex === null && plan.sit);
    expect(reception.map((plan) => plan.target.join(",")).sort()).toEqual(
      WAITING_SEATS.map((seat) => seat.point.join(",")).sort(),
    );
    expect([...plans.values()].filter((plan) => !plan.sit).length).toBe(crowd.length - CAPACITY - 2);
    // Agents without a desk wait on the floor below.
    for (const plan of plans.values()) if (plan.deskIndex === null) expect(plan.floor).toBe("lower");
  });

  it("seats meeting attendees facing the table and agents on break on the sofa, and keeps visitors standing", () => {
    const presence: MeetingPresence[] = [
      { agent_id: "d-1", seat_index: 1, phase: "kickoff", task_id: null, until: 2_000 },
      { agent_id: "d-2", seat_index: 8, phase: "kickoff", task_id: null, until: 2_000 },
    ];
    const agents = DEFAULT_COMPANY.map((a) => (a.id === "q-2" ? { ...a, status: "break" as const } : a));
    const visits = new Map([["g-1", { seatIndex: 0, phase: "review" as const, until: 5_000 }]]);
    const { plans } = planAgents({ ...base, agents, meetingPresence: presence, ceoVisits: visits });
    expect(plans.get("d-1")!.sit).toEqual({ yaw: 0 });
    expect(plans.get("d-2")!.sit).toEqual({ yaw: Math.PI });
    expect(plans.get("g-1")!.sit).toBeNull();
    expect(plans.get("q-2")!.sit).toEqual({ yaw: BREAK_SPOTS[0].yaw }); // first break spot: the sofa
  });

  it("puts each meeting chair behind its seat, facing the table, clear of the table top", () => {
    const table = FURNITURE.conferenceTable;
    MEETING_SEATS.forEach(([x, z], i) => {
      const yaw = meetingSeatYaw(i);
      // Facing the table: the table centre lies in front of the seated agent.
      expect(Math.cos(yaw) * (table.z - z)).toBeGreaterThan(0);
      const hipsZ = z - Math.cos(yaw) * SIT_BACK;
      expect(Math.abs(hipsZ - table.z)).toBeGreaterThan(1.15 / 2 + 0.3);
      expect(Math.abs(hipsZ - table.z)).toBeLessThan(1.15 / 2 + 0.6);
      expect(x).toBeGreaterThan(table.x - table.width / 2);
    });
  });

  it("pulls desk chairs out to where a seated agent's hips land", () => {
    expect(DESK_CHAIR_OFFSET).toBeCloseTo(deskSeat(0)[1] - DESKS[0][1] + SIT_BACK);
    expect(DESK_CHAIR_OFFSET - DESK_DEPTH / 2).toBeGreaterThan(0.3);
  });

  it("puts the Director's seat between the executive chair and desk, facing the monitor (east)", () => {
    const desk = FURNITURE.executiveDesk;
    expect(EXECUTIVE_SEAT.yaw).toBeCloseTo(Math.PI / 2);
    expect(EXECUTIVE_CHAIR[0]).toBeCloseTo(EXECUTIVE_SEAT.x - SIT_BACK);
    expect(EXECUTIVE_CHAIR[1]).toBeCloseTo(EXECUTIVE_SEAT.z);
    // Knees under the desk's west edge, the chair clear of the bookshelf on the west wall.
    expect(EXECUTIVE_SEAT.x).toBeLessThan(desk.x - desk.width / 2 + 0.05);
    expect(EXECUTIVE_SEAT.x).toBeGreaterThan(desk.x - desk.width / 2 - 0.3);
    expect(EXECUTIVE_CHAIR[0]).toBeGreaterThan(FURNITURE.bookshelf.x + FURNITURE.bookshelf.width / 2 + 0.3);
    expect(findInteraction(EXECUTIVE_SEAT.x, EXECUTIVE_SEAT.z, false)).toMatchObject({ zone: { id: "monitor" } });
  });

  it("keeps the executive office inside its glass walls, reachable through the north door", () => {
    const room = ROOMS.executive;
    for (const rect of Object.values(EXECUTIVE_FURNITURE)) {
      expect(rect.x - rect.width / 2, `${rect.x},${rect.z}`).toBeGreaterThanOrEqual(room.minX - 0.01);
      expect(rect.x + rect.width / 2, `${rect.x},${rect.z}`).toBeLessThan(room.maxX);
      expect(rect.z - rect.depth / 2, `${rect.x},${rect.z}`).toBeGreaterThan(room.minZ);
    }
    // The north wall blocks everywhere but the doorway.
    expect(canOccupy(room.doorX - 1.5, room.minZ, AGENT_RADIUS)).toBe(false);
    expect(canOccupy(room.doorX, room.minZ, AGENT_RADIUS)).toBe(true);
    for (const spot of CEO_VISIT_SPOTS) {
      const path = findPath(deskSeat(1), spot);
      expect(path[path.length - 1]).toEqual(spot);
      for (const point of path) expect(point[0] < room.maxX || point[1] < room.minZ, `${point}`).toBe(true);
    }
    // The monitor zone is reachable on foot from the corridor.
    const toDesk = findPath([-5.5, 0.9], [EXECUTIVE_SEAT.x - 0.2, EXECUTIVE_SEAT.z], "director");
    expect(toDesk[toDesk.length - 1]).toEqual([EXECUTIVE_SEAT.x - 0.2, EXECUTIVE_SEAT.z]);
  });
});

describe("ATLAS agent looks", () => {
  const publicFile = (url: string) => resolve(__dirname, "../../../public", url.replace(/^\//, ""));

  it("gives every look a built model and headshot", () => {
    for (const look of ALL_LOOKS) {
      expect(existsSync(publicFile(modelUrl(look))), modelUrl(look)).toBe(true);
      expect(existsSync(publicFile(portraitUrl(look))), portraitUrl(look)).toBe(true);
    }
    expect(new Set(ALL_LOOKS.map((look) => look.key)).size).toBe(ALL_LOOKS.length);
  });

  it("gives each of the fourteen sprite numbers its own person", () => {
    const keys = Array.from({ length: 14 }, (_, i) => lookForSprite(i + 1).key);
    expect(new Set(keys).size).toBe(14);
    expect(lookForSprite(0)).toBe(lookForSprite(1));
  });

  it("gives agents that share a sprite number different people, the same way every time", () => {
    // 22 agents: sprite numbers repeat (1-12 auto-assigned, plus a few chosen ones).
    const sprites = new Map(Array.from({ length: 22 }, (_, i) => [`agent-${String(i).padStart(2, "0")}`, (i % 12) + 1]));
    sprites.set("agent-doro", 13);
    const looks = buildLookMap(sprites);
    expect(new Set([...looks.values()].map((look) => look.key)).size).toBe(sprites.size);
    expect(looks.get("agent-00")).toBe(lookForSprite(1)); // first agent with a sprite keeps its own look
    expect(looks.get("agent-doro")).toBe(lookForSprite(13));
    expect(buildLookMap(new Map(sprites)).get("agent-21")).toEqual(looks.get("agent-21"));
  });
});

describe("ATLAS screens and city", () => {
  it("cleans terminal output down to the latest printable lines", async () => {
    const { cleanTerminalLines } = await import("./screenArt");
    const text = "\u001b[32m$ pnpm test\u001b[0m\r\n\n ✓ a.test.ts\n\t× b.test.ts\u0007\n\n";
    expect(cleanTerminalLines(text, 10)).toEqual(["$ pnpm test", " ✓ a.test.ts", "  × b.test.ts"]);
    expect(cleanTerminalLines(text, 1)).toEqual(["  × b.test.ts"]);
    expect(cleanTerminalLines("", 5)).toEqual([]);
  });

  it("builds the same city every time, around the ATLAS tower but never on it", async () => {
    const { cityLayout } = await import("./OfficeCity");
    const city = cityLayout();
    expect(city.length).toBeGreaterThan(100);
    expect(cityLayout()).toEqual(city);
    const towerHalfX = (FLOOR.maxX - FLOOR.minX) / 2 + 1;
    const towerHalfZ = (FLOOR.maxZ - FLOOR.minZ) / 2 + 1;
    for (const box of city) {
      const clear =
        Math.abs(box.x) - box.width / 2 > towerHalfX || Math.abs(box.z) - box.depth / 2 > towerHalfZ;
      expect(clear, `${box.x},${box.z}`).toBe(true);
      // Most roofs are below the office floor (y = 0); the street is at STREET_Y.
    }
    const { STREET_Y } = await import("./OfficeCity");
    const below = city.filter((box) => STREET_Y + box.height < 0).length;
    expect(below / city.length).toBeGreaterThan(0.8);
  });
});

describe("ATLAS breaks", () => {
  const base = {
    agents: DEFAULT_COMPANY,
    departments: SIX_DEPARTMENTS,
    tasks: [],
    subAgents: [],
    meetingPresence: [] as MeetingPresence[],
    ceoVisits: new Map(),
    now: 1_000,
  };

  it("sends agents on a break to the sofa, the coffee machine, the lounge chair and the foosball table", () => {
    // Few enough agents that all of them work (and take their breaks) on the Director's floor.
    const agents = DEFAULT_COMPANY.slice(0, DESK_INDICES_BY_FLOOR.director.length).map((a, i) => (i < 6 ? { ...a, status: "break" as const } : a));
    const plans = [...planAgents({ ...base, agents }).plans.values()].filter((plan) => plan.activity === "break");
    expect(plans.map((plan) => (plan.sit ? "sit" : (plan.use?.kind ?? "stand")))).toEqual([
      "sit",
      "coffee",
      "sit",
      "sit",
      "sit",
      "foosball",
    ]);
    for (const plan of plans) expect(plan.deskIndex).toBeNull();
  });

  it("reaches the reception chairs, like desk chairs, by walking straight to them", () => {
    for (const spot of WAITING_SEATS) {
      const path = findPath(deskSeat(2), spot.point);
      expect(path[path.length - 1]).toEqual(spot.point);
    }
  });

  it("reaches every break spot from the front, never through the sofa or the lounge chair", () => {
    for (const spot of BREAK_SPOTS) {
      const path = findPath(deskSeat(2), spot.point);
      expect(path[path.length - 1]).toEqual(spot.point);
      // Spots on open floor are walked to directly; seats inside the furniture's footprint need a front approach.
      if (spot.action === "stand" || canOccupy(spot.point[0], spot.point[1], AGENT_RADIUS)) continue;
      // The last leg into a seat or onto a counter starts in front of it (where the agent will face from).
      const before = path.length > 1 ? path[path.length - 2] : deskSeat(2);
      const towardStart = [before[0] - spot.point[0], before[1] - spot.point[1]];
      const facing = [Math.sin(spot.yaw), Math.cos(spot.yaw)];
      const length = Math.hypot(towardStart[0], towardStart[1]);
      expect(length, `${spot.point}`).toBeLessThan(0.6);
      expect(towardStart[0] * facing[0] + towardStart[1] * facing[1], `${spot.point}`).toBeGreaterThan(-0.05);
    }
  });
});


describe("ATLAS lower floor", () => {
  const base = {
    agents: DEFAULT_COMPANY,
    departments: SIX_DEPARTMENTS,
    tasks: [],
    subAgents: [],
    meetingPresence: [] as MeetingPresence[],
    ceoVisits: new Map(),
    now: 1_000,
  };
  const lowerAgent = () => {
    const { floors } = assignDeskSeats(DEFAULT_COMPANY, SIX_DEPARTMENTS);
    return DEFAULT_COMPANY.find((a) => floors.get(a.id) === "lower")!;
  };

  it("has no executive office: its walls, desk and bookshelf are open floor or desk 5", () => {
    // The office's glass north wall (west of its door) and east wall are open floor downstairs.
    expect(canOccupy(-9.5, ROOMS.executive.minZ, AGENT_RADIUS, "director")).toBe(false);
    expect(canOccupy(-9.5, ROOMS.executive.minZ, AGENT_RADIUS, "lower")).toBe(true);
    expect(canOccupy(ROOMS.executive.maxX, 3.0, AGENT_RADIUS, "director")).toBe(false);
    expect(canOccupy(ROOMS.executive.maxX, 3.0, AGENT_RADIUS, "lower")).toBe(true);
    expect(cameraCanOccupy(FURNITURE.bookshelf.x, FURNITURE.bookshelf.z, 0.15, "lower")).toBe(true);
    expect(canOccupy(FURNITURE.executiveDesk.x, FURNITURE.executiveDesk.z, AGENT_RADIUS, "lower")).toBe(true);
    // The conference room keeps its glass on both floors.
    expect(canOccupy(ROOMS.conference.minX, -4, AGENT_RADIUS, "lower")).toBe(false);
    // Walks straight across where the office's east glass wall stands upstairs.
    expect(findPath([-5.4, 3.0], [-7.0, 3.0], "lower")).toEqual([[-7.0, 3.0]]);
    expect(findPath([-5.4, 3.0], [-7.0, 3.0], "director").length).toBeGreaterThan(1);
  });

  it("has a lounge nook instead of the pool table", () => {
    expect(canOccupy(FURNITURE.poolTable.x, FURNITURE.poolTable.z, AGENT_RADIUS, "director")).toBe(false);
    expect(findInteraction(-2.85, -3.3, false, "lower")).toBe(null);
  });

  it("offers no executive desktop or meeting minutes downstairs, and the elevator goes back up", () => {
    expect(findInteraction(-10.4, 4.1, false, "lower")?.kind === "zone").toBe(false);
    expect(findInteraction(3.65, -2.9, true, "lower")).toBe(null);
    expect(findInteraction(9.3, -5.6, false, "lower")).toMatchObject({
      zone: { id: "elevator", label: "take the elevator up" },
    });
    expect(findInteraction(9.3, -5.6, false, "director")).toMatchObject({ zone: { label: "take the elevator down" } });
    expect(canOccupy(ELEVATOR_ARRIVAL.x, ELEVATOR_ARRIVAL.z, undefined, "lower")).toBe(true);
    expect(canOccupy(ELEVATOR_ARRIVAL.x, ELEVATOR_ARRIVAL.z, undefined, "director")).toBe(true);
  });

  it("brings agents from the floor below up for meetings and visits, and back down afterwards", () => {
    const downstairs = lowerAgent();
    const presence: MeetingPresence = {
      agent_id: downstairs.id,
      seat_index: 2,
      phase: "kickoff",
      task_id: null,
      until: 2_000,
    };
    const during = planAgents({ ...base, meetingPresence: [presence] }).plans.get(downstairs.id)!;
    expect(during).toMatchObject({ floor: "director", homeFloor: "lower", activity: "meeting" });
    const after = planAgents({ ...base, meetingPresence: [presence], now: 3_000 }).plans.get(downstairs.id)!;
    expect(after).toMatchObject({ floor: "lower", homeFloor: "lower" });
    const visits = new Map([[downstairs.id, { seatIndex: 0, phase: "review" as const, until: 5_000 }]]);
    expect(planAgents({ ...base, ceoVisits: visits }).plans.get(downstairs.id)!.floor).toBe("director");
  });

  it("gives each floor its own lounge for breaks", () => {
    const downstairs = lowerAgent();
    const agents = DEFAULT_COMPANY.map((a) =>
      a.id === downstairs.id || a.id === "p-lead" ? { ...a, status: "break" as const } : a,
    );
    const { plans } = planAgents({ ...base, agents });
    expect(plans.get("p-lead")).toMatchObject({ floor: "director", target: BREAK_SPOTS[0].point });
    expect(plans.get(downstairs.id)).toMatchObject({ floor: "lower", target: BREAK_SPOTS[0].point });
  });
});

describe("ATLAS lower floor lounge nook", () => {
  it("blocks the nook furniture downstairs only", () => {
    for (const rect of Object.values(LOWER_NOOK)) {
      expect(canOccupy(rect.x, rect.z, AGENT_RADIUS, "lower"), `${rect.x},${rect.z}`).toBe(false);
    }
    expect(canOccupy(LOWER_NOOK.sofa.x, LOWER_NOOK.sofa.z + 1.6, AGENT_RADIUS, "lower")).toBe(false); // coffee table
    expect(canOccupy(-1.0, -3.0, AGENT_RADIUS, "lower")).toBe(true);
  });

  it("reaches every nook seat from the front, and both lounges are used downstairs", () => {
    for (const spot of NOOK_BREAK_SPOTS) {
      const path = findPath(deskSeat(2), spot.point, "lower");
      expect(path[path.length - 1]).toEqual(spot.point);
      if (canOccupy(spot.point[0], spot.point[1], AGENT_RADIUS, "lower")) continue;
      const before = path.length > 1 ? path[path.length - 2] : deskSeat(2);
      const towardStart = [before[0] - spot.point[0], before[1] - spot.point[1]];
      const facing = [Math.sin(spot.yaw), Math.cos(spot.yaw)];
      expect(Math.hypot(towardStart[0], towardStart[1]), `${spot.point}`).toBeLessThan(0.6);
      expect(towardStart[0] * facing[0] + towardStart[1] * facing[1], `${spot.point}`).toBeGreaterThan(-0.05);
    }
    expect(BREAK_SPOTS_BY_FLOOR.lower[1]).toBe(NOOK_BREAK_SPOTS[0]);
    expect(BREAK_SPOTS_BY_FLOOR.director).toBe(BREAK_SPOTS);
  });
});
