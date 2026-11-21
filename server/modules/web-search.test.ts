import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentWebError } from "./agent-web.ts";
import { saveWebSearchSettings, webSearch, webSearchSettings } from "./web-search.ts";

beforeAll(() => {
  process.env.OAUTH_ENCRYPTION_SECRET ||= "test-secret-for-web-search-0123456789";
});
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const NOW = Date.UTC(2026, 10, 21, 12);

function setup(provider: "none" | "serper" | "brave" | "tavily" = "serper", cap = 100) {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  if (provider !== "none") saveWebSearchSettings(db, { provider, api_key: "secret-key", monthly_cap: cap }, NOW);
  const fallback = vi.fn(async (body: Record<string, unknown>) => ({
    source: "DuckDuckGo (keyless)",
    query: body.query,
    note: "Untrusted",
    results: [{ title: "Fallback", url: "https://fallback.example", snippet: "" }],
  }));
  return { db, fallback };
}

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & {
    mock: { calls: Array<[string | URL, RequestInit | undefined]> };
  };
}

describe("web search providers", () => {
  it("asks Google through Serper with the key, and returns results with related questions", async () => {
    const { db, fallback } = setup("serper");
    const fetchFn = fakeFetch(200, {
      organic: [
        { title: "27 <b>top</b> digital products", link: "https://blog.example/top", snippet: "Planners lead" },
        { title: "Duplicate", link: "https://blog.example/top", snippet: "" },
        { title: "Bad", link: "javascript:alert(1)", snippet: "" },
      ],
      peopleAlsoAsk: [{ question: "What sells best on Etsy?" }],
      relatedSearches: [{ query: "etsy trends 2026" }],
    });
    const result = await webSearch(
      db,
      { query: "best selling digital products", limit: 5 },
      { fetch: fetchFn, now: () => NOW, fallback },
    );
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe("https://google.serper.dev/search");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({ q: "best selling digital products", num: 5 });
    expect(result).toMatchObject({
      source: "Google (Serper)",
      results: [{ title: "27 top digital products", url: "https://blog.example/top", snippet: "Planners lead" }],
      related_questions: ["What sells best on Etsy?", "etsy trends 2026"],
    });
    expect((result.results as unknown[]).length).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(webSearchSettings(db, NOW)).toMatchObject({ provider: "serper", api_key_set: true, used_this_month: 1 });
  });

  it("builds Brave and Tavily requests their own way", async () => {
    const brave = setup("brave");
    const braveFetch = fakeFetch(200, {
      web: { results: [{ title: "B", url: "https://b.example", description: "d" }] },
    });
    await webSearch(brave.db, { query: "svg trends" }, { fetch: braveFetch, now: () => NOW, fallback: brave.fallback });
    const [braveUrl, braveInit] = braveFetch.mock.calls[0];
    expect(String(braveUrl)).toBe("https://api.search.brave.com/res/v1/web/search?q=svg+trends&count=8");
    expect((braveInit?.headers as Record<string, string>)["x-subscription-token"]).toBe("secret-key");
    const tavily = setup("tavily");
    const tavilyFetch = fakeFetch(200, { results: [{ title: "T", url: "https://t.example", content: "c" }] });
    const result = await webSearch(
      tavily.db,
      { query: "svg trends" },
      { fetch: tavilyFetch, now: () => NOW, fallback: tavily.fallback },
    );
    expect((tavilyFetch.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(result).toMatchObject({ source: "Tavily", results: [{ url: "https://t.example", snippet: "c" }] });
  });

  it("falls back to the keyless search when the key is refused or the monthly cap is used, and says why", async () => {
    const { db, fallback } = setup("serper", 1);
    const refused = await webSearch(db, { query: "q1" }, { fetch: fakeFetch(403, {}), now: () => NOW, fallback });
    expect(refused).toMatchObject({
      source: "DuckDuckGo (keyless)",
      note: expect.stringContaining("web_search_key_rejected"),
    });
    expect(webSearchSettings(db, NOW).last_error).toContain("web_search_key_rejected");
    const capped = await webSearch(
      db,
      { query: "q2" },
      { fetch: fakeFetch(200, { organic: [] }), now: () => NOW, fallback },
    );
    expect(capped.note).toContain("monthly search cap of 1 reached");
    // A new month starts a new count.
    const nextMonth = Date.UTC(2026, 11, 2);
    const fresh = await webSearch(
      db,
      { query: "q3" },
      { fetch: fakeFetch(200, { organic: [] }), now: () => nextMonth, fallback },
    );
    expect(fresh.source).toBe("Google (Serper)");
  });

  it("uses the keyless search with no provider, and explains a refusal instead of failing silently", async () => {
    const { db, fallback } = setup("none");
    await webSearch(db, { query: "printables" }, { now: () => NOW, fallback });
    expect(fallback).toHaveBeenCalledWith({ operation: "web.search", query: "printables", limit: 8 });
    const refusing = vi.fn(async () => {
      throw new AgentWebError("web_search_rate_limited", 429);
    });
    await expect(webSearch(db, { query: "printables" }, { now: () => NOW, fallback: refusing })).rejects.toThrow(
      "add a search key",
    );
    await expect(webSearch(db, { query: "" })).rejects.toThrow("web_invalid_query");
  });

  it("never returns the key, and forgets it when the provider changes", () => {
    const { db } = setup("serper");
    expect(JSON.stringify(webSearchSettings(db, NOW))).not.toContain("secret-key");
    expect(saveWebSearchSettings(db, { provider: "brave" }, NOW)).toMatchObject({
      provider: "brave",
      api_key_set: false,
    });
    expect(() => saveWebSearchSettings(db, { provider: "google" }, NOW)).toThrow("invalid_provider");
    expect(() => saveWebSearchSettings(db, { monthly_cap: 0 }, NOW)).toThrow("invalid_monthly_cap");
  });
});
