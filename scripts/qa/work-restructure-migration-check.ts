/** Phase 9: migrate a disposable copy of the live database without starting ATLAS or any model loop. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyBaseSchema } from "../../server/modules/bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../server/modules/bootstrap/schema/task-schema-migrations.ts";
import {
  applyWorkModelMigration,
  archiveLegacyWork,
  dropRetiredWorkTables,
} from "../../server/modules/bootstrap/schema/work-model-migration.ts";
import { ensureReviewSchema } from "../../server/modules/task-review.ts";
import { ensureAutonomyEngineSchema } from "../../server/modules/autonomy-engine.ts";
import { requestFreshResearchOnce } from "../../server/modules/goal-strategy.ts";
import { ensureModelRoutingSchema } from "../../server/modules/model-routing.ts";
import { ensureControlStateSchema } from "../../server/modules/control-state.ts";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg)
  throw new Error("usage: tsx work-restructure-migration-check.ts <source-copy> <output-copy>");
const source = path.resolve(sourceArg);
const output = path.resolve(outputArg);
const safeDir = path.resolve(".tmp/phase9-copy");
if (!source.startsWith(`${safeDir}${path.sep}`) || !output.startsWith(`${safeDir}${path.sep}`) || source === output)
  throw new Error("source and output must be distinct files inside .tmp/phase9-copy");
if (!fs.existsSync(source) || fs.existsSync(output)) throw new Error("source missing or output already exists");

function count(db: DatabaseSync, name: string): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return exists ? Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n) : 0;
}

const before = new DatabaseSync(source, { readOnly: true });
const baseline = Object.fromEntries(
  [
    "agents",
    "business_goals",
    "goal_milestones",
    "goal_strategies",
    "business_contacts",
    "business_drafts",
    "business_mailboxes",
    "business_profiles",
    "business_quotes",
    "business_social_accounts",
    "business_tickets",
    "deals",
    "ledger_entries",
    "listing_packages",
    "etsy_connection",
    "etsy_shop_changes",
    "etsy_shop_listings",
    "square_connection",
    "square_location_mappings",
    "square_receipts",
  ].map((name) => [name, count(before, name)]),
);
before.exec(`VACUUM INTO '${output.replaceAll("\\", "/").replaceAll("'", "''")}'`);
before.close();

const db = new DatabaseSync(output);
db.exec("PRAGMA foreign_keys=ON");
function migrate() {
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  archiveLegacyWork(db);
  dropRetiredWorkTables(db);
  ensureReviewSchema(db);
  ensureModelRoutingSchema(db);
  ensureControlStateSchema(db);
  ensureAutonomyEngineSchema(db);
  requestFreshResearchOnce(db);
}

try {
  migrate();
  const first = {
    goals: count(db, "business_goals"),
    initiatives: count(db, "initiatives"),
    archivedTasks: count(db, "archive_20261122_tasks"),
    archivedIdeas: count(db, "archive_20261122_opportunities"),
    archivedProposals: count(db, "archive_20261122_agent_task_proposals"),
  };
  migrate();
  const second = {
    goals: count(db, "business_goals"),
    initiatives: count(db, "initiatives"),
    archivedTasks: count(db, "archive_20261122_tasks"),
    archivedIdeas: count(db, "archive_20261122_opportunities"),
    archivedProposals: count(db, "archive_20261122_agent_task_proposals"),
  };
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("second migration changed work row counts");
  for (const [name, expected] of Object.entries(baseline)) {
    if (count(db, name) !== expected) throw new Error(`${name} count changed during migration`);
  }
  const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (integrity !== "ok" || foreignKeys.length)
    throw new Error(`database check failed: ${integrity}, ${foreignKeys.length} FK errors`);
  const emptyGoalTitles = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM business_goals WHERE TRIM(title)=''").get() as { n: number }).n,
  );
  if (emptyGoalTitles) throw new Error(`${emptyGoalTitles} goal titles are empty`);
  const freshResearch = Number(
    (
      db.prepare("SELECT COUNT(*) AS n FROM goal_strategies WHERE owner_note LIKE 'Fresh research%'").get() as {
        n: number;
      }
    ).n,
  );
  console.log(
    JSON.stringify({ output, integrity, foreignKeyErrors: 0, baseline, migrated: first, freshResearch }, null, 2),
  );
} finally {
  db.close();
}
