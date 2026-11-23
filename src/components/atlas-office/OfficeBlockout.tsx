import { DoubleSide } from "three";
import RoomSign from "./RoomSign";
import {
  DESKS,
  DESK_DEPTH,
  DESK_WIDTH,
  ELEVATOR,
  FLOOR,
  DESK_INDICES_BY_FLOOR,
  FLOOR_INFO,
  FURNITURE,
  FURNITURE_BY_FLOOR,
  LOWER_NOOK,
  GLASS_WALLS_BY_FLOOR,
  EXECUTIVE_CHAIR,
  MEETING_SEATS,
  SIT_BACK,
  ROOMS,
  deskSeat,
  type FloorId,
  type FloorRect,
} from "./layout";

/**
 * Phase 1 blockout of the office floor plan: simple shapes in the final positions.
 * Later phases replace these with Blender-made models; positions come from layout.ts.
 */

const COLORS = {
  floor: "#3b4248",
  wall: "#2b3036",
  ceiling: "#d9d4cb",
  wood: "#8a5a3c",
  darkWood: "#5b3b28",
  metal: "#5f676e",
  black: "#1c2024",
  white: "#e9e6e0",
  fabric: "#d8ccb8",
  glass: "#9fc3d3",
  neon: "#38d7ff",
  amber: "#ffb347",
  plant: "#4f8a4a",
  pot: "#3a3a3a",
};

function Box({
  position,
  size,
  color,
  opacity = 1,
  emissive,
  emissiveIntensity = 1,
  roughness = 0.7,
  metalness = 0,
  rotationY = 0,
}: {
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  opacity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  rotationY?: number;
}) {
  return (
    <mesh position={position} rotation-y={rotationY} castShadow={opacity === 1} receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity === 1}
        emissive={emissive ?? "#000000"}
        emissiveIntensity={emissive ? emissiveIntensity : 0}
        roughness={roughness}
        metalness={metalness}
      />
    </mesh>
  );
}

/** A box resting on the floor, using a layout footprint. */
function Footprint({
  rect,
  height,
  color,
  y = 0,
  ...rest
}: { rect: FloorRect; height: number; color: string; y?: number } & Partial<Parameters<typeof Box>[0]>) {
  return (
    <Box position={[rect.x, y + height / 2, rect.z]} size={[rect.width, height, rect.depth]} color={color} {...rest} />
  );
}

function Rug({ x, z, width, depth, color }: { x: number; z: number; width: number; depth: number; color: string }) {
  return <Box position={[x, 0.006, z]} size={[width, 0.012, depth]} color={color} roughness={0.95} />;
}

function Chair({ x, z, facing = 0, color = COLORS.black }: { x: number; z: number; facing?: number; color?: string }) {
  return (
    <group position={[x, 0, z]} rotation-y={facing}>
      <Box position={[0, 0.46, 0]} size={[0.5, 0.08, 0.5]} color={color} />
      <Box position={[0, 0.78, 0.22]} size={[0.48, 0.6, 0.07]} color={color} />
      <Box position={[0, 0.22, 0]} size={[0.06, 0.44, 0.06]} color={COLORS.metal} metalness={0.6} roughness={0.4} />
    </group>
  );
}

function Plant({ rect, height = 1.3 }: { rect: FloorRect; height?: number }) {
  const radius = Math.min(rect.width, rect.depth) / 2;
  return (
    <group position={[rect.x, 0, rect.z]}>
      <mesh position={[0, 0.25, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius * 0.75, radius * 0.6, 0.5, 16]} />
        <meshStandardMaterial color={COLORS.pot} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.5 + height / 2, 0]} castShadow>
        <coneGeometry args={[radius * 1.2, height, 9]} />
        <meshStandardMaterial color={COLORS.plant} roughness={0.9} />
      </mesh>
    </group>
  );
}

