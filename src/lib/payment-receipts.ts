// Repositorio de payment_receipts. La fila es una MÁQUINA DE ESTADOS: cada transición es un
// UPDATE condicional con WHERE status = … RETURNING (sin read-then-write), lo que da
// idempotencia y exclusión mutua sin locks explícitos (ver D3/D4 del design). TODA lectura y
// escritura filtra tenant_id (y el id): un id de otro tenant se comporta como inexistente.
//
// amount llega de drizzle como string decimal ("12345.67"): se persiste y serializa tal cual,
// nunca se parsea a float para guardar.

import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, paymentReceipts } from "@/db/schema"
import { CONFIRM_LEASE_SECONDS, EMAIL_LEASE_SECONDS } from "@/lib/receipt-validation"

export type PaymentReceiptRow = typeof paymentReceipts.$inferSelect

/** Estados internos, NUNCA visibles en portal ni admin. */
export const VISIBLE_STATUSES = ["pending", "loaded"] as const

/** Límite duro del repo para `listAdmin` (la ruta puede pedir menos, no más). */
export const ADMIN_LIST_MAX_LIMIT = 50
export const ADMIN_LIST_DEFAULT_LIMIT = 25

/** "Mail no enviado" staleness: email pending informado hace más de 5 minutos. */
export const EMAIL_STALE_MS = 5 * 60 * 1000

/** email_error se trunca a esto (design: ≤500 chars, sin secretos). */
export const EMAIL_ERROR_MAX_CHARS = 500

const DAY_MS = 24 * 60 * 60 * 1000
/** Limpieza lazy: uploading huérfano > 1 día, rejected > 30 días (spec). */
const UPLOADING_STALE_MS = DAY_MS
const REJECTED_STALE_MS = 30 * DAY_MS

// ---------------------------------------------------------------------------
// Insert / mantenimiento
// ---------------------------------------------------------------------------

export interface CreateUploadingInput {
  codigocliente: string
  razonsocial: string
  cuit: string
  clientEmail: string | null
  /** Decimal string ya validado ("150000.50"). */
  amount: string
  /** "YYYY-MM-DD". */
  paidOn: string
  method: string
  methodOther: string | null
  notes: string | null
  declaredContentType: string
  declaredSize: number
}

/** Crea la fila en `uploading` (los datos del cliente salen de la sesión, no del body crudo). */
export async function createUploading(tenantId: string, input: CreateUploadingInput): Promise<PaymentReceiptRow> {
  const [row] = await getDb()
    .insert(paymentReceipts)
    .values({ tenantId, ...input, status: "uploading" })
    .returning()
  return row
}

/** Limpieza lazy (corre en el init): borra del tenant los uploading viejos y los rejected. */
export async function cleanupStale(tenantId: string, now: Date): Promise<void> {
  const uploadingBefore = new Date(now.getTime() - UPLOADING_STALE_MS)
  const rejectedBefore = new Date(now.getTime() - REJECTED_STALE_MS)
  await getDb()
    .delete(paymentReceipts)
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      or(
        and(eq(paymentReceipts.status, "uploading"), lt(paymentReceipts.createdAt, uploadingBefore)),
        and(eq(paymentReceipts.status, "rejected"), lt(paymentReceipts.createdAt, rejectedBefore)),
      ),
    ))
}

/** Filas no-`uploading` del cliente en las últimas 24 h (tope diario anti-abuso; incluye
 *  `rejected`, que cuenta contra la cuota). */
export async function countRecentForClient(
  tenantId: string,
  codigocliente: string,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS)
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentReceipts)
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.codigocliente, codigocliente),
      ne(paymentReceipts.status, "uploading"),
      gte(paymentReceipts.createdAt, since),
    ))
  return row?.count ?? 0
}

// ---------------------------------------------------------------------------
// Máquina de estados del confirm (lease 120 s)
// ---------------------------------------------------------------------------

/**
 * CLAIM del confirm: `uploading → processing` (o retoma un `processing` con el lease vencido).
 * UPDATE condicional — el que actualiza una fila es el único que la "tiene".
 */
