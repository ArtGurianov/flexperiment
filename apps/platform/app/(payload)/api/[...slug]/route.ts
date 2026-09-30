import config from "@payload-config";
import { REST_DELETE, REST_GET, REST_OPTIONS, REST_PATCH, REST_POST, REST_PUT } from "@payloadcms/next/routes";
import { withPlatformRequestLifetime } from "@/lib/manifest/request-lifetime";

export const GET = REST_GET(config);
export const POST = withPlatformRequestLifetime(REST_POST(config));
export const DELETE = withPlatformRequestLifetime(REST_DELETE(config));
export const PATCH = withPlatformRequestLifetime(REST_PATCH(config));
export const PUT = withPlatformRequestLifetime(REST_PUT(config));
export const OPTIONS = REST_OPTIONS(config);
