import { describe, expect, it } from "vitest";
import { buildMessengerTokenKey } from "./token-hint.ts";
import {
  resolveAgentSessionRoutesFromSettings,
  resolveSessionAgentRouteFromSettings,
  resolveSessionTargetRouteFromSettings,
  resolveSourceChatRoute,
} from "./session-agent-routing.ts";

describe("session-agent-routing", () => {
  it("returns the agentId when a Telegram session targetId matches the chat", () => {
    const route = resolveSessionAgentRouteFromSettings({
      settingsValue: {
        telegram: {
          sessions: [{ id: "tg-ops", name: "Ops", targetId: "7028830484", enabled: true, agentId: "a-1" }],
        },
      },
      source: "telegram",
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "tg-ops",
      sessionName: "Ops",
      targetId: "7028830484",
      agentId: "a-1",
    });
  });

  it("does not map a session without an agentId", () => {
    const route = resolveSessionAgentRouteFromSettings({
      settingsValue: {
        telegram: {
          sessions: [{ id: "tg-ops", name: "Ops", targetId: "7028830484", enabled: true }],
        },
      },
      source: "telegram",
      chat: "7028830484",
    });

    expect(route).toBeNull();
  });

  it("still resolves the session target route without an agentId", () => {
    const route = resolveSessionTargetRouteFromSettings({
      settingsValue: {
        telegram: {
          sessions: [{ id: "tg-ops", name: "Ops", targetId: "7028830484", enabled: true }],
        },
      },
      source: "telegram",
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "tg-ops",
      sessionName: "Ops",
      targetId: "7028830484",
    });
  });

  it("prefers the session whose token matches the source hint for the same chat_id", () => {
    const tokenA = "tg-token-a";
    const tokenB = "tg-token-b";
    const tokenBKey = buildMessengerTokenKey("telegram", tokenB);
    const route = resolveSessionTargetRouteFromSettings({
      settingsValue: {
        telegram: {
          token: tokenA,
          sessions: [
            { id: "tg-a", name: "A", targetId: "7028830484", enabled: true },
            { id: "tg-b", name: "B", targetId: "7028830484", enabled: true, token: tokenB },
          ],
        },
      },
      source: `telegram#${tokenBKey}`,
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "tg-b",
      sessionName: "B",
      targetId: "7028830484",
    });
  });

  it("tells same-chat_id sessions apart by index when session.id is empty", () => {
    const tokenA = "tg-token-a";
    const tokenB = "tg-token-b";
    const tokenBKey = buildMessengerTokenKey("telegram", tokenB);
    const route = resolveSessionTargetRouteFromSettings({
      settingsValue: {
        telegram: {
          token: tokenA,
          sessions: [
            { name: "A", targetId: "7028830484", enabled: true },
            { name: "B", targetId: "7028830484", enabled: true, token: tokenB },
          ],
        },
      },
      source: `telegram#${tokenBKey}`,
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "telegram-2",
      sessionName: "B",
      targetId: "7028830484",
    });
  });

  it("does not map disabled sessions", () => {
    const route = resolveSessionAgentRouteFromSettings({
      settingsValue: {
        discord: {
          sessions: [
            { id: "dc-1", name: "Discord", targetId: "channel:1469158639695695904", enabled: false, agentId: "a-2" },
          ],
        },
      },
      source: "discord",
      chat: "channel:1469158639695695904",
    });

    expect(route).toBeNull();
  });

  it("looks up the active sessions mapped to an agentId, per channel", () => {
    const routes = resolveAgentSessionRoutesFromSettings({
      settingsValue: {
        telegram: {
          sessions: [
            { id: "tg-1", name: "TG Ops", targetId: "7028830484", enabled: true, agentId: "a-1" },
            { id: "tg-2", name: "TG Off", targetId: "7028830485", enabled: false, agentId: "a-1" },
          ],
        },
        discord: {
          sessions: [
            { id: "dc-1", name: "DC Ops", targetId: "channel:1469158639695695904", enabled: true, agentId: "a-1" },
          ],
        },
        slack: {
          sessions: [{ id: "sl-1", name: "SL Ops", targetId: "channel:C12345", enabled: true, agentId: "a-2" }],
        },
      },
      agentId: "a-1",
    });

    expect(routes).toEqual([
      {
        channel: "telegram",
        sessionId: "tg-1",
        sessionName: "TG Ops",
        targetId: "7028830484",
      },
      {
        channel: "discord",
        sessionId: "dc-1",
        sessionName: "DC Ops",
        targetId: "1469158639695695904",
      },
    ]);
  });

  it("resolves the default route from source and chat alone", () => {
    expect(resolveSourceChatRoute({ source: "google_chat", chat: "space:spaces/AAAABBBB" })).toEqual({
      channel: "googlechat",
      targetId: "spaces/AAAABBBB",
    });
    expect(resolveSourceChatRoute({ source: "telegram", chat: "telegram:7028830484" })).toEqual({
      channel: "telegram",
      targetId: "7028830484",
    });
  });
});
