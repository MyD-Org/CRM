import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { listTemplatesRaw, createTemplateRaw } from "@/lib/inbox-api"

// Gestión de plantillas: acción sensible (crea recursos en Meta), solo superadmin.
async function requireSuperadmin() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return { error: NextResponse.json({ error: "no autorizado" }, { status: 401 }) }
  if (session.role !== "superadmin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) }

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return { error: NextResponse.json({ error: "canal no configurado" }, { status: 503 }) }
  }
  return { role: session.role, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId }
}

// Reenvía la respuesta de ai-api tal cual (status + JSON) para conservar el detalle de un
// rechazo de Meta (422 meta_rejected) y demás errores.
async function forward(res: Response): Promise<NextResponse> {
  const text = await res.text()
  return new NextResponse(text, { status: res.status, headers: { "content-type": "application/json" } })
}

// GET /api/admin/templates — lista (reconciliando contra Meta primero).
export async function GET() {
  const ctx = await requireSuperadmin()
  if ("error" in ctx) return ctx.error
  return forward(await listTemplatesRaw(ctx.aiApiUrl, ctx.aiTenantId, ctx.role, true))
}

// POST /api/admin/templates — crea una plantilla.
export async function POST(req: NextRequest) {
  const ctx = await requireSuperadmin()
  if ("error" in ctx) return ctx.error
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "body inválido" }, { status: 400 })
  return forward(await createTemplateRaw(ctx.aiApiUrl, ctx.aiTenantId, ctx.role, body))
}