export async function claimForConfirm(
  tenantId: string,
  codigocliente: string,
  id: string,
  now: Date,
): Promise<PaymentReceiptRow | null> {
  const leaseExpiredBefore = new Date(now.getTime() - CONFIRM_LEASE_SECONDS * 1000)
  const [row] = await getDb()
    .update(paymentReceipts)
    .set({ status: "processing", processingStartedAt: now, updatedAt: now })
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.codigocliente, codigocliente),
      eq(paymentReceipts.id, id),
      or(
        eq(paymentReceipts.status, "uploading"),
        and(eq(paymentReceipts.status, "processing"), lt(paymentReceipts.processingStartedAt, leaseExpiredBefore)),
      ),
    ))
    .returning()
  return row ?? null
}

/** Lectura cruzada tras un claim fallido (para decidir idempotente / in_progress / rechazo). */
export async function findForClient(
  tenantId: string,
  codigocliente: string,
  id: string,
): Promise<PaymentReceiptRow | null> {
  const [row] = await getDb()
    .select()
    .from(paymentReceipts)
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.codigocliente, codigocliente),
      eq(paymentReceipts.id, id),
    ))
  return row ?? null
}

/** Libera el lease de un confirm interrumpido: `processing → uploading` (reintentable). */
export async function release(tenantId: string, id: string, now: Date): Promise<boolean> {
  const rows = await getDb()
    .update(paymentReceipts)
    .set({ status: "uploading", processingStartedAt: null, updatedAt: now })
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.id, id),
      eq(paymentReceipts.status, "processing"),
    ))
    .returning({ id: paymentReceipts.id })
  return rows.length > 0
}

/** Rechazo: `processing → rejected`, con el código del motivo en `reject_reason` (auditoría
 *  y para responder un reintento con el mismo error; no se resucita). */
export async function reject(
  tenantId: string,
  id: string,
  reason: string,
  now: Date,
): Promise<void> {
  await getDb()
    .update(paymentReceipts)
    .set({ status: "rejected", rejectReason: reason, processingStartedAt: null, updatedAt: now })
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.id, id),
      eq(paymentReceipts.status, "processing"),
    ))
}

export interface PublishFields {
  fileKey: string
  fileMime: string
  fileSize: number
  fileSha256: string
  convertedFrom: string | null
}

/**
 * Publicación: `processing → pending` + los datos verificados del archivo. Exige seguir en
 * `processing`: 0 filas ⇒ el lease se perdió (otro confirm publicó) y el llamador responde
 * `in_progress`, sin mail.
 */
export async function publish(
  tenantId: string,
  id: string,
  fields: PublishFields,
  at: Date,
): Promise<PaymentReceiptRow | null> {
  const [row] = await getDb()
    .update(paymentReceipts)
    .set({
      status: "pending",
      processingStartedAt: null,
      fileKey: fields.fileKey,
      fileMime: fields.fileMime,
      fileSize: fields.fileSize,
      fileSha256: fields.fileSha256,
      convertedFrom: fields.convertedFrom,
      submittedAt: at,
      updatedAt: at,
    })
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.id, id),
      eq(paymentReceipts.status, "processing"),
    ))
    .returning()
  return row ?? null
}

// ---------------------------------------------------------------------------
// Backoffice (solo `pending`/`loaded` son visibles)
// ---------------------------------------------------------------------------

export type AdminListStatus = "pending" | "loaded" | "all"

export interface ListAdminFilter {
  /** Default "pending". "all" = pending + loaded. */
  status?: AdminListStatus
  /** "failed" = mail no enviado: failed/skipped, o pending con submitted_at hace >5 min. */
  email?: "failed"
  start?: number
  /** Default 25, máximo ADMIN_LIST_MAX_LIMIT. */
  limit?: number
}

function failedEmailCondition(now: Date): SQL {
  const staleBefore = new Date(now.getTime() - EMAIL_STALE_MS)
  return or(
    inArray(paymentReceipts.emailStatus, ["failed", "skipped"]),
    and(eq(paymentReceipts.emailStatus, "pending"), lt(paymentReceipts.submittedAt, staleBefore)),
  )!
}

