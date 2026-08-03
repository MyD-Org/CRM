"use client"

import { useRef, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { MessageSquare, Users, LogOut, Package, BarChart3 } from "lucide-react"
import { SideNav, ToastProvider } from "@myd-org/ui"
import { AvailabilityToggle, type Availability } from "./AvailabilityToggle"
import { NotificationsPrompt } from "./NotificationsPrompt"
import { PendingRepliesDialog, type PendingContact } from "./PendingRepliesDialog"
import type { InboxContact } from "@/lib/inbox-api"
import { roleRank, type AdminRole } from "@/lib/roles"

interface AdminShellProps {
  name: string
  email: string
  role: AdminRole
  logoSrc?: string
  // Icono cuadrado del tenant (el mismo del favicon). Se usa en el rail del sidebar en lugar
  // del logo horizontal, que no entra en la barra angosta.
  iconSrc?: string
  tenantName?: string
  availability: "available" | "away"
  currentUserId: string
  usagePanelEnabled?: boolean
  children: React.ReactNode
}

function roleLabel(role: AdminRole): string {
  if (role === "superadmin") return "Superadmin"
  if (role === "admin") return "Admin"
  return "Operador"
}

// `flag`: entradas gateadas por feature flag (evaluado server-side y pasado por prop).
// `minRole`: nivel mínimo para ver la entrada (usa el ranking de roles).
const NAV = [
  { href: "/admin/inbox", label: "Mensajes", icon: <MessageSquare size={16} strokeWidth={1.6} /> },
  { href: "/admin/uso", label: "Uso del bot", icon: <BarChart3 size={16} strokeWidth={1.6} />, minRole: "superadmin" as const, flag: "usagePanel" as const },
  { href: "/admin/catalogo", label: "Catálogo", icon: <Package size={16} strokeWidth={1.6} />, minRole: "superadmin" as const },
  { href: "/admin/usuarios", label: "Usuarios", icon: <Users size={16} strokeWidth={1.6} />, minRole: "admin" as const },
]

export function AdminShell({ name, email, role, logoSrc, iconSrc, tenantName, availability: initialAvailability, currentUserId, usagePanelEnabled, children }: AdminShellProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [warning, setWarning] = useState<{ action: "away" | "logout"; contacts: PendingContact[] } | null>(null)
  const resolveWarning = useRef<((proceed: boolean) => void) | null>(null)
  // Fuente de verdad de la disponibilidad. Se levantó del AvailabilityToggle para que la
  // versión expanded (footerSlot) y la compact (footerSlotCompact, rail) muestren el mismo
  // estado sin desincronizarse cuando el operador colapsa/expande el sidebar.
  const [availability, setAvailability] = useState<Availability>(initialAvailability)

  // Antes de ausentarse o cerrar sesión, chequea si el operador tiene conversaciones
  // asignadas dentro de la ventana de 24hs y sin responder; si las hay, pide confirmación.
  async function guardAgainstPendingReplies(action: "away" | "logout"): Promise<boolean> {
    let contacts: InboxContact[]
    try {
      const res = await fetch("/api/admin/inbox/contacts?scope=active")
      if (!res.ok) return true
      contacts = await res.json()
    } catch {
      // Fallo de red al chequear pendientes: no bloqueamos el logout/ausencia (fail-open),
      // igual que cuando el server responde !ok. Evita un "Failed to fetch" no capturado.
      return true
    }
    const pending = contacts.filter((c) => c.assigned_operator_id === currentUserId && c.awaiting_reply)
    if (pending.length === 0) return true

    return new Promise<boolean>((resolve) => {
      resolveWarning.current = resolve
      setWarning({ action, contacts: pending })
    })
  }

  function closeWarning(proceed: boolean) {
    resolveWarning.current?.(proceed)
    resolveWarning.current = null
    setWarning(null)
  }

  async function handleLogout() {
    const ok = await guardAgainstPendingReplies("logout")
    if (!ok) return
    await fetch("/api/admin/auth/logout", { method: "POST" })
    router.push("/admin/login")
  }

  const visibleNav = NAV.filter((item) => {
    if (item.minRole && roleRank(role) < roleRank(item.minRole)) return false
    if (item.flag === "usagePanel" && !usagePanelEnabled) return false
    return true
  })

  const logo = logoSrc ? (
    <div className="flex flex-col gap-1">
      <Image src={logoSrc} alt={tenantName ?? "Logo"} width={120} height={32} style={{ width: 120, height: "auto" }} priority unoptimized />
      <p className="text-[10px] font-medium uppercase tracking-wider text-subtle">Backoffice</p>
    </div>
  ) : (
    <div className="flex flex-col gap-0.5">
      <p className="text-sm font-semibold text-text">{tenantName ?? "Backoffice"}</p>
      <p className="text-[10px] font-medium uppercase tracking-wider text-subtle">Backoffice</p>
    </div>
  )

  // Logo compacto para el rail: mismo icono cuadrado que usamos como favicon del tenant
  // (public/logos/<tenant>-icon.svg). Si el caller no pasa iconSrc, cae al inicial del nombre
  // como fallback prolijo.
  const compactLogo = iconSrc ? (
    <Image
      src={iconSrc}
      alt={tenantName ?? "Logo"}
      width={32}
      height={32}
      style={{ width: 32, height: 32 }}
      priority
      unoptimized
      title={tenantName ?? "Backoffice"}
    />
  ) : (
    <div
      className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold"
      style={{ background: "var(--blue-soft)", color: "var(--blue)" }}
      title={tenantName ?? "Backoffice"}
    >
      {(tenantName ?? "Backoffice").charAt(0).toUpperCase()}
    </div>
  )

  return (
    <ToastProvider>
    <SideNav
      logo={logo}
      compactLogo={compactLogo}
      // Modo rail al colapsar: en desktop/tablet (>=sm), apretar el toggle deja una barra
      // angosta con solo los íconos (patrón VS Code / Notion). Da más pantalla al inbox sin
      // perder navegación.
      collapsedMode="rail"
      // Mobile (<sm) usa bottom sheet en vez del drawer clásico: patrón "app nativa" con FAB
      // abajo-derecha para abrir, drag hacia abajo para cerrar, backdrop tap también cierra.
      // Más pulgar-friendly que la hamburguesa arriba-izquierda.
      mobileMode="bottom-sheet"
      // En el detalle de una conversación (/admin/inbox/c/*) escondemos el FAB de nav: ya hay
      // un back button en el header del thread y el FAB taparía el botón de enviar del compose.
      hideMobileTrigger={pathname.startsWith("/admin/inbox/c/")}
      items={visibleNav.map((item) => ({
        href: item.href,
        label: item.label,
        icon: item.icon,
        active: pathname.startsWith(item.href),
      }))}
      user={{
        name,
        subtitle: `${email} · ${roleLabel(role)}`,
        logoutIcon: <LogOut size={15} strokeWidth={1.6} />,
        onLogout: handleLogout,
      }}
      renderLink={(href, content) => (
        <Link href={href} className="block">
          {content}
        </Link>
      )}
      /* Presencia del operador en el pie del sidebar, pegada a su cuenta (patrón Slack/Intercom):
         vive con el usuario, no en el header. Así el header queda para el estado de la operación (bot). */
      footerSlot={
        <AvailabilityToggle
          value={availability}
          onChange={setAvailability}
          onBeforeAway={() => guardAgainstPendingReplies("away")}
        />
      }
      footerSlotCompact={
        <div className="flex items-center justify-center">
          <AvailabilityToggle
            value={availability}
            onChange={setAvailability}
            onBeforeAway={() => guardAgainstPendingReplies("away")}
            compact
          />
        </div>
      }
    >
      {children}
    </SideNav>
    <NotificationsPrompt />
    {warning && (
      <PendingRepliesDialog
        open
        action={warning.action}
        contacts={warning.contacts}
        onCancel={() => closeWarning(false)}
        onConfirm={() => closeWarning(true)}
      />
    )}
    </ToastProvider>
  )
}
