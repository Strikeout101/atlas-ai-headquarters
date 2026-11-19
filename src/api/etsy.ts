import { patch, post, request } from "./core";

import type { ListingPackage } from "./listings";

/** The Etsy connection as the owner sees it. Secrets and tokens are never sent back, only whether they are set. */
export interface EtsySettings {
  business: "tech" | "rental" | "ventures";
  keystring: string;
  shared_secret_set: boolean;
  redirect_uri: string;
  connected: boolean;
  shop_id: string | null;
  shop_name: string | null;
  expires_at: number | null;
  auto_publish: boolean;
  sync_enabled: boolean;
  last_test_at: number | null;
  last_test_ok: boolean | null;
  last_error: string | null;
  last_sync_at: number | null;
  last_sync_error: string | null;
  scopes: string[];
}

export const etsyApi = {
  get: async () => (await request<{ ok: true; settings: EtsySettings }>("/api/etsy")).settings,
  save: async (input: {
    keystring?: string;
    shared_secret?: string;
    redirect_uri?: string;
    auto_publish?: boolean;
    sync_enabled?: boolean;
  }) => (await patch<{ ok: true; settings: EtsySettings }>("/api/etsy", input)).settings,
  connect: async () => (await post<{ ok: true; url: string }>("/api/etsy/connect", {})).url,
  complete: async (url: string) =>
    (await post<{ ok: true; settings: EtsySettings }>("/api/etsy/connect/complete", { url })).settings,
  test: async () => (await post<{ ok: true; settings: EtsySettings }>("/api/etsy/test", {})).settings,
  sync: () =>
    post<{
      ok: true;
      counts: { receipts: number; fees: number; refunds: number; listings: number };
      settings: EtsySettings;
    }>("/api/etsy/sync", {}),
  disconnect: async () => (await post<{ ok: true; settings: EtsySettings }>("/api/etsy/disconnect", {})).settings,
  pushDraft: async (listingId: string) =>
    (await post<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(listingId)}/etsy-draft`, {}))
      .item,
  publish: async (listingId: string) =>
    (await post<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(listingId)}/etsy-publish`, {}))
      .item,
};
