import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera, type Group, type Vector3 } from "three";
import ThirdPersonController, { type AtlasPrompt } from "./ThirdPersonController";
import AgentBillboards, { type AgentSpeech } from "./AgentBillboards";
import type { CeoVisit } from "./agentActivity";
import type { Agent, CeoOfficeCall, CrossDeptDelivery, Department, MeetingPresence, SubAgent, Task } from "../../types";
import {
  ELEVATOR_ARRIVAL,
  FLOOR_INFO,
  assignDeskSeats,
  otherFloor,
  type FloorId,
  type InteractionId,
  type OfficePose,
} from "./layout";
import OfficeBlockout, { BlockoutShell, OfficeSignage } from "./OfficeBlockout";
import OfficeFurniture, { type BoardData, type DeskScreen } from "./OfficeFurniture";
import { localName } from "./AgentBillboards";
import { useTaskTerminals } from "./useTaskTerminals";
import OfficeShell from "./OfficeShell";
import OfficeAtmosphere from "./OfficeAtmosphere";
import SceneWarmup, { useLoadingProgress, type WarmupPhase } from "./SceneWarmup";
import { LOCALE_TEXT, pickLocale } from "../office-view/themes-locale";

type Language = "en";

interface AtlasOfficeProps {
  onReturnToOriginal: () => void;
  onEnterDesktop: () => void;
  agents: Agent[];
  departments: Department[];
  tasks: Task[];
  subAgents: SubAgent[];
  meetingPresence: MeetingPresence[];
  activeMeetingTaskId: string | null;
  unreadAgentIds: Set<string>;
  crossDeptDeliveries: CrossDeptDelivery[];
  onCrossDeptDeliveryProcessed: (id: string) => void;
  ceoOfficeCalls: CeoOfficeCall[];
  onCeoOfficeCallProcessed: (id: string) => void;
  onOpenActiveMeetingMinutes: (taskId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onSelectDepartment: (department: Department) => void;
  language: Language;
  pose: OfficePose;
}

const SPEECH_MS = 5000;
/** Fallback so an agent never waits in the executive office forever if no dismiss arrives. */
const CEO_VISIT_MS = 120_000;
const DELIVERY_MS = 2400;

interface ActiveDelivery {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  startedAt: number;
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(value);
}

/** Basic lighting, used if the HDRIs or post-processing cannot load. */
function FallbackLighting() {
  return (
    <>
      <color attach="background" args={["#a9c8de"]} />
      <hemisphereLight args={["#e8f1f8", "#3a3430", 0.9]} />
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[4, 9, 14]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-13}
        shadow-camera-right={13}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-bias={-0.0005}
      />
      {[-8, -2.85, 3.65, 0, 6.4, -6.1].map((x, i) => (
        <pointLight
          key={i}
          position={[x, 2.85, i < 3 ? -4.2 : 2.9]}
          intensity={9}
          distance={9}
          decay={2}
          color="#ffe2bc"
        />
      ))}
    </>
  );
}

type AtlasQuality = "high" | "low";
const QUALITY_STORAGE_KEY = "atlas.quality";

function readStoredQuality(): AtlasQuality {
  try {
    return window.localStorage.getItem(QUALITY_STORAGE_KEY) === "low" ? "low" : "high";
  } catch {
    return "high";
  }
}

/** Vertical field of view. 55° matches most third-person games; the old 72° (about 105° across a wide screen)
 * stretched everything near the edges of the screen. Adjustable in the HUD, 45–70°. */
const FOV_STORAGE_KEY = "atlas.fov";
const DEFAULT_FOV = 55;
const FOV_RANGE = [45, 70] as const;

function readStoredFov(): number {
  try {
    const stored = Number(window.localStorage.getItem(FOV_STORAGE_KEY));
    return stored >= FOV_RANGE[0] && stored <= FOV_RANGE[1] ? stored : DEFAULT_FOV;
  } catch {
    return DEFAULT_FOV;
  }
}

/** Applies the field of view to the live camera (the Canvas camera prop only sets it once). */
function CameraFov({ fov }: { fov: number }) {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    if (camera instanceof PerspectiveCamera) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }, [camera, fov]);
  return null;
}

