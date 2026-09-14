"use client"

import { useEffect, useRef, useState } from "react"
import { Button, Dialog, Spinner } from "@myd-org/ui"
import { ComprobantesInformados, type ComprobanteInformado } from "./ComprobantesInformados"

// Diálogo "Mis comprobantes": el historial de informados salió de la pestaña Pagos y vive
// acá, detrás de un botón de la toolbar. Al abrir pide la primera página a la API (el resto
// lo pagina ComprobantesInformados con "Cargar más", igual que antes).

interface Props {
  onClose: () => void
}

export function MisComprobantesDialog({ onClose }: Props) {
  const [datos, setDatos] = useState<{ comprobantes: ComprobanteInformado[]; total: number } | null>(null)
  const [error, setError] = useState("")
  const cancelado = useRef(false)

  useEffect(() => {
    fetch("/api/portal/comprobantes?start=0", { cache: "no-store" })
      .then(async (res) => {
        if (cancelado.current) return
        if (!res.ok) {
          setError("No pudimos cargar tus comprobantes, intentá de nuevo.")
          return
        }
        const body = await res.json().catch(() => null)
        if (cancelado.current || !body) return
        setDatos({
          comprobantes: (body.comprobantes as ComprobanteInformado[]) ?? [],
          total: Number(body.total ?? 0),
        })
      })
      .catch(() => {
        if (!cancelado.current) setError("No pudimos cargar tus comprobantes, intentá de nuevo.")
      })
    return () => {
      cancelado.current = true
    }
  }, [])

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Comprobantes que informaste"
      className="max-w-2xl"
    >
      {!datos && !error && (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      )}
      {error && (
        <div className="flex flex-col items-center gap-3 py-6">
          <p className="rounded-[var(--radius)] p-3 text-sm self-stretch" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
        </div>
      )}
      {datos && (
        <ComprobantesInformados comprobantes={datos.comprobantes} total={datos.total} mostrarTitulo={false} />
      )}
    </Dialog>
  )
}
