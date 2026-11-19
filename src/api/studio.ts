import { patch, post, request } from "./core";

export interface StudioSettings {
  provider: "none" | "openai_compatible";
  base_url: string;
  api_key_set: boolean;
  model: string;
  image_size: string;
  cost_per_image_minor: number;
  monthly_cap_minor: number;
  enabled: boolean;
  chrome_path: string;
  license_note: string;
  spent_this_month_minor: number;
  /** The browser the free mockup renderer will use, or null when none was found. */
  renderer_browser: string | null;
}

export interface MediaAsset {
  id: string;
  business: "tech" | "rental" | "ventures" | null;
  project_id: string | null;
  opportunity_id: string | null;
  listing_id: string | null;
  kind: "mockup" | "generated" | "upload";
  path: string;
  source: string;
  prompt: string;
  license: string;
  tags: string[];
  width: number | null;
  height: number | null;
  cost_minor: number;
  currency: string;
  created_at: number;
}

export const studioApi = {
  get: async () => (await request<{ ok: true; settings: StudioSettings }>("/api/studio")).settings,
  save: async (
    input: Partial<Omit<StudioSettings, "api_key_set" | "spent_this_month_minor" | "renderer_browser">> & {
      api_key?: string;
    },
  ) => (await patch<{ ok: true; settings: StudioSettings }>("/api/studio", input)).settings,
  test: async () => (await post<{ ok: true; models: string[] }>("/api/studio/test", {})).models,
  media: async (filter: { q?: string; business?: string } = {}) => {
    const params = new URLSearchParams();
    if (filter.q) params.set("q", filter.q);
    if (filter.business) params.set("business", filter.business);
    const query = params.toString();
    return (await request<{ ok: true; items: MediaAsset[] }>(`/api/media${query ? `?${query}` : ""}`)).items;
  },
  fileUrl: (id: string) => `/api/media/${encodeURIComponent(id)}/file`,
};
