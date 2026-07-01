"use client"

import { Dialog, Button } from "@myd-org/ui"

export interface PendingContact {
  end_user_id: string
  contact: string
  last_inbound_at: string | null
}

interface Props {
  open: boolean
  action: "away" | "logout"
  contacts: PendingContact[]
  onCancel: () => void
  onConfirm: () => void
}

// Se muestra cuando el operador intenta marcarse ausente o cerrar sesión teniendo
// conversaciones asignadas dentro de la ventana de 24hs y aún sin responder.
export function PendingRepliesDialog({ open, action, contacts, onCancel, onConfirm }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onCancel() }}
      title="Tenés mensajes asignados sin responder"
      description={
        action === "away"
          ? "Si te marcás como ausente, estas conversaciones quedan sin nadie respondiendo mientras corre la ventana de 24hs."
          : "Si cerrás sesión, estas conversaciones quedan sin nadie respondiendo mientras corre la ventana de 24hs."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Volver</Button>
          <Button variant="danger" onClick={onConfirm}>
            {action === "away" ? "Marcarme ausente igual" : "Cerrar sesión igual"}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-2">
        {contacts.map((c) => (
          <li
            key={c.end_user_id}
            className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border px-3 py-2"
          >
            <span className="truncate text-sm font-medium text-text">{c.contact}</span>
            <span className="shrink-0 text-xs text-muted">{formatRemaining(c.last_inbound_at)}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

function formatRemaining(lastInboundAt: string | null): string {
  if (!lastInboundAt) return "—"
  const closesAt = new Date(lastInboundAt).getTime() + 24 * 3_600_000
  const msLeft = closesAt - Date.now()
  if (msLeft <= 0) return "ventana cerrada"
  const h = Math.floor(msLeft / 3_600_000)
  const m = Math.floor((msLeft % 3_600_000) / 60_000)
  return h > 0 ? `quedan ${h}h ${m}m` : `quedan ${m}m`
}
