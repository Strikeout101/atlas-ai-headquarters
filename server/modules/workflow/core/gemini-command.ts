import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type GeminiCommand = "agy" | "gemini";

export function cliPath(): string {
  const extra =
    process.platform === "win32"
      ? [
        path.join(process.env.LOCALAPPDATA || "", "agy", "bin"),
          path.join(os.homedir(), ".local", "bin"),
          path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"),
          path.join(process.env.APPDATA || "", "npm"),
        ]
      : [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return [...new Set([...(process.env.PATH || "").split(path.delimiter), ...extra].filter(Boolean))].join(
    path.delimiter,
  );
}

export function resolveGeminiCommand(): GeminiCommand | null {
  const which = process.platform === "win32" ? "where.exe" : "which";
  for (const command of ["agy", "gemini"] as const) {
    try {
      if (
        execFileSync(which, [command], {
          encoding: "utf8",
          timeout: 3000,
          env: { ...process.env, PATH: cliPath() },
          stdio: "pipe",
        }).trim()
      )
        return command;
    } catch {
      // Try the next installed CLI.
    }
  }
  return null;
}
