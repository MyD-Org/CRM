"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { MessageSquare, Users, LogOut } from "lucide-react"

interface AdminShellProps {
  name: string
  role: "operator" | "superadmin"
  children: React.ReactNode
}

const NAV = [
  { href: "/admin/inbox", label: "Inbox", icon: MessageSquare },
  { href: "/admin/usuarios", label: "Usuarios", icon: Users, superadminOnly: true },
]

export function AdminShell({ name, role, children }: AdminShellProps) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await fetch("/api/admin/auth/logout", { method: "POST" })
    router.push("/admin/login")
  }

  const visibleNav = NAV.filter((item) => !item.superadminOnly || role === "superadmin")

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col w-56 shrink-0 h-full"
        style={{ background: "var(--card)", borderRight: "1px solid var(--border)" }}
      >
        <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--ink-faint)" }}>Backoffice</p>
        </div>

        <nav className="flex-1 px-3 py-3 flex flex-col gap-0.5">
          {visibleNav.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius)] text-sm font-medium transition-colors"
                style={{
                  background: active ? "var(--blue-soft)" : "transparent",
                  color: active ? "var(--blue)" : "var(--ink-soft)",
                }}
              >
                <Icon size={16} strokeWidth={1.6} />
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="px-3 py-3" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2 px-3 py-2 mb-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
              style={{ background: "var(--blue)" }}
            >
              {name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium truncate" style={{ color: "var(--ink)" }}>{name}</p>
              <p className="text-[10px] truncate" style={{ color: "var(--ink-faint)" }}>
                {role === "superadmin" ? "Superadmin" : "Operador"}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius)] text-sm transition-colors hover:bg-[var(--bg)]"
            style={{ color: "var(--ink-soft)" }}
          >
            <LogOut size={15} strokeWidth={1.6} />
            Salir
          </button>
        </div>
      </aside>

      {/* Contenido */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
