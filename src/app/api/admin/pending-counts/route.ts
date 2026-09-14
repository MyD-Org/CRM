import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { getGuardedAdminSession } from "@/lib/admin-session"
import { listConversations, type InboxConversation } from "@/lib/inbox-api"
import { listPendingSubmittedAt } from "@/lib/payment-receipts"
import { roleRank } from "@/lib/roles"

// GET /api/admin/pending-counts — contadores para los badges de "novedades" del sidebar del
// backoffice. El badge NO es "todo lo pendiente" sino "lo nuevo desde mi última visita a la
// sección" (modelo last-visit, trackeado en localStorage del browser, por dispositivo).
//
// Modelo de filtrado:
//   - inbox: conversaciones con awaiting_reply && status === "active" (el ai-api deja
//     awaiting_reply=true en conversaciones cerradas: contarlas inflaba el badge, dato real
//     de prod) y, si viene `since`, con last_inbound_at > since. last_inbound_at null no
//     cuenta cuando hay since (no hay "entrada reciente" medible); sin since sí cuenta.
//   - comprobantes: payment_receipts pending con submittedAt > since (o todos sin since).
//     "Pendiente" deja de contar al visitar la sección aunque el admin ya lo haya abierto.
//   - parámetros: `?since=` aplica a AMBOS (atajo), y `sinceInbox` / `sinceComprobantes`
//     filtran por sección (lo que manda el cliente: cada sección tiene su propio last-visit).
//     Inválido o ausente = sin filtro (primer uso: backlog completo, razonable).
//
// Responde CUALQUIER rol autenticado (operador incluido). `comprobantes` va en null para
// operadores: no lo usa la UI y no se expone el dato innecesariamente.
//
// Cache en memoria ~15 s por tenant del RAW (lista de conversaciones + submittedAt de los
// pending), no de los contadores: así cada request cuenta sobre el mismo snapshot, el count
// es puro y liviano, y el `since` del cliente no invalida nada. El proceso es serverless de
// corta vida: el Map muere con la instancia. La key es el tenant (no el usuario): el valor
// crudo es el mismo para todos; el filtro por rol se aplica AL RESPONDER.

const CACHE_TTL_MS = 15_000

interface Raw {
  /** null = tenant sin inbox configurado (inbox 0, no es error). */
  conversations: InboxConversation[] | null
  pendingSubmittedAt: Date[]
}

const cache = new Map<string, { at: number; value: Raw }>()

/** Invalida el cache (los tests de integración lo llaman entre casos). */
export function clearPendingCountsCache(): void {
  cache.clear()
}

/** Parsea un ISO del query. Inválido/ausente ⇒ null (sin filtro). */
function parseSince(raw: string | null): Date | null {
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : new Date(t)
}

async function loadRaw(tenantId: string): Promise<Raw> {
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, tenantId))

  let conversations: InboxConversation[] | null = null
  if (tenant?.aiApiUrl && tenant?.aiTenantId) {
    conversations = await listConversations(tenant.aiApiUrl, tenant.aiTenantId)
  }

  return { conversations, pendingSubmittedAt: await listPendingSubmittedAt(tenantId) }
}

export async function GET(req: Request) {
  const guarded = await getGuardedAdminSession(req)
  if (!guarded.ok) {
    return Response.json({ error: "No autorizado", code: "unauthorized" }, { status: 401 })
  }

  const url = new URL(req.url)
  // `since` es el atajo "mismo momento para ambas secciones"; los específicos ganan.
  const sinceAmbos = parseSince(url.searchParams.get("since"))
  const sinceInbox = parseSince(url.searchParams.get("sinceInbox")) ?? sinceAmbos
  const sinceComprobantes = parseSince(url.searchParams.get("sinceComprobantes")) ?? sinceAmbos

  const cached = cache.get(guarded.tenantId)
  let value: Raw
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    value = cached.value
  } else {
    try {
      value = await loadRaw(guarded.tenantId)
    } catch (err) {
      // ai-api caída o DB con problemas: el cliente mantiene lo último conocido (badge viejo
      // o ninguno), igual que con un fallo de red. No es motivo para un 500 con stack.
      console.error("[pending-counts] falló la carga del raw:", err)
      return Response.json(
        { error: "No pudimos calcular los pendientes, intente nuevamente", code: "counts_error" },
        { status: 502 },
      )
    }
    cache.set(guarded.tenantId, { at: Date.now(), value })
  }

  const inbox =
    value.conversations?.filter((c) => {
      if (!c.awaiting_reply || c.status !== "active") return false
      if (!sinceInbox) return true
      // Sin last_inbound_at no hay "entrada reciente" medible: no cuenta cuando hay since.
      return c.last_inbound_at !== null && new Date(c.last_inbound_at) > sinceInbox
    }).length ?? 0

  const comprobantes = value.pendingSubmittedAt.filter((d) => !sinceComprobantes || d > sinceComprobantes).length

  const esAdmin = roleRank(guarded.user.role) >= roleRank("admin")
  return Response.json(
    { inbox, comprobantes: esAdmin ? comprobantes : null },
    { headers: { "Cache-Control": "private, no-store" } },
  )
}
