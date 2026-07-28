// Modelo de roles del backoffice. Tres niveles:
//  - operator:   usa el inbox y responde mensajes.
//  - admin:      todo lo del operador + gestión del equipo (operadores y otros admins).
//  - superadmin: todo + catálogo + panel de uso/topes + gestión de admins y superadmins.
// El admin administra al equipo del cliente sin tocar datos de plataforma. La frontera dura
// es superadmin: solo el dueño puede otorgar ese rol o actuar sobre quien lo tiene, porque
// es el que da acceso al catálogo, al gasto y a los topes.
export type AdminRole = "operator" | "admin" | "superadmin"

const RANK: Record<AdminRole, number> = { operator: 0, admin: 1, superadmin: 2 }

export function roleRank(role: string): number {
  return RANK[role as AdminRole] ?? 0
}

// ¿Puede entrar a la gestión de usuarios? admin y superadmin.
export function canManageUsers(role: string): boolean {
  return roleRank(role) >= RANK.admin
}

// Roles que `actor` puede ASIGNAR al invitar/editar. El admin puede crear operadores y otros
// admins (administra el equipo del cliente); superadmin lo asigna únicamente el superadmin.
export function assignableRoles(actor: string): AdminRole[] {
  if (actor === "superadmin") return ["operator", "admin", "superadmin"]
  if (actor === "admin") return ["operator", "admin"]
  return []
}

// ¿Puede `actor` editar/eliminar a un usuario cuyo rol es `target`? El superadmin puede con
// cualquiera; el admin con operadores y otros admins, pero nunca con un superadmin.
// Regla general: se puede actuar sobre un rol de rango igual o menor, salvo el operador que
// no gestiona a nadie.
export function canActOnRole(actor: string, target: string): boolean {
  if (actor === "superadmin") return true
  if (actor === "admin") return roleRank(target) <= RANK.admin
  return false
}