function Workstation({ x, z }: { x: number; z: number }) {
  const [seatX, seatZ] = deskSeat(DESKS.findIndex(([dx, dz]) => dx === x && dz === z));
  return (
    <group>
      <Box position={[x, 0.74, z]} size={[DESK_WIDTH, 0.05, DESK_DEPTH]} color={COLORS.wood} roughness={0.55} />
      <Box
        position={[x - DESK_WIDTH / 2 + 0.25, 0.36, z]}
        size={[0.45, 0.72, DESK_DEPTH - 0.06]}
        color={COLORS.black}
      />
      <Box
        position={[x + DESK_WIDTH / 2 - 0.04, 0.36, z]}
        size={[0.05, 0.72, DESK_DEPTH - 0.06]}
        color={COLORS.metal}
      />
      {[-0.3, 0.3].map((offset) => (
        <group key={offset}>
          <Box position={[x + offset, 1.08, z - 0.25]} size={[0.56, 0.34, 0.03]} color={COLORS.black} />
          <Box
            position={[x + offset, 1.08, z - 0.233]}
            size={[0.52, 0.3, 0.005]}
            color="#123045"
            emissive="#3fa9f5"
            emissiveIntensity={0.55}
          />
          <Box position={[x + offset, 0.86, z - 0.27]} size={[0.05, 0.2, 0.05]} color={COLORS.metal} />
        </group>
      ))}
      <Box position={[x, 0.775, z + 0.12]} size={[0.45, 0.02, 0.15]} color={COLORS.black} />
      {/* Where the agent working here sits. */}
      <Chair x={seatX} z={seatZ + SIT_BACK} />
    </group>
  );
}

/** Neon strips along a room's door wall, which runs east-west at `z`. */
function GlassRoomTrim({ room, z }: { room: { minX: number; maxX: number }; z: number }) {
  const width = room.maxX - room.minX;
  const centerX = (room.minX + room.maxX) / 2;
  return (
    <>
      {[0.02, 2.45].map((y) => (
        <Box
          key={y}
          position={[centerX, y, z + 0.05]}
          size={[width, 0.03, 0.03]}
          color={COLORS.neon}
          emissive={COLORS.neon}
          emissiveIntensity={2.2}
        />
      ))}
    </>
  );
}

/** Simple-shape building shell, shown only if the Blender shell model cannot load. */
export function BlockoutShell({ floor = "director" }: { floor?: FloorId }) {
  const director = floor === "director";
  const width = FLOOR.maxX - FLOOR.minX;
  const depth = FLOOR.maxZ - FLOOR.minZ;
  const { ceiling } = FLOOR;
  return (
    <>
      {/* Shell */}
      <Box position={[0, -0.1, 0]} size={[width, 0.2, depth]} color={COLORS.floor} roughness={0.85} />
      <mesh position={[0, ceiling, 0]} rotation-x={Math.PI / 2} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color={COLORS.ceiling} side={DoubleSide} roughness={0.95} />
      </mesh>
      <Box position={[0, ceiling / 2, FLOOR.minZ - 0.1]} size={[width + 0.4, ceiling, 0.2]} color={COLORS.wall} />
      <Box position={[FLOOR.minX - 0.1, ceiling / 2, 0]} size={[0.2, ceiling, depth]} color={COLORS.wall} />
      <Box position={[FLOOR.maxX + 0.1, ceiling / 2, 0]} size={[0.2, ceiling, depth]} color={COLORS.wall} />
      {[-8.6, 7.9, 10.9].map((x) => (
        <Box
          key={x}
          position={[x, 1.6, FLOOR.minZ + 0.02]}
          size={[0.08, 2.6, 0.04]}
          color={COLORS.amber}
          emissive={COLORS.amber}
          emissiveIntensity={1.6}
        />
      ))}

      {/* Window wall with the city beyond */}
      <Box
        position={[0, ceiling / 2, FLOOR.maxZ + 0.05]}
        size={[width, ceiling, 0.04]}
        color={COLORS.glass}
        opacity={0.18}
        roughness={0.1}
      />
      {Array.from({ length: 13 }, (_, i) => FLOOR.minX + (i * width) / 12).map((x) => (
        <Box key={x} position={[x, ceiling / 2, FLOOR.maxZ + 0.05]} size={[0.08, ceiling, 0.12]} color={COLORS.black} />
      ))}
      <Box position={[0, 0.06, FLOOR.maxZ + 0.05]} size={[width, 0.12, 0.16]} color={COLORS.black} />
      <Box position={[0, 1.05, FLOOR.maxZ + 0.08]} size={[width, 0.04, 0.06]} color={COLORS.black} />

      {/* Ceiling light panels over the desk rows and lounge */}
      {[0, 4.8, 2.9].flatMap((z) =>
        [-8, -4, 0, 4, 8].map((x) => (
          <Box
            key={`${x}:${z}`}
            position={[x, ceiling - 0.02, z]}
            size={[1.6, 0.03, 0.35]}
            color="#fff7e8"
            emissive="#fff3dc"
            emissiveIntensity={1.4}
          />
        )),
      )}

      {/* Glass rooms */}
      {GLASS_WALLS_BY_FLOOR[floor].map((wall) => (
        <Box
          key={`${wall.x}:${wall.z}`}
          position={[wall.x, ceiling / 2, wall.z]}
          size={[wall.width, ceiling, wall.depth]}
          color={COLORS.glass}
          opacity={0.22}
          roughness={0.08}
        />
      ))}
      {director && <GlassRoomTrim room={ROOMS.executive} z={ROOMS.executive.minZ} />}
      <GlassRoomTrim room={ROOMS.conference} z={ROOMS.conference.maxZ} />

      {/* Elevator */}
      <Box
        position={[ELEVATOR.x, 1.25, FLOOR.minZ + 0.03]}
        size={[ELEVATOR.width + 0.3, 2.5, 0.06]}
        color={COLORS.black}
      />
      {[-0.48, 0.48].map((offset) => (
        <Box
          key={offset}
          position={[ELEVATOR.x + offset, 1.15, FLOOR.minZ + 0.07]}
          size={[0.92, 2.25, 0.04]}
          color="#9aa3aa"
          metalness={0.75}
          roughness={0.3}
        />
      ))}
      <Box
        position={[ELEVATOR.x + 1.35, 1.2, FLOOR.minZ + 0.06]}
        size={[0.12, 0.28, 0.03]}
        color={COLORS.black}
        emissive={COLORS.amber}
        emissiveIntensity={0.9}
      />

      {/* Rugs */}
      {director && <Rug x={-7.7} z={4.1} width={2.6} depth={2.6} color="#b9a184" />}
      {director && <Rug x={-2.85} z={-4.5} width={3.8} depth={2.6} color="#a99a88" />}
      {!director && <Rug x={-2.85} z={-4.75} width={3.6} depth={2.9} color="#b9a184" />}
      <Rug x={3.65} z={-4.4} width={5.6} depth={2.9} color="#b4a48f" />
      <Rug x={0} z={3.1} width={4.4} depth={2.2} color="#b59f86" />
      <Rug x={-7.8} z={-4.4} width={2.3} depth={1.6} color="#a99a88" />
      <mesh position={[6.4, 0.008, 3.2]} rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[1.35, 40]} />
        <meshStandardMaterial color="#e9d9b8" roughness={0.95} />
      </mesh>
    </>
  );
}

