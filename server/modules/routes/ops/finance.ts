import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireOwnerSession, shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";
import {
  createDeal,
  createManualLedgerEntry,
  createSpendRequest,
  decideSpendRequest,
  ensureFinanceSchema,
  financeOverview,
  linkLedgerEntry,
  updateDeal,
} from "../../finance-store.ts";

export function registerFinanceRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
): void {
  ensureFinanceSchema(db);
  app.get("/api/finance", (req, res) => {
    const filter: { business?: string; from?: number; to?: number } = {};
    for (const field of ["business", "from", "to"] as const) {
      const value = req.query[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value.trim()) return res.status(400).json({ error: `invalid_${field}` });
      if (field === "business") filter.business = value;
      else filter[field] = Number(value);
    }
    try {
      res.json({ ok: true, ...financeOverview(db, filter) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "finance_read_failed" });
    }
  });
  const mutation = (
    path: string,
    method: "post" | "patch",
    work: (id: string, body: Record<string, unknown>) => unknown,
    key: string,
  ) => {
    app[method](path, (req, res) => {
      if (!requireOwnerSession(req, res)) return;
      if (shouldRequireCsrf(req) && !hasValidCsrfToken(req))
        return res.status(403).json({ error: "csrf_token_required" });
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        return res.status(400).json({ error: "invalid_payload" });
      try {
        const item = work(String((req.params as Record<string, string>).id ?? ""), req.body);
        broadcast("finance_changed", { resource: key });
        res.status(method === "post" && !path.endsWith("/decide") ? 201 : 200).json({ ok: true, item, [key]: item });
      } catch (error) {
        const message = error instanceof Error ? error.message : "finance_mutation_failed";
        res
          .status(message.endsWith("_not_found") ? 404 : message.endsWith("already_decided") ? 409 : 400)
          .json({ error: message });
      }
    });
  };
  mutation("/api/finance/deals", "post", (_id, body) => createDeal(db, body), "deal");
  mutation("/api/finance/deals/:id", "patch", (id, body) => updateDeal(db, id, body), "deal");
  mutation("/api/finance/ledger", "post", (_id, body) => createManualLedgerEntry(db, body), "entry");
  mutation("/api/finance/ledger/:id/link", "patch", (id, body) => linkLedgerEntry(db, id, body), "entry");
  mutation("/api/finance/spend-requests", "post", (_id, body) => createSpendRequest(db, body), "request");
  mutation(
    "/api/finance/spend-requests/:id/decide",
    "post",
    (id, body) => {
      if (Object.keys(body).some((key) => key !== "approve") || typeof body.approve !== "boolean")
        throw new Error("approve_boolean_required");
      return decideSpendRequest(db, id, body.approve, "owner");
    },
    "request",
  );
}
