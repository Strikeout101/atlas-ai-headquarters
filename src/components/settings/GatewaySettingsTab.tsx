import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SettingsSection from "./SettingsSection";
import * as api from "../../api";
import AgentAvatar, { useSpriteMap } from "../AgentAvatar";
import { MESSENGER_CHANNELS, type Agent, type MessengerSessionConfig } from "../../types";
import type { ChannelSettingsTabProps } from "./types";
import ChatEditorModal from "./gateway-settings/ChatEditorModal";
import { CHANNEL_META } from "./gateway-settings/constants";
import {
  type ChatRow,
  createEditorState,
  createSessionId,
  normalizeChannelsConfig,
  resolveChannelsConfig,
} from "./gateway-settings/state";

export default function GatewaySettingsTab({ t, form, setForm, persistSettings }: ChannelSettingsTabProps) {
  const channelsConfig = resolveChannelsConfig(form.messengerChannels);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ ok: boolean; msg: string } | null>(null);

  const [sending, setSending] = useState(false);
  const [sendText, setSendText] = useState("");
  const [sendStatus, setSendStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeSessions, setRuntimeSessions] = useState<Awaited<ReturnType<typeof api.getMessengerRuntimeSessions>>>(
    [],
  );
  const [receiverLoading, setReceiverLoading] = useState(false);
  const [telegramReceiverStatus, setTelegramReceiverStatus] = useState<Awaited<
    ReturnType<typeof api.getTelegramReceiverStatus>
  > | null>(null);
  const [discordReceiverStatus, setDiscordReceiverStatus] = useState<Awaited<
    ReturnType<typeof api.getDiscordReceiverStatus>
  > | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const spriteMap = useSpriteMap(agents);

  const [editor, setEditor] = useState(() => createEditorState(channelsConfig));
  const [editorError, setEditorError] = useState<string | null>(null);
  const [discordChannelsLoading, setDiscordChannelsLoading] = useState(false);
  const [discordChannelOptions, setDiscordChannelOptions] = useState<api.DiscordDiscoverableChannel[]>([]);
  const [discordChannelsError, setDiscordChannelsError] = useState<string | null>(null);
  const discordLookupSeq = useRef(0);

  const chatRows = useMemo<ChatRow[]>(() => {
    return MESSENGER_CHANNELS.flatMap((channel) => {
      const channelConfig = channelsConfig[channel];
      return (channelConfig.sessions ?? [])
        .map((session) => ({
          key: `${channel}:${session.id}`,
          channel,
          token: (session.token ?? "").trim() || (channelConfig.token ?? ""),
          receiveEnabled: channelConfig.receiveEnabled !== false,
          session,
        }))
        .filter((entry) => entry.session.targetId.trim().length > 0);
    });
  }, [channelsConfig]);

  const [selectedChatKey, setSelectedChatKey] = useState<string>("");

  useEffect(() => {
    if (chatRows.length === 0) {
      setSelectedChatKey("");
      return;
    }
    const exists = chatRows.some((row) => row.key === selectedChatKey);
    if (!exists) {
      setSelectedChatKey(chatRows[0].key);
    }
  }, [chatRows, selectedChatKey]);

  const selectedChat = chatRows.find((row) => row.key === selectedChatKey) ?? null;

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const resolveDiscordLookupErrorMessage = useCallback(
    (error: unknown): string => {
      if (api.isApiRequestError(error)) {
        const code = error.code ?? "";
        if (code === "discord_token_required") {
          return t({
            en: "Please enter a Discord token.",
          });
        }
        if (code === "discord_auth_failed") {
          return t({
            en: "Discord authentication failed. Check your bot token and permissions.",
          });
        }
        if (code === "discord_rate_limited") {
          return t({
            en: "Discord API is rate-limited. Please try again shortly.",
          });
        }
        if (code === "discord_channel_lookup_failed") {
          return t({
            en: "Failed to load Discord channels. Check network connectivity and permissions.",
          });
        }
      }
      return t({
        en: "An error occurred while loading Discord channels.",
      });
    },
    [t],
  );

  const persistChannelsForm = (nextChannels: ReturnType<typeof resolveChannelsConfig>, successMsg?: string) => {
    const normalized = normalizeChannelsConfig(nextChannels);
    const nextForm = { ...form, messengerChannels: normalized };
    setForm(nextForm);
    setSaving(true);
    setSaved(null);
    try {
      persistSettings(nextForm);
      setSaved({
        ok: true,
        msg:
          successMsg ??
          t({
            en: "Channel settings saved",
          }),
      });
      setTimeout(() => setSaved(null), 2500);
      return true;
    } catch (error) {
      setSaved({ ok: false, msg: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeChat = (row: ChatRow) => {
    const next = resolveChannelsConfig(form.messengerChannels);
    next[row.channel] = {
      ...next[row.channel],
      sessions: next[row.channel].sessions.filter((session) => session.id !== row.session.id),
    };
    persistChannelsForm(
      next,
      t({
        en: "Chat deleted",
      }),
    );
    setSendStatus(null);
  };

  const openCreateModal = () => {
    setEditor({
      ...createEditorState(channelsConfig),
      open: true,
      mode: "create",
    });
    setEditorError(null);
  };

  const openEditModal = (row: ChatRow) => {
    setEditor({
      open: true,
      mode: "edit",
      ref: { channel: row.channel, sessionId: row.session.id },
      channel: row.channel,
      token: row.session.token?.trim() || (channelsConfig[row.channel].token ?? ""),
      name: row.session.name ?? "",
      targetId: row.session.targetId ?? "",
      enabled: row.session.enabled !== false,
      agentId: row.session.agentId ?? "",
      receiveEnabled: channelsConfig[row.channel].receiveEnabled !== false,
    });
    setEditorError(null);
  };

  const closeEditorModal = () => {
    setEditor((prev) => ({ ...prev, open: false, ref: null }));
    setEditorError(null);
  };

  const handleSaveEditor = () => {
    const token = editor.token.trim();
    const name = editor.name.trim();
    const targetId = editor.targetId.trim();
    const agentId = editor.agentId.trim();

    if (!token) {
      setEditorError(
        t({
          en: "Please enter a token.",
        }),
      );
      return;
    }
    if (!name) {
      setEditorError(
        t({
          en: "Please enter a chat name.",
        }),
      );
      return;
    }
    if (!targetId) {
      setEditorError(
        t({
          en: "Please enter a channel/target ID.",
        }),
      );
      return;
    }

    const next = resolveChannelsConfig(form.messengerChannels);

    next[editor.channel] = {
      ...next[editor.channel],
      receiveEnabled: editor.channel === "telegram" ? editor.receiveEnabled : next[editor.channel].receiveEnabled,
    };

    const nextSession: MessengerSessionConfig = {
      id: editor.ref?.sessionId || createSessionId(editor.channel),
      name,
      targetId,
      enabled: editor.enabled,
      token,
      agentId: agentId || undefined,
    };

    let insertIndex: number | null = null;
    if (editor.ref) {
      const sourceChannel = editor.ref.channel;
      const sourceSessions = [...next[sourceChannel].sessions];
      const sourceIndex = sourceSessions.findIndex((session) => session.id === editor.ref?.sessionId);
      if (sourceIndex >= 0) {
        sourceSessions.splice(sourceIndex, 1);
        next[sourceChannel] = { ...next[sourceChannel], sessions: sourceSessions };
        if (sourceChannel === editor.channel) {
          insertIndex = sourceIndex;
        }
      }
    }

    const targetSessions = [...next[editor.channel].sessions];
    if (insertIndex !== null && insertIndex >= 0 && insertIndex <= targetSessions.length) {
      targetSessions.splice(insertIndex, 0, nextSession);
    } else {
      targetSessions.push(nextSession);
    }

    next[editor.channel] = {
      ...next[editor.channel],
      sessions: targetSessions,
    };

    const savedOk = persistChannelsForm(
      next,
      t({
        en: "Chat saved",
      }),
    );
    if (!savedOk) {
      setEditorError(
        t({
          en: "Failed to save chat. Please try again.",
        }),
      );
      return;
    }
    setSelectedChatKey(`${editor.channel}:${nextSession.id}`);
    closeEditorModal();
  };

  const handleSendMessage = async () => {
    if (!selectedChat || !sendText.trim()) {
      return;
    }

    setSending(true);
    setSendStatus(null);
    try {
      const result = await api.sendMessengerRuntimeMessage({
        sessionKey: selectedChat.key,
        text: sendText.trim(),
      });
      if (!result.ok) {
        setSendStatus({ ok: false, msg: result.error || "send_failed" });
        return;
      }
      setSendStatus({
        ok: true,
        msg: t({
          en: "Message sent",
        }),
      });
      setSendText("");
    } catch (error) {
      setSendStatus({ ok: false, msg: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  };

  const loadRuntimeSessions = async () => {
    setRuntimeLoading(true);
    try {
      const sessions = await api.getMessengerRuntimeSessions();
      setRuntimeSessions(sessions);
    } catch {
      setRuntimeSessions([]);
    } finally {
      setRuntimeLoading(false);
    }
  };

  const loadAgents = async () => {
    setAgentsLoading(true);
    try {
      const rows = await api.getAgents();
      setAgents(rows);
    } catch {
      setAgents([]);
    } finally {
      setAgentsLoading(false);
    }
  };

  useEffect(() => {
    void loadAgents();
  }, []);

  useEffect(() => {
    if (!editor.open || editor.channel !== "discord") {
      setDiscordChannelsLoading(false);
      setDiscordChannelsError(null);
      setDiscordChannelOptions([]);
      return;
    }
    const token = editor.token.trim();
    if (!token) {
      setDiscordChannelsLoading(false);
      setDiscordChannelsError(null);
      setDiscordChannelOptions([]);
      return;
    }

    const seq = discordLookupSeq.current + 1;
    discordLookupSeq.current = seq;
    const timer = setTimeout(() => {
      setDiscordChannelsLoading(true);
      setDiscordChannelsError(null);
      void api
        .listDiscordChannelsByToken(token)
        .then((channels) => {
          if (discordLookupSeq.current !== seq) return;
          setDiscordChannelOptions(channels);
        })
        .catch((error) => {
          if (discordLookupSeq.current !== seq) return;
          setDiscordChannelOptions([]);
          setDiscordChannelsError(resolveDiscordLookupErrorMessage(error));
        })
        .finally(() => {
          if (discordLookupSeq.current !== seq) return;
          setDiscordChannelsLoading(false);
        });
    }, 450);

    return () => {
      clearTimeout(timer);
    };
  }, [editor.open, editor.channel, editor.token, resolveDiscordLookupErrorMessage]);

  const loadMessengerReceiverStatus = async () => {
    setReceiverLoading(true);
    try {
      const [telegramStatus, discordStatus] = await Promise.all([
        api.getTelegramReceiverStatus().catch(() => null),
        api.getDiscordReceiverStatus().catch(() => null),
      ]);
      setTelegramReceiverStatus(telegramStatus);
      setDiscordReceiverStatus(discordStatus);
    } catch {
      setTelegramReceiverStatus(null);
      setDiscordReceiverStatus(null);
    } finally {
      setReceiverLoading(false);
    }
  };

  const selectedChatTransportReady = selectedChat ? CHANNEL_META[selectedChat.channel].transportReady : false;

  return (
    <SettingsSection title={t({ en: "Messaging channels" })} defaultOpen>
      <div className="flex items-center justify-between">
        {saved && <span className={`text-xs ${saved.ok ? "text-emerald-400" : "text-red-400"}`}>{saved.msg}</span>}
      </div>

      <p className="text-xs text-slate-400">
        {t({
          en: "You can configure messenger channels directly in this tab. Use 'Add Chat' to register messenger/token/target ID/conversation agent.",
        })}
      </p>

      <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-200">{t({ en: "Chat Sessions" })}</div>
          <button
            onClick={openCreateModal}
            className="text-xs px-3 py-1 rounded-md bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/40"
          >
            + {t({ en: "Add Chat" })}
          </button>
        </div>

        {chatRows.length === 0 ? (
          <div className="text-xs text-slate-500 py-2">
            {t({
              en: "No chats yet. Use 'Add Chat' to register messenger/token/channel.",
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {chatRows.map((row) => {
              const meta = CHANNEL_META[row.channel];
              const assignedAgent = row.session.agentId ? agentById.get(row.session.agentId) : undefined;
              const assignedAgentName = assignedAgent ? assignedAgent.name : row.session.agentId || "";
              const tokenReady = row.token.trim().length > 0;
              return (
                <div key={row.key} className="rounded-md border border-slate-700/70 bg-slate-800/50 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-100">{row.session.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 uppercase">
                          {meta.label}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${meta.transportReady ? "bg-emerald-600/20 text-emerald-300" : "bg-amber-600/20 text-amber-300"}`}
                        >
                          {meta.transportReady ? t({ en: "Native" }) : t({ en: "Compat" })}
                        </span>
                        {!tokenReady && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-600/20 text-red-300">
                            {t({ en: "No token" })}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400 font-mono break-all">{row.session.targetId}</div>
                      <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-1.5">
                        {assignedAgentName ? (
                          <>
                            <span>{t({ en: "Agent" })}:</span>
                            {assignedAgent && (
                              <AgentAvatar agent={assignedAgent} spriteMap={spriteMap} size={14} rounded="xl" />
                            )}
                            <span className="truncate">{assignedAgentName}</span>
                          </>
                        ) : (
                          <span>
                            {t({
                              en: "No agent assigned",
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => openEditModal(row)}
                        className="px-2 py-1 rounded text-[11px] bg-slate-700/70 border border-slate-600 text-slate-200 hover:bg-slate-700"
                      >
                        {t({ en: "Edit" })}
                      </button>
                      <button
                        onClick={() => removeChat(row)}
                        className="px-2 py-1 rounded text-[11px] bg-red-600/20 border border-red-500/30 text-red-300 hover:bg-red-600/30"
                      >
                        {t({ en: "Delete" })}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="text-[11px] text-slate-500">
          {t({
            en: "Messages starting with $ become company directives; normal messages go 1:1 to the selected agent.",
          })}
        </div>
      </div>

      <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-200">{t({ en: "Test Send" })}</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadMessengerReceiverStatus()}
              disabled={receiverLoading}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-60"
            >
              {t({ en: "Receiver" })}
            </button>
            <button
              onClick={() => void loadRuntimeSessions()}
              disabled={runtimeLoading}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-60"
            >
              {t({ en: "Runtime" })}
            </button>
          </div>
        </div>

        {telegramReceiverStatus && (
          <div className="rounded-md border border-slate-700/60 bg-slate-800/60 px-3 py-2 text-xs text-slate-300 space-y-1">
            <div>
              {t({ en: "Telegram Receiver" })}:{" "}
              <span className={telegramReceiverStatus.enabled ? "text-emerald-400" : "text-amber-300"}>
                {telegramReceiverStatus.enabled ? t({ en: "active" }) : t({ en: "inactive" })}
              </span>
            </div>
            <div>
              {t({ en: "Allowed chats" })}: {telegramReceiverStatus.allowedChatCount}
            </div>
            {telegramReceiverStatus.lastError && <div className="text-red-400">{telegramReceiverStatus.lastError}</div>}
          </div>
        )}

        {discordReceiverStatus && (
          <div className="rounded-md border border-slate-700/60 bg-slate-800/60 px-3 py-2 text-xs text-slate-300 space-y-1">
            <div>
              {t({ en: "Discord Receiver" })}:{" "}
              <span className={discordReceiverStatus.enabled ? "text-emerald-400" : "text-amber-300"}>
                {discordReceiverStatus.enabled ? t({ en: "active" }) : t({ en: "inactive" })}
              </span>
            </div>
            <div>
              {t({ en: "Polled channels" })}: {discordReceiverStatus.routeCount}
            </div>
            {discordReceiverStatus.lastError && <div className="text-red-400">{discordReceiverStatus.lastError}</div>}
          </div>
        )}

        <div>
          <label className="block text-xs text-slate-400 mb-1">{t({ en: "Target Session" })}</label>
          {chatRows.length === 0 ? (
            <div className="text-xs text-slate-500 py-1">
              {t({
                en: "No saved session. Add a chat first.",
              })}
            </div>
          ) : (
            <select
              value={selectedChat?.key ?? ""}
              onChange={(e) => setSelectedChatKey(e.target.value)}
              className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
            >
              {chatRows.map((row) => (
                <option key={row.key} value={row.key}>
                  {CHANNEL_META[row.channel].label} · {row.session.name} ({row.session.targetId})
                </option>
              ))}
            </select>
          )}
        </div>

        <textarea
          value={sendText}
          onChange={(e) => setSendText(e.target.value)}
          rows={3}
          placeholder={t({
            en: "Type a test message...",
          })}
          className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500 resize-y"
        />

        {!selectedChatTransportReady && selectedChat && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300">
            {t({
              en: "This channel can be configured and mapped, but direct transport runtime is not ready yet.",
            })}
          </div>
        )}

        <button
          onClick={() => void handleSendMessage()}
          disabled={sending || !selectedChat || !sendText.trim() || !selectedChatTransportReady}
          className="px-4 py-2 rounded-lg ax-btn-primary text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sending ? t({ en: "Sending..." }) : t({ en: "Send" })}
        </button>

        {sendStatus && (
          <div
            className={`text-xs px-3 py-2 rounded-lg ${
              sendStatus.ok
                ? "bg-green-500/10 text-green-400 border border-green-500/20"
                : "bg-red-500/10 text-red-400 border border-red-500/20"
            }`}
          >
            {sendStatus.msg}
          </div>
        )}

        {runtimeSessions.length > 0 && (
          <div className="pt-1">
            <div className="text-xs text-slate-400 mb-1">{t({ en: "Runtime Sessions" })}</div>
            <div className="max-h-44 overflow-auto rounded-md border border-slate-700/60">
              {runtimeSessions.map((session) => (
                <div
                  key={session.sessionKey}
                  className="px-2.5 py-2 text-[11px] border-b last:border-b-0 border-slate-700/60 text-slate-300"
                >
                  <span className="font-semibold">{session.channel}</span> · {session.displayName} · {session.targetId}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {editor.open && (
        <ChatEditorModal
          t={t}
          editor={editor}
          setEditor={setEditor}
          closeEditorModal={closeEditorModal}
          handleSaveEditor={handleSaveEditor}
          channelsConfig={channelsConfig}
          agents={agents}
          agentsLoading={agentsLoading}
          editorError={editorError}
          discordChannels={discordChannelOptions}
          discordChannelsLoading={discordChannelsLoading}
          discordChannelsError={discordChannelsError}
        />
      )}
    </SettingsSection>
  );
}
