import { ListChecks, Megaphone, FileBarChart } from "lucide-react";
type ChatMode = "chat" | "task" | "announcement" | "report";

type Tr = (en: string) => string;

interface ChatModeHintProps {
  mode: ChatMode;
  isDirectiveMode: boolean;
  tr: Tr;
}

export default function ChatModeHint({ mode, isDirectiveMode, tr }: ChatModeHintProps) {
  if (mode === "chat" && !isDirectiveMode) return null;

  return (
    <div className="px-4 py-1 flex-shrink-0">
      {isDirectiveMode ? (
        <p className="text-xs text-red-400 font-medium">{tr("Directive mode - Planning team auto-coordinates")}</p>
      ) : (
        <>
          {mode === "task" && (
            <p className="text-xs text-blue-400">
              <ListChecks size={13} strokeWidth={1.75} className="mr-1 inline -mt-0.5" />
              {tr("Task mode - assign work to the agent")}
            </p>
          )}
          {mode === "announcement" && (
            <p className="text-xs text-yellow-400">
              <Megaphone size={13} strokeWidth={1.75} className="mr-1 inline -mt-0.5" />
              {tr("Announcement mode - sent to all agents")}
            </p>
          )}
          {mode === "report" && (
            <p className="text-xs text-emerald-400">
              <FileBarChart size={13} strokeWidth={1.75} className="mr-1 inline -mt-0.5" />
              {tr("Report mode - request report/deck authoring")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
