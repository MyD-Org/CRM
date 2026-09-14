import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { getGuardedAdminSession } from "@/lib/admin-session"
import { listConversations } from "@/lib/inbox-api"
import { countPending } from "@/lib/payment-receipts"
import { roleRank } from "@/lib/roles"

// GET /api/admin/pending-counts — contadores para los badges de pendientes del sidebar del
// backoffice: conversaciones del inbox esperando respuesta y comprobantes pendientes de cargar
// en Alegra. Responde CUALQUIER rol autenticado (operador incluido): los counts no filtran
// nada sensible y el ítem "Comprobantes" ni siquiera lo ve el operador. `comprobantes` va en
// null para operadores: no lo usa la UI y no se expone el dato innecesariamente.
//
// Cache en memoria ~15 s por tenant: el sidebar pollea cada 30 s y la cuenta de inbox le pega
// a la ai-api; sin cache cada pestaña abierta multiplica los requests. El proceso es
// serverless de corta vida, así que el Map no crece — muere con la instancia. La key es el
// tenant (no el usuario): el valor crudo es el mismo para todos; el filtro por rol se aplica
// AL RESPONDER, sobre el valor cacheado.

const CACHE_TTL_MS = 15_000

interface Counts {
  inbox: number
  comprobantes: number
}

const cache = new Map<string, { at: number; value: Counts }>()

/** Invalida el cache (los tests de integración lo llaman entre casos). */
export function clearPendingCountsCache(): void {
  cache.clear()
}

async function computeCounts(tenantId: string): Promise<Counts> {
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, tenantId))

  // Tenant sin inbox configurado: 0 pendientes, no es error (mismo criterio que el sidebar,
  // que esconde/o no muestra el badge cuando no hay nada que contar).
  let inbox = 0
  if (tenant?.aiApiUrl && tenant?.aiTenantId) {
    const conversations = await listConversations(tenant.aiApiUrl, tenant.aiTenantId)
    inbox = conversations.filter((c) => c.awaiting_reply).length
  }

  return { inbox, comprobantes: await countPending(tenantId) }
}

export async function GET(req: Request) {
  const guarded = await getGuardedAdminSession(req)
  if (!guarded.ok) {
    return Response.json({ error: "No autorizado", code: "unauthorized" }, { status: 401 })
  }

  const cached = cache.get(guarded.tenantId)
  let value: Counts
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    value = cached.value
  } else {
    try {
      value = await computeCounts(guarded.tenantId)
    } catch (err) {
      // ai-api caída o DB con problemas: el cliente mantiene lo último conocido (badge viejo
      // o ninguno), igual que con un fallo de red. No es motivo para un 500 con stack.
      console.error("[pending-counts] falló el cálculo de pendientes:", err)
      return Response.json(
        { error: "No pudimos calcular los pendientes, intente nuevamente", code: "counts_error" },
        { status: 502 },
      )
    }
    cache.set(guarded.tenantId, { at: Date.now(), value })
  }

  const esAdmin = roleRank(guarded.user.role) >= roleRank("admin")
  return Response.json(
    { inbox: value.inbox, comprobantes: esAdmin ? value.comprobantes : null },
    { headers: { "Cache-Control": "private, no-store" } },
  )
}
