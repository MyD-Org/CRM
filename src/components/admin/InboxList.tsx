"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { MessageSquare, Clock, Bot, User, MessageCircleWarning } from "lucide-react"
import { Tabs, Badge, EmptyState } from "@myd-org/ui"
import type { InboxContact } from "@/lib/inbox-api"

type Tab = "active" | "history"
type Scope = "all" | "mine"

interface Props {
  initialContacts: InboxContact[]
  currentUserId: string
}

export function InboxList({ initialContacts, currentUserId }: Props) {
  const [contacts, setContacts] = useState(initialContacts)
  const [tab, setTab] = useState<Tab>("active")
  const [scope, setScope] = useState<Scope>("all")

  // El fetch depende solo de la solapa principal: "Activas" trae solo ventana abierta;
  // "Históricas" trae todos. "Todas / Mis conversaciones" es una sub-solapa que filtra
  // esa misma lista en el cliente, no dispara otro fetch.
  useEffect(() => {
    const fetchScope = tab === "active" ? "active" : "all"
    let cancelled = false
    const load = async () => {
      const res = await fetch(`/api/admin/inbox/contacts?scope=${fetchScope}`)
      if (res.ok && !cancelled) setContacts(await res.json())
    }
    load()
    const interval = setInterval(load, 10_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [tab])

  const mine = contacts.filter((c) => c.assigned_operator_id === currentUserId)
  const pendingCount = contacts.filter((c) => c.awaiting_reply).length
  const visible = scope === "mine" ? mine : contacts

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        variant="underline"
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        items={[
          {
            value: "active",
            label: (
              <span className="flex items-center gap-1.5">
                Activas
                {pendingCount > 0 && tab === "active" && (
                  <Badge tone="warning" className="text-[10px] px-1.5 py-0">
                    {pendingCount}
                  </Badge>
                )}
              </span>
            ),
          },
          { value: "history", label: "Históricas" },
        ]}
      />

      <Tabs
        variant="pill"
        value={scope}
        onValueChange={(v) => setScope(v as Scope)}
        items={[
          { value: "all", label: "Todas" },
          {
            value: "mine",
            label: (
              <span className="flex items-center gap-1.5">
                Mis conversaciones
                {mine.length > 0 && (
                  <Badge tone="info" className="text-[10px] px-1.5 py-0">
                    {mine.length}
                  </Badge>
                )}
              </span>
            ),
          },
        ]}
      />

      {!visible.length ? (
        <EmptyState
          icon={<MessageSquare size={28} strokeWidth={1.2} />}
          title={
            scope === "mine" ? "No tenés contactos asignados"
              : tab === "history" ? "No hay contactos en el historial"
                : "No hay conversaciones activas"
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((c) => (
            <Link
              key={c.end_user_id}
              href={`/admin/inbox/c/${c.end_user_id}`}
              className="flex items-center gap-4 px-4 py-3 rounded-[var(--radius)] transition-colors hover:opacity-90 overflow-hidden"
              style={{
                background: c.awaiting_reply ? "var(--amber-soft)" : "var(--card)",
                border: `1px solid ${c.awaiting_reply ? "var(--amber)" : "var(--border)"}`,
                borderLeft: `3px solid ${c.awaiting_reply ? "var(--amber)" : urgencyColor(c.last_inbound_at)}`,
              }}
            >
              <div className="relative shrink-0">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center"
                  style={{ background: c.awaiting_reply ? "var(--amber)" : "var(--blue-soft)" }}
                >
                  {c.awaiting_reply
                    ? <MessageCircleWarning size={16} strokeWidth={1.6} style={{ color: "white" }} />
                    : <MessageSquare size={16} strokeWidth={1.6} style={{ color: "var(--blue)" }} />
                  }
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--ink)" }}>
                    {c.contact}
                  </p>
                  <ModeChip mode={c.mode} operatorName={c.assigned_operator_name ?? null} />
                  {c.awaiting_reply && (
                    <Badge tone="warning" className="flex items-center gap-1 shrink-0">
                      <MessageCircleWarning size={9} />
                      Sin respuesta
                    </Badge>
                  )}
                </div>
                <p className="text-xs truncate mt-0.5" style={{ color: "var(--ink-soft)" }}>
                  {c.last_message
                    ? c.last_message
                    : `${c.channel}${c.phone && c.phone !== c.contact ? ` · ${c.phone}` : ""}`}
                  {" · "}{c.last_inbound_at ? formatTime(c.last_inbound_at) : "—"}
                </p>
              </div>

              <WindowBadge within={c.within_window} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function ModeChip({ mode, operatorName }: { mode: string; operatorName: string | null }) {
  if (mode !== "human") {
    return (
      <Badge tone="info" className="flex items-center gap-1">
        <Bot size={9} />
        Bot
      </Badge>
    )
  }
  // En modo humano nunca mostramos el genérico "Humano": o el operador asignado, o un
  // "Sin asignar" en alerta para que se vea que esa conversación necesita dueño.
  return operatorName
    ? (
      <Badge tone="success" className="flex items-center gap-1">
        <User size={9} />
        Asignado a {operatorName}
      </Badge>
    )
    : (
      <Badge tone="warning" className="flex items-center gap-1">
        <User size={9} />
        Sin asignar
      </Badge>
    )
}

function WindowBadge({ within }: { within: boolean }) {
  return (
    <Badge tone={within ? "success" : "neutral"} className="flex items-center gap-1 shrink-0">
      <Clock size={10} />
      {within ? "Ventana abierta" : "Ventana cerrada"}
    </Badge>
  )
}

function urgencyColor(lastInboundAt: string | null): string {
  if (!lastInboundAt) return "transparent"
  const diffH = (Date.now() - new Date(lastInboundAt).getTime()) / 3_600_000
  if (diffH > 6) return "var(--color-danger)"
  if (diffH > 1) return "var(--color-warning)"
  return "transparent"
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  const diffM = Math.floor(diffMs / 60_000)
  if (diffM < 1) return "ahora"
  if (diffM < 60) return `hace ${diffM}m`
  if (diffH < 24) return `hace ${diffH}h`
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })
}
