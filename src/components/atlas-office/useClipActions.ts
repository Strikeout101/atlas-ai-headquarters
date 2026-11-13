import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AnimationMixer, type AnimationAction, type AnimationClip, type Object3D } from "three";

/**
 * Animation actions for one model, created inside an effect. drei's useAnimations caches its actions across the
 * mount/unmount/mount cycle of React StrictMode (dev) and ends up holding actions it has already uncached, which
 * leaves models frozen in their T-pose. Creating the mixer in the effect gives every mount fresh, working actions.
 *
 * Returns a ref: `current.actions` (by clip name) and `current.generation`, which changes whenever the actions are
 * recreated so callers can restart their clip.
 */
export function useClipActions(root: Object3D | null, clips: AnimationClip[]) {
  const state = useRef<{ mixer: AnimationMixer | null; actions: Record<string, AnimationAction>; generation: number }>({
    mixer: null,
    actions: {},
    generation: 0,
  });
  useEffect(() => {
    if (!root) return;
    const mixer = new AnimationMixer(root);
    const actions: Record<string, AnimationAction> = {};
    for (const clip of clips) actions[clip.name] = mixer.clipAction(clip);
    state.current = { mixer, actions, generation: state.current.generation + 1 };
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      state.current = { mixer: null, actions: {}, generation: state.current.generation + 1 };
    };
  }, [root, clips]);
  useFrame((_, delta) => state.current.mixer?.update(Math.min(delta, 0.1)));
  return state;
}
