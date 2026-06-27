"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { MessageSquare, Users, LogOut, Package } from "lucide-react"
import { SideNav, ToastProvider } from "@myd-org/ui"

interface AdminShellProps {
  name: string
  role: "operator" | "superadmin"
  logoSrc?: string
  tenantName?: string
  children: React.ReactNode
}

const NAV = [
  { href: "/admin/inbox", label: "Inbox", icon: <MessageSquare size={16} strokeWidth={1.6} /> },
  { href: "/admin/catalogo", label: "Catálogo", icon: <Package size={16} strokeWidth={1.6} />, superadminOnly: true },
  { href: "/admin/usuarios", label: "Usuarios", icon: <Users size={16} strokeWidth={1.6} />, superadminOnly: true },
]

export function AdminShell({ name, role, logoSrc, tenantName, children }: AdminShellProps) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await fetch("/api/admin/auth/logout", { method: "POST" })
    router.push("/admin/login")
  }

  const visibleNav = NAV.filter((item) => !item.superadminOnly || role === "superadmin")

  const logo = logoSrc ? (
    <div className="flex flex-col gap-1">
      <Image src={logoSrc} alt={tenantName ?? "Logo"} width={120} height={32} style={{ width: 120, height: "auto" }} priority />
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
        subtitle: role === "superadmin" ? "Superadmin" : "Operador",
        logoutIcon: <LogOut size={15} strokeWidth={1.6} />,
        onLogout: handleLogout,
      }}
      renderLink={(href, content) => (
        <Link href={href} className="block">
          {content}
        </Link>
      )}
    >
      {children}
    </SideNav>
    </ToastProvider>
  )
}
