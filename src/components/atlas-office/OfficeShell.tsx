import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { DoubleSide, Mesh, MeshPhysicalMaterial, type Material } from "three";
import type { FloorId } from "./layout";

/**
 * Building shell built by art/blender/build_atlas_shell.py (floors, walls, ceiling, glass, trim). The floor below
 * the Director's is the same build without the executive office (ATLAS_SHELL_VARIANT=lower).
 */
export const SHELL_URLS: Record<FloorId, string> = {
  director: "/models/atlas/office-shell.glb",
  lower: "/models/atlas/office-shell-lower.glb",
};

/** Surfaces that only receive shadows; everything else also casts them. */
const FLAT_SURFACES = new Set([
  "ATLAS_FloorTiles",
  "ATLAS_WoodFloor",
  "ATLAS_Carpet",
  "ATLAS_LightPanel",
  "ATLAS_NeonCyan",
  "ATLAS_NeonAmber",
]);

export default function OfficeShell({ floor = "director" }: { floor?: FloorId }) {
  const { scene } = useGLTF(SHELL_URLS[floor]);
  const glass = useMemo(
    () =>
      new MeshPhysicalMaterial({
        name: "ATLAS_Glass",
        color: "#d4e9f2",
        roughness: 0.04,
        metalness: 0,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        side: DoubleSide,
        envMapIntensity: 1.6,
        specularIntensity: 1,
      }),
    [],
  );
  useEffect(() => () => glass.dispose(), [glass]);

  const shell = useMemo(() => {
    const root = scene.clone(true);
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const name = (object.material as Material).name;
      if (name === "ATLAS_Glass") {
        // The exported placeholder only marks the panes; real glass is set up here.
        object.material = glass;
        object.castShadow = false;
        object.receiveShadow = false;
        object.renderOrder = 2;
        return;
      }
      object.castShadow = !FLAT_SURFACES.has(name);
      object.receiveShadow = true;
    });
    return root;
  }, [scene, glass]);

  return <primitive object={shell} />;
}

useGLTF.preload(SHELL_URLS.director);
useGLTF.preload(SHELL_URLS.lower);
