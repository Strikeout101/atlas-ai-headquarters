import { describe, expect, it } from "vitest";
import { groupEvents } from "./BusinessWorkspace";
import type { RentalQuote } from "../api/business";

const quote = (id: string, event_date: string | null, status: RentalQuote["status"] = "shared"): RentalQuote => ({
  id,
  business: "rental",
  contact_id: null,
  event_name: id,
  event_date,
  items: "Bubble House",
  quote_text: null,
  status,
  created_at: 0,
  updated_at: 0,
});

describe("groupEvents", () => {
  it("groups upcoming events by month in date order, then undated, then past newest first", () => {
    const groups = groupEvents(
      [
        quote("dec", "2026-12-05"),
        quote("nov-late", "2026-11-22"),
        quote("today", "2026-11-14"),
        quote("tbd", null),
        quote("old", "2026-10-01"),
        quote("older", "2026-09-01"),
        quote("declined", "2026-11-20", "declined"),
        quote("archived", null, "archived"),
      ],
      "2026-11-14",
    );
    expect(groups.months.map((m) => [m.month, m.quotes.map((q) => q.id)])).toEqual([
      ["2026-11", ["today", "nov-late"]],
      ["2026-12", ["dec"]],
    ]);
    expect(groups.undated.map((q) => q.id)).toEqual(["tbd"]);
    expect(groups.past.map((q) => q.id)).toEqual(["old", "older"]);
  });
});
