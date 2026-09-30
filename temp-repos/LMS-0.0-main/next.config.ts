import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
  ignoreBuildErrors: true, // Ignore TypeScript errors during build

 },
 eslint: {
  ignoreDuringBuilds: true, // Ignore ESLint errors during build
 },
 
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.t3.storage.dev",
        port: "",
      },
    ],
  },
};

export default nextConfig;
