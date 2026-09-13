import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCuenta, getFacturasPage, getPagosPage, getPresupuestosPage } from "@/lib/erp"
import { DashboardClient } from "@/components/portal/DashboardClient"
import { AiChat } from "@/components/portal/AiChat"
import { aiChatEnabled, shopEnabled } from "@/lib/flags"
import { r2Config } from "@/lib/r2"
import { listPortal, type PortalReceiptDto } from "@/lib/payment-receipts"
import type { SessionData } from "@/types"

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; factura?: string; alegra?: string }>
}) {
  const [tenant, cookieStore, sp] = await Promise.all([getTenantConfig(), cookies(), searchParams])
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn || !session.codigocliente) {
    redirect("/portal")
  }

  // Todo se pide paginado: bajar el historial entero rompía el dashboard. Un cliente con 387
  // pagos eran ~13 páginas de 9 s cada una (cada pago trae sus facturas embebidas).
  //
  // allSettled y no all: con `all` una sola caída de Alegra dejaba al cliente sin dashboard.
  // Cada sección falla por su cuenta y la UI avisa cuál no cargó.
  const [clienteRes, facturasRes, pagosRes, presupuestosRes] = await Promise.allSettled([
    // La cuenta trae las facturas abiertas completas: saldo, contadores y chips Pendientes/Vencidas.
    getCuenta(tenant, session.codigocliente),
    getFacturasPage(tenant, session.codigocliente),
    getPagosPage(tenant, session.codigocliente),
    getPresupuestosPage(tenant, session.codigocliente),
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

  const { cliente, abiertas } = clienteRes.value
  // Primera página nomás: el resto lo pide el cliente con "Cargar más".
  const facturas = facturasRes.status === "fulfilled" ? facturasRes.value.facturas : []
  const facturasTotal = facturasRes.status === "fulfilled" ? facturasRes.value.total : 0
  const pagos = pagosRes.status === "fulfilled" ? pagosRes.value.pagos : []
  const pagosTotal = pagosRes.status === "fulfilled" ? pagosRes.value.total : 0
  const presupuestos = presupuestosRes.status === "fulfilled" ? presupuestosRes.value.presupuestos : []
  const presupuestosTotal = presupuestosRes.status === "fulfilled" ? presupuestosRes.value.total : 0
  const seccionesCaidas = [
    facturasRes.status === "rejected" ? ("facturas" as const) : null,
    pagosRes.status === "rejected" ? ("pagos" as const) : null,
    presupuestosRes.status === "rejected" ? ("presupuestos" as const) : null,
  ].filter((v) => v !== null)

  const [aiEnabled, shopActive] = await Promise.all([aiChatEnabled(), shopEnabled()])

  // Primera página del historial de comprobantes informados (B). Solo con el storage
  // configurado; si la query falla la sección queda oculta (no es carga de Alegra y no
  // suma a seccionesCaidas: antes de esta entrega el dashboard no la mostraba).
  const receiptsEnabled = r2Config() !== null
  let comprobantes: PortalReceiptDto[] = []
  let comprobantesTotal = 0
  if (receiptsEnabled) {
    const comprobantesRes = await Promise.allSettled([listPortal(tenant.id, session.codigocliente as string, 0)])
    if (comprobantesRes[0].status === "fulfilled") {
      comprobantes = comprobantesRes[0].value.items
      comprobantesTotal = comprobantesRes[0].value.total
    } else {
      console.error("dashboard: falló comprobantes:", comprobantesRes[0].reason)
    }
  }

  return (
    <>
      <DashboardClient
      cliente={cliente}
      facturas={facturas}
      facturasTotal={facturasTotal}
      abiertas={abiertas}
      pagos={pagos}
      pagosTotal={pagosTotal}
      presupuestos={presupuestos}
      presupuestosTotal={presupuestosTotal}
      razonsocial={session.razonsocial ?? cliente.razonsocial}
      tenantName={tenant.name}
      whatsappNumber={tenant.whatsappNumber}
      logoSrc={tenant.logoPath}
      logoSubtitle={tenant.subtitle}
      initialTab={sp.factura ? "facturas" : sp.tab}
      openFacturaId={sp.factura}
      openFacturaAlegraId={sp.alegra}
      shopUrl={shopActive ? process.env.NEXT_PUBLIC_SHOP_URL : undefined}
      seccionesCaidas={seccionesCaidas}
      receiptsEnabled={receiptsEnabled}
      comprobantes={comprobantes}
      comprobantesTotal={comprobantesTotal}
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
