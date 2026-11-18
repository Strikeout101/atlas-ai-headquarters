import { del, patch, post, request } from "./core";

/** The businesses ATLAS works for. Mirrors `server/modules/businesses.ts`. */
export const BUSINESS_KINDS = ["tech", "rental", "ventures"] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];
export const BUSINESS_NAMES: Record<BusinessKind, string> = {
  tech: "Tech Services",
  rental: "Events and Rentals",
  ventures: "Ventures",
};
/** Sentence-case names used in Settings headings. */
export const BUSINESS_SETTINGS_NAMES: Record<BusinessKind, string> = {
  tech: "Tech services",
  rental: "Events and rentals",
  ventures: "Ventures",
};
/** One-word names for labels such as "Tech mailboxes". */
export const BUSINESS_SHORT_NAMES: Record<BusinessKind, string> = {
  tech: "Tech",
  rental: "Rental",
  ventures: "Ventures",
};
export type DraftChannel = "email" | "social" | "sms";
export type DraftPurpose = "outreach" | "promotion" | "follow_up" | "checkin" | "checkout" | "general";

export interface BusinessContact {
  id: string;
  business: BusinessKind;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  /** 1 when this person asked not to be contacted. Drafts to them can't be marked ready. */
  do_not_contact?: number;
  /** Important and VIP clients go to the owner for approval (per the business's approval settings). */
  tier?: ClientTier;
  created_at: number;
  updated_at: number;
}

export type ClientTier = "normal" | "important" | "vip";
type ContactFlag = { do_not_contact?: "0" | "1"; tier?: ClientTier };

export interface BusinessProfile {
  business: BusinessKind;
  name: string;
  website: string;
  email: string;
  service_area: string;
  hours: string;
  brand_voice: string;
  social_profiles: string;
  services: string;
  workflow_notes: string;
  updated_at: number;
}

export interface TechTicket {
  id: string;
  business: "tech";
  contact_id: string | null;
  title: string;
  device: string | null;
  description: string | null;
  status: "new" | "scheduled" | "active" | "waiting" | "done";
  created_at: number;
  updated_at: number;
}

export interface RentalQuote {
  id: string;
  business: "rental";
  contact_id: string | null;
  event_name: string;
  event_date: string | null;
  items: string;
  quote_text: string | null;
  /** Quote total in cents, for the owner's deal-size approval limit. */
  total_minor?: number | null;
  currency?: string;
  status: "draft" | "shared" | "accepted" | "declined" | "archived";
  created_at: number;
  updated_at: number;
}

export interface CommunicationDraft {
  id: string;
  business: BusinessKind;
  contact_id: string | null;
  channel: DraftChannel;
  purpose: DraftPurpose;
  subject: string | null;
  body: string;
  status: "draft" | "ready" | "archived";
  created_at: number;
  updated_at: number;
}

type ListResponse<T> = { ok: true; items: T[] };
type ItemResponse<T> = { ok: true; item: T };

export const businessApi = {
  profiles: {
    list: async () => (await request<ListResponse<BusinessProfile>>("/api/business/profiles")).items,
    update: async (business: BusinessKind, input: Partial<Omit<BusinessProfile, "business" | "updated_at">>) =>
      (await patch<ItemResponse<BusinessProfile>>(`/api/business/profiles/${business}`, input)).item,
  },
  contacts: {
    list: async (business: BusinessKind) =>
      (await request<ListResponse<BusinessContact>>(`/api/business/contacts?business=${business}`)).items,
    create: async (
      input: Pick<BusinessContact, "business" | "name"> &
        Partial<Pick<BusinessContact, "email" | "phone" | "notes">> &
        ContactFlag,
    ) => (await post<ItemResponse<BusinessContact>>("/api/business/contacts", input)).item,
    update: async (
      id: string,
      input: Partial<Pick<BusinessContact, "name" | "email" | "phone" | "notes">> & ContactFlag,
    ) => (await patch<ItemResponse<BusinessContact>>(`/api/business/contacts/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/contacts/${encodeURIComponent(id)}`),
  },
  tickets: {
    list: async () => (await request<ListResponse<TechTicket>>("/api/business/tickets")).items,
    create: async (
      input: Pick<TechTicket, "title" | "status"> & Partial<Pick<TechTicket, "contact_id" | "device" | "description">>,
    ) => (await post<ItemResponse<TechTicket>>("/api/business/tickets", input)).item,
    update: async (
      id: string,
      input: Partial<Pick<TechTicket, "contact_id" | "title" | "device" | "description" | "status">>,
    ) => (await patch<ItemResponse<TechTicket>>(`/api/business/tickets/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/tickets/${encodeURIComponent(id)}`),
  },
  quotes: {
    list: async () => (await request<ListResponse<RentalQuote>>("/api/business/quotes")).items,
    create: async (
      input: Pick<RentalQuote, "event_name" | "items" | "status"> &
        Partial<Pick<RentalQuote, "contact_id" | "event_date" | "quote_text">> & { total_minor?: string | null },
    ) => (await post<ItemResponse<RentalQuote>>("/api/business/quotes", input)).item,
    update: async (
      id: string,
      input: Partial<
        Pick<RentalQuote, "contact_id" | "event_name" | "event_date" | "items" | "quote_text" | "status">
      > & {
        total_minor?: string | null;
      },
    ) => (await patch<ItemResponse<RentalQuote>>(`/api/business/quotes/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/quotes/${encodeURIComponent(id)}`),
  },
  drafts: {
    list: async (business: BusinessKind) =>
      (await request<ListResponse<CommunicationDraft>>(`/api/business/drafts?business=${business}`)).items,
    create: async (
      input: Pick<CommunicationDraft, "business" | "channel" | "purpose" | "body" | "status"> &
        Partial<Pick<CommunicationDraft, "contact_id" | "subject">>,
    ) => (await post<ItemResponse<CommunicationDraft>>("/api/business/drafts", input)).item,
    update: async (
      id: string,
      input: Partial<Pick<CommunicationDraft, "contact_id" | "channel" | "purpose" | "subject" | "body" | "status">>,
    ) => (await patch<ItemResponse<CommunicationDraft>>(`/api/business/drafts/${encodeURIComponent(id)}`, input)).item,
    remove: async (id: string) => del(`/api/business/drafts/${encodeURIComponent(id)}`),
  },
};
