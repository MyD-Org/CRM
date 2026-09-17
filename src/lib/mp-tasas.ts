// Tasas reales de Mercado Pago por cantidad de cuotas, SÓLO para mostrar en el backoffice
// (Configuración → Medios de pago / Cuotas) al lado de la configuración. No forman parte del
// contrato con el Shop: el Shop consulta sus propias tasas con su token.
//
// GET /v1/payment_methods/installments?public_key=…&amount=…&payment_method_id={visa|master}
// devuelve una entrada por emisor con sus `payer_costs`. Por cantidad de cuotas se muestra la
// tasa MÁS ALTA entre emisores y marcas (mismo criterio conservador que el Shop), con el CFT/TEA
// de esa misma entrada. Tasa 0 = sin interés (se activa en el panel de Mercado Pago).
//
// Nunca tira: sin MP_PUBLIC_KEY → "sin_clave"; cualquier falla → "error" (la página sigue).
// Caché en memoria por instancia (TTL 1 h) sólo de respuestas buenas: la página es
// force-dynamic y no hace falta la caché de fetch de Next para algo de un solo admin.

export const MONTO_REFERENCIA = 100_000
export const TTL_MS = 60 * 60 * 1000
const TIMEOUT_MS = 4000
const API = "https://api.mercadopago.com/v1/payment_methods/installments"
const MEDIOS = ["visa", "master"] as const

export interface TasaCuotas {
  cuotas: number
  tasaPct: number
  cftPct: number | null
  teaPct: number | null
}

export type TasasMP =
  | { estado: "ok"; tasas: TasaCuotas[]; consultadoEn: string }
  | { estado: "sin_clave" }
  | { estado: "error" }

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const finito = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** "45,67" → 45.67; "1.234,50" → 1234.5; "12.5" → 12.5. */
function numeroAR(s: string): number | null {
  const normal = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s
  const n = Number(normal)
  return Number.isFinite(n) ? n : null
}

/** Extrae CFT y TEA de labels tipo `CFT_45,67%|TEA_12,34%`. */
export function parsearLabelsMP(labels: unknown): { cftPct: number | null; teaPct: number | null } {
  let cftPct: number | null = null
  let teaPct: number | null = null
  if (!Array.isArray(labels)) return { cftPct, teaPct }
  for (const l of labels) {
    if (typeof l !== "string") continue
    const cft = /CFT_([\d.,]+)%/.exec(l)
    const tea = /TEA_([\d.,]+)%/.exec(l)
    if (cft?.[1] && cftPct === null) cftPct = numeroAR(cft[1])
    if (tea?.[1] && teaPct === null) teaPct = numeroAR(tea[1])
  }
  return { cftPct, teaPct }
}

/** Une las respuestas crudas (una por marca) en una tasa por cantidad de cuotas. */
export function normalizarTasasMP(respuestas: unknown[]): TasaCuotas[] {
  const porCuotas = new Map<number, TasaCuotas>()
  for (const crudo of respuestas) {
    if (!Array.isArray(crudo)) continue
    for (const emisor of crudo) {
      if (!esObjeto(emisor) || !Array.isArray(emisor.payer_costs)) continue
      for (const pc of emisor.payer_costs) {
        if (!esObjeto(pc)) continue
        const cuotas = pc.installments
        const tasa = pc.installment_rate
        if (typeof cuotas !== "number" || !Number.isInteger(cuotas) || cuotas < 1 || !finito(tasa) || tasa < 0) continue
        const previo = porCuotas.get(cuotas)
        if (!previo || tasa > previo.tasaPct) {
          porCuotas.set(cuotas, { cuotas, tasaPct: tasa, ...parsearLabelsMP(pc.labels) })
        }
      }
    }
  }
  return [...porCuotas.values()].sort((a, b) => a.cuotas - b.cuotas)
}

const pct = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 })

/** "sin interés" | "32,14% (CFT 45,67%)" | "20% de interés" (sin CFT informado). */
export function textoTasa(t: TasaCuotas): string {
  if (t.tasaPct === 0) return "sin interés"
  return t.cftPct === null ? `${pct.format(t.tasaPct)}% de interés` : `${pct.format(t.tasaPct)}% (CFT ${pct.format(t.cftPct)}%)`
}

const cache = new Map<string, { expira: number; valor: Extract<TasasMP, { estado: "ok" }> }>()

/** Para tests. */
export function limpiarCacheTasas(): void {
  cache.clear()
}

async function consultarMedio(fetchFn: FetchLike, publicKey: string, medio: string, timeoutMs: number): Promise<unknown> {
  const url = new URL(API)
  url.searchParams.set("public_key", publicKey)
  url.searchParams.set("amount", String(MONTO_REFERENCIA))
  url.searchParams.set("payment_method_id", medio)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(url.toString(), { signal: controller.signal, cache: "no-store" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function obtenerTasasMercadoPago(opts: {
  publicKey: string | undefined
  fetch?: FetchLike
  ahora?: Date
  timeoutMs?: number
}): Promise<TasasMP> {
  const publicKey = opts.publicKey?.trim()
  if (!publicKey) return { estado: "sin_clave" }
  const ahora = opts.ahora ?? new Date()

  const enCache = cache.get(publicKey)
  if (enCache && enCache.expira > ahora.getTime()) return enCache.valor

  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  try {
    const resultados = await Promise.allSettled(
      MEDIOS.map((m) => consultarMedio(fetchFn, publicKey, m, opts.timeoutMs ?? TIMEOUT_MS)),
    )
    const buenos = resultados.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    const tasas = normalizarTasasMP(buenos)
    if (tasas.length === 0) {
      const motivos = resultados.map((r) => (r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : "error") : "sin planes"))
      console.warn(`[cuotas] no se pudieron consultar las tasas de Mercado Pago: ${motivos.join("; ")}`)
      return { estado: "error" }
    }
    const valor = { estado: "ok" as const, tasas, consultadoEn: ahora.toISOString() }
    cache.set(publicKey, { expira: ahora.getTime() + TTL_MS, valor })
    return valor
  } catch (err) {
    console.warn(`[cuotas] tasas de Mercado Pago: ${err instanceof Error ? err.message : "error"}`)
    return { estado: "error" }
  }
}
