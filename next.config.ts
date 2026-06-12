import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // El widget de chat habla con ai-api vía same-origin para evitar CORS
    const aiApiUrl = process.env.CENTRAL_LED_AI_API_URL
    if (!aiApiUrl) return []
    return [{ source: "/ai-api/:path*", destination: `${aiApiUrl}/:path*` }]
  },
};

export default nextConfig;
