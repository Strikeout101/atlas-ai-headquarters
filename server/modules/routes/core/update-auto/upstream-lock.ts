/**
 * ATLAS is a fork of claw-empire. The inherited updater pulls upstream releases, which would overwrite this fork, so it
 * is locked unless ATLAS_ALLOW_UPSTREAM_UPDATE=1 is set. ATLAS updates come from Settings > General > Service, which
 * deploys this repository's own latest commit.
 */
export const UPSTREAM_UPDATE_LOCK_ERROR = "upstream_updates_disabled_in_atlas";
export const UPSTREAM_UPDATE_LOCK_MESSAGE =
  "Upstream updates are disabled in ATLAS. Updates come from Settings > General > Service (this repository's latest commit).";

export function upstreamUpdatesLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.ATLAS_ALLOW_UPSTREAM_UPDATE ?? "").trim() !== "1";
}
