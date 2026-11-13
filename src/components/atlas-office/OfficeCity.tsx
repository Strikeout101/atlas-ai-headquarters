import { useEffect, useMemo } from "react";
import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";
import { FLOOR } from "./layout";

/**
 * The city below the office windows: the tower's own facade going down to the street, then a street grid with
 * buildings that mostly stop below the office floor, so up close to the glass you look down onto roofs and streets
 * instead of into the flat skyline panorama's haze. Distance fades into scene fog of the same colour as that haze.
 * Everything is generated here (seeded, so the city never changes); no downloaded assets.
 */

/** The office floor is about 20 storeys up. */
export const STREET_Y = -62;
/** Buildings stay inside the skyline panorama's cylinder (OfficeAtmosphere, radius 175); fog hides the edge. */
const CITY_RADIUS = 165;
const BLOCK = 30;
const STREET = 9;
const FLOOR_HEIGHT = 3.6;
const BAY_WIDTH = 1.8;
/** One facade texture tile covers this many storeys and window bays. */
const TILE_FLOORS = 4;
const TILE_BAYS = 8;

type FacadeKind = "glass" | "concrete" | "stone";

/** Small deterministic random generator (mulberry32), so the skyline is the same every visit. */
function random(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Facade tile (colour) and its lit-windows mask (emissive), TILE_FLOORS x TILE_BAYS windows. */
function facadeTextures(kind: FacadeKind, seed: number): { map: Texture; emissive: Texture } {
  const size = 512;
  const color = document.createElement("canvas");
  const lit = document.createElement("canvas");
  color.width = color.height = lit.width = lit.height = size;
  const c = color.getContext("2d");
  const l = lit.getContext("2d");
  const rand = random(seed);
  if (c && l) {
    const style = {
      // Curtain wall: tall glass panes reflecting the sky, thin mullions, dark spandrel band.
      glass: { wall: "#39424c", sky: ["#8d9aa7", "#7b8a99", "#a2acb6", "#6f7f8f"], ground: "#28313b", frame: 0.06, sill: 0.2 },
      // Punched windows in pale concrete.
      concrete: { wall: "#a8a296", sky: ["#6f7c89", "#5f6c79", "#7d8995"], ground: "#2c343c", frame: 0.34, sill: 0.42 },
      // Warm stone with smaller windows.
      stone: { wall: "#8a7663", sky: ["#66727e", "#58646f", "#717c87"], ground: "#272d33", frame: 0.4, sill: 0.46 },
    }[kind];
    c.fillStyle = style.wall;
    c.fillRect(0, 0, size, size);
    // Weathering: faint vertical streaks.
    for (let i = 0; i < 40; i++) {
      c.fillStyle = `rgba(0, 0, 0, ${0.02 + rand() * 0.04})`;
      c.fillRect(rand() * size, 0, 2 + rand() * 6, size);
    }
    l.fillStyle = "#000000";
    l.fillRect(0, 0, size, size);
    const cellW = size / TILE_BAYS;
    const cellH = size / TILE_FLOORS;
    for (let floor = 0; floor < TILE_FLOORS; floor++) {
      for (let bay = 0; bay < TILE_BAYS; bay++) {
        const x = bay * cellW + cellW * style.frame * 0.5;
        const y = floor * cellH + cellH * style.sill * 0.55;
        const w = cellW * (1 - style.frame);
        const h = cellH * (1 - style.sill);
        // Panes reflect the sky at the top and the darker city below.
        const gradient = c.createLinearGradient(x, y, x, y + h);
        gradient.addColorStop(0, style.sky[Math.floor(rand() * style.sky.length)]);
        gradient.addColorStop(1, style.ground);
        c.fillStyle = gradient;
        c.fillRect(x, y, w, h);
        // A few offices with the lights on.
        if (rand() < 0.12) {
          const warm = rand() < 0.7 ? "#ffe2b8" : "#eef3ff";
          const blind = rand() < 0.4 ? h * (0.15 + rand() * 0.4) : 0;
          l.globalAlpha = 0.35 + rand() * 0.4;
          l.fillStyle = warm;
          l.fillRect(x, y + blind, w, h - blind);
          l.globalAlpha = 1;
        }
      }
      // Floor slab line.
      c.fillStyle = "rgba(0, 0, 0, 0.25)";
      c.fillRect(0, floor * cellH, size, 3);
    }
  }
  const toTexture = (canvas: HTMLCanvasElement) => {
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.anisotropy = 8;
    return texture;
  };
  return { map: toTexture(color), emissive: toTexture(lit) };
}

/** Asphalt with lane markings and pavements, one texture tile per city block (BLOCK + STREET metres). */
function streetTexture(): Texture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const c = canvas.getContext("2d");
  if (c) {
    const metre = size / (BLOCK + STREET);
    c.fillStyle = "#2e3033";
    c.fillRect(0, 0, size, size);
    // Pavement ring around the block, then the block itself (plaza / courtyard).
    const kerb = STREET * metre;
    c.fillStyle = "#77736c";
    c.fillRect(kerb / 2, kerb / 2, size - kerb, size - kerb);
    c.fillStyle = "#5d5a55";
    c.fillRect(kerb / 2 + 2.5 * metre, kerb / 2 + 2.5 * metre, size - kerb - 5 * metre, size - kerb - 5 * metre);
    // Dashed centre lines.
    c.strokeStyle = "#d9c98a";
    c.lineWidth = 0.18 * metre;
    c.setLineDash([2.5 * metre, 2.5 * metre]);
    for (const line of [0, size]) {
      c.beginPath();
      c.moveTo(line, 0);
      c.lineTo(line, size);
      c.moveTo(0, line);
      c.lineTo(size, line);
      c.stroke();
    }
    // Pedestrian crossings at the corners.
    c.setLineDash([]);
    c.fillStyle = "#cfcac0";
    for (let i = -2; i <= 2; i++) {
      c.fillRect(kerb / 2 + 1 * metre, i * 1.1 * metre - 0.3 * metre, 0.6 * metre, kerb * 0.8);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

interface Box {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  kind: FacadeKind;
}

/** Wall quads with UVs in facade tiles (so windows keep their real size), and roof quads, for many boxes. */
function buildingGeometry(boxes: Box[], base: number) {
  const walls: number[] = [];
  const wallUv: number[] = [];
  const wallNormals: number[] = [];
  const roofs: number[] = [];
  const roofNormals: number[] = [];
  const tileW = TILE_BAYS * BAY_WIDTH;
  const tileH = TILE_FLOORS * FLOOR_HEIGHT;
  for (const box of boxes) {
    const x0 = box.x - box.width / 2;
    const x1 = box.x + box.width / 2;
    const z0 = box.z - box.depth / 2;
    const z1 = box.z + box.depth / 2;
    const y0 = base;
    const y1 = base + box.height;
    const v1 = box.height / tileH;
    // Each side: corners a -> b along the wall, outward normal n.
    const sides: Array<[[number, number], [number, number], [number, number]]> = [
      [[x0, z1], [x1, z1], [0, 1]],
      [[x1, z1], [x1, z0], [1, 0]],
      [[x1, z0], [x0, z0], [0, -1]],
      [[x0, z0], [x0, z1], [-1, 0]],
    ];
    let u = 0;
    for (const [[ax, az], [bx, bz], [nx, nz]] of sides) {
      const length = Math.hypot(bx - ax, bz - az) / tileW;
      // Two triangles: a-bottom, b-bottom, b-top / a-bottom, b-top, a-top.
      walls.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
      wallUv.push(u, 0, u + length, 0, u + length, v1, u, 0, u + length, v1, u, v1);
      for (let i = 0; i < 6; i++) wallNormals.push(nx, 0, nz);
      u += length;
    }
    roofs.push(x0, y1, z0, x0, y1, z1, x1, y1, z1, x0, y1, z0, x1, y1, z1, x1, y1, z0);
    for (let i = 0; i < 6; i++) roofNormals.push(0, 1, 0);
  }
  const wall = new BufferGeometry();
  wall.setAttribute("position", new Float32BufferAttribute(walls, 3));
  wall.setAttribute("normal", new Float32BufferAttribute(wallNormals, 3));
  wall.setAttribute("uv", new Float32BufferAttribute(wallUv, 2));
  const roof = new BufferGeometry();
  roof.setAttribute("position", new Float32BufferAttribute(roofs, 3));
  roof.setAttribute("normal", new Float32BufferAttribute(roofNormals, 3));
  return { wall, roof };
}

/** Seeded city layout: a street grid with 1-4 buildings per block, clear of the ATLAS tower. */
export function cityLayout(seed = 7): Box[] {
  const rand = random(seed);
  const boxes: Box[] = [];
  const pitch = BLOCK + STREET;
  const cells = Math.ceil(CITY_RADIUS / pitch) + 1;
  const kinds: FacadeKind[] = ["glass", "concrete", "stone"];
  for (let i = -cells; i <= cells; i++) {
    for (let j = -cells; j <= cells; j++) {
      const cx = i * pitch;
      const cz = j * pitch;
      // The ATLAS tower stands on the block at the origin.
      if (i === 0 && j === 0) continue;
      const lots = rand() < 0.35 ? 1 : rand() < 0.6 ? 2 : 4;
      const split = lots === 4 ? 2 : 1;
      const lotW = BLOCK / (lots === 1 ? 1 : 2);
      const lotD = BLOCK / split;
      for (let lot = 0; lot < lots; lot++) {
        const lx = cx - BLOCK / 2 + lotW * ((lot % 2) + 0.5);
        const lz = cz - BLOCK / 2 + lotD * (Math.floor(lot / 2) + 0.5);
        const x = lots === 1 ? cx : lx;
        const z = lots === 1 ? cz : lots === 2 ? cz : lz;
        if (Math.hypot(x, z) > CITY_RADIUS) continue;
        const width = (lots === 1 ? BLOCK : lotW) * (0.72 + rand() * 0.2);
        const depth = (lots === 4 ? lotD : BLOCK) * (0.72 + rand() * 0.2);
        // Mostly below the office (rooftops seen from above); a few towers rise past eye level.
        const tall = rand() < 0.12;
        const height = tall ? 70 + rand() * 30 : 14 + rand() * 42;
        boxes.push({ x, z, width, depth, height, kind: kinds[Math.floor(rand() * kinds.length)] });
      }
    }
  }
  return boxes;
}

export default function OfficeCity() {
  const city = useMemo(() => {
    const boxes = cityLayout();
    const kinds: FacadeKind[] = ["glass", "concrete", "stone"];
    const parts = kinds.map((kind, index) => {
      const { wall } = buildingGeometry(
        boxes.filter((box) => box.kind === kind),
        STREET_Y,
      );
      const textures = facadeTextures(kind, 11 + index);
      const material = new MeshStandardMaterial({
        map: textures.map,
        emissiveMap: textures.emissive,
        emissive: "#ffffff",
        emissiveIntensity: 0.5,
        roughness: kind === "glass" ? 0.3 : 0.85,
        metalness: kind === "glass" ? 0.25 : 0,
        envMapIntensity: kind === "glass" ? 0.8 : 0.3,
      });
      return { geometry: wall, material, textures: [textures.map, textures.emissive] };
    });
    const roofGeometry = buildingGeometry(boxes, STREET_Y).roof;
    const roofMaterial = new MeshStandardMaterial({ color: "#4a4b4d", roughness: 0.95 });

    // The ATLAS tower's own glass facade, from the street up to just under the office floor.
    const tower: Box = {
      x: 0,
      z: 0,
      width: FLOOR.maxX - FLOOR.minX + 0.9,
      depth: FLOOR.maxZ - FLOOR.minZ + 0.9,
      height: -STREET_Y - 0.35,
      kind: "glass",
    };
    const towerTextures = facadeTextures("glass", 99);
    const towerGeometry = buildingGeometry([tower], STREET_Y).wall;
    const towerMaterial = new MeshStandardMaterial({
      map: towerTextures.map,
      emissiveMap: towerTextures.emissive,
      emissive: "#ffffff",
      emissiveIntensity: 0.4,
      roughness: 0.3,
      metalness: 0.3,
    });

    const street = streetTexture();
    const extent = (CITY_RADIUS + 25) * 2;
    // Tile centres (the blocks) line up with the building grid: uv 0.5 at the origin maps to a tile centre.
    const repeat = extent / (BLOCK + STREET);
    street.repeat.set(repeat, repeat);
    street.offset.set(0.5 - 0.5 * repeat, 0.5 - 0.5 * repeat);
    const groundMaterial = new MeshStandardMaterial({ map: street, roughness: 0.95 });
    return {
      parts,
      roofGeometry,
      roofMaterial,
      towerGeometry,
      towerMaterial,
      towerTextures: [towerTextures.map, towerTextures.emissive],
      groundMaterial,
      street,
      extent,
    };
  }, []);

  useEffect(
    () => () => {
      for (const part of city.parts) {
        part.geometry.dispose();
        part.material.dispose();
        part.textures.forEach((texture) => texture.dispose());
      }
      city.roofGeometry.dispose();
      city.roofMaterial.dispose();
      city.towerGeometry.dispose();
      city.towerMaterial.dispose();
      city.towerTextures.forEach((texture) => texture.dispose());
      city.groundMaterial.dispose();
      city.street.dispose();
    },
    [city],
  );

  return (
    <group>
      {city.parts.map((part, index) => (
        <mesh key={index} geometry={part.geometry} material={part.material} />
      ))}
      <mesh geometry={city.roofGeometry} material={city.roofMaterial} />
      <mesh geometry={city.towerGeometry} material={city.towerMaterial} />
      <mesh position={[0, STREET_Y, 0]} rotation-x={-Math.PI / 2} material={city.groundMaterial}>
        <planeGeometry args={[city.extent, city.extent]} />
      </mesh>
    </group>
  );
}
