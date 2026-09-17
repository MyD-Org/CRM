// Cuotas configurables (Configuración → Medios de pago / Cuotas). Lógica PURA: validación de
// lo que manda el backoffice, regla de superposición de vigencias (D15) y armado del payload
// del contrato v1 (platform/contracts/cuotas/v1) que lee el Shop. Sin DB: el acceso a datos
// vive en src/lib/cuotas-repo.ts.
//
// El CRM decide QUÉ se ofrece. Las tasas reales las trae el Shop del proveedor, así que acá
// "sinInteres" es sólo lo que el tenant quiere ofrecer (el Shop aplica la doble llave).

export const CUOTAS_MIN = 2
export const CUOTAS_MAX = 24
const MAX_MONTO = 999_999_999_999.99

export type Resultado<T> = { ok: true; value: T } | { ok: false; campo: string; error: string }

const fail = (campo: string, error: string): { ok: false; campo: string; error: string } => ({ ok: false, campo, error })

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Valor del body si viene la clave; si no, el actual (PATCH parcial). */
function tomar(body: Record<string, unknown>, clave: string, actual: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(body, clave) ? body[clave] : actual
}

function textoRequerido(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.trim()
  return s.length > 0 && s.length <= 100 ? s : null
}

// ─── Medios ──────────────────────────────────────────────────────────────────────────────

export interface MedioValido {
  proveedor: string
  codigoProveedor: string
  nombre: string
  activo: boolean
  orden: number
}

export function validarMedio(body: unknown, actual?: MedioValido): Resultado<MedioValido> {
  if (!esObjeto(body)) return fail("body", "Datos inválidos")

  const proveedor = textoRequerido(tomar(body, "proveedor", actual?.proveedor))
  if (!proveedor) return fail("proveedor", "Indicá el proveedor (ej. mercadopago)")
  const codigoProveedor = textoRequerido(tomar(body, "codigoProveedor", actual?.codigoProveedor))
  if (!codigoProveedor) return fail("codigoProveedor", "Indicá el código del medio en el proveedor (ej. visa)")
  const nombre = textoRequerido(tomar(body, "nombre", actual?.nombre))
  if (!nombre) return fail("nombre", "Indicá el nombre que ve el cliente")

  const activo = tomar(body, "activo", actual?.activo ?? true)
  if (typeof activo !== "boolean") return fail("activo", "Activo inválido")
  const orden = tomar(body, "orden", actual?.orden ?? 0)
  if (typeof orden !== "number" || !Number.isInteger(orden) || orden < 0 || orden > 9999) {
    return fail("orden", "El orden tiene que ser un entero entre 0 y 9999")
  }

  return { ok: true, value: { proveedor, codigoProveedor, nombre, activo, orden } }
}

// ─── Opciones ────────────────────────────────────────────────────────────────────────────

export interface OpcionValida {
  paymentMethodId: string
  cuotas: number
  sinInteres: boolean
  /** numeric(14,2) como string, ej. "150000.00". Con IVA. */
  montoMinimo: string
  /** "YYYY-MM-DD" inclusive (hora Argentina) o null = sin límite de ese lado. */
  vigenteDesde: string | null
  vigenteHasta: string | null
  activo: boolean
}

function parseCuotas(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v
  if (typeof n !== "number" || !Number.isInteger(n) || n < CUOTAS_MIN || n > CUOTAS_MAX) return null
  return n
}

/** "" / null / undefined → "0.00". Número o string decimal ≥ 0 con hasta 2 decimales. */
function parseMontoMinimo(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return "0.00"
  let s: string
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null
    s = String(v)
  } else if (typeof v === "string") {
    s = v.trim()
  } else {
    return null
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const n = Number(s)
  if (n > MAX_MONTO) return null
  return n.toFixed(2)
}

/** "" / null / undefined → null. Si no, "YYYY-MM-DD" de calendario válido; inválido → undefined. */
function parseFecha(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined
  const [y, m, d] = v.split("-").map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined
  return v
}

export function validarOpcion(body: unknown, actual?: OpcionValida): Resultado<OpcionValida> {
  if (!esObjeto(body)) return fail("body", "Datos inválidos")

  const paymentMethodId = tomar(body, "paymentMethodId", actual?.paymentMethodId)
  if (typeof paymentMethodId !== "string" || paymentMethodId.trim() === "") {
    return fail("paymentMethodId", "Elegí el medio de pago")
  }

  const cuotas = parseCuotas(tomar(body, "cuotas", actual?.cuotas))
  if (cuotas === null) return fail("cuotas", `Las cuotas tienen que ser un entero entre ${CUOTAS_MIN} y ${CUOTAS_MAX}`)

  const sinInteres = tomar(body, "sinInteres", actual?.sinInteres ?? false)
  if (typeof sinInteres !== "boolean") return fail("sinInteres", "Sin interés inválido")

  const montoMinimo = parseMontoMinimo(tomar(body, "montoMinimo", actual?.montoMinimo))
  if (montoMinimo === null) return fail("montoMinimo", "El monto mínimo tiene que ser un número mayor o igual a 0")

  const vigenteDesde = parseFecha(tomar(body, "vigenteDesde", actual?.vigenteDesde))
  if (vigenteDesde === undefined) return fail("vigenteDesde", "La fecha de inicio es inválida")
  const vigenteHasta = parseFecha(tomar(body, "vigenteHasta", actual?.vigenteHasta))
  if (vigenteHasta === undefined) return fail("vigenteHasta", "La fecha de fin es inválida")
  if (vigenteDesde && vigenteHasta && vigenteDesde > vigenteHasta) {
    return fail("vigenteHasta", "La vigencia termina antes de empezar")
  }

  const activo = tomar(body, "activo", actual?.activo ?? true)
  if (typeof activo !== "boolean") return fail("activo", "Activo inválido")

  return {
    ok: true,
    value: { paymentMethodId: paymentMethodId.trim(), cuotas, sinInteres, montoMinimo, vigenteDesde, vigenteHasta, activo },
  }
}

