import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Client Cache: desde Next 15 el default de `dynamic` es 0s, o sea que entrar y salir de
    // un chat vuelve a pedirle TODO el inbox al server cada vez. Con 30s el "volver" sale de
    // cache y es instantáneo. Es seguro acá porque las dos vistas se refrescan solas: la lista
    // pollea cada 10s (InboxList) y el thread también (ContactThreadView), así que si algo
    // quedó viejo se corrige en el próximo tick sin que el operador haga nada.
    staleTimes: { dynamic: 30 },
  },
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
