import type { Metadata } from "next"
import { getTenantConfig } from "@/lib/tenant-context"
import "./globals.css"

export async function generateMetadata(): Promise<Metadata> {
  try {
    const tenant = await getTenantConfig()
    return {
      title: `Portal de Clientes — ${tenant.name}`,
      description: `Portal de clientes de ${tenant.name}${tenant.subtitle ? ` — ${tenant.subtitle}` : ""}`,
    }
  } catch {
    return { title: "Portal de Clientes" }
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
