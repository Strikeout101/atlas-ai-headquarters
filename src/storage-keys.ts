/**
 * Browser storage keys. They used the upstream "climpire" prefix until the rename to ATLAS (work restructure,
 * phase 8); a saved value under an old key is moved to its new key once, so the owner keeps their theme,
 * language and drafts.
 */
export const STORAGE_KEYS = {
  language: "atlas.language",
  languageUserSet: "atlas.language.user_set",
  theme: "atlas.theme",
  roomThemes: "atlas.roomThemes",
  taskCreateDrafts: "atlas.taskCreateDrafts",
} as const;

const OLD_KEYS: Record<string, string> = {
  "climpire.language": STORAGE_KEYS.language,
  "climpire.language.user_set": STORAGE_KEYS.languageUserSet,
  climpire_theme: STORAGE_KEYS.theme,
  climpire_room_themes: STORAGE_KEYS.roomThemes,
  "climpire.taskCreateDrafts": STORAGE_KEYS.taskCreateDrafts,
};

/** Fired on window when the UI language changes. */
export const LANGUAGE_CHANGE_EVENT = "atlas-language-change";

export function migrateStorageKeys(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    if (!storage) return;
    for (const [oldKey, newKey] of Object.entries(OLD_KEYS)) {
      const value = storage.getItem(oldKey);
      if (value === null) continue;
      if (storage.getItem(newKey) === null) storage.setItem(newKey, value);
      storage.removeItem(oldKey);
    }
  } catch {
    /* storage can be unavailable (private mode); defaults apply */
  }
}

migrateStorageKeys();
