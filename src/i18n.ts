import { createContext, createElement, useCallback, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { STORAGE_KEYS } from "./storage-keys";

// ATLAS is English-only. The helpers keep their shape so components can keep calling t({ en: "..." }).
export type UiLanguage = "en";
export const LANGUAGE_STORAGE_KEY = STORAGE_KEYS.language;
export const LANGUAGE_USER_SET_STORAGE_KEY = STORAGE_KEYS.languageUserSet;

export type LangText = { en: string };

type TranslationInput = LangText | string;

export function normalizeLanguage(_value?: string | null): UiLanguage {
  return "en";
}

/** The English display name; translated name columns in the database are ignored. */
export function localeName(_locale: UiLanguage | string, obj: { name: string }): string {
  return obj.name;
}

export function detectBrowserLanguage(): UiLanguage {
  return "en";
}

export function localeFromLanguage(_lang?: UiLanguage): string {
  return "en-US";
}

export function pickLang(_lang: UiLanguage | string, text: LangText): string {
  return text.en;
}

export interface I18nContextValue {
  language: UiLanguage;
  locale: string;
  t: (text: TranslationInput) => string;
  __fromProvider?: boolean;
}

const translate = (text: TranslationInput) => (typeof text === "string" ? text : text.en);

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  locale: "en-US",
  t: translate,
  __fromProvider: false,
});

interface I18nProviderProps {
  language?: string | null;
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  // Tell the browser the page is English, so it doesn't offer to translate it.
  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = "en";
  }, []);

  const value = useMemo(() => ({ language: "en" as const, locale: "en-US", t: translate, __fromProvider: true }), []);
  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(_languageOverride?: string | null): I18nContextValue {
  const context = useContext(I18nContext);
  const t = useCallback(translate, []);
  return useMemo(
    () => ({ language: "en" as const, locale: "en-US", t, __fromProvider: context.__fromProvider }),
    [context.__fromProvider, t],
  );
}
