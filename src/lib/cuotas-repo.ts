import { and, asc, eq, sql } from "drizzle-orm"
import { getDb } from "@/db"
import { installmentOptions, paymentConfigVersions, paymentMethods, tenants } from "@/db/schema"
import {
  armarContratoCuotasV2,
  buscarMontoRepetido,
  CODIGO_CREDITO,
  validarEscalon,
  validarProveedor,
  type ContratoCuotasV2,
  type EscalonFila,
  type EscalonValido,
  type ProveedorFila,
  type ProveedorValido,
} from "@/lib/cuotas"

// Acceso a datos de Medios de pago / Cuotas (v2: por proveedor). TODO filtra por `tenantId`
// (el del guard, nunca el del body): un id de otro tenant se comporta igual que uno inexistente
// (not_found → 404).
//
// Mapeo a las tablas de 0025 (sin columnas nuevas):
//   proveedor = payment_methods con codigo_proveedor = CODIGO_CREDITO. Las filas v1 por marca
//               (visa, master…) se ignoran en todo este módulo.
//   escalón   = installment_options; `cuotas` guarda cuotasMax. sin_interes/vigencias sin uso.
//
// "No dos escalones activos del mismo proveedor con el mismo monto mínimo" se valida dentro de
// una transacción con pg_advisory_xact_lock por proveedor. Cada escritura pisa
// payment_config_versions (misma tx) para que `actualizadoEn` del contrato cambie también con
// borrados.

type ProveedorRow = typeof paymentMethods.$inferSelect
type EscalonRow = typeof installmentOptions.$inferSelect

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const esUuid = (id: string) => UUID_RE.test(id)

type Invalido = { kind: "invalid"; campo: string; error: string }
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]

function esUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true
  }
  return false
}

async function tocarVersion(tx: Tx, tenantId: string): Promise<void> {
  const ahora = new Date()
  await tx
    .insert(paymentConfigVersions)
    .values({ tenantId, updatedAt: ahora })
    .onConflictDoUpdate({ target: paymentConfigVersions.tenantId, set: { updatedAt: ahora } })
}

// ─── DTOs (lo que ve el backoffice) ──────────────────────────────────────────────────────

export interface ProveedorDto extends ProveedorValido {
  id: string
}

export interface EscalonDto extends EscalonValido {
  id: string
  updatedAt: string
}

const aProveedorFila = (r: ProveedorRow): ProveedorFila => ({
  id: r.id,
  proveedor: r.proveedor,
  nombre: r.nombre,
  activo: r.activo,
  orden: r.orden,
  updatedAt: r.updatedAt,
})

const escalonValido = (r: EscalonRow): EscalonValido => ({
  proveedorId: r.paymentMethodId,
  cuotasMax: r.cuotas,
  montoMinimo: r.montoMinimo,
  activo: r.activo,
})

const aEscalonFila = (r: EscalonRow): EscalonFila => ({ id: r.id, ...escalonValido(r), updatedAt: r.updatedAt })

export const toProveedorDto = (r: ProveedorRow): ProveedorDto => ({
  id: r.id,
  proveedor: r.proveedor,
  nombre: r.nombre,
  activo: r.activo,
  orden: r.orden,
})

export const toEscalonDto = (r: EscalonRow): EscalonDto => ({ id: r.id, ...escalonValido(r), updatedAt: r.updatedAt.toISOString() })

// ─── Proveedores ─────────────────────────────────────────────────────────────────────────

const esProveedorV2 = eq(paymentMethods.codigoProveedor, CODIGO_CREDITO)

export async function listarProveedores(tenantId: string): Promise<ProveedorRow[]> {
  return getDb()
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.tenantId, tenantId), esProveedorV2))
    .orderBy(asc(paymentMethods.orden), asc(paymentMethods.nombre))
}

export type ResultadoProveedor = { kind: "ok"; row: ProveedorRow } | { kind: "duplicado" } | { kind: "not_found" } | Invalido

export async function crearProveedor(tenantId: string, body: unknown): Promise<ResultadoProveedor> {
  const v = validarProveedor(body)
  if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
  try {
    return await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({ tenantId, codigoProveedor: CODIGO_CREDITO, ...v.value })
        .returning()
      await tocarVersion(tx, tenantId)
      return { kind: "ok", row: row as ProveedorRow }
    })
  } catch (err) {
    if (esUniqueViolation(err)) return { kind: "duplicado" }
    throw err
  }
}

export async function actualizarProveedor(tenantId: string, id: string, body: unknown): Promise<ResultadoProveedor> {
  if (!esUuid(id)) return { kind: "not_found" }
  const donde = and(eq(paymentMethods.id, id), eq(paymentMethods.tenantId, tenantId), esProveedorV2)
  try {
    return await getDb().transaction(async (tx) => {
      const [actual] = await tx.select().from(paymentMethods).where(donde)
      if (!actual) return { kind: "not_found" }

      const v = validarProveedor(body, toProveedorDto(actual))
      if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
      const [row] = await tx
        .update(paymentMethods)
        .set({ ...v.value, updatedAt: new Date() })
        .where(donde)
        .returning()
      if (!row) return { kind: "not_found" }
      await tocarVersion(tx, tenantId)
      return { kind: "ok", row }
    })
  } catch (err) {
    if (esUniqueViolation(err)) return { kind: "duplicado" }
    throw err
  }
}

// ─── Escalones ───────────────────────────────────────────────────────────────────────────