export async function listAdmin(
  tenantId: string,
  filter: ListAdminFilter,
  now: Date,
): Promise<{ items: PaymentReceiptRow[]; total: number }> {
  const status = filter.status ?? "pending"
  const start = Math.max(0, Math.trunc(filter.start ?? 0))
  const limit = Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, Math.trunc(filter.limit ?? ADMIN_LIST_DEFAULT_LIMIT)))

  const conditions: SQL[] = [eq(paymentReceipts.tenantId, tenantId)]
  if (status === "all") {
    conditions.push(inArray(paymentReceipts.status, [...VISIBLE_STATUSES]))
  } else {
    conditions.push(eq(paymentReceipts.status, status))
  }
  if (filter.email === "failed") {
    conditions.push(failedEmailCondition(now))
  }
  const where = and(...conditions)

  const [items, count] = await Promise.all([
    getDb()
      .select()
      .from(paymentReceipts)
      .where(where)
      .orderBy(desc(paymentReceipts.submittedAt), desc(paymentReceipts.id))
      .limit(limit)
      .offset(start),
    getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentReceipts)
      .where(where),
  ])
  return { items, total: count[0]?.count ?? 0 }
}

/** Detalle admin: SOLO `pending`/`loaded` — uploading/processing/rejected son invisibles. */
export async function getAdmin(tenantId: string, id: string): Promise<PaymentReceiptRow | null> {
  const [row] = await getDb()
    .select()
    .from(paymentReceipts)
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.id, id),
      inArray(paymentReceipts.status, [...VISIBLE_STATUSES]),
    ))
  return row ?? null
}

export type SetLoadedResult =
  | { kind: "updated"; row: PaymentReceiptRow }
  | { kind: "already"; row: PaymentReceiptRow }
  | { kind: "not_found" }

/**
 * Marcar cargado en Alegra / deshacer (pending↔loaded), idempotente. El UPDATE es condicional
 * al estado origen; si no afectó filas y la fila YA estaba en el destino, es un re-envío del
 * PATCH (200 igual). Cualquier otra cosa (incluido un estado invisible) ⇒ not_found.
 * `loaded_by_name` se lee de la DB (fila fresca del admin, no de la cookie).
 * El "deshacer" pone loaded_at/loaded_by en NULL pero CONSERVA loaded_by_name (auditoría).
 */
export async function setLoaded(
  tenantId: string,
  id: string,
  to: "loaded" | "pending",
  adminUserId: string,
  now: Date,
): Promise<SetLoadedResult> {
  const from = to === "loaded" ? "pending" : "loaded"
  const set =
    to === "loaded"
      ? {
          status: "loaded",
          loadedAt: now,
          loadedBy: adminUserId,
          loadedByName: await adminName(tenantId, adminUserId),
          updatedAt: now,
        }
      : {
          status: "pending",
          loadedAt: null,
          loadedBy: null,
          updatedAt: now,
        }
  const [row] = await getDb()
    .update(paymentReceipts)
    .set(set)
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.id, id),
      eq(paymentReceipts.status, from),
    ))
    .returning()
  if (row) return { kind: "updated", row }

  const current = await getAdmin(tenantId, id)
  if (current && current.status === to) return { kind: "already", row: current }
  return { kind: "not_found" }
}

async function adminName(tenantId: string, userId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ name: adminUsers.name })
    .from(adminUsers)
    .where(and(eq(adminUsers.id, userId), eq(adminUsers.tenantId, tenantId)))
  return row?.name ?? null
}

export interface MarkLoadedFromAlegraInput {
  /** Id numérico del pago creado en Alegra. */
  alegraPaymentId: number
  /** Número legible del pago en Alegra (recibo de caja), si la cuenta lo numeró. */
  alegraPaymentNumber: string | null
  /** Monto FINAL cargado (normalizado "12345.67"); puede corregir al declarado. */
  amount: string
  /** Fecha final "YYYY-MM-DD"; puede corregir a la declarada. */
  paidOn: string
  /** Lo declarado originalmente, SOLO cuando difiere de lo corregido (auditoría). */
  declaredAmount: string | null
  declaredPaidOn: string | null
  adminUserId: string
}

/**
 * Marca el comprobante como cargado CON pago real en Alegra. La guarda anti-duplicados en
 * Alegra (que no tiene idempotency-key) es este UPDATE condicional: solo aplica mientras la
 * fila siga sin `alegra_payment_id` y visible (pending/loaded). 0 filas ⇒ alguien cargó
 * antes (o la fila no existe): null, y el llamador responde 409 sin pisar nada.
 */
