import { bootstrapSession, patch, post, put, request } from "./core";

import type { BusinessKind } from "./business";

export type ListingPlatform = "etsy" | "itch";
export type ListingStatus = "draft" | "ready" | "approved" | "published" | "rejected" | "withdrawn";
export const LISTING_PLATFORM_NAMES: Record<ListingPlatform, string> = { etsy: "Etsy", itch: "itch.io" };

/** Everything needed to publish one product on a storefront. Agents prepare it; publishing is done by hand. */
export interface ListingPackage {
  id: string;
  business: BusinessKind;
  platform: ListingPlatform;
  project_id: string | null;
  opportunity_id: string | null;
  title: string;
  description: string;
  tags: string[];
  price_minor: number;
  currency: string;
  files: string[];
  mockups: string[];
  notes: string;
  fee_minor: number;
  fee_currency: string;
  status: ListingStatus;
  listing_url: string | null;
  agent_id: string | null;
  task_id: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  submitted_at: number | null;
  decided_at: number | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
  taxonomy_id?: number | null;
  who_made?: string;
  when_made?: string;
  /** Set once the package has been pushed to Etsy as a draft. */
  etsy_listing_id?: string | null;
  /** Who can approve it right now: the VPs, or the owner (always, for fees outside the budget). */
  approver: "owner" | "vp";
}

export interface ListingFeeBudget {
  month: string;
  currency: string;
  monthly_cap_minor: number;
  used_minor: number;
  remaining_minor: number;
}

export interface ListingsOverview {
  items: ListingPackage[];
  budget: ListingFeeBudget;
  fees: Record<ListingPlatform, { amount_minor: number; currency: string }>;
}

async function ownerPost<T>(path: string, body: unknown = {}): Promise<T> {
  await bootstrapSession({ promptOnUnauthorized: false });
  return post<T>(path, body);
}

export const listingsApi = {
  list: (business?: BusinessKind) =>
    request<ListingsOverview & { ok: true }>(
      `/api/listings${business ? `?business=${encodeURIComponent(business)}` : ""}`,
    ),
  setBudget: async (monthlyCapMinor: number) => {
    await bootstrapSession({ promptOnUnauthorized: false });
    return (
      await put<{ ok: true; budget: ListingFeeBudget }>("/api/listings/budget", { monthly_cap_minor: monthlyCapMinor })
    ).budget;
  },
  update: async (
    id: string,
    input: Partial<Pick<ListingPackage, "title" | "description" | "price_minor" | "notes">>,
  ) => {
    await bootstrapSession({ promptOnUnauthorized: false });
    return (await patch<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(id)}`, input)).item;
  },
  decide: async (id: string, approve: boolean) =>
    (await ownerPost<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(id)}/decide`, { approve }))
      .item,
  markPublished: async (id: string, listingUrl: string) =>
    (
      await ownerPost<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(id)}/published`, {
        listing_url: listingUrl,
      })
    ).item,
  withdraw: async (id: string) =>
    (await ownerPost<{ ok: true; item: ListingPackage }>(`/api/listings/${encodeURIComponent(id)}/withdraw`)).item,
};
