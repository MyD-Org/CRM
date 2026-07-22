"use client"

import { useState } from "react"
import { Bot, Power } from "lucide-react"
import { Badge, Button, Dialog, useToast } from "@myd-org/ui"

interface Props {
  initialEnabled: boolean
}

// Kill switch global del bot. Apagarlo detiene las respuestas del bot en TODAS las
// conversaciones del tenant (los mensajes entrantes siguen entrando al inbox para que un
// operador los atienda a mano). Apagar pide confirmación; encender es inmediato.
export function BotKillSwitch({ initialEnabled }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  const apply = async (next: boolean) => {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/inbox/bot-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) throw new Error()
      setEnabled(next)
      toast({
        title: next ? "Bot reactivado" : "Bot pausado",
        description: next
          ? "Vuelve a responder automáticamente en todos los canales."
          : "No responderá; los mensajes quedan en el inbox para atención manual.",
        tone: next ? "success" : "warning",
      })
    } catch {
      toast({ title: "No se pudo cambiar el estado del bot", tone: "danger" })
    } finally {
      setSaving(false)
      setConfirmOpen(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {/* Estado del bot ("Bot activo/pausado"): oculto en mobile para ahorrar ancho —
          el color del botón (rojo=activo/verde=pausado) ya comunica el estado. Solo desktop. */}
      <span className="hidden md:flex items-center gap-1.5 text-sm" style={{ color: "var(--ink-soft)" }}>
        <Bot className="w-4 h-4" />
        {enabled ? (
          <Badge tone="success">Bot activo</Badge>
        ) : (
          <Badge tone="warning">Bot pausado</Badge>
        )}
      </span>

      <Button
        variant={enabled ? "danger" : "primary"}
        size="sm"
        disabled={saving}
        onClick={() => (enabled ? setConfirmOpen(true) : apply(true))}
      >
        <Power className="w-4 h-4 mr-1.5" />
        {enabled ? "Pausar bot" : "Reactivar bot"}
      </Button>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="¿Pausar el bot?"
        description="El bot dejará de responder en TODAS las conversaciones de todos los canales. Los mensajes de los clientes seguirán llegando al inbox para que un operador los atienda a mano. Podés reactivarlo en cualquier momento."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button variant="danger" size="sm" onClick={() => apply(false)} disabled={saving}>
              {saving ? "Pausando…" : "Pausar bot"}
            </Button>
          </div>
        }
      />
    </div>
  )
}
