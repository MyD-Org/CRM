import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Los logos de tenant (ej. /logos/central-led.svg) son SVG. next/image bloquea
    // los SVG en el optimizador por defecto; los habilitamos con una CSP restrictiva
    // (sin scripts, sandbox) porque son assets propios y confiables de /public/logos.
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  async rewrites() {
    // El widget de chat habla con ai-api vía same-origin para evitar CORS
    const aiApiUrl = process.env.CENTRAL_LED_AI_API_URL
    if (!aiApiUrl) return []
    return [{ source: "/ai-api/:path*", destination: `${aiApiUrl}/:path*` }]
  },
};

export default nextConfig;
