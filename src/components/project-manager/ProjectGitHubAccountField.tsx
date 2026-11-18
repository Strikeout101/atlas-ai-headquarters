import { useEffect, useState } from "react";
import { githubAccountsApi, type GitHubAccount } from "../../api/accounts";
import type { Project } from "../../types";
import type { ProjectI18nTranslate } from "./types";

/**
 * Which GitHub account pushes this project. "Automatic" uses the default for the project's business, then the
 * personal default. Accounts for other businesses are not offered.
 */
export default function ProjectGitHubAccountField({
  t,
  business,
  value,
  onChange,
  disabled,
}: {
  t: ProjectI18nTranslate;
  business: Project["business"];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled: boolean;
}) {
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  useEffect(() => {
    githubAccountsApi
      .list()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);
  const usable = accounts.filter((account) => account.business === null || account.business === (business ?? null));
  const automatic =
    usable.find((account) => business && account.business === business && account.is_default) ??
    usable.find((account) => account.business === null && account.is_default);
  return (
    <label className="block text-xs text-slate-400">
      {t({ ko: "GitHub 계정", en: "GitHub account", ja: "GitHub アカウント", zh: "GitHub 账户" })}
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
      >
        <option value="">
          {automatic
            ? t({
                ko: `자동 (${automatic.label})`,
                en: `Automatic (${automatic.label})`,
                ja: `自動 (${automatic.label})`,
                zh: `自动 (${automatic.label})`,
              })
            : t({
                ko: "자동 (계정 없음: 로컬에만 병합)",
                en: "Automatic (no account yet: merged on this PC only)",
                ja: "自動 (アカウントなし: この PC でのみマージ)",
                zh: "自动（尚无账户：仅在本机合并）",
              })}
        </option>
        {usable.map((account) => (
          <option key={account.id} value={account.id}>
            {account.label}
            {account.login ? ` (${account.login})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
