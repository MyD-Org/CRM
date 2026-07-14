import type { MetadataRoute } from "next"
import { getTenantConfig } from "@/lib/tenant-context"

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  try {
    const tenant = await getTenantConfig()
    const icon = `/logos/${tenant.id}-icon.svg`
    return {
      name: `Portal — ${tenant.name}`,
      short_name: tenant.name,
      description: `Portal de clientes de ${tenant.name}${tenant.subtitle ? ` — ${tenant.subtitle}` : ""}`,
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [
        { src: icon, sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: icon, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      ],
    }
  } catch {
    return {
      name: "Portal de Clientes",
      short_name: "Portal",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [{ src: "/logos/central-led-icon.svg", sizes: "any", type: "image/svg+xml" }],
    }
  }
}
