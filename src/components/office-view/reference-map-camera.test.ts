import { describe, expect, it } from "vitest";
import {
  REFERENCE_WORLD_HEIGHT,
  REFERENCE_WORLD_WIDTH,
  createReferenceMapCamera,
  getReferenceMapScale,
  panReferenceMapBy,
  resizeReferenceMapCamera,
  screenToWorld,
  worldToScreen,
  zoomReferenceMapAt,
} from "./reference-map-camera";

describe("reference map camera", () => {
  it("fits and centers the full map in the viewport", () => {
    const camera = createReferenceMapCamera(1000, 1000);
    const scale = getReferenceMapScale(camera);

    expect(scale).toBeCloseTo(1000 / REFERENCE_WORLD_WIDTH);
    expect(worldToScreen(camera, { x: 0, y: 0 }).x).toBeCloseTo(0);
    expect(worldToScreen(camera, { x: 0, y: 0 }).y).toBeCloseTo((1000 - REFERENCE_WORLD_HEIGHT * scale) / 2);
    expect(worldToScreen(camera, { x: REFERENCE_WORLD_WIDTH, y: REFERENCE_WORLD_HEIGHT }).x).toBeCloseTo(1000);
  });

  it("round-trips world and screen points", () => {
    const camera = zoomReferenceMapAt(createReferenceMapCamera(1200, 800), 2, { x: 600, y: 400 });
    const point = { x: 430, y: 265 };
    const recovered = screenToWorld(camera, worldToScreen(camera, point));

    expect(recovered.x).toBeCloseTo(point.x);
    expect(recovered.y).toBeCloseTo(point.y);
  });

  it("keeps the cursor's world point fixed while zooming when bounds allow", () => {
    const anchor = { x: 510, y: 375 };
    const initial = createReferenceMapCamera(1200, 800);
    const worldPoint = screenToWorld(initial, anchor);
    const zoomed = zoomReferenceMapAt(initial, 2, anchor);

    expect(worldToScreen(zoomed, worldPoint).x).toBeCloseTo(anchor.x);
    expect(worldToScreen(zoomed, worldPoint).y).toBeCloseTo(anchor.y);
  });

  it("clamps zoom to 1–3 and pan to visible map bounds", () => {
    const initial = createReferenceMapCamera(1200, 800);
    const anchor = { x: 600, y: 400 };
    expect(zoomReferenceMapAt(initial, 0.1, anchor).zoom).toBe(1);

    const camera = zoomReferenceMapAt(initial, 9, anchor);
    const scale = getReferenceMapScale(camera);
    expect(camera.zoom).toBe(3);

    const leftTop = panReferenceMapBy(camera, 100000, 100000);
    expect(leftTop.offsetX).toBe(0);
    expect(leftTop.offsetY).toBe(0);

    const rightBottom = panReferenceMapBy(camera, -100000, -100000);
    expect(rightBottom.offsetX).toBeCloseTo(1200 - REFERENCE_WORLD_WIDTH * scale);
    expect(rightBottom.offsetY).toBeCloseTo(800 - REFERENCE_WORLD_HEIGHT * scale);
  });

  it("preserves the world point at the viewport center on resize", () => {
    const initial = panReferenceMapBy(
      zoomReferenceMapAt(createReferenceMapCamera(1200, 800), 2, { x: 600, y: 400 }),
      -120,
      70,
    );
    const before = screenToWorld(initial, { x: 600, y: 400 });
    const resized = resizeReferenceMapCamera(initial, 1400, 900);
    const after = screenToWorld(resized, { x: 700, y: 450 });

    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(resized.zoom).toBe(2);
  });
});
