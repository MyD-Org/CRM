import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente, getCondiciones } from "@/lib/flexxus"
import { CondicionesClient } from "@/components/portal/CondicionesClient"
import type { SessionData } from "@/types"

export default async function CondicionesPage() {
  const [tenant, cookieStore] = await Promise.all([getTenantConfig(), cookies()])
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn || !session.codigocliente) {
    redirect("/portal")
  }

  const [cliente, condiciones] = await Promise.all([
    getCliente(tenant, session.codigocliente),
    getCondiciones(tenant, session.codigocliente),
  ])

  return (
    <CondicionesClient
      cliente={cliente}
      condiciones={condiciones}
      razonsocial={session.razonsocial ?? cliente.razonsocial}
      tenantName={tenant.name}
      logoSrc={tenant.logoPath}
      logoSubtitle={tenant.subtitle}
    />
  )
}
