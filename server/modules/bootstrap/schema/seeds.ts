import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "exec" | "prepare">;

/** Original Korean seed personalities and their English replacements. */
export const LEGACY_KOREAN_SEED_PERSONALITIES: ReadonlyArray<readonly [string, string]> = [
  ["꼼꼼한 시니어 개발자", "Meticulous senior developer"],
  ["빠른 코딩 전문가", "Fast coding specialist"],
  ["창의적인 주니어", "Creative junior"],
  ["디자인 리더", "Design leader"],
  ["감성적인 UI 디자이너", "Empathetic UI designer"],
  ["전략 분석가", "Strategic analyst"],
  ["데이터 기반 기획자", "Data-driven planner"],
  ["운영의 달인", "Operations expert"],
  ["자동화 전문가", "Automation specialist"],
  ["날카로운 품질 감시자", "Sharp-eyed quality guardian"],
  ["꼼꼼한 테스트 전문가", "Meticulous testing specialist"],
  ["보안 아키텍트", "Security architect"],
  ["CI/CD 파이프라인 전문가", "CI/CD pipeline specialist"],
  ["꼼꼼한 품질관리 주니어", "Meticulous junior QA"],
];

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
    nameKo: "마커스",
    nameJa: "マーカス",
    nameZh: "马库斯",
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
    nameKo: "엘레나",
    nameJa: "エレナ",
    nameZh: "埃琳娜",
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
    nameKo: "오웬",
    nameJa: "オーウェン",
    nameZh: "欧文",
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
    nameKo: "아이리스",
    nameJa: "アイリス",
    nameZh: "艾丽丝",
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
    nameKo: "펠릭스",
    nameJa: "フェリックス",
    nameZh: "费利克斯",
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
    nameKo: "에이드리언",
    nameJa: "エイドリアン",
    nameZh: "阿德里安",
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
    nameKo: "클레어",
    nameJa: "クレア",
    nameZh: "克莱尔",
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
    nameKo: "다이애나",
    nameJa: "ダイアナ",
    nameZh: "黛安娜",
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
    nameKo: "프리야",
    nameJa: "プリヤ",
    nameZh: "普丽娅",
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
    nameKo: "빅터",
    nameJa: "ビクター",
    nameZh: "维克多",
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
    nameKo: "해나",
    nameJa: "ハンナ",
    nameZh: "汉娜",
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
    nameKo: "레오",
    nameJa: "レオ",
    nameZh: "利奥",
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
    nameKo: "라파엘",
    nameJa: "ラファエル",
    nameZh: "拉斐尔",
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
    nameKo: "나디아",
    nameJa: "ナディア",
    nameZh: "娜迪亚",
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
    // Workflow order: 기획 → 개발 → 디자인 → QA → 인프라보안 → 운영
    insertDept.run("planning", "Planning", "기획팀", "企画チーム", "企划组", "📊", "#f59e0b", 1);
    insertDept.run("dev", "Development", "개발팀", "開発チーム", "开发组", "💻", "#3b82f6", 2);
    insertDept.run("design", "Design", "디자인팀", "デザインチーム", "设计组", "🎨", "#8b5cf6", 3);
    insertDept.run("qa", "QA/QC", "품질관리팀", "品質管理チーム", "质量管理组", "🔍", "#ef4444", 4);
    insertDept.run(
      "devsecops",
      "DevSecOps",
      "인프라보안팀",
      "インフラセキュリティチーム",
      "基础安全组",
      "🛡️",
      "#f97316",
      5,
    );
    insertDept.run("operations", "Operations", "운영팀", "運営チーム", "运营组", "⚙️", "#10b981", 6);
    console.log("[Claw-Empire] Seeded default departments");
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
    console.log("[Claw-Empire] Seeded default agents");
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

  // Earlier installs seeded these personalities in Korean. They are part of every agent prompt, so a Korean
  // personality pulls replies toward Korean whatever the UI language is. Translate only untouched seed values.
  {
    const translate = db.prepare("UPDATE agents SET personality = ? WHERE personality = ?");
    for (const [korean, english] of LEGACY_KOREAN_SEED_PERSONALITIES) translate.run(english, korean);
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
      insertSetting.run("companyName", "Claw-Empire");
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
      console.log("[Claw-Empire] Seeded default settings");
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

    // UNIQUE 인덱스 일시 제거 → 값 갱신 → 인덱스 재생성 (충돌 방지)
    try {
      db.exec("DROP INDEX IF EXISTS idx_departments_sort_order");
    } catch {
      /* noop */
    }
    const DEPT_ORDER: Record<string, number> = { planning: 1, dev: 2, design: 3, qa: 4, devsecops: 5, operations: 6 };

    const insertDeptIfMissing = db.prepare(
      "INSERT OR IGNORE INTO departments (id, name, name_ko, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertDeptIfMissing.run("qa", "QA/QC", "품질관리팀", "🔍", "#ef4444", 4);
    insertDeptIfMissing.run("devsecops", "DevSecOps", "인프라보안팀", "🛡️", "#f97316", 5);

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
      console.warn("[Claw-Empire] Failed to recreate idx_departments_sort_order:", err);
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
        console.warn(`[Claw-Empire] Skip adding agent "${agent.name}": missing department "${agent.department}"`);
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
        console.warn(`[Claw-Empire] Skip adding agent "${agent.name}":`, err);
      }
    }
    if (added > 0) console.log(`[Claw-Empire] Added ${added} new agents`);
  }
}
