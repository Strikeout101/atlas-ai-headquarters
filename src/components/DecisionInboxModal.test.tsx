import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import DecisionInboxModal from "./DecisionInboxModal";
import type { DecisionInboxItem } from "./chat/decision-inbox";

function decision(kind: DecisionInboxItem["kind"], labels: string[], index: number): DecisionInboxItem {
  return {
    id: `${kind}-${index}`,
    kind,
    agentId: null,
    agentName: "ATLAS",
    agentNameKo: "ATLAS",
    requestContent: `Decision ${index}`,
    createdAt: Date.now(),
    options: labels.map((label, option) => ({ number: option + 1, label, action: `action_${option}` })),
  };
}

describe("Decision Inbox", () => {
  it("renders each work decision with its recommendation first and sends the selected option", async () => {
    const onReplyOption = vi.fn();
    const items = [
      decision("strategy", ["Approve strategy (recommended)", "Ask for a redo"], 1),
      decision("initiative_approval", ["Build it (recommended)", "Leave for later"], 2),
      decision("initiative_blocked", ["Try again (recommended)", "Skip step", "Stop"], 3),
    ];
    render(
      <DecisionInboxModal
        open
        loading={false}
        items={items}
        agents={[]}
        busyKey={null}
        uiLanguage="en"
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onReplyOption={onReplyOption}
        onOpenChat={vi.fn()}
      />,
    );
    const cards = items.map((item) => screen.getByText(item.requestContent).closest(".rounded-xl") as HTMLElement);
    expect(cards.map((card) => within(card).getAllByRole("button").length)).toEqual([2, 2, 3]);
    for (const card of cards) expect(within(card).getAllByRole("button")[0].textContent).toContain("recommended");
    await userEvent.click(within(cards[2]).getByRole("button", { name: "2. Skip step" }));
    expect(onReplyOption).toHaveBeenCalledWith(items[2], 2);
  });
});
