import type { ReactNode } from "react";
import { presentAdminError } from "../../lib/errors";

export function Notice({ error, children }: { error?: string | null; children?: ReactNode }) {
  if (!error && !children) return null;
  const presentation = error ? presentAdminError(error) : null;
  return (
    <p className={`notice ${error ? "notice-error" : ""}`}>
      {error ? (
        <>
          Ошибка: {presentation?.message} <code>{error}</code>
          {presentation?.hint && <> — {presentation.hint}</>}
        </>
      ) : (
        children
      )}
    </p>
  );
}
