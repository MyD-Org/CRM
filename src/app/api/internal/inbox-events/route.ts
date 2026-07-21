import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants, conversationAssignments } from "@/db/schema"
import { bearerMatches } from "@/lib/secure-compare"
import { sendPushToDepartment, sendPushToOperator } from "@/lib/push"

// Endpoint interno: la ai-api avisa al CRM de eventos del inbox para disparar notificaciones
// push a los operadores. Auth via INTERNAL_SECRET (mismo canal que /api/internal/operators).
// El CRM es dueño de las suscripciones y decide a quién notificar; la ai-api solo dispara.
//
// Body:
//   { tenantId, event, conversationId, department?, operatorId?, contactName? }
//   - tenantId: el aiTenantId (el mismo que ya usa la ai-api en /api/internal/operators).
//   - event 'handoff': el bot derivó a humano. Si viene operatorId (pedido por nombre) se
//     notifica a esa persona; si no, a los operadores disponibles del departamento.
//   - event 'inbound': llegó un mensaje del cliente en una conversación en modo humano →
//     se notifica al operador asignado (según conversation_assignments del CRM).
export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as {
    tenantId?: string
    event?: string
    conversationId?: string
    department?: string | null
    operatorId?: string | null
    contactName?: string | null
  } | null
  if (!body?.tenantId || !body.event || !body.conversationId) {
    return Response.json({ error: "missing fields" }, { status: 400 })
  }

  const db = getDb()
  // La ai-api manda el aiTenantId; lo resolvemos al tenant del CRM (fuente de las subs).
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.aiTenantId, body.tenantId))
  if (!tenant) return Response.json({ ok: true, sent: 0 }, { status: 200 })

  const contact = body.contactName?.trim() || "un cliente"
  const url = `/admin/inbox/${body.conversationId}`
  const icon = `/logos/${tenant.id}-icon.svg`
  const tag = `${body.event}-${body.conversationId}`

  let sent = 0

  if (body.event === "handoff") {
    if (body.operatorId) {
      // Handoff a una persona puntual (assign_to_human por nombre).
      sent = await sendPushToOperator(tenant.id, body.operatorId, {
        title: "Nueva conversación asignada",
        body: `Se te derivó la conversación con ${contact}.`,
        url,
        icon,
        tag,
      })
    } else {
      // Handoff genérico a la cola de un departamento (o a todos si no hay depto).
      const dept = body.department ?? null
      sent = await sendPushToDepartment(tenant.id, dept, {
        title: "Nueva conversación en espera",
        body: dept ? `Se derivó una conversación a ${dept}.` : "Se derivó una conversación a un operador.",
        url,
        icon,
        tag,
      })
    }
  } else if (body.event === "inbound") {
    // Mensaje del cliente en modo humano → avisamos al operador asignado (si lo hay).
    const operatorId =
      body.operatorId ??
      (
        await db
          .select({ operatorId: conversationAssignments.operatorId })
          .from(conversationAssignments)
          .where(
            and(
              eq(conversationAssignments.tenantId, tenant.id),
              eq(conversationAssignments.conversationId, body.conversationId),
            ),
          )
      )[0]?.operatorId
    if (operatorId) {
      sent = await sendPushToOperator(tenant.id, operatorId, {
        title: contact,
        body: "Te escribió un mensaje.",
        url,
        icon,
        tag,
      })
    }
  } else {
    return Response.json({ error: "unknown event" }, { status: 400 })
  }

  return Response.json({ ok: true, sent })
}
