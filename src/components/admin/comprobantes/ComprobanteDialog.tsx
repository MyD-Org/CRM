"use client"

import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import { AlertTriangle, Check, Download, ExternalLink, MailWarning, RotateCw } from "lucide-react"
import { Badge, Button, Dialog, Field, Input, Select, Spinner } from "@myd-org/ui"
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

// Contexto del formulario "Cargar en Alegra" (GET …/{id}/load-context).
interface FacturaAbierta {
  alegraId: string
  number: string | null
  date: string
  balance: number
}
interface CuentaBancaria {
  alegraId: string
  name: string
}
interface LoadContext {
  openInvoices: FacturaAbierta[]
  bankAccounts: CuentaBancaria[]
}

const METODOS_ALEGRA = [
  { value: "transfer", label: "Transferencia" },
  { value: "cash", label: "Efectivo" },
  { value: "deposit", label: "Depósito" },
  { value: "check", label: "Cheque" },
  { value: "credit-card", label: "Tarjeta de crédito" },
  { value: "debit-card", label: "Tarjeta de débito" },
]
// Métodos para los que la API exige saber en qué cuenta entró el dinero (mismo criterio que
// valida el server en src/lib/receipt-alegra-load.ts).
const METODOS_CON_CUENTA = ["transfer", "deposit", "check"]

/** Default del select de medio según lo declarado por el cliente (lo que no mapea, va vacío). */
function medioDesdeMetodo(method: string): string {
  if (method === "transferencia") return "transfer"
  if (method === "efectivo") return "cash"
  if (method === "cheque") return "check"
  return ""
}

/** "Hoy" en Argentina para el `max` del input date (mismo criterio que InformarPagoModal). */
function hoyAR(): string {
  const partes = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

/** "12.345,67" / "12345,67" / "150.000" → "12345.67" / "12345.67" / "150000" (o null). */
function normalizarMonto(raw: string): string | null {
  let s = raw.trim().replace(/\s+/g, "")
  if (!s) return null
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".")
  } else {
    const partes = s.split(".")
    // Un punto con 3 dígitos después es separador de miles ("1.500" = 1500); en caso contrario
    // se respeta como decimal ("150.50").
    if (partes.length > 1 && partes[partes.length - 1].length === 3 && partes.every((p) => /^\d+$/.test(p))) {
      s = partes.join("")
    }
  }
  return /^\d+(\.\d{1,2})?$/.test(s) ? s : null
}

