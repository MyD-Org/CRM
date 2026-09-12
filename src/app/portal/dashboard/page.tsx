import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente, getFacturas, getPagos, getPresupuestos } from "@/lib/erp"
import { DashboardClient } from "@/components/portal/DashboardClient"
import { AiChat } from "@/components/portal/AiChat"
import { aiChatEnabled, shopEnabled } from "@/lib/flags"
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

  // allSettled y no all: son cuatro llamadas a Alegra y con `all` una sola caída dejaba al
  // cliente sin dashboard. Pasó de verdad — /payments devolvió 500 para un contacto y la
  // página entera murió, con las facturas ya traídas. Ahora cada sección falla por su cuenta
  // y la UI avisa cuál no cargó.
  const [clienteRes, facturasRes, pagosRes, presupuestosRes] = await Promise.allSettled([
    getCliente(tenant, session.codigocliente),
    getFacturas(tenant, session.codigocliente),
    getPagos(tenant, session.codigocliente),
    getPresupuestos(tenant, session.codigocliente),
  ])

  for (const [nombre, res] of [
    ["cliente", clienteRes],
    ["facturas", facturasRes],
    ["pagos", pagosRes],
    ["presupuestos", presupuestosRes],
  ] as const) {
    if (res.status === "rejected") console.error(`dashboard: falló ${nombre}:`, res.reason)
  }

  // El cliente es la excepción: sin él no hay razón social, saldos ni cuenta corriente que
  // mostrar. Ahí sí no hay dashboard posible y conviene el error.
  if (clienteRes.status === "rejected") throw clienteRes.reason

  const cliente = clienteRes.value
  const facturas = facturasRes.status === "fulfilled" ? facturasRes.value : []
  const pagos = pagosRes.status === "fulfilled" ? pagosRes.value : []
  const presupuestos = presupuestosRes.status === "fulfilled" ? presupuestosRes.value : []
  const seccionesCaidas = [
    facturasRes.status === "rejected" ? ("facturas" as const) : null,
    pagosRes.status === "rejected" ? ("pagos" as const) : null,
    presupuestosRes.status === "rejected" ? ("presupuestos" as const) : null,
  ].filter((v) => v !== null)

  const [aiEnabled, shopActive] = await Promise.all([aiChatEnabled(), shopEnabled()])

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
      shopUrl={shopActive ? process.env.NEXT_PUBLIC_SHOP_URL : undefined}
      seccionesCaidas={seccionesCaidas}
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
