import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq, isNotNull } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { assignConversation, listConversations } from "@/lib/inbox-api"

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

  if (typeof body.operatorId === "string" && body.operatorId.trim()) {
    targetOperatorId = body.operatorId.trim()
  } else if (body.strategy === "least-loaded") {
    const conditions = [
      eq(adminUsers.tenantId, session.tenantId),
      isNotNull(adminUsers.passwordHash),
    ]
    if (body.department) {
      conditions.push(eq(adminUsers.department, body.department))
    }

    const operators = await db.select({ id: adminUsers.id })
      .from(adminUsers)
      .where(and(...conditions))

    if (!operators.length) {
      const reason = body.department
        ? `no hay operadores activos en el departamento "${body.department}"`
        : "no hay operadores activos"
      return NextResponse.json({ error: reason }, { status: 404 })
    }

    const convs = await listConversations(tenant.aiApiUrl, tenant.aiTenantId)

    const loadMap = new Map<string, number>()
    for (const op of operators) loadMap.set(op.id, 0)
    for (const conv of convs) {
      if (conv.assigned_operator_id && loadMap.has(conv.assigned_operator_id)) {
        loadMap.set(conv.assigned_operator_id, (loadMap.get(conv.assigned_operator_id) ?? 0) + 1)
      }
    }

    let minLoad = Infinity
    let chosen = operators[0].id
    for (const op of operators) {
      const load = loadMap.get(op.id) ?? 0
      if (load < minLoad) { minLoad = load; chosen = op.id }
    }
    targetOperatorId = chosen
  } else {
    return NextResponse.json(
      { error: "Se requiere operatorId o strategy='least-loaded'" },
      { status: 400 },
    )
  }

  await assignConversation(tenant.aiApiUrl, tenant.aiTenantId, id, targetOperatorId)
  return NextResponse.json({ ok: true, assigned_operator_id: targetOperatorId })
}
