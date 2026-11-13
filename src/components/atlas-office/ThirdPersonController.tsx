import { Component, Suspense, useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Matrix4, Quaternion, Raycaster, Vector2, Vector3, type Group, type Object3D } from "three";
import type { Agent } from "../../types";
import {
  EXECUTIVE_CAMERA,
  EXECUTIVE_SEAT,
  PLAYER_RADIUS,
  cameraCanOccupy,
  canOccupy,
  findInteraction,
  type FloorId,
  type InteractionId,
  type OfficePose,
} from "./layout";
import DirectorAvatar from "./DirectorAvatar";
import DirectorSprite, { type DirectorMotion } from "./DirectorSprite";

/** Shows `fallback` (the sprite) if the 3D character fails to load. */
class AvatarBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Camera boom: about 3.3 m behind, aimed at shoulder height and only a little above it, so the office is
 * seen from roughly eye level instead of from near the ceiling. */
const CAMERA_DISTANCE = 3.3;
const CAMERA_TARGET_HEIGHT = 1.45;
const CAMERA_LIFT = 0.35;
/** Over-the-shoulder offset so the crosshair is not hidden behind the Director. */
const SHOULDER_OFFSET = 0.45;
const INTERACT_RANGE = 2.8;
/** Sitting down at the executive desk: the camera glides to the monitor while the Director sits, then the
 * dashboard opens. Long enough for the sit-down clip to finish. */
const SIT_TRANSITION_SECONDS = 1.5;
/** Time for the Director to shuffle from where he stood onto the seat spot. */
const SEAT_SLIDE_RATE = 6;
const UP = new Vector3(0, 1, 0);

export type AtlasPrompt =
  | { kind: "agent"; name: string }
  | { kind: "zone"; id: InteractionId; label: string }
  | { kind: "desk"; deskIndex: number; label: string }
  | null;

function samePrompt(a: AtlasPrompt, b: AtlasPrompt): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Zone actions that open a panel or leave the office, so the mouse is released first. */
const MODAL_ZONES: ReadonlySet<InteractionId> = new Set(["monitor", "minutes"]);

