import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

/** Per TanStack's testing guidance: an isolated client per test, retries off. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function withQueryClient(client: QueryClient, node: ReactElement): ReactElement {
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

export function QueryClientWrapper({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
