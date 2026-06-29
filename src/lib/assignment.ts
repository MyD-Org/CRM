import { and, eq, isNotNull } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { listConversations, assignConversation, type InboxConversation } from "./inbox-api"

// Asignación de conversaciones a operadores. El bot (ai-api) solo etiqueta el departamento
// y deja la conversación sin dueño; el CRM elige al operador DISPONIBLE menos cargado.
// Ver ADR 0006 (platform/decisions/0006-...).

export interface Operator {
  id: string
  department: string | null
}

/** Operadores DISPONIBLES (presencia + cuenta activa) del tenant, opcionalmente de un depto. */
export async function availableOperators(tenantId: string, department?: string | null): Promise<Operator[]> {
  const conditions = [
    eq(adminUsers.tenantId, tenantId),
    isNotNull(adminUsers.passwordHash),
    eq(adminUsers.availability, "available"),
  ]
  if (department) conditions.push(eq(adminUsers.department, department))
  return getDb()
    .select({ id: adminUsers.id, department: adminUsers.department })
    .from(adminUsers)
    .where(and(...conditions))
}

/** Conteo de conversaciones humanas activas asignadas a cada operador. */
export function loadMapOf(conversations: InboxConversation[]): Map<string, number> {
  const load = new Map<string, number>()
  for (const c of conversations) {
    if (c.assigned_operator_id) {
      load.set(c.assigned_operator_id, (load.get(c.assigned_operator_id) ?? 0) + 1)
    }
  }
  return load
}

/** Elige el operador menos cargado del conjunto de candidatos. Devuelve null si está vacío. */
export function pickLeastLoaded(candidates: Operator[], load: Map<string, number>): Operator | null {
  let chosen: Operator | null = null
  let min = Infinity
  for (const op of candidates) {
    const l = load.get(op.id) ?? 0
    if (l < min) { min = l; chosen = op }
  }
  return chosen
}

/**
 * Levanta de la cola las conversaciones derivadas SIN operador y le asigna el menos cargado
 * del departamento (o de todos, si no tiene depto). Best-effort: errores no rompen el inbox.
 * Se llama al cargar el inbox. Ver ADR 0006 (disparador "el CRM la levanta de la cola").
 */
export async function assignPendingConversations(tenant: {
  id: string
  aiApiUrl: string
  aiTenantId: string
}): Promise<void> {
  let convs: InboxConversation[]
  try {
    convs = await listConversations(tenant.aiApiUrl, tenant.aiTenantId)
  } catch {
    return
  }

  const pending = convs.filter((c) => c.mode === "human" && !c.assigned_operator_id && c.status !== "closed")
  if (!pending.length) return

  const load = loadMapOf(convs)
  // Cache de operadores disponibles por departamento (incl. "" = todos) para no re-consultar.
  const cache = new Map<string, Operator[]>()
  const getCandidates = async (dept: string | null): Promise<Operator[]> => {
    const key = dept ?? ""
    if (!cache.has(key)) cache.set(key, await availableOperators(tenant.id, dept))
    return cache.get(key)!
  }

  for (const conv of pending) {
    const candidates = await getCandidates(conv.assigned_department ?? null)
    const chosen = pickLeastLoaded(candidates, load)
    if (!chosen) continue // nadie disponible en ese depto → queda en la cola
    try {
      await assignConversation(tenant.aiApiUrl, tenant.aiTenantId, conv.id, chosen.id)
      // Subimos su carga para repartir si quedan más pendientes en esta misma pasada.
      load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1)
    } catch {
      // best-effort: si falla la asignación de una, seguimos con las demás
    }
  }
}
