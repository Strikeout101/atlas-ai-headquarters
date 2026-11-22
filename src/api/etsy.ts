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
  /** False until the owner reconnects with the shops_w permission (needed to apply shop changes). */
  can_change_shop?: boolean;
  shop_listings?: number;
}

export interface EtsyShopProfile {
  shop_name: string;
  title: string;
  announcement: string;
  digital_sale_message: string;
  has_logo: boolean;
  has_banner: boolean;
  url: string;
  active_listings: number;
  sales: number;
  reviews: number;
  sections: Array<{ id: string; title: string; listings: number }>;
}
export interface EtsyShopChange {
  id: string;
  status: "ready" | "approved" | "applied" | "rejected";
  title: string | null;
  about: string | null;
  logo_path: string | null;
  banner_path: string | null;
  project_id: string | null;
  error: string | null;
  owner_done_at: number | null;
  created_at: number;
}
export interface EtsyShopState {
  profile: EtsyShopProfile | null;
  seen_at: number | null;
  gaps: string[];
  can_change: boolean;
  changes: EtsyShopChange[];
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
  views?: number | null;
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
  /** `historyDays` re-reads that much history of orders and payment records (1 to 1095 days). */
  sync: (historyDays?: number) =>
    post<{
      ok: true;
      counts: {
        receipts: number;
        fees: number;
        refunds: number;
        listings: number;
        shop_listings: number;
        changed_on_etsy: number;
        windows: number;
      };
      settings: EtsySettings;
    }>("/api/etsy/sync", historyDays === undefined ? {} : { history_days: historyDays }),
  shopListings: async () => (await request<{ ok: true; items: EtsyShopListing[] }>("/api/etsy/listings")).items,
  adopt: async (etsyListingId: string, opportunityId: string | null) =>
    (
      await post<{ ok: true; item: ListingPackage }>(`/api/etsy/listings/${encodeURIComponent(etsyListingId)}/adopt`, {
        opportunity_id: opportunityId,
      })
    ).item,
  shop: async () => {
    const { ok: _ok, ...state } = await request<{ ok: true } & EtsyShopState>("/api/etsy/shop");
    return state as EtsyShopState;
  },
  shopOwnerDone: (id: string) => post(`/api/etsy/shop-changes/${encodeURIComponent(id)}/owner-done`, {}),
  disconnect: async () => (await post<{ ok: true; settings: EtsySettings }>("/api/etsy/disconnect", {})).settings,
  pushDraft: async (listingId: string) =>
    (await post<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(listingId)}/etsy-draft`, {}))
      .item,
  publish: async (listingId: string) =>
    (await post<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(listingId)}/etsy-publish`, {}))
      .item,
};
