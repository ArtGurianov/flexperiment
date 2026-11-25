import type { NextConfig } from "next";
import { LEGACY_COURSE_ALIASES } from "./lib/legacy-course-aliases";
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
  async rewrites() {
    return [...LEGACY_COURSE_ALIASES.keys()].map(alias => ({
      source: `/${alias}`,
      destination: `/courses/legacy-alias/${alias}`,
    }));
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [{ key: "Content-Security-Policy", value: publicImageContentSecurityPolicy() }],
    }];
  },
};

export default config;
