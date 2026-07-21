import webpush from "web-push"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { pushSubscriptions } from "@/db/schema"
import { availableOperators } from "@/lib/assignment"

// ── Web Push ────────────────────────────────────────────────────────────────
// El CRM es dueño de las suscripciones (los operadores son usuarios del CRM) y el único que
// envía notificaciones push. ai-api solo dispara eventos vía /api/internal/inbox-events.
// Todo va GATEADO por las claves VAPID: sin env vars, esto es no-op (dev/local sin config).

export interface PushPayload {
  title: string
  body: string
  // Ruta a la que lleva el click. El service worker la abre/enfoca.
  url?: string
  // Ícono a mostrar (ruta del logo del tenant). El SW cae a un default si no viene.
  icon?: string
  // Agrupa/reemplaza notificaciones del mismo hilo (ej. no apilar 5 avisos de la misma conv).
  tag?: string
}

let configured = false

/** Configura VAPID una sola vez. Devuelve false si faltan las claves (push deshabilitado). */
function ensureConfigured(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return false
  if (!configured) {
    // El subject identifica al emisor ante el push service (mailto o URL del sitio).
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:soporte@myd-org.com", publicKey, privateKey)
    configured = true
  }
  return true
}

/**
 * Envía un push a TODAS las suscripciones de un operador (todos sus dispositivos).
 * Poda automáticamente las suscripciones muertas (404/410 = el navegador la revocó).
 * Best-effort: nunca lanza — un fallo de push no debe romper el flujo que lo disparó.
 */
export async function sendPushToOperator(tenantId: string, operatorId: string, payload: PushPayload): Promise<number> {
  if (!ensureConfigured()) return 0
  const db = getDb()
  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.tenantId, tenantId), eq(pushSubscriptions.operatorId, operatorId)))

  let delivered = 0
  const body = JSON.stringify(payload)

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        )
        delivered++
        await db
          .update(pushSubscriptions)
          .set({ lastUsedAt: new Date() })
          .where(eq(pushSubscriptions.id, sub.id))
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        // 404/410: la suscripción ya no existe en el push service → la borramos.
        if (statusCode === 404 || statusCode === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id))
        } else {
          console.error("push send error:", statusCode ?? err)
        }
      }
    }),
  )

  return delivered
}

/**
 * Envía un push a los operadores DISPONIBLES de un departamento (cola de handoff sin dueño).
 * Si no se pasa department, notifica a todos los disponibles del tenant.
 */
export async function sendPushToDepartment(
  tenantId: string,
  department: string | null,
  payload: PushPayload,
): Promise<number> {
  if (!ensureConfigured()) return 0
  const operators = await availableOperators(tenantId, department)
  const counts = await Promise.all(operators.map((op) => sendPushToOperator(tenantId, op.id, payload)))
  return counts.reduce((a, b) => a + b, 0)
}
