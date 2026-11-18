import { ListChecks, Megaphone, FileBarChart } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import type { Agent } from "../../types";
import ChatModeHint from "./ChatModeHint";

type ChatMode = "chat" | "task" | "announcement" | "report";
type Tr = (en: string) => string;

interface ChatComposerProps {
  mode: ChatMode;
  input: string;
  selectedAgent: Agent | null;
  isDirectiveMode: boolean;
  isAnnouncementMode: boolean;
  tr: Tr;
  getAgentName: (agent: Agent | null | undefined) => string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onModeChange: (mode: ChatMode) => void;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export default function ChatComposer({
  mode,
  input,
  selectedAgent,
  isDirectiveMode,
  isAnnouncementMode,
  tr,
  getAgentName,
  textareaRef,
  onModeChange,
  onInputChange,
  onSend,
  onKeyDown,
}: ChatComposerProps) {
  return (
    <>
      <div className="flex flex-shrink-0 gap-2 border-t border-gray-700/50 px-4 pb-1 pt-3">
        <button
          onClick={() => onModeChange(mode === "task" ? "chat" : "task")}
          disabled={!selectedAgent}
          className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
            mode === "task"
              ? "bg-blue-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
          }`}
        >
          <ListChecks size={14} strokeWidth={1.75} />
          <span>{tr("Task")}</span>
        </button>

        <button
          onClick={() => onModeChange(mode === "announcement" ? "chat" : "announcement")}
          className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
            mode === "announcement" ? "bg-yellow-500 text-gray-900" : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
        >
          <Megaphone size={14} strokeWidth={1.75} />
          <span>{tr("Announcement")}</span>
        </button>

        <button
          onClick={() => onModeChange(mode === "report" ? "chat" : "report")}
          disabled={!selectedAgent}
          className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
            mode === "report"
              ? "bg-emerald-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
          }`}
        >
          <FileBarChart size={14} strokeWidth={1.75} />
          <span>{tr("Report")}</span>
        </button>
      </div>

      <ChatModeHint mode={mode} isDirectiveMode={isDirectiveMode} tr={tr} />

      <div className="flex-shrink-0 px-4 pb-4 pt-2">
        <div
          className={`flex items-end gap-2 rounded-2xl border bg-gray-800 transition-colors ${
            isDirectiveMode
              ? "border-red-500/50 focus-within:border-red-400"
              : isAnnouncementMode
                ? "border-yellow-500/50 focus-within:border-yellow-400"
                : mode === "task"
                  ? "border-blue-500/50 focus-within:border-blue-400"
                  : mode === "report"
                    ? "border-emerald-500/50 focus-within:border-emerald-400"
                    : "border-gray-600 focus-within:border-blue-500"
          }`}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isAnnouncementMode
                ? tr("Write an announcement...")
                : mode === "task"
                  ? tr("Write a task instruction...")
                  : mode === "report"
                    ? tr("Write a report request...")
                    : selectedAgent
                      ? tr(`Send a message to ${getAgentName(selectedAgent)}...`)
                      : tr("Type a message...")
            }
            rows={1}
            className="min-h-[44px] max-h-32 flex-1 resize-none overflow-y-auto bg-transparent px-4 py-3 text-sm leading-relaxed text-gray-100 placeholder-gray-500 focus:outline-none"
            style={{ scrollbarWidth: "none" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
          />
          <button
            onClick={onSend}
            disabled={!input.trim()}
            className={`mb-2 mr-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition-all ${
              input.trim()
                ? isDirectiveMode
                  ? "bg-red-600 text-white hover:bg-red-500"
                  : isAnnouncementMode
                    ? "bg-yellow-500 text-gray-900 hover:bg-yellow-400"
                    : mode === "task"
                      ? "bg-blue-600 text-white hover:bg-blue-500"
                      : mode === "report"
                        ? "bg-emerald-600 text-white hover:bg-emerald-500"
                        : "bg-blue-600 text-white hover:bg-blue-500"
                : "cursor-not-allowed bg-gray-700 text-gray-600"
            }`}
            aria-label={tr("Send")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
            </svg>
          </button>
        </div>
        <p className="mt-1.5 px-1 text-xs text-gray-600">{tr("Press Enter to send, Shift+Enter for a new line")}</p>
      </div>
    </>
  );
}
