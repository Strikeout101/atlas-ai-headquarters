import {
  Application,
  AnimatedSprite,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  TextureStyle,
  type Texture,
} from "pixi.js";
import type { Agent } from "../../types";
import { buildSpriteMap } from "../AgentAvatar";
import type { OfficeViewProps } from "./model";
import {
  DESK_ANCHORS,
  INTERACTION_ANCHORS,
  MAP_HEIGHT,
  MAP_WIDTH,
  ROOM_ZONES,
  findWalkPath,
  isInsideRect,
  isWalkable,
  type MapPoint,
} from "./reference-map-geometry";
import {
  createReferenceMapCamera,
  getReferenceMapScale,
  panReferenceMapBy,
  resizeReferenceMapCamera,
  screenToWorld,
  zoomReferenceMapAt,
  type ReferenceMapCamera,
} from "./reference-map-camera";

type LayerName = "sky" | "building" | "floor" | "furniture" | "foreground";
const STATIC_LAYERS: readonly LayerName[] = ["sky", "building", "floor", "furniture", "foreground"];
const DETAIL_TILE_COUNT = 4;
const DETAIL_TILE_W = MAP_WIDTH / DETAIL_TILE_COUNT;
const DETAIL_TILE_H = MAP_HEIGHT / DETAIL_TILE_COUNT;

interface MovingActor {
  node: Container;
  route: MapPoint[];
  routeIndex: number;
  speed: number;
  afterArrival?: () => void;
  retainOnArrival?: boolean;
  agentId?: string;
}

interface AgentNode {
  agent: Agent;
  node: Container;
  position: MapPoint;
}

interface AmbientSprite {
  node: Container;
  speed: number;
  minX: number;
  maxX: number;
}

