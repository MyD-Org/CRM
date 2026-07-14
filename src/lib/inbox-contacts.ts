import { listContacts, listConversations, type InboxContact } from "./inbox-api"
import { getAssignments } from "./assignment"
import { operatorNamesByIds } from "./operator-names"

// Lista de contactos del inbox ENRIQUECIDA con la fuente de verdad del CRM:
// - assigned_operator_id / _name → de conversation_assignments (Neon), NO de ai-api.
// - assigned_department → del handoff que etiqueta el bot en ai-api (listConversations).
// No dispara reconciliación: los callers la corren antes según su disparador (ADR 0006).
export async function listEnrichedContacts(
  tenant: { id: string; aiApiUrl: string; aiTenantId: string },
  scope: "active" | "all" = "active",
): Promise<InboxContact[]> {
  const [contacts, conversations, assignments] = await Promise.all([
    listContacts(tenant.aiApiUrl, tenant.aiTenantId, scope),
    listConversations(tenant.aiApiUrl, tenant.aiTenantId).catch(() => []),
    getAssignments(tenant.id),
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

// Enriquece UN contacto (vista de conversación) con la misma fuente de verdad del CRM.
export async function enrichContact(
  tenant: { id: string; aiApiUrl: string; aiTenantId: string },
  contact: InboxContact,
): Promise<InboxContact> {
  const convId = contact.current_conversation_id
  if (!convId) return { ...contact, assigned_operator_id: null, assigned_operator_name: null, assigned_department: null }

  const [conversations, assignments] = await Promise.all([
    listConversations(tenant.aiApiUrl, tenant.aiTenantId).catch(() => []),
    getAssignments(tenant.id),
  ])
  const operatorId = assignments.find((a) => a.conversationId === convId)?.operatorId ?? null
  const department = conversations.find((c) => c.id === convId)?.assigned_department ?? null
  const nameById = await operatorNamesByIds([operatorId])

  return {
    ...contact,
    assigned_operator_id: operatorId,
    assigned_operator_name: operatorId ? nameById.get(operatorId) ?? null : null,
    assigned_department: department,
  }
}
