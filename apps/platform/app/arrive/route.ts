import { forwardArrival } from "@/lib/browser-context";

// Platform-origin arrival endpoint (ART-378): Refref's referral redirect lands here with `?arrival=`.
export function GET(request: Request) {
  return forwardArrival(request);
}
