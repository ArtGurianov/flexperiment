import { redeemExchange } from "@/lib/lms-exchange";

export function POST(request: Request) {
  return redeemExchange(request);
}
