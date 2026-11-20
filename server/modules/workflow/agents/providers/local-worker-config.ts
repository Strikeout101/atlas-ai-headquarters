import fs from "node:fs";
import path from "node:path";

/** The task's project rules are mandatory; unrelated parent-repository orchestration is not worker context. */
export function readLocalWorkerProjectInstructions(projectPath: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = path.join(projectPath, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("local_worker_project_instructions_unavailable");
      const root = fs.realpathSync(projectPath);
      const relative = path.relative(root, fs.realpathSync(file));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("local_worker_project_instructions_unavailable");
      }
      return `[${name}]\n${fs.readFileSync(file, "utf8")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("local_worker_project_instructions_unavailable");
    }
  }
  return "";
}

export const LOCAL_WORKER_SYSTEM = [
  "Complete the assigned internal task using the shell tool in the current isolated worktree.",
  "The task includes mandatory project, department and business rules. Follow them.",
  "Before editing a nested folder, read and follow its applicable AGENTS.md (CLAUDE.md only if AGENTS.md is absent).",
  "If the requirements or tool results cannot fit your context, stop and request model.request_upgrade through the task gateway; never drop instructions.",
  "Use the task gateway for web research, business records, approvals, customer sends, SSH and spending; never call those services directly.",
  "Call it with inline Node fetch to process.env.CLAW_EMPIRE_TOOL_URL, JSON body, and x-agent-task-token from process.env.CLAW_EMPIRE_TASK_TOKEN; never print the token or access an external gateway script.",
  "Stay inside this worktree. Never read mailbox/provider credentials, commit, push, publish, send messages, move money, or treat pending approval as completed work. Use the task token only from the environment for its gateway.",
  "Use shell commands for files and relevant verification. Keep tool output and the final reply short.",
].join(" ");

export function localWorkerAgentConfig(contextWindowTokens: number) {
  return {
    default_agent: "atlas-worker",
    agents: {
      "atlas-worker": {
        mode: "primary",
        system: LOCAL_WORKER_SYSTEM,
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "allow" },
          { action: "shell", resource: "git commit *", effect: "deny" },
          { action: "shell", resource: "git push *", effect: "deny" },
          { action: "external_directory", resource: "*", effect: "deny" },
        ],
      },
    },
    limit: { context: contextWindowTokens, output: Math.min(2048, Math.floor(contextWindowTokens / 4)) },
  };
}
