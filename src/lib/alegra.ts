import type { TenantConfig } from "./tenants"
import {
  mockCategories,
  mockItems,
  getMockItemLive,
  mockContacts,
  mockPriceLists,
  mockPaymentTerms,
  mockSellers,
  mockTaxes,
  mockCurrencies,
  mockCreateEstimate,
  mockDeleteEstimate,
  mockListEstimates,
  mockInvoicesByContact,
  mockPaymentsByContact,
} from "./mock-alegra"

// Cliente de Alegra (productos, contactos, cotizaciones, listas de precio, formas de pago).
// Auth HTTP Basic (email:token). Espejo del patrón de lib/flexxus.ts. Modo mock (alegraMock)
// usa fixtures locales — permite construir/probar sin credenciales. Ver ADR catálogo Alegra.
//
// OJO: las cuentas de Alegra son REALES (no hay sandbox). Las lecturas son inocuas; la única
// escritura permitida desde este cliente son cotizaciones (/estimates), que se pueden borrar
// por API. No exponer creación de facturas/pagos desde acá sin decisión explícita.

const ALEGRA_BASE = process.env.ALEGRA_BASE_URL ?? "https://api.alegra.com/api/v1"
const PAGE_SIZE = 30 // Alegra topea limit en 30

// ── Tipos normalizados (lo que consume la sync / el live), independientes del shape crudo ──
export interface AlegraCategory {
  alegraId: string
  name: string
  parentAlegraId: string | null
  status: string
}
export interface AlegraPrice {
  idPriceList: string
  name: string
  price: number
}
export interface AlegraProduct {
  alegraId: string
  code: string | null
  name: string
  description: string | null
  categoryAlegraId: string | null
  prices: AlegraPrice[]
  stock: number | null
  status: string
  images: string[]
}
export interface AlegraContact {
  alegraId: string
  name: string
  identification: string | null // CUIT/DNI según el país de la cuenta
  email: string | null
  phone: string | null
  priceListId: string | null
  sellerId: string | null
  paymentTermId: string | null
  status: string
}
export interface AlegraContactInput {
  name: string
  identification?: string // CUIT/DNI
  email?: string
  phone?: string
}
export interface AlegraPriceList {
  alegraId: string
  name: string
  type: string | null // percentage | amount | ...
  status: string
}
export interface AlegraPaymentTerm {
  alegraId: string
  name: string
  days: number | null
}
export interface AlegraSeller {
  alegraId: string
  name: string
  identification: string | null
  status: string
}
export interface AlegraTax {
  alegraId: string
  name: string
  percentage: number | null
  status: string
}
export interface AlegraCurrency {
  code: string
  name: string
  symbol: string | null
  exchangeRate: number | null
}
export interface AlegraEstimateItemInput {
  alegraId: string
  quantity: number
  price?: number // si no viene, Alegra usa el precio del ítem (según lista del cliente)
  discount?: number // porcentaje
}
export interface AlegraEstimateInput {
  contactAlegraId: string
  items: AlegraEstimateItemInput[]
  dueDate?: string // YYYY-MM-DD
  observations?: string
  anotation?: string // nota interna, no visible al cliente
  priceListId?: string
  sellerId?: string
}
export interface AlegraEstimate {
  alegraId: string
  number: string | null
  date: string
  dueDate: string | null
  clientAlegraId: string
  clientName: string
  status: string
  total: number
  observations: string | null
  items: { alegraId: string; name: string; quantity: number; price: number; discount: number }[]
}
export interface AlegraInvoice {
  alegraId: string
  number: string | null // fullNumber legible (ej. "FV-1-00012876") si Alegra lo trae
  date: string // emisión, YYYY-MM-DD
  dueDate: string | null // vencimiento, YYYY-MM-DD
  total: number
  balance: number // saldo pendiente (0 = pagada)
  status: string // Alegra: open | closed | draft | void
  clientAlegraId: string
}
export interface AlegraPaymentApplied {
  invoiceAlegraId: string
  invoiceNumber: string | null
  amount: number
}
export interface AlegraPayment {
  alegraId: string
  number: string | null
  date: string // YYYY-MM-DD
  amount: number
  method: string // paymentMethod (Transferencia, Efectivo, ...)
  invoices: AlegraPaymentApplied[]
}
/** Saldo de cuenta corriente derivado de las facturas abiertas del contacto. */
export interface AlegraContactBalance {
  total: number // deuda total (saldo de facturas open)
  overdue: number // vencido (dueDate < hoy)
  toFallDue: number // a vencer
}