export async function listarEscalones(tenantId: string): Promise<EscalonRow[]> {
  const rows = await getDb()
    .select({ escalon: installmentOptions })
    .from(installmentOptions)
    .innerJoin(paymentMethods, eq(paymentMethods.id, installmentOptions.paymentMethodId))
    .where(and(eq(installmentOptions.tenantId, tenantId), esProveedorV2))
    .orderBy(asc(installmentOptions.paymentMethodId), asc(installmentOptions.montoMinimo), asc(installmentOptions.cuotas))
  return rows.map((r) => r.escalon)
}

export type ResultadoEscalon =
  | { kind: "ok"; row: EscalonRow }
  | { kind: "not_found" }
  | { kind: "monto_repetido"; conId: string }
  | Invalido

/** Bloquea el proveedor (dentro de la tx) y busca un escalón activo con el mismo monto mínimo. */
async function chequearMontoRepetido(tx: Tx, candidato: EscalonValido & { id?: string }) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${candidato.proveedorId}))`)
  const existentes = await tx
    .select({ id: installmentOptions.id, montoMinimo: installmentOptions.montoMinimo, activo: installmentOptions.activo })
    .from(installmentOptions)
    .where(eq(installmentOptions.paymentMethodId, candidato.proveedorId))
  return buscarMontoRepetido(candidato, existentes)
}

async function proveedorDelTenant(tx: Tx, tenantId: string, proveedorId: string): Promise<boolean> {
  if (!esUuid(proveedorId)) return false
  const [p] = await tx
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.id, proveedorId), eq(paymentMethods.tenantId, tenantId), esProveedorV2))
  return Boolean(p)
}

/** Columnas de installment_options para un escalón (los campos v1 quedan en su default). */
const columnas = (e: EscalonValido) => ({
  paymentMethodId: e.proveedorId,
  cuotas: e.cuotasMax,
  montoMinimo: e.montoMinimo,
  activo: e.activo,
})

export async function crearEscalon(tenantId: string, body: unknown, actorId: string): Promise<ResultadoEscalon> {
  const v = validarEscalon(body)
  if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
  const escalon = v.value

  return getDb().transaction(async (tx) => {
    if (!(await proveedorDelTenant(tx, tenantId, escalon.proveedorId))) return { kind: "not_found" }
    const choque = await chequearMontoRepetido(tx, escalon)
    if (choque) return { kind: "monto_repetido", conId: choque.id }
    const [row] = await tx
      .insert(installmentOptions)
      .values({ tenantId, ...columnas(escalon), updatedBy: actorId })
      .returning()
    await tocarVersion(tx, tenantId)
    return { kind: "ok", row: row as EscalonRow }
  })
}

export async function actualizarEscalon(
  tenantId: string,
  id: string,
  body: unknown,
  actorId: string,
): Promise<ResultadoEscalon> {
  if (!esUuid(id)) return { kind: "not_found" }

  return getDb().transaction(async (tx) => {
    const [actual] = await tx
      .select({ escalon: installmentOptions })
      .from(installmentOptions)
      .innerJoin(paymentMethods, eq(paymentMethods.id, installmentOptions.paymentMethodId))
      .where(and(eq(installmentOptions.id, id), eq(installmentOptions.tenantId, tenantId), esProveedorV2))
    if (!actual) return { kind: "not_found" }

    const v = validarEscalon(body, escalonValido(actual.escalon))
    if (!v.ok) return { kind: "invalid", campo: v.campo, error: v.error }
    const escalon = v.value

    if (escalon.proveedorId !== actual.escalon.paymentMethodId && !(await proveedorDelTenant(tx, tenantId, escalon.proveedorId))) {
      return { kind: "not_found" }
    }
    const choque = await chequearMontoRepetido(tx, { ...escalon, id })
    if (choque) return { kind: "monto_repetido", conId: choque.id }

    const [row] = await tx
      .update(installmentOptions)
      .set({ ...columnas(escalon), updatedBy: actorId, updatedAt: new Date() })
      .where(and(eq(installmentOptions.id, id), eq(installmentOptions.tenantId, tenantId)))
      .returning()
    if (!row) return { kind: "not_found" }
    await tocarVersion(tx, tenantId)
    return { kind: "ok", row }
  })
}

export async function borrarEscalon(tenantId: string, id: string): Promise<boolean> {
  if (!esUuid(id)) return false
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .delete(installmentOptions)
      .where(
        and(
          eq(installmentOptions.id, id),
          eq(installmentOptions.tenantId, tenantId),
          sql`${installmentOptions.paymentMethodId} in (select ${paymentMethods.id} from ${paymentMethods} where ${esProveedorV2})`,
        ),
      )
      .returning({ id: installmentOptions.id })
    if (rows.length === 0) return false
    await tocarVersion(tx, tenantId)
    return true
  })
}

// ─── Contrato v2 ─────────────────────────────────────────────────────────────────────────

/** Payload del GET interno para `tenantId` (por `tenants.id`). null si el tenant no existe. */
export async function contratoCuotasV2(tenantId: string, ahora = new Date()): Promise<ContratoCuotasV2 | null> {
  const db = getDb()
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId))
  if (!tenant) return null
  const [proveedores, escalones, [version]] = await Promise.all([
    listarProveedores(tenantId),
    listarEscalones(tenantId),
    db
      .select({ updatedAt: paymentConfigVersions.updatedAt })
      .from(paymentConfigVersions)
      .where(eq(paymentConfigVersions.tenantId, tenantId)),
  ])
  return armarContratoCuotasV2({
    tenant: tenant.id,
    proveedores: proveedores.map(aProveedorFila),
    escalones: escalones.map(aEscalonFila),
    configActualizadaEn: version?.updatedAt ?? null,
    ahora,
  })
}
