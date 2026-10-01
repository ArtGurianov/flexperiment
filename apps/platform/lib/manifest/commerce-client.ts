import type { CourseManifest, ManifestAck, RestrictiveOperation } from "./contracts";

const commerceOrigin = () => process.env.COMMERCE_INTERNAL_ORIGIN ?? "http://127.0.0.1:3002";
const serviceToken = () => {
  const token = process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  if (!token) throw new Error("PLATFORM_COMMERCE_SERVICE_TOKEN_REQUIRED");
  return token;
};

async function request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, commerceOrigin()), {
    method: "POST",
    headers: { authorization: `Bearer ${serviceToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const result = await response.json() as T & { code?: string };
  if (!response.ok) throw new Error(result.code ?? `COMMERCE_HTTP_${response.status}`);
  return result;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, commerceOrigin()), {
    headers: { authorization: `Bearer ${serviceToken()}` },
    cache: "no-store",
  });
  const result = await response.json() as T & { code?: string };
  if (!response.ok) throw new Error(result.code ?? `COMMERCE_HTTP_${response.status}`);
  return result;
}

export const createCommerceOverride = (operation: RestrictiveOperation, signal?: AbortSignal) =>
  request<{ state: "PENDING"; enforced: true }>("/v1/internal/access-overrides", operation, signal);

export const pushCourseManifest = (manifest: CourseManifest) =>
  request<ManifestAck>("/v1/internal/course-manifests", manifest);

export const releaseRolledBackOverride = (operationId: string, proof: unknown) =>
  request<{ state: "RELEASED_ROLLED_BACK" }>(`/v1/internal/access-overrides/${encodeURIComponent(operationId)}/release`, proof);

export type PendingCommerceOverride = {
  readonly operationId: string;
  readonly courseRef: string;
  readonly deadlineAt: string;
  readonly platformEpoch: string;
  readonly createdAt: string;
  readonly orphanedAt: string | null;
};

export const listPendingCommerceOverrides = async () =>
  get<{ overrides: PendingCommerceOverride[] }>("/v1/internal/access-overrides/pending").then(({ overrides }) => overrides);
