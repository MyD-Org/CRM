import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const aiApiUrl = process.env.AI_API_URL ?? "http://localhost:3000";
    return [
      // El browser habla same-origin con /ai-api/* ; Next lo proxea a ai-api (sin CORS).
      { source: "/ai-api/:path*", destination: `${aiApiUrl}/:path*` },
    ];
  },
};

export default nextConfig;
