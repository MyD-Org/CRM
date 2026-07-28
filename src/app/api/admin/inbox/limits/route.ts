import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getLimits, setLimits } from "@/lib/inbox-api"
import { botUsagePanelEnabled } from "@/lib/flags"

// Topes de uso del bot. Misma feature/flag que el panel de "Uso": los topes son un control de
// gasto de nivel plataforma → solo superadmin. El gate se repite en la ai-api (rol en el staff
// token) como defensa en profundidad.
async function requireSuperadminTenant() {
  if (!(await botUsagePanelEnabled())) {
    return { error: NextResponse.json({ error: "no encontrado" }, { status: 404 }) }
  }
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return { error: NextResponse.json({ error: "no autorizado" }, { status: 401 }) }
  if (session.role !== "superadmin") return { error: NextResponse.json({ error: "prohibido" }, { status: 403 }) }

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return { error: NextResponse.json({ error: "inbox no configurado" }, { status: 503 }) }
  }
  return { tenant, role: session.role }
}

export async function GET() {
  const { error, tenant } = await requireSuperadminTenant()
  if (error) return error
  const limits = await getLimits(tenant.aiApiUrl!, tenant.aiTenantId!)
  return NextResponse.json(limits)
}

// Valida un tope: entero >= 1, o null para quitarlo, o ausente para no tocarlo.
function readLimit(v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v
  return NaN // señal de inválido
}

export async function PATCH(req: NextRequest) {
  const { error, tenant, role } = await requireSuperadminTenant()
  if (error) return error

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body inválido" }, { status: 400 })
  }
  const messages_per_day = readLimit(body.messages_per_day)
  const tokens_per_month = readLimit(body.tokens_per_month)
  if (Number.isNaN(messages_per_day) || Number.isNaN(tokens_per_month)) {
    return NextResponse.json({ error: "los topes deben ser enteros >= 1 o null" }, { status: 400 })
  }

  const patch: { messages_per_day?: number | null; tokens_per_month?: number | null } = {}
  if (messages_per_day !== undefined) patch.messages_per_day = messages_per_day
  if (tokens_per_month !== undefined) patch.tokens_per_month = tokens_per_month

  const limits = await setLimits(tenant.aiApiUrl!, tenant.aiTenantId!, patch, role)
  return NextResponse.json(limits)
}
