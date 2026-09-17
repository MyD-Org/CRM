import { and, asc, eq, sql } from "drizzle-orm"
import { getDb } from "@/db"
import { installmentOptions, paymentMethods, tenants } from "@/db/schema"
import {
  armarContratoCuotasV1,
  buscarSuperpuesta,
  validarMedio,
  validarOpcion,
  type ContratoCuotasV1,
  type MedioValido,
  type OpcionValida,
} from "@/lib/cuotas"

// Acceso a datos de Medios de pago / Cuotas. TODO filtra por `tenantId` (el del guard, nunca el
// del body): un id de otro tenant se comporta igual que uno inexistente (not_found → 404).
// La regla "no dos opciones activas del mismo medio y cuotas con vigencia superpuesta" se
// valida dentro de una transacción con pg_advisory_xact_lock por medio (D15): no hay unique
// index porque la misma cantidad de cuotas puede repetirse en vigencias que no se tocan.

export type MedioRow = typeof paymentMethods.$inferSelect
export type OpcionRow = typeof installmentOptions.$inferSelect

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const esUuid = (id: string) => UUID_RE.test(id)

type Invalido = { kind: "invalid"; campo: string; error: string }

function esUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true
  }
  return false
}

// ─── DTOs (lo que ve el backoffice) ──────────────────────────────────────────────────────

export interface MedioDto extends MedioValido {
  id: string
}

export interface OpcionDto extends OpcionValida {
  id: string
  updatedAt: string
}

export const toMedioDto = (r: MedioRow): MedioDto => ({
  id: r.id,
  proveedor: r.proveedor,
  codigoProveedor: r.codigoProveedor,
  nombre: r.nombre,
  activo: r.activo,
  orden: r.orden,
})

const opcionValida = (r: OpcionRow): OpcionValida => ({
  paymentMethodId: r.paymentMethodId,
  cuotas: r.cuotas,
  sinInteres: r.sinInteres,
  montoMinimo: r.montoMinimo,
  vigenteDesde: r.vigenteDesde,
  vigenteHasta: r.vigenteHasta,
  activo: r.activo,
})

export const toOpcionDto = (r: OpcionRow): OpcionDto => ({ id: r.id, ...opcionValida(r), updatedAt: r.updatedAt.toISOString() })

// ─── Medios ──────────────────────────────────────────────────────────────────────────────

export async function listarMedios(tenantId: string): Promise<MedioRow[]> {
  return getDb()
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.tenantId, tenantId))
    .orderBy(asc(paymentMethods.orden), asc(paymentMethods.nombre))
}

export type ResultadoMedio = { kind: "ok"; row: MedioRow } | { kind: "duplicado" } | { kind: "not_found" } | Invalido

export async function crearMedio(tenantId: string, body: unknown): Promise<ResultadoMedio> {
  const v = validarMedio(body)
  if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
  try {
    const [row] = await getDb()
      .insert(paymentMethods)
      .values({ tenantId, ...v.value })
      .returning()
    return { kind: "ok", row: row as MedioRow }
  } catch (err) {
    if (esUniqueViolation(err)) return { kind: "duplicado" }
    throw err
  }
}

export async function actualizarMedio(tenantId: string, id: string, body: unknown): Promise<ResultadoMedio> {
  if (!esUuid(id)) return { kind: "not_found" }
  const db = getDb()
  const [actual] = await db
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.id, id), eq(paymentMethods.tenantId, tenantId)))
  if (!actual) return { kind: "not_found" }

  const v = validarMedio(body, toMedioDto(actual))
  if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
  try {
    const [row] = await db
      .update(paymentMethods)
      .set({ ...v.value, updatedAt: new Date() })
      .where(and(eq(paymentMethods.id, id), eq(paymentMethods.tenantId, tenantId)))
      .returning()
    return row ? { kind: "ok", row } : { kind: "not_found" }
  } catch (err) {
    if (esUniqueViolation(err)) return { kind: "duplicado" }
    throw err
  }
}

// ─── Opciones ────────────────────────────────────────────────────────────────────────────

export async function listarOpciones(tenantId: string): Promise<OpcionRow[]> {
  return getDb()
    .select()
    .from(installmentOptions)
    .where(eq(installmentOptions.tenantId, tenantId))
    .orderBy(asc(installmentOptions.paymentMethodId), asc(installmentOptions.cuotas), asc(installmentOptions.vigenteDesde))
}

