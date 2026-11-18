import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { SRGBColorSpace, Vector3, type Group, type Mesh, type MeshBasicMaterial, type Texture } from "three";
import { buildSpriteMap } from "../AgentAvatar";
import type { Agent, Department, MeetingPresence, SubAgent, Task } from "../../types";
import { ACTIVITY_COLORS, planAgents, type AgentPlan, type CeoVisit } from "./agentActivity";
import { FaceCamera, LabelPlate, truncate } from "./CanvasLabel";
import {
  DESKS,
  DESK_KEYBOARD,
  DESK_MOUSE,
  ELEVATOR_ARRIVAL,
  ESPRESSO_MACHINE,
  FURNITURE,
  type FloorId,
  type FloorPoint,
  type OfficePose,
} from "./layout";
import { handTargets } from "./armIK";
import { findPath } from "./navigation";
import { agentFrame, facingFromView, type AgentFrame, type Facing } from "./spriteFacing";
import AgentModel, { type AgentLook, type AgentPose } from "./AgentModel";
import { buildLookMap, lookForSprite } from "./agentLooks";

export interface AgentSpeech {
  line: string;
  until: number;
}

type Language = "en";

export function localName(
  entity: { name: string; name_ko: string; name_ja?: string | null; name_zh?: string | null },
  language: Language,
): string {
  return entity.name;
}

const FRAME_KEYS: AgentFrame[] = ["D-1", "D-2", "D-3", "L-1", "R-1"];
const AGENT_HEIGHT = 1.4;
/** Labels sit above the 3D models' heads (the pixel sprites are shorter). */
const MODEL_LABEL_HEIGHT = 1.92;
const TURN_RATE = 8;
/** Labels drop while seated so they stay just above the head. */
const SEATED_LABEL_DROP = 0.42;
/** How closely an agent must face its seat direction before it lowers itself into the chair. */
const SIT_FACING_TOLERANCE = 0.12;
/** Fallback for the sprite (no model to report the clip ending): how long sitting down or standing up takes. */
const SIT_TRANSITION_TIMEOUT = 2.5;

/**
 * Sitting is a small state machine. An agent walks to its seat standing, turns to face the desk or table, plays
 * the sit-down clip (which lowers its hips back into the chair), loops a seated clip, and plays the stand-up clip
 * before walking anywhere else.
 */
type SeatState = "standing" | "sittingDown" | "seated" | "standingUp";

/** Where an agent looks while standing still, by activity (models face +Z at rotation 0). */
function restingYaw(activity: AgentPlan["activity"], x: number, z: number): number | null {
  const toward = (tx: number, tz: number) => Math.atan2(tx - x, tz - z);
  switch (activity) {
    case "working":
    case "idle":
    case "offline":
      return Math.PI; // desks are north of the seats
    case "meeting":
      return toward(FURNITURE.conferenceTable.x, FURNITURE.conferenceTable.z);
    case "ceo_visit":
      return toward(FURNITURE.executiveDesk.x, FURNITURE.executiveDesk.z);
    default:
      return null;
  }
}

/** Reports a 3D model that fails to load, so the agent falls back to its pixel sprite. */
class ModelBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFail();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** What the per-frame movement code shares with the fallback sprite. */
interface SpriteMotion {
  moving: boolean;
  walked: number;
  heading: [number, number];
}

/**
 * The agent's pixel-art sprite: only loaded and shown when its 3D model fails, so the five sprite images are not
 * downloaded and uploaded for every agent on every visit.
 */
