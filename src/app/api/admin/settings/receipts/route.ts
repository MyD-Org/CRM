import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { requireAdminPlus } from "@/lib/admin-route-guard"
import { parseReceiptsEmail } from "@/lib/receipt-validation"

// GET/PUT /api/admin/settings/receipts — mail destino de los avisos de comprobantes
// (Configuración → Comprobantes). Un solo email o vacío ("" = feature sin destino:
// los mails quedan "skipped"). El UPDATE toca SOLO el tenant del guard: un tenantId
// en el body se ignora por completo.

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const [tenant] = await getDb()
    .select({ receiptsEmail: tenants.receiptsEmail })
    .from(tenants)
    .where(eq(tenants.id, guard.tenantId))

  return Response.json({ receiptsEmail: tenant?.receiptsEmail ?? "" }, { headers: NO_STORE })
}

export async function PUT(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const body = await req.json().catch(() => null)
  const receiptsEmail = parseReceiptsEmail(body?.receiptsEmail)
  if (receiptsEmail === null) {
    return Response.json(
      { error: "Ingrese un solo email válido (sin comas, espacios ni <>) o déjelo vacío", code: "invalid" },
      { status: 400, headers: NO_STORE },
    )
  }

  await getDb()
    .update(tenants)
    .set({ receiptsEmail, updatedAt: new Date() })
    .where(eq(tenants.id, guard.tenantId))

  return Response.json({ ok: true, receiptsEmail }, { headers: NO_STORE })
}
