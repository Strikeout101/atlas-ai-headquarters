import { del, patch, post, request } from "./core";

import type { BusinessKind } from "./business";

export interface SocialAccount {
  id: string;
  business: BusinessKind;
  platform: "instagram";
  username: string;
  profile_url: string;
  has_access_token: boolean;
  connection_status: "not_connected" | "configured" | "verified";
  provider_user_id: string | null;
  display_name: string | null;
  last_test_at: number | null;
  last_test_ok: boolean | null;
  updated_at: number;
}
type SocialInput = { username?: string; access_token?: string; clear_access_token?: true };
export interface InstagramPost {
  id: string;
  caption: string | null;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | null;
  permalink: string | null;
  timestamp: string | null;
}
export const socialApi = {
  media: async (id: string) =>
    request<{ ok: true; items: InstagramPost[] } | { ok: false; error: string }>(
      `/api/business/social-accounts/${encodeURIComponent(id)}/media`,
    ),
  list: async () => (await request<{ ok: true; items: SocialAccount[] }>("/api/business/social-accounts")).items,
  create: async (business: BusinessKind, input: SocialInput & { username: string }) =>
    (
      await post<{ ok: true; item: SocialAccount }>("/api/business/social-accounts", {
        business,
        platform: "instagram",
        ...input,
      })
    ).item,
  update: async (id: string, input: SocialInput) =>
    (await patch<{ ok: true; item: SocialAccount }>(`/api/business/social-accounts/${encodeURIComponent(id)}`, input))
      .item,
  test: async (id: string) =>
    post<{ ok: boolean; item: SocialAccount; error?: string }>(
      `/api/business/social-accounts/${encodeURIComponent(id)}/test`,
      {},
    ),
  disconnect: async (id: string) =>
    (
      await post<{ ok: true; item: SocialAccount }>(
        `/api/business/social-accounts/${encodeURIComponent(id)}/disconnect`,
        {},
      )
    ).item,
  remove: async (id: string) => del(`/api/business/social-accounts/${encodeURIComponent(id)}`),
};
