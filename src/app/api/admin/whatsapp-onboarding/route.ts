import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// Genera el link de Embedded Signup para conectar un número de WhatsApp.
//
// Sirve para los dos modelos: un número más para el propio tenant (Central Led), o el
// número de una empresa cliente (Avantec como tech provider). Lo único que cambia es el
// tenantId que se manda, y por eso es superadmin: emitir un link para OTRO tenant es
// poder enchufar un número en la cuenta de otro cliente.
//
// El link lo firma la ai-api, no el CRM: la clave de firma vive en un solo lado.
async function requireSuperadmin() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return { error: NextResponse.json({ error: "no autorizado" }, { status: 401 }) }
  if (session.role !== "superadmin") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) }

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiApiUrl) {
    return { error: NextResponse.json({ error: "canal no configurado" }, { status: 503 }) }
  }
  return { aiApiUrl: tenant.aiApiUrl, ownAiTenantId: tenant.aiTenantId }
}

export async function POST(req: NextRequest) {
  const ctx = await requireSuperadmin()
  if ("error" in ctx) return ctx.error

  const body = (await req.json().catch(() => null)) as
    | { tenantId?: string; metaAppSlug?: string }
    | null
  if (!body?.metaAppSlug) return NextResponse.json({ error: "falta metaAppSlug" }, { status: 400 })

  // Sin tenantId explícito, el alta es para el tenant de la sesión (el caso "otro número
  // para nosotros mismos"), que es el default seguro.
  const tenantId = body.tenantId ?? ctx.ownAiTenantId
  if (!tenantId) return NextResponse.json({ error: "falta tenantId" }, { status: 400 })

  const res = await fetch(`${ctx.aiApiUrl.replace(/\/$/, "")}/onboarding/whatsapp/links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.INTERNAL_SECRET ?? ""}`,
    },
    body: JSON.stringify({ tenantId, metaAppSlug: body.metaAppSlug }),
    cache: "no-store",
  })
  const text = await res.text()
  return new NextResponse(text, { status: res.status, headers: { "content-type": "application/json" } })
}
