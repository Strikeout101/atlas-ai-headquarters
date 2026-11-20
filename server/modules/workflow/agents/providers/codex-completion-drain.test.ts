import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createCodexCompletionDrain } from "./codex-completion-drain.ts";

function setup() {
  const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const done = vi.fn();
  const dispose = createCodexCompletionDrain(process as unknown as ChildProcess, done);
  return { process, done, dispose };
}

describe("Codex completed process pipe drain", () => {
  it.each(["terminal-first", "exit-first"])("requires both successful OS exit and terminal stdout (%s)", (order) => {
    const { process, done } = setup();
    const event = () => process.stdout.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
    const exit = () => process.emit("exit", 0);
    (order === "terminal-first" ? event : exit)();
    expect(done).not.toHaveBeenCalled();
    expect(process.stdout.destroyed).toBe(false);
    (order === "terminal-first" ? exit : event)();
    expect(done).toHaveBeenCalledOnce();
    expect(process.stdout.destroyed).toBe(true);
    expect(process.stderr.destroyed).toBe(true);
    process.emit("exit", 0);
    expect(done).toHaveBeenCalledOnce();
  });

  it.each([1, null])("does not convert an unsuccessful exit into success (%s)", (code) => {
    const { process, done, dispose } = setup();
    process.stdout.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
    process.emit("exit", code);
    expect(done).not.toHaveBeenCalled();
    expect(process.stdout.destroyed).toBe(false);
    dispose();
  });

  it("ignores marker text in other events, stderr and partial events", () => {
    const { process, done, dispose } = setup();
    process.emit("exit", 0);
    process.stderr.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
    process.stdout.emit("data", Buffer.from('{"type":"item.completed","text":"turn.completed"}\n'));
    process.stdout.emit("data", Buffer.from('{"type":"turn.completed",'));
    expect(done).not.toHaveBeenCalled();
    expect(process.stdout.destroyed).toBe(false);
    dispose();
  });

  it.each([true, false])("parses split final events with or without a newline (newline=%s)", (newline) => {
    const { process, done } = setup();
    process.emit("exit", 0);
    process.stdout.emit("data", Buffer.from('{"type":"turn.com'));
    expect(done).not.toHaveBeenCalled();
    process.stdout.emit("data", Buffer.from(`pleted"}${newline ? "\n" : ""}`));
    expect(done).toHaveBeenCalledOnce();
  });

  it("detaches after timeout/cancellation so late events cannot drain", () => {
    const { process, done, dispose } = setup();
    dispose();
    process.stdout.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
    process.emit("exit", 0);
    expect(done).not.toHaveBeenCalled();
    expect(process.stdout.destroyed).toBe(false);
    expect(process.listenerCount("exit")).toBe(0);
    expect(process.stdout.listenerCount("data")).toBe(0);
  });

  it("lets the normal output consumer persist the terminal data before completion", () => {
    const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    let saved = "";
    process.stdout.on("data", (chunk) => {
      saved += chunk.toString();
    });
    const done = vi.fn(() => expect(saved).toContain('"type":"turn.completed"'));
    createCodexCompletionDrain(process as unknown as ChildProcess, done);
    process.emit("exit", 0);
    process.stdout.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
    expect(done).toHaveBeenCalledOnce();
  });
});
