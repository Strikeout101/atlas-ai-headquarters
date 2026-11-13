import { useEffect, useMemo } from "react";
import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";

const FONT = '"Inter", "Segoe UI", system-ui, sans-serif';

function signTexture(label: string, width: number, height: number) {
  const scale = 512; // canvas pixels per metre
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (context) {
    const w = canvas.width;
    const h = canvas.height;
    context.clearRect(0, 0, w, h);
    const fontSize = h * 0.36;
    context.font = `600 ${fontSize}px ${FONT}`;
    context.letterSpacing = `${fontSize * 0.28}px`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#f4f7fa";
    // letterSpacing also pads the end of the text; shift by half a space to keep it optically centred.
    context.fillText(label.toUpperCase(), w / 2 + fontSize * 0.14, h * 0.46, w * 0.9);
    const lineWidth = Math.min(w * 0.22, context.measureText(label.toUpperCase()).width * 0.35);
    context.fillStyle = "#38d7ff";
    context.fillRect(w / 2 - lineWidth / 2, h * 0.76, lineWidth, Math.max(2, h * 0.025));
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/**
 * A slim graphite panel with centred, spaced capitals and a short cyan rule. `doubleSided` signs straddle a glass
 * wall (the panel is solid, so the lettering never shows through the glass mirrored) and read from both sides.
 */
export default function RoomSign({
  label,
  position,
  width = 1.8,
  height = 0.4,
  doubleSided = true,
}: {
  label: string;
  position: [number, number, number];
  width?: number;
  height?: number;
  doubleSided?: boolean;
}) {
  const texture = useMemo(() => signTexture(label, width, height), [label, width, height]);
  useEffect(() => () => texture.dispose(), [texture]);
  const depth = doubleSided ? 0.07 : 0.03;
  const faces = doubleSided ? [0, Math.PI] : [0];

  return (
    <group position={position}>
      <mesh castShadow={false} receiveShadow>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color="#141a20" roughness={0.38} metalness={0.45} />
      </mesh>
      {faces.map((turn) => (
        <mesh
          key={turn}
          rotation-y={turn}
          position={[0, 0, (turn === 0 ? 1 : -1) * (depth / 2 + 0.002)]}
        >
          <planeGeometry args={[width, height]} />
          <meshBasicMaterial map={texture} transparent toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