export async function markLoadedFromAlegra(
  tenantId: string,
  id: string,
  data: MarkLoadedFromAlegraInput,
  now: Date,
): Promise<PaymentReceiptRow | null> {
  const [row] = await getDb()
    .update(paymentReceipts)
    .set({
      status: "loaded",
      loadedAt: now,
      loadedBy: data.adminUserId,
      loadedByName: await adminName(tenantId, data.adminUserId),
      amount: data.amount,
      paidOn: data.paidOn,
      declaredAmount: data.declaredAmount,
      declaredPaidOn: data.declaredPaidOn,
      alegraPaymentId: data.alegraPaymentId,
      alegraPaymentNumber: data.alegraPaymentNumber,
      updatedAt: now,
    })
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.id, id),
      isNull(paymentReceipts.alegraPaymentId),
      inArray(paymentReceipts.status, [...VISIBLE_STATUSES]),
    ))
    .returning()
  return row ?? null
}

// ---------------------------------------------------------------------------
// Mail (lease propio de 60 s, D4)
// ---------------------------------------------------------------------------

/**
 * Toma el lease de envío: sube `email_attempts` y pisa `email_last_attempt_at`, SOLO si la
 * fila está en `pending`/`loaded` y no hay un intento en los últimos 60 s. Devuelve el número
 * de intento (para el idempotencyKey) o null si el lease está ocupado / la fila no aplica.
 */
export async function claimEmailAttempt(tenantId: string, id: string, now: Date): Promise<number | null> {
  const leaseExpiredBefore = new Date(now.getTime() - EMAIL_LEASE_SECONDS * 1000)
  const [row] = await getDb()
    .update(paymentReceipts)
    .set({
      emailAttempts: sql`${paymentReceipts.emailAttempts} + 1`,
      emailLastAttemptAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.id, id),
      inArray(paymentReceipts.status, [...VISIBLE_STATUSES]),
      or(isNull(paymentReceipts.emailLastAttemptAt), lt(paymentReceipts.emailLastAttemptAt, leaseExpiredBefore)),
    ))
    .returning({ attempts: paymentReceipts.emailAttempts })
  return row?.attempts ?? null
}

export type EmailDeliveryOutcome =
  | { status: "sent" }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string }

/** Persiste el resultado del envío. `error` se trunca a EMAIL_ERROR_MAX_CHARS. */
export async function recordEmailResult(
  tenantId: string,
  id: string,
  outcome: EmailDeliveryOutcome,
  now: Date,
): Promise<void> {
  const errorText =
    outcome.status === "failed" ? outcome.error : outcome.status === "skipped" ? outcome.reason : null
  await getDb()
    .update(paymentReceipts)
    .set({
      emailStatus: outcome.status,
      emailError: errorText ? errorText.slice(0, EMAIL_ERROR_MAX_CHARS) : null,
      emailSentAt: outcome.status === "sent" ? now : null,
      updatedAt: now,
    })
    .where(and(eq(paymentReceipts.tenantId, tenantId), eq(paymentReceipts.id, id)))
}

// ---------------------------------------------------------------------------
// DTO admin (sin file_key, file_sha256 ni URLs firmadas)
// ---------------------------------------------------------------------------

export interface AdminReceiptDto {
  id: string
  submittedAt: string
  codigocliente: string
  razonsocial: string
  cuit: string
  clientEmail: string | null
  amount: string
  currency: "ARS"
  paidOn: string
  method: string
  methodOther: string | null
  notes: string | null
  status: "pending" | "loaded"
  file: { mime: string; size: number; originalName: string | null; convertedFrom: string | null }
  email: {
    status: "pending" | "sent" | "failed" | "skipped"
    error: string | null
    sentAt: string | null
    attempts: number
    stale: boolean
  }
  loaded: { at: string; byName: string | null } | null
  /** Pago real creado en Alegra desde el backoffice; null = cargado a mano (solo status). */
  alegra: { id: number; number: string | null } | null
  /** Lo que el cliente declaró, cuando el admin corrigió monto/fecha al cargar. */
  declared: { amount: string; paidOn: string } | null
}

/** Serializa una fila (pending/loaded) al DTO del backoffice. Sin file_key, file_sha256 ni
 *  URLs firmadas: el archivo se ve por la ruta /file (302), nunca por datos en el listado. */
