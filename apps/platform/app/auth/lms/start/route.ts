import { startExchange } from "@/lib/lms-exchange";

export function GET(request: Request) {
  return startExchange(request);
}
