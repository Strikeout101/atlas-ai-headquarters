import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_WORKER_SYSTEM,
  localWorkerAgentConfig,
  readLocalWorkerProjectInstructions,
} from "./local-worker-config.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) {
    if (!path.isAbsolute(dir) || !path.basename(dir).startsWith("atlas-local-rules-"))
      throw new Error("Invalid test cleanup path");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-local-rules-"));
  directories.push(dir);
  return dir;
}

describe("local worker project rules", () => {
  it("preserves the complete target AGENTS and never pulls in unrelated parent instructions", () => {
    const parent = fixture();
    const dir = path.join(parent, "task");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(parent, "AGENTS.md"), "Unrelated orchestration outside task");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Full project rules\nRespect every requirement.");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "Fallback not applicable");
    expect(readLocalWorkerProjectInstructions(dir)).toBe("[AGENTS.md]\nFull project rules\nRespect every requirement.");
  });
  it("uses CLAUDE only when the target AGENTS is absent", () => {
    const dir = fixture();
    expect(readLocalWorkerProjectInstructions(dir)).toBe("");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "Applicable fallback rules");
    expect(readLocalWorkerProjectInstructions(dir)).toContain("Applicable fallback rules");
  });
  it("refuses oversized or unreadable rules instead of truncating or ignoring them", () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "x".repeat(65537));
    expect(() => readLocalWorkerProjectInstructions(dir)).toThrow("local_worker_project_instructions_unavailable");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Read must fail closed");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("Access denied");
    });
    expect(() => readLocalWorkerProjectInstructions(dir)).toThrow("local_worker_project_instructions_unavailable");
  });
  it("refuses an instruction link outside the worktree before reading its contents", () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Target metadata only");
    vi.spyOn(fs, "realpathSync")
      .mockReturnValueOnce(dir)
      .mockReturnValueOnce(path.resolve(dir, "..", "outside-secret"));
    const read = vi.spyOn(fs, "readFileSync");
    expect(() => readLocalWorkerProjectInstructions(dir)).toThrow("local_worker_project_instructions_unavailable");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("compact native local worker", () => {
  it("bounds actual native context/output and reduces tools without weakening worktree/approval rules", () => {
    const config = localWorkerAgentConfig(4096);
    expect(config.limit).toEqual({ context: 4096, output: 1024 });
    const agent = config.agents["atlas-worker"];
    expect(agent.permissions).toContainEqual({ action: "external_directory", resource: "*", effect: "deny" });
    expect(agent.permissions).toContainEqual({ action: "shell", resource: "git commit *", effect: "deny" });
    expect(agent.permissions).toContainEqual({ action: "shell", resource: "git push *", effect: "deny" });
    expect(LOCAL_WORKER_SYSTEM).toContain("applicable AGENTS.md");
    expect(LOCAL_WORKER_SYSTEM).toContain("never drop instructions");
    expect(LOCAL_WORKER_SYSTEM).toContain("inline Node fetch");
    expect(LOCAL_WORKER_SYSTEM).toContain("never print the token");
    expect(localWorkerAgentConfig(2048).limit.output).toBe(512);
  });
});
