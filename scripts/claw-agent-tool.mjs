#!/usr/bin/env node
import fs from "node:fs/promises";

const [, , first, second] = process.argv;
if (!first || (first === "--file" && !second)) {
  process.stderr.write("Usage: node claw-agent-tool.mjs '<json operation>' | --file operation.json\n");
  process.exit(2);
}

const url = process.env.CLAW_EMPIRE_TOOL_URL;
const token = process.env.CLAW_EMPIRE_TASK_TOKEN;
if (!url || !token) {
  process.stderr.write("Task-scoped Claw-Empire tools are unavailable in this process.\n");
  process.exit(2);
}

try {
  const raw = first === "--file" ? await fs.readFile(second, "utf8") : first;
  if (Buffer.byteLength(raw, "utf8") > 20_000) throw new Error("Operation exceeds 20 KB");
  const operation = JSON.parse(raw);
  if (!operation || typeof operation !== "object" || Array.isArray(operation))
    throw new Error("Operation must be a JSON object");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-task-token": token },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(75_000),
  });
  const result = await response.json();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
