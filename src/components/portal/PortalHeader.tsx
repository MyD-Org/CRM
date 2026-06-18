"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Avatar, DropdownMenu, type DropdownMenuEntry } from "@myd-org/ui"
import { ShoppingCart, LogOut, ChevronDown, ChevronRight, Bell, Clock, AlertTriangle } from "lucide-react"
import { Logo } from "./Logo"

type EntityKind = "factura" | "pago" | "presupuesto"

interface PortalHeaderProps {
  logoSrc: string
  tenantName: string
  logoSubtitle: string
  razonsocial: string
  shopUrl?: string
}

export function PortalHeader({ logoSrc, tenantName, logoSubtitle, razonsocial, shopUrl }: PortalHeaderProps) {
  const router = useRouter()
  const [notifOpen, setNotifOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const notifRef = useRef<HTMLDivElement | null>(null)
  const notif = useNotifications()

  async function handleLogout() {
    setLoggingOut(true)
    await fetch("/api/auth/logout", { method: "POST" })
    router.push("/portal")
  }

  useEffect(() => {
    if (!notifOpen) return
    function handleClick(event: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) setNotifOpen(false)
    }
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") setNotifOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKeydown)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKeydown)
    }
  }, [notifOpen])

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
        {/* Tienda chip — activo solo cuando el flag shop-enabled está activo */}
        {shopUrl ? (
          <a
            href={shopUrl}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors hover:opacity-80"
            style={{ background: "var(--blue-soft)", color: "var(--blue)", border: "1px solid var(--blue-soft)" }}
          >
            <ShoppingCart size={12} strokeWidth={1.2} color="currentColor" />
            Ir a la tienda
          </a>
        ) : (
          <div
            className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium cursor-not-allowed"
            style={{ background: "var(--bg)", color: "var(--ink-faint)", border: "1px solid var(--border)" }}
          >
            <ShoppingCart size={12} strokeWidth={1.2} color="currentColor" />
            Tienda · Pronto
          </div>
        )}

        {/* Campanita de notificaciones */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => setNotifOpen((p) => !p)}
            aria-label="Notificaciones"
            className="relative flex items-center justify-center w-8 h-8 rounded-full transition-colors hover:bg-[var(--bg)]"
          >
            <Bell size={18} strokeWidth={1.6} style={{ color: "var(--ink-soft)" }} />
            <NotifBadge count={notif.unread} />
          </button>

          {notifOpen && (
            <NotifDropdown
              notif={notif}
              onClose={() => setNotifOpen(false)}
            />
          )}
        </div>

        {/* Avatar + menú */}
        <DropdownMenu
          className="w-56"
          items={
            [
              { type: "label", label: razonsocial },
              {
                label: "Salir",
                icon: <LogOut size={15} strokeWidth={1.6} />,
                tone: "danger",
                disabled: loggingOut,
                onSelect: handleLogout,
              },
            ] as DropdownMenuEntry[]
          }
        >
          <button
            type="button"
            aria-label="Menú de usuario"
            className="flex items-center gap-1.5 transition-opacity hover:opacity-80"
          >
            <Avatar size="sm" name={razonsocial} className="h-8 w-8 text-xs font-bold" />
            <ChevronDown size={14} strokeWidth={2} style={{ color: "var(--ink-soft)" }} />
          </button>
        </DropdownMenu>
      </div>
    </header>
  )
}

// ── Notificaciones ────────────────────────────────────────────────────────────

interface NotifRow {
  id: string
  facturaId: string
  type: string
  channel: string
  sentAt: string
  status: string
  error: string | null
  readAt: string | null
}

type Tone = "info" | "warn" | "danger"

interface NotifTarget {
  label: string // texto accesible del botón, ej. "Ver factura"
  href: string  // navegación por URL — funciona desde cualquier página del portal
}

interface NotifMeta {
  title: string
  detail: string
  tone: Tone
  target?: NotifTarget // si existe, se muestra el botón para navegar
}

// URL del dashboard apuntando a un comprobante. Para facturas abre el detalle
// directamente (?factura=ID); para el resto filtra la tab por comprobante.
function dashboardHref(kind: EntityKind, id: string) {
  if (kind === "factura") return `/portal/dashboard?factura=${encodeURIComponent(id)}`
  return `/portal/dashboard?tab=${kind}s&q=${encodeURIComponent(id)}`
}

// Deriva mensaje + severidad + destino navegable del type.
// Tipos de factura: before_due_N / after_due_N.
// Tipos futuros (pago confirmado, presupuesto por vencer, etc.) se agregan acá.
function describeNotif(row: NotifRow): NotifMeta {
  const before = row.type.match(/^before_due_(\d+)$/)
  const after = row.type.match(/^after_due_(\d+)$/)
  const facturaTarget: NotifTarget = { label: "Ver factura", href: dashboardHref("factura", row.facturaId) }

  if (before) {
    const n = Number(before[1])
    const cuando = n === 0 ? "vence hoy" : n === 1 ? "vence mañana" : `vence en ${n} días`
    return {
      title: `Factura ${row.facturaId} ${cuando}`,
      detail: "Recordatorio de vencimiento",
      tone: n <= 1 ? "warn" : "info",
      target: facturaTarget,
    }
  }

  if (after) {
    const n = Number(after[1])
    const cuando = n === 1 ? "venció hace 1 día" : `venció hace ${n} días`
    return {
      title: `Factura ${row.facturaId} ${cuando}`,
      detail: "Pago vencido — regularizá tu cuenta",
      tone: "danger",
      target: facturaTarget,
    }
  }

  // Cambio en condiciones comerciales → navega a la página de condiciones
  if (row.type === "conditions_changed") {
    return {
      title: "Se actualizaron tus condiciones comerciales",
      detail: "Revisá tu condición de pago, descuentos y crédito",
      tone: "info",
      target: { label: "Ver condiciones", href: "/portal/condiciones" },
    }
  }

  // Notificación de sistema sin destino navegable
  return { title: `Factura ${row.facturaId}`, detail: "Notificación del sistema", tone: "info" }
}

