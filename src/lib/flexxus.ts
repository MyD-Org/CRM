import type { Cliente, Factura, Pago, Presupuesto } from "@/types"
import type { TenantConfig } from "./tenants"
import { mockCliente, mockFacturas, mockPagos, mockPresupuestos } from "./mock-data"

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
