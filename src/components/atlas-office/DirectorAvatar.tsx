import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useAnimations, useGLTF } from "@react-three/drei";
import { LoopOnce, LoopRepeat, Mesh, type AnimationAction, type Group, type Material } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { DirectorMotion } from "./DirectorSprite";

/**
 * The Director as a 3D character: the owner's Avaturn avatar, built by art/blender/build_atlas_director_avaturn.py
 * with clips from the Universal Animation Library (CC0).
 */
export const DIRECTOR_MODEL_URL = "/models/atlas/director.glb";

type Gait = "idle" | "walk" | "run" | "sitDown" | "sit" | "standUp";
const CLIP: Record<Gait, string> = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  run: "Jog_Fwd_Loop",
  sitDown: "Sitting_Enter",
  sit: "Sitting_Idle_Loop",
  standUp: "Sitting_Exit",
};
const ONE_SHOT: ReadonlySet<Gait> = new Set(["sitDown", "standUp"]);
const CHAIR_GAITS: ReadonlySet<Gait> = new Set(["sitDown", "sit", "standUp"]);
/** Ground speed (m/s) each clip was authored for, so steps keep pace with the controller and feet don't slide. */
const CLIP_SPEED: Record<"walk" | "run", number> = { walk: 1.9, run: 4.2 };
const FADE = 0.22;
const TURN_RATE = 12;

/** Signed shortest difference between two angles. */
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export default function DirectorAvatar({ motion }: { motion: MutableRefObject<DirectorMotion> }) {
  const { scene, animations } = useGLTF(DIRECTOR_MODEL_URL);
  const root = useRef<Group>(null);
  const { model, materials } = useMemo(() => {
    const copy = cloneSkinned(scene) as Group;
    const owned: Material[] = [];
    copy.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.frustumCulled = false; // skinned bounds don't follow the animation
      object.userData.atlasPlayer = true;
      const own = (material: Material) => {
        const copyMaterial = material.clone();
        owned.push(copyMaterial);
        return copyMaterial;
      };
      object.material = Array.isArray(object.material) ? object.material.map(own) : own(object.material);
    });
    return { model: copy, materials: owned };
  }, [scene]);
  useEffect(() => () => materials.forEach((material) => material.dispose()), [materials]);

  const { actions } = useAnimations(animations, root);
  const gait = useRef<Gait | null>(null);
  const lastDistance = useRef(motion.current.distance);
  const yaw = useRef(Math.atan2(motion.current.headingX, motion.current.headingZ));
  const fade = useRef(1);

  const play = (next: Gait) => {
    const incoming = actions[CLIP[next]] as AnimationAction | null | undefined;
    if (!incoming) return;
    const outgoing = gait.current ? (actions[CLIP[gait.current]] as AnimationAction | null | undefined) : null;
    incoming.reset().setEffectiveWeight(1);
    if (ONE_SHOT.has(next)) {
      incoming.setLoop(LoopOnce, 1);
      incoming.clampWhenFinished = true;
    } else incoming.setLoop(LoopRepeat, Infinity);
    incoming.fadeIn(FADE).play();
    if (outgoing && outgoing !== incoming) outgoing.fadeOut(FADE);
    gait.current = next;
  };

  useEffect(() => {
    play("idle");
    return () => {
      Object.values(actions).forEach((action) => action?.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);

  useFrame((_, delta) => {
    const group = root.current;
    if (!group) return;
    const state = motion.current;
    const dt = Math.min(delta, 0.05);
    const speed = dt > 0 ? (state.distance - lastDistance.current) / dt : 0;
    lastDistance.current = state.distance;

    // Chair: sit down, stay seated, and stand up again before walking.
    const current = gait.current;
    const oneShotDone = (() => {
      const action = current ? actions[CLIP[current]] : null;
      return !action || action.time >= action.getClip().duration - 1e-3 || !action.isRunning();
    })();
    let next: Gait;
    if (state.seated) next = current === "sitDown" && !oneShotDone ? "sitDown" : current === "sitDown" || current === "sit" ? "sit" : "sitDown";
    else if (current === "sitDown" || current === "sit") next = "standUp";
    else if (current === "standUp" && !oneShotDone) next = "standUp";
    else next = !state.moving ? "idle" : state.running ? "run" : "walk";
    if (next !== gait.current) play(next);
    state.inChair = CHAIR_GAITS.has(next);
    if (next === "walk" || next === "run") {
      const action = actions[CLIP[next]];
      if (action) action.timeScale = Math.min(1.8, Math.max(0.6, speed / CLIP_SPEED[next]));
    }

    // Turn smoothly toward the direction of travel (the model faces +Z).
    const target = Math.atan2(state.headingX, state.headingZ);
    yaw.current += angleDelta(yaw.current, target) * (1 - Math.exp(-TURN_RATE * dt));
    group.rotation.y = yaw.current;

    // Fade out when the camera is pressed against him, so he never fills the screen.
    const opacity = Math.min(1, Math.max(0, (state.cameraDistance - 0.9) / 0.9));
    if (Math.abs(opacity - fade.current) > 0.01) {
      fade.current = opacity;
      for (const material of materials) {
        // Hysteresis: switching transparency recompiles the shader, so don't flip it back and forth.
        const transparent = material.transparent ? opacity < 0.995 : opacity < 0.97;
        if (material.transparent !== transparent) material.needsUpdate = true;
        material.transparent = transparent;
        material.opacity = opacity;
        material.depthWrite = opacity > 0.95;
      }
    }
    group.visible = opacity > 0.02;
  });

  return (
    <group ref={root}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload(DIRECTOR_MODEL_URL);
