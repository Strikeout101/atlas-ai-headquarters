export type SquareConnection = {
  environment: "production" | "sandbox";
  token_configured: boolean;
  enabled: boolean;
  history_since: string;
  locations: Array<{ id: string; name: string; currency: string; status: string }>;
  mappings: Array<{ business: "tech" | "rental" | "ventures"; location_id: string }>;
  last_test_at: number | null;
  last_sync_at: number | null;
  last_sync_error: string | null;
  watermark: string | null;
  fee_unknown: number;
};
import { patch, post, put, request } from "./core";
export const getSquareSettings = () => request<{ ok: true; connection: SquareConnection }>("/api/square");
export const updateSquareSettings = (input: {
  environment?: "production" | "sandbox";
  token?: string;
  clear_token?: boolean;
  enabled?: boolean;
  history_since?: string;
}) => patch<{ ok: true; connection: SquareConnection }>("/api/square", input);
export const updateSquareMappings = (mappings: SquareConnection["mappings"]) =>
  put<{ ok: true; connection: SquareConnection }>("/api/square/mappings", { mappings });
export const testSquare = () => post<{ ok: true; connection: SquareConnection }>("/api/square/test", {});
export const syncSquare = () =>
  post<{ ok: true; imported: number; settings: SquareConnection }>("/api/square/sync", {});
