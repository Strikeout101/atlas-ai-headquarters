import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useTexture } from "@react-three/drei";
import {
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  type AnimationAction,
  type Group,
  type Material,
  type Texture,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { modelUrl, type AgentLook } from "./agentLooks";
import { applyHands, findArmRig, type HandTargets } from "./armIK";
import { useClipActions } from "./useClipActions";

export type { AgentLook } from "./agentLooks";

export type AgentPose = "idle" | "walk" | "talk" | "sitDown" | "sit" | "sitTalk" | "standUp" | "use";
const CLIP: Record<AgentPose, string> = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  talk: "Idle_Talking_Loop",
  sitDown: "Sitting_Enter",
  sit: "Sitting_Idle_Loop",
  sitTalk: "Sitting_Talking_Loop",
  standUp: "Sitting_Exit",
  /** Reaching and pressing: the coffee machine, the foosball rods. */
  use: "Interact",
};
/** Transitions that play once and hold their last frame; `finished` reports when they are done. */
const ONE_SHOT: ReadonlySet<AgentPose> = new Set(["sitDown", "standUp"]);
/**
 * Resting poses play only part of their clip's motion: the clip is blended with a frozen copy of its first frame, so
 * agents breathe and shift a little instead of swaying. 1 = the full clip, 0 = a statue.
 */
const RESTING_MOTION = 0.45;
const RESTING: ReadonlySet<AgentPose> = new Set(["idle", "sit"]);
const STILL_SUFFIX = "__still";
/** Ground speed the walk clip was made for (m/s). */
const WALK_CLIP_SPEED = 1.3;
const FADE = 0.3;

function LookTexture({ url, onTexture }: { url: string; onTexture: (texture: Texture) => void }) {
  const texture = useTexture(url);
  useEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false; // glTF UV convention
    texture.needsUpdate = true;
    onTexture(texture);
  }, [texture, onTexture]);
  return null;
}

export default function AgentModel({
  look,
  pose,
  finished,
  hands,
  walkSpeed,
  dimmed,
}: {
  look: AgentLook;
  /** Ref so the per-frame movement code can switch clips without re-rendering. */
  pose: { current: AgentPose };
  /** Set to true when the current one-shot pose (sitDown, standUp) has played to its end. */
  finished: { current: boolean };
  /** Hands on the desk's keyboard and mouse (IK over the seated clip), when the agent works at its desk. */
  hands?: { current: HandTargets };
  walkSpeed: number;
  dimmed: boolean;
}) {
  const { scene, animations } = useGLTF(modelUrl(look));
  const { model, materials } = useMemo(() => {
    const copy = cloneSkinned(scene) as Group;
    const owned: MeshStandardMaterial[] = [];
    copy.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.frustumCulled = false;
      const own = (material: Material) => {
        const copyMaterial = material.clone() as MeshStandardMaterial;
        // Hair and lashes are cut out by the alpha map: alpha test keeps them sorted correctly.
        if (copyMaterial.transparent || copyMaterial.alphaMap) {
          copyMaterial.transparent = false;
          copyMaterial.alphaTest = 0.5;
        }
        owned.push(copyMaterial);
        return copyMaterial;
      };
      object.material = Array.isArray(object.material) ? object.material.map(own) : own(object.material);
    });
    return { model: copy, materials: owned };
  }, [scene]);
  useEffect(() => () => materials.forEach((material) => material.dispose()), [materials]);

  useEffect(() => {
    for (const material of materials) {
      material.transparent = dimmed;
      material.opacity = dimmed ? 0.45 : 1;
      material.depthWrite = !dimmed;
      material.needsUpdate = true;
    }
  }, [dimmed, materials]);

  const lookUrl = look.texture;
  const applyLook = useMemo(
    () => (texture: Texture) => {
      for (const material of materials) {
        if (material.map) {
          material.map = texture;
          material.needsUpdate = true;
        }
      }
    },
    [materials],
  );

  // Frozen copies of the resting clips (see RESTING_MOTION).
  const allClips = useMemo(
    () => [
      ...animations,
      ...animations
        .filter((clip) => [...RESTING].some((p) => CLIP[p] === clip.name))
        .map((clip) => {
          const still = clip.clone();
          still.name = clip.name + STILL_SUFFIX;
          return still;
        }),
    ],
    [animations],
  );
  const clips = useClipActions(model, allClips);
  const armRig = useMemo(() => findArmRig(model), [model]);
  const playing = useRef<{ pose: AgentPose | null; generation: number }>({ pose: null, generation: -1 });

  useFrame(() => {
    const { actions, generation } = clips.current;
    const next = pose.current;
    if (generation !== playing.current.generation) {
      playing.current = { pose: null, generation }; // fresh actions (first mount or StrictMode remount)
    }
    if (next !== playing.current.pose) {
      const incoming = actions[CLIP[next]] as AnimationAction | undefined;
      if (incoming) {
        const first = playing.current.pose === null;
        const previous = first ? null : (playing.current.pose as AgentPose);
        const once = ONE_SHOT.has(next);
        const resting = RESTING.has(next);
        incoming.reset().setEffectiveWeight(resting ? RESTING_MOTION : 1);
        if (once) {
          incoming.setLoop(LoopOnce, 1);
          incoming.clampWhenFinished = true;
        } else incoming.setLoop(LoopRepeat, Infinity);
        // Start each agent at a different point of its loop so a row of agents doesn't move in sync.
        if (first && !once) incoming.time = Math.random() * incoming.getClip().duration;
        else if (!first) incoming.fadeIn(once ? FADE / 2 : FADE);
        finished.current = false;
        incoming.play();
        const still = resting ? actions[CLIP[next] + STILL_SUFFIX] : undefined;
        if (still) {
          still
            .reset()
            .setLoop(LoopRepeat, Infinity)
            .setEffectiveWeight(1 - RESTING_MOTION);
          if (!first) still.fadeIn(FADE);
          still.play();
          still.paused = true; // held on the clip's first frame
        }
        if (previous) {
          const outgoing = actions[CLIP[previous]];
          if (outgoing && outgoing !== incoming) outgoing.fadeOut(FADE);
          const outgoingStill = RESTING.has(previous) ? actions[CLIP[previous] + STILL_SUFFIX] : undefined;
          if (outgoingStill && outgoingStill !== still) outgoingStill.fadeOut(FADE);
        }
        playing.current = { pose: next, generation };
      }
    }
    if (ONE_SHOT.has(next) && playing.current.pose === next && !finished.current) {
      const action = actions[CLIP[next]] as AnimationAction | undefined;
      if (!action || action.time >= action.getClip().duration - 1e-3 || !action.isRunning()) finished.current = true;
    }
    const walk = actions[CLIP.walk];
    if (walk && next === "walk") walk.timeScale = walkSpeed / WALK_CLIP_SPEED;
  });

  // After the mixer (registered above) has posed the skeleton: put the hands on the keyboard and mouse.
  useFrame(() => {
    if (hands) applyHands(armRig, hands.current);
  });

  return (
    <group>
      <primitive object={model} />
      {lookUrl && <LookTexture url={lookUrl} onTexture={applyLook} />}
    </group>
  );
}
