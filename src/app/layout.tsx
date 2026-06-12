import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Portal de Clientes — Central LED",
  description: "Portal de clientes de Central LED — Materiales Eléctricos e Iluminación",
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
