import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { CanvasTexture, Color, Mesh, MeshStandardMaterial, SRGBColorSpace, type Material, type Object3D } from "three";
import { FURNITURE, type FloorId } from "./layout";
import {
  MONITOR_CANVAS,
  TV_CANVAS,
  drawBoard,
  drawDeskScreen,
  drawExecutiveScreen,
  type BoardData,
  type DeskScreen,
} from "./screenArt";

/**
 * Furniture built by art/blender/build_atlas_furniture.py from the downloaded models and placed at
 * the layout.ts positions. Node names follow "<asset>_<n>", e.g. monitor_3, arcade_0.
 */
export const FURNITURE_URL = "/models/atlas/office-furniture.glb";

/** Thin, floor-level or transparent parts that should not cast shadows. */
const NO_SHADOW = /^(mouse|keyboard_|table_lamp|plant_)/;
const ARCADE_GLOW = new Color("#5af0ff");

function isArcadeScreen(material: Material): boolean {
  return /screen/i.test(material.name);
}

export type { BoardData, DeskScreen, ScreenState } from "./screenArt";

/**
 * Splits a placed node's name, "<asset>_<n>" or "<floor>__<asset>_<n>" for pieces on one floor only
 * (build_atlas_furniture.py), into the floor tag and the "<asset>_<n>" part.
 */
export function pieceName(name: string): { floor: FloorId | null; asset: string } {
  const match = /^(director|lower)__(.*)$/.exec(name);
  return match ? { floor: match[1] as FloorId, asset: match[2] } : { floor: null, asset: name };
}
/** Monitor index i belongs to desk i (layout DESKS order); the last monitor is the Director's. */
export const EXECUTIVE_MONITOR_INDEX = 10;
/** Screens redraw twice a second, so the terminal cursor blinks and the clocks stay current. */
const REDRAW_SECONDS = 0.5;

interface LiveScreen {
  material: MeshStandardMaterial;
  texture: CanvasTexture;
  context: CanvasRenderingContext2D;
}

/** Gives a screen material its own canvas, shown as an emissive picture (screens light themselves). */
function liveScreen(material: MeshStandardMaterial, size: { width: number; height: number }): LiveScreen | null {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false; // glTF UVs
  texture.anisotropy = 8;
  const own = material.clone();
  own.color.set("#000000");
  own.map = null;
  own.emissive.set("#ffffff");
  own.emissiveMap = texture;
  own.emissiveIntensity = 1.1;
  own.roughness = 0.22;
  own.metalness = 0;
  return { material: own, texture, context };
}

export default function OfficeFurniture({
  floor = "director",
  arcadeOn,
  screens,
  board,
}: {
  /** The floor below uses the same furniture without the executive office's pieces. */
  floor?: FloorId;
  arcadeOn: boolean;
  /** What each desk's monitor shows, by desk index. */
  screens: DeskScreen[];
  /** The conference room TV's company board. */
  board: BoardData;
}) {
  const { scene } = useGLTF(FURNITURE_URL);
  // One memo clones the furniture and gives the arcade, each monitor and the TV their own screen materials.
  // It must stay one step: React may run a memo twice (StrictMode) and keep either result, so materials made in a
  // separate memo could end up belonging to a clone that isn't the one on screen.
  const { furniture, arcadeScreens, live } = useMemo(() => {
    const root = scene.clone(true);
    const arcade: MeshStandardMaterial[] = [];
    const monitors = new Map<number, LiveScreen>();
    let tv: LiveScreen | null = null;
    root.traverse((object: Object3D) => {
      if (!(object instanceof Mesh)) return;
      const placed = pieceName(object.parent?.name ?? object.name).asset;
      object.castShadow = !NO_SHADOW.test(placed) && !NO_SHADOW.test(object.name);
      object.receiveShadow = true;
      // Screen materials, split out by the Blender build ("ATLAS_Screen", "ATLAS_TVScreen" mapped onto the whole
      // texture). Nodes are named "[<floor>__]<asset>_<n>"; meshes sit directly under them.
      const monitor = /^monitor_(\d+)$/.exec(placed);
      const own = (material: Material) => {
        if (!(material instanceof MeshStandardMaterial)) return material;
        if (placed === "arcade_0" && isArcadeScreen(material)) {
          const copy = material.clone();
          arcade.push(copy);
          return copy;
        }
        if (monitor && /ATLAS_Screen/.test(material.name)) {
          const screen = liveScreen(material, MONITOR_CANVAS);
          if (!screen) return material;
          monitors.set(Number(monitor[1]), screen);
          return screen.material;
        }
        if (placed === "tv_0" && /ATLAS_TVScreen/.test(material.name)) {
          tv = liveScreen(material, TV_CANVAS);
          return tv?.material ?? material;
        }
        return material;
      };
      object.material = Array.isArray(object.material) ? object.material.map(own) : own(object.material);
    });
    return { furniture: root, arcadeScreens: arcade, live: { monitors, tv: tv as LiveScreen | null } };
  }, [scene]);

  // Placed pieces are the root's direct children. Pieces tagged with a floor (the executive office and pool table
  // upstairs; desk 5 and the lounge nook downstairs) show on that floor only.
  useEffect(() => {
    for (const piece of furniture.children) {
      const only = pieceName(piece.name).floor;
      piece.visible = !only || only === floor;
    }
  }, [furniture, floor]);
  useEffect(() => {
    for (const screen of arcadeScreens) {
      screen.emissive = arcadeOn ? ARCADE_GLOW : new Color("#000000");
      screen.emissiveIntensity = arcadeOn ? 1.4 : 0;
      screen.needsUpdate = true;
    }
  }, [arcadeOn, arcadeScreens]);
  useEffect(
    () => () => {
      arcadeScreens.forEach((screen) => screen.dispose());
      for (const screen of [...live.monitors.values(), ...(live.tv ? [live.tv] : [])]) {
        screen.texture.dispose();
        screen.material.dispose();
      }
    },
    [arcadeScreens, live],
  );

  const latest = useRef({ screens, board });
  latest.current = { screens, board };
  const sinceDraw = useRef(REDRAW_SECONDS);
  const blink = useRef(false);
  useFrame((_, delta) => {
    sinceDraw.current += delta;
    if (sinceDraw.current < REDRAW_SECONDS) return;
    sinceDraw.current = 0;
    blink.current = !blink.current;
    const now = new Date();
    const { screens: desks, board: company } = latest.current;
    live.monitors.forEach((screen, index) => {
      if (index === EXECUTIVE_MONITOR_INDEX) drawExecutiveScreen(screen.context, now, company.agentsWorking);
      else drawDeskScreen(screen.context, desks[index] ?? { state: "off" }, now, blink.current);
      const off = index !== EXECUTIVE_MONITOR_INDEX && (desks[index]?.state ?? "off") === "off";
      screen.material.emissiveIntensity = off ? 0 : 1.1;
      screen.texture.needsUpdate = true;
    });
    if (live.tv && blink.current) {
      drawBoard(live.tv.context, company, now);
      live.tv.texture.needsUpdate = true;
    }
  });

  const { arcade } = FURNITURE;
  return (
    <>
      <primitive object={furniture} />
      {/* The arcade faces east, its back to the west wall. The light stays mounted and only dims when the arcade is
          switched off: adding or removing a light makes three.js recompile every material in the scene. */}
      <pointLight
        position={[arcade.x + 0.9, 1.5, arcade.z]}
        intensity={arcadeOn ? 2.2 : 0}
        distance={3.5}
        decay={2}
        color="#5af0ff"
      />
    </>
  );
}

useGLTF.preload(FURNITURE_URL);
