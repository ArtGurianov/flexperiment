import { proxyCommerce } from "@/lib/commerce-proxy";

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyCommerce(request, (await params).path);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
