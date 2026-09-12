import type { Cliente, CondicionesComerciales, Factura, FacturaEstado, Pago, Presupuesto, PresupuestoEstado } from "@/types"
import type { TenantConfig } from "./tenants"
import type { AlegraContact, AlegraEstimate, AlegraInvoice, AlegraPayment } from "./alegra"
import {
  getContact,
  findContactByIdentifier,
  listAllContacts,
  listInvoicesByContact,
  listInvoicesPageByContact,
  type AlegraInvoiceFilters,
  listPaymentsByContact,
  listPaymentsPageByContact,
  listEstimatesByContact,
  listEstimatesPageByContact,
  type AlegraEstimateFilters,
  listOpenInvoicesByContact,
  computeBalance,
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
  // Primero que nada: una anulada no es ni pagada ni adeudada, aunque Alegra le deje
  // saldo. Si se evaluara después, una anulada con balance 0 se mostraría como "pagada".
  if (inv.status === "void") return "anulada"
  if (inv.status === "closed" || inv.balance <= 0) return "pagada"
  if (inv.dueDate && new Date(`${inv.dueDate}T00:00:00`) < hoy) return "vencida"
  return "pendiente"
}

function mapInvoice(inv: AlegraInvoice, hoy: Date): Factura {
  return {
    id: inv.number ?? inv.alegraId,
    alegraId: inv.alegraId,
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
    alegraId: p.alegraId,
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
  // Alegra marca los presupuestos como `billed` (ya facturado = aceptado) o `unbilled`
  // (probado contra la cuenta real). Esto buscaba "accept"/"invoic", que Alegra nunca
  // devuelve, así que el chip "Aceptados" no mostraba nada nunca. Se conservan esas variantes
  // por si llegan de otra cuenta.
  if (s === "billed" || s.includes("accept") || s.includes("acept") || s.includes("invoic")) return "aceptado"
  if (e.dueDate && new Date(`${e.dueDate}T00:00:00`) < hoy) return "vencido"
  return "vigente"
}

function mapEstimate(e: AlegraEstimate, hoy: Date): Presupuesto {
  return {
    id: e.number ?? e.alegraId,
    alegraId: e.alegraId,
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
    tipoCuenta: "corriente",
    // Alegra SÍ lo expone (`creditLimit` del contacto). El comentario que había acá decía
    // lo contrario y por eso se hardcodeaba en 0.
    limitecredito: c.creditLimit,
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
  const contact = await findContactByIdentifier(config, identifier)
  if (!contact) return null
  const balance = await getContactBalance(config, contact.alegraId)
  return mapContactToCliente(contact, balance)
}

export interface Cuenta {
  cliente: Cliente
  /** Facturas impagas (pendientes y vencidas), COMPLETAS. De acá salen los contadores y los
   *  chips Pendientes/Vencidas, que no se pueden calcular sobre una página. */
  abiertas: Factura[]
}

/**
 * Cliente con su saldo y sus facturas abiertas, en un solo pedido de abiertas: el saldo y los
 * contadores salen del mismo set, así que no se puede dar que la tarjeta diga una deuda y la
 * lista de vencidas no la explique.
 */
export async function getCuenta(config: TenantConfig, codigocliente: string): Promise<Cuenta> {
  if (config.alegraMock) {
    return { cliente: mockCliente, abiertas: mockFacturas.filter((f) => f.estado === "pendiente" || f.estado === "vencida") }
  }
  const hoy = today()
  const [contact, abiertas] = await Promise.all([
    getContact(config, codigocliente),
    listOpenInvoicesByContact(config, codigocliente),
  ])
  if (!contact) throw new Error(`Contacto ${codigocliente} no encontrado en Alegra`)
  return {
    cliente: mapContactToCliente(contact, computeBalance(abiertas)),
    // `open` con saldo 0 se mapea como "pagada": no es deuda y no va a estos chips.
    abiertas: abiertas
      .map((i) => mapInvoice(i, hoy))
      .filter((f) => f.estado === "pendiente" || f.estado === "vencida"),
  }
}

/** Todos los clientes del tenant — usado por el gestor de cobranza. */
export async function getClientes(config: TenantConfig): Promise<Cliente[]> {
  if (config.alegraMock) return [mockCliente]
  const contacts = await listAllContacts(config)
  // Sin saldo por contacto acá (sería N+1 de facturas): la cobranza recorre las facturas igual.
  return contacts.filter((c) => c.status === "active").map((c) => mapContactToCliente(c))
}

/** Tamaño de página de las facturas del portal. 30 es el máximo real de Alegra: pedir más
 *  no falla, devuelve basura (con limit=100 vuelven 2 filas). */
export const FACTURAS_PAGE_SIZE = 30

export interface FacturasPage {
  facturas: Factura[]
  /** Total del contacto en Alegra: cuántas hay en total, para saber si quedan más. */
  total: number
}

/**
 * Una página de facturas, de la más reciente a la más vieja.
 *
 * El portal no baja el historial completo: para un cliente con 1282 facturas eran 43
 * páginas y ~7 s de espera antes de ver nada.
 */
export async function getFacturasPage(
  config: TenantConfig,
  codigocliente: string,
  start = 0,
  limit = FACTURAS_PAGE_SIZE,
  filters: AlegraInvoiceFilters = {},
): Promise<FacturasPage> {
  if (config.alegraMock) {
    return { facturas: mockFacturas.slice(start, start + limit), total: mockFacturas.length }
  }
  const hoy = today()
  const { items, total } = await listInvoicesPageByContact(config, codigocliente, { start, limit, filters })
  // Los borradores se esconden (no son documentos emitidos), así que una página puede
  // traer menos de `limit` filas sin que eso signifique que se terminaron.
  return { facturas: items.filter((i) => i.status !== "draft").map((i) => mapInvoice(i, hoy)), total }
}

export async function getFacturas(config: TenantConfig, codigocliente: string): Promise<Factura[]> {
  if (config.alegraMock) return mockFacturas
  const hoy = today()
  const invoices = await listInvoicesByContact(config, codigocliente)
  // Las anuladas SÍ se muestran, marcadas como tales: si el cliente vio la factura en su
  // cuenta y después desaparece sin rastro, parece un error del portal. Los borradores no:
  // no son documentos emitidos y el cliente no tiene por qué enterarse de que existen.
  return invoices.filter((i) => i.status !== "draft").map((i) => mapInvoice(i, hoy))
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

/** Pagos por página. 10 y no 30: cada pago trae embebidas sus facturas y 30 tardan ~9 s. */
export const PAGOS_PAGE_SIZE = 10
/** Presupuestos por página: el máximo de Alegra, son livianos. */
export const PRESUPUESTOS_PAGE_SIZE = 30

export async function getPagosPage(
  config: TenantConfig,
  codigocliente: string,
  start = 0,
  limit = PAGOS_PAGE_SIZE,
): Promise<{ pagos: Pago[]; total: number }> {
  if (config.alegraMock) return { pagos: mockPagos.slice(start, start + limit), total: mockPagos.length }
  const { items, total } = await listPaymentsPageByContact(config, codigocliente, { start, limit })
  return { pagos: items.map(mapPayment), total }
}

export async function getPresupuestosPage(
  config: TenantConfig,
  codigocliente: string,
  start = 0,
  limit = PRESUPUESTOS_PAGE_SIZE,
  filters: AlegraEstimateFilters = {},
): Promise<{ presupuestos: Presupuesto[]; total: number }> {
  if (config.alegraMock) {
    return { presupuestos: mockPresupuestos.slice(start, start + limit), total: mockPresupuestos.length }
  }
  const hoy = today()
  const { items, total } = await listEstimatesPageByContact(config, codigocliente, { start, limit, filters })
  return { presupuestos: items.map((e) => mapEstimate(e, hoy)), total }
}

// Condiciones comerciales: lo que Alegra ya tiene en la ficha del contacto (plazo, lista de
// precios, vendedor) se lee de ahí, y la tabla propia aporta solo lo que Alegra no modela
// (descuentos por rubro, transporte, y el teléfono/email del vendedor, porque Alegra guarda
// solo su nombre).
//
// Antes esto salía ENTERO de la tabla propia, con fallback a un mock cuando no había fila y
// SIN distinguir dev de producción. Avantec no tenía ninguna fila, así que todos sus clientes
// veían el vendedor "Martín Gutiérrez" de Central Led como si fuera el suyo.
export async function getCondiciones(config: TenantConfig, codigocliente: string): Promise<CondicionesComerciales> {
  if (config.alegraMock) return mockCondiciones

  const [contact, propias] = await Promise.all([
    getContact(config, codigocliente),
    getCondicionesPropias(config, codigocliente),
  ])

  const vendedorNombre = contact?.sellerName ?? propias?.vendedor?.nombre ?? null

  return {
    condicionPago: contact?.paymentTermName ?? propias?.condicionPago ?? null,
    plazoDias: contact?.paymentTermDays ?? propias?.plazoDias ?? null,
    listaPrecios: contact?.priceListName ?? propias?.listaPrecios ?? null,
    descuentos: propias?.descuentos ?? [],
    vendedor: vendedorNombre
      ? {
          nombre: vendedorNombre,
          telefono: propias?.vendedor?.telefono || null,
          email: propias?.vendedor?.email || null,
        }
      : null,
    transporte: propias?.transporte?.modalidad ? propias.transporte : null,
  }
}

type CondicionesPropias = {
  condicionPago: string | null
  plazoDias: number | null
  listaPrecios: string | null
  descuentos: CondicionesComerciales["descuentos"]
  vendedor: { nombre?: string; telefono?: string; email?: string } | null
  transporte: { modalidad: string; observaciones: string } | null
}

/** La fila de `client_commercial_conditions`, o `null` si el cliente no tiene. Sin fallback a mock. */
async function getCondicionesPropias(config: TenantConfig, codigocliente: string): Promise<CondicionesPropias | null> {
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
    if (!row) return null

    return {
      condicionPago: row.condicionPago || null,
      plazoDias: row.plazoDias,
      listaPrecios: row.listaPrecios || null,
      descuentos: (row.descuentos as CondicionesComerciales["descuentos"]) ?? [],
      vendedor: (row.vendedor as CondicionesPropias["vendedor"]) ?? null,
      transporte: (row.transporte as CondicionesPropias["transporte"]) ?? null,
    }
  } catch (err) {
    // Una DB caída no tiene por qué dejar al cliente sin lo que sí vino de Alegra.
    console.error("getCondicionesPropias: DB no disponible:", err)
    return null
  }
}