export type ResultadoOpcion =
  | { kind: "ok"; row: OpcionRow }
  | { kind: "not_found" }
  | { kind: "superpuesta"; conId: string }
  | Invalido

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]

/** Bloquea el medio (dentro de la tx) y busca una opción que choque con `candidata`. */
async function chequearSuperposicion(tx: Tx, candidata: OpcionValida & { id?: string }) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${candidata.paymentMethodId}))`)
  const existentes = await tx
    .select({
      id: installmentOptions.id,
      cuotas: installmentOptions.cuotas,
      activo: installmentOptions.activo,
      vigenteDesde: installmentOptions.vigenteDesde,
      vigenteHasta: installmentOptions.vigenteHasta,
    })
    .from(installmentOptions)
    .where(
      and(
        eq(installmentOptions.paymentMethodId, candidata.paymentMethodId),
        eq(installmentOptions.cuotas, candidata.cuotas),
      ),
    )
  return buscarSuperpuesta(candidata, existentes)
}

async function medioDelTenant(tx: Tx, tenantId: string, medioId: string): Promise<boolean> {
  if (!esUuid(medioId)) return false
  const [m] = await tx
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.id, medioId), eq(paymentMethods.tenantId, tenantId)))
  return Boolean(m)
}

export async function crearOpcion(tenantId: string, body: unknown, actorId: string): Promise<ResultadoOpcion> {
  const v = validarOpcion(body)
  if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
  const opcion = v.value

  return getDb().transaction(async (tx) => {
    if (!(await medioDelTenant(tx, tenantId, opcion.paymentMethodId))) return { kind: "not_found" }
    const choque = await chequearSuperposicion(tx, opcion)
    if (choque) return { kind: "superpuesta", conId: choque.id }
    const [row] = await tx
      .insert(installmentOptions)
      .values({ tenantId, ...opcion, updatedBy: actorId })
      .returning()
    return { kind: "ok", row: row as OpcionRow }
  })
}

export async function actualizarOpcion(
  tenantId: string,
  id: string,
  body: unknown,
  actorId: string,
): Promise<ResultadoOpcion> {
  if (!esUuid(id)) return { kind: "not_found" }

  return getDb().transaction(async (tx) => {
    const [actual] = await tx
      .select()
      .from(installmentOptions)
      .where(and(eq(installmentOptions.id, id), eq(installmentOptions.tenantId, tenantId)))
    if (!actual) return { kind: "not_found" }

    const v = validarOpcion(body, opcionValida(actual))
    if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
    const opcion = v.value

    if (opcion.paymentMethodId !== actual.paymentMethodId && !(await medioDelTenant(tx, tenantId, opcion.paymentMethodId))) {
      return { kind: "not_found" }
    }
    const choque = await chequearSuperposicion(tx, { ...opcion, id })
    if (choque) return { kind: "superpuesta", conId: choque.id }

    const [row] = await tx
      .update(installmentOptions)
      .set({ ...opcion, updatedBy: actorId, updatedAt: new Date() })
      .where(and(eq(installmentOptions.id, id), eq(installmentOptions.tenantId, tenantId)))
      .returning()
    return row ? { kind: "ok", row } : { kind: "not_found" }
  })
}

export async function borrarOpcion(tenantId: string, id: string): Promise<boolean> {
  if (!esUuid(id)) return false
  const rows = await getDb()
    .delete(installmentOptions)
    .where(and(eq(installmentOptions.id, id), eq(installmentOptions.tenantId, tenantId)))
    .returning({ id: installmentOptions.id })
  return rows.length > 0
}

// ─── Contrato v1 ─────────────────────────────────────────────────────────────────────────

/** Payload del GET interno para `tenantId` (por `tenants.id`). null si el tenant no existe. */
export async function contratoCuotasV1(tenantId: string, ahora = new Date()): Promise<ContratoCuotasV1 | null> {
  const db = getDb()
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId))
  if (!tenant) return null
  const [medios, opciones] = await Promise.all([listarMedios(tenantId), listarOpciones(tenantId)])
  return armarContratoCuotasV1({ tenant: tenant.id, medios, opciones, ahora })
}
