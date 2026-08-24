"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { defaultQueryOptions } from "../lib/query-config";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: defaultQueryOptions }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
