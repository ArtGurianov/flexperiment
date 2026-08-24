/**
 * Normalization owns the rule that {}, { city_id: "" } and { city_id: undefined }
 * are one logical query. Both the query-key builder and the URL serializer
 * call through here so the two representations cannot drift apart.
 */
export type OrderFilters = {
  city_id?: string;
  occurrence_id?: string;
  payment_status?: string;
  payment_state?: string;
  booking_status?: string;
};

const ORDER_FILTER_KEYS = ["city_id", "occurrence_id", "payment_status", "payment_state", "booking_status"] as const;

export function normalizeOrderFilters(filters: OrderFilters): OrderFilters {
  const normalized: OrderFilters = {};
  for (const key of ORDER_FILTER_KEYS) {
    const value = filters[key];
    if (value) normalized[key] = value;
  }
  return normalized;
}

export function orderFiltersToSearch(filters: OrderFilters): string {
  const normalized = normalizeOrderFilters(filters);
  return ORDER_FILTER_KEYS.filter((key) => normalized[key]).map((key) => `${key}=${encodeURIComponent(normalized[key]!)}`).join("&");
}

export function orderFiltersFromSearchParams(params: URLSearchParams): OrderFilters {
  const filters: OrderFilters = {};
  for (const key of ORDER_FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

export type RefundFilters = {
  status?: readonly string[];
  source?: string;
};

export function normalizeRefundFilters(filters: RefundFilters): RefundFilters {
  const normalized: RefundFilters = {};
  if (filters.status?.length) normalized.status = [...filters.status].sort();
  if (filters.source) normalized.source = filters.source;
  return normalized;
}

export function refundFiltersToSearch(filters: RefundFilters): string {
  const normalized = normalizeRefundFilters(filters);
  const parts: string[] = [];
  for (const status of normalized.status ?? []) parts.push(`status=${encodeURIComponent(status)}`);
  if (normalized.source) parts.push(`source=${encodeURIComponent(normalized.source)}`);
  return parts.join("&");
}

export function refundFiltersFromSearchParams(params: URLSearchParams): RefundFilters {
  const status = params.getAll("status");
  const source = params.get("source");
  const filters: RefundFilters = {};
  if (status.length) filters.status = status;
  if (source) filters.source = source;
  return filters;
}
