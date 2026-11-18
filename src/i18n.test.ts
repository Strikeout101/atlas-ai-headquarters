import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  I18nProvider,
  detectBrowserLanguage,
  type I18nContextValue,
  localeFromLanguage,
  localeName,
  normalizeLanguage,
  pickLang,
  useI18n,
} from "./i18n";

describe("i18n helpers (English only)", () => {
  it("always resolves to English, whatever the input or browser", () => {
    for (const value of ["ko-KR", "en_US", "ja-JP", "zh-CN", "fr-FR", undefined]) {
      expect(normalizeLanguage(value)).toBe("en");
    }
    expect(detectBrowserLanguage()).toBe("en");
    expect(localeFromLanguage("en")).toBe("en-US");
  });

  it("returns English text and English names", () => {
    expect(pickLang("en", { en: "hello" })).toBe("hello");
    expect(localeName("en", { name: "Planning" })).toBe("Planning");
  });

  it("useI18n and the provider give English and mark the page as English", () => {
    let result: I18nContextValue | null = null;
    const Probe = ({ override }: { override?: string }) => {
      result = useI18n(override);
      return null;
    };
    render(createElement(I18nProvider, { language: "ko", children: createElement(Probe, { override: "ja" }) }));
    expect(result!.language).toBe("en");
    expect(result!.locale).toBe("en-US");
    expect(result!.t({ en: "Save" })).toBe("Save");
    expect(result!.t("plain")).toBe("plain");
    expect(document.documentElement.lang).toBe("en");
  });
});