function authHeader(config: TenantConfig): string {
  const basic = Buffer.from(`${config.alegraEmail}:${config.alegraToken}`).toString("base64")
  return `Basic ${basic}`
}

async function alegraFetch(
  config: TenantConfig,
  path: string,
  params?: Record<string, string>,
  init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
) {
  const url = new URL(`${ALEGRA_BASE}${path}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), {
    method: init?.method ?? "GET",
    headers: {
      Authorization: authHeader(config),
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  })
  if (!res.ok) {
    // Alegra devuelve el motivo en el body (ej. validación de la cotización) — lo sumamos al error.
    const detail = await res.text().catch(() => "")
    throw new Error(`Alegra error ${res.status} en ${path}${detail ? `: ${detail.slice(0, 300)}` : ""}`)
  }
  if (res.status === 204) return null
  return res.json()
}

// Pagina un endpoint de Alegra (start/limit) hasta agotar, mapeando cada fila a un tipo normalizado.
// Alegra topea el limit en 30/página. Para catálogos grandes, pedir una página a la vez
// (await secuencial) tarda demasiado y hace que la función serverless llegue al timeout
// (504 Vercel Runtime Timeout, visto con el catálogo de Central Led). Se piden varias
// páginas en paralelo por tanda para bajar el tiempo total de wall-clock.
const PAGE_CONCURRENCY = 8

async function fetchAllPages<T>(
  config: TenantConfig,
  path: string,
  map: (raw: Record<string, unknown>) => T,
  extraParams: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = []
  let start = 0
  let done = false
  while (!done) {
    const starts = Array.from({ length: PAGE_CONCURRENCY }, (_, i) => start + i * PAGE_SIZE)
    const pages = (await Promise.all(
      starts.map((s) =>
        alegraFetch(config, path, { ...extraParams, start: String(s), limit: String(PAGE_SIZE) }),
      ),
    )) as Record<string, unknown>[][]

    for (const page of pages) {
      if (!Array.isArray(page) || page.length === 0) {
        done = true
        break
      }
      for (const row of page) out.push(map(row))
      if (page.length < PAGE_SIZE) {
        done = true
        break
      }
    }
    start += PAGE_CONCURRENCY * PAGE_SIZE
  }
  return out
}

// ── Mapeo crudo de Alegra → normalizado ──
function mapRawCategory(raw: Record<string, unknown>): AlegraCategory {
  return {
    alegraId: String(raw.id),
    name: String(raw.name ?? ""),
    parentAlegraId: raw.parent ? String((raw.parent as { id?: unknown }).id ?? raw.parent) : null,
    status: String(raw.status ?? "active"),
  }
}

function mapRawItem(raw: Record<string, unknown>): AlegraProduct {
  const priceRaw = Array.isArray(raw.price) ? (raw.price as Record<string, unknown>[]) : []
  const prices: AlegraPrice[] = priceRaw.map((p) => ({
    idPriceList: String(p.idPriceList ?? p.id ?? ""),
    name: String(p.name ?? ""),
    price: Number(p.price ?? 0),
  }))
  const cat = raw.itemCategory as { id?: unknown } | undefined
  const inv = raw.inventory as { availableQuantity?: unknown } | undefined
  const imgs = Array.isArray(raw.images) ? (raw.images as Record<string, unknown>[]) : []
  return {
    alegraId: String(raw.id),
    code: raw.reference ? String((raw.reference as { reference?: unknown }).reference ?? raw.reference) : null,
    name: String(raw.name ?? ""),
    description: raw.description ? String(raw.description) : null,
    categoryAlegraId: cat?.id != null ? String(cat.id) : null,
    prices,
    stock: inv?.availableQuantity != null ? Number(inv.availableQuantity) : null,
    status: String(raw.status ?? "active"),
    images: imgs.map((i) => String(i.url ?? "")).filter(Boolean),
  }
}

function mapRawContact(raw: Record<string, unknown>): AlegraContact {
  const ident = raw.identification
  const priceList = raw.priceList as { id?: unknown } | undefined
  const seller = raw.seller as { id?: unknown } | undefined
  const term = raw.term as { id?: unknown } | undefined
  return {
    alegraId: String(raw.id),
    name: String(raw.name ?? ""),
    // identification puede venir como string o como objeto { type, number } según el país
    identification:
      ident == null
        ? null
        : typeof ident === "object"
          ? String((ident as { number?: unknown }).number ?? "") || null
          : String(ident),
    email: raw.email ? String(raw.email) : null,
    phone: raw.phonePrimary ? String(raw.phonePrimary) : raw.mobile ? String(raw.mobile) : null,
    priceListId: priceList?.id != null ? String(priceList.id) : null,
    sellerId: seller?.id != null ? String(seller.id) : null,
    paymentTermId: term?.id != null ? String(term.id) : null,
    status: String(raw.status ?? "active"),
  }
}

function mapRawPriceList(raw: Record<string, unknown>): AlegraPriceList {
  return {
    alegraId: String(raw.id),
    name: String(raw.name ?? ""),
    type: raw.type ? String(raw.type) : null,
    status: String(raw.status ?? "active"),
  }
}

function mapRawPaymentTerm(raw: Record<string, unknown>): AlegraPaymentTerm {
  return {
    alegraId: String(raw.id),
    name: String(raw.name ?? ""),
    days: raw.days != null ? Number(raw.days) : null,
  }
}

function mapRawSeller(raw: Record<string, unknown>): AlegraSeller {
  return {
    alegraId: String(raw.id),
    name: String(raw.name ?? ""),
    identification: raw.identification ? String(raw.identification) : null,
    status: String(raw.status ?? "active"),
  }
}

function mapRawTax(raw: Record<string, unknown>): AlegraTax {
  return {
    alegraId: String(raw.id),
    name: String(raw.name ?? ""),
    percentage: raw.percentage != null ? Number(raw.percentage) : null,
    status: String(raw.status ?? "active"),
  }
}

function mapRawCurrency(raw: Record<string, unknown>): AlegraCurrency {
  return {
    code: String(raw.code ?? ""),
    name: String(raw.name ?? ""),
    symbol: raw.symbol ? String(raw.symbol) : null,
    exchangeRate: raw.exchangeRate != null ? Number(raw.exchangeRate) : null,
  }
}

function mapRawEstimate(raw: Record<string, unknown>): AlegraEstimate {
  const client = (raw.client ?? {}) as Record<string, unknown>
  const itemsRaw = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : []
  return {
    alegraId: String(raw.id),
    number: raw.number != null ? String(raw.number) : null,
    date: String(raw.date ?? ""),
    dueDate: raw.dueDate ? String(raw.dueDate) : null,
    clientAlegraId: client.id != null ? String(client.id) : "",
    clientName: String(client.name ?? ""),
    status: String(raw.status ?? ""),
    total: Number(raw.total ?? 0),
    observations: raw.observations ? String(raw.observations) : null,
    items: itemsRaw.map((it) => ({
      alegraId: String(it.id),
      name: String(it.name ?? ""),
      quantity: Number(it.quantity ?? 0),
      price: Number(it.price ?? 0),
      discount: Number(it.discount ?? 0),
    })),
  }
}

function mapRawInvoice(raw: Record<string, unknown>): AlegraInvoice {
  const client = (raw.client ?? {}) as Record<string, unknown>
  const numberTemplate = raw.numberTemplate as { fullNumber?: unknown; formattedNumber?: unknown } | undefined
  const fullNumber = numberTemplate?.fullNumber ?? numberTemplate?.formattedNumber ?? raw.number
  return {
    alegraId: String(raw.id),
    number: fullNumber != null ? String(fullNumber) : null,
    date: String(raw.date ?? ""),
    dueDate: raw.dueDate ? String(raw.dueDate) : null,
    total: Number(raw.total ?? 0),
    balance: Number(raw.balance ?? 0),
    status: String(raw.status ?? "open"),
    clientAlegraId: client.id != null ? String(client.id) : "",
  }
}

function mapRawPayment(raw: Record<string, unknown>): AlegraPayment {
  const method = raw.paymentMethod as { name?: unknown } | string | undefined
  const invoicesRaw = Array.isArray(raw.invoices) ? (raw.invoices as Record<string, unknown>[]) : []
  return {
    alegraId: String(raw.id),
    number: raw.number != null ? String(raw.number) : null,
    date: String(raw.date ?? ""),
    amount: Number(raw.amount ?? 0),
    method:
      typeof method === "string" ? method : method?.name != null ? String(method.name) : String(raw.paymentMethod ?? ""),
    invoices: invoicesRaw.map((inv) => {
      const numberTemplate = inv.numberTemplate as { fullNumber?: unknown } | undefined
      return {
        invoiceAlegraId: String(inv.id),
        invoiceNumber: numberTemplate?.fullNumber != null ? String(numberTemplate.fullNumber) : inv.number != null ? String(inv.number) : null,
        // Alegra devuelve el monto imputado en `amount` dentro de cada factura del pago
        amount: Number(inv.amount ?? 0),
      }
    }),
  }
}

// ── API pública del cliente ──

/** Todas las categorías de ítems del tenant. Para la sync. */
export async function listAllCategories(config: TenantConfig): Promise<AlegraCategory[]> {
  if (config.alegraMock) return mockCategories
  return fetchAllPages(config, "/item-categories", mapRawCategory)
}

/** Todos los productos del tenant (modo advanced: trae categoría, inventario, precios). Para la sync. */
export async function listAllItems(config: TenantConfig): Promise<AlegraProduct[]> {
  if (config.alegraMock) return mockItems
  return fetchAllPages(config, "/items", mapRawItem, { order_field: "id", order_direction: "ASC" })
}

/** Precio/stock EN VIVO de ítems puntuales (momento decisivo: checkout, presupuesto del bot). */
export async function getItemsLive(config: TenantConfig, alegraIds: string[]): Promise<AlegraProduct[]> {
  const ids = [...new Set(alegraIds)].filter(Boolean)
  if (config.alegraMock) {
    return ids.map((id) => getMockItemLive(id)).filter((x): x is AlegraProduct => x !== null)
  }
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = (await alegraFetch(config, `/items/${id}`)) as Record<string, unknown>
        return mapRawItem(raw)
      } catch {
        return null
      }
    }),
  )
  return results.filter((x): x is AlegraProduct => x !== null)
}

// ── Contactos (clientes de Alegra) ──

/** Busca contactos por nombre/identificación. `query` usa la búsqueda global de Alegra. */
export async function searchContacts(config: TenantConfig, query: string, limit = 20): Promise<AlegraContact[]> {
  if (config.alegraMock) {
    // Sin tildes para que "san martin" encuentre "San Martín" (la API real resuelve esto server-side)
    const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    const q = fold(query)
    return mockContacts
      .filter(
        (c) =>
          fold(c.name).includes(q) ||
          (c.identification ?? "").includes(query) ||
          (c.email ?? "").toLowerCase() === query.toLowerCase(),
      )
      .slice(0, limit)
  }
  const page = (await alegraFetch(config, "/contacts", {
    query,
    limit: String(Math.min(limit, PAGE_SIZE)),
  })) as Record<string, unknown>[]
  return Array.isArray(page) ? page.map(mapRawContact) : []
}

/** Un contacto puntual por id de Alegra. */
export async function getContact(config: TenantConfig, alegraId: string): Promise<AlegraContact | null> {
  if (config.alegraMock) return mockContacts.find((c) => c.alegraId === alegraId) ?? null
  try {
    const raw = (await alegraFetch(config, `/contacts/${alegraId}`)) as Record<string, unknown>
    return mapRawContact(raw)
  } catch {
    return null
  }
}

/**
 * Crea un contacto en Alegra (cliente nuevo). Lo usa el agente cuando el cliente da su
 * CUIT y no existe todavía, para poder cotizarle. `name` es lo único obligatorio.
 */
export async function createContact(config: TenantConfig, input: AlegraContactInput): Promise<AlegraContact> {
  if (config.alegraMock) {
    const created: AlegraContact = {
      alegraId: String(Date.now()),
      name: input.name,
      identification: input.identification ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      priceListId: null,
      sellerId: null,
      paymentTermId: null,
      status: "active",
    }
    mockContacts.push(created)
    return created
  }
  const body: Record<string, unknown> = { name: input.name }
  if (input.identification) body.identification = input.identification
  if (input.email) body.email = input.email
  if (input.phone) body.phone = input.phone
  const raw = (await alegraFetch(config, "/contacts", undefined, { method: "POST", body })) as Record<string, unknown>
  return mapRawContact(raw)
}

/** Todos los contactos (para una futura sync). Pagina hasta agotar. */
export async function listAllContacts(config: TenantConfig): Promise<AlegraContact[]> {
  if (config.alegraMock) return mockContacts
  return fetchAllPages(config, "/contacts", mapRawContact)
}

// ── Configuración de venta: listas de precio, formas de pago, vendedores, impuestos, monedas ──

export async function listPriceLists(config: TenantConfig): Promise<AlegraPriceList[]> {
  if (config.alegraMock) return mockPriceLists
  return fetchAllPages(config, "/price-lists", mapRawPriceList)
}

/** Términos/condiciones de pago (contado, 30 días, etc.). Endpoint /terms de Alegra. */
export async function listPaymentTerms(config: TenantConfig): Promise<AlegraPaymentTerm[]> {
  if (config.alegraMock) return mockPaymentTerms
  const page = (await alegraFetch(config, "/terms")) as Record<string, unknown>[]
  return Array.isArray(page) ? page.map(mapRawPaymentTerm) : []
}

export async function listSellers(config: TenantConfig): Promise<AlegraSeller[]> {
  if (config.alegraMock) return mockSellers
  const page = (await alegraFetch(config, "/sellers")) as Record<string, unknown>[]
  return Array.isArray(page) ? page.map(mapRawSeller) : []
}

export async function listTaxes(config: TenantConfig): Promise<AlegraTax[]> {
  if (config.alegraMock) return mockTaxes
  const page = (await alegraFetch(config, "/taxes")) as Record<string, unknown>[]
  return Array.isArray(page) ? page.map(mapRawTax) : []
}

export async function listCurrencies(config: TenantConfig): Promise<AlegraCurrency[]> {
  if (config.alegraMock) return mockCurrencies
  const page = (await alegraFetch(config, "/currencies")) as Record<string, unknown>[]
  return Array.isArray(page) ? page.map(mapRawCurrency) : []
}

// ── Cotizaciones (estimates) — la única ESCRITURA permitida contra Alegra ──

/** Crea una cotización. No es documento fiscal: se puede borrar por API (deleteEstimate). */
export async function createEstimate(config: TenantConfig, input: AlegraEstimateInput): Promise<AlegraEstimate> {
  if (config.alegraMock) return mockCreateEstimate(input)
  const body: Record<string, unknown> = {
    client: Number.isNaN(Number(input.contactAlegraId)) ? input.contactAlegraId : Number(input.contactAlegraId),
    date: new Date().toISOString().slice(0, 10),
    items: input.items.map((it) => ({
      id: Number.isNaN(Number(it.alegraId)) ? it.alegraId : Number(it.alegraId),
      quantity: it.quantity,
      ...(it.price !== undefined ? { price: it.price } : {}),
      ...(it.discount !== undefined ? { discount: it.discount } : {}),
    })),
  }
  if (input.dueDate) body.dueDate = input.dueDate
  if (input.observations) body.observations = input.observations
  if (input.anotation) body.anotation = input.anotation
  if (input.priceListId) body.priceList = Number(input.priceListId)
  if (input.sellerId) body.seller = Number(input.sellerId)
  const raw = (await alegraFetch(config, "/estimates", undefined, { method: "POST", body })) as Record<
    string,
    unknown
  >
  return mapRawEstimate(raw)
}

export async function getEstimate(config: TenantConfig, alegraId: string): Promise<AlegraEstimate | null> {
  if (config.alegraMock) return mockListEstimates().find((e) => e.alegraId === alegraId) ?? null
  try {
    const raw = (await alegraFetch(config, `/estimates/${alegraId}`)) as Record<string, unknown>
    return mapRawEstimate(raw)
  } catch {
    return null
  }
}

/** Cotizaciones de un contacto (para "¿qué le coticé?"). */
export async function listEstimatesByContact(config: TenantConfig, contactAlegraId: string): Promise<AlegraEstimate[]> {
  if (config.alegraMock) return mockListEstimates().filter((e) => e.clientAlegraId === contactAlegraId)
  const page = (await alegraFetch(config, "/estimates", {
    client_id: contactAlegraId,
    limit: String(PAGE_SIZE),
    order_field: "id",
    order_direction: "DESC",
  })) as Record<string, unknown>[]
  return Array.isArray(page) ? page.map(mapRawEstimate) : []
}

/** Borra una cotización. Lo usa el smoke test para no dejar datos en cuentas reales. */
export async function deleteEstimate(config: TenantConfig, alegraId: string): Promise<void> {
  if (config.alegraMock) {
    mockDeleteEstimate(alegraId)
    return
  }
  await alegraFetch(config, `/estimates/${alegraId}`, undefined, { method: "DELETE" })
}

// ── Facturas y pagos (cuenta corriente del cliente) ──
// Alegra es el ERP: el portal lee de acá lo que antes venía de Flexxus. Ver lib/erp.ts.

/** Facturas de venta de un contacto (todas; el portal filtra por estado). */
export async function listInvoicesByContact(config: TenantConfig, contactAlegraId: string): Promise<AlegraInvoice[]> {
  if (config.alegraMock) return mockInvoicesByContact(contactAlegraId)
  return fetchAllPages(config, "/invoices", mapRawInvoice, {
    client_id: contactAlegraId,
    order_field: "date",
    order_direction: "DESC",
  })
}

/** Pagos (recibos) recibidos de un contacto, con sus imputaciones a facturas. */
export async function listPaymentsByContact(config: TenantConfig, contactAlegraId: string): Promise<AlegraPayment[]> {
  if (config.alegraMock) return mockPaymentsByContact(contactAlegraId)
  return fetchAllPages(config, "/payments", mapRawPayment, {
    client_id: contactAlegraId,
    type: "in", // solo cobros al cliente, no pagos a proveedores
    order_field: "date",
    order_direction: "DESC",
  })
}

/** Saldo de cuenta corriente derivado de las facturas abiertas (vencido vs. a vencer). */
export async function getContactBalance(config: TenantConfig, contactAlegraId: string): Promise<AlegraContactBalance> {
  const invoices = await listInvoicesByContact(config, contactAlegraId)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  let total = 0
  let overdue = 0
  for (const inv of invoices) {
    if (inv.status === "closed" || inv.status === "void" || inv.balance <= 0) continue
    total += inv.balance
    const due = inv.dueDate ? new Date(`${inv.dueDate}T00:00:00`) : null
    if (due && due < today) overdue += inv.balance
  }
  return { total, overdue, toFallDue: total - overdue }
}
