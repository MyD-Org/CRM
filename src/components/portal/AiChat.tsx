"use client"

import { ChatDrawer } from "@myd-org/ai-widget/preset"
import "@myd-org/ai-widget/styles"

interface Props {
  baseUrl: string
  agentId: string
  tenantName: string
  logoSrc: string
}

export function AiChat({ baseUrl, agentId, tenantName, logoSrc }: Props) {
  return (
    <ChatDrawer
      config={{
        baseUrl,
        agentId,
        fetchToken: async () => {
          const res = await fetch("/api/ai-token", { method: "POST" })
          if (!res.ok) throw new Error("No se pudo obtener el token del chat")
          return (await res.json()).token
        },
      }}
      branding={{
        title: tenantName,
        subtitle: "Soporte post-venta",
        avatarUrl: "/logos/central-led-avatar.jpg",
        primaryColor: "#0c3ed6",
      }}
    />
  )
}
