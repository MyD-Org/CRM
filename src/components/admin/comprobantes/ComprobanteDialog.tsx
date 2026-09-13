"use client"

import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import { AlertTriangle, Check, Download, ExternalLink, MailWarning, RotateCw } from "lucide-react"
import { Badge, Button, Dialog, Spinner } from "@myd-org/ui"
import type { AdminReceiptDto } from "@/lib/payment-receipts"
import { fileLabel, fmtFecha, fmtFechaHora, fmtMonto, fmtTamano, methodLabel } from "./format"

interface Props {
  id: string
  /** DTO de la fila si el diálogo se abrió desde la lista (puede estar levemente viejo). */
  initial: AdminReceiptDto | null
  onClose: () => void
  onChanged: (next: AdminReceiptDto) => void
}

type ConfirmAction = "loaded" | "pending"

// El archivo NUNCA pasa por la función: el <img>/<iframe> y window.open siguen el 302 a R2.
function fileUrl(id: string, download = false) {
  return `/api/admin/comprobantes/${id}/file${download ? "?download=1" : ""}`
}

export function ComprobanteDialog({ id, initial, onClose, onChanged }: Props) {
  const [receipt, setReceipt] = useState<AdminReceiptDto | null>(initial)
  const [notFound, setNotFound] = useState(false)
  const [cargando, setCargando] = useState(!initial)
  const [errorCarga, setErrorCarga] = useState("")
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [accionando, setAccionando] = useState(false)
  const [errorAccion, setErrorAccion] = useState("")
  const [previoError, setPrevioError] = useState(false)
  const cancelado = useRef(false)

  // Detalle fresco al abrir: la fila de la lista puede tener el estado viejo, y cuando se abre
  // por ?id= (link del mail) no hay fila. 404 = inexistente/ajeno: mismo aviso que en la lista.
  useEffect(() => {
    fetch(`/api/admin/comprobantes/${id}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelado.current) return
        if (!res.ok) {
          setNotFound(res.status === 404)
          setErrorCarga(res.status === 404 ? "" : "No pudimos cargar el comprobante")
          setCargando(false)
          return
        }
        setReceipt((await res.json()) as AdminReceiptDto)
        setCargando(false)
      })
      .catch(() => {
        if (cancelado.current) return
        setErrorCarga("No pudimos cargar el comprobante")
        setCargando(false)
      })
    return () => {
      cancelado.current = true
    }
  }, [id])

  function actualizar(next: AdminReceiptDto) {
    setReceipt(next)
    onChanged(next)
  }

  async function cambiarEstado(to: ConfirmAction) {
    setAccionando(true)
    setErrorAccion("")
    try {
      const res = await fetch(`/api/admin/comprobantes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: to }),
      })
      if (res.ok) {
        actualizar((await res.json()) as AdminReceiptDto)
        setConfirm(null)
        return
      }
      if (res.status === 404) {
        setConfirm(null)
        setNotFound(true)
        setReceipt(null)
        return
      }
      const body = await res.json().catch(() => null)
      setErrorAccion(body?.error ?? "No pudimos actualizar el comprobante")
    } catch {
      setErrorAccion("Error de conexión. Intentá de nuevo.")
    } finally {
      setAccionando(false)
    }
  }

  async function reenviarMail() {
    setAccionando(true)
    setErrorAccion("")
    try {
      const res = await fetch(`/api/admin/comprobantes/${id}/resend-email`, { method: "POST" })
      const body = await res.json().catch(() => null)
      if (res.ok && body?.email && receipt) {
        actualizar({ ...receipt, email: body.email })
        return
      }
      // 409 email_in_progress / email_skipped y 502 email_failed: el server manda mensaje mostrable.
      setErrorAccion(body?.error ?? "No pudimos reenviar el mail")
    } catch {
      setErrorAccion("Error de conexión. Intentá de nuevo.")
    } finally {
      setAccionando(false)
    }
  }

  const puedeReenviar =
    !!receipt &&
    !accionando &&
    (receipt.email.status === "failed" || receipt.email.status === "skipped" || receipt.email.stale)

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => { if (!open) onClose() }}
        title="Comprobante de pago"
        className="max-w-2xl"
      >
        {cargando && (
          <div className="flex items-center justify-center py-10">
            <Spinner />
          </div>
        )}

        {notFound && (
          <p className="rounded-[var(--radius)] p-4 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
            Comprobante no encontrado.
          </p>
        )}

        {!cargando && errorCarga && !notFound && (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>{errorCarga}</p>
            <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
          </div>
        )}

        {receipt && (
          <div className="flex flex-col gap-4">
            {receipt.file.mime.startsWith("image/") ? (
              <div
                className="relative w-full h-[46vh] rounded-[var(--radius)]"
                style={{ border: "1px solid var(--border)", background: "var(--bg)" }}
              >
                <Image
                  src={fileUrl(id)}
                  alt="Comprobante de pago"
                  fill
                  unoptimized
                  className="object-contain"
                  onError={() => setPrevioError(true)}
                />
              </div>
            ) : (
              <iframe
                src={fileUrl(id)}
                title="Comprobante de pago"
                className="w-full rounded-[var(--radius)]"
                style={{ height: "min(46vh, 520px)", border: "1px solid var(--border)", background: "var(--bg)" }}
                onError={() => setPrevioError(true)}
              />
            )}
            {previoError && (
              <p className="text-xs" style={{ color: "var(--red)" }}>
                No pudimos mostrar el archivo. Probá abrirlo en una pestaña nueva.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => window.open(fileUrl(id), "_blank", "noopener")}>
                <ExternalLink size={13} /> Abrir en pestaña nueva
              </Button>
              <Button variant="ghost" size="sm" onClick={() => window.open(fileUrl(id, true), "_blank", "noopener")}>
                <Download size={13} /> Descargar
              </Button>
              {receipt.status === "pending" ? (
                <Button size="sm" onClick={() => { setErrorAccion(""); setConfirm("loaded") }} disabled={accionando}>
                  <Check size={13} /> Marcar cargado en Alegra
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => { setErrorAccion(""); setConfirm("pending") }} disabled={accionando}>
                  Deshacer
                </Button>
              )}
              {puedeReenviar && (
                <Button variant="ghost" size="sm" onClick={reenviarMail} disabled={accionando}>
                  <RotateCw size={13} /> Reenviar mail
                </Button>
              )}
            </div>

            {errorAccion && (
              <p className="rounded-[var(--radius)] p-3 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
                {errorAccion}
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Fila label="Cliente" value={receipt.razonsocial} />
              {receipt.cuit && <Fila label="CUIT" value={receipt.cuit} />}
              <Fila label="Monto" value={<span className="font-semibold">{fmtMonto(receipt.amount)}</span>} />
              <Fila label="Fecha del pago" value={fmtFecha(receipt.paidOn)} />
              <Fila label="Medio" value={methodLabel(receipt.method, receipt.methodOther)} />
              <Fila label="Informado el" value={fmtFechaHora(receipt.submittedAt)} />
              <Fila
                label="Archivo"
                value={
                  <>
                    {receipt.file.originalName ?? "comprobante"}
                    <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
                      {" "}
                      · {fileLabel(receipt.file.mime, receipt.file.convertedFrom)} · {fmtTamano(receipt.file.size)}
                    </span>
                  </>
                }
              />
              <Fila
                label="Estado"
                value={
                  receipt.status === "loaded" ? (
                    <span className="inline-flex items-center gap-2">
                      <Badge tone="success">Cargado</Badge>
                      {receipt.loaded?.byName && (
                        <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
                          por {receipt.loaded.byName} el {fmtFechaHora(receipt.loaded.at)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <Badge tone="warning">Pendiente</Badge>
                  )
                }
              />
              <Fila
                label="Mail de aviso"
                value={<EstadoMail receipt={receipt} />}
              />
              {receipt.clientEmail && <Fila label="Email del cliente" value={receipt.clientEmail} />}
            </div>

            {receipt.notes && (
              <div className="rounded-[var(--radius)] p-3 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ink-faint)" }}>
                  Notas del cliente
                </p>
                <p style={{ color: "var(--ink)" }}>{receipt.notes}</p>
              </div>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={confirm === "loaded" ? "Marcar cargado en Alegra" : "Deshacer carga"}
        headerBorder={false}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={accionando}>Cancelar</Button>
            <Button
              variant={confirm === "pending" ? "danger" : "primary"}
              loading={accionando}
              onClick={() => confirm && cambiarEstado(confirm)}
            >
              {confirm === "loaded" ? "Sí, ya lo cargué" : "Sí, deshacer"}
            </Button>
          </div>
        }
      >
        <p className="text-sm" style={{ color: "var(--ink)" }}>
          {confirm === "loaded"
            ? "Confirmá que ya cargaste este pago en Alegra. El comprobante va a quedar marcado como cargado."
            : "El comprobante vuelve a quedar pendiente de cargar en Alegra. ¿Confirmás?"}
        </p>
      </Dialog>
    </>
  )
}

function Fila({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-medium" style={{ color: "var(--ink-faint)" }}>{label}</p>
      <div className="text-sm" style={{ color: "var(--ink)" }}>{value}</div>
    </div>
  )
}

function EstadoMail({ receipt }: { receipt: AdminReceiptDto }) {
  const { email } = receipt
  if (email.status === "sent") {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="success">Enviado</Badge>
        {email.sentAt && (
          <span className="text-xs" style={{ color: "var(--ink-faint)" }}>el {fmtFechaHora(email.sentAt)}</span>
        )}
      </span>
    )
  }
  if (email.status === "skipped") {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="danger" className="flex items-center gap-1">
          <MailWarning size={9} /> No enviado
        </Badge>
        <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
          Falta el email destino o el remitente.
        </span>
      </span>
    )
  }
  if (email.status === "failed") {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="danger" className="flex items-center gap-1">
          <MailWarning size={9} /> No enviado
        </Badge>
        {email.error && (
          <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{email.error}</span>
        )}
      </span>
    )
  }
  // pending (recién informado o stale: el badge "Mail no enviado" ya avisa en la lista).
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={email.stale ? "danger" : "neutral"} className="flex items-center gap-1">
        {email.stale && <AlertTriangle size={9} />}
        {email.stale ? "Mail no enviado" : "Pendiente de envío"}
      </Badge>
      <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
        {email.attempts > 0 ? `Intentos: ${email.attempts}` : "Se avisa por email al informar el pago."}
      </span>
    </span>
  )
}
