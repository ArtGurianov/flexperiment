export class PartnerApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export async function partnerApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(`/v1/partner${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      throw new PartnerApiError(response.status, body?.error?.code ?? `HTTP_${response.status}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof PartnerApiError) throw error;
    throw new PartnerApiError(0, "NETWORK_AMBIGUOUS");
  }
}