function pointDistance(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function canvasResolution(width: number, height: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelBudget = 3840 * 2160;
  return Math.max(1, Math.min(dpr, Math.sqrt(pixelBudget / Math.max(1, width * height))));
}

function makeCloud(x: number, y: number, size: number, alpha: number): Graphics {
  const cloud = new Graphics();
  cloud
    .moveTo(-size * 0.52, size * 0.08)
    .quadraticCurveTo(-size * 0.47, -size * 0.04, -size * 0.34, -size * 0.04)
    .quadraticCurveTo(-size * 0.25, -size * 0.22, -size * 0.09, -size * 0.14)
    .quadraticCurveTo(size * 0.02, -size * 0.3, size * 0.13, -size * 0.13)
    .quadraticCurveTo(size * 0.28, -size * 0.19, size * 0.35, -size * 0.04)
    .quadraticCurveTo(size * 0.48, -size * 0.03, size * 0.52, size * 0.08)
    .quadraticCurveTo(0, size * 0.17, -size * 0.52, size * 0.08)
    .fill({ color: 0xf4fbff, alpha });
  cloud.position.set(x, y);
  return cloud;
}

function makeBird(x: number, y: number): Graphics {
  const bird = new Graphics();
  bird.moveTo(-10, 2).quadraticCurveTo(-4, -5, 0, 1).quadraticCurveTo(4, -5, 10, 2).stroke({
    color: 0x334a68,
    alpha: 0.7,
    width: 1.5,
  });
  bird.position.set(x, y);
  return bird;
}

function makePlane(x: number, y: number): Graphics {
  const plane = new Graphics();
  plane.moveTo(-16, 0).lineTo(14, -2).lineTo(-7, 3).closePath().fill({ color: 0xf5f9ff, alpha: 0.88 });
  plane.moveTo(-3, 0).lineTo(3, -8).lineTo(8, -8).lineTo(4, 0).fill({ color: 0xe3edfa, alpha: 0.9 });
  plane.position.set(x, y);
  return plane;
}

/** Imperative Pixi runtime. React updates data; Pixi owns every frame and never rebuilds static art. */
export class ReferenceOfficeScene {
  private readonly element: HTMLDivElement;
  private readonly onReady: (error?: string) => void;
  private readonly onObjectInteract: (label: string) => void;
  private app: Application | null = null;
  private world = new Container();
  private actorLayer = new Container();
  private skyMotion = new Container();
  private effectLayer = new Container();
  private detailLayers = new Map<LayerName, Container>();
  private baseTiles = new Map<string, Sprite>();
  private detailTiles = new Map<string, Sprite>();
  private pendingDetailTiles = new Set<string>();
  private detailEvictionTimers = new Map<string, number>();
  private detailUnloadPromises = new Map<string, Promise<void>>();
  private detailTimer: number | null = null;
  private detailActive = false;
  private camera: ReferenceMapCamera;
  private props: OfficeViewProps;
  private lastRenderedProps: OfficeViewProps | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private textures = new Map<number, Texture[]>();
  private ceoTexture: Texture | null = null;
  private ceoNode: Container | null = null;
  private ceoPos: MapPoint = { ...INTERACTION_ANCHORS.ceoSpawn };
  private agentNodes = new Map<string, AgentNode>();
  private subAgentNodes: Array<{ node: Container; base: MapPoint; phase: number }> = [];
  private meetingActors = new Map<string, { node: Container; holdUntil: number }>();
  private visibleDeskByAgent = new Map<string, (typeof DESK_ANCHORS)[number]>();
  private movingActors: MovingActor[] = [];
  private ambient: AmbientSprite[] = [];
  private lightNodes: Graphics[] = [];
  private monitorScans: Array<{ node: Graphics; left: number; phase: number }> = [];
  private transientEffects: Array<{ node: Graphics; age: number }> = [];
  private arcadeOn = true;
  private keys = new Set<string>();
  private pointers = new Map<number, MapPoint>();
  private pointerStart: MapPoint | null = null;
  private pointerLast: MapPoint | null = null;
  private pointerDragged = false;
  private pinchDistance = 0;
  private elapsed = 0;
  private lastBirdAt = 0;
  private lastPlaneAt = 0;
  private processedDeliveries = new Set<string>();
  private processedCalls = new Set<string>();
  private activeTasks = new Set<string>();
  private appCanvas: HTMLCanvasElement | null = null;
  private highlightNode = new Graphics();

  constructor(
    element: HTMLDivElement,
    props: OfficeViewProps,
    onReady: (error?: string) => void,
    onObjectInteract: (label: string) => void,
  ) {
    this.element = element;
    this.props = props;
    this.onReady = onReady;
    this.onObjectInteract = onObjectInteract;
    this.camera = createReferenceMapCamera(Math.max(1, element.clientWidth), Math.max(1, element.clientHeight));
  }

  async init(): Promise<void> {
    const width = Math.max(1, this.element.clientWidth);
    const height = Math.max(1, this.element.clientHeight);
    TextureStyle.defaultOptions.scaleMode = "linear";
    const app = new Application();
    this.app = app;
    try {
      await app.init({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        resolution: canvasResolution(width, height),
        autoDensity: true,
        preference: "webgl",
      });
      if (this.disposed) {
        app.destroy(true, { children: true });
        return;
      }
      app.ticker.maxFPS = 60;
      const canvas = app.canvas as HTMLCanvasElement;
      this.appCanvas = canvas;
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.touchAction = "none";
      this.element.appendChild(canvas);

      const staticTiles = STATIC_LAYERS.flatMap((layer) => {
        const count = DETAIL_TILE_COUNT;
        return Array.from({ length: count * count }, (_, index) => ({
          layer,
          column: index % count,
          row: Math.floor(index / count),
        }));
      });
      const staticTextures = await Promise.all(
        staticTiles.map(({ layer, column, row }) =>
          Assets.load<Texture>(`/office-map/rendered/${layer}-${column}-${row}.png`),
        ),
      );
      const [
        conferenceTexture,
        executiveTexture,
        loungeTexture,
        beanbagTexture,
        foosballTexture,
        kitchenetteTexture,
        planterTexture,
        ...workstationTextures
      ] = await Promise.all(
        [
          "conference-table",
          "executive-furniture-candidate",
          "lounge-center-candidate",
          "beanbag-nook",
          "foosball-table",
          "kitchenette",
          "lush-planter",
          "workstation-candidate",
          "workstation-dual-blue-clean",
          "workstation-green-plant",
          "workstation-purple-lamp",
          "workstation-landscape",
        ].map((name) => Assets.load<Texture>(`/office-map/sprites/${name}.png`)),
      );
      if (this.disposed) return;

      let textureIndex = 0;
      for (const layer of STATIC_LAYERS) {
        const container = new Container();
        container.label = `${layer}-layer`;
        const detailContainer = new Container();
        detailContainer.label = `high-resolution-${layer}-layer`;
        this.detailLayers.set(layer, detailContainer);
        const count = DETAIL_TILE_COUNT;
        const tileWidth = MAP_WIDTH / count;
        const tileHeight = MAP_HEIGHT / count;
        for (let row = 0; row < count; row++) {
          for (let column = 0; column < count; column++) {
            const sprite = new Sprite(staticTextures[textureIndex++]);
            sprite.position.set(column * tileWidth, row * tileHeight);
            sprite.width = tileWidth;
            sprite.height = tileHeight;
            container.addChild(sprite);
            this.baseTiles.set(`${layer}-${column}-${row}`, sprite);
          }
        }
        if (layer === "building") this.world.addChild(this.skyMotion);
        if (layer === "furniture") {
          const conference = new Sprite(conferenceTexture);
          conference.label = "painted-conference-furniture";
          conference.position.set(867, 137);
          conference.width = 343;
          conference.height = 151;
          const executive = new Sprite(executiveTexture);
          executive.label = "painted-executive-furniture";
          executive.position.set(442, 71);
          executive.width = 376;
          executive.height = 211;
          const lounge = new Sprite(loungeTexture);
          lounge.label = "painted-lounge-furniture";
          lounge.position.set(669, 384);
          lounge.width = 329;
          lounge.height = 165;
          const beanbags = new Sprite(beanbagTexture);
          beanbags.label = "painted-beanbag-nook";
          beanbags.position.set(1097, 427);
          beanbags.width = 205;
          beanbags.height = 116;
          const foosball = new Sprite(foosballTexture);
          foosball.label = "painted-foosball-table";
          foosball.position.set(388, 414);
          foosball.width = 190;
          foosball.height = 110;
          const kitchenette = new Sprite(kitchenetteTexture);
          kitchenette.label = "painted-kitchenette";
          kitchenette.position.set(120, 280);
          kitchenette.width = 125;
          kitchenette.height = 210;
          const planter = new Sprite(planterTexture);
          planter.label = "lounge-planter";
          planter.position.set(969, 417);
          planter.width = 79;
          planter.height = 105;
          const workstations = [
            [259, 318, 0],
            [505, 317, 1],
            [755, 316, 2],
            [990, 317, 3],
            [1229, 318, 4],
            [238, 546, 2],
            [497, 547, 3],
            [750, 548, 1],
            [1001, 548, 0],
            [1256, 548, 4],
          ].map(([x, y, variant], index) => {
            const desk = new Sprite(workstationTextures[variant]);
            desk.label = `painted-workstation-${index + 1}`;
            desk.position.set(x, y);
            desk.width = 208;
            desk.height = 139;
            return desk;
          });
          this.world.addChild(
            container,
            detailContainer,
            conference,
            executive,
            kitchenette,
            ...workstations.slice(0, 5),
            foosball,
            lounge,
            planter,
            beanbags,
            ...workstations.slice(5),
          );
          continue;
        }
        if (layer === "foreground") {
          this.actorLayer.sortableChildren = true;
          this.actorLayer.label = "agent-layer";
          this.world.addChild(this.actorLayer);
        }
        this.world.addChild(container, detailContainer);
      }
      this.effectLayer.label = "animated-elements-layer";
      this.highlightNode.label = "interaction-highlight";
      this.effectLayer.addChild(this.highlightNode);
      this.world.addChild(this.effectLayer);
      app.stage.addChild(this.world);
      this.buildAmbient();
      await this.loadAgentTextures(this.props.agents);
      if (this.disposed) return;
      this.createCeo();
      this.rebuildAgents();
      this.updateHighlight();
      this.enqueueExternalEvents();
      this.lastRenderedProps = this.props;
      this.applyCamera();
      app.ticker.add(this.tick);
      canvas.addEventListener("wheel", this.onWheel, { passive: false });
      canvas.addEventListener("pointerdown", this.onPointerDown);
      canvas.addEventListener("pointermove", this.onPointerMove);
      canvas.addEventListener("pointerup", this.onPointerUp);
      canvas.addEventListener("pointercancel", this.onPointerUp);
      window.addEventListener("keydown", this.onKeyDown);
      window.addEventListener("keyup", this.onKeyUp);
      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(this.element);
      this.onReady();
    } catch (error) {
      if (!this.disposed) {
        this.onReady(error instanceof Error ? error.message : String(error));
        this.destroy();
      }
    }
  }

  updateData(props: OfficeViewProps): void {
    const previous = this.props;
    this.props = props;
    if (!this.app || !this.ceoNode) return;
    const rebuild =
      !this.lastRenderedProps ||
      props.agents !== this.lastRenderedProps.agents ||
      props.subAgents !== this.lastRenderedProps.subAgents ||
      props.unreadAgentIds !== this.lastRenderedProps.unreadAgentIds;
    this.lastRenderedProps = props;
    if (rebuild) {
      void this.loadAgentTextures(props.agents).then(() => {
        if (this.disposed) return;
        this.rebuildAgents();
        this.updateHighlight();
        this.enqueueExternalEvents();
      });
      return;
    }
    if (props.meetingPresence !== previous.meetingPresence) this.syncMeetingPresence();
    if (
      props.themeHighlightTargetId !== previous.themeHighlightTargetId ||
      props.customDeptThemes !== previous.customDeptThemes
    ) {
      this.updateHighlight();
    }
    this.enqueueExternalEvents();
  }

  getOverflowAgents(): Agent[] {
    return this.props.agents.slice(DESK_ANCHORS.length);
  }

  getZoom(): number {
    return this.camera.zoom;
  }

  setZoom(zoom: number): void {
    this.camera = zoomReferenceMapAt(this.camera, zoom, {
      x: this.camera.viewportWidth / 2,
      y: this.camera.viewportHeight / 2,
    });
    this.applyCamera();
  }

  interact(): void {
    if (pointDistance(this.ceoPos, INTERACTION_ANCHORS.meetingTable) < 90) {
      const taskId = this.props.activeMeetingTaskId;
      if (taskId) {
        this.props.onOpenActiveMeetingMinutes?.(taskId);
        return;
      }
    }
    const deskIndex = DESK_ANCHORS.findIndex(
      (desk) => pointDistance(this.ceoPos, { x: desk.approachX, y: desk.approachY }) < 60,
    );
    if (deskIndex >= 0) {
      this.selectDeskDepartment(deskIndex);
      return;
    }
    if (pointDistance(this.ceoPos, INTERACTION_ANCHORS.foosball) < 70) {
      this.triggerObjectInteraction("foosball", INTERACTION_ANCHORS.foosball);
      return;
    }
    const nearest = ROOM_ZONES.find((zone) => pointDistance(this.ceoPos, zone.interactAt) < 70);
    if (nearest) {
      this.triggerObjectInteraction(nearest.id, nearest.interactAt);
    }
  }

  setMoveDirectionPressed(direction: "up" | "down" | "left" | "right", pressed: boolean): void {
    const code = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[direction];
    if (pressed) this.keys.add(code);
    else this.keys.delete(code);
  }

  private async loadAgentTextures(agents: Agent[]): Promise<void> {
    const spriteMap = buildSpriteMap(agents);
    await Promise.all(
      [...new Set(spriteMap.values())].map(async (number) => {
        if (this.textures.has(number)) return;
        try {
          const frames = await Promise.all(
            [1, 2, 3].map((frame) => Assets.load<Texture>(`/sprites/${number}-D-${frame}.png`)),
          );
          this.textures.set(number, frames);
        } catch {
          // An agent may use a custom sprite number without a public asset.
        }
      }),
    );
    if (!this.ceoTexture) {
      try {
        this.ceoTexture = await Assets.load<Texture>("/sprites/ceo-lobster.png");
      } catch {
        this.ceoTexture = null;
      }
    }
  }

  private createCeo(): void {
    const node = new Container();
    node.label = "ceo-actor";
    if (this.ceoTexture) {
      const sprite = new Sprite(this.ceoTexture);
      sprite.anchor.set(0.5, 1);
      sprite.scale.set(48 / Math.max(1, sprite.texture.height));
      node.addChild(sprite);
    } else {
      const marker = new Graphics();
      marker.circle(0, -22, 18).fill(0xff7e55);
      node.addChild(marker);
    }
    node.position.set(this.ceoPos.x, this.ceoPos.y);
    node.zIndex = this.ceoPos.y;
    this.actorLayer.addChild(node);
    this.ceoNode = node;
  }

  private rebuildAgents(): void {
    for (const item of this.agentNodes.values()) item.node.destroy({ children: true });
    for (const item of this.subAgentNodes) item.node.destroy({ children: true });
    this.agentNodes.clear();
    this.subAgentNodes = [];
    this.visibleDeskByAgent.clear();
    const spriteMap = buildSpriteMap(this.props.agents);
    const breakSpots: readonly MapPoint[] = [
      { x: 1152, y: 493 },
      { x: 1238, y: 493 },
      { x: 958, y: 519 },
    ];
    this.props.agents.slice(0, DESK_ANCHORS.length).forEach((agent, index) => {
      const desk = DESK_ANCHORS[index];
      this.visibleDeskByAgent.set(agent.id, desk);
      const position = agent.status === "break" ? breakSpots[index % breakSpots.length] : { x: desk.x, y: desk.y };
      const node = this.makeAgentNode(agent, spriteMap.get(agent.id));
      node.position.set(position.x, position.y);
      node.zIndex = position.y;
      this.actorLayer.addChild(node);
      this.agentNodes.set(agent.id, { agent, node, position });
    });
    const cloneCount = new Map<string, number>();
    for (const subAgent of this.props.subAgents) {
      if (subAgent.status !== "working") continue;
      const parent = this.agentNodes.get(subAgent.parentAgentId);
      if (!parent) continue;
      const count = cloneCount.get(subAgent.parentAgentId) ?? 0;
      if (count >= 3) continue;
      cloneCount.set(subAgent.parentAgentId, count + 1);
      const x = parent.position.x + (count - 1) * 25;
      const y = parent.position.y + 17;
      const node = this.makeAgentNode(parent.agent, spriteMap.get(parent.agent.id));
      node.scale.set(0.55);
      node.position.set(x, y);
      node.zIndex = y + 1;
      const aura = new Graphics();
      aura.ellipse(0, -3, 16, 5).fill({ color: 0x72e0ff, alpha: 0.22 });
      node.addChildAt(aura, 0);
      this.actorLayer.addChild(node);
      this.subAgentNodes.push({ node, base: { x, y }, phase: count * 1.9 + x * 0.02 });
    }
    this.syncMeetingPresence();
  }

  private syncMeetingPresence(): void {
    const now = Date.now();
    const active = new Set<string>();
    const byId = new Map(this.props.agents.map((agent) => [agent.id, agent]));
    const spriteMap = buildSpriteMap(this.props.agents);
    for (const presence of this.props.meetingPresence ?? []) {
      if (presence.until <= now) continue;
      active.add(presence.agent_id);
      if (this.movingActors.some((actor) => actor.agentId === presence.agent_id)) continue;
      const seat = INTERACTION_ANCHORS.meetingSeats[presence.seat_index % INTERACTION_ANCHORS.meetingSeats.length];
      const existing = this.meetingActors.get(presence.agent_id);
      if (existing) {
        existing.node.position.set(seat.x, seat.y);
        existing.node.zIndex = seat.y;
        existing.holdUntil = presence.until;
        continue;
      }
      const agent = byId.get(presence.agent_id);
      if (!agent) continue;
      const node = this.makeAgentNode(agent, spriteMap.get(agent.id));
      node.position.set(seat.x, seat.y);
      node.zIndex = seat.y;
      this.actorLayer.addChild(node);
      this.meetingActors.set(agent.id, { node, holdUntil: presence.until });
    }
    for (const [agentId, held] of this.meetingActors) {
      if (active.has(agentId) || held.holdUntil > now) continue;
      held.node.destroy({ children: true });
      this.meetingActors.delete(agentId);
    }
  }

  private updateHighlight(): void {
    this.highlightNode.clear();
    const target = this.props.themeHighlightTargetId;
    if (!target) return;
    const color = this.props.customDeptThemes?.[target]?.accent ?? 0x2dd9fa;
    if (target === "ceoOffice" || target === "breakRoom") {
      const zone = ROOM_ZONES.find((item) => item.id === (target === "ceoOffice" ? "executive" : "lounge"));
      if (zone)
        this.highlightNode.rect(zone.x, zone.y, zone.width, zone.height).stroke({ color, width: 5, alpha: 0.7 });
    } else {
      for (const [agentId, desk] of this.visibleDeskByAgent) {
        const agent = this.props.agents.find((item) => item.id === agentId);
        if (agent?.department_id !== target) continue;
        this.highlightNode.roundRect(desk.x - 90, desk.y - 68, 180, 96, 9).stroke({ color, width: 4, alpha: 0.7 });
      }
    }
  }

  private makeAgentNode(agent: Agent, spriteNumber?: number): Container {
    const node = new Container();
    node.label = `agent-${agent.id}`;
    const frames = spriteNumber ? this.textures.get(spriteNumber) : null;
    if (frames?.length) {
      const sprite = agent.status === "working" ? new AnimatedSprite(frames) : new Sprite(frames[0]);
      sprite.anchor.set(0.5, 1);
      sprite.scale.set(43 / Math.max(1, frames[0].height));
      if (agent.status === "offline") sprite.alpha = 0.45;
      if (sprite instanceof AnimatedSprite) {
        sprite.animationSpeed = 0.09;
        sprite.play();
      }
      node.addChild(sprite);
    } else {
      const fallback = new Graphics();
      fallback.circle(0, -18, 13).fill(0x68bdd4);
      fallback.roundRect(-10, -16, 20, 18, 6).fill(0x214456);
      node.addChild(fallback);
    }
    const badge = new Graphics();
    const color = agent.status === "working" ? 0x77d5ae : agent.status === "offline" ? 0x8698a7 : 0xf4c76b;
    badge.circle(15, -40, 4).fill(color).stroke({ color: 0x1c2530, width: 1.5 });
    node.addChild(badge);
    if (this.props.unreadAgentIds?.has(agent.id)) {
      const unread = new Graphics();
      unread.circle(-15, -40, 5).fill(0xff9a4a);
      node.addChild(unread);
    }
    return node;
  }

  private buildAmbient(): void {
    for (const [x, y, size, speed] of [
      [80, 34, 110, 5],
      [470, 27, 85, 3],
      [975, 30, 120, 4],
      [1450, 35, 105, 6],
    ]) {
      const cloud = makeCloud(x, y, size, 0.16);
      this.skyMotion.addChild(cloud);
      this.ambient.push({ node: cloud, speed, minX: -140, maxX: MAP_WIDTH + 140 });
    }
    const arcadeLight = new Graphics();
    arcadeLight.roundRect(201, 163, 31, 7, 2).fill({ color: 0x32e7fc, alpha: 0.4 });
    this.effectLayer.addChild(arcadeLight);
    this.lightNodes.push(arcadeLight);
    for (const desk of DESK_ANCHORS) {
      const monitor = new Graphics();
      const screenY = desk.row === "north" ? 338 : 569;
      monitor.roundRect(desk.x - 20, screenY, 42, 17, 2).fill({
        color: 0x20bbef,
        alpha: 0.08,
      });
      this.effectLayer.addChild(monitor);
      this.lightNodes.push(monitor);
      const scan = new Graphics();
      scan.rect(0, screenY + 3, 10, 1.5).fill({ color: 0xb2f7ff, alpha: 0.4 });
      this.effectLayer.addChild(scan);
      this.monitorScans.push({ node: scan, left: desk.x - 20, phase: desk.x * 0.011 });
    }
  }

  private selectDeskDepartment(index: number): void {
    const agent = this.props.agents[index];
    const department = this.props.departments.find((item) => item.id === agent?.department_id);
    if (department) this.props.onSelectDepartment(department);
  }

  private triggerObjectInteraction(id: string, at: MapPoint): void {
    if (id === "arcade") this.arcadeOn = !this.arcadeOn;
    const label =
      id === "arcade"
        ? `Arcade lights ${this.arcadeOn ? "on" : "off"}`
        : ((
            {
              kitchenette: "Kitchenette",
              foosball: "Foosball",
              lounge: "Lounge",
              elevator: "Elevator",
              executive: "Executive office",
              conference: "Conference room",
            } as Record<string, string>
          )[id] ?? "Office");
    this.onObjectInteract(label);
    const ripple = new Graphics();
    ripple.circle(0, 0, 16).stroke({ color: 0x66e2ff, width: 3, alpha: 0.8 });
    ripple.position.set(at.x, at.y);
    this.effectLayer.addChild(ripple);
    this.transientEffects.push({ node: ripple, age: 0 });
  }

  private enqueueExternalEvents(): void {
    const byId = new Map(this.props.agents.map((agent) => [agent.id, agent]));
    for (const delivery of this.props.crossDeptDeliveries ?? []) {
      if (this.processedDeliveries.has(delivery.id)) continue;
      this.processedDeliveries.add(delivery.id);
      const from = this.travelAnchorForAgent(delivery.fromAgentId);
      const to = this.travelAnchorForAgent(delivery.toAgentId);
      if (byId.has(delivery.fromAgentId) && byId.has(delivery.toAgentId)) {
        this.spawnWalkingActor(byId.get(delivery.fromAgentId), from, to);
      }
      this.props.onCrossDeptDeliveryProcessed?.(delivery.id);
    }
    for (const call of this.props.ceoOfficeCalls ?? []) {
      if (this.processedCalls.has(call.id)) continue;
      this.processedCalls.add(call.id);
      const from = this.travelAnchorForAgent(call.fromAgentId);
      const seat = INTERACTION_ANCHORS.meetingSeats[call.seatIndex % INTERACTION_ANCHORS.meetingSeats.length];
      if (call.action === "dismiss") {
        const held = this.meetingActors.get(call.fromAgentId);
        held?.node.destroy({ children: true });
        this.meetingActors.delete(call.fromAgentId);
        for (let index = this.movingActors.length - 1; index >= 0; index--) {
          if (this.movingActors[index].agentId !== call.fromAgentId) continue;
          this.movingActors[index].node.destroy({ children: true });
          this.movingActors.splice(index, 1);
        }
      } else if (call.action === "speak") {
        this.showSpeechBubble(
          seat,
          call.line?.trim() || (call.phase === "review" ? "Review in progress" : "Let's begin"),
        );
      } else if (byId.has(call.fromAgentId)) {
        const held = this.meetingActors.get(call.fromAgentId);
        held?.node.destroy({ children: true });
        this.meetingActors.delete(call.fromAgentId);
        this.spawnWalkingActor(
          byId.get(call.fromAgentId),
          from,
          seat,
          call.fromAgentId,
          call.holdUntil ?? Date.now() + 600_000,
        );
      }
      this.props.onCeoOfficeCallProcessed?.(call.id);
    }
    const current = new Set(
      this.props.tasks.filter((task) => task.status === "in_progress" && task.assigned_agent_id).map((task) => task.id),
    );
    for (const task of this.props.tasks) {
      if (!current.has(task.id) || this.activeTasks.has(task.id) || !task.assigned_agent_id) continue;
      this.spawnTaskDocument(this.ceoPos, this.travelAnchorForAgent(task.assigned_agent_id));
    }
    this.activeTasks = current;
  }

  private travelAnchorForAgent(agentId: string): MapPoint {
    const desk = this.visibleDeskByAgent.get(agentId);
    return desk ? { x: desk.approachX, y: desk.approachY } : { ...INTERACTION_ANCHORS.elevator };
  }

  private spawnWalkingActor(
    agent: Agent | undefined,
    from: MapPoint,
    to: MapPoint,
    holdAgentId?: string,
    holdUntil?: number,
  ): void {
    if (!agent) return;
    const spriteNumber = buildSpriteMap(this.props.agents).get(agent.id);
    const node = this.makeAgentNode(agent, spriteNumber);
    node.position.set(from.x, from.y);
    node.zIndex = from.y;
    this.actorLayer.addChild(node);
    const route = findWalkPath(from, to);
    if (route.length < 2) {
      node.destroy({ children: true });
      return;
    }
    this.movingActors.push({
      node,
      route,
      routeIndex: 1,
      speed: 150,
      agentId: holdAgentId,
      retainOnArrival: Boolean(holdAgentId),
      afterArrival: holdAgentId
        ? () => this.meetingActors.set(holdAgentId, { node, holdUntil: holdUntil ?? Date.now() + 600_000 })
        : undefined,
    });
  }

  private showSpeechBubble(at: MapPoint, line: string): void {
    const bubble = new Container();
    const text = new Text({
      text: line.slice(0, 90),
      style: new TextStyle({
        fontSize: 13,
        fill: 0x22313d,
        fontFamily: "system-ui, sans-serif",
        wordWrap: true,
        wordWrapWidth: 190,
      }),
    });
    text.anchor.set(0.5, 1);
    text.position.set(0, -50);
    const background = new Graphics();
    background
      .roundRect(
        -Math.min(105, text.width / 2 + 10),
        -text.height - 60,
        Math.min(210, text.width + 20),
        text.height + 18,
        8,
      )
      .fill(0xfff8e9)
      .stroke({ color: 0x45d5f5, width: 2 });
    bubble.addChild(background, text);
    bubble.position.set(at.x, at.y);
    this.effectLayer.addChild(bubble);
    const remove = () => {
      if (!bubble.destroyed) bubble.destroy({ children: true });
    };
    window.setTimeout(remove, 2800);
  }

  private spawnTaskDocument(from: MapPoint, to: MapPoint): void {
    const node = new Container();
    const paper = new Graphics();
    paper.roundRect(-8, -10, 16, 20, 2).fill(0xfaf3df).stroke({ color: 0xd4b16a, width: 1 });
    paper.moveTo(-4, -3).lineTo(4, -3).moveTo(-4, 2).lineTo(3, 2).stroke({ color: 0x69859c, width: 1 });
    node.addChild(paper);
    node.position.set(from.x, from.y - 22);
    this.effectLayer.addChild(node);
    this.movingActors.push({
      node,
      route: [
        { x: from.x, y: from.y - 22 },
        { x: to.x, y: to.y - 36 },
      ],
      routeIndex: 1,
      speed: 420,
    });
  }

  private tick = (): void => {
    const app = this.app;
    if (!app || this.disposed) return;
    const dt = Math.min(0.05, app.ticker.deltaMS / 1000);
    this.elapsed += dt;
    this.moveCeo(dt);
    this.moveActors(dt);
    for (const item of this.ambient) {
      item.node.x += item.speed * dt;
      if (item.node.x > item.maxX) item.node.x = item.minX;
    }
    this.lightNodes.forEach((light, index) => {
      light.alpha =
        (0.65 + 0.3 * Math.sin(this.elapsed * (index === 0 ? 4 : 0.9) + index * 1.2)) *
        (index === 0 && !this.arcadeOn ? 0.12 : 1);
    });
    for (const scan of this.monitorScans) {
      scan.node.x = scan.left + ((this.elapsed * 7 + scan.phase * 11) % 32);
      scan.node.alpha = 0.18 + 0.18 * Math.sin(this.elapsed * 1.3 + scan.phase);
    }
    for (const item of this.agentNodes.values()) {
      const amplitude = item.agent.status === "working" ? 1.2 : 0.35;
      item.node.y = item.position.y + Math.sin(this.elapsed * 2.1 + item.position.x * 0.02) * amplitude;
    }
    for (const clone of this.subAgentNodes) {
      clone.node.position.set(
        clone.base.x + Math.sin(this.elapsed * 1.6 + clone.phase) * 2,
        clone.base.y + Math.sin(this.elapsed * 2.3 + clone.phase) * 2,
      );
    }
    for (let index = this.transientEffects.length - 1; index >= 0; index--) {
      const effect = this.transientEffects[index];
      effect.age += dt;
      effect.node.scale.set(1 + effect.age * 2);
      effect.node.alpha = Math.max(0, 1 - effect.age * 1.4);
      if (effect.age > 0.75) {
        effect.node.destroy();
        this.transientEffects.splice(index, 1);
      }
    }
    this.highlightNode.alpha = 0.65 + Math.sin(this.elapsed * 2.8) * 0.2;
    const now = Date.now();
    for (const [agentId, held] of this.meetingActors) {
      if (held.holdUntil > now) continue;
      held.node.destroy({ children: true });
      this.meetingActors.delete(agentId);
    }
    if (this.elapsed - this.lastBirdAt > 18) {
      this.lastBirdAt = this.elapsed;
      const bird = makeBird(-20, 55 + Math.random() * 55);
      this.skyMotion.addChild(bird);
      this.ambient.push({ node: bird, speed: 38, minX: -20, maxX: MAP_WIDTH + 30 });
      if (this.ambient.length > 8) {
        const old = this.ambient.splice(4, 1)[0];
        old.node.destroy();
      }
    }
    if (this.elapsed - this.lastPlaneAt > 85) {
      this.lastPlaneAt = this.elapsed;
      const plane = makePlane(-25, 105);
      this.skyMotion.addChild(plane);
      this.ambient.push({ node: plane, speed: 57, minX: -25, maxX: MAP_WIDTH + 35 });
    }
  };

  private moveCeo(dt: number): void {
    if (!this.ceoNode) return;
    let dx =
      Number(this.keys.has("ArrowRight") || this.keys.has("KeyD")) -
      Number(this.keys.has("ArrowLeft") || this.keys.has("KeyA"));
    let dy =
      Number(this.keys.has("ArrowDown") || this.keys.has("KeyS")) -
      Number(this.keys.has("ArrowUp") || this.keys.has("KeyW"));
    if (dx === 0 && dy === 0) return;
    const length = Math.hypot(dx, dy);
    dx = (dx / length) * 175 * dt;
    dy = (dy / length) * 175 * dt;
    const nextX = { x: this.ceoPos.x + dx, y: this.ceoPos.y };
    if (isWalkable(nextX, 10)) this.ceoPos.x = nextX.x;
    const nextY = { x: this.ceoPos.x, y: this.ceoPos.y + dy };
    if (isWalkable(nextY, 10)) this.ceoPos.y = nextY.y;
    this.ceoNode.position.set(this.ceoPos.x, this.ceoPos.y);
    this.ceoNode.zIndex = this.ceoPos.y;
    if (this.camera.zoom > 1.15) this.followCeo();
  }

  private moveActors(dt: number): void {
    for (let index = this.movingActors.length - 1; index >= 0; index--) {
      const actor = this.movingActors[index];
      let distanceLeft = actor.speed * dt;
      while (distanceLeft > 0 && actor.routeIndex < actor.route.length) {
        const target = actor.route[actor.routeIndex];
        const current = { x: actor.node.x, y: actor.node.y };
        const distance = pointDistance(current, target);
        if (distance <= distanceLeft || distance < 0.01) {
          actor.node.position.set(target.x, target.y);
          actor.routeIndex++;
          distanceLeft -= distance;
        } else {
          const ratio = distanceLeft / distance;
          actor.node.position.set(
            current.x + (target.x - current.x) * ratio,
            current.y + (target.y - current.y) * ratio,
          );
          distanceLeft = 0;
        }
      }
      actor.node.zIndex = actor.node.y;
      if (actor.routeIndex >= actor.route.length) {
        actor.afterArrival?.();
        if (!actor.retainOnArrival) actor.node.destroy({ children: true });
        this.movingActors.splice(index, 1);
      }
    }
  }

  private followCeo(): void {
    const scale = getReferenceMapScale(this.camera);
    const screenX = this.ceoPos.x * scale + this.camera.offsetX;
    const screenY = this.ceoPos.y * scale + this.camera.offsetY;
    const marginX = this.camera.viewportWidth * 0.2;
    const marginY = this.camera.viewportHeight * 0.2;
    const dx =
      screenX < marginX
        ? marginX - screenX
        : screenX > this.camera.viewportWidth - marginX
          ? this.camera.viewportWidth - marginX - screenX
          : 0;
    const dy =
      screenY < marginY
        ? marginY - screenY
        : screenY > this.camera.viewportHeight - marginY
          ? this.camera.viewportHeight - marginY - screenY
          : 0;
    if (dx || dy) {
      this.camera = panReferenceMapBy(this.camera, dx, dy);
      this.applyCamera();
    }
  }

  private applyCamera(): void {
    this.world.scale.set(getReferenceMapScale(this.camera));
    this.world.position.set(this.camera.offsetX, this.camera.offsetY);
    if (this.detailTimer !== null) window.clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => {
      this.detailTimer = null;
      this.refreshDetailTiles();
    }, 90);
  }

  private detailUrl(key: string): string {
    return `/office-map/detail/${key}.png`;
  }

  private desiredDetailTiles(): Set<string> {
    const topLeft = screenToWorld(this.camera, { x: 0, y: 0 });
    const bottomRight = screenToWorld(this.camera, {
      x: this.camera.viewportWidth,
      y: this.camera.viewportHeight,
    });
    const desired = new Set<string>();
    for (let row = 0; row < DETAIL_TILE_COUNT; row++) {
      for (let column = 0; column < DETAIL_TILE_COUNT; column++) {
        const left = column * DETAIL_TILE_W;
        const top = row * DETAIL_TILE_H;
        if (
          left < bottomRight.x &&
          left + DETAIL_TILE_W > topLeft.x &&
          top < bottomRight.y &&
          top + DETAIL_TILE_H > topLeft.y
        ) {
          for (const layer of STATIC_LAYERS) desired.add(`${layer}-${column}-${row}`);
        }
      }
    }
    return desired;
  }

  private disposeDetailTile(key: string): void {
    const sprite = this.detailTiles.get(key);
    if (!sprite) return;
    sprite.destroy();
    this.detailTiles.delete(key);
    const base = this.baseTiles.get(key);
    if (base) base.visible = true;
    const timer = window.setTimeout(() => {
      this.detailEvictionTimers.delete(key);
      const unload = Assets.unload(this.detailUrl(key))
        .catch(() => {})
        .finally(() => this.detailUnloadPromises.delete(key));
      this.detailUnloadPromises.set(key, unload);
    }, 2000);
    this.detailEvictionTimers.set(key, timer);
  }

  private refreshDetailTiles(): void {
    if (this.disposed || !this.app) return;
    const physicalScale =
      getReferenceMapScale(this.camera) * canvasResolution(this.camera.viewportWidth, this.camera.viewportHeight);
    if (physicalScale >= 3.6) this.detailActive = true;
    else if (physicalScale < 3.1) this.detailActive = false;
    const desired = this.detailActive ? this.desiredDetailTiles() : new Set<string>();
    for (const key of this.detailTiles.keys()) {
      if (!desired.has(key)) this.disposeDetailTile(key);
    }
    for (const key of desired) {
      if (this.detailTiles.has(key) || this.pendingDetailTiles.has(key)) continue;
      const eviction = this.detailEvictionTimers.get(key);
      if (eviction !== undefined) {
        window.clearTimeout(eviction);
        this.detailEvictionTimers.delete(key);
      }
      this.pendingDetailTiles.add(key);
      const url = this.detailUrl(key);
      void Promise.resolve(this.detailUnloadPromises.get(key))
        .then(() => Assets.load<Texture>(url))
        .then((texture) => {
          this.pendingDetailTiles.delete(key);
          if (this.disposed || !this.detailActive || !this.desiredDetailTiles().has(key)) {
            void Assets.unload(url).catch(() => {});
            return;
          }
          const [layer, columnText, rowText] = key.split("-");
          const column = Number(columnText);
          const row = Number(rowText);
          const sprite = new Sprite(texture);
          sprite.position.set(column * DETAIL_TILE_W, row * DETAIL_TILE_H);
          sprite.width = DETAIL_TILE_W;
          sprite.height = DETAIL_TILE_H;
          this.detailLayers.get(layer as LayerName)?.addChild(sprite);
          this.detailTiles.set(key, sprite);
          const base = this.baseTiles.get(key);
          if (base) base.visible = false;
        })
        .catch(() => this.pendingDetailTiles.delete(key));
    }
  }

  private resize = (): void => {
    if (!this.app || this.disposed) return;
    const width = Math.max(1, this.element.clientWidth);
    const height = Math.max(1, this.element.clientHeight);
    this.app.renderer.resize(width, height, canvasResolution(width, height));
    this.camera = resizeReferenceMapCamera(this.camera, width, height);
    this.applyCamera();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.appCanvas?.getBoundingClientRect();
    if (!rect) return;
    const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = Math.exp(-event.deltaY * 0.0012);
    this.camera = zoomReferenceMapAt(this.camera, this.camera.zoom * factor, local);
    this.applyCamera();
  };

  private toLocal(event: PointerEvent): MapPoint {
    const rect = this.appCanvas?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.appCanvas?.setPointerCapture(event.pointerId);
    const point = this.toLocal(event);
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size === 1) {
      this.pointerStart = point;
      this.pointerLast = point;
      this.pointerDragged = false;
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = pointDistance(a, b);
      this.pointerDragged = true;
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    const point = this.toLocal(event);
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = pointDistance(a, b);
      if (this.pinchDistance > 0) {
        this.camera = zoomReferenceMapAt(this.camera, this.camera.zoom * (distance / this.pinchDistance), {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
        });
        this.applyCamera();
      }
      this.pinchDistance = distance;
    } else if (this.pointerLast && this.pointerStart) {
      if (pointDistance(point, this.pointerStart) > 4) this.pointerDragged = true;
      if (this.pointerDragged) {
        this.camera = panReferenceMapBy(this.camera, point.x - this.pointerLast.x, point.y - this.pointerLast.y);
        this.applyCamera();
      }
      this.pointerLast = point;
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    const point = this.toLocal(event);
    if (!this.pointerDragged && this.pointers.size === 1) this.selectAt(screenToWorld(this.camera, point));
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    if (this.pointers.size === 0) {
      this.pointerStart = null;
      this.pointerLast = null;
      this.pointerDragged = false;
    }
  };

  private selectAt(point: MapPoint): void {
    if (this.props.activeMeetingTaskId && point.x >= 895 && point.x <= 1200 && point.y >= 174 && point.y <= 238) {
      this.props.onOpenActiveMeetingMinutes?.(this.props.activeMeetingTaskId);
      return;
    }
    let closest: AgentNode | null = null;
    let distance = 52;
    for (const item of this.agentNodes.values()) {
      const current = pointDistance(point, item.position);
      if (current < distance) {
        closest = item;
        distance = current;
      }
    }
    if (closest) {
      this.props.onSelectAgent(closest.agent);
      return;
    }
    if (pointDistance(point, INTERACTION_ANCHORS.meetingTable) < 80 && this.props.activeMeetingTaskId) {
      this.props.onOpenActiveMeetingMinutes?.(this.props.activeMeetingTaskId);
      return;
    }
    if (pointDistance(point, INTERACTION_ANCHORS.foosball) < 75) {
      this.triggerObjectInteraction("foosball", INTERACTION_ANCHORS.foosball);
      return;
    }
    const deskIndex = DESK_ANCHORS.findIndex((desk) => pointDistance(point, desk) < 75);
    if (deskIndex >= 0) {
      this.selectDeskDepartment(deskIndex);
      return;
    }
    const room = ROOM_ZONES.find((zone) => isInsideRect(point, zone));
    if (room) this.triggerObjectInteraction(room.id, room.interactAt);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = document.activeElement as HTMLElement | null;
    if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
    } else if ((event.code === "Enter" || event.code === "Space") && !event.repeat) {
      event.preventDefault();
      this.interact();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  destroy(): void {
    this.disposed = true;
    if (this.detailTimer !== null) window.clearTimeout(this.detailTimer);
    this.resizeObserver?.disconnect();
    const canvas = this.appCanvas;
    canvas?.removeEventListener("wheel", this.onWheel);
    canvas?.removeEventListener("pointerdown", this.onPointerDown);
    canvas?.removeEventListener("pointermove", this.onPointerMove);
    canvas?.removeEventListener("pointerup", this.onPointerUp);
    canvas?.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.app?.ticker?.remove(this.tick);
    for (const key of [...this.detailTiles.keys()]) this.disposeDetailTile(key);
    for (const [key, timer] of this.detailEvictionTimers) {
      window.clearTimeout(timer);
      void Assets.unload(this.detailUrl(key)).catch(() => {});
    }
    this.detailEvictionTimers.clear();
    if (this.app?.renderer) this.app.destroy(true, { children: true });
    this.app = null;
    this.appCanvas = null;
    this.movingActors = [];
    this.agentNodes.clear();
  }
}
