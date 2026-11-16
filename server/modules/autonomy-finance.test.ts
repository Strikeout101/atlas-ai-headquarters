import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureBusinessSchema } from "./routes/ops/business.ts";
import { autonomyOverview, ensureAutonomySchema } from "./autonomy-store.ts";
import { ensureFinanceSchema } from "./finance-store.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  ensureBusinessSchema(db);
  ensureAutonomySchema(db);
  ensureFinanceSchema(db);
  db.exec(`INSERT INTO projects(id,name,project_path,core_goal) VALUES('p','Project','C:/Projects/ventures','Evidence');
    INSERT INTO business_goals(id,business,project_id,metric,target,currency,period_start,period_end,created_at,updated_at)
    VALUES('usd','ventures','p','verified_revenue',50,'USD',100,200,100,100),
    ('jpy','ventures','p','revenue',200,'JPY',100,200,100,100),('profit','ventures','p','profit',20,'USD',100,200,100,100);
    INSERT INTO ledger_entries(id,business,kind,amount_minor,currency,source,external_id,verified,description,occurred_at,created_at,updated_at)
    VALUES('receipt','ventures','revenue',3500,'USD','square_payment','production:receipt',1,'Test provider evidence',150,150,150),
    ('yen','ventures','revenue',125,'JPY','square_payment','production:yen',1,'Test provider evidence',150,150,150),
    ('unverified','ventures','revenue',80000,'USD','manual',NULL,0,'Owner estimate',150,150,150),
    ('old','ventures','revenue',2000,'USD','square_payment','production:old',1,'Older receipt',99,99,99);`);
  return db;
}
describe("financial evidence in autonomous goals", () => {
  it("uses only verified receipts in the goal's own currency and time window", () => {
    const goals = autonomyOverview(setup()).goals;
    expect(goals.find((g) => g.id === "usd")).toMatchObject({
      progress: 35,
      currency: "USD",
      progress_scope: "business",
      verified_revenue_minor: 3500,
    });
    expect(goals.find((g) => g.id === "jpy")).toMatchObject({ progress: 125, currency: "JPY" });
  });
  it("does not turn receipt evidence into verified profit or a completed profit goal", () => {
    expect(autonomyOverview(setup()).goals.find((g) => g.id === "profit")).toMatchObject({
      progress: null,
      costs_complete: false,
      profit_verified: false,
    });
  });
});
