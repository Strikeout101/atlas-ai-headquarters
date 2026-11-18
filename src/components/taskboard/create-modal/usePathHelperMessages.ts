import { useCallback, useMemo } from "react";
import { isApiRequestError } from "../../../api";
import type { Locale, TFunction } from "../constants";

export function usePathHelperMessages(t: TFunction) {
  const unsupportedPathApiMessage = useMemo(
    () =>
      t({
        en: "This server does not support path helper APIs. Enter the path manually.",
      }),
    [t],
  );

  const nativePickerUnavailableMessage = useMemo(
    () =>
      t({
        en: "OS folder picker is unavailable in this environment. Use in-app browser or manual input.",
      }),
    [t],
  );

  const formatAllowedRootsMessage = useCallback(
    (allowedRoots: string[]) => {
      if (allowedRoots.length === 0) {
        return t({
          en: "Path is outside allowed project roots.",
        });
      }
      return t({
        en: `Path is outside allowed project roots. Allowed roots: ${allowedRoots.join(", ")}`,
      });
    },
    [t],
  );

  const resolvePathHelperErrorMessage = useCallback(
    (error: unknown, fallback: Record<Locale, string>) => {
      if (!isApiRequestError(error)) return t(fallback);

      if (error.status === 404) {
        return unsupportedPathApiMessage;
      }
      if (error.code === "project_path_outside_allowed_roots") {
        const allowedRoots = Array.isArray((error.details as { allowed_roots?: unknown })?.allowed_roots)
          ? (error.details as { allowed_roots: unknown[] }).allowed_roots.filter(
              (item): item is string => typeof item === "string" && item.trim().length > 0,
            )
          : [];
        return formatAllowedRootsMessage(allowedRoots);
      }
      if (error.code === "native_picker_unavailable" || error.code === "native_picker_failed") {
        return nativePickerUnavailableMessage;
      }
      if (error.code === "project_path_not_directory") {
        return t({
          en: "This path is not a directory. Please enter a directory path.",
        });
      }
      if (error.code === "project_path_not_found") {
        return t({
          en: "Path not found.",
        });
      }
      return t(fallback);
    },
    [formatAllowedRootsMessage, nativePickerUnavailableMessage, t, unsupportedPathApiMessage],
  );

  return {
    unsupportedPathApiMessage,
    nativePickerUnavailableMessage,
    resolvePathHelperErrorMessage,
  };
}
