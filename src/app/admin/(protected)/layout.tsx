import { redirect } from "next/navigation"
import { getGuardedAdminSession } from "@/lib/admin-session"
import { getTenantByIdFromDb } from "@/lib/tenants"
import { botUsagePanelEnabled } from "@/lib/flags"
import { AdminShell } from "@/components/admin/AdminShell"

export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  // El guard verifica el tenant contra la FILA de `admin_users`, no contra la cookie: una
  // membresía revocada sobreviviría hasta que expire la sesión. `redirect()` corta la ejecución
  // antes de emitir JSX, así que ante rechazo el HTML no contiene nombre, logo ni ningún dato
  // del tenant de la sesión — se cumple por construcción, no hay HTML.
  const guard = await getGuardedAdminSession()
  if (!guard.ok) {
    // El motivo va a los logs del server, nunca al usuario.
    console.warn(`[admin-guard] sesión rechazada en el área protegida: ${guard.reason}`)
    // El layout NO puede destruir la sesión (`cookies()` es read-only fuera de Server Actions y
    // Route Handlers), así que delega en el Route Handler. Sin sesión no hay cookie que borrar.
    redirect(guard.reason === "no-session" ? "/admin/login" : "/api/admin/auth/expire")
  }

  const { session, tenantId, user } = guard

  // Independientes entre sí: en serie sumaban un round-trip extra a cada navegación.
  const [tenant, usagePanelEnabled] = await Promise.all([
    getTenantByIdFromDb(tenantId),
    botUsagePanelEnabled(),
  ])
  const availability = user.availability === "available" ? "available" : "away"

  return (
    <AdminShell
      name={session.name}
      email={session.email}
      // Rol FRESCO de la DB, no el de la cookie. Consecuencia aceptada: bajar de admin a operator
      // no es instantáneo en las rutas API — los lectores de `session.role` ven el rol viejo hasta
      // el próximo login (la cookie no se puede reescribir desde un Server Component).
      role={user.role}
      logoSrc={tenant?.logoPath}
      // Mismo icono cuadrado que sirve de favicon del tenant (convención en root layout.tsx):
      // /public/logos/<tenant>-icon.svg. Se usa en el rail del sidebar (56px) donde el logo
      // horizontal no entra.
      iconSrc={tenant?.id ? `/logos/${tenant.id}-icon.svg` : undefined}
      tenantName={tenant?.name}
      availability={availability}
      currentUserId={session.userId}
      usagePanelEnabled={usagePanelEnabled}
    >
      {children}
    </AdminShell>
  )
}
