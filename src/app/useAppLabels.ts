import { useMemo } from "react";
import { normalizeLanguage, pickLang } from "../i18n";
import type { CompanySettings, Department } from "../types";
import type { View } from "./types";
import { NAV_ITEMS } from "./routes";

interface UseAppLabelsParams {
  view: View;
  settings: CompanySettings;
  departments: Department[];
}

export function useAppLabels({ view, settings, departments }: UseAppLabelsParams) {
  const uiLanguage = normalizeLanguage(settings.language);
  const loadingTitle = pickLang(uiLanguage, {
    en: "Loading ATLAS...",
  });
  const loadingSubtitle = pickLang(uiLanguage, {
    en: "Preparing your AI agent empire",
  });
  const navItem = NAV_ITEMS.find((item) => item.view === view);
  const viewTitle = navItem ? pickLang(uiLanguage, navItem.label) : "";
  const announcementLabel = `${pickLang(uiLanguage, {
    en: "Announcement",
  })}`;
  const roomManagerLabel = `${pickLang(uiLanguage, {
    en: "Office Manager",
  })}`;
  const roomManagerDepartments = useMemo(
    () => [
      {
        id: "ceoOffice",
        name: pickLang(uiLanguage, {
          en: "CEO Office",
        }),
      },
      ...departments,
      {
        id: "breakRoom",
        name: pickLang(uiLanguage, {
          en: "Break Room",
        }),
      },
    ],
    [departments, uiLanguage],
  );
  const reportLabel = `${pickLang(uiLanguage, {
    en: "Reports",
  })}`;
  const tasksPrimaryLabel = pickLang(uiLanguage, {
    en: "Tasks",
  });
  const agentStatusLabel = pickLang(uiLanguage, {
    en: "Agent status",
  });
  const decisionLabel = pickLang(uiLanguage, {
    en: "Decisions",
  });

  return {
    uiLanguage,
    loadingTitle,
    loadingSubtitle,
    viewTitle,
    announcementLabel,
    roomManagerLabel,
    roomManagerDepartments,
    reportLabel,
    tasksPrimaryLabel,
    agentStatusLabel,
    decisionLabel,
  };
}