/** Reports the average frame rate twice a second (only mounted while the FPS readout is shown). */
function FpsProbe({ onSample }: { onSample: (fps: number) => void }) {
  const frames = useRef(0);
  const elapsed = useRef(0);
  useFrame((_, delta) => {
    frames.current += 1;
    elapsed.current += delta;
    if (elapsed.current >= 0.5) {
      onSample(Math.round(frames.current / elapsed.current));
      frames.current = 0;
      elapsed.current = 0;
    }
  });
  return null;
}

class SceneErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** A document that arcs from the sender to the receiver of a cross-department hand-off. */
function DeliveryEnvelope({
  delivery,
  positions,
}: {
  delivery: ActiveDelivery;
  positions: MutableRefObject<Map<string, Vector3>>;
}) {
  const group = useRef<Group>(null);
  useFrame(() => {
    const node = group.current;
    const from = positions.current.get(delivery.fromAgentId);
    const to = positions.current.get(delivery.toAgentId);
    if (!node) return;
    if (!from || !to) {
      node.visible = false;
      return;
    }
    const t = Math.min(1, (Date.now() - delivery.startedAt) / DELIVERY_MS);
    const eased = t * t * (3 - 2 * t);
    node.visible = t < 1;
    node.position.set(
      from.x + (to.x - from.x) * eased,
      1.2 + Math.sin(Math.PI * eased) * 0.9,
      from.z + (to.z - from.z) * eased,
    );
    node.rotation.y = eased * Math.PI * 2;
  });
  return (
    <group ref={group} visible={false}>
      <mesh castShadow>
        <boxGeometry args={[0.26, 0.03, 0.34]} />
        <meshStandardMaterial color="#f4efe4" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.017, -0.06]}>
        <boxGeometry args={[0.2, 0.005, 0.04]} />
        <meshBasicMaterial color="#5d9ccc" />
      </mesh>
    </group>
  );
}

const ZONE_MESSAGES: Partial<Record<InteractionId, string>> = {
  kitchenette: "Coffee's on ☕",
  foosball: "Foosball: first to 5 wins",
  pool: "Pool: call your shot 🎱",
  lounge: "Taking a breather in the lounge",
};

