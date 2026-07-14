import type { Metadata, Viewport } from "next"
import { getTenantConfig } from "@/lib/tenant-context"
import "./globals.css"

// Sin esto, los navegadores mobile renderizan a ~980px y achican todo (hay que hacer
// pinch-zoom). Con device-width el layout responsive del CRM funciona en el celular.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
}

export async function generateMetadata(): Promise<Metadata> {
  try {
    const tenant = await getTenantConfig()
    return {
      title: `Portal de Clientes — ${tenant.name}`,
      description: `Portal de clientes de ${tenant.name}${tenant.subtitle ? ` — ${tenant.subtitle}` : ""}`,
      // Favicon por tenant, por convención: public/logos/{tenantId}-icon.svg
      icons: { icon: `/logos/${tenant.id}-icon.svg` },
    }
  } catch {
    return { title: "Portal de Clientes", icons: { icon: "/logos/central-led-icon.svg" } }
  }
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="es" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  )
}
