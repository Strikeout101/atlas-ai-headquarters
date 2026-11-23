import type { DatabaseSync } from "node:sqlite";
import type { DecisionInboxRouteItem } from "./types.ts";

type Row = Record<string, unknown>;

/** Only owner decisions enter this feed. The VPs handle ordinary step failures. */
export function buildWorkDecisionItems(db: DatabaseSync): DecisionInboxRouteItem[] {
  try {
    const goals = db.prepare("SELECT * FROM business_goals").all() as Row[];
    const goalTitle = new Map(goals.map((goal) => [String(goal.id), String(goal.title || goal.metric || "Goal")]));
    const strategies = db
      .prepare(
        `SELECT s.id, s.goal_id, s.version, s.summary, s.created_at, s.task_id
       FROM goal_strategies s WHERE s.status='proposed'
       AND (s.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id=s.task_id AND t.status='done'))
       AND s.rowid=(SELECT MAX(x.rowid) FROM goal_strategies x WHERE x.goal_id=s.goal_id AND x.status='proposed')`,
      )
      .all() as Row[];
    const initiatives = db
      .prepare(
        `SELECT id, goal_id, title, status, escalation, blocked_reason, created_at, updated_at
       FROM initiatives WHERE (status='proposed' AND EXISTS (
         SELECT 1 FROM goal_strategies s WHERE s.goal_id=initiatives.goal_id AND s.status='approved'
       )) OR (status='blocked' AND escalation='owner')`,
      )
      .all() as Row[];
    return [
      ...strategies.map(
        (row): DecisionInboxRouteItem => ({
          id: `strategy:${row.id}`,
          kind: "strategy",
          created_at: Number(row.created_at),
          summary: `${goalTitle.get(String(row.goal_id)) ?? "Goal"}: approve strategy v${Number(row.version ?? 1)}?\n\n${String(row.summary ?? "").slice(0, 8000)}`,
          project_id: null,
          project_name: null,
          project_path: null,
          task_id: row.task_id ? String(row.task_id) : null,
          task_title: null,
          options: [
            { number: 1, action: "strategy_approve", label: "Approve this strategy (recommended)" },
            { number: 2, action: "strategy_redo", label: "Ask for a redo with a note" },
          ],
        }),
      ),
      ...initiatives.map((row): DecisionInboxRouteItem => {
        const blocked = row.status === "blocked";
        return {
          id: `initiative:${row.id}`,
          kind: blocked ? "initiative_blocked" : "initiative_approval",
          created_at: Number(blocked ? row.updated_at : row.created_at),
          summary: blocked
            ? `"${String(row.title)}" is stuck: ${String(row.blocked_reason ?? "The step failed.").slice(0, 500)}`
            : `Build "${String(row.title)}" for ${goalTitle.get(String(row.goal_id)) ?? "this goal"}?`,
          project_id: null,
          project_name: null,
          project_path: null,
          task_id: null,
          task_title: null,
          options: blocked
            ? [
                { number: 1, action: "initiative_retry", label: "Try the step once more (recommended)" },
                { number: 2, action: "initiative_skip", label: "Skip this step" },
                { number: 3, action: "initiative_stop", label: "Stop this initiative" },
              ]
            : [
                { number: 1, action: "initiative_approve", label: "Approve and start building (recommended)" },
                { number: 2, action: "initiative_defer", label: "Leave this idea for later" },
              ],
        };
      }),
    ];
  } catch {
    return []; // An older database can be read before the work migration runs.
  }
}
