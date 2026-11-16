import { request, type FullConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

export default async function verifyIsolatedRuntime(config: FullConfig): Promise<void> {
  const expected = readFileSync(path.resolve(".tmp/e2e-runtime/runtime-id.txt"), "utf8").trim();
  const client = await request.newContext({ baseURL: config.projects[0].use.baseURL });
  try {
    const session = await client.get("/api/auth/session");
    if (!session.ok()) throw new Error("E2E safety check: isolated API sign-in failed.");
    const response = await client.get("/api/settings");
    const payload = response.ok() ? await response.json() : null;
    if (!expected || payload?.settings?.__e2eRuntimeId !== expected) {
      throw new Error(
        "E2E safety check: frontend is not connected to this run's disposable database. Refusing to run browser tests.",
      );
    }
  } finally {
    await client.dispose();
  }
}
