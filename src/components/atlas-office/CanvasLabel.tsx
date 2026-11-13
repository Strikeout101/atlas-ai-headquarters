import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { CanvasTexture, LinearFilter, SRGBColorSpace, type Group } from "three";

/** Turns its children toward the camera around the vertical axis only, so nothing tilts. */
export function FaceCamera({ position, children }: { position?: [number, number, number]; children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const node = group.current;
    if (!node) return;
    const world = node.parent;
    const x = node.position.x + (world?.position.x ?? 0);
    const z = node.position.z + (world?.position.z ?? 0);
    node.rotation.y = Math.atan2(camera.position.x - x, camera.position.z - z);
  });
  return (
    <group ref={group} position={position}>
      {children}
    </group>
  );
}

export interface LabelStyle {
  background: string;
  color: string;
  /** Small dot before the first line (e.g. the department colour). */
  accent?: string;
  /** Small dot before the second line (e.g. the activity colour). */
  dot?: string;
  fontSize?: number;
  /** Draws a small tail under the box, for speech bubbles. */
  tail?: boolean;
  /** Spaced capitals with a thin accent underline: department and area signs. */
  caps?: boolean;
}

/** Labels are drawn at 2x and shown at PIXELS_PER_METRE logical pixels per metre, so text stays crisp but small. */
const RESOLUTION = 2;
const PIXELS_PER_METRE = 400;
const FONT = '"Inter", "Segoe UI", system-ui, sans-serif';

function drawLabel(lines: string[], style: LabelStyle) {
  const r = RESOLUTION;
  const fontSize = (style.fontSize ?? 26) * r;
  const subSize = fontSize * 0.78;
  const padX = 14 * r;
  const padY = 9 * r;
  const gap = 4 * r;
  const dotSize = 7 * r;
  const tail = style.tail ? 10 * r : 0;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return { canvas, width: 1, height: 1 };
  const text = style.caps ? lines.map((line) => line.toUpperCase()) : lines;
  const fonts = text.map((_, i) => `${i === 0 ? 600 : 450} ${i === 0 ? fontSize : subSize}px ${FONT}`);
  const spacing = style.caps ? `${0.14 * fontSize}px` : "0px";
  const indent = (i: number) => ((i === 0 ? style.accent : style.dot) ? dotSize + 7 * r : 0);
  const widths = text.map((line, i) => {
    context.font = fonts[i];
    context.letterSpacing = spacing;
    return Math.min(context.measureText(line).width, 560 * r) + indent(i);
  });
  const heights = text.map((_, i) => (i === 0 ? fontSize : subSize) * 1.18);
  const width = Math.ceil(Math.max(...widths) + padX * 2);
  const boxHeight = Math.ceil(heights.reduce((a, b) => a + b, 0) + gap * (text.length - 1) + padY * 2);
  const height = boxHeight + tail;
  canvas.width = width;
  canvas.height = height;
  const radius = Math.min(boxHeight / 2, 16 * r);
  context.fillStyle = style.background;
  context.beginPath();
  context.roundRect(0.5 * r, 0.5 * r, width - r, boxHeight - r, radius);
  if (style.tail) {
    context.moveTo(width / 2 - 8 * r, boxHeight - r);
    context.lineTo(width / 2, height);
    context.lineTo(width / 2 + 8 * r, boxHeight - r);
  }
  context.fill();
  // Hairline edge, like frosted glass.
  context.strokeStyle = "rgba(255, 255, 255, 0.14)";
  context.lineWidth = r;
  context.beginPath();
  context.roundRect(0.5 * r, 0.5 * r, width - r, boxHeight - r, radius);
  context.stroke();
  if (style.caps && style.accent) {
    context.fillStyle = style.accent;
    context.fillRect(padX, boxHeight - 4 * r, width - padX * 2, 2 * r);
  }
  context.textBaseline = "middle";
  let y = padY;
  text.forEach((line, i) => {
    const lineHeight = heights[i];
    const centre = y + lineHeight / 2;
    const marker = i === 0 ? style.accent : style.dot;
    let x = padX;
    if (marker && !(style.caps && i === 0)) {
      context.fillStyle = marker;
      context.beginPath();
      context.arc(x + dotSize / 2, centre, dotSize / 2, 0, Math.PI * 2);
      context.fill();
      x += dotSize + 7 * r;
    } else if (style.caps && i === 0) {
      x = (width - widths[0]) / 2; // signs are centred
    }
    context.font = fonts[i];
    context.letterSpacing = spacing;
    context.fillStyle = i === 0 ? style.color : style.color.startsWith("#") ? `${style.color}b8` : style.color;
    context.fillText(line, x, centre + r, 560 * r);
    y += lineHeight + gap;
  });
  return { canvas, width: width / r, height: height / r };
}

/** A camera-facing text plate rendered into a texture. Lines are short; the first is bold. */
export function useLabelTexture(lines: string[], style: LabelStyle) {
  const key = JSON.stringify([lines, style]);
  const label = useMemo(() => {
    const { canvas, width, height } = drawLabel(lines, style);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    return { texture, width: width / PIXELS_PER_METRE, height: height / PIXELS_PER_METRE };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => label.texture.dispose(), [label]);
  return label;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Flat label plate. Parent is expected to face the camera. */
export function LabelPlate({
  lines,
  style,
  position,
  scale = 1,
}: {
  lines: string[];
  style: LabelStyle;
  position: [number, number, number];
  scale?: number;
}) {
  const { texture, width, height } = useLabelTexture(lines, style);
  return (
    <mesh position={[position[0], position[1] + (height * scale) / 2, position[2]]} renderOrder={10}>
      <planeGeometry args={[width * scale, height * scale]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