function AgentSprite({
  spriteNumber,
  offline,
  activity,
  agentId,
  motion,
  position,
}: {
  spriteNumber: number;
  offline: boolean;
  activity: AgentPlan["activity"];
  agentId: string;
  motion: MutableRefObject<SpriteMotion>;
  position: MutableRefObject<Vector3>;
}) {
  const loaded = useTexture(FRAME_KEYS.map((key) => `/sprites/${spriteNumber}-${key}.png`));
  const frames = useMemo(() => {
    const byKey = new Map<AgentFrame, Texture>();
    loaded.forEach((texture, i) => {
      if (texture.colorSpace !== SRGBColorSpace) {
        texture.colorSpace = SRGBColorSpace;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
      }
      byKey.set(FRAME_KEYS[i], texture);
    });
    return byKey;
  }, [loaded]);
  const body = useRef<Group>(null);
  const sprite = useRef<Mesh>(null);
  const material = useRef<MeshBasicMaterial>(null);
  const facing = useRef<Facing>("front");
  const currentFrame = useRef<AgentFrame | null>(null);

  useFrame(({ camera, clock }) => {
    const { moving, walked, heading } = motion.current;
    const viewX = position.current.x - camera.position.x;
    const viewZ = position.current.z - camera.position.z;
    if (body.current) body.current.rotation.y = Math.atan2(-viewX, -viewZ);
    facing.current = moving ? facingFromView(heading[0], heading[1], viewX, viewZ, facing.current) : "front";
    const frameKey = agentFrame(facing.current, walked, moving);
    const texture = frames.get(frameKey);
    if (frameKey !== currentFrame.current && texture && material.current && sprite.current) {
      currentFrame.current = frameKey;
      material.current.map = texture;
      const image = texture.image as { width?: number; height?: number } | undefined;
      const aspect = image?.width && image?.height ? image.width / image.height : 0.6;
      sprite.current.scale.set(AGENT_HEIGHT * aspect, AGENT_HEIGHT, 1);
    }
    if (sprite.current) {
      const t = clock.elapsedTime + (agentId.charCodeAt(0) % 7);
      const bob =
        !moving && activity === "working"
          ? Math.abs(Math.sin(t * 7)) * 0.018
          : !moving && activity === "break"
            ? Math.sin(t * 1.6) * 0.012
            : 0;
      sprite.current.position.y = AGENT_HEIGHT / 2 + bob;
    }
  });

  return (
    <group ref={body}>
      <mesh ref={sprite} position={[0, AGENT_HEIGHT / 2, 0]} scale={[AGENT_HEIGHT * 0.6, AGENT_HEIGHT, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          ref={material}
          map={frames.get("D-1")}
          transparent
          alphaTest={0.1}
          opacity={offline ? 0.45 : 1}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function ModelReady({ onReady }: { onReady: () => void }) {
  useEffect(() => onReady(), [onReady]);
  return null;
}
const WALK_SPEED = 1.5;
const DETAIL_RANGE = 4.2;
const ACTIVITY_LABELS: Record<AgentPlan["activity"], string> = {
  working: "Working",
  idle: "Idle",
  break: "On break",
  offline: "Offline",
  meeting: "In meeting",
  ceo_visit: "Reporting to you",
};

function AtlasAgent({
  agent,
  plan,
  departmentName,
  departmentColor,
  spriteNumber,
  look,
  speech,
  unread,
  pose,
  spawn,
  targetAgentId,
  positions,
  onSelect,
}: {
  agent: Agent;
  look: AgentLook;
  plan: AgentPlan;
  /** Where the agent first appears when it is not already at its target (stepping out of the elevator). */
  spawn: FloorPoint | null;
  departmentName: string | null;
  departmentColor: string;
  spriteNumber: number;
  speech: AgentSpeech | undefined;
  unread: boolean;
  pose: OfficePose;
  targetAgentId: MutableRefObject<string | null>;
  positions: MutableRefObject<Map<string, Vector3>>;
  onSelect: (agent: Agent) => void;
}) {
  const root = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const spriteMotion = useRef<SpriteMotion>({ moving: false, walked: 0, heading: [0, 1] });
  const [modelFailed, setModelFailed] = useState(false);
  const markFailed = useMemo(() => () => setModelFailed(true), []);
  const start = spawn ?? plan.target;
  const position = useRef(new Vector3(start[0], 0, start[1]));
  const path = useRef<Array<[number, number]>>([]);
  const walked = useRef(0);
  const heading = useRef<[number, number]>([0, 1]);
  const [showDetails, setShowDetails] = useState(false);
  const model = useRef<Group>(null);
  const modelPose = useRef<AgentPose>("idle");
  const clipFinished = useRef(false);
  /** Hands on the keyboard / mouse while working at the desk (see armIK.ts); `onMouse` flips every few seconds. */
  const hands = useRef(handTargets());
  const handUse = useRef({ onMouse: false, until: 0, phase: Math.random() * 10 });
  const modelYaw = useRef(plan.sit?.yaw ?? Math.PI);
  /** Agents that first appear in their seat start seated instead of sitting down on load. */
  const seat = useRef<{ state: SeatState; elapsed: number }>({
    state: plan.sit && !spawn ? "seated" : "standing",
    elapsed: 0,
  });
  const [seated, setSeated] = useState(Boolean(plan.sit && !spawn));
  const [modelReady, setModelReady] = useState(false);
  const markReady = useMemo(() => () => setModelReady(true), []);

  const [targetX, targetZ] = plan.target;
  const floor = plan.floor;
  useEffect(() => {
    const from: [number, number] = [position.current.x, position.current.z];
    if (Math.hypot(targetX - from[0], targetZ - from[1]) < 0.05) {
      path.current = [];
      return;
    }
    path.current = findPath(from, [targetX, targetZ], floor);
  }, [targetX, targetZ, floor]);

  useEffect(() => {
    const map = positions.current;
    return () => {
      map.delete(agent.id);
    };
  }, [agent.id, positions]);

  useFrame(({ clock }, delta) => {
    const group = root.current;
    if (!group) return;
    const dt = Math.min(delta, 0.05);
    const atTarget = Math.hypot(targetX - position.current.x, targetZ - position.current.z) < 0.05;
    const sitYaw = plan.sit?.yaw;
    const wantsSeat = sitYaw !== undefined && atTarget && path.current.length === 0;

    // Seat state: stand up before walking off, sit down once at the seat and facing the right way.
    const seatState = seat.current;
    seatState.elapsed += dt;
    const transitionDone = clipFinished.current || seatState.elapsed > (modelReady ? SIT_TRANSITION_TIMEOUT : 0);
    if (seatState.state === "seated" && !wantsSeat) {
      seatState.state = "standingUp";
      seatState.elapsed = 0;
      clipFinished.current = false;
    } else if (seatState.state === "sittingDown" && transitionDone) {
      seatState.state = wantsSeat ? "seated" : "standingUp";
      seatState.elapsed = 0;
      clipFinished.current = false;
    } else if (seatState.state === "standingUp" && transitionDone && seatState.elapsed > 0.05) {
      seatState.state = "standing";
      seatState.elapsed = 0;
    } else if (seatState.state === "standing" && wantsSeat) {
      const facingError = Math.abs(
        Math.atan2(Math.sin(sitYaw - modelYaw.current), Math.cos(sitYaw - modelYaw.current)),
      );
      if (facingError < SIT_FACING_TOLERANCE || !modelReady) {
        seatState.state = "sittingDown";
        seatState.elapsed = 0;
        clipFinished.current = false;
      }
    }

    let moving = false;
    if (seatState.state === "standing") {
      let remaining = dt * WALK_SPEED;
      while (remaining > 0 && path.current.length > 0) {
        const [wx, wz] = path.current[0];
        const dx = wx - position.current.x;
        const dz = wz - position.current.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 1e-3) {
          path.current.shift();
          continue;
        }
        const advance = Math.min(distance, remaining);
        position.current.x += (dx / distance) * advance;
        position.current.z += (dz / distance) * advance;
        heading.current = [dx / distance, dz / distance];
        walked.current += advance;
        remaining -= advance;
        moving = true;
        if (advance >= distance) path.current.shift();
      }
    }
    group.position.copy(position.current);
    positions.current.set(agent.id, position.current);
    const isSeated = seatState.state !== "standing";
    if (isSeated !== seated) setSeated(isSeated);

    // 3D model: walk while moving, talk in meetings and at the Director's desk, otherwise idle; seated variants
    // while in a chair. Turn smoothly to the walking direction, or to what the agent is attending to.
    const talking = plan.activity === "meeting" || plan.activity === "ceo_visit";
    modelPose.current =
      seatState.state === "sittingDown"
        ? "sitDown"
        : seatState.state === "standingUp"
          ? "standUp"
          : seatState.state === "seated"
            ? talking
              ? "sitTalk"
              : "sit"
            : moving
              ? "walk"
              : talking
                ? "talk"
                : plan.use && atTarget
                  ? "use"
                  : "idle";
    if (model.current) {
      const nowAtTarget = Math.hypot(targetX - position.current.x, targetZ - position.current.z) < 0.05;
      const rest = nowAtTarget
        ? (sitYaw ?? plan.use?.yaw ?? restingYaw(plan.activity, position.current.x, position.current.z))
        : null;
      // Seated agents keep facing the way they sat down; standing agents turn toward travel or their focus.
      const wanted = isSeated
        ? modelYaw.current
        : moving
          ? Math.atan2(heading.current[0], heading.current[1])
          : (rest ?? modelYaw.current);
      const diff = Math.atan2(Math.sin(wanted - modelYaw.current), Math.cos(wanted - modelYaw.current));
      modelYaw.current += diff * (1 - Math.exp(-TURN_RATE * dt));
      model.current.rotation.y = modelYaw.current;
    }

    // Hands on the keyboard and mouse once seated at the desk: typing taps while working, with the right hand
    // moving to the mouse now and then; idle agents mostly browse with the mouse.
    const hand = hands.current;
    const atDesk = seatState.state === "seated" && plan.deskIndex !== null && plan.activity !== "offline";
    hand.weight += ((atDesk ? 1 : 0) - hand.weight) * (1 - Math.exp(-4 * dt));
    if (hand.weight > 0.001 && plan.deskIndex !== null) {
      const t = clock.elapsedTime + handUse.current.phase;
      const working = plan.activity === "working";
      const use = handUse.current;
      if (clock.elapsedTime > use.until) {
        use.onMouse = working ? !use.onMouse && Math.random() < 0.6 : Math.random() < 0.85;
        use.until = clock.elapsedTime + (use.onMouse ? 1.5 + Math.random() * 2.5 : 3 + Math.random() * 5);
      }
      const [dx, dz] = DESKS[plan.deskIndex];
      const yaw = modelYaw.current;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      // The character's right is (-fz, fx); wrists sit a little behind the keys, toward the body.
      const wrist = (x: number, z: number, along: number, lift: number, target: Vector3) =>
        target.set(dx + x - fz * along - fx * 0.07, 0.8 + lift, dz + z + fx * along - fz * 0.07);
      const tap = (speed: number, offset: number) => (working ? Math.max(0, Math.sin(t * speed + offset)) * 0.014 : 0);
      wrist(DESK_KEYBOARD[0], DESK_KEYBOARD[2], -0.1 + Math.sin(t * 0.7) * 0.02, tap(13, 0), hand.left);
      if (use.onMouse) {
        wrist(DESK_MOUSE[0] + Math.sin(t * 1.3) * 0.02, DESK_MOUSE[2] + Math.cos(t * 1.7) * 0.015, 0, 0, hand.right);
      } else {
        wrist(DESK_KEYBOARD[0], DESK_KEYBOARD[2], 0.1 + Math.sin(t * 0.9) * 0.02, tap(11, 1.9), hand.right);
      }
      hand.lean = 0.28;
      hand.facing = yaw;
    }

    spriteMotion.current.moving = moving;
    spriteMotion.current.walked = walked.current;
    spriteMotion.current.heading = heading.current;
    if (ring.current) {
      const pulse = plan.activity === "working" ? 1 + Math.sin(clock.elapsedTime * 3) * 0.08 : 1;
      ring.current.scale.setScalar(pulse);
    }
    const near =
      targetAgentId.current === agent.id ||
      Math.hypot(position.current.x - pose.x, position.current.z - pose.z) < DETAIL_RANGE;
    if (near !== showDetails) setShowDetails(near);
  });

  const offline = plan.activity === "offline";
  const labelHeight = modelReady ? MODEL_LABEL_HEIGHT - (seated ? SEATED_LABEL_DROP : 0) : AGENT_HEIGHT + 0.08;
  const color = ACTIVITY_COLORS[plan.activity];
  const now = Date.now();
  const speaking = speech && speech.until > now ? speech.line : null;
  const detailLines = [
    agent.name,
    plan.taskTitle
      ? truncate(plan.taskTitle, 42)
      : [departmentName, ACTIVITY_LABELS[plan.activity]].filter(Boolean).join(" · "),
  ];

  return (
    <group
      ref={root}
      position={[start[0], 0, start[1]]}
      userData={{ atlasAgentId: agent.id }}
      onClick={(event) => {
        // While the mouse is captured the controller handles clicks via the crosshair.
        if (document.pointerLockElement) return;
        event.stopPropagation();
        onSelect(agent);
      }}
    >
      {modelFailed && (
        <Suspense fallback={null}>
          <AgentSprite
            spriteNumber={spriteNumber}
            offline={offline}
            activity={plan.activity}
            agentId={agent.id}
            motion={spriteMotion}
            position={position}
          />
        </Suspense>
      )}
      <ModelBoundary onFail={markFailed}>
        <Suspense fallback={null}>
          <group ref={model} rotation-y={Math.PI}>
            <AgentModel
              look={look}
              pose={modelPose}
              finished={clipFinished}
              hands={hands}
              walkSpeed={WALK_SPEED}
              dimmed={offline}
            />
          </group>
          <ModelReady onReady={markReady} />
        </Suspense>
      </ModelBoundary>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.014, 0]}>
        <ringGeometry args={[0.24, 0.31, 32]} />
        <meshBasicMaterial color={color} transparent opacity={offline ? 0.35 : 0.85} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.24, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.18} depthWrite={false} />
      </mesh>
      {plan.activeSubAgents > 0 && <SubAgentOrbit count={plan.activeSubAgents} />}
      <FaceCamera>
        {unread && (
          <LabelPlate
            lines={["!"]}
            style={{ background: "#ef4444", color: "#ffffff", fontSize: 20 }}
            position={[0.24, labelHeight + 0.04, 0.02]}
          />
        )}
        {speaking ? (
          <LabelPlate
            lines={[truncate(speaking, 48)]}
            style={{ background: "rgba(248, 250, 252, 0.94)", color: "#0f172a", tail: true, fontSize: 22 }}
            position={[0, labelHeight, 0]}
          />
        ) : (
          showDetails && (
            <LabelPlate
              lines={detailLines}
              style={{
                background: "rgba(13, 17, 23, 0.72)",
                color: "#f8fafc",
                accent: departmentColor,
                dot: color,
                fontSize: 25,
              }}
              position={[0, labelHeight, 0]}
            />
          )
        )}
      </FaceCamera>
    </group>
  );
}

