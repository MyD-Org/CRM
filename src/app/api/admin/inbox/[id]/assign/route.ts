import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { listConversations } from "@/lib/inbox-api"
import { assignInCrm, availableOperators, getAssignments, loadFromAssignments, pickLeastLoaded } from "@/lib/assignment"
import { sendPushToOperator } from "@/lib/push"

// POST /api/admin/inbox/:id/assign
//
// Cuerpos aceptados:
//   { operatorId: string }                            → asigna a ese operador directamente (por UUID)
//   { strategy: "least-loaded", department?: string } → elige al operador con menos
//                                                       conversaciones activas asignadas;
//                                                       si se pasa department filtra por él
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "body requerido" }, { status: 400 })

  const db = getDb()
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  let targetOperatorId: string

  // Depto de la conversación (lo etiquetó el bot en ai-api): lo usamos para elegir
  // candidatos y para guardarlo como snapshot en la asignación del CRM.
  const convs = await listConversations(tenant.aiApiUrl, tenant.aiTenantId).catch(() => [])
  const conv = convs.find((c) => c.id === id)
  const convDepartment = conv?.assigned_department ?? null

  if (typeof body.operatorId === "string" && body.operatorId.trim()) {
    targetOperatorId = body.operatorId.trim()
  } else if (body.strategy === "least-loaded") {
    // Mismo criterio que la reconciliación automática (ADR 0006): operadores DISPONIBLES
    // del depto + menos cargado. La carga se cuenta desde la DB del CRM (fuente de verdad).
    const operators = await availableOperators(session.tenantId, body.department ?? null)
    if (!operators.length) {
      const reason = body.department
        ? `no hay operadores disponibles en el departamento "${body.department}"`
        : "no hay operadores disponibles"
      return NextResponse.json({ error: reason }, { status: 404 })
    }

    const assignments = await getAssignments(session.tenantId)
    const activeConvIds = new Set(convs.filter((c) => c.status !== "closed").map((c) => c.id))
    const chosen = pickLeastLoaded(operators, loadFromAssignments(assignments, activeConvIds))
    targetOperatorId = chosen!.id
  } else {
    return NextResponse.json(
      { error: "Se requiere operatorId o strategy='least-loaded'" },
      { status: 400 },
    )
  }

  await assignInCrm(session.tenantId, id, targetOperatorId, body.department ?? convDepartment)

  // Notifica al operador asignado (salvo que se haya autoasignado: ya lo sabe). Best-effort.
  if (targetOperatorId !== session.userId) {
    const contactName = conv?.contact || "un cliente"
    await sendPushToOperator(session.tenantId, targetOperatorId, {
      title: "Nueva conversación asignada",
      body: `Se te asignó la conversación con ${contactName}.`,
      url: `/admin/inbox/${id}`,
      icon: `/logos/${tenant.id}-icon.svg`,
      tag: `assign-${id}`,
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true, assigned_operator_id: targetOperatorId })
}
