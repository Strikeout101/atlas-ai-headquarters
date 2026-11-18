import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "exec" | "prepare">;

interface DefaultAgent {
  name: string;
  nameKo: string;
  nameJa: string;
  nameZh: string;
  /** Name this agent had in installs seeded before the rename. */
  legacyName: string;
  department: string;
  role: "team_leader" | "senior" | "junior";
  cli: string;
  emoji: string;
  personality: string;
  /** Sprite, and so headshot, for new installs; matched to the name. */
  sprite: number;
  /**
   * Sprite to pin when renaming an existing install. The old "DORO" got sprite 13 by name, which the rename would
   * lose; everyone else keeps the face they already have.
   */
  legacySprite?: number;
}

/** The default team. Names suit the headshot each agent gets (atlas-office/agentLooks.ts). */
export const DEFAULT_AGENTS: ReadonlyArray<DefaultAgent> = [
  {
    name: "Marcus",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Aria",
    department: "dev",
    role: "team_leader",
    cli: "claude",
    emoji: "👨‍💻",
    personality: "Meticulous senior developer",
    sprite: 1,
  },
  {
    name: "Elena",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Bolt",
    department: "dev",
    role: "senior",
    cli: "codex",
    emoji: "⚡",
    personality: "Fast coding specialist",
    sprite: 2,
  },
  {
    name: "Owen",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Nova",
    department: "dev",
    role: "junior",
    cli: "copilot",
    emoji: "🌟",
    personality: "Creative junior",
    sprite: 3,
  },
  {
    name: "Iris",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Pixel",
    department: "design",
    role: "team_leader",
    cli: "claude",
    emoji: "🎨",
    personality: "Design leader",
    sprite: 4,
  },
  {
    name: "Felix",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Luna",
    department: "design",
    role: "junior",
    cli: "gemini",
    emoji: "🖌️",
    personality: "Empathetic UI designer",
    sprite: 5,
  },
  {
    name: "Adrian",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Sage",
    department: "planning",
    role: "team_leader",
    cli: "codex",
    emoji: "🧠",
    personality: "Strategic analyst",
    sprite: 7,
  },
  {
    name: "Claire",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Clio",
    department: "planning",
    role: "senior",
    cli: "claude",
    emoji: "📝",
    personality: "Data-driven planner",
    sprite: 6,
  },
  {
    name: "Diana",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Atlas",
    department: "operations",
    role: "team_leader",
    cli: "claude",
    emoji: "🗺️",
    personality: "Operations expert",
    sprite: 8,
  },
  {
    name: "Priya",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Turbo",
    department: "operations",
    role: "senior",
    cli: "codex",
    emoji: "🚀",
    personality: "Automation specialist",
    sprite: 10,
  },
  {
    name: "Victor",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Hawk",
    department: "qa",
    role: "team_leader",
    cli: "claude",
    emoji: "🔍",
    personality: "Sharp-eyed quality guardian",
    sprite: 9,
  },
  {
    name: "Hannah",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Lint",
    department: "qa",
    role: "senior",
    cli: "codex",
    emoji: "🔬",
    personality: "Meticulous testing specialist",
    sprite: 12,
  },
  {
    name: "Leo",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "DORO",
    department: "qa",
    role: "junior",
    cli: "gemini",
    emoji: "🧪",
    personality: "Meticulous junior QA",
    sprite: 13,
    legacySprite: 13,
  },
  {
    name: "Rafael",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Vault",
    department: "devsecops",
    role: "team_leader",
    cli: "claude",
    emoji: "🛡️",
    personality: "Security architect",
    sprite: 11,
  },
  {
    name: "Nadia",
    nameKo: "",
    nameJa: "",
    nameZh: "",
    legacyName: "Pipe",
    department: "devsecops",
    role: "senior",
    cli: "codex",
    emoji: "🔧",
    personality: "CI/CD pipeline specialist",
    sprite: 14,
  },
];

