import { describe, expect, it } from "vitest";
import {
  DESK_ANCHORS,
  INTERACTION_ANCHORS,
  MAP_HEIGHT,
  MAP_WIDTH,
  ROOM_ZONES,
  findWalkPath,
  isWalkable,
  type MapPoint,
} from "./reference-map-geometry";

function segmentIsWalkable(from: MapPoint, to: MapPoint): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.ceil(length / 5);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!isWalkable({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })) return false;
  }
  return true;
}

describe("reference office geometry", () => {
  it("keeps the reference frame and fixed ten-desk composition", () => {
    expect([MAP_WIDTH, MAP_HEIGHT]).toEqual([1672, 941]);
    expect(DESK_ANCHORS.filter((desk) => desk.row === "north")).toHaveLength(5);
    expect(DESK_ANCHORS.filter((desk) => desk.row === "south")).toHaveLength(5);
    expect(ROOM_ZONES.map((room) => room.id)).toEqual([
      "executive",
      "conference",
      "kitchenette",
      "arcade",
      "lounge",
      "elevator",
    ]);
  });

  it("routes every workstation approach to the conference through free space", () => {
    for (const desk of DESK_ANCHORS) {
      const start = { x: desk.approachX, y: desk.approachY };
      expect(isWalkable(start), desk.id).toBe(true);
      const path = findWalkPath(start, INTERACTION_ANCHORS.meetingTable);
      expect(path.length, desk.id).toBeGreaterThan(2);
      expect(path[0]).toEqual(start);
      expect(path.at(-1)).toEqual(INTERACTION_ANCHORS.meetingTable);
      for (let i = 1; i < path.length; i++) {
        expect(segmentIsWalkable(path[i - 1], path[i]), `${desk.id}, segment ${i}`).toBe(true);
      }
    }
  });

  it("blocks furniture and keeps the CEO spawn traversable", () => {
    expect(isWalkable({ x: 480, y: 480 })).toBe(false); // foosball table
    expect(isWalkable({ x: 840, y: 475 })).toBe(false); // sofa
    expect(isWalkable(INTERACTION_ANCHORS.ceoSpawn)).toBe(true);
  });

  it("keeps movement inside the angled side rails", () => {
    expect(isWalkable({ x: 350, y: 150 })).toBe(false);
    expect(isWalkable({ x: 95, y: 210 })).toBe(false);
    expect(isWalkable({ x: 160, y: 210 })).toBe(false);
    expect(isWalkable({ x: 260, y: 210 })).toBe(true);
    expect(isWalkable({ x: 1570, y: 210 })).toBe(false);
  });

  it("reaches each office object from the CEO spawn", () => {
    for (const [name, target] of Object.entries(INTERACTION_ANCHORS)) {
      if (name === "ceoSpawn" || name === "meetingSeats") continue;
      const path = findWalkPath(INTERACTION_ANCHORS.ceoSpawn, target as MapPoint);
      expect(path.length, name).toBeGreaterThan(1);
      for (let i = 1; i < path.length; i++) {
        expect(segmentIsWalkable(path[i - 1], path[i]), `${name}, segment ${i}`).toBe(true);
      }
    }
  });
});
