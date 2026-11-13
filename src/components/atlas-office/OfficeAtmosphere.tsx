import { useEffect } from "react";
import { useTexture, Environment } from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { DoubleSide, RepeatWrapping, SRGBColorSpace } from "three";
import { FLOOR } from "./layout";
import OfficeCity from "./OfficeCity";

/**
 * Lighting, sky and post-processing for the ATLAS office.
 * - Indoor HDRI for soft fill light and reflections (not visible).
 * - Sunset city HDRI as the sky, a skyline strip at the horizon, and a 3D city below (OfficeCity) so the office
 *   reads as high up even right at the glass.
 * - Warm low sun through the window wall, ceiling fixtures as point lights.
 * - Ambient occlusion, bloom on emissive trim/screens, and neutral tone mapping, which keeps sprite colours true.
 */

export const ATLAS_HDRI = {
  lighting: "/hdri/office-room-1k.hdr",
  sky: "/hdri/city-sunset-2k.hdr",
  skyline: "/textures/city-skyline.webp",
} as const;

/** Far enough out that the 3D city (OfficeCity, radius CITY_RADIUS) fits inside it. */
const SKYLINE_RADIUS = 175;
/** The panorama was framed at 58 m; heights scale with the radius so it covers the same angles. */
const SKYLINE_SCALE = SKYLINE_RADIUS / 58;
/** Horizontal texture offset that puts the tallest towers in view of the window wall. */
const SKYLINE_FACING = 0.36;
const HAZE = "#77736f";
/**
 * postprocessing's ToneMappingMode.NEUTRAL (Khronos PBR Neutral). "postprocessing" is only a dependency of
 * @react-three/postprocessing, and pnpm does not let app code import it directly, so the value is inlined.
 */
const NEUTRAL_TONE_MAPPING = 8;

function Skyline() {
  const texture = useTexture(ATLAS_HDRI.skyline);
  useEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    // Seen from inside the cylinder, so mirror horizontally.
    texture.repeat.set(-1, 1);
    texture.offset.set(SKYLINE_FACING, 0);
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }, [texture]);
  // Starting well below the floor puts the city's horizon under eye level, like a high-rise view.
  const bottom = -14 * SKYLINE_SCALE;
  const top = 20 * SKYLINE_SCALE;
  return (
    <group>
      <mesh position={[0, (bottom + top) / 2, 0]}>
        <cylinderGeometry args={[SKYLINE_RADIUS, SKYLINE_RADIUS, top - bottom, 96, 1, true]} />
        <meshBasicMaterial
          map={texture}
          side={DoubleSide}
          transparent
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>
      {/* Haze below the skyline hides the panorama's rooftop foreground. */}
      <mesh position={[0, bottom - 40 * SKYLINE_SCALE, 0]}>
        <cylinderGeometry args={[SKYLINE_RADIUS + 1, SKYLINE_RADIUS + 1, 80 * SKYLINE_SCALE, 48, 1, true]} />
        <meshBasicMaterial color={HAZE} side={DoubleSide} toneMapped={false} />
      </mesh>
      <mesh position={[0, bottom - 80 * SKYLINE_SCALE, 0]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[SKYLINE_RADIUS + 2, 48]} />
        <meshBasicMaterial color={HAZE} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Ceiling fixtures over the desk rows, lounge and glass rooms. */
const CEILING_LIGHTS: Array<[number, number]> = [
  ...[-8, -4, 0, 4, 8].map((x): [number, number] => [x, 0.4]),
  ...[-8, -4, 0, 4, 8].map((x): [number, number] => [x, 4.6]),
  [-2.85, -4.2],
  [3.65, -4.4],
  [-8, -4.4],
  [9.3, -4.2],
  [-10, 0],
];

export default function OfficeAtmosphere({ quality = "high" }: { quality?: "high" | "low" }) {
  return (
    <>
      <Environment files={ATLAS_HDRI.lighting} environmentIntensity={0.45} />
      <Environment
        files={ATLAS_HDRI.sky}
        background="only"
        backgroundIntensity={0.85}
        backgroundRotation={[0, Math.PI * 0.7, 0]}
      />
      <Skyline />
      <OfficeCity />
      {/* Distance haze over the city, the same colour as the haze under the skyline panorama. Starts beyond the
          office's far wall, so the interior is never fogged. */}
      <fog attach="fog" args={[HAZE, 45, 185]} />

      <hemisphereLight args={["#f3efe8", "#2c2724", 0.35]} />
      {/* Low evening sun through the window wall. */}
      <directionalLight
        position={[6, 7, FLOOR.maxZ + 9]}
        intensity={2.2}
        color="#ffd6a8"
        castShadow
        shadow-mapSize={quality === "high" ? [2048, 2048] : [1024, 1024]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      {CEILING_LIGHTS.map(([x, z]) => (
        <pointLight
          key={`${x}:${z}`}
          position={[x, FLOOR.ceiling - 0.25, z]}
          intensity={4.5}
          distance={7}
          decay={2}
          color="#ffe6c7"
        />
      ))}

      <EffectComposer multisampling={quality === "high" ? 4 : 0} enableNormalPass={false}>
        <N8AO
          aoRadius={0.8}
          distanceFalloff={0.6}
          intensity={quality === "high" ? 2.4 : 1.6}
          quality={quality === "high" ? "medium" : "performance"}
          halfRes={quality !== "high"}
        />
        <Bloom luminanceThreshold={1.05} luminanceSmoothing={0.2} intensity={0.55} mipmapBlur />
        <Vignette offset={0.3} darkness={0.35} />
        <ToneMapping mode={NEUTRAL_TONE_MAPPING} />
      </EffectComposer>
    </>
  );
}
