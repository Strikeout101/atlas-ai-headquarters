import { randomUUID } from "node:crypto";
import type { Lang } from "../../../types/lang.ts";
import { resolveConstrainedAgentScopeForTask } from "../../routes/core/tasks/execution-run-auto-assign.ts";

type SubtaskSeedingDeps = {
  db: any;
  nowMs: () => number;
  broadcast: (event: string, payload: unknown) => void;
  analyzeSubtaskDepartment: (title: string, parentDeptId: string | null) => string | null;
  rerouteSubtasksByPlanningLeader: (
    taskId: string,
    ownerDeptId: string | null,
    phase: "planned" | "review",
  ) => Promise<void>;
  findTeamLeader: (departmentId: string, candidateAgentIds?: string[] | null) => any;
  getDeptName: (departmentId: string) => string;
  getPreferredLanguage: () => Lang;
  resolveLang: (text: string) => Lang;
  l: (en: string[]) => any;
  pickL: (choices: any, lang: string) => string;
  appendTaskLog: (taskId: string | null, kind: string, message: string) => void;
  notifyCeo: (message: string, taskId: string | null, messageType?: string) => void;
};

export function createSubtaskSeedingTools(deps: SubtaskSeedingDeps) {
  const {
    db,
    nowMs,
    broadcast,
    analyzeSubtaskDepartment,
    rerouteSubtasksByPlanningLeader,
    findTeamLeader,
    getDeptName,
    getPreferredLanguage,
    resolveLang,
    l,
    pickL,
    appendTaskLog,
    notifyCeo,
  } = deps;

  function createSubtaskFromCli(taskId: string, toolUseId: string, title: string): void {
    const subId = randomUUID();
    const parentAgent = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
      | { assigned_agent_id: string | null }
      | undefined;

    db.prepare(
      `
    INSERT INTO subtasks (id, task_id, title, status, assigned_agent_id, cli_tool_use_id, created_at)
    VALUES (?, ?, ?, 'in_progress', ?, ?, ?)
  `,
    ).run(subId, taskId, title, parentAgent?.assigned_agent_id ?? null, toolUseId, nowMs());

    // Detect if this subtask belongs to a foreign department
    const parentTaskDept = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(taskId) as
      | { department_id: string | null }
      | undefined;
    const targetDeptId = analyzeSubtaskDepartment(title, parentTaskDept?.department_id ?? null);

    if (targetDeptId) {
      const targetDeptName = getDeptName(targetDeptId);
      const lang = getPreferredLanguage();
      const blockedReason = pickL(l([`Waiting for ${targetDeptName} collaboration`]), lang);
      db.prepare(
        "UPDATE subtasks SET target_department_id = ?, status = 'blocked', blocked_reason = ? WHERE id = ?",
      ).run(targetDeptId, blockedReason, subId);
    }

    const subtask = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subId);
    broadcast("subtask_update", subtask);
  }

  function completeSubtaskFromCli(toolUseId: string): void {
    const existing = db.prepare("SELECT id, status FROM subtasks WHERE cli_tool_use_id = ?").get(toolUseId) as
      | { id: string; status: string }
      | undefined;
    if (!existing || existing.status === "done") return;

    db.prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(nowMs(), existing.id);

    const subtask = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(existing.id);
    broadcast("subtask_update", subtask);
  }

  function seedApprovedPlanSubtasks(taskId: string, ownerDeptId: string | null, planningNotes: string[] = []): void {
    const existing = db.prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ?").get(taskId) as {
      cnt: number;
    };
    if (existing.cnt > 0) return;

    const task = db
      .prepare("SELECT title, description, assigned_agent_id, department_id, project_id FROM tasks WHERE id = ?")
      .get(taskId) as
      | {
          title: string;
          description: string | null;
          assigned_agent_id: string | null;
          department_id: string | null;
          project_id: string | null;
        }
      | undefined;
    if (!task) return;

    const baseDeptId = ownerDeptId ?? task.department_id;
    const lang = resolveLang(task.description ?? task.title);
    const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
      project_id: task.project_id,
      department_id: baseDeptId,
    });

    const now = nowMs();
    const baseAssignee = task.assigned_agent_id;
    const uniquePlanNotes: string[] = [];
    const planSeen = new Set<string>();
    for (const note of planningNotes) {
      const normalized = note.replace(/\s+/g, " ").trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (planSeen.has(key)) continue;
      planSeen.add(key);
      uniquePlanNotes.push(normalized);
      if (uniquePlanNotes.length >= 8) break;
    }

    const items: Array<{
      title: string;
      description: string;
      status: "pending" | "blocked";
      assignedAgentId: string | null;
      blockedReason: string | null;
      targetDepartmentId: string | null;
    }> = [
      {
        title: pickL(l(["Finalize detailed execution plan from planned meeting"]), lang),
        description: pickL(
          l([`Finalize detailed task sequence and deliverable criteria from the planned meeting. (${task.title})`]),
          lang,
        ),
        status: "pending",
        assignedAgentId: baseAssignee,
        blockedReason: null,
        targetDepartmentId: null,
      },
    ];
    const noteDetectedDeptSet = new Set<string>();

    for (const note of uniquePlanNotes) {
      const detail = note.replace(/^[\s\-*0-9.)]+/, "").trim();
      if (!detail) continue;
      const afterColon = detail.includes(":") ? detail.split(":").slice(1).join(":").trim() : detail;
      const titleCore = (afterColon || detail).slice(0, 56).trim();
      const clippedTitle = titleCore.length > 54 ? `${titleCore.slice(0, 53).trimEnd()}…` : titleCore;
      const targetDeptId = analyzeSubtaskDepartment(detail, baseDeptId);
      const targetDeptName = targetDeptId ? getDeptName(targetDeptId) : "";
      const targetLeader = targetDeptId ? findTeamLeader(targetDeptId, constrainedAgentIds) : null;
      if (targetDeptId && targetDeptId !== baseDeptId) {
        noteDetectedDeptSet.add(targetDeptId);
      }

      items.push({
        title: pickL(l([`[Plan Item] ${clippedTitle || "Additional improvement item"}`]), lang),
        description: pickL(
          l([`Convert this planned-meeting improvement note into an executable task: ${detail}`]),
          lang,
        ),
        status: targetDeptId ? "blocked" : "pending",
        assignedAgentId: targetDeptId ? (targetLeader?.id ?? null) : baseAssignee,
        blockedReason: targetDeptId ? pickL(l([`Waiting for ${targetDeptName} collaboration`]), lang) : null,
        targetDepartmentId: targetDeptId,
      });
    }

    const relatedDepts = [...noteDetectedDeptSet];
    for (const deptId of relatedDepts) {
      const deptName = getDeptName(deptId);
      const crossLeader = findTeamLeader(deptId, constrainedAgentIds);
      items.push({
        title: pickL(l([`[Collaboration] Produce ${deptName} deliverable`]), lang),
        description: pickL(
          l([`Create and share the ${deptName}-owned deliverable based on the planned meeting.`]),
          lang,
        ),
        status: "blocked",
        assignedAgentId: crossLeader?.id ?? null,
        blockedReason: pickL(l([`Waiting for ${deptName} collaboration`]), lang),
        targetDepartmentId: deptId,
      });
    }

    items.push({
      title: pickL(l(["Consolidate department deliverables and finalize package"]), lang),
      description: pickL(
        l(["Collect related-department outputs, merge into one package, and prepare the review submission."]),
        lang,
      ),
      status: "pending",
      assignedAgentId: baseAssignee,
      blockedReason: null,
      targetDepartmentId: null,
    });

    for (const st of items) {
      const sid = randomUUID();
      db.prepare(
        `
      INSERT INTO subtasks (id, task_id, title, description, status, assigned_agent_id, blocked_reason, target_department_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      ).run(
        sid,
        taskId,
        st.title,
        st.description,
        st.status,
        st.assignedAgentId,
        st.blockedReason,
        st.targetDepartmentId,
        now,
      );
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sid));
    }

    appendTaskLog(
      taskId,
      "system",
      `Planned meeting seeded ${items.length} subtasks (plan-notes: ${uniquePlanNotes.length}, cross-dept: ${relatedDepts.length})`,
    );
    notifyCeo(
      pickL(
        l([
          `Created ${items.length} subtasks from the planned-meeting output for '${task.title}' and assigned owners/cross-department collaboration.`,
        ]),
        lang,
      ),
      taskId,
    );

    void rerouteSubtasksByPlanningLeader(taskId, baseDeptId, "planned");
  }

  return {
    createSubtaskFromCli,
    completeSubtaskFromCli,
    seedApprovedPlanSubtasks,
  };
}
