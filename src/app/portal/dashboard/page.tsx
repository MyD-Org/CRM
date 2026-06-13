import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente, getFacturas, getPagos, getPresupuestos } from "@/lib/flexxus"
import { DashboardClient } from "@/components/portal/DashboardClient"
import { AiChat } from "@/components/portal/AiChat"
import { aiChatEnabled } from "@/lib/flags"
import type { SessionData } from "@/types"

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; factura?: string }>
}) {
  const [tenant, cookieStore, sp] = await Promise.all([getTenantConfig(), cookies(), searchParams])
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn || !session.codigocliente) {
    redirect("/portal")
  }

  const [cliente, facturas, pagos, presupuestos] = await Promise.all([
    getCliente(tenant, session.codigocliente),
    getFacturas(tenant, session.codigocliente),
    getPagos(tenant, session.codigocliente),
    getPresupuestos(tenant, session.codigocliente),
  ])

  const [aiEnabled] = await Promise.all([aiChatEnabled()])

  return (
    <>
      <DashboardClient
      cliente={cliente}
      facturas={facturas}
      pagos={pagos}
      presupuestos={presupuestos}
      razonsocial={session.razonsocial ?? cliente.razonsocial}
      tenantName={tenant.name}
      whatsappNumber={tenant.whatsappNumber}
      logoSrc={tenant.logoPath}
      logoSubtitle={tenant.subtitle}
      initialTab={sp.factura ? "facturas" : sp.tab}
      initialQuery={sp.q}
      openFacturaId={sp.factura}
      />
      {aiEnabled && (
        <AiChat
          baseUrl="/ai-api"
          agentId={tenant.aiAgentId}
          tenantName={tenant.name}
          logoSrc={tenant.logoPath}
        />
      )}
    </>
  )
}
