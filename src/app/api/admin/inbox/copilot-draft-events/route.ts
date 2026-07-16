import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { getDb } from "@/db"
import { copilotDraftEvents } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// Registra en el CRM cuando el operador manda un mensaje que había insertado desde el copiloto
// (botón "Copiar" con onUseMessage). El plan que motiva la métrica vive en
// docs/superpowers/plans/2026-07-16-copiar-a-draft.md: si ~80%+ de las sugerencias se envían as-is,
// pasamos ventas a bot-first.
export async function POST(req: NextRequest) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.conversation_id || typeof body.conversation_id !== "string") {
    return NextResponse.json({ error: "conversation_id requerido" }, { status: 400 })
  }
  if (body.outcome !== "as-is" && body.outcome !== "edited") {
    return NextResponse.json({ error: "outcome inválido" }, { status: 400 })
  }

  await getDb().insert(copilotDraftEvents).values({
    tenantId: session.tenantId,
    conversationId: body.conversation_id,
    operatorId: session.userId,
    outcome: body.outcome,
  })
  return NextResponse.json({ ok: true })
}
