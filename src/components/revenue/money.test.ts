import { describe, expect, it } from "vitest";
import { formatMoney, moneyInput, parseMoney } from "./money";

describe("currency minor units", () => {
  it("parses decimal text exactly using each currency's exponent", () => {
    expect(parseMoney("0.29", "USD")).toBe(29);
    expect(parseMoney("431", "JPY")).toBe(431);
    expect(parseMoney("4.317", "KWD")).toBe(4317);
    expect(moneyInput(4317, "KWD")).toBe("4.317");
    expect(() => parseMoney("4.31", "JPY")).toThrow("decimal places");
    expect(() => parseMoney("1.234", "USD")).toThrow("decimal places");
  });
  it("refuses unsafe integers and formats the final minor unit without floating point loss", () => {
    expect(() => parseMoney("90071992547409.92", "USD")).toThrow("safely");
    expect(parseMoney("90071992547409.91", "USD")).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatMoney(Number.MAX_SAFE_INTEGER, "USD", "en-US")).toBe("$90,071,992,547,409.91");
    expect(formatMoney(-1, "USD", "en-US")).toBe("-$0.01");
    expect(formatMoney(431, "JPY", "en-US")).toBe("¥431");
  });
});