/** Wisps of steam rising from the espresso machine while someone is making coffee. */
function CoffeeSteam() {
  const puffs = useRef<Array<Mesh | null>>([]);
  useFrame(({ clock }) => {
    puffs.current.forEach((puff, i) => {
      if (!puff) return;
      const life = (clock.elapsedTime * 0.5 + i / 10) % 1;
      puff.position.set(
        ESPRESSO_MACHINE[0] + 0.12 + Math.sin(life * 6 + i) * 0.03,
        ESPRESSO_MACHINE[1] + 0.32 + life * 0.45,
        ESPRESSO_MACHINE[2] + Math.cos(life * 5 + i) * 0.03,
      );
      puff.scale.setScalar(0.012 + life * 0.045);
      (puff.material as MeshBasicMaterial).opacity = Math.sin(life * Math.PI) * 0.16;
    });
  });
  return (
    <>
      {Array.from({ length: 10 }, (_, i) => (
        <mesh
          key={i}
          ref={(mesh) => {
            puffs.current[i] = mesh;
          }}
        >
          <sphereGeometry args={[1, 10, 8]} />
          <meshBasicMaterial color="#f4f1ec" transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </>
  );
}

function SubAgentOrbit({ count }: { count: number }) {
  const group = useRef<Group>(null);
  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 1.6;
  });
  const visible = Math.min(count, 5);
  return (
    <group ref={group} position={[0, AGENT_HEIGHT * 0.78, 0]}>
      {Array.from({ length: visible }, (_, i) => {
        const angle = (i / visible) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(angle) * 0.42, 0, Math.sin(angle) * 0.42]}>
            <sphereGeometry args={[0.045, 10, 10]} />
            <meshBasicMaterial color="#8fd3ff" toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}

export default function AgentBillboards({
  agents,
  departments,
  tasks,
  subAgents,
  meetingPresence,
  ceoVisits,
  speech,
  unreadAgentIds,
  language,
  pose,
  floor,
  allFloors = false,
  targetAgentId,
  positions,
  onSelectAgent,
}: {
  /** Only agents on this floor (the Director's) are drawn. */
  floor: FloorId;
  /** Also draw the agents on the other floor (while the loading screen warms up their models). */
  allFloors?: boolean;
  agents: Agent[];
  departments: Department[];
  tasks: Task[];
  subAgents: SubAgent[];
  meetingPresence: MeetingPresence[];
  ceoVisits: ReadonlyMap<string, CeoVisit>;
  speech: ReadonlyMap<string, AgentSpeech>;
  unreadAgentIds: ReadonlySet<string>;
  language: Language;
  pose: OfficePose;
  targetAgentId: MutableRefObject<string | null>;
  positions: MutableRefObject<Map<string, Vector3>>;
  onSelectAgent: (agent: Agent) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    // Re-plan when the next meeting seat or speech bubble expires.
    const nextExpiry = Math.min(
      ...meetingPresence.map((presence) => presence.until).filter((until) => until > now),
      ...[...speech.values()].map((entry) => entry.until).filter((until) => until > now),
      ...[...ceoVisits.values()].map((visit) => visit.until).filter((until) => until > now),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 1);
    return () => window.clearTimeout(timeout);
  }, [meetingPresence, speech, ceoVisits, now]);

  const spriteMap = useMemo(() => buildSpriteMap(agents), [agents]);
  const lookMap = useMemo(() => buildLookMap(spriteMap), [spriteMap]);
  const { plans, pods } = useMemo(
    () => planAgents({ agents, departments, tasks, subAgents, meetingPresence, ceoVisits, now }),
    [agents, departments, tasks, subAgents, meetingPresence, ceoVisits, now],
  );
  const departmentsById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments]);
  const makingCoffee = [...plans.values()].some((plan) => plan.floor === floor && plan.use?.kind === "coffee");
  // An agent whose floor changed since the last commit (called to a meeting upstairs, or going back down) steps out
  // of the elevator instead of appearing at its target. Agents met by riding the elevator are already in place.
  const lastFloors = useRef(new Map<string, FloorId>());
  useEffect(() => {
    lastFloors.current = new Map([...plans].map(([id, plan]) => [id, plan.floor]));
  }, [plans]);

  return (
    <>
      {makingCoffee && <CoffeeSteam />}
      {pods
        .filter((pod) => pod.floor === floor)
        .map((pod) => {
          const department = pod.departmentId ? departmentsById.get(pod.departmentId) : undefined;
          const [x, z] = pod.center;
          return (
            <FaceCamera key={`${pod.departmentId ?? "unassigned"}:${pod.deskIndices[0]}`} position={[x, 2.3, z - 0.1]}>
              <LabelPlate
                lines={[department ? localName(department, language) : "Unassigned"]}
                style={{
                  background: "rgba(13, 17, 23, 0.6)",
                  color: "#e2e8f0",
                  accent: department?.color ?? "#7895a2",
                  caps: true,
                  fontSize: 27,
                }}
                position={[0, 0, 0]}
              />
            </FaceCamera>
          );
        })}
      {agents.map((agent) => {
        const plan = plans.get(agent.id);
        if (!plan || (plan.floor !== floor && !allFloors)) return null;
        const previousFloor = lastFloors.current.get(agent.id);
        const arriving = previousFloor !== undefined && previousFloor !== plan.floor;
        const department = agent.department_id ? departmentsById.get(agent.department_id) : undefined;
        return (
          <Suspense key={agent.id} fallback={null}>
            <AtlasAgent
              agent={{ ...agent, name: localName(agent, language) }}
              plan={plan}
              departmentName={department ? localName(department, language) : null}
              departmentColor={department?.color ?? "#7895a2"}
              spriteNumber={spriteMap.get(agent.id) ?? 1}
              look={lookMap.get(agent.id) ?? lookForSprite(spriteMap.get(agent.id) ?? 1)}
              speech={speech.get(agent.id)}
              unread={unreadAgentIds.has(agent.id)}
              pose={pose}
              spawn={arriving ? [ELEVATOR_ARRIVAL.x, ELEVATOR_ARRIVAL.z] : null}
              targetAgentId={targetAgentId}
              positions={positions}
              onSelect={() => onSelectAgent(agent)}
            />
          </Suspense>
        );
      })}
    </>
  );
}
