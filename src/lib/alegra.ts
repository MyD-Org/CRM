import type { TenantConfig } from "./tenants"
import { mockCategories, mockItems, getMockItemLive } from "./mock-alegra"

// Cliente de Alegra para el catálogo (productos, precios, categorías). Auth HTTP Basic
// (email:token). Espejo del patrón de lib/flexxus.ts. Modo mock (alegraMock) usa fixtures
// locales — permite construir/probar sin credenciales. Ver ADR catálogo Alegra (cache + live).

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

function authHeader(config: TenantConfig): string {
  const basic = Buffer.from(`${config.alegraEmail}:${config.alegraToken}`).toString("base64")
  return `Basic ${basic}`
}

async function alegraFetch(config: TenantConfig, path: string, params?: Record<string, string>) {
  const url = new URL(`${ALEGRA_BASE}${path}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader(config), Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Alegra error ${res.status} en ${path}`)
  return res.json()
}

// Pagina un endpoint de Alegra (start/limit) hasta agotar, mapeando cada fila a un tipo normalizado.
async function fetchAllPages<T>(
  config: TenantConfig,
  path: string,
  map: (raw: Record<string, unknown>) => T,
  extraParams: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = []
  for (let start = 0; ; start += PAGE_SIZE) {
    const page = (await alegraFetch(config, path, {
      ...extraParams,
      start: String(start),
      limit: String(PAGE_SIZE),
    })) as Record<string, unknown>[]
    if (!Array.isArray(page) || page.length === 0) break
    for (const row of page) out.push(map(row))
    if (page.length < PAGE_SIZE) break
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
