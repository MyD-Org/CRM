import { and, eq, isNotNull } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, conversationAssignments } from "@/db/schema"
import { listConversations, type InboxConversation } from "./inbox-api"

// Asignación de conversaciones a operadores. El bot (ai-api) solo etiqueta el departamento
// y deja la conversación sin dueño; el CRM elige al operador DISPONIBLE menos cargado y
// PERSISTE la asignación en su propia DB (tabla conversation_assignments en Neon), para que
// no se mezclen entre operadores. ai-api ya no es la fuente de verdad de la asignación.
// Ver ADR 0006 (platform/decisions/0006-...).

export interface Operator {
  id: string
  department: string | null
}

export interface Assignment {
  conversationId: string
  operatorId: string
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

/** Todas las asignaciones persistidas del tenant (CRM es la fuente de verdad). */
export async function getAssignments(tenantId: string): Promise<Assignment[]> {
  return getDb()
    .select({
      conversationId: conversationAssignments.conversationId,
      operatorId: conversationAssignments.operatorId,
      department: conversationAssignments.department,
    })
    .from(conversationAssignments)
    .where(eq(conversationAssignments.tenantId, tenantId))
}

/** Persiste (upsert) la asignación de una conversación a un operador en la DB del CRM. */
export async function assignInCrm(
  tenantId: string,
  conversationId: string,
  operatorId: string,
  department: string | null,
): Promise<void> {
  await getDb()
    .insert(conversationAssignments)
    .values({ tenantId, conversationId, operatorId, department })
    .onConflictDoUpdate({
      target: [conversationAssignments.tenantId, conversationAssignments.conversationId],
      set: { operatorId, department, assignedAt: new Date() },
    })
}

/**
 * Conteo de conversaciones ACTIVAS asignadas a cada operador, según la DB del CRM.
 * Solo cuenta las que siguen activas (activeConvIds viene de ai-api: mode/status en vivo).
 */
export function loadFromAssignments(assignments: Assignment[], activeConvIds: Set<string>): Map<string, number> {
  const load = new Map<string, number>()
  for (const a of assignments) {
    if (!activeConvIds.has(a.conversationId)) continue
    load.set(a.operatorId, (load.get(a.operatorId) ?? 0) + 1)
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
 * Reconcilia la cola: adopta asignaciones viejas de ai-api al CRM (migración transparente)
 * y asigna las conversaciones derivadas SIN dueño al operador disponible menos cargado del
 * departamento (o de todos, si no tiene depto). Best-effort: errores no rompen el inbox.
 * Se llama al cargar el inbox, al pollear contactos y al ponerse un operador disponible.
 * Ver ADR 0006 (disparador "el CRM la levanta de la cola").
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

  const assignments = await getAssignments(tenant.id)
  const assignedConvIds = new Set(assignments.map((a) => a.conversationId))
  const activeConvIds = new Set(convs.filter((c) => c.status !== "closed").map((c) => c.id))

  // Migración transparente: conversaciones que ai-api ya tenía asignadas pero el CRM no.
  // Las adoptamos a la DB del CRM sin tocar ai-api. Una sola vez por conversación.
  for (const conv of convs) {
    if (conv.assigned_operator_id && !assignedConvIds.has(conv.id) && conv.status !== "closed") {
      try {
        await assignInCrm(tenant.id, conv.id, conv.assigned_operator_id, conv.assigned_department ?? null)
        assignments.push({ conversationId: conv.id, operatorId: conv.assigned_operator_id, department: conv.assigned_department ?? null })
        assignedConvIds.add(conv.id)
      } catch {
        /* best-effort */
      }
    }
  }

  const pending = convs.filter(
    (c) => c.mode === "human" && c.status !== "closed" && !assignedConvIds.has(c.id),
  )
  if (!pending.length) return

  const load = loadFromAssignments(assignments, activeConvIds)
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
      await assignInCrm(tenant.id, conv.id, chosen.id, conv.assigned_department ?? null)
      // Subimos su carga para repartir si quedan más pendientes en esta misma pasada.
      load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1)
    } catch {
      // best-effort: si falla la asignación de una, seguimos con las demás
    }
  }
}
