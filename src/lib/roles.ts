// Modelo de roles del backoffice. Tres niveles:
//  - operator:   usa el inbox y responde mensajes.
//  - admin:      todo lo del operador + gestión de OPERADORES (invitar/editar/eliminar).
//  - superadmin: todo + catálogo + panel de uso/topes + gestión de admins y superadmins.
// La creación de admins/superadmins queda reservada al superadmin a propósito: así el tier
// admin (y el acceso a datos de plataforma) lo otorga solo el dueño, no se auto-propaga.
export type AdminRole = "operator" | "admin" | "superadmin"

const RANK: Record<AdminRole, number> = { operator: 0, admin: 1, superadmin: 2 }

export function roleRank(role: string): number {
  return RANK[role as AdminRole] ?? 0
}

// ¿Puede entrar a la gestión de usuarios? admin y superadmin.
export function canManageUsers(role: string): boolean {
  return roleRank(role) >= RANK.admin
}

// Roles que `actor` puede ASIGNAR al invitar/editar. El admin solo puede crear operadores;
// admins y superadmins los asigna únicamente el superadmin.
export function assignableRoles(actor: string): AdminRole[] {
  if (actor === "superadmin") return ["operator", "admin", "superadmin"]
  if (actor === "admin") return ["operator"]
  return []
}

// ¿Puede `actor` editar/eliminar a un usuario cuyo rol es `target`? El superadmin puede con
// cualquiera; el admin solo con operadores (no con otros admins ni con el superadmin).
export function canActOnRole(actor: string, target: string): boolean {
  if (actor === "superadmin") return true
  if (actor === "admin") return target === "operator"
  return false
}
