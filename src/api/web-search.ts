import { patch, post, request } from "./core";

export type WebSearchProvider = "none" | "serper" | "brave" | "tavily";

/** Which search service agents use for web.search. The key is never sent back, only whether it is set. */
export interface WebSearchSettings {
  provider: WebSearchProvider;
  api_key_set: boolean;
  monthly_cap: number;
  used_this_month: number;
  last_error: string | null;
  last_ok_at: number | null;
}

export const webSearchApi = {
  get: async () => (await request<{ ok: true; settings: WebSearchSettings }>("/api/web-search")).settings,
  save: async (input: { provider?: WebSearchProvider; api_key?: string; monthly_cap?: number }) =>
    (await patch<{ ok: true; settings: WebSearchSettings }>("/api/web-search", input)).settings,
  test: () =>
    post<{ ok: true; source: string; results: number; settings: WebSearchSettings }>("/api/web-search/test", {}),
};
