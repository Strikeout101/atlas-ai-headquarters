import { execFileSync } from "node:child_process";
import { planCodePush, queueCodePush } from "../../../code-pushes.ts";
import { githubAccountToken, openPullRequest, pushBranchAs, scrubTokenFromOrigin } from "../../../github-accounts.ts";
import type { WorktreeInfo } from "./lifecycle.ts";
import {
  autoCommitWorktreePendingChanges,
  DIFF_SUMMARY_ERROR,
  DIFF_SUMMARY_NONE,
  hasVisibleDiffSummary,
  readWorktreeStatusShort,
} from "./shared.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

type CreateWorktreeMergeToolsDeps = {
  db: DbLike;
  taskWorktrees: Map<string, WorktreeInfo>;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  cleanupWorktree: (projectPath: string, taskId: string) => void;
  resolveLang: (text: string) => string;
  l: (...args: any[]) => any;
  pickL: (...args: any[]) => string;
};

export function createWorktreeMergeTools(deps: CreateWorktreeMergeToolsDeps) {
  const { db, taskWorktrees, appendTaskLog, cleanupWorktree, resolveLang, l, pickL } = deps;

  function mergeWorktree(
    projectPath: string,
    taskId: string,
  ): { success: boolean; message: string; conflicts?: string[] } {
    const info = taskWorktrees.get(taskId);
    if (!info) return { success: false, message: "No worktree found for this task" };
    const taskRow = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as
      | {
          title: string;
          description: string | null;
        }
      | undefined;
    const lang = resolveLang(taskRow?.description ?? taskRow?.title ?? "");

    try {
      const autoCommit = autoCommitWorktreePendingChanges(taskId, info, appendTaskLog);
      if (autoCommit.error) {
        if (autoCommit.errorKind === "restricted_untracked") {
          return {
            success: false,
            message: pickL(
              l([
                `Pre-merge auto-commit was blocked by restricted untracked files (${autoCommit.restrictedUntrackedCount}). Remove/review restricted files and retry.`,
              ]),
              lang,
            ),
          };
        }
        return {
          success: false,
          message: pickL(l([`Failed to auto-commit pending changes before merge: ${autoCommit.error}`]), lang),
        };
      }

      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      try {
        const diffCheck = execFileSync("git", ["diff", `${currentBranch}...${info.branchName}`, "--stat"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 10000,
        })
          .toString()
          .trim();
        if (!diffCheck) {
          return {
            success: true,
            message: pickL(l(["No changes to merge."]), lang),
          };
        }
      } catch {
        /* proceed */
      }

      const mergeMsg = `Merge climpire task ${taskId.slice(0, 8)} (branch ${info.branchName})`;
      execFileSync("git", ["merge", info.branchName, "--no-ff", "-m", mergeMsg], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 30000,
      });

      return {
        success: true,
        message: pickL(l([`Merge completed: ${info.branchName} -> ${currentBranch}`]), lang),
      };
    } catch (err: unknown) {
      try {
        const unmerged = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        const conflicts = unmerged ? unmerged.split("\n").filter(Boolean) : [];

        if (conflicts.length > 0) {
          try {
            execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
          } catch {
            /* ignore */
          }

          return {
            success: false,
            message: pickL(
              l([`Merge conflict: ${conflicts.length} file(s) have conflicts and need manual resolution.`]),
              lang,
            ),
            conflicts,
          };
        }
      } catch {
        /* ignore */
      }

      try {
        execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: pickL(l([`Merge failed: ${msg}`]), lang),
      };
    }
  }

  /**
   * Merges reviewed work into the project's dev branch, then pushes it with the project's own GitHub account (or queues
   * the push for approval, per the business's code_pushes setting). Never uses the PC's own git login.
   */
  function mergeToDevAndCreatePR(
    projectPath: string,
    taskId: string,
    githubRepo: string,
    projectId: string | null = null,
  ): { success: boolean; message: string; conflicts?: string[]; prUrl?: string } {
    const info = taskWorktrees.get(taskId);
    if (!info) return { success: false, message: "No worktree found for this task" };
    const taskRow = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string } | undefined;
    const taskTitle = taskRow?.title ?? taskId.slice(0, 8);

    try {
      const autoCommit = autoCommitWorktreePendingChanges(taskId, info, appendTaskLog);
      if (autoCommit.error) {
        if (autoCommit.errorKind === "restricted_untracked") {
          return {
            success: false,
            message: `Pre-merge auto-commit blocked by restricted untracked files (${autoCommit.restrictedUntrackedCount}). Remove or handle restricted files and retry.`,
          };
        }
        return { success: false, message: `Pre-merge auto-commit failed: ${autoCommit.error}` };
      }

      try {
        const devExists = execFileSync("git", ["branch", "--list", "dev"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        if (!devExists) {
          execFileSync("git", ["branch", "dev", "main"], {
            cwd: projectPath,
            stdio: "pipe",
            timeout: 5000,
          });
          console.log(`[ATLAS] Created dev branch from main for task ${taskId.slice(0, 8)}`);
        }
      } catch {
        try {
          execFileSync("git", ["branch", "dev", "HEAD"], {
            cwd: projectPath,
            stdio: "pipe",
            timeout: 5000,
          });
        } catch {
          /* ignore */
        }
      }

      execFileSync("git", ["checkout", "dev"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      });

      const mergeMsg = `Merge climpire task ${taskId.slice(0, 8)} (branch ${info.branchName})`;
      execFileSync("git", ["merge", info.branchName, "--no-ff", "-m", mergeMsg], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 30000,
      });

      const plan = planCodePush(db as any, projectId);
      let pushNote: string;
      if (plan.action === "skip") {
        pushNote = `not pushed: ${plan.reason}. Add a GitHub account in Settings > Businesses.`;
        appendTaskLog(taskId, "system", `Merged to dev locally; ${pushNote}`);
      } else if (plan.action === "queue") {
        const request = queueCodePush(db as any, {
          project_id: projectId!,
          task_id: taskId,
          business: plan.business,
          github_repo: githubRepo,
          project_path: projectPath,
          branch: "dev",
          account_id: plan.accountId!,
          title: taskTitle,
        });
        pushNote = `push waits for approval (${plan.reason}); request ${request.id.slice(0, 8)}`;
        appendTaskLog(taskId, "system", `Merged to dev locally; ${pushNote}.`);
      } else {
        // Push now (synchronously, so a failure is reported); the pull request is opened in the background.
        const token = githubAccountToken(db as any, plan.accountId!);
        if (!token) throw new Error("GitHub token for this project could not be read");
        scrubTokenFromOrigin(projectPath, githubRepo);
        pushBranchAs(projectPath, githubRepo, "dev", token);
        pushNote = `pushed (${plan.reason})`;
        void openPullRequest(githubRepo, token, {
          head: "dev",
          base: "main",
          title: `[ATLAS] ${taskTitle}`.slice(0, 250),
          body: `Reviewed and approved in ATLAS.\n\nTask: ${taskId.slice(0, 8)}`,
        }).then((pr) => {
          if (pr.url) appendTaskLog(taskId, "system", `GitHub PR ${pr.created ? "created" : "updated"}: ${pr.url}`);
          else if (pr.error) appendTaskLog(taskId, "system", `GitHub PR could not be opened (${pr.error})`);
        });
      }

      try {
        execFileSync("git", ["checkout", "main"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        });
      } catch {
        /* best effort */
      }

      return {
        success: true,
        message: `Merged ${info.branchName} → dev; ${pushNote}.`,
      };
    } catch (err: unknown) {
      try {
        const unmerged = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        const conflicts = unmerged ? unmerged.split("\n").filter(Boolean) : [];
        if (conflicts.length > 0) {
          try {
            execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
          } catch {
            /* ignore */
          }
          try {
            execFileSync("git", ["checkout", "main"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
          } catch {
            /* ignore */
          }
          return { success: false, message: `Merge conflict: ${conflicts.length} file(s) have conflicts.`, conflicts };
        }
      } catch {
        /* ignore */
      }

      try {
        execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["checkout", "main"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* ignore */
      }

      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Dev merge failed: ${msg}` };
    }
  }

  function getWorktreeDiffSummary(projectPath: string, taskId: string): string {
    const info = taskWorktrees.get(taskId);
    if (!info) return "";

    try {
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      const stat = execFileSync("git", ["diff", `${currentBranch}...${info.branchName}`, "--stat"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      })
        .toString()
        .trim();

      const worktreePending = readWorktreeStatusShort(info.worktreePath);
      if (stat && worktreePending) return `${stat}\n\n[uncommitted worktree changes]\n${worktreePending}`;
      if (stat) return stat;
      if (worktreePending) return `[uncommitted worktree changes]\n${worktreePending}`;
      return DIFF_SUMMARY_NONE;
    } catch {
      return DIFF_SUMMARY_ERROR;
    }
  }

  function rollbackTaskWorktree(taskId: string, reason: string): boolean {
    const info = taskWorktrees.get(taskId);
    if (!info) return false;

    const diffSummary = getWorktreeDiffSummary(info.projectPath, taskId);
    if (hasVisibleDiffSummary(diffSummary)) {
      appendTaskLog(taskId, "system", `Rollback(${reason}) diff summary:\n${diffSummary}`);
    }

    cleanupWorktree(info.projectPath, taskId);
    appendTaskLog(taskId, "system", `Worktree rollback completed (${reason})`);
    return true;
  }

  return {
    mergeWorktree,
    mergeToDevAndCreatePR,
    rollbackTaskWorktree,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
  };
}
