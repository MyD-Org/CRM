// Cuotas por proveedor (Configuración → Medios de pago / Cuotas). Lógica PURA: validación de
// lo que manda el backoffice, regla "no dos escalones activos con el mismo monto mínimo" y
// armado del payload del contrato v2 (platform/contracts/cuotas/v2) que lee el Shop. Sin DB:
// el acceso a datos vive en src/lib/cuotas-repo.ts.
//
// El CRM decide HASTA CUÁNTAS cuotas se ofrecen según el monto, por proveedor, para todas las
// tarjetas de crédito. Tasas y sin interés los informa el proveedor (en Mercado Pago, tasa 0 =
// sin interés, configurado en su panel): no se guardan acá.

export const CUOTAS_MIN = 1
export const CUOTAS_MAX = 24
const MAX_MONTO = 999_999_999_999.99

/** Valor fijo de payment_methods.codigo_proveedor en v2: aplica a todas las tarjetas de crédito. */
export const CODIGO_CREDITO = "credito"

/** Proveedores que se pueden configurar. El id es el que viaja en el contrato. */
export const PROVEEDORES = [{ id: "mercadopago", nombre: "Mercado Pago" }] as const

export function nombreProveedor(id: string): string | null {
  return PROVEEDORES.find((p) => p.id === id)?.nombre ?? null
}

export type Resultado<T> = { ok: true; value: T } | { ok: false; campo: string; error: string }

const fail = (campo: string, error: string): { ok: false; campo: string; error: string } => ({ ok: false, campo, error })

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Valor del body si viene la clave; si no, el actual (PATCH parcial). */
function tomar(body: Record<string, unknown>, clave: string, actual: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(body, clave) ? body[clave] : actual
}

// ─── Proveedores ─────────────────────────────────────────────────────────────────────────

export interface ProveedorValido {
  proveedor: string
  /** Derivado de PROVEEDORES: no se tipea. */
  nombre: string
  activo: boolean
  orden: number
}

export function validarProveedor(body: unknown, actual?: ProveedorValido): Resultado<ProveedorValido> {
  if (!esObjeto(body)) return fail("body", "Datos inválidos")

  const proveedor = tomar(body, "proveedor", actual?.proveedor)
  const nombre = typeof proveedor === "string" ? nombreProveedor(proveedor) : null
  if (typeof proveedor !== "string" || !nombre) return fail("proveedor", "Elegí un proveedor de la lista")

  const activo = tomar(body, "activo", actual?.activo ?? true)
  if (typeof activo !== "boolean") return fail("activo", "Activo inválido")
  const orden = tomar(body, "orden", actual?.orden ?? 0)
  if (typeof orden !== "number" || !Number.isInteger(orden) || orden < 0 || orden > 9999) {
    return fail("orden", "El orden tiene que ser un entero entre 0 y 9999")
  }

  return { ok: true, value: { proveedor, nombre, activo, orden } }
}

// ─── Escalones ───────────────────────────────────────────────────────────────────────────

export interface EscalonValido {
  proveedorId: string
  /** Máximo de cuotas desde `montoMinimo` (1..24). */
  cuotasMax: number
  /** numeric(14,2) como string, ej. "180000.00". ARS con IVA. */
  montoMinimo: string
  activo: boolean
}

function parseCuotasMax(v: unknown): number | null {
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

export function validarEscalon(body: unknown, actual?: EscalonValido): Resultado<EscalonValido> {
  if (!esObjeto(body)) return fail("body", "Datos inválidos")

  const proveedorId = tomar(body, "proveedorId", actual?.proveedorId)
  if (typeof proveedorId !== "string" || proveedorId.trim() === "") {
    return fail("proveedorId", "Elegí el proveedor")
  }

  const cuotasMax = parseCuotasMax(tomar(body, "cuotasMax", actual?.cuotasMax))
  if (cuotasMax === null) {
    return fail("cuotasMax", `El máximo de cuotas tiene que ser un entero entre ${CUOTAS_MIN} y ${CUOTAS_MAX}`)
  }

  const montoMinimo = parseMontoMinimo(tomar(body, "montoMinimo", actual?.montoMinimo))
  if (montoMinimo === null) return fail("montoMinimo", "El monto mínimo tiene que ser un número mayor o igual a 0")

  const activo = tomar(body, "activo", actual?.activo ?? true)
  if (typeof activo !== "boolean") return fail("activo", "Activo inválido")

  return { ok: true, value: { proveedorId: proveedorId.trim(), cuotasMax, montoMinimo, activo } }
}

interface EscalonComparable {
  id?: string
  montoMinimo: string
  activo: boolean
}

/**
 * Devuelve el escalón existente (del MISMO proveedor) que impide guardar `candidato`: activo y
 * con el mismo monto mínimo. Un candidato inactivo nunca choca.
 */
export function buscarMontoRepetido<T extends EscalonComparable>(candidato: EscalonComparable, existentes: T[]): T | null {
  if (!candidato.activo) return null
  const monto = Number(candidato.montoMinimo)
  return (
    existentes.find(
      (e) => e.activo && Number(e.montoMinimo) === monto && (candidato.id === undefined || e.id !== candidato.id),
    ) ?? null
  )
}

// ─── Contrato v2 (platform/contracts/cuotas/v2) ──────────────────────────────────────────

export interface EscalonV2 {
  id: string
  cuotasMax: number
  montoMinimo: number
}

export interface ProveedorV2 {
  id: string
  proveedor: string
  nombre: string
  activo: boolean
  orden: number
  escalones: EscalonV2[]
}

export interface ContratoCuotasV2 {
  version: "v2"
  tenant: string
  actualizadoEn: string
  proveedores: ProveedorV2[]
}

export interface ProveedorFila extends ProveedorValido {
  id: string
  updatedAt: Date
}

export interface EscalonFila extends EscalonValido {
  id: string
  updatedAt: Date
}

/**
 * Payload del GET interno. Sólo viajan proveedores activos y sus escalones activos (por monto
 * mínimo asc). `actualizadoEn` = máximo entre TODAS las filas (desactivar también es un cambio)
 * y la versión de config del tenant (cubre borrados); sin nada de eso, `ahora`.
 */
export function armarContratoCuotasV2(input: {
  tenant: string
  proveedores: ProveedorFila[]
  escalones: EscalonFila[]
  configActualizadaEn: Date | null
  ahora: Date
}): ContratoCuotasV2 {
  const proveedores = input.proveedores
    .filter((p) => p.activo)
    .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre))
    .map((p) => ({
      id: p.id,
      proveedor: p.proveedor,
      nombre: p.nombre,
      activo: true,
      orden: p.orden,
      escalones: input.escalones
        .filter((e) => e.activo && e.proveedorId === p.id)
        .map((e) => ({ id: e.id, cuotasMax: e.cuotasMax, montoMinimo: Number(e.montoMinimo) }))
        .sort((a, b) => a.montoMinimo - b.montoMinimo || a.cuotasMax - b.cuotasMax),
    }))

  const tiempos = [...input.proveedores, ...input.escalones].map((f) => f.updatedAt.getTime())
  if (input.configActualizadaEn) tiempos.push(input.configActualizadaEn.getTime())
  const actualizadoEn = tiempos.length ? new Date(Math.max(...tiempos)) : input.ahora

  return { version: "v2", tenant: input.tenant, actualizadoEn: actualizadoEn.toISOString(), proveedores }
}
