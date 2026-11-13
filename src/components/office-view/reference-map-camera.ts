export const REFERENCE_WORLD_WIDTH = 1672;
export const REFERENCE_WORLD_HEIGHT = 941;

export interface ReferenceMapPoint {
  x: number;
  y: number;
}

export interface ReferenceMapCamera {
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
  /** Screen-space translation applied after scaling world coordinates. */
  offsetX: number;
  offsetY: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

function validViewportSize(value: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : 1;
}

function boundedOffset(offset: number, viewportSize: number, worldSize: number): number {
  if (worldSize <= viewportSize) return (viewportSize - worldSize) / 2;
  return Math.min(0, Math.max(viewportSize - worldSize, offset));
}

function boundCamera(camera: ReferenceMapCamera): ReferenceMapCamera {
  const scale = getReferenceMapScale(camera);
  return {
    ...camera,
    offsetX: boundedOffset(camera.offsetX, camera.viewportWidth, REFERENCE_WORLD_WIDTH * scale),
    offsetY: boundedOffset(camera.offsetY, camera.viewportHeight, REFERENCE_WORLD_HEIGHT * scale),
  };
}

export function createReferenceMapCamera(viewportWidth: number, viewportHeight: number): ReferenceMapCamera {
  return boundCamera({
    viewportWidth: validViewportSize(viewportWidth),
    viewportHeight: validViewportSize(viewportHeight),
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });
}

export function getReferenceMapScale(camera: ReferenceMapCamera): number {
  return (
    Math.min(camera.viewportWidth / REFERENCE_WORLD_WIDTH, camera.viewportHeight / REFERENCE_WORLD_HEIGHT) * camera.zoom
  );
}

export function worldToScreen(camera: ReferenceMapCamera, point: ReferenceMapPoint): ReferenceMapPoint {
  const scale = getReferenceMapScale(camera);
  return { x: point.x * scale + camera.offsetX, y: point.y * scale + camera.offsetY };
}

export function screenToWorld(camera: ReferenceMapCamera, point: ReferenceMapPoint): ReferenceMapPoint {
  const scale = getReferenceMapScale(camera);
  return { x: (point.x - camera.offsetX) / scale, y: (point.y - camera.offsetY) / scale };
}

export function zoomReferenceMapAt(
  camera: ReferenceMapCamera,
  zoom: number,
  screenPoint: ReferenceMapPoint,
): ReferenceMapCamera {
  const nextZoom = Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : camera.zoom;
  const anchor = screenToWorld(camera, screenPoint);
  const nextScale = getReferenceMapScale({ ...camera, zoom: nextZoom });
  return boundCamera({
    ...camera,
    zoom: nextZoom,
    offsetX: screenPoint.x - anchor.x * nextScale,
    offsetY: screenPoint.y - anchor.y * nextScale,
  });
}

export function panReferenceMapBy(camera: ReferenceMapCamera, dx: number, dy: number): ReferenceMapCamera {
  return boundCamera({
    ...camera,
    offsetX: camera.offsetX + (Number.isFinite(dx) ? dx : 0),
    offsetY: camera.offsetY + (Number.isFinite(dy) ? dy : 0),
  });
}

export function resizeReferenceMapCamera(
  camera: ReferenceMapCamera,
  viewportWidth: number,
  viewportHeight: number,
): ReferenceMapCamera {
  const worldCenter = screenToWorld(camera, {
    x: camera.viewportWidth / 2,
    y: camera.viewportHeight / 2,
  });
  const next = {
    ...camera,
    viewportWidth: validViewportSize(viewportWidth),
    viewportHeight: validViewportSize(viewportHeight),
  };
  const scale = getReferenceMapScale(next);
  return boundCamera({
    ...next,
    offsetX: next.viewportWidth / 2 - worldCenter.x * scale,
    offsetY: next.viewportHeight / 2 - worldCenter.y * scale,
  });
}