export default function ThirdPersonController({
  active,
  floor,
  agents,
  pose,
  targetAgentId,
  interactedAt,
  meetingMinutesAvailable,
  onPromptChange,
  onEnterDesktop,
  onSelectAgent,
  onOpenMeetingMinutes,
  onSelectDesk,
  onZoneInteract,
  describeDesk,
}: {
  active: boolean;
  /** The floor the Director is on: collisions, the camera and interactions follow its plan. */
  floor: FloorId;
  agents: Agent[];
  pose: OfficePose;
  /** Shared with the agent layer so the targeted agent can show its details. */
  targetAgentId: MutableRefObject<string | null>;
  /** Time of the last interaction, so the click that triggered it does not re-capture the mouse. */
  interactedAt: MutableRefObject<number>;
  meetingMinutesAvailable: boolean;
  onPromptChange: (prompt: AtlasPrompt) => void;
  onEnterDesktop: () => void;
  onSelectAgent: (agent: Agent) => void;
  onOpenMeetingMinutes: () => void;
  onSelectDesk: (deskIndex: number) => void;
  onZoneInteract: (id: InteractionId) => void;
  /** Prompt text for a desk (e.g. its department), or null when the desk has nothing to open. */
  describeDesk: (deskIndex: number) => string | null;
}) {
  const { camera, gl, scene } = useThree();
  const pressed = useRef(new Set<string>());
  const yaw = useRef(pose.yaw);
  const pitch = useRef(pose.pitch);
  /** Current camera boom length; pulled in at once by walls, eased back out (no pumping while looking around). */
  const boomLength = useRef(CAMERA_DISTANCE);
  const direction = useRef(new Vector3());
  const player = useRef<Group>(null);
  const prompt = useRef<AtlasPrompt>(null);
  const raycaster = useRef(new Raycaster());
  const targetScanTime = useRef(0);
  const motion = useRef<DirectorMotion>({
    moving: false,
    running: false,
    distance: 0,
    headingX: -Math.sin(pose.yaw),
    headingZ: -Math.cos(pose.yaw),
    cameraDistance: CAMERA_DISTANCE,
  });
  const handlers = useRef({
    agents,
    onEnterDesktop,
    onSelectAgent,
    onOpenMeetingMinutes,
    onSelectDesk,
    onZoneInteract,
    describeDesk,
    meetingMinutesAvailable,
    floor,
  });
  const transition = useRef<{ elapsed: number; start: Vector3; rotation: Quaternion } | null>(null);
  /** 0 = standing where the pose says, 1 = on the executive seat. */
  const seatBlend = useRef(0);

  useEffect(() => {
    handlers.current = {
      agents,
      onEnterDesktop,
      onSelectAgent,
      onOpenMeetingMinutes,
      onSelectDesk,
      onZoneInteract,
      describeDesk,
      meetingMinutesAvailable,
      floor,
    };
  }, [
    floor,
    agents,
    onEnterDesktop,
    onSelectAgent,
    onOpenMeetingMinutes,
    onSelectDesk,
    onZoneInteract,
    describeDesk,
    meetingMinutesAvailable,
  ]);

  // After the elevator moves him to another floor, the Director faces the way the pose looks (into the room).
  useEffect(() => {
    motion.current.headingX = -Math.sin(pose.yaw);
    motion.current.headingZ = -Math.cos(pose.yaw);
  }, [floor, pose]);

  useEffect(() => {
    camera.position.set(pose.x, 2.3, pose.z + 1.2);
    camera.lookAt(pose.x, 0.9, pose.z);
    const canvas = gl.domElement;
    const pressedKeys = pressed.current;
    const interact = (): boolean => {
      const current = prompt.current;
      if (!current) return false;
      if (current.kind === "zone" && !MODAL_ZONES.has(current.id)) {
        // Small in-world actions (arcade lights, coffee, foosball) keep the Director in control.
        handlers.current.onZoneInteract(current.id);
        return true;
      }
      interactedAt.current = performance.now();
      document.exitPointerLock();
      pressedKeys.clear();
      if (current.kind === "zone" && current.id === "monitor") {
        transition.current = { elapsed: 0, start: camera.position.clone(), rotation: camera.quaternion.clone() };
        // Sit down facing the desk.
        motion.current.seated = true;
        motion.current.headingX = Math.sin(EXECUTIVE_SEAT.yaw);
        motion.current.headingZ = Math.cos(EXECUTIVE_SEAT.yaw);
      } else if (current.kind === "zone") {
        handlers.current.onOpenMeetingMinutes();
      } else if (current.kind === "desk") {
        handlers.current.onSelectDesk(current.deskIndex);
      } else {
        const agent = handlers.current.agents.find((candidate) => candidate.id === targetAgentId.current);
        if (agent) handlers.current.onSelectAgent(agent);
      }
      return true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || document.pointerLockElement !== canvas) return;
      if (event.code === "KeyE" && !event.repeat) {
        if (interact()) event.preventDefault();
        return;
      }
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"].includes(event.code)) {
        event.preventDefault();
        pressedKeys.add(event.code);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => pressedKeys.delete(event.code);
    const onMouseDown = (event: MouseEvent) => {
      // While the mouse is captured, a left click acts on whatever the crosshair targets.
      if (!active || event.button !== 0 || document.pointerLockElement !== canvas) return;
      interact();
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!active || document.pointerLockElement !== canvas) return;
      yaw.current -= event.movementX * 0.0022;
      pitch.current = Math.max(-0.2, Math.min(0.65, pitch.current + event.movementY * 0.0022));
      pose.yaw = yaw.current;
      pose.pitch = pitch.current;
    };
    const onBlur = () => pressedKeys.clear();
    const onPointerLockChange = () => {
      if (document.pointerLockElement !== canvas) pressedKeys.clear();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("blur", onBlur);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    return () => {
      pressedKeys.clear();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
    };
  }, [active, camera, gl, pose, targetAgentId, interactedAt]);

  useFrame((_, delta) => {
    // The Director's body slides onto the executive seat while seated and back to his standing spot after.
    const state = motion.current;
    const seatTarget = state.seated || state.inChair ? 1 : 0;
    seatBlend.current += (seatTarget - seatBlend.current) * (1 - Math.exp(-SEAT_SLIDE_RATE * Math.min(delta, 0.05)));
    if (player.current) {
      player.current.position.set(
        pose.x + (EXECUTIVE_SEAT.x - pose.x) * seatBlend.current,
        0,
        pose.z + (EXECUTIVE_SEAT.z - pose.z) * seatBlend.current,
      );
    }
    if (transition.current) {
      state.cameraDistance = CAMERA_DISTANCE; // never fade him out while the camera looks over his shoulder
      transition.current.elapsed += delta;
      const progress = Math.min(transition.current.elapsed / SIT_TRANSITION_SECONDS, 1);
      const eased = progress * progress * (3 - 2 * progress);
      const destination = new Vector3(...EXECUTIVE_CAMERA.position);
      const lookAt = new Vector3(...EXECUTIVE_CAMERA.lookAt);
      const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(destination, lookAt, camera.up));
      camera.position.lerpVectors(transition.current.start, destination, eased);
      camera.quaternion.copy(transition.current.rotation).slerp(orientation, eased);
      if (progress === 1) {
        transition.current = null;
        handlers.current.onEnterDesktop();
      }
      return;
    }
    const navigating = active && document.pointerLockElement === gl.domElement;
    const currentFloor = handlers.current.floor;
    // The shared pose is the source of truth, so a restored or externally set pose is honoured.
    yaw.current = pose.yaw;
    pitch.current = pose.pitch;

    targetScanTime.current += delta;
    if (targetScanTime.current >= 0.1) {
      targetScanTime.current = 0;
      let targetId: string | undefined;
      if (navigating) {
        raycaster.current.setFromCamera(new Vector2(0, 0), camera);
        raycaster.current.far = CAMERA_DISTANCE + INTERACT_RANGE + 0.5;
        const targets: Object3D[] = [];
        scene.traverse((object) => {
          if (object.userData.atlasAgentId) targets.push(object);
        });
        const hit = raycaster.current.intersectObjects(targets, true)[0];
        let hitObject: Object3D | null = hit?.object ?? null;
        while (hitObject && !hitObject.userData.atlasAgentId) hitObject = hitObject.parent;
        const hitPosition = hitObject?.getWorldPosition(new Vector3());
        if (hitPosition && Math.hypot(hitPosition.x - pose.x, hitPosition.z - pose.z) <= INTERACT_RANGE) {
          targetId = hitObject?.userData.atlasAgentId as string | undefined;
        }
      }
      targetAgentId.current = targetId ?? null;
      const here = findInteraction(pose.x, pose.z, handlers.current.meetingMinutesAvailable, currentFloor);
      const agentName = targetId ? agents.find((agent) => agent.id === targetId)?.name : undefined;
      const deskLabel = here?.kind === "desk" ? handlers.current.describeDesk(here.deskIndex) : null;
      let next: AtlasPrompt = null;
      if (here?.kind === "zone" && here.zone.id === "monitor") next = { kind: "zone", id: "monitor", label: here.zone.label };
      else if (agentName) next = { kind: "agent", name: agentName };
      else if (here?.kind === "zone") next = { kind: "zone", id: here.zone.id, label: here.zone.label };
      else if (here?.kind === "desk" && deskLabel) next = { kind: "desk", deskIndex: here.deskIndex, label: deskLabel };
      if (!samePrompt(next, prompt.current)) {
        prompt.current = next;
        onPromptChange(next);
      }
    }

    const keys = pressed.current;
    const forward = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
    const strafe = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
    const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const speed = running ? 5.2 : 3.1;
    direction.current.set(strafe, 0, -forward).normalize().applyAxisAngle(UP, yaw.current);
    const step = Math.min(delta, 0.05) * speed;
    state.moving = false;
    state.running = running;
    // Back in the office after the desktop: any movement key stands the Director up; he walks once he is up.
    if (navigating && (forward || strafe) && state.seated) state.seated = false;
    if (navigating && (forward || strafe) && !state.seated && !state.inChair) {
      const startX = pose.x;
      const startZ = pose.z;
      const nextX = pose.x + direction.current.x * step;
      const nextZ = pose.z + direction.current.z * step;
      if (canOccupy(nextX, pose.z, PLAYER_RADIUS, currentFloor)) pose.x = nextX;
      if (canOccupy(pose.x, nextZ, PLAYER_RADIUS, currentFloor)) pose.z = nextZ;
      const moved = Math.hypot(pose.x - startX, pose.z - startZ);
      state.headingX = direction.current.x;
      state.headingZ = direction.current.z;
      if (moved > 1e-4) {
        state.moving = true;
        state.distance += moved;
      }
    }

    const shoulder = new Vector3(SHOULDER_OFFSET, 0, 0).applyAxisAngle(UP, yaw.current);
    const target = new Vector3(pose.x, CAMERA_TARGET_HEIGHT, pose.z).add(shoulder);
    if (!cameraCanOccupy(target.x, target.z, 0.1, currentFloor)) target.set(pose.x, CAMERA_TARGET_HEIGHT, pose.z);
    const offset = new Vector3(0, CAMERA_LIFT + pitch.current * 1.6, CAMERA_DISTANCE).applyAxisAngle(UP, yaw.current);
    const desired = target.clone().add(offset);
    desired.y = Math.min(desired.y, 2.75);
    // The camera sits on a boom from the target. Its direction follows the mouse exactly; only its length
    // changes near walls. Walls pull it in at once, open space lets it ease back out, so turning beside a wall
    // no longer makes it pump in and out. Furniture never blocks it: the camera rides above desk height.
    const boom = desired.sub(target);
    const fullLength = boom.length();
    boom.divideScalar(fullLength);
    let safeLength = fullLength;
    for (let length = 0.1; length <= fullLength; length += 0.02) {
      const point = target.clone().addScaledVector(boom, length);
      if (!cameraCanOccupy(point.x, point.z, 0.15, currentFloor)) {
        safeLength = Math.max(0.1, length - 0.04);
        break;
      }
    }
    const dt = Math.min(delta, 0.05);
    boomLength.current =
      safeLength < boomLength.current
        ? safeLength
        : boomLength.current + (safeLength - boomLength.current) * (1 - Math.exp(-4 * dt));
    camera.position.copy(target).addScaledVector(boom, boomLength.current);
    camera.lookAt(target);
    state.cameraDistance = Math.hypot(camera.position.x - pose.x, camera.position.z - pose.z);
  });

  return (
    <group ref={player} position={[pose.x, 0, pose.z]} userData={{ atlasPlayer: true }}>
      {/* The 3D character; the pixel-art sprite stands in while it loads or if the model fails. */}
      <AvatarBoundary fallback={<Suspense fallback={null}><DirectorSprite motion={motion} /></Suspense>}>
        <Suspense fallback={<DirectorSprite motion={motion} />}>
          <DirectorAvatar motion={motion} />
        </Suspense>
      </AvatarBoundary>
    </group>
  );
}