const TONE_STYLES: Record<Tone, { bg: string; color: string }> = {
  info: { bg: "rgba(12,62,214,0.1)", color: "#1d4ed8" },
  warn: { bg: "rgba(217,119,6,0.12)", color: "#b45309" },
  danger: { bg: "rgba(220,38,38,0.1)", color: "#b91c1c" },
}

function ToneIcon({ tone }: { tone: Tone }) {
  const { color } = TONE_STYLES[tone]
  if (tone === "danger") return <AlertTriangle size={13} style={{ color }} />
  return <Clock size={13} style={{ color }} />
}

function useNotifications() {
  const [rows, setRows] = useState<NotifRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch("/api/notifications/log")
      .then((r) => r.json())
      .then((data: NotifRow[]) => { setRows(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const unread = rows.filter((r) => !r.readAt).length

  // Optimista: actualiza la UI al instante y persiste en background.
  function markRead(ids: string[]) {
    if (!ids.length) return
    const now = new Date().toISOString()
    setRows((prev) => prev.map((r) => (ids.includes(r.id) && !r.readAt ? { ...r, readAt: now } : r)))
    fetch("/api/notifications/log", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).catch(() => {})
  }

  function markAllRead() {
    const now = new Date().toISOString()
    setRows((prev) => prev.map((r) => (r.readAt ? r : { ...r, readAt: now })))
    fetch("/api/notifications/log", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {})
  }

  return { rows, loading, unread, markRead, markAllRead }
}

function NotifBadge({ count }: { count: number }) {
  if (!count) return null
  return (
    <span
      className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold text-white"
      style={{ background: "var(--red, #dc2626)" }}
    >
      {count > 9 ? "9+" : count}
    </span>
  )
}

function NotifDropdown({
  notif,
  onClose,
}: {
  notif: ReturnType<typeof useNotifications>
  onClose: () => void
}) {
  const { rows, loading, unread, markRead, markAllRead } = notif
  const router = useRouter()

  function handleTarget(row: NotifRow, target: NotifTarget) {
    markRead([row.id])
    router.push(target.href)
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-label="Notificaciones"
      className="absolute right-0 mt-2 w-80 rounded-[12px] z-50 overflow-hidden"
      style={{
        background: "var(--card)",
        border: "1px solid var(--border)",
        boxShadow: "0 12px 32px rgba(16,24,40,0.14)",
      }}
    >
      <div className="px-4 py-3 flex items-center justify-between gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Notificaciones</p>
        {unread > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="text-[11px] font-medium transition-colors hover:opacity-80"
            style={{ color: "var(--blue)" }}
          >
            Marcar todas como leídas
          </button>
        )}
      </div>

      <div className="max-h-80 overflow-y-auto">
        {loading && (
          <p className="text-xs py-6 text-center" style={{ color: "var(--ink-soft)" }}>Cargando...</p>
        )}
        {!loading && !rows.length && (
          <div className="flex flex-col items-center gap-2 py-8" style={{ color: "var(--ink-soft)" }}>
            <Bell size={24} strokeWidth={1.4} />
            <p className="text-xs">Sin notificaciones</p>
          </div>
        )}
        {rows.map((row) => {
          const meta = describeNotif(row)
          const tone = TONE_STYLES[meta.tone]
          const fecha = new Date(row.sentAt)
          const fechaStr = fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })
          const isRead = !!row.readAt
          // Clic en la fila: si tiene destino navega (y marca leída); si no, solo marca leída.
          // Siempre clickeable, esté leída o no, para poder volver a entrar.
          const handleRowClick = () => {
            if (meta.target) handleTarget(row, meta.target)
            else markRead([row.id])
          }
          return (
            <div
              key={row.id}
              onClick={handleRowClick}
              className="flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--bg)]"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <span
                className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: tone.bg }}
              >
                <ToneIcon tone={meta.tone} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {!isRead && (
                    <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: "var(--blue)" }} />
                  )}
                  <p className="text-xs font-medium" style={{ color: "var(--ink)" }}>
                    {meta.title}
                  </p>
                </div>
                <p className="text-xs mt-0.5" style={{ color: meta.tone === "danger" ? tone.color : "var(--ink-soft)" }}>
                  {meta.detail}
                </p>
                <span className="text-[11px] mt-1 block" style={{ color: "var(--ink-faint, #9ca3af)" }}>
                  {fechaStr}
                </span>
              </div>
              {meta.target && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleTarget(row, meta.target!) }}
                  aria-label={meta.target.label}
                  title={meta.target.label}
                  className="mt-0.5 flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full transition-colors hover:bg-[var(--card)]"
                  style={{ color: "var(--blue)" }}
                >
                  <ChevronRight size={15} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
