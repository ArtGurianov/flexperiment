export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export const idempotencyKey = () => crypto.randomUUID();

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(`/v1/admin${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      throw new AdminApiError(response.status, body?.error?.code ?? `HTTP_${response.status}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    throw new AdminApiError(0, "NETWORK_AMBIGUOUS");
  }
}
