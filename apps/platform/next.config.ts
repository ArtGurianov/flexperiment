import type { NextConfig } from "next";
import { publicImageContentSecurityPolicy, publicMediaRemotePattern } from "./lib/public-media";

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
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

export default config;
