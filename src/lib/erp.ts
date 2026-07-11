import type { Cliente, CondicionesComerciales, Factura, FacturaEstado, Pago, Presupuesto, PresupuestoEstado } from "@/types"
import type { TenantConfig } from "./tenants"
import type { AlegraContact, AlegraEstimate, AlegraInvoice, AlegraPayment } from "./alegra"
import {
  getContact,
  searchContacts,
  listAllContacts,
  listInvoicesByContact,
  listPaymentsByContact,
  listEstimatesByContact,
  getContactBalance,
} from "./alegra"
import { mockCliente, mockCondiciones, mockFacturas, mockPagos, mockPresupuestos } from "./mock-data"

// Capa ERP del portal sobre Alegra. Antes esto era lib/flexxus.ts: Alegra reemplazó a Flexxus
// como ERP, así que el portal (dashboard, login, cobranza) y los endpoints del agente leen de
// acá con los mismos tipos de dominio (Cliente/Factura/Pago/Presupuesto). En modo `alegraMock`
// devuelve los fixtures de mock-data.ts — el portal funciona en dev sin credenciales, igual que
// con el mock de Flexxus. El `codigocliente` del portal es el id de contacto de Alegra.

// ── Helpers de mapeo Alegra → tipos del portal ──

/** "YYYY-MM-DD" → "DD/MM/YYYY" (el portal y el gestor de cobranza usan DD/MM/YYYY). */
function isoToDMY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

function today(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function facturaEstado(inv: AlegraInvoice, hoy: Date): FacturaEstado {
  if (inv.status === "closed" || inv.balance <= 0) return "pagada"
  if (inv.dueDate && new Date(`${inv.dueDate}T00:00:00`) < hoy) return "vencida"
  return "pendiente"
}

function mapInvoice(inv: AlegraInvoice, hoy: Date): Factura {
  return {
    id: inv.number ?? inv.alegraId,
    // Alegra no expone el tipo fiscal (A/B/C) de forma estándar en la factura de venta.
    tipo: "Factura",
    emision: isoToDMY(inv.date),
    vencimiento: inv.dueDate ? isoToDMY(inv.dueDate) : "",
    importe: inv.total,
    estado: facturaEstado(inv, hoy),
    pagado: inv.total - inv.balance,
  }
}

function mapPayment(p: AlegraPayment): Pago {
  return {
    id: p.number ?? p.alegraId,
    fecha: isoToDMY(p.date),
    medio: p.method,
    monto: p.amount,
    facturas: p.invoices.map((inv) => ({
      factura: inv.invoiceNumber ?? inv.invoiceAlegraId,
      imputado: inv.amount,
    })),
  }
}

function presupuestoEstado(e: AlegraEstimate, hoy: Date): PresupuestoEstado {
  const s = e.status.toLowerCase()
  if (s.includes("accept") || s.includes("acept") || s.includes("invoic")) return "aceptado"
  if (e.dueDate && new Date(`${e.dueDate}T00:00:00`) < hoy) return "vencido"
  return "vigente"
}

function mapEstimate(e: AlegraEstimate, hoy: Date): Presupuesto {
  return {
    id: e.number ?? e.alegraId,
    fecha: isoToDMY(e.date),
    validoHasta: e.dueDate ? isoToDMY(e.dueDate) : "",
    total: e.total,
    estado: presupuestoEstado(e, hoy),
  }
}

function mapContactToCliente(c: AlegraContact, balance?: { total: number; overdue: number; toFallDue: number }): Cliente {
  return {
    codigocliente: c.alegraId,
    razonsocial: c.name,
    cuit: c.identification ?? "",
    email: c.email ?? undefined,
    numerocuentacorriente: Number(c.alegraId) || 0,
    tipoCuenta: "corriente",
    limitecredito: 0, // Alegra no expone límite de crédito; se completará desde la DB si hace falta
    deudatotal: balance?.total ?? 0,
    saldovencido: balance?.overdue ?? 0,
    saldoavencer: balance?.toFallDue ?? 0,
  }
}

// ── API del portal (mismo contrato que la vieja lib/flexxus.ts) ──

/** Cliente por su codigocliente (= id de contacto de Alegra), con saldo de cuenta corriente. */
export async function getCliente(config: TenantConfig, codigocliente: string): Promise<Cliente> {
  if (config.alegraMock) return mockCliente
  const [contact, balance] = await Promise.all([
    getContact(config, codigocliente),
    getContactBalance(config, codigocliente),
  ])
  if (!contact) throw new Error(`Contacto ${codigocliente} no encontrado en Alegra`)
  return mapContactToCliente(contact, balance)
}

/** Resuelve el cliente por email o CUIT/identificación (usado por el login OTP). */
export async function getClienteByIdentifier(config: TenantConfig, identifier: string): Promise<Cliente | null> {
  if (config.alegraMock) return mockCliente
  const matches = await searchContacts(config, identifier, 1)
  const contact = matches[0]
  if (!contact) return null
  const balance = await getContactBalance(config, contact.alegraId)
  return mapContactToCliente(contact, balance)
}

/** Todos los clientes del tenant — usado por el gestor de cobranza. */
export async function getClientes(config: TenantConfig): Promise<Cliente[]> {
  if (config.alegraMock) return [mockCliente]
  const contacts = await listAllContacts(config)
  // Sin saldo por contacto acá (sería N+1 de facturas): la cobranza recorre las facturas igual.
  return contacts.filter((c) => c.status === "active").map((c) => mapContactToCliente(c))
}

export async function getFacturas(config: TenantConfig, codigocliente: string): Promise<Factura[]> {
  if (config.alegraMock) return mockFacturas
  const hoy = today()
  const invoices = await listInvoicesByContact(config, codigocliente)
  return invoices.filter((i) => i.status !== "draft" && i.status !== "void").map((i) => mapInvoice(i, hoy))
}

export async function getPagos(config: TenantConfig, codigocliente: string): Promise<Pago[]> {
  if (config.alegraMock) return mockPagos
  const payments = await listPaymentsByContact(config, codigocliente)
  return payments.map(mapPayment)
}

export async function getPresupuestos(config: TenantConfig, codigocliente: string): Promise<Presupuesto[]> {
  if (config.alegraMock) return mockPresupuestos
  const hoy = today()
  const estimates = await listEstimatesByContact(config, codigocliente)
  return estimates.map((e) => mapEstimate(e, hoy))
}

// Las condiciones comerciales NO viven en el ERP: se leen de la DB propia por (tenant, cliente),
// con fallback a mock en dev sin seed. (Idéntico a como estaba en la capa Flexxus.)
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