/** Centavos enteros → "$ 1.234,56" (para mostrar deltas sin pasar por floats). */
function fmtCentavos(cents: number): string {
  return fmtMonto((cents / 100).toFixed(2))
}

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

  // Segundo paso: formulario "Cargar en Alegra".
  const [formAbierto, setFormAbierto] = useState(false)
  const [cargandoContexto, setCargandoContexto] = useState(false)
  const [errorContexto, setErrorContexto] = useState("")
  const [contexto, setContexto] = useState<LoadContext | null>(null)
  const [monto, setMonto] = useState("")
  const [fechaPago, setFechaPago] = useState("")
  const [medio, setMedio] = useState("")
  const [cuentaId, setCuentaId] = useState("")
  const [asignaciones, setAsignaciones] = useState<Record<string, string>>({})
  const [cargandoAlegra, setCargandoAlegra] = useState(false)
  const [errorAlegra, setErrorAlegra] = useState("")

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
      setErrorAccion("Error de conexión. Intente nuevamente.")
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
      setErrorAccion("Error de conexión. Intente nuevamente.")
    } finally {
      setAccionando(false)
    }
  }

  /** GET load-context + defaults del formulario. 404 = mismo cierre que el detalle. */
  async function cargarContexto() {
    if (!receipt) return
    setCargandoContexto(true)
    setErrorContexto("")
    try {
      const res = await fetch(`/api/admin/comprobantes/${id}/load-context`, { cache: "no-store" })
      if (res.status === 404) {
        setFormAbierto(false)
        setNotFound(true)
        setReceipt(null)
        return
      }
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setContexto(null)
        setErrorContexto(body?.error ?? "No pudimos preparar la carga")
        return
      }
      setContexto(body as LoadContext)
      setMonto(receipt.amount)
      setFechaPago(receipt.paidOn)
      setMedio(medioDesdeMetodo(receipt.method))
      setCuentaId("")
      setAsignaciones({})
    } catch {
      setContexto(null)
      setErrorContexto("Error de conexión. Intente nuevamente.")
    } finally {
      setCargandoContexto(false)
    }
  }

  function abrirCarga() {
    setErrorAccion("")
    setErrorAlegra("")
    setFormAbierto(true)
    void cargarContexto()
  }

  // Repartir el monto entre las facturas abiertas, de la MÁS VIEJA a la más nueva, hasta
  // cubrirlo. Si el monto excede el saldo total, se llena todo y el delta avisa (no confirma).
  function repartir() {
    const montoNorm = normalizarMonto(monto)
    if (!montoNorm || !contexto) return
    let restante = Math.round(Number(montoNorm) * 100)
    const next: Record<string, string> = {}
    for (const inv of contexto.openInvoices) {
      if (restante <= 0) break
      const poner = Math.min(Math.round(inv.balance * 100), restante)
      if (poner > 0) next[inv.alegraId] = (poner / 100).toFixed(2)
      restante -= poner
    }
    setAsignaciones(next)
  }

  async function confirmarCarga() {
    setCargandoAlegra(true)
    setErrorAlegra("")
    try {
      const allocations = Object.entries(asignaciones)
        .filter(([, v]) => v.trim() !== "")
        .map(([invoiceId, v]) => ({ invoiceId, amount: normalizarMonto(v) ?? v }))
      const res = await fetch(`/api/admin/comprobantes/${id}/load-to-alegra`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: medio,
          amount: normalizarMonto(monto),
          paidOn: fechaPago,
          ...(cuentaId ? { bankAccountId: cuentaId } : {}),
          allocations,
        }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok && body) {
        actualizar(body as AdminReceiptDto)
        setFormAbierto(false)
        return
      }
      if (res.status === 404) {
        setFormAbierto(false)
        setNotFound(true)
        setReceipt(null)
        return
      }
      setErrorAlegra(body?.error ?? "No pudimos cargar el pago en Alegra")
    } catch {
      setErrorAlegra("Error de conexión. Intente nuevamente.")
    } finally {
      setCargandoAlegra(false)
    }
  }

  const puedeReenviar =
    !!receipt &&
    !accionando &&
    (receipt.email.status === "failed" || receipt.email.status === "skipped" || receipt.email.stale)

  // Validación en vivo de la distribución: suma exacta al monto y ninguna factura por encima
  // de su saldo. El server re-valida contra Alegra antes de crear el pago.
  const montoNorm = normalizarMonto(monto)
  const montoCents = montoNorm ? Math.round(Number(montoNorm) * 100) : null
  let asignadoCents = 0
  let excesoSaldo = false
  for (const inv of contexto?.openInvoices ?? []) {
    const raw = asignaciones[inv.alegraId]
    if (raw === undefined || raw.trim() === "") continue
    const n = normalizarMonto(raw)
    if (n === null) continue
    asignadoCents += Math.round(Number(n) * 100)
    if (Math.round(Number(n) * 100) > Math.round(inv.balance * 100)) excesoSaldo = true
  }
  const faltaCents = montoCents !== null ? montoCents - asignadoCents : null
  const distribucionOk = faltaCents !== null && faltaCents === 0 && !excesoSaldo
  const cuentaRequerida = METODOS_CON_CUENTA.includes(medio)
  const sinFacturas = !!contexto && contexto.openInvoices.length === 0
  const formValido =
    !!montoNorm &&
    fechaPago !== "" &&
    medio !== "" &&
    (!cuentaRequerida || cuentaId !== "") &&
    distribucionOk &&
    !sinFacturas

  // Con pago real en Alegra no hay deshacer ni re-carga (la guarda es alegra_payment_id).
  const cargadoEnAlegra = !!receipt?.alegra
  const puedeCargarEnAlegra =
    !!receipt && (receipt.status === "pending" || (receipt.status === "loaded" && !cargadoEnAlegra))

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
                No pudimos mostrar el archivo. Intente abrirlo en una pestaña nueva.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => window.open(fileUrl(id), "_blank", "noopener")}>
                <ExternalLink size={13} /> Abrir en pestaña nueva
              </Button>
              <Button variant="ghost" size="sm" onClick={() => window.open(fileUrl(id, true), "_blank", "noopener")}>
                <Download size={13} /> Descargar
              </Button>
              {puedeCargarEnAlegra && (
                <Button size="sm" onClick={abrirCarga} disabled={accionando}>
                  <Check size={13} /> Cargar en Alegra
                </Button>
              )}
              {receipt.status === "pending" && (
                <Button variant="ghost" size="sm" onClick={() => { setErrorAccion(""); setConfirm("loaded") }} disabled={accionando}>
                  Ya lo cargué a mano
                </Button>
              )}
              {receipt.status === "loaded" && !cargadoEnAlegra && (
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
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Badge tone="success">Cargado</Badge>
                      {receipt.alegra ? (
                        <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
                          {receipt.alegra.number
                            ? `Pago N° ${receipt.alegra.number} en Alegra`
                            : `Pago en Alegra (id ${receipt.alegra.id})`}
                        </span>
                      ) : (
                        receipt.loaded?.byName && (
                          <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
                            por {receipt.loaded.byName} el {fmtFechaHora(receipt.loaded.at)}
                          </span>
                        )
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

            {receipt.declared && (
              <div className="rounded-[var(--radius)] p-3 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ink-faint)" }}>
                  Corregido al cargar
                </p>
                <p style={{ color: "var(--ink)" }}>
                  El cliente informó {fmtMonto(receipt.declared.amount)} el {fmtFecha(receipt.declared.paidOn)};
                  {" "}cargado según el comprobante.
                </p>
              </div>
            )}

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
        title={confirm === "loaded" ? "Ya lo cargué a mano" : "Deshacer carga"}
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
            ? "Usalo solo si cargaste el pago en Alegra por fuera de este panel: no se crea nada en Alegra, el comprobante queda marcado como cargado."
            : "El comprobante vuelve a quedar pendiente de cargar en Alegra. ¿Confirmás?"}
        </p>
      </Dialog>

      <Dialog
        open={formAbierto}
        onOpenChange={(open) => { if (!open) setFormAbierto(false) }}
        title="Cargar en Alegra"
        className="max-w-2xl"
        footer={
          contexto && !cargandoContexto && (
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setFormAbierto(false)} disabled={cargandoAlegra}>Cancelar</Button>
              <Button loading={cargandoAlegra} disabled={!formValido} onClick={confirmarCarga}>
                Confirmar carga
              </Button>
            </div>
          )
        }
      >
        {cargandoContexto && (
          <div className="flex items-center justify-center py-10">
            <Spinner />
          </div>
        )}

        {!cargandoContexto && errorContexto && (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="rounded-[var(--radius)] p-3 text-sm self-stretch" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
              {errorContexto}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void cargarContexto()}>Reintentar</Button>
          </div>
        )}

        {!cargandoContexto && contexto && (
          <div className="flex flex-col gap-4">
            {sinFacturas ? (
              <p className="rounded-[var(--radius)] p-3 text-sm" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--ink)" }}>
                El cliente no tiene facturas abiertas en Alegra para imputar el pago. Cargalo
                directamente en Alegra y marcá el comprobante con &quot;Ya lo cargué a mano&quot;.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Field label="Monto" hint="Según el comprobante; puede corregir lo informado.">
                    <Input
                      value={monto}
                      onChange={(e) => setMonto(e.target.value)}
                      inputMode="decimal"
                      placeholder="15000.00"
                      aria-invalid={!montoNorm}
                    />
                  </Field>
                  <Field label="Fecha del pago">
                    <Input
                      type="date"
                      value={fechaPago}
                      max={hoyAR()}
                      onChange={(e) => setFechaPago(e.target.value)}
                    />
                  </Field>
                  <Field label="Medio de pago">
                    <Select
                      options={METODOS_ALEGRA}
                      value={medio}
                      onValueChange={(v) => {
                        setMedio(v)
                        if (!METODOS_CON_CUENTA.includes(v)) setCuentaId("")
                      }}
                      placeholder="Seleccione el medio"
                      aria-label="Medio de pago"
                    />
                  </Field>
                  {cuentaRequerida && (
                    <Field label="Cuenta bancaria">
                      <Select
                        options={contexto.bankAccounts.map((c) => ({ value: c.alegraId, label: c.name }))}
                        value={cuentaId}
                        onValueChange={setCuentaId}
                        placeholder={contexto.bankAccounts.length > 0 ? "Seleccione la cuenta" : "Sin cuentas en Alegra"}
                        aria-label="Cuenta bancaria"
                      />
                    </Field>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-faint)" }}>
                      Facturas abiertas del cliente
                    </p>
                    <Button variant="secondary" size="sm" onClick={repartir} disabled={!montoNorm}>
                      Repartir
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    {contexto.openInvoices.map((inv) => (
                      <div
                        key={inv.alegraId}
                        className="grid grid-cols-[1fr_8.5rem] items-center gap-3 rounded-[var(--radius)] px-3 py-2"
                        style={{ border: "1px solid var(--border)" }}
                      >
                        <div className="min-w-0">
                          <p className="text-sm truncate" style={{ color: "var(--ink)" }}>
                            {inv.number ?? `Factura ${inv.alegraId}`}
                          </p>
                          <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
                            {fmtFecha(inv.date)} · saldo {fmtMonto(String(inv.balance))}
                          </p>
                        </div>
                        <Input
                          value={asignaciones[inv.alegraId] ?? ""}
                          onChange={(e) => setAsignaciones((prev) => ({ ...prev, [inv.alegraId]: e.target.value }))}
                          inputMode="decimal"
                          placeholder="0,00"
                          aria-label={`Monto para ${inv.number ?? inv.alegraId}`}
                        />
                      </div>
                    ))}
                  </div>
                  {faltaCents !== null && faltaCents > 0 && (
                    <p className="text-xs" style={{ color: "var(--red)" }}>Faltan asignar {fmtCentavos(faltaCents)}</p>
                  )}
                  {faltaCents !== null && faltaCents < 0 && (
                    <p className="text-xs" style={{ color: "var(--red)" }}>Las asignaciones superan el monto en {fmtCentavos(-faltaCents)}</p>
                  )}
                  {faltaCents === 0 && !excesoSaldo && (
                    <p className="text-xs" style={{ color: "var(--green)" }}>Distribución completa</p>
                  )}
                  {excesoSaldo && (
                    <p className="text-xs" style={{ color: "var(--red)" }}>Una de las facturas quedó por encima de su saldo</p>
                  )}
                </div>
              </>
            )}

            {errorAlegra && (
              <p className="rounded-[var(--radius)] p-3 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
                {errorAlegra}
              </p>
            )}
          </div>
        )}
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
