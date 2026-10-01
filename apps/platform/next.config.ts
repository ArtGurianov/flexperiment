import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";
import { publicImageContentSecurityPolicy, publicMediaRemotePattern } from "./lib/public-media";

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    optimizePackageImports: ["@payloadcms/ui"],
  },
  images: {
    remotePatterns: [publicMediaRemotePattern()],
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [{ key: "Content-Security-Policy", value: publicImageContentSecurityPolicy() }],
    }];
  },
};

export default withPayload(config);
