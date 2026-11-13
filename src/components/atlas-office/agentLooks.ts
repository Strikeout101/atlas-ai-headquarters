/**
 * Which 3D person each agent is. Kept free of three.js so the dashboard can use it for headshots without loading
 * the 3D office.
 *
 * Models and headshots are built by art/blender/build_atlas_agents.py from Microsoft Rocketbox avatars (MIT):
 *   public/models/atlas/agent-<key>.glb   body, rig and the shared animation clips
 *   public/portraits/<key>.webp           dashboard headshot of the same model
 */
export interface AgentLook {
  key: string;
  /** Optional replacement texture for the model's base-colour map. */
  texture?: string;
}

const looks = (keys: string[]): AgentLook[] => keys.map((key) => ({ key }));

/**
 * One person per pixel-sprite number (sprite 1 = first entry; the app has sprites 1-14), so the 3D model, the
 * dashboard headshot and the sprite picker agree. Women and men alternate.
 */
export const AGENT_LOOKS: AgentLook[] = looks([
  "rb-bm1",
  "rb-bf1",
  "rb-bm2",
  "rb-bf2",
  "rb-bm3",
  "rb-bf3",
  "rb-bm4",
  "rb-bf4",
  "rb-bm5",
  "rb-af05",
  "rb-bm6",
  "rb-af07",
  "rb-bm7",
  "rb-af09",
]);

/** More people for agents whose sprite number is already taken (sprite numbers repeat after 12 auto-assigned). */
export const EXTRA_LOOKS: AgentLook[] = looks([
  "rb-af01",
  "rb-am03",
  "rb-af02",
  "rb-am12",
  "rb-af11",
  "rb-am08",
  "rb-af14",
  "rb-am02",
  "rb-af15",
  "rb-am07",
  "rb-am14",
]);

export const ALL_LOOKS: AgentLook[] = [...AGENT_LOOKS, ...EXTRA_LOOKS];

/** The look for a sprite number, ignoring other agents. */
export function lookForSprite(spriteNumber: number): AgentLook {
  const index = (((Math.max(1, Math.floor(spriteNumber)) - 1) % AGENT_LOOKS.length) + AGENT_LOOKS.length) % AGENT_LOOKS.length;
  return AGENT_LOOKS[index];
}

const lookMapCache = new WeakMap<ReadonlyMap<string, number>, Map<string, AgentLook>>();

/**
 * Looks for a whole company, from its sprite map (agent id -> sprite number). Each agent gets its sprite's look
 * unless an earlier agent (by id) already has it; then it gets the next unused extra look, so nobody shares a face
 * until every look is taken.
 */
export function buildLookMap(spriteMap: ReadonlyMap<string, number>): Map<string, AgentLook> {
  const cached = lookMapCache.get(spriteMap);
  if (cached) return cached;
  const result = new Map<string, AgentLook>();
  const used = new Set<string>();
  const spare = () => ALL_LOOKS.find((look) => !used.has(look.key));
  for (const id of [...spriteMap.keys()].sort()) {
    const own = lookForSprite(spriteMap.get(id) ?? 1);
    const look = used.has(own.key) ? (EXTRA_LOOKS.find((l) => !used.has(l.key)) ?? spare() ?? own) : own;
    used.add(look.key);
    result.set(id, look);
  }
  lookMapCache.set(spriteMap, result);
  return result;
}

export function modelUrl(look: AgentLook): string {
  return `/models/atlas/agent-${look.key}.glb`;
}

export function portraitUrl(look: AgentLook): string {
  return `/portraits/${look.key}.webp`;
}
