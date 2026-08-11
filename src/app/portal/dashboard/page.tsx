import { redirect } from "next/navigation"
import { identidadPortal, urlLogin } from "@/lib/portal-auth"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente, getFacturas, getPagos, getPresupuestos } from "@/lib/erp"
import { DashboardClient } from "@/components/portal/DashboardClient"
import { AiChat } from "@/components/portal/AiChat"
import { aiChatEnabled, shopEnabled } from "@/lib/flags"

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; factura?: string }>
}) {
  const [tenant, identidad, sp] = await Promise.all([
    getTenantConfig(),
    identidadPortal(),
    searchParams,
  ])

  // Sin sesion: al login del dominio primario (el Shop). Este dominio es
  // satellite y no autentica por su cuenta.
  if (!identidad.clerkUserId && !identidad.codigocliente) {
    redirect(urlLogin())
  }

  // Logueado pero sin cuenta de cliente vinculada: no hay estado de cuenta que
  // mostrar. Se lo manda a vincular al Shop, que es donde vive el OTP.
  if (!identidad.codigocliente) {
    redirect("/portal/sin-cuenta")
  }

  const codigocliente = identidad.codigocliente

  const [cliente, facturas, pagos, presupuestos] = await Promise.all([
    getCliente(tenant, codigocliente),
    getFacturas(tenant, codigocliente),
    getPagos(tenant, codigocliente),
    getPresupuestos(tenant, codigocliente),
  ])

  const [aiEnabled, shopActive] = await Promise.all([aiChatEnabled(), shopEnabled()])

  return (
    <>
      <DashboardClient
      cliente={cliente}
      facturas={facturas}
      pagos={pagos}
      presupuestos={presupuestos}
      razonsocial={identidad.razonsocial ?? cliente.razonsocial}
      tenantName={tenant.name}
      whatsappNumber={tenant.whatsappNumber}
      logoSrc={tenant.logoPath}
      logoSubtitle={tenant.subtitle}
      initialTab={sp.factura ? "facturas" : sp.tab}
      initialQuery={sp.q}
      openFacturaId={sp.factura}
      shopUrl={shopActive ? process.env.NEXT_PUBLIC_SHOP_URL : undefined}
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
