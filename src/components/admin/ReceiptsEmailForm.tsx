"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button, Field, Input, useToast } from "@myd-org/ui"

interface Props {
  initialReceiptsEmail: string
}

// Configuración → Comprobantes: el único mail destino de los avisos de comprobantes de pago
// (`tenants.receipts_email`, expuesto por GET/PUT /api/admin/settings/receipts). Vacío =
// permitido: los avisos quedan "skipped" y la pantalla de Comprobantes muestra el aviso.
export function ReceiptsEmailForm({ initialReceiptsEmail }: Props) {
  const [email, setEmail] = useState(initialReceiptsEmail)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const { toast } = useToast()

  async function handleSave() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/admin/settings/receipts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receiptsEmail: email }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError(body?.error ?? "No pudimos guardar el email")
        return
      }
      setEmail(body.receiptsEmail ?? email)
      // El aviso de "destino no configurado" en /admin/comprobantes depende de este valor.
      router.refresh()
      toast({ title: "Email guardado", tone: "success" })
    } catch {
      setError("Error de conexión. Intente nuevamente.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 max-w-xl">
      <Field
        label="Email para comprobantes"
        hint="Cuando un cliente informa un pago desde el portal, se avisa a este email con el comprobante adjunto (hasta 10 MB; si pesa más, con un link). Si lo deja vacío, los avisos no se envían: los comprobantes siguen llegando a la pantalla de Comprobantes."
      >
        <Input
          type="email"
          value={email}
          placeholder="pagos@ejemplo.com"
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(error)}
        />
      </Field>
      {error && <p className="text-sm" style={{ color: "var(--red)" }}>{error}</p>}
      <div>
        <Button onClick={handleSave} loading={saving} disabled={saving}>
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  )
}