/** Room signs, the neon logo and wall accents. Always shown, whichever furniture set is loaded. */
export function OfficeSignage({ floor = "director" }: { floor?: FloorId }) {
  return (
    <>
      {/* On the glass transom above each door, between the neon strip (2.45 m) and the head frame. */}
      {floor === "director" && (
        <RoomSign label="Executive" position={[ROOMS.executive.doorX, 2.79, ROOMS.executive.minZ]} />
      )}
      {/* Above the elevator, so it is clear which floor the doors opened onto. */}
      <RoomSign
        label={`Level ${FLOOR_INFO[floor].level}`}
        position={[ELEVATOR.x, 2.82, FLOOR.minZ + 0.016]}
        width={1.6}
        height={0.4}
        doubleSided={false}
      />
      <RoomSign label="Conference" position={[ROOMS.conference.doorX, 2.79, ROOMS.conference.maxZ]} />
      <mesh position={[-7.8, 2.05, FLOOR.minZ + 0.06]}>
        <torusGeometry args={[0.55, 0.035, 12, 48]} />
        <meshStandardMaterial color={COLORS.neon} emissive={COLORS.neon} emissiveIntensity={2.4} />
      </mesh>
      <RoomSign
        label="ATLAS AI HQ"
        position={[-7.8, 1.15, FLOOR.minZ + 0.016]}
        width={2.2}
        height={0.46}
        doubleSided={false}
      />
      {[1.0, 6.3].map((x) => (
        <Box
          key={x}
          position={[x, 1.75, FLOOR.minZ + 0.04]}
          size={[1.0, 0.05, 0.03]}
          color={COLORS.amber}
          emissive={COLORS.amber}
          emissiveIntensity={1.8}
        />
      ))}
    </>
  );
}