// ─── Superposición (D15) ─────────────────────────────────────────────────────────────────

export interface Rango {
  desde: string | null
  hasta: string | null
}

/** Rangos de fecha inclusive; null = abierto de ese lado. Compara strings YYYY-MM-DD. */
export function seSuperponen(a: Rango, b: Rango): boolean {
  const empiezaAntesDelFinDeB = a.desde === null || b.hasta === null || a.desde <= b.hasta
  const empiezaBAntesDelFinDeA = b.desde === null || a.hasta === null || b.desde <= a.hasta
  return empiezaAntesDelFinDeB && empiezaBAntesDelFinDeA
}

interface OpcionComparable {
  id?: string
  cuotas: number
  activo: boolean
  vigenteDesde: string | null
  vigenteHasta: string | null
}

/**
 * Devuelve la opción existente (del MISMO medio) que impide guardar `candidata`: activa, con
 * las mismas cuotas y vigencia superpuesta. Una candidata inactiva nunca choca.
 */
export function buscarSuperpuesta<T extends OpcionComparable>(candidata: OpcionComparable, existentes: T[]): T | null {
  if (!candidata.activo) return null
  const rango = { desde: candidata.vigenteDesde, hasta: candidata.vigenteHasta }
  return (
    existentes.find(
      (e) =>
        e.activo &&
        e.cuotas === candidata.cuotas &&
        (candidata.id === undefined || e.id !== candidata.id) &&
        seSuperponen(rango, { desde: e.vigenteDesde, hasta: e.vigenteHasta }),
    ) ?? null
  )
}

// ─── Contrato v1 (platform/contracts/cuotas/v1) ──────────────────────────────────────────

export interface MedioDePagoV1 {
  id: string
  proveedor: string
  codigo: string
  nombre: string
  activo: boolean
  orden: number
}

export interface OpcionConfiguradaV1 {
  id: string
  medioId: string
  cuotas: number
  sinInteres: boolean
  montoMinimo: number
  vigenteDesde: string | null
  vigenteHasta: string | null
  activo: boolean
}

export interface ContratoCuotasV1 {
  version: "v1"
  tenant: string
  actualizadoEn: string
  medios: MedioDePagoV1[]
  opciones: OpcionConfiguradaV1[]
}

export interface MedioFila extends MedioValido {
  id: string
  updatedAt: Date
}

export interface OpcionFila extends OpcionValida {
  id: string
  updatedAt: Date
}

/**
 * Payload del GET interno. Sólo viajan medios activos y opciones activas de medios activos;
 * la vigencia viaja tal cual (la evalúa el Shop con su reloj). `actualizadoEn` considera TODAS
 * las filas (desactivar también es un cambio); sin filas, `ahora`.
 */
export function armarContratoCuotasV1(input: {
  tenant: string
  medios: MedioFila[]
  opciones: OpcionFila[]
  ahora: Date
}): ContratoCuotasV1 {
  const mediosActivos = input.medios
    .filter((m) => m.activo)
    .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre))
  const posicion = new Map(mediosActivos.map((m, i) => [m.id, i]))

  const opciones = input.opciones
    .filter((o) => o.activo && posicion.has(o.paymentMethodId))
    .sort(
      (a, b) =>
        (posicion.get(a.paymentMethodId) ?? 0) - (posicion.get(b.paymentMethodId) ?? 0) ||
        a.cuotas - b.cuotas ||
        (a.vigenteDesde ?? "").localeCompare(b.vigenteDesde ?? ""),
    )

  const tiempos = [...input.medios, ...input.opciones].map((f) => f.updatedAt.getTime())
  const actualizadoEn = tiempos.length ? new Date(Math.max(...tiempos)) : input.ahora

  return {
    version: "v1",
    tenant: input.tenant,
    actualizadoEn: actualizadoEn.toISOString(),
    medios: mediosActivos.map((m) => ({
      id: m.id,
      proveedor: m.proveedor,
      codigo: m.codigoProveedor,
      nombre: m.nombre,
      activo: true,
      orden: m.orden,
    })),
    opciones: opciones.map((o) => ({
      id: o.id,
      medioId: o.paymentMethodId,
      cuotas: o.cuotas,
      sinInteres: o.sinInteres,
      montoMinimo: Number(o.montoMinimo),
      vigenteDesde: o.vigenteDesde,
      vigenteHasta: o.vigenteHasta,
      activo: true,
    })),
  }
}
