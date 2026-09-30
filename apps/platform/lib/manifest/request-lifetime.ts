import { randomUUID } from "node:crypto";
import { finishPlatformRequest } from "./in-flight";

type RouteArgs = { params: Promise<{ slug?: string[] }> };
type PayloadRoute = (request: Request, args: RouteArgs) => Promise<Response>;

export const withPlatformRequestLifetime = (handler: PayloadRoute): PayloadRoute => async (request, args) => {
  const requestId = randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-platform-request-id", requestId);
  const correlatedRequest = new Request(request, { headers });
  try {
    return await handler(correlatedRequest, args);
  } finally {
    finishPlatformRequest(requestId);
  }
};
