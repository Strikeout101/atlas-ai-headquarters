import type { Agent, Department, MeetingPresence, SubAgent, Task } from "../../types";
import {
  BREAK_SPOTS_BY_FLOOR,
  CEO_VISIT_SPOTS,
  DESK_SEAT_YAW,
  WAITING_SEATS,
  assignDeskSeats,
  hotDeskSpot,
  meetingSeatPosition,
  meetingSeatYaw,
  type DepartmentPod,
  type FloorId,
  type FloorPoint,
} from "./layout";

export type AtlasActivity = "working" | "idle" | "break" | "offline" | "meeting" | "ceo_visit";

export interface CeoVisit {
  seatIndex: number;
  phase: "kickoff" | "review";
  /** Visit ends at this time even if no dismiss call arrives. */
  until: number;
}

export interface AgentPlan {
  agentId: string;
  activity: AtlasActivity;
  /** The floor the agent is on now: its own floor, or the Director's for meetings and visits to his office. */
  floor: FloorId;
  /** The floor of the agent's desk (or of its waiting spot when it has none). */
  homeFloor: FloorId;
  /** Where the agent should be standing now. */
  target: FloorPoint;
  /** The agent's own desk spot (agents first appear at `target`). */
  home: FloorPoint;
  /** Set when the agent should sit at `target`, facing `yaw` (radians, 0 = +z), in the chair behind it. */
  sit: { yaw: number } | null;
  /** Set when the agent uses something at `target` (making coffee, playing foosball), facing `yaw`. */
  use: { yaw: number; kind: "coffee" | "foosball" } | null;
  /** The agent's own desk while it sits there (its hands go to that desk's keyboard and mouse). */
  deskIndex: number | null;
  taskTitle: string | null;
  activeSubAgents: number;
}

export interface AtlasPlanInput {
  agents: Agent[];
  departments: Department[];
  tasks: Task[];
  subAgents: SubAgent[];
  meetingPresence: MeetingPresence[];
  ceoVisits: ReadonlyMap<string, CeoVisit>;
  now: number;
}

export interface AtlasPlan {
  plans: Map<string, AgentPlan>;
  pods: DepartmentPod[];
}

/** Turns live company state into a position and activity for every agent. */
export function planAgents({
  agents,
  departments,
  tasks,
  subAgents,
  meetingPresence,
  ceoVisits,
  now,
}: AtlasPlanInput): AtlasPlan {
  const { seats, desks, floors, overflow, pods } = assignDeskSeats(agents, departments);
  const overflowIndex = new Map(overflow.map((id, index) => [id, index]));
  const meetingSeats = new Map(
    meetingPresence.filter((presence) => presence.until > now).map((p) => [p.agent_id, p.seat_index]),
  );
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const subAgentCounts = new Map<string, number>();
  for (const subAgent of subAgents) {
    if (subAgent.status !== "working") continue;
    subAgentCounts.set(subAgent.parentAgentId, (subAgentCounts.get(subAgent.parentAgentId) ?? 0) + 1);
  }

  const plans = new Map<string, AgentPlan>();
  // Each floor has its own lounge, so break spots are handed out per floor.
  const loungeIndex: Record<FloorId, number> = { director: 0, lower: 0 };
  for (const agent of agents) {
    // Agents with a desk sit at it; the first agents without one take seats on the corner sofa on the floor below,
    // the rest wait nearby.
    const homeFloor: FloorId = floors.get(agent.id) ?? "lower";
    let floor = homeFloor;
    const overflowAt = overflowIndex.get(agent.id);
    const receptionSeat = overflowAt !== undefined ? WAITING_SEATS[overflowAt] : undefined;
    const home = seats.get(agent.id) ?? receptionSeat?.point ?? hotDeskSpot(overflowAt ?? 0);
    const meetingSeat = meetingSeats.get(agent.id);
    const visitEntry = ceoVisits.get(agent.id);
    const visit = visitEntry && visitEntry.until > now ? visitEntry : undefined;
    let activity: AtlasActivity;
    let target: FloorPoint = home;
    let sit: AgentPlan["sit"] = seats.has(agent.id)
      ? { yaw: DESK_SEAT_YAW }
      : receptionSeat
        ? { yaw: receptionSeat.yaw }
        : null;
    let use: AgentPlan["use"] = null;
    let deskIndex = desks.get(agent.id) ?? null;
    if (meetingSeat !== undefined) {
      activity = "meeting";
      floor = "director";
      target = meetingSeatPosition(meetingSeat);
      sit = { yaw: meetingSeatYaw(meetingSeat) };
      deskIndex = null;
    } else if (visit) {
      activity = "ceo_visit";
      floor = "director";
      target = CEO_VISIT_SPOTS[visit.seatIndex % CEO_VISIT_SPOTS.length];
      sit = null;
      deskIndex = null;
    } else if (agent.status === "break") {
      activity = "break";
      const spots = BREAK_SPOTS_BY_FLOOR[homeFloor];
      const spot = spots[loungeIndex[homeFloor]++ % spots.length];
      target = spot.point;
      sit = spot.action === "sit" ? { yaw: spot.yaw } : null;
      use = spot.action === "coffee" || spot.action === "foosball" ? { yaw: spot.yaw, kind: spot.action } : null;
      deskIndex = null;
    } else {
      activity = agent.status;
    }
    const task = agent.current_task_id ? tasksById.get(agent.current_task_id) : undefined;
    plans.set(agent.id, {
      agentId: agent.id,
      activity,
      floor,
      homeFloor,
      target,
      home,
      sit,
      use,
      deskIndex,
      taskTitle: task?.title ?? null,
      activeSubAgents: subAgentCounts.get(agent.id) ?? 0,
    });
  }
  return { plans, pods };
}

export const ACTIVITY_COLORS: Record<AtlasActivity, string> = {
  working: "#5fbf8f",
  idle: "#d2a463",
  break: "#9b8cd9",
  offline: "#7d868d",
  meeting: "#5d9ccc",
  ceo_visit: "#e0c25a",
};
