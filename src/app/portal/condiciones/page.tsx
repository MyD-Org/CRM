import { redirect } from "next/navigation"
import { identidadPortal, urlLogin } from "@/lib/portal-auth"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente, getCondiciones } from "@/lib/erp"
import { CondicionesClient } from "@/components/portal/CondicionesClient"

export default async function CondicionesPage() {
  const [tenant, identidad] = await Promise.all([getTenantConfig(), identidadPortal()])

  if (!identidad.clerkUserId && !identidad.codigocliente) redirect(urlLogin())
  if (!identidad.codigocliente) redirect("/portal/sin-cuenta")
  const codigocliente = identidad.codigocliente

  const [cliente, condiciones] = await Promise.all([
    getCliente(tenant, codigocliente),
    getCondiciones(tenant, codigocliente),
  ])

  return (
    <CondicionesClient
      cliente={cliente}
      condiciones={condiciones}
      razonsocial={identidad.razonsocial ?? cliente.razonsocial}
      tenantName={tenant.name}
      logoSrc={tenant.logoPath}
      logoSubtitle={tenant.subtitle}
    />
  )
}
