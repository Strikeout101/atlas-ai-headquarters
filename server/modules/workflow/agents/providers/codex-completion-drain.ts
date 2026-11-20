import type { ChildProcess } from "node:child_process";

/**
 * Node's `close` waits for every inherited stdio handle, even after the process exits.
 * Release our readers only after Codex's terminal stdout event AND successful OS exit.
 * Register after ordinary output listeners so callers first persist the terminal output.
 */
export function createCodexCompletionDrain(child: ChildProcess, onTerminal?: () => void): () => void {
  let disposed = false;
  let exited = false;
  let exitCode: number | null = null;
  let terminal = false;
  let buffer = "";
  const detach = () => {
    disposed = true;
    child.stdout?.off("data", onData);
    child.off("exit", onExit);
  };
  const drain = () => {
    // A valid final JSON event need not include a trailing newline. Only consider
    // that buffered tail after OS exit; incomplete chunks are never completion.
    if (exited && !terminal && buffer) {
      try {
        terminal = JSON.parse(buffer)?.type === "turn.completed";
      } catch {
        // A later stdout chunk may finish the event.
      }
    }
    if (disposed || !exited || exitCode !== 0 || !terminal) return;
    detach();
    onTerminal?.();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const onData = (chunk: Buffer) => {
    if (disposed) return;
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        if (JSON.parse(line)?.type === "turn.completed") terminal = true;
      } catch {
        // A string containing the marker, an incomplete event or stderr is not evidence.
      }
    }
    if (buffer.length > 512_000) buffer = "";
    drain();
  };
  const onExit = (code: number | null) => {
    exited = true;
    exitCode = code;
    drain();
  };
  child.stdout?.on("data", onData);
  child.on("exit", onExit);
  return detach;
}
