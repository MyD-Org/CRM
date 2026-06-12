import type { Cliente, Factura, Pago, Presupuesto } from "@/types"
import { mockCliente, mockFacturas, mockPagos, mockPresupuestos } from "./mock-data"

const MOCK = true
const BASE_URL = process.env.FLEXXUS_BASE_URL ?? ""
const TOKEN = process.env.FLEXXUS_TOKEN ?? ""

async function apiFetch(path: string, params?: Record<string, string>) {
  const url = new URL(`${BASE_URL}${path}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Flexxus error: ${res.status}`)
  return res.json()
}

export async function getCliente(codigocliente: string): Promise<Cliente> {
  if (MOCK) return mockCliente
  return apiFetch(`/clientes/${codigocliente}`)
}

export async function getFacturas(codigocliente: string): Promise<Factura[]> {
  if (MOCK) return mockFacturas
  return apiFetch("/facturas", { codigocliente })
}

export async function getPagos(codigocliente: string): Promise<Pago[]> {
  if (MOCK) return mockPagos
  return apiFetch("/pagos", { codigocliente })
}

export async function getPresupuestos(codigocliente: string): Promise<Presupuesto[]> {
  if (MOCK) return mockPresupuestos
  return apiFetch("/presupuestos", { codigocliente })
}
