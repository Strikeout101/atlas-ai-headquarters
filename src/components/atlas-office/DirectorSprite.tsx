import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { LinearFilter, SRGBColorSpace, type Group, type MeshBasicMaterial } from "three";
import { DIRECTOR_SHEET, facingFromView, sheetOffset, walkColumn, type Facing } from "./spriteFacing";

export interface DirectorMotion {
  moving: boolean;
  /** Shift held: the 3D character jogs instead of walking. */
  running: boolean;
  /** Metres walked so far; drives the walk cycle so steps match speed. */
  distance: number;
  headingX: number;
  headingZ: number;
  /** Distance from camera to the player, used to fade the sprite when the camera is pressed close. */
  cameraDistance: number;
  /** The Director should be sitting in the executive chair (set by the controller). */
  seated?: boolean;
  /** Set by the 3D character while it is sitting down, seated or standing up, so the controller holds still. */
  inChair?: boolean;
}

export const DIRECTOR_HEIGHT = 1.75;

/** The Director's pixel-art character: a camera-facing sprite that picks its row from the camera angle. */
export default function DirectorSprite({ motion }: { motion: MutableRefObject<DirectorMotion> }) {
  const source = useTexture(DIRECTOR_SHEET.url);
  const texture = useMemo(() => {
    const sheet = source.clone();
    sheet.colorSpace = SRGBColorSpace;
    sheet.minFilter = LinearFilter;
    sheet.magFilter = LinearFilter;
    sheet.generateMipmaps = false;
    sheet.repeat.set(1 / DIRECTOR_SHEET.columns, 1 / DIRECTOR_SHEET.rows);
    sheet.needsUpdate = true;
    return sheet;
  }, [source]);
  useEffect(() => () => texture.dispose(), [texture]);
  const billboard = useRef<Group>(null);
  const material = useRef<MeshBasicMaterial>(null);
  const facing = useRef<Facing>("back");
  const frameKey = useRef("");

  const planeHeight = DIRECTOR_HEIGHT / DIRECTOR_SHEET.contentHeightRatio;
  const planeWidth = planeHeight * DIRECTOR_SHEET.frameAspect;
  const planeY = planeHeight / 2 - planeHeight * DIRECTOR_SHEET.footPaddingRatio;

  useFrame(({ camera }) => {
    const group = billboard.current;
    if (!group) return;
    const world = group.parent;
    const x = world ? world.position.x : 0;
    const z = world ? world.position.z : 0;
    const viewX = x - camera.position.x;
    const viewZ = z - camera.position.z;
    // Cylindrical billboard: turn toward the camera around the vertical axis only.
    group.rotation.y = Math.atan2(-viewX, -viewZ) - (world ? world.rotation.y : 0);
    const state = motion.current;
    facing.current = facingFromView(state.headingX, state.headingZ, viewX, viewZ, facing.current);
    const column = walkColumn(state.distance, state.moving);
    const row = DIRECTOR_SHEET.rowByFacing[facing.current];
    const key = `${column}:${row}`;
    if (key !== frameKey.current) {
      frameKey.current = key;
      const [u, v] = sheetOffset(column, row);
      texture.offset.set(u, v);
    }
    if (material.current) {
      // Fully hidden when the camera is pressed against him, so he never fills the screen.
      const opacity = Math.min(1, Math.max(0, (state.cameraDistance - 0.9) / 0.9));
      material.current.opacity = opacity;
      material.current.depthWrite = opacity > 0.95;
      material.current.visible = opacity > 0.02;
    }
  });

  return (
    <>
      <group ref={billboard}>
        <mesh position={[0, planeY, 0]} userData={{ atlasPlayer: true }}>
          <planeGeometry args={[planeWidth, planeHeight]} />
          <meshBasicMaterial ref={material} map={texture} transparent alphaTest={0.08} toneMapped={false} />
        </mesh>
      </group>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.012, 0]}>
        <circleGeometry args={[0.32, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} depthWrite={false} />
      </mesh>
    </>
  );
}
