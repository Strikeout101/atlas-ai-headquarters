import { spawn, execFile } from "node:child_process";

export type CodexCliModel = {
  slug: string;
  displayName?: string;
  description?: string;
  reasoningLevels?: Array<{ effort: string; description: string }>;
  defaultReasoningLevel?: string;
};

export function parseCodexModelList(value: unknown): CodexCliModel[] {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return [];
  return value.data.flatMap((item: Record<string, unknown>) => {
    if (!item || typeof item !== "object" || item.hidden === true || typeof item.model !== "string" || !item.model)
      return [];
    const levels = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [];
    return [
      {
        slug: item.model,
        displayName: typeof item.displayName === "string" ? item.displayName : item.model,
        description: typeof item.description === "string" ? item.description : undefined,
        reasoningLevels: levels
          .filter(
            (level): level is { reasoningEffort: string; description: string } =>
              Boolean(level) && typeof level === "object" && typeof level.reasoningEffort === "string",
          )
          .map((level: unknown) => {
            const entry = level as { reasoningEffort: string; description?: string };
            return {
              effort: entry.reasoningEffort,
              description: typeof entry.description === "string" ? entry.description : "",
            };
          }),
        defaultReasoningLevel:
          typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : undefined,
      },
    ];
  });
}

/** Query the installed CLI using its own signed-in identity, without starting a thread or inference run. */
export function discoverCodexCliModels(timeoutMs = 10_000): Promise<CodexCliModel[]> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let done = false;
    let buffer = "";
    const finish = (models: CodexCliModel[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else child.kill();
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));
    child.stdin?.on("error", () => finish([]));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 2_000_000) return finish([]);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) return finish([]);
            child.stdin?.write(`${JSON.stringify({ method: "initialized" })}\n`);
            child.stdin?.write(
              `${JSON.stringify({ id: 2, method: "model/list", params: { includeHidden: false } })}\n`,
            );
          }
          if (message.id === 2) finish(parseCodexModelList(message.result));
        } catch {
          /* Ignore diagnostic lines; only the model/list result is consumed. */
        }
      }
    });
    child.stdin?.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "claw_empire", title: "Claw Empire", version: "2.0.4" },
          capabilities: { experimentalApi: false },
        },
      })}\n`,
    );
  });
}