export function applyDefaultSeeds(db: DbLike): void {
  const deptCount = (db.prepare("SELECT COUNT(*) as cnt FROM departments").get() as { cnt: number }).cnt;

  if (deptCount === 0) {
    const insertDept = db.prepare(
      "INSERT INTO departments (id, name, name_ko, name_ja, name_zh, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Workflow order: planning → dev → design → QA → infra security → operations
    insertDept.run("planning", "Planning", "", "", "", "📊", "#f59e0b", 1);
    insertDept.run("dev", "Development", "", "", "", "💻", "#3b82f6", 2);
    insertDept.run("design", "Design", "", "", "", "🎨", "#8b5cf6", 3);
    insertDept.run("qa", "QA/QC", "", "", "", "🔍", "#ef4444", 4);
    insertDept.run("devsecops", "DevSecOps", "", "", "", "🛡️", "#f97316", 5);
    insertDept.run("operations", "Operations", "", "", "", "⚙️", "#10b981", 6);
    console.log("[ATLAS] Seeded default departments");
  }

  const agentCount = (db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as { cnt: number }).cnt;

  if (agentCount === 0) {
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, name_ko, name_ja, name_zh, department_id, role, cli_provider, avatar_emoji, personality, sprite_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const agent of DEFAULT_AGENTS) {
      insertAgent.run(
        randomUUID(),
        agent.name,
        agent.nameKo,
        agent.nameJa,
        agent.nameZh,
        agent.department,
        agent.role,
        agent.cli,
        agent.emoji,
        agent.personality,
        agent.sprite,
      );
    }
    console.log("[ATLAS] Seeded default agents");
  }

  // Earlier installs seeded playful names (Aria, Bolt, DORO, ...). Rename a default agent only while it still has
  // its original seed name, department and role, so agents the owner renamed or moved are left alone.
  {
    const rename = db.prepare(
      `UPDATE agents SET name = ?, name_ko = ?, name_ja = ?, name_zh = ?,
        sprite_number = COALESCE(sprite_number, ?)
      WHERE name = ? AND department_id = ? AND role = ?`,
    );
    for (const agent of DEFAULT_AGENTS) {
      rename.run(
        agent.name,
        agent.nameKo,
        agent.nameJa,
        agent.nameZh,
        agent.legacySprite ?? null,
        agent.legacyName,
        agent.department,
        agent.role,
      );
    }
  }

  // ATLAS is English-only: clear the translated name columns that older installs filled in.
  // (Skipped quietly on a very old database whose name_ja/name_zh columns are added by a later migration.)
  for (const table of ["agents", "departments"]) {
    try {
      db.exec(
        `UPDATE ${table} SET name_ko = '', name_ja = '', name_zh = '' WHERE name_ko <> '' OR name_ja <> '' OR name_zh <> ''`,
      );
    } catch {
      // columns not there yet
    }
  }

  // Seed default settings if none exist
  {
    const defaultRoomThemes = {
      ceoOffice: { accent: 0xa77d0c, floor1: 0xe5d9b9, floor2: 0xdfd0a8, wall: 0x998243 },
      planning: { accent: 0xd4a85a, floor1: 0xf0e1c5, floor2: 0xeddaba, wall: 0xae9871 },
      dev: { accent: 0x5a9fd4, floor1: 0xd8e8f5, floor2: 0xcce1f2, wall: 0x6c96b7 },
      design: { accent: 0x9a6fc4, floor1: 0xe8def2, floor2: 0xe1d4ee, wall: 0x9378ad },
      qa: { accent: 0xd46a6a, floor1: 0xf0cbcb, floor2: 0xedc0c0, wall: 0xae7979 },
      devsecops: { accent: 0xd4885a, floor1: 0xf0d5c5, floor2: 0xedcdba, wall: 0xae8871 },
      operations: { accent: 0x5ac48a, floor1: 0xd0eede, floor2: 0xc4ead5, wall: 0x6eaa89 },
      breakRoom: { accent: 0xf0c878, floor1: 0xf7e2b7, floor2: 0xf6dead, wall: 0xa99c83 },
    };

    const settingsCount = (db.prepare("SELECT COUNT(*) as c FROM settings").get() as { c: number }).c;
    const isLegacySettingsInstall = settingsCount > 0;
    if (settingsCount === 0) {
      const insertSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      insertSetting.run("companyName", "ATLAS");
      insertSetting.run("ceoName", "CEO");
      insertSetting.run("autoAssign", "true");
      insertSetting.run("yoloMode", "false");
      insertSetting.run("autoUpdateEnabled", "false");
      insertSetting.run("autoUpdateNoticePending", "false");
      insertSetting.run("oauthAutoSwap", "true");
      insertSetting.run("language", "en");
      insertSetting.run("defaultProvider", "claude");
      insertSetting.run(
        "providerModelConfig",
        JSON.stringify({
          claude: { model: "claude-opus-4-6", subModel: "claude-sonnet-4-6" },
          codex: {
            model: "gpt-5.3-codex",
            reasoningLevel: "xhigh",
            subModel: "gpt-5.3-codex",
            subModelReasoningLevel: "high",
          },
          gemini: { model: "gemini-3-pro-preview" },
          opencode: { model: "github-copilot/claude-sonnet-4.6" },
          copilot: { model: "github-copilot/claude-sonnet-4.6" },
          antigravity: { model: "google/antigravity-gemini-3-pro" },
        }),
      );
      insertSetting.run("roomThemes", JSON.stringify(defaultRoomThemes));
      console.log("[ATLAS] Seeded default settings");
    }

    const hasLanguageSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'language' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasLanguageSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("language", "en");
    }

    const hasOAuthAutoSwapSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'oauthAutoSwap' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasOAuthAutoSwapSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("oauthAutoSwap", "true");
    }

    const hasAutoUpdateEnabledSetting = db
      .prepare("SELECT 1 FROM settings WHERE key = 'autoUpdateEnabled' LIMIT 1")
      .get() as { 1: number } | undefined;
    if (!hasAutoUpdateEnabledSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("autoUpdateEnabled", "false");
    }

    const hasYoloModeSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'yoloMode' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasYoloModeSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("yoloMode", "false");
    }

    const hasAutoUpdateNoticePendingSetting = db
      .prepare("SELECT 1 FROM settings WHERE key = 'autoUpdateNoticePending' LIMIT 1")
      .get() as { 1: number } | undefined;
    if (!hasAutoUpdateNoticePendingSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "autoUpdateNoticePending",
        isLegacySettingsInstall ? "true" : "false",
      );
    }

    const hasRoomThemesSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'roomThemes' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasRoomThemesSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "roomThemes",
        JSON.stringify(defaultRoomThemes),
      );
    }
  }

  // Migrate: add sort_order column & set correct ordering for existing DBs
  {
    try {
      db.exec("ALTER TABLE agents ADD COLUMN acts_as_planning_leader INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    try {
      db.exec(`
        UPDATE agents
        SET acts_as_planning_leader = CASE
          WHEN role = 'team_leader' AND department_id = 'planning' THEN 1
          ELSE COALESCE(acts_as_planning_leader, 0)
        END
      `);
    } catch {
      /* best effort */
    }

    try {
      db.exec("ALTER TABLE departments ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 99");
    } catch {
      /* already exists */
    }

    // Drop the UNIQUE index, update values, recreate it (avoids conflicts)
    try {
      db.exec("DROP INDEX IF EXISTS idx_departments_sort_order");
    } catch {
      /* noop */
    }
    const DEPT_ORDER: Record<string, number> = { planning: 1, dev: 2, design: 3, qa: 4, devsecops: 5, operations: 6 };

    const insertDeptIfMissing = db.prepare(
      "INSERT OR IGNORE INTO departments (id, name, name_ko, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertDeptIfMissing.run("qa", "QA/QC", "", "🔍", "#ef4444", 4);
    insertDeptIfMissing.run("devsecops", "DevSecOps", "", "🛡️", "#f97316", 5);

    const updateOrder = db.prepare("UPDATE departments SET sort_order = ? WHERE id = ?");
    for (const [id, order] of Object.entries(DEPT_ORDER)) {
      updateOrder.run(order, id);
    }

    const allDepartments = db
      .prepare("SELECT id, sort_order FROM departments ORDER BY sort_order ASC, id ASC")
      .all() as Array<{ id: string; sort_order: number }>;
    const existingDeptIds = new Set(allDepartments.map((row) => row.id));
    const usedOrders = new Set<number>();
    for (const [id, order] of Object.entries(DEPT_ORDER)) {
      if (!existingDeptIds.has(id)) continue;
      usedOrders.add(order);
    }

    let nextOrder = 1;
    for (const row of allDepartments) {
      if (Object.prototype.hasOwnProperty.call(DEPT_ORDER, row.id)) continue;
      while (usedOrders.has(nextOrder)) nextOrder += 1;
      updateOrder.run(nextOrder, row.id);
      usedOrders.add(nextOrder);
      nextOrder += 1;
    }

    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_sort_order ON departments(sort_order)");
    } catch (err) {
      console.warn("[ATLAS] Failed to recreate idx_departments_sort_order:", err);
    }

    const insertAgentIfMissing = db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, name_ko, name_ja, name_zh, department_id, role, cli_provider, avatar_emoji, personality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Check which agents exist by name to avoid duplicates. An agent counts as present under its current or its
    // pre-rename name, so renamed installs don't get the old agents back.
    const existingNames = new Set(
      (db.prepare("SELECT name FROM agents").all() as { name: string }[]).map((r) => r.name),
    );

    // Agents added to installs that predate them (originally Luna, Clio, Turbo, Hawk, Lint, Vault, Pipe).
    // This top-up happens once per install. Running it on every start re-created default agents the owner had
    // deleted, so an install that already has any of them (or has done the top-up) is left alone.
    const LATER_DEFAULTS = new Set(["Luna", "Clio", "Turbo", "Hawk", "Lint", "Vault", "Pipe"]);
    const LATER_DEFAULTS_DONE_KEY = "laterDefaultAgentsAdded";
    const laterDefaultsDone = Boolean(
      db.prepare("SELECT 1 FROM settings WHERE key = ? LIMIT 1").get(LATER_DEFAULTS_DONE_KEY),
    );
    const hasAnyLaterDefault = DEFAULT_AGENTS.some(
      (agent) =>
        LATER_DEFAULTS.has(agent.legacyName) && (existingNames.has(agent.name) || existingNames.has(agent.legacyName)),
    );
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, 'true')").run(LATER_DEFAULTS_DONE_KEY);
    let added = 0;
    for (const agent of laterDefaultsDone || hasAnyLaterDefault ? [] : DEFAULT_AGENTS) {
      if (!LATER_DEFAULTS.has(agent.legacyName)) continue;
      if (existingNames.has(agent.name) || existingNames.has(agent.legacyName)) continue;
      if (!existingDeptIds.has(agent.department)) {
        console.warn(`[ATLAS] Skip adding agent "${agent.name}": missing department "${agent.department}"`);
        continue;
      }
      try {
        insertAgentIfMissing.run(
          randomUUID(),
          agent.name,
          agent.nameKo,
          agent.nameJa,
          agent.nameZh,
          agent.department,
          agent.role,
          agent.cli,
          agent.emoji,
          agent.personality,
        );
        added++;
      } catch (err) {
        console.warn(`[ATLAS] Skip adding agent "${agent.name}":`, err);
      }
    }
    if (added > 0) console.log(`[ATLAS] Added ${added} new agents`);
  }
}
