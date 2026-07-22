"use client"

import { useRef, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { MessageSquare, Users, LogOut, Package, BarChart3 } from "lucide-react"
import { SideNav, ToastProvider } from "@myd-org/ui"
import { AvailabilityToggle } from "./AvailabilityToggle"
import { NotificationsPrompt } from "./NotificationsPrompt"
import { PendingRepliesDialog, type PendingContact } from "./PendingRepliesDialog"
import type { InboxContact } from "@/lib/inbox-api"

interface AdminShellProps {
  name: string
  email: string
  role: "operator" | "superadmin"
  logoSrc?: string
  tenantName?: string
  availability: "available" | "away"
  currentUserId: string
  usagePanelEnabled?: boolean
  children: React.ReactNode
}

// `flag`: entradas gateadas por feature flag (evaluado server-side y pasado por prop).
const NAV = [
  { href: "/admin/inbox", label: "Inbox", icon: <MessageSquare size={16} strokeWidth={1.6} /> },
  { href: "/admin/uso", label: "Uso del bot", icon: <BarChart3 size={16} strokeWidth={1.6} />, superadminOnly: true, flag: "usagePanel" as const },
  { href: "/admin/catalogo", label: "Catálogo", icon: <Package size={16} strokeWidth={1.6} />, superadminOnly: true },
  { href: "/admin/usuarios", label: "Usuarios", icon: <Users size={16} strokeWidth={1.6} />, superadminOnly: true },
]

export function AdminShell({ name, email, role, logoSrc, tenantName, availability, currentUserId, usagePanelEnabled, children }: AdminShellProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [warning, setWarning] = useState<{ action: "away" | "logout"; contacts: PendingContact[] } | null>(null)
  const resolveWarning = useRef<((proceed: boolean) => void) | null>(null)

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
    if (item.superadminOnly && role !== "superadmin") return false
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

  return (
    <ToastProvider>
    <SideNav
      logo={logo}
      items={visibleNav.map((item) => ({
        href: item.href,
        label: item.label,
        icon: item.icon,
        active: pathname.startsWith(item.href),
      }))}
      user={{
        name,
        subtitle: `${email} · ${role === "superadmin" ? "Superadmin" : "Operador"}`,
        logoutIcon: <LogOut size={15} strokeWidth={1.6} />,
        onLogout: handleLogout,
      }}
      renderLink={(href, content) => (
        <Link href={href} className="block">
          {content}
        </Link>
      )}
    >
      <div className="flex justify-end px-4 md:px-6 pt-4">
        <AvailabilityToggle
          initial={availability}
          onBeforeAway={() => guardAgainstPendingReplies("away")}
        />
      </div>
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