export default function AtlasOffice({
  onReturnToOriginal,
  onEnterDesktop,
  agents,
  departments,
  tasks,
  subAgents,
  meetingPresence,
  activeMeetingTaskId,
  unreadAgentIds,
  crossDeptDeliveries,
  onCrossDeptDeliveryProcessed,
  ceoOfficeCalls,
  onCeoOfficeCallProcessed,
  onOpenActiveMeetingMinutes,
  onSelectAgent,
  onSelectDepartment,
  language,
  pose,
}: AtlasOfficeProps) {
  const [locked, setLocked] = useState(false);
  const [quality, setQualityState] = useState<AtlasQuality>(readStoredQuality);
  const setQuality = useCallback((next: AtlasQuality) => {
    setQualityState(next);
    try {
      window.localStorage.setItem(QUALITY_STORAGE_KEY, next);
    } catch {
      // Storage unavailable; the choice lasts for this visit only.
    }
  }, []);
  const [fov, setFovState] = useState(readStoredFov);
  const setFov = useCallback((next: number) => {
    setFovState(next);
    try {
      window.localStorage.setItem(FOV_STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable; the choice lasts for this visit only.
    }
  }, []);
  const [showFps, setShowFps] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "F3") {
        event.preventDefault();
        setShowFps((on) => !on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [prompt, setPrompt] = useState<AtlasPrompt>(null);
  const [ceoVisits, setCeoVisits] = useState<ReadonlyMap<string, CeoVisit>>(() => new Map());
  const [speech, setSpeech] = useState<ReadonlyMap<string, AgentSpeech>>(() => new Map());
  const [deliveries, setDeliveries] = useState<ActiveDelivery[]>([]);
  const targetAgentId = useRef<string | null>(null);
  const canvasElement = useRef<HTMLCanvasElement | null>(null);
  const interactedAt = useRef(0);
  const [arcadeOn, setArcadeOn] = useState(true);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [floor, setFloor] = useState<FloorId>(pose.floor ?? "director");
  /** Covers the switch between floors: the screen dims while the elevator travels. */
  const [riding, setRiding] = useState(false);
  /** The loading screen stays up until every download is done and the GPU is warmed up (see SceneWarmup). */
  const [warmup, setWarmup] = useState<WarmupPhase>("loading");
  const { progress } = useLoadingProgress();
  /** Nothing is drawn while the tab is hidden; the scene picks up where it was when the tab comes back. */
  const [tabVisible, setTabVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVisibility = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const floorRef = useRef(floor);
  const deskAssignment = useMemo(() => assignDeskSeats(agents, departments), [agents, departments]);
  /** Desk index → agent, for the desks on the floor the Director is on. */
  const deskAgents = useMemo(() => {
    const byDesk = new Map<number, Agent>();
    for (const agent of agents) {
      const desk = deskAssignment.desks.get(agent.id);
      if (desk !== undefined && deskAssignment.floors.get(agent.id) === floor) byDesk.set(desk, agent);
    }
    return byDesk;
  }, [agents, deskAssignment, floor]);
  // Desk monitors: a live terminal of the current task while an agent works (see useTaskTerminals).
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const workingTaskIds = useMemo(
    () =>
      [...deskAgents.values()]
        .filter((agent) => agent.status === "working" && agent.current_task_id)
        .map((agent) => agent.current_task_id as string),
    [deskAgents],
  );
  const terminals = useTaskTerminals(workingTaskIds);
  const screens = useMemo(() => {
    const result: DeskScreen[] = [];
    for (const [desk, agent] of deskAgents) {
      const task = agent.current_task_id ? tasksById.get(agent.current_task_id) : undefined;
      result[desk] = {
        state:
          agent.status === "working"
            ? "working"
            : agent.status === "idle"
              ? "idle"
              : agent.status === "break"
                ? "away"
                : "off",
        agentName: localName(agent, language),
        taskTitle: task?.title ?? null,
        lines: agent.current_task_id ? terminals.get(agent.current_task_id) : undefined,
      };
    }
    return result;
  }, [deskAgents, tasksById, terminals, language]);
  // Conference room TV: the company board.
  const board = useMemo<BoardData>(() => {
    const working = agents.filter((agent) => agent.status === "working");
    return {
      agentsWorking: working.length,
      agentsTotal: agents.length,
      inProgress: tasks.filter((task) => task.status === "in_progress" || task.status === "collaborating").length,
      inReview: tasks.filter((task) => task.status === "review").length,
      done: tasks.filter((task) => task.status === "done").length,
      active: working.map((agent) => ({
        agent: localName(agent, language),
        task: (agent.current_task_id && tasksById.get(agent.current_task_id)?.title) || "Working",
      })),
      meeting: activeMeetingTaskId ? (tasksById.get(activeMeetingTaskId)?.title ?? "Team meeting") : null,
    };
  }, [agents, tasks, tasksById, activeMeetingTaskId, language]);
  const deskDepartment = useCallback(
    (deskIndex: number) => {
      const agent = deskAgents.get(deskIndex);
      return departments.find((department) => department.id === agent?.department_id) ?? null;
    },
    [departments, deskAgents],
  );
  const describeDesk = useCallback(
    (deskIndex: number) => {
      const department = deskDepartment(deskIndex);
      return department ? `talk to the ${department.name} team lead` : null;
    },
    [deskDepartment],
  );
  const selectDesk = useCallback(
    (deskIndex: number) => {
      const department = deskDepartment(deskIndex);
      if (department) onSelectDepartment(department);
    },
    [deskDepartment, onSelectDepartment],
  );
  const arcadeOnRef = useRef(arcadeOn);
  const elevatorTimers = useRef<number[]>([]);
  useEffect(() => () => elevatorTimers.current.forEach((timer) => window.clearTimeout(timer)), []);
  /** Rides the elevator: the screen dims, the floor changes behind it, and the Director steps out facing the room. */
  const rideElevator = useCallback(() => {
    if (elevatorTimers.current.length > 0) return;
    setRiding(true);
    const destination = otherFloor(floorRef.current);
    elevatorTimers.current = [
      window.setTimeout(() => {
        floorRef.current = destination;
        pose.floor = destination;
        pose.x = ELEVATOR_ARRIVAL.x;
        pose.z = ELEVATOR_ARRIVAL.z;
        pose.yaw = ELEVATOR_ARRIVAL.yaw;
        setFloor(destination);
        setToast({ text: `${FLOOR_INFO[destination].label} · Level ${FLOOR_INFO[destination].level}`, id: Date.now() });
      }, 450),
      window.setTimeout(() => {
        setRiding(false);
        elevatorTimers.current = [];
      }, 900),
    ];
  }, [pose]);
  const handleZone = useCallback(
    (id: InteractionId) => {
      if (id === "elevator") {
        rideElevator();
        return;
      }
      let text = ZONE_MESSAGES[id] ?? "";
      if (id === "arcade") {
        arcadeOnRef.current = !arcadeOnRef.current;
        setArcadeOn(arcadeOnRef.current);
        text = arcadeOnRef.current ? "Arcade lights on" : "Arcade lights off";
      }
      setToast({ text, id: Date.now() });
    },
    [rideElevator],
  );
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  const positions = useRef(new Map<string, Vector3>());
  const processedCalls = useRef(new Set<string>());
  const processedDeliveries = useRef(new Set<string>());
  const handlePromptChange = useCallback((next: AtlasPrompt) => setPrompt(next), []);
  const openMinutes = useCallback(() => {
    if (activeMeetingTaskId) onOpenActiveMeetingMinutes(activeMeetingTaskId);
  }, [activeMeetingTaskId, onOpenActiveMeetingMinutes]);

  useEffect(() => {
    const syncPointerLock = () => setLocked(Boolean(document.pointerLockElement));
    document.addEventListener("pointerlockchange", syncPointerLock);
    return () => document.removeEventListener("pointerlockchange", syncPointerLock);
  }, []);

  // CEO office calls: agents walk to the executive office, speak, then return to their desks.
  useEffect(() => {
    const fresh = ceoOfficeCalls.filter((call) => !processedCalls.current.has(call.id));
    if (fresh.length === 0) return;
    setCeoVisits((previous) => {
      const next = new Map(previous);
      for (const call of fresh) {
        const until = Math.max(call.holdUntil ?? 0, Date.now() + CEO_VISIT_MS);
        if (call.action === "dismiss") next.delete(call.fromAgentId);
        else if (call.action !== "speak")
          next.set(call.fromAgentId, { seatIndex: call.seatIndex, phase: call.phase, until });
        else {
          const visit = next.get(call.fromAgentId);
          if (visit) next.set(call.fromAgentId, { ...visit, until });
        }
      }
      return next;
    });
    const speaking = fresh.filter((call) => call.action === "speak");
    if (speaking.length > 0) {
      setSpeech((previous) => {
        const next = new Map(previous);
        for (const call of speaking) {
          const pool = pickLocale(
            language,
            call.phase === "review" ? LOCALE_TEXT.reviewLines : LOCALE_TEXT.kickoffLines,
          );
          const line = call.line?.trim() || pool[hash(`${call.fromAgentId}-${call.id}`) % pool.length];
          next.set(call.fromAgentId, { line, until: Date.now() + SPEECH_MS });
        }
        return next;
      });
    }
    for (const call of fresh) {
      processedCalls.current.add(call.id);
      onCeoOfficeCallProcessed(call.id);
    }
  }, [ceoOfficeCalls, language, onCeoOfficeCallProcessed]);

  // Cross-department hand-offs: show a document travelling between the two agents.
  useEffect(() => {
    const fresh = crossDeptDeliveries.filter((delivery) => !processedDeliveries.current.has(delivery.id));
    if (fresh.length === 0) return;
    const startedAt = Date.now();
    setDeliveries((previous) => [
      ...previous,
      ...fresh.map((delivery) => ({
        id: delivery.id,
        fromAgentId: delivery.fromAgentId,
        toAgentId: delivery.toAgentId,
        startedAt,
      })),
    ]);
    for (const delivery of fresh) {
      processedDeliveries.current.add(delivery.id);
      onCrossDeptDeliveryProcessed(delivery.id);
    }
  }, [crossDeptDeliveries, onCrossDeptDeliveryProcessed]);

  useEffect(() => {
    if (deliveries.length === 0) return;
    const oldest = Math.min(...deliveries.map((delivery) => delivery.startedAt));
    const timeout = window.setTimeout(
      () => setDeliveries((previous) => previous.filter((delivery) => Date.now() - delivery.startedAt < DELIVERY_MS)),
      Math.max(0, oldest + DELIVERY_MS - Date.now()) + 50,
    );
    return () => window.clearTimeout(timeout);
  }, [deliveries]);

  const fallback = (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-slate-900 text-slate-100">
      <p>3D rendering is unavailable in this browser.</p>
      <button type="button" onClick={onReturnToOriginal} className="rounded border border-slate-400 px-3 py-2 text-sm">
        Return to Original Office
      </button>
    </div>
  );

  const promptText = useMemo(() => {
    if (!prompt) return null;
    return prompt.kind === "agent" ? `Press E or click to view ${prompt.name}` : `Press E or click to ${prompt.label}`;
  }, [prompt]);

  return (
    <section className="relative h-[100dvh] w-full overflow-hidden bg-slate-900" aria-label="ATLAS Office">
      <SceneErrorBoundary fallback={fallback}>
        <Canvas
          shadows="percentage"
          flat
          frameloop={tabVisible ? "always" : "never"}
          dpr={quality === "high" ? [1, 1.75] : [1, 1]}
          camera={{ position: [pose.x, 1.65, pose.z], fov }}
          gl={{ antialias: false, powerPreference: "high-performance" }}
          onCreated={({ gl }) => {
            canvasElement.current = gl.domElement;
          }}
          onPointerMissed={(event) => {
            // Clicking empty space captures the mouse; clicking an agent opens it instead.
            if (event.type !== "click" || document.pointerLockElement) return;
            if (performance.now() - interactedAt.current < 400) return;
            const request = canvasElement.current?.requestPointerLock() as Promise<void> | undefined;
            request?.catch(() => undefined);
          }}
        >
          <SceneErrorBoundary fallback={<FallbackLighting />}>
            <Suspense fallback={<FallbackLighting />}>
              <OfficeAtmosphere quality={quality} />
            </Suspense>
          </SceneErrorBoundary>
          <SceneErrorBoundary fallback={<BlockoutShell floor={floor} />}>
            <Suspense fallback={<BlockoutShell floor={floor} />}>
              <OfficeShell floor={floor} />
              {/* The other floor's shell is drawn (behind the loading screen) only while warming up, so its shaders
                  and textures are ready before the first elevator ride. */}
              {warmup !== "ready" && <OfficeShell floor={otherFloor(floor)} />}
            </Suspense>
          </SceneErrorBoundary>
          <SceneErrorBoundary fallback={<OfficeBlockout arcadeOn={arcadeOn} floor={floor} />}>
            <Suspense fallback={<OfficeBlockout arcadeOn={arcadeOn} floor={floor} />}>
              <OfficeFurniture floor={floor} arcadeOn={arcadeOn} screens={screens} board={board} />
            </Suspense>
          </SceneErrorBoundary>
          <OfficeSignage floor={floor} />
          <CameraFov fov={fov} />
          {showFps && <FpsProbe onSample={setFps} />}
          <SceneWarmup onPhase={setWarmup} />
          <AgentBillboards
            agents={agents}
            departments={departments}
            tasks={tasks}
            subAgents={subAgents}
            meetingPresence={meetingPresence}
            ceoVisits={ceoVisits}
            speech={speech}
            unreadAgentIds={unreadAgentIds}
            language={language}
            pose={pose}
            floor={floor}
            allFloors={warmup !== "ready"}
            targetAgentId={targetAgentId}
            positions={positions}
            onSelectAgent={onSelectAgent}
          />
          {deliveries.map((delivery) => (
            <DeliveryEnvelope key={delivery.id} delivery={delivery} positions={positions} />
          ))}
          <ThirdPersonController
            active
            floor={floor}
            agents={agents}
            pose={pose}
            targetAgentId={targetAgentId}
            interactedAt={interactedAt}
            meetingMinutesAvailable={Boolean(activeMeetingTaskId)}
            onPromptChange={handlePromptChange}
            onEnterDesktop={onEnterDesktop}
            onSelectAgent={onSelectAgent}
            onOpenMeetingMinutes={openMinutes}
            onSelectDesk={selectDesk}
            onZoneInteract={handleZone}
            describeDesk={describeDesk}
          />
        </Canvas>
      </SceneErrorBoundary>
      <div className="pointer-events-none absolute bottom-4 left-4 rounded bg-slate-900/80 px-3 py-2 text-xs text-slate-100">
        {locked
          ? "WASD move · Mouse orbit · Shift faster · E or click interact · Esc release mouse"
          : "Click the office to control · Click an agent to open it"}
      </div>
      {locked && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90 ring-1 ring-slate-900/60" />
      )}
      <div
        className={`pointer-events-none absolute inset-0 bg-slate-950 transition-opacity duration-300 ${riding ? "opacity-100" : "opacity-0"}`}
      />
      <div className="pointer-events-none absolute left-4 top-16 rounded bg-slate-900/80 px-3 py-1.5 text-xs text-slate-100">
        Level {FLOOR_INFO[floor].level} · {FLOOR_INFO[floor].label}
      </div>
      <div
        className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 transition-opacity duration-500 ${
          warmup === "ready" ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        // Fixed colours: the app's light theme remaps the slate palette, and this screen stays dark like the office.
        style={{ background: "#0b0f17" }}
        role="status"
        aria-live="polite"
        aria-hidden={warmup === "ready"}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.35em]" style={{ color: "#cbd5e1" }}>
          ATLAS AI HQ
        </p>
        <div className="h-1 w-64 overflow-hidden rounded-full" style={{ background: "#1e293b" }}>
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              background: "#38bdf8",
              width: `${warmup === "loading" ? Math.round(progress * 0.85) : warmup === "preparing" ? 92 : 100}%`,
            }}
          />
        </div>
        <p className="text-xs tabular-nums" style={{ color: "#94a3b8" }}>
          {warmup === "loading" ? "Loading the office…" : "Preparing graphics…"}
        </p>
      </div>
      {toast && (
        <div
          key={toast.id}
          className="pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 rounded bg-slate-900/90 px-4 py-2 text-sm text-white"
        >
          {toast.text}
        </div>
      )}
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2 text-xs text-white">
        {showFps && (
          <span className="rounded bg-slate-900/85 px-2 py-1.5 font-mono tabular-nums">{fps ?? "…"} FPS</span>
        )}
        <button
          type="button"
          onClick={() => setShowFps((on) => !on)}
          className="rounded border border-slate-500/60 bg-slate-900/85 px-2.5 py-1.5 transition hover:bg-slate-700 active:scale-[0.98]"
          title="Show frame rate (F3)"
        >
          FPS
        </button>
        <label
          className="flex items-center gap-2 rounded border border-slate-500/60 bg-slate-900/85 px-2.5 py-1"
          title="Field of view: lower looks flatter and closer, higher shows more of the room"
        >
          <span>View {fov}°</span>
          <input
            type="range"
            min={FOV_RANGE[0]}
            max={FOV_RANGE[1]}
            step={1}
            value={fov}
            onChange={(event) => setFov(Number(event.target.value))}
            onKeyDown={(event) => event.stopPropagation()}
            className="w-20 accent-sky-400"
            aria-label="Field of view"
          />
        </label>
        <button
          type="button"
          onClick={() => setQuality(quality === "high" ? "low" : "high")}
          className="rounded border border-slate-500/60 bg-slate-900/85 px-2.5 py-1.5 transition hover:bg-slate-700 active:scale-[0.98]"
          title="High: soft shadows, ambient occlusion, bloom. Low: faster on weaker GPUs."
        >
          Graphics: {quality === "high" ? "High" : "Low"}
        </button>
      </div>
      {promptText && locked && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 rounded bg-slate-900/90 px-4 py-2 text-sm text-white">
          {promptText}
        </div>
      )}
    </section>
  );
}
