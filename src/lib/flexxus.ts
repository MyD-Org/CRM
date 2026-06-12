import type { Cliente, CondicionesComerciales, Factura, Pago, Presupuesto } from "@/types"
import type { TenantConfig } from "./tenants"
import { mockCliente, mockCondiciones, mockFacturas, mockPagos, mockPresupuestos } from "./mock-data"

async function apiFetch(config: TenantConfig, path: string, params?: Record<string, string>) {
  const url = new URL(`${config.flexxusBaseUrl}${path}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${config.flexxusToken}`, "Content-Type": "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Flexxus error: ${res.status}`)
  return res.json()
}

export async function getCliente(config: TenantConfig, codigocliente: string): Promise<Cliente> {
  if (config.flexxusMock) return mockCliente
  return apiFetch(config, `/clientes/${codigocliente}`)
}

/** Todos los clientes del tenant — usado por el gestor de cobranza */
export async function getClientes(config: TenantConfig): Promise<Cliente[]> {
  if (config.flexxusMock) return [mockCliente]
  return apiFetch(config, "/clientes")
}

export async function getFacturas(config: TenantConfig, codigocliente: string): Promise<Factura[]> {
  if (config.flexxusMock) return mockFacturas
  return apiFetch(config, "/facturas", { codigocliente })
}

export async function getPagos(config: TenantConfig, codigocliente: string): Promise<Pago[]> {
  if (config.flexxusMock) return mockPagos
  return apiFetch(config, "/pagos", { codigocliente })
}

export async function getPresupuestos(config: TenantConfig, codigocliente: string): Promise<Presupuesto[]> {
  if (config.flexxusMock) return mockPresupuestos
  return apiFetch(config, "/presupuestos", { codigocliente })
}

// Flexxus no almacena condiciones comerciales: viven en nuestra DB por
// (tenant, cliente). mockCondiciones queda como fallback de dev sin seed.
export async function getCondiciones(config: TenantConfig, codigocliente: string): Promise<CondicionesComerciales> {
  try {
    const { getDb } = await import("@/db")
    const { clientCommercialConditions } = await import("@/db/schema")
    const { and, eq } = await import("drizzle-orm")

    const [row] = await getDb()
      .select()
      .from(clientCommercialConditions)
      .where(
        and(
          eq(clientCommercialConditions.tenantId, config.id),
          eq(clientCommercialConditions.codigocliente, codigocliente),
        ),
      )

    if (!row) return mockCondiciones

    return {
      condicionPago: row.condicionPago,
      plazoDias: row.plazoDias,
      listaPrecios: row.listaPrecios,
      descuentos: row.descuentos as CondicionesComerciales["descuentos"],
      vendedor: row.vendedor as CondicionesComerciales["vendedor"],
      transporte: row.transporte as CondicionesComerciales["transporte"],
    }
  } catch (err) {
    console.error("getCondiciones: DB no disponible, fallback a mock:", err)
    return mockCondiciones
  }
}
