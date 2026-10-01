import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
