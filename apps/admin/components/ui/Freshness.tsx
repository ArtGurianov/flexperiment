import { classifyFreshness } from "../../lib/freshness";
import { useLastKnownGoodAt } from "../../lib/use-last-known-good-at";
import { formatTimestamp } from "../../lib/values";

export type FreshnessQuery = {
  isPlaceholderData: boolean;
  isFetching: boolean;
  isRefetchError: boolean;
  isLoadingError: boolean;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  hasData: boolean;
  refetch: () => void;
};

/** Rule: no panel renders server data without this. Stale data may stay on
 * screen; the UI may not imply it is current. */
export function Freshness({ query }: { query: FreshnessQuery }) {
  const lastKnownGoodAt = useLastKnownGoodAt(query.dataUpdatedAt);
  const state = classifyFreshness({ ...query, lastKnownGoodAt });

  switch (state.kind) {
    case "placeholder":
      return <p className="freshness freshness-updating" aria-busy="true">Показываем предыдущие данные · обновляем…</p>;
    case "failedRefetch":
      return (
        <p className="freshness freshness-warn" role="alert">
          Обновление не удалось в {formatTimestamp(state.errorAt)} · данные от {formatTimestamp(state.lastGoodAt)}
          {" · "}
          <button type="button" onClick={query.refetch}>Повторить</button>
        </p>
      );
    case "loadingError":
      return null;
    case "fetching":
      return <p className="freshness" aria-busy="true">Обновляем…</p>;
    case "fresh":
      return <p className="freshness">Обновлено {formatTimestamp(state.updatedAt)}</p>;
  }
}
