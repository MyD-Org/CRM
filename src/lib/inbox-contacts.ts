import { listContacts, listConversations, type InboxContact, type InboxConversation } from "./inbox-api"
import { getAssignments, type Assignment } from "./assignment"
import { operatorNamesByIds } from "./operator-names"


// Lista de contactos del inbox ENRIQUECIDA con la fuente de verdad del CRM:
// - assigned_operator_id / _name → de conversation_assignments (Neon), NO de ai-api.
// - assigned_department → del handoff que etiqueta el bot en ai-api (listConversations).
// No dispara reconciliación: los callers la corren antes según su disparador (ADR 0006).
// Acepta `convs` y `assignments` ya traídos (los que devuelve assignPendingConversations)
// para no re-consultar ai-api ni la DB en el mismo request.
export async function listEnrichedContacts(
  tenant: { id: string; aiApiUrl: string; aiTenantId: string },
  scope: "active" | "all" = "active",
  convs?: InboxConversation[] | null,
  knownAssignments?: Assignment[],
): Promise<InboxContact[]> {
  const [contacts, conversations, assignments] = await Promise.all([
    listContacts(tenant.aiApiUrl, tenant.aiTenantId, scope),
    convs ?? listConversations(tenant.aiApiUrl, tenant.aiTenantId).catch(() => []),
    knownAssignments ?? getAssignments(tenant.id),
  ])

  const operatorByConv = new Map(assignments.map((a) => [a.conversationId, a.operatorId]))
  const deptByConv = new Map(conversations.map((c) => [c.id, c.assigned_department]))

  const withOwner = contacts.map((c) => ({
    ...c,
    assigned_operator_id: c.current_conversation_id ? operatorByConv.get(c.current_conversation_id) ?? null : null,
    assigned_department: c.current_conversation_id ? deptByConv.get(c.current_conversation_id) ?? null : null,
  }))

  const nameById = await operatorNamesByIds(withOwner.map((c) => c.assigned_operator_id))
  return withOwner.map((c) => ({
    ...c,
    assigned_operator_name: c.assigned_operator_id ? nameById.get(c.assigned_operator_id) ?? null : null,
  }))
}

// Datos que el caller puede haber empezado a pedir ANTES de tener el contacto: ninguno
// depende de él. Se aceptan como promesas para que la página arranque todo junto y esto no
// sea otra tanda en la cascada (ver la vista de conversación).
export interface EnrichContactPrefetch {
  conversations?: Promise<InboxConversation[]> | InboxConversation[]
  assignments?: Promise<Assignment[]> | Assignment[]
  operatorNames?: Promise<Map<string, string>> | Map<string, string>
}

// Enriquece UN contacto (vista de conversación) con la misma fuente de verdad del CRM.
export async function enrichContact(
  tenant: { id: string; aiApiUrl: string; aiTenantId: string },
  contact: InboxContact,
  prefetch: EnrichContactPrefetch = {},
): Promise<InboxContact> {
  const convId = contact.current_conversation_id
  if (!convId) return { ...contact, assigned_operator_id: null, assigned_operator_name: null, assigned_department: null }

  const [conversations, assignments] = await Promise.all([
    prefetch.conversations ?? listConversations(tenant.aiApiUrl, tenant.aiTenantId).catch(() => []),
    prefetch.assignments ?? getAssignments(tenant.id),
  ])
  const operatorId = assignments.find((a) => a.conversationId === convId)?.operatorId ?? null
  const department = conversations.find((c) => c.id === convId)?.assigned_department ?? null
  // Sin prefetch resolvemos solo el nombre que hace falta; con prefetch ya vienen todos.
  const nameById = prefetch.operatorNames
    ? await prefetch.operatorNames
    : await operatorNamesByIds([operatorId])

  return {
    ...contact,
    assigned_operator_id: operatorId,
    assigned_operator_name: operatorId ? nameById.get(operatorId) ?? null : null,
    assigned_department: department,
  }
}
