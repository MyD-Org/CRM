"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ShoppingCart, LogOut, FileText, ChevronDown } from "lucide-react"
import { Logo } from "./Logo"

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
}

interface PortalHeaderProps {
  logoSrc: string
  tenantName: string
  logoSubtitle: string
  razonsocial: string
}

export function PortalHeader({ logoSrc, tenantName, logoSubtitle, razonsocial }: PortalHeaderProps) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  async function handleLogout() {
    setLoggingOut(true)
    await fetch("/api/auth/logout", { method: "POST" })
    router.push("/portal")
  }

  useEffect(() => {
    if (!menuOpen) return
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKeydown)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKeydown)
    }
  }, [menuOpen])

  return (
    <header
      className="sticky top-0 z-40 flex items-center justify-between px-6 h-14"
      style={{
        background: "var(--card)",
        borderBottom: "1px solid var(--border)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Logo size="sm" src={logoSrc} name={tenantName} />
        {logoSubtitle && (
          <>
            <div className="w-px h-5 hidden sm:block" style={{ background: "var(--border)" }} />
            <span className="text-xs font-medium hidden sm:block" style={{ color: "var(--ink-soft)" }}>
              {logoSubtitle}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {/* Tienda chip disabled */}
        <div
          className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium cursor-not-allowed"
          style={{ background: "var(--bg)", color: "var(--ink-faint)", border: "1px solid var(--border)" }}
        >
          <ShoppingCart size={12} strokeWidth={1.2} color="currentColor" />
          Tienda · Pronto
        </div>

        {/* Avatar + menú */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex items-center gap-1.5 transition-opacity hover:opacity-80"
          >
            <span
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
              style={{ background: "var(--blue)" }}
            >
              {initials(razonsocial)}
            </span>
            <ChevronDown
              size={14}
              strokeWidth={2}
              style={{ color: "var(--ink-soft)", transform: menuOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
            />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-56 rounded-[12px] py-1.5 z-50"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                boxShadow: "0 12px 32px rgba(16,24,40,0.14)",
              }}
            >
              <div className="px-4 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
                <p className="text-xs font-semibold truncate" style={{ color: "var(--ink)" }}>{razonsocial}</p>
              </div>
              <Link
                href="/portal/condiciones"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors hover:bg-[var(--bg)]"
                style={{ color: "var(--ink)" }}
              >
                <FileText size={15} strokeWidth={1.6} style={{ color: "var(--ink-soft)" }} />
                Condiciones comerciales
              </Link>
              <button
                role="menuitem"
                onClick={handleLogout}
                disabled={loggingOut}
                className="flex items-center gap-2.5 w-full px-4 py-2.5 text-sm text-left transition-colors hover:bg-[var(--bg)] disabled:opacity-50"
                style={{ color: "var(--red)" }}
              >
                <LogOut size={15} strokeWidth={1.6} color="currentColor" />
                Salir
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