/** Simple-shape furniture in final positions, shown only if the Blender furniture model cannot load. */
export default function OfficeBlockout({ arcadeOn, floor = "director" }: { arcadeOn: boolean; floor?: FloorId }) {
  const f = FURNITURE;
  const nook = LOWER_NOOK;
  const director = floor === "director";
  return (
    <>
      {/* Executive office in the south-west corner (the Director's floor only); he faces east across the desk. */}
      {director && (
        <>
          <Footprint rect={f.executiveDesk} height={0.06} y={0.72} color={COLORS.darkWood} roughness={0.45} />
          <Box
            position={[f.executiveDesk.x, 0.36, f.executiveDesk.z]}
            size={[0.1, 0.72, f.executiveDesk.depth - 0.1]}
            color={COLORS.darkWood}
          />
          <Box position={[-9.2, 1.07, 4.1]} size={[0.03, 0.42, 0.75]} color={COLORS.black} />
          <Box
            position={[-9.216, 1.07, 4.1]}
            size={[0.005, 0.38, 0.7]}
            color="#123045"
            emissive="#55c2ff"
            emissiveIntensity={0.7}
          />
          <Chair x={EXECUTIVE_CHAIR[0]} z={EXECUTIVE_CHAIR[1]} facing={-Math.PI / 2} color="#3a2a22" />
          <Footprint rect={f.bookshelf} height={2.3} color={COLORS.darkWood} />
          {[0.5, 1.0, 1.5, 2.0].map((y) => (
            <Box
              key={y}
              position={[f.bookshelf.x + 0.21, y, f.bookshelf.z]}
              size={[0.02, 0.03, 2.3]}
              color={COLORS.amber}
              emissive={COLORS.amber}
              emissiveIntensity={0.8}
            />
          ))}
          <Chair x={f.guestChairNorth.x} z={f.guestChairNorth.z} facing={Math.PI / 2} color={COLORS.white} />
          <Chair x={f.guestChairSouth.x} z={f.guestChairSouth.z} facing={Math.PI / 2} color={COLORS.white} />
          <Footprint rect={f.loungeChair} height={0.45} color="#c4733a" />
          <Plant rect={f.plantExecutive} />
          {/* Pool table where the old office stood */}
          <Footprint rect={f.poolTable} height={0.8} color={COLORS.black} roughness={0.3} />
          <Box position={[f.poolTable.x, 0.81, f.poolTable.z]} size={[1.9, 0.02, 1.0]} color="#5b3a8c" />
        </>
      )}
      {/* The floor below: a lounge nook where the pool table is upstairs, and a plant in the south-west corner. */}
      {!director && (
        <>
          <Footprint rect={nook.sofa} height={0.42} color={COLORS.fabric} />
          <Box
            position={[nook.sofa.x, 0.7, nook.sofa.z - 0.36]}
            size={[nook.sofa.width, 0.55, 0.18]}
            color={COLORS.fabric}
          />
          <Footprint rect={nook.coffeeTable} height={0.4} color={COLORS.black} roughness={0.35} />
          <Chair x={nook.armchairWest.x} z={nook.armchairWest.z} color={COLORS.white} />
          <Chair x={nook.armchairEast.x} z={nook.armchairEast.z} color={COLORS.white} />
          <Footprint rect={nook.loungeChair} height={0.45} color="#c4733a" />
          <Plant rect={nook.plantWest} />
          <Plant rect={nook.plantEast} height={1.5} />
          <Plant rect={FURNITURE_BY_FLOOR.lower.plantSouthWest} height={1.7} />
        </>
      )}

      {/* Conference room */}
      <Footprint rect={f.conferenceTable} height={0.06} y={0.72} color={COLORS.wood} roughness={0.4} />
      <Box position={[f.conferenceTable.x, 0.36, f.conferenceTable.z]} size={[2.6, 0.72, 0.4]} color={COLORS.black} />
      {MEETING_SEATS.map(([x, z], i) => (
        <Chair key={i} x={x} z={z + (i < 6 ? -SIT_BACK : SIT_BACK)} facing={i < 6 ? Math.PI : 0} color="#e6ddd0" />
      ))}
      <Box
        position={[3.65, 1.55, FLOOR.minZ + 0.05]}
        size={[2.6, 1.3, 0.06]}
        color={COLORS.black}
        emissive="#0b1622"
        emissiveIntensity={0.6}
      />

      {/* Corner sofa (north-west) and the arcade beside it, facing east */}
      <Footprint rect={f.cornerSofa} height={0.42} color={COLORS.fabric} />
      <Footprint rect={f.cornerSofaChaise} height={0.42} color={COLORS.fabric} />
      <Box
        position={[FLOOR.minX + 0.1, 0.6, f.cornerSofa.z]}
        size={[0.18, 0.4, f.cornerSofa.depth]}
        color={COLORS.fabric}
      />
      <Footprint rect={f.arcade} height={1.8} color="#1d2f45" />
      <Box
        position={[f.arcade.x + 0.41, 1.3, f.arcade.z]}
        size={[0.02, 0.45, 0.6]}
        color="#0a1220"
        emissive={arcadeOn ? "#5af0ff" : "#000000"}
        emissiveIntensity={arcadeOn ? 1.6 : 0}
      />
      <Box
        position={[f.arcade.x, 1.82, f.arcade.z]}
        size={[0.8, 0.06, 0.8]}
        color={COLORS.neon}
        emissive={arcadeOn ? COLORS.neon : "#000000"}
        emissiveIntensity={arcadeOn ? 2 : 0}
      />

      {/* Kitchenette */}
      <Footprint rect={f.kitchenCounter} height={0.9} color="#6b4a33" />
      <Box
        position={[f.kitchenCounter.x, 0.92, f.kitchenCounter.z]}
        size={[0.74, 0.04, 2.84]}
        color="#d9d3c9"
        roughness={0.3}
      />
      <Box position={[f.kitchenCounter.x, 1.1, -0.6]} size={[0.35, 0.36, 0.3]} color={COLORS.black} metalness={0.5} />
      <Box position={[FLOOR.minX + 0.2, 1.85, 0]} size={[0.38, 0.7, 2.6]} color="#6b4a33" />
      <mesh position={[f.trashCan.x, 0.3, f.trashCan.z]} castShadow>
        <cylinderGeometry args={[0.18, 0.16, 0.6, 16]} />
        <meshStandardMaterial color={COLORS.metal} metalness={0.6} roughness={0.35} />
      </mesh>
      <Plant rect={f.plantKitchen} />

      {/* Workstations */}
      {DESK_INDICES_BY_FLOOR[floor].map((i) => (
        <Workstation key={i} x={DESKS[i][0]} z={DESKS[i][1]} />
      ))}

      {/* Lounge */}
      <Footprint rect={f.sofa} height={0.42} color={COLORS.fabric} />
      <Box position={[f.sofa.x, 0.7, f.sofa.z - 0.36]} size={[f.sofa.width, 0.55, 0.18]} color={COLORS.fabric} />
      <Footprint rect={f.coffeeTable} height={0.4} color={COLORS.black} roughness={0.35} />
      <mesh position={[f.floorLamp.x, 0.8, f.floorLamp.z]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 1.6, 8]} />
        <meshStandardMaterial color={COLORS.black} />
      </mesh>
      <mesh position={[f.floorLamp.x, 1.65, f.floorLamp.z]}>
        <sphereGeometry args={[0.16, 16, 12]} />
        <meshStandardMaterial color="#fff2d6" emissive="#ffd9a0" emissiveIntensity={1.5} />
      </mesh>
      <Footprint rect={f.armchair} height={0.45} color="#c4733a" />
      <Box position={[f.armchair.x + 0.3, 0.75, f.armchair.z]} size={[0.15, 0.6, 0.8]} color="#c4733a" />
      <Plant rect={f.loungePlant} height={1.5} />
      <Footprint rect={f.foosball} height={0.85} color={COLORS.wood} />
      <Box position={[f.foosball.x, 0.86, f.foosball.z]} size={[1.3, 0.02, 0.62]} color="#3f8c46" />
      {(
        [
          [f.beanbagWest, "#1f9bb5"],
          [f.beanbagNorth, "#e0802f"],
          [f.beanbagEast, "#8a4fc2"],
        ] as const
      ).map(([rect, color]) => (
        <mesh key={color} position={[rect.x, 0.25, rect.z]} scale={[1, 0.62, 1]} castShadow>
          <sphereGeometry args={[rect.width / 2, 24, 16]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      ))}
      <mesh position={[f.beanbagTable.x, 0.22, f.beanbagTable.z]} castShadow>
        <cylinderGeometry args={[0.25, 0.25, 0.44, 24]} />
        <meshStandardMaterial color={COLORS.wood} />
      </mesh>

      {/* Corner plant */}
      <Plant rect={f.plantSouthEast} height={1.7} />
    </>
  );
}
