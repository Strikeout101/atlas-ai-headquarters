import { useCallback, type RefObject } from "react";
import type { Message } from "../../types";
import type { DecisionOption } from "../chat/decision-request";
import { isPromiseLike, type ChatMode } from "./model";

type Tr = (en: string) => string;

interface UseDecisionReplyHandlersParams {
  tr: Tr;
  onSendMessage: (
    content: string,
    receiverType: "agent" | "department" | "all",
    receiverId?: string,
    messageType?: string,
  ) => void | Promise<void>;
  setDecisionReplyKey: (value: string | null | ((prev: string | null) => string | null)) => void;
  setMode: (mode: ChatMode) => void;
  setInput: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useDecisionReplyHandlers({
  tr,
  onSendMessage,
  setDecisionReplyKey,
  setMode,
  setInput,
  textareaRef,
}: UseDecisionReplyHandlersParams) {
  const handleDecisionOptionReply = useCallback(
    (msg: Message, option: DecisionOption) => {
      const receiverId = msg.sender_id;
      if (!receiverId) return;

      const replyContent = tr(`[Decision Reply] Please proceed with option ${option.number}. (${option.label})`);
      const key = `${msg.id}:${option.number}`;
      setDecisionReplyKey(key);
      const sendResult = onSendMessage(replyContent, "agent", receiverId, "chat");
      if (isPromiseLike(sendResult)) {
        sendResult.finally(() => setDecisionReplyKey((prev) => (prev === key ? null : prev)));
        return;
      }
      setDecisionReplyKey(null);
    },
    [onSendMessage, setDecisionReplyKey, tr],
  );

  const handleDecisionManualDraft = useCallback(
    (option: DecisionOption) => {
      setMode("chat");
      setInput(tr(`Please proceed with option ${option.number}. Additional note: `));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [setInput, setMode, textareaRef, tr],
  );

  return { handleDecisionOptionReply, handleDecisionManualDraft };
}
