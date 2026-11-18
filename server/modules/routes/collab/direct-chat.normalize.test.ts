import { describe, expect, it } from "vitest";
import {
  detectProjectKindChoice,
  isAffirmativeReply,
  isNoPathReply,
  isProjectProgressInquiry,
  isTaskKickoffMessage,
  normalizeAgentReply,
  resolveContextualTaskMessage,
  shouldPreserveStructuredFallback,
  shouldTreatDirectChatAsTask,
} from "./direct-chat.ts";

describe("normalizeAgentReply", () => {
  it("collapses a fully repeated reply to one copy", () => {
    const input = "Hello! This is Doro from Design. Hello! This is Doro from Design.";
    expect(normalizeAgentReply(input)).toBe("Hello! This is Doro from Design.");
  });

  it("collapses repeated sentence blocks (A+B+C, A+B+C) to one copy", () => {
    const input =
      "Sorry, let me check the time now!Oh, it's 1:30 AM… Are you still working at this hour? You should rest too! Oh, it's 1:30 AM… Are you still working at this hour? You should rest too!";
    expect(normalizeAgentReply(input)).toBe(
      "Sorry, let me check the time now! Oh, it's 1:30 AM… Are you still working at this hour? You should rest too!",
    );
  });

  it("keeps a reply with no repetition", () => {
    const input = "Understood, I'll share the results within 10 minutes after checking.";
    expect(normalizeAgentReply(input)).toBe(input);
  });
});

describe("task intent upgrade", () => {
  it("treats a go-ahead message as a task kickoff", () => {
    expect(isTaskKickoffMessage("go go!")).toBe(true);
    expect(isTaskKickoffMessage("let's go")).toBe(true);
    expect(isTaskKickoffMessage("good morning")).toBe(false);
  });

  it("recognizes affirmative and negative replies", () => {
    expect(isAffirmativeReply("yes, go ahead")).toBe(true);
    expect(isAffirmativeReply("ok")).toBe(true);
    expect(isAffirmativeReply("not now")).toBe(false);
  });

  it("recognizes a reply that there is no project path", () => {
    expect(isNoPathReply("I don't have project path")).toBe(true);
    expect(isNoPathReply("create new project")).toBe(true);
    expect(isNoPathReply("the path is C:/work/site")).toBe(false);
  });

  it("recognizes the project kind choice", () => {
    expect(detectProjectKindChoice("existing project")).toBe("existing");
    expect(detectProjectKindChoice("1")).toBe("existing");
    expect(detectProjectKindChoice("2")).toBe("new");
    expect(detectProjectKindChoice("new project")).toBe("new");
    expect(detectProjectKindChoice("not sure yet")).toBeNull();
  });

  it("treats review and audit requests as tasks", () => {
    expect(shouldTreatDirectChatAsTask("I need a design review report", "chat")).toBe(true);
    expect(shouldTreatDirectChatAsTask("Can you review the source code and write a report?", "chat")).toBe(true);
    expect(shouldTreatDirectChatAsTask("how's the weather today?", "chat")).toBe(false);
  });

  it("does not treat a decision reply marker as a task", () => {
    expect(shouldTreatDirectChatAsTask("[decision reply] 1", "chat")).toBe(false);
  });

  it("promotes a go-ahead to the task request just before it", () => {
    const contextual = resolveContextualTaskMessage("go ahead", [
      { content: "go ahead", messageType: "chat", createdAt: 3000 },
      { content: "Can you run a design review of the current source code?", messageType: "chat", createdAt: 2000 },
      { content: "Yes, I can do that!", messageType: "chat", createdAt: 1000 },
    ]);
    expect(contextual).toBe("Can you run a design review of the current source code?");
  });

  it("promotes a yes after the agent asked whether to start", () => {
    const contextual = resolveContextualTaskMessage(
      "yes, please proceed",
      [
        { content: "yes, please proceed", messageType: "chat", createdAt: 3000 },
        {
          content: "Can you evaluate the current source-code design and run the task?",
          messageType: "chat",
          createdAt: 2000,
        },
      ],
      [{ content: "I can do that. Should I start right away?", createdAt: 2500 }],
    );
    expect(contextual).toBe("Can you evaluate the current source-code design and run the task?");
  });

  it("does not promote a yes without a start question", () => {
    const contextual = resolveContextualTaskMessage(
      "yes",
      [
        { content: "yes", messageType: "chat", createdAt: 3000 },
        { content: "What should we have for lunch?", messageType: "chat", createdAt: 2000 },
      ],
      [{ content: "Nice weather today", createdAt: 2500 }],
    );
    expect(contextual).toBeNull();
  });

  it("does not promote a go-ahead without a task request", () => {
    const contextual = resolveContextualTaskMessage("go ahead", [
      { content: "go ahead", messageType: "chat", createdAt: 3000 },
      { content: "Nice weather today", messageType: "chat", createdAt: 2000 },
      { content: "What should we have for lunch?", messageType: "chat", createdAt: 1000 },
    ]);
    expect(contextual).toBeNull();
  });

  it("recognizes project progress questions", () => {
    expect(isProjectProgressInquiry("Can you share the current project task progress?")).toBe(true);
    expect(isProjectProgressInquiry("Write a design review report for the project")).toBe(false);
  });

  it("keeps structured option lists as they are", () => {
    expect(
      shouldPreserveStructuredFallback("Existing project or new project?\n1️⃣ Existing project\n2️⃣ New project"),
    ).toBe(true);
    expect(
      shouldPreserveStructuredFallback(
        "Please pick an existing project.\n1. Doro [LATEST]\n   Path: /Users/me/Projects/site\n2. Shop\n   Path: /Users/me/Projects/shop",
      ),
    ).toBe(true);
    expect(shouldPreserveStructuredFallback("Understood. I'll get started right away.")).toBe(false);
  });
});
