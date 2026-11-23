import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security-headers";

// FLEX-120 my.flexperiment.ru: no analytics, no third-party scripts, no referrer (contract §12).
const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export default config;
