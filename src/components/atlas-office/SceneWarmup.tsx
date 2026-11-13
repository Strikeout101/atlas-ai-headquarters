import { useEffect, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import { useProgress } from "@react-three/drei";
import { HalfFloatType, Mesh, SkinnedMesh, WebGLRenderTarget, type Material, type Object3D, type Texture } from "three";

/** Loads that start this soon after the last one finished (a GLB's textures, the next agent) still count. */
const SETTLE_MS = 600;
/** Never keep the office hidden longer than this, even if a download hangs. */
const GIVE_UP_MS = 90_000;

export type WarmupPhase = "loading" | "preparing" | "ready";

/**
 * drei's loading progress, read a few times a second. Subscribing to the store directly re-renders this component
 * while a model component is still rendering (loads start during render), which React warns about.
 */
export function useLoadingProgress(): { active: boolean; loaded: number; total: number; progress: number } {
  const read = () => {
    const { active, loaded, total, progress } = useProgress.getState();
    return { active, loaded, total, progress };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = read();
      setState((previous) =>
        previous.active === next.active && previous.loaded === next.loaded && previous.total === next.total
          ? previous
          : next,
      );
    }, 150);
    return () => window.clearInterval(timer);
  }, []);
  return state;
}

function texturesOf(material: Material): Texture[] {
  return Object.values(material).filter((value): value is Texture => Boolean(value && (value as Texture).isTexture));
}

/**
 * Prepares the GPU before the office is shown. three.js compiles a material's shader and uploads its textures the
 * first time that object is drawn, which stalls the frame. In the office that happened every time a new part of
 * the room came into view during the first minute. Once every download has finished, this compiles all shaders
 * (in parallel where the browser supports it) and uploads every texture, including those of hidden objects such as
 * the other floor's furniture, then lets a few frames render behind the loading screen.
 */
export default function SceneWarmup({ onPhase }: { onPhase: (phase: WarmupPhase) => void }) {
  const { gl, scene, camera } = useThree();
  const { active, loaded, total } = useLoadingProgress();
  const done = useRef(false);
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;

  useEffect(() => {
    if (done.current) return;
    if (active || loaded < total) return;
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        if (cancelled || done.current) return;
        done.current = true;
        onPhaseRef.current("preparing");
        const t0 = performance.now();
        const programsBefore = gl.info.programs?.length ?? 0;
        let meshCount = 0;
        scene.traverse((object) => {
          if (object instanceof Mesh) meshCount++;
        });
        // Hidden objects (the other floor's pieces, fallbacks) are made visible, and nothing is culled for being off
        // screen, so every object's shaders and textures are prepared, not only what the first camera sees.
        const hidden: Object3D[] = [];
        const culled: Object3D[] = [];
        scene.traverse((object) => {
          if (!object.visible) {
            hidden.push(object);
            object.visible = true;
          }
          if (object.frustumCulled) {
            culled.push(object);
            object.frustumCulled = false;
          }
        });
        const meshMaterials = (filter: (mesh: Mesh) => boolean) => {
          const found = new Set<Material>();
          scene.traverse((object) => {
            if (!(object instanceof Mesh) || !filter(object)) return;
            for (const material of Array.isArray(object.material) ? object.material : [object.material]) found.add(material);
          });
          return found;
        };
        // The office is drawn into the post-processing buffers, not straight to the screen, and three.js builds a
        // different shader for each. Compile against an off-screen target so the shaders are the ones really used.
        const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
        const previousTarget = gl.getRenderTarget();
        try {
          gl.setRenderTarget(target);
          await gl.compileAsync(scene, camera);
          // Characters switch between solid and see-through (the Director when the camera comes close, offline
          // agents): prepare the other version of their shaders too.
          const characters = [...meshMaterials((mesh) => mesh instanceof SkinnedMesh)];
          for (const material of characters) {
            material.transparent = !material.transparent;
            material.needsUpdate = true;
          }
          await gl.compileAsync(scene, camera);
          for (const material of characters) {
            material.transparent = !material.transparent;
            material.needsUpdate = true;
          }
          await gl.compileAsync(scene, camera);
          const textures = new Set<Texture>();
          for (const material of meshMaterials(() => true)) for (const texture of texturesOf(material)) textures.add(texture);
          for (const texture of textures) gl.initTexture(texture);
        } catch (error) {
          console.warn("ATLAS warm-up skipped", error);
        } finally {
          gl.setRenderTarget(previousTarget);
          target.dispose();
        }
        // A few real frames with everything in view: shadow maps, glass (which redraws the room behind it) and the
        // post-processing passes set themselves up here, behind the loading screen.
        await new Promise<void>((resolve) => {
          let frames = 0;
          const step = () => (++frames >= 4 ? resolve() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        });
        for (const object of hidden) object.visible = false;
        for (const object of culled) object.frustumCulled = true;
        // One more frame with the real visibility, so the first frame the player sees is not the first of its kind.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (import.meta.env.DEV) {
          console.info("[ATLAS warm-up]", {
            ms: Math.round(performance.now() - t0),
            meshes: meshCount,
            programs: [programsBefore, gl.info.programs?.length ?? 0],
          });
        }
        onPhaseRef.current("ready");
      },
      SETTLE_MS,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, loaded, total, gl, scene, camera]);

  // If a download hangs and the progress store never changes again, show the office anyway.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (done.current) return;
      done.current = true;
      onPhaseRef.current("ready");
    }, GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