export function toAdminDto(row: PaymentReceiptRow, now: Date): AdminReceiptDto {
  const submittedAt = row.submittedAt
  const stale =
    row.emailStatus === "pending" &&
    submittedAt !== null &&
    submittedAt.getTime() < now.getTime() - EMAIL_STALE_MS
  return {
    id: row.id,
    submittedAt: submittedAt ? submittedAt.toISOString() : "",
    codigocliente: row.codigocliente,
    razonsocial: row.razonsocial,
    cuit: row.cuit,
    clientEmail: row.clientEmail,
    amount: row.amount,
    currency: "ARS",
    paidOn: row.paidOn,
    method: row.method,
    methodOther: row.methodOther,
    notes: row.notes,
    status: row.status as AdminReceiptDto["status"],
    file: {
      mime: row.fileMime ?? "",
      size: row.fileSize ?? 0,
      originalName: row.fileOriginalName,
      convertedFrom: row.convertedFrom,
    },
    email: {
      status: row.emailStatus as AdminReceiptDto["email"]["status"],
      error: row.emailError,
      sentAt: row.emailSentAt ? row.emailSentAt.toISOString() : null,
      attempts: row.emailAttempts,
      stale,
    },
    loaded: row.loadedAt ? { at: row.loadedAt.toISOString(), byName: row.loadedByName } : null,
    alegra: row.alegraPaymentId !== null ? { id: row.alegraPaymentId, number: row.alegraPaymentNumber } : null,
    declared:
      row.declaredAmount !== null && row.declaredPaidOn !== null
        ? { amount: row.declaredAmount, paidOn: row.declaredPaidOn }
        : null,
  }
}

// ---------------------------------------------------------------------------
// Portal (historial del cliente)
// ---------------------------------------------------------------------------

export interface PortalReceiptDto {
  id: string
  submittedAt: string
  paidOn: string
  amount: string
  currency: "ARS"
  method: string
  methodOther: string | null
  status: "pending" | "loaded"
  fileOriginalName: string | null
}

/** Tamaño de página del historial del portal (página corta: cada fila se expande en mobile). */
export const PORTAL_PAGE_SIZE = 10

function toPortalDto(row: PaymentReceiptRow): PortalReceiptDto {
  return {
    id: row.id,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : "",
    paidOn: row.paidOn,
    amount: row.amount,
    currency: "ARS",
    method: row.method,
    methodOther: row.methodOther,
    status: row.status as PortalReceiptDto["status"],
    fileOriginalName: row.fileOriginalName,
  }
}

/** Página del historial del cliente: SOLO `pending`/`loaded` propios (tenant+codigocliente
 *  de la sesión), más recientes primero. Sin file_key/file_sha256 ni nada del mail/admin. */
export async function listPortal(
  tenantId: string,
  codigocliente: string,
  start: number,
): Promise<{ items: PortalReceiptDto[]; total: number }> {
  const where = and(
    eq(paymentReceipts.tenantId, tenantId),
    eq(paymentReceipts.codigocliente, codigocliente),
    inArray(paymentReceipts.status, [...VISIBLE_STATUSES]),
  )
  const [rows, count] = await Promise.all([
    getDb()
      .select()
      .from(paymentReceipts)
      .where(where)
      .orderBy(desc(paymentReceipts.submittedAt), desc(paymentReceipts.id))
      .limit(PORTAL_PAGE_SIZE)
      .offset(start),
    getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentReceipts)
      .where(where),
  ])
  return { items: rows.map(toPortalDto), total: count[0]?.count ?? 0 }
}

/** Aviso de duplicado: mismo tenant+cliente, mismo sha256 ya publicado, otro id. Devuelve
 *  el más reciente de los anteriores (el confirm lo informa sin bloquear). Los estados
 *  internos no tienen sha256 (solo se setea al publicar), pero el filtro queda explícito. */
export async function findDuplicateBySha(
  tenantId: string,
  codigocliente: string,
  sha256: string,
  excludeId: string,
): Promise<{ id: string; submittedAt: Date } | null> {
  const [row] = await getDb()
    .select({ id: paymentReceipts.id, submittedAt: paymentReceipts.submittedAt })
    .from(paymentReceipts)
    .where(and(
      eq(paymentReceipts.tenantId, tenantId),
      eq(paymentReceipts.codigocliente, codigocliente),
      eq(paymentReceipts.fileSha256, sha256),
      ne(paymentReceipts.id, excludeId),
      inArray(paymentReceipts.status, [...VISIBLE_STATUSES]),
    ))
    .orderBy(desc(paymentReceipts.submittedAt))
    .limit(1)
  if (!row?.submittedAt) return null
  return { id: row.id, submittedAt: row.submittedAt }
}
