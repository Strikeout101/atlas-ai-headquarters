// ATLAS is English-only.
export type Lang = "en";

export const SUPPORTED_LANGS: readonly Lang[] = ["en"] as const;

export function isLang(value: unknown): value is Lang {
  return value === "en";
}
