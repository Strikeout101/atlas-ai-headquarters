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
  /** Etsy's daily request allowance as it last reported it (sliding 24 hours). */
  rate_limit_per_day?: number | null;
  rate_remaining_today?: number | null;
  rate_seen_at?: number | null;
  /** True when background sync is paused because the allowance is nearly used. */
  quota_low?: boolean;
  shop_listings?: number;
}

/** One listing in the shop as ATLAS last read it, and the ATLAS package it belongs to, if any. */
export interface EtsyShopListing {
  listing_id: string;
  state: string;
  title: string;
  description: string;
  tags: string[];
  price_minor: number | null;
  currency: string | null;
  url: string | null;
  num_favorers: number | null;
  quantity: number | null;
  seen_at: number;
  package_id: string | null;
  opportunity_id: string | null;
  adopted: boolean;
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
      counts: {
        receipts: number;
        fees: number;
        refunds: number;
        listings: number;
        shop_listings: number;
        changed_on_etsy: number;
      };
      settings: EtsySettings;
    }>("/api/etsy/sync", {}),
  shopListings: async () => (await request<{ ok: true; items: EtsyShopListing[] }>("/api/etsy/listings")).items,
  adopt: async (etsyListingId: string, opportunityId: string | null) =>
    (
      await post<{ ok: true; item: ListingPackage }>(`/api/etsy/listings/${encodeURIComponent(etsyListingId)}/adopt`, {
        opportunity_id: opportunityId,
      })
    ).item,
  disconnect: async () => (await post<{ ok: true; settings: EtsySettings }>("/api/etsy/disconnect", {})).settings,
  pushDraft: async (listingId: string) =>
    (await post<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(listingId)}/etsy-draft`, {}))
      .item,
  publish: async (listingId: string) =>
    (await post<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(listingId)}/etsy-publish`, {}))
      .item,
};
