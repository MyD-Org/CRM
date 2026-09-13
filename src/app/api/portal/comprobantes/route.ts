import { requirePortalClient } from "@/lib/portal-route-guard"
import { createUploading, cleanupStale, countRecentForClient, listPortal } from "@/lib/payment-receipts"
import { getR2, receiptKeys } from "@/lib/r2"
import { parseInitBody, RECEIPTS_DAILY_LIMIT, RECEIPTS_HOURLY_LIMIT, UPLOAD_URL_TTL_SECONDS } from "@/lib/receipt-validation"

// POST /api/portal/comprobantes — init de la subida de un comprobante de pago.
// NO recibe bytes: valida el body, crea la fila en `uploading` y devuelve una URL PUT
// prefirmada para R2. El orden es el del design: guard → storage → validación → rate
// limit (Map 10/h) → tope diario (COUNT 24 h) → limpieza lazy → INSERT → presign.

const NO_STORE = { "Cache-Control": "private, no-store" }

// ── Rate limit por hora ─────────────────────────────────────────────────────
// Map en memoria del proceso (mismo patrón que admin/auth/login): ventana deslizante
// de 1 h por `${tenant}:${codigocliente}`. CAVEATS: por-proceso (no se comparte entre
// instancias ni deploys) y se reinicia con el proceso; el tope REAL anti-abuso es el
// diario de la DB (RECEIPTS_DAILY_LIMIT), esto solo amortigua ráfagas.
const HOURLY_WINDOW_MS = 60 * 60 * 1000

type HourlyBucket = { count: number; firstAt: number }
const hourlyAttempts = new Map<string, HourlyBucket>()

// Limpieza oportunista para acotar el tamaño del Map.
function sweepHourly(now: number) {
  for (const [key, bucket] of hourlyAttempts) {
    if (now - bucket.firstAt > HOURLY_WINDOW_MS) hourlyAttempts.delete(key)
  }
}

function hourlyLimitHit(key: string, now: number): boolean {
  const bucket = hourlyAttempts.get(key)
  return !!bucket && now - bucket.firstAt <= HOURLY_WINDOW_MS && bucket.count >= RECEIPTS_HOURLY_LIMIT
}

function recordHourlyAttempt(key: string, now: number) {
  let bucket = hourlyAttempts.get(key)
  if (!bucket || now - bucket.firstAt > HOURLY_WINDOW_MS) {
    bucket = { count: 0, firstAt: now }
  }
  bucket.count += 1
  hourlyAttempts.set(key, bucket)
}

// GET /api/portal/comprobantes?start=0 — página del historial de comprobantes del cliente
// logueado (solo `pending`/`loaded` propios). La primera página la trae el server component
// de dashboard; esto pagina el resto.
export async function GET(req: Request) {
  const guard = await requirePortalClient(req)
  if (!guard.ok) return guard.response

  const raw = new URL(req.url).searchParams.get("start") ?? "0"
  const start = Number(raw)
  if (!Number.isInteger(start) || start < 0) {
    return Response.json(
      { error: "Parámetro start inválido", code: "invalid_start" },
      { status: 400, headers: NO_STORE },
    )
  }

  try {
    const { items, total } = await listPortal(guard.tenantId, guard.session.codigocliente as string, start)
    return Response.json({ comprobantes: items, total }, { headers: NO_STORE })
  } catch (err) {
    console.error("[portal/comprobantes] list error:", err)
    return Response.json(
      { error: "No pudimos cargar tus comprobantes, intentá de nuevo en unos minutos", code: "internal_error" },
      { status: 500, headers: NO_STORE },
    )
  }
}

export async function POST(req: Request) {
  const guard = await requirePortalClient(req)
  if (!guard.ok) return guard.response

  try {
    const r2 = getR2()
    if (!r2) {
      return Response.json(
        { error: "El servicio de comprobantes no está disponible, intentá de nuevo más tarde", code: "storage_unavailable" },
        { status: 503, headers: NO_STORE },
      )
    }

    const now = new Date()
    const body = await req.json().catch(() => null)
    const parsed = parseInitBody(body, now)
    if (!parsed.ok) {
      if (parsed.status === 400) {
        return Response.json(
          { error: "Revisá los datos del formulario", code: "invalid", fields: parsed.fields },
          { status: 400, headers: NO_STORE },
        )
      }
      return Response.json({ error: parsed.error, code: parsed.code }, { status: parsed.status, headers: NO_STORE })
    }

    // El guard garantiza sesión con codigocliente (sin él responde 401 antes de acá).
    const codigocliente = guard.session.codigocliente as string

    // Rate limit: primero el Map de la hora (barato), después el COUNT del día (DB).
    const attemptKey = `${guard.tenantId}:${codigocliente}`
    const nowMs = now.getTime()
    sweepHourly(nowMs)
    if (hourlyLimitHit(attemptKey, nowMs)) {
      return Response.json(
        { error: "Informaste demasiados comprobantes en la última hora, probá de nuevo más tarde", code: "hourly_limit" },
        { status: 429, headers: NO_STORE },
      )
    }
    recordHourlyAttempt(attemptKey, nowMs)

    const recentCount = await countRecentForClient(guard.tenantId, codigocliente, now)
    if (recentCount >= RECEIPTS_DAILY_LIMIT) {
      return Response.json(
        { error: `Llegaste al límite de ${RECEIPTS_DAILY_LIMIT} comprobantes por día, probá de nuevo mañana`, code: "daily_limit" },
        { status: 429, headers: NO_STORE },
      )
    }

    await cleanupStale(guard.tenantId, now)

    // Los datos del cliente salen de la SESIÓN (tercer invariante del design): un body
    // con codigocliente/razonsocial/cuit/email distintos se ignora por completo.
    const row = await createUploading(guard.tenantId, {
      codigocliente,
      razonsocial: guard.session.razonsocial ?? "",
      cuit: guard.session.cuit ?? "",
      clientEmail: guard.session.email ?? null,
      amount: parsed.value.amount,
      paidOn: parsed.value.paidOn,
      method: parsed.value.method,
      methodOther: parsed.value.methodOther,
      notes: parsed.value.notes,
      declaredContentType: parsed.value.file.contentType,
      declaredSize: parsed.value.file.size,
    })

    const upload = await r2.presignPut(receiptKeys.tmp(guard.tenantId, row.id), {
      contentType: parsed.value.file.contentType,
      contentLength: parsed.value.file.size,
      ttlSeconds: UPLOAD_URL_TTL_SECONDS,
    })

    return Response.json(
      {
        id: row.id,
        upload: { url: upload.url, method: "PUT", headers: upload.headers, expiresAt: upload.expiresAt.toISOString() },
      },
      { status: 201, headers: NO_STORE },
    )
  } catch (err) {
    console.error("[portal/comprobantes] init error:", err)
    return Response.json(
      { error: "No pudimos preparar la subida del comprobante, intentá de nuevo en unos minutos", code: "internal_error" },
      { status: 500, headers: NO_STORE },
    )
  }
}
