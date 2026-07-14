import type { Metadata, Viewport } from "next"
import { getTenantConfig } from "@/lib/tenant-context"
import { InstallAppButton } from "@/components/InstallAppButton"
import "./globals.css"

// Sin esto, los navegadores mobile renderizan a ~980px y achican todo (hay que hacer
// pinch-zoom). Con device-width el layout responsive del CRM funciona en el celular.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
}

export async function generateMetadata(): Promise<Metadata> {
  try {
    const tenant = await getTenantConfig()
    const iconPath = `/logos/${tenant.id}-icon.svg`
    return {
      title: `Portal de Clientes — ${tenant.name}`,
      description: `Portal de clientes de ${tenant.name}${tenant.subtitle ? ` — ${tenant.subtitle}` : ""}`,
      // Favicon + apple-touch-icon por tenant, por convención: public/logos/{tenantId}-icon.svg
      icons: { icon: iconPath, apple: iconPath },
      appleWebApp: {
        capable: true,
        title: tenant.name,
        statusBarStyle: "default",
      },
    }
  } catch {
    return {
      title: "Portal de Clientes",
      icons: { icon: "/logos/central-led-icon.svg", apple: "/logos/central-led-icon.svg" },
      appleWebApp: { capable: true, title: "Portal", statusBarStyle: "default" },
    }
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  let tenantName = "Portal"
  try {
    tenantName = (await getTenantConfig()).name
  } catch {}
  return (
    <html lang="es" className="h-full">
      <body className="min-h-full">
        {children}
        <InstallAppButton appName={tenantName} />
      </body>
    </html>
  )
}
