"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, Info } from "lucide-react"
import { Badge, Button, Dialog, Field, FileDropZone, Input, Progress, Select, Textarea } from "@myd-org/ui"
import type { ComprobanteInformado } from "./ComprobantesInformados"
import {
  isValidPaidOn,
  MAX_FILE_BYTES,
  MAX_METHOD_OTHER_CHARS,
  MAX_NOTES_CHARS,
  parseAmount,
} from "@/lib/receipt-validation"

// Modal "Informar pago" (portal → Pagos). El archivo NO pasa por el CRM: primero se pide una
// URL PUT prefirmada (init), se sube directo a R2 con XHR (con progress) y recién después se
// llama al confirm, que verifica el archivo y avisa a la empresa. Un error recuperable de la
// subida NO llama al confirm: se muestra el error y se puede reintentar la subida a la misma
// URL (sigue viva 10 minutos) sin crear una fila nueva.

const ACCEPT = "image/jpeg,image/png,application/pdf"
// C: el <input accept> sigue pidiendo JPG/PNG/PDF (iOS convierte la mayoría de las fotos),
// pero si un HEIC se cuela por Mac/Files/AirDrop el server lo convierte: el cliente no lo
// rechaza. HEIC/HEIF figuran en TIPOS_SOPORTADOS para dejarlo pasar.
const TIPOS_SOPORTADOS = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif"]

const METODOS = [
  { value: "transferencia", label: "Transferencia" },
  { value: "cheque", label: "Cheque" },
  { value: "efectivo", label: "Efectivo" },
  { value: "otro", label: "Otro" },
]

type Etapa = "form" | "creating" | "uploading" | "confirming" | "done" | "queued"

interface InitResponse {
  id: string
  upload: {
    url: string
    method: "PUT"
    headers: { "content-type": string }
    expiresAt: string
  }
}

interface Fallo {
  mensaje: string
  /** En qué etapa falló: la subida (re-PUT a la misma URL) o el confirm (re-llamada). */
  etapa: "put" | "confirm"
  reintentable: boolean
}

/** "Hoy" en Argentina (mismo criterio que la validación del server) para el `max` del date. */
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

function tipoDeclarado(file: File): string {
  if (file.type) return file.type
  const nombre = file.name.toLowerCase()
  if (nombre.endsWith(".pdf")) return "application/pdf"
  if (nombre.endsWith(".png")) return "image/png"
  if (nombre.endsWith(".jpg") || nombre.endsWith(".jpeg")) return "image/jpeg"
  if (nombre.endsWith(".heic")) return "image/heic"
  if (nombre.endsWith(".heif")) return "image/heif"
  return ""
}

// Mismos formatos que la tabla del historial (ComprobantesInformados): el hint de "Ya
// informaste" resume esas filas, no redefine el modelo.
function fmtMonto(amount: string): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(amount))
}

/** "2026-09-10" → "10/09/2026" (tanto paidOn como la fecha del submittedAt ISO). */
function fmtFecha(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-")
  return y && m && d ? `${d}/${m}/${y}` : iso
}

const ULTIMOS_INFORMADOS = 5

export function InformarPagoModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [monto, setMonto] = useState("")
  const [paidOn, setPaidOn] = useState("")
  const [method, setMethod] = useState("")
  const [methodOther, setMethodOther] = useState("")
  const [notes, setNotes] = useState("")
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [errorGeneral, setErrorGeneral] = useState("")
  const [fallo, setFallo] = useState<Fallo | null>(null)
  const [etapa, setEtapa] = useState<Etapa>("form")
  const [progreso, setProgreso] = useState(0)
  // B: fecha (dd/mm/aaaa) del comprobante anterior con los mismos bytes, si el confirm la
  // devuelve. Solo informativo: el informe se recibe igual.
  const [avisoDuplicado, setAvisoDuplicado] = useState("")
  // Últimos comprobantes informados: hint anti-duplicados en el momento de informar. Sale
  // de la misma página que el historial; best-effort (si falla, no se muestra nada).
  const [yaInformados, setYaInformados] = useState<ComprobanteInformado[]>([])
  // El XHR y la respuesta del init viven en refs: se usan solo dentro de handlers (el poll de
  // progreso dispara renders y no hay que perder la referencia), y el abort al cerrar los corta.
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const initRef = useRef<InitResponse | null>(null)

  const ocupado = etapa === "creating" || etapa === "uploading" || etapa === "confirming"

  // Se monta solo cuando se abre (el padre lo renderiza condicionalmente): al abrir pide
  // la primera página y guarda los últimos N. Sin paginado ni reintentos: es un aviso.
  useEffect(() => {
    let cancelado = false
    fetch("/api/portal/comprobantes?start=0", { cache: "no-store" })
      .then(async (res) => {
        if (cancelado || !res.ok) return
        const body = await res.json().catch(() => null)
        if (cancelado || !body) return
        setYaInformados(((body.comprobantes as ComprobanteInformado[]) ?? []).slice(0, ULTIMOS_INFORMADOS))
      })
      .catch(() => {})
    return () => {
      cancelado = true
    }
  }, [])

  function validar(): boolean {
    const errores: Record<string, string> = {}
    if (!file) {
      errores.file = "Elegí el archivo del comprobante"
    } else {
      const tipo = tipoDeclarado(file)
      if (!TIPOS_SOPORTADOS.includes(tipo)) {
        errores.file = "El tipo de archivo no es válido: subí un PDF, JPG o PNG"
      } else if (file.size <= 0) {
        errores.file = "El archivo está vacío"
      } else if (file.size > MAX_FILE_BYTES) {
        errores.file = "El archivo supera el máximo de 20 MB"
      }
    }
    const normalizado = normalizarMonto(monto)
    if (!normalizado || !parseAmount(normalizado)) {
      errores.amount = "Ingresá un monto mayor a 0 (hasta 2 decimales)"
    }
    if (!isValidPaidOn(paidOn, new Date())) {
      errores.paidOn = "Ingresá una fecha de pago válida (no futura)"
    }
    if (!method) {
      errores.method = "Elegí el medio de pago"
    }
    if (method === "otro" && methodOther.trim().length === 0) {
      errores.methodOther = "Contanos qué medio fue (obligatorio)"
    } else if (methodOther.trim().length > MAX_METHOD_OTHER_CHARS) {
      errores.methodOther = `El detalle no puede superar los ${MAX_METHOD_OTHER_CHARS} caracteres`
    }
    if (notes.length > MAX_NOTES_CHARS) {
      errores.notes = `Las notas no pueden superar los ${MAX_NOTES_CHARS} caracteres`
    }
    setFieldErrors(errores)
    return Object.keys(errores).length === 0
  }

  async function iniciar() {
    setEtapa("creating")
    setErrorGeneral("")
    setFallo(null)
    setAvisoDuplicado("")
    try {
      const res = await fetch("/api/portal/comprobantes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amount: normalizarMonto(monto),
          paidOn,
          method,
          methodOther: method === "otro" ? methodOther.trim() : undefined,
          notes: notes.trim() || undefined,
          file: { name: file?.name, size: file?.size, contentType: tipoDeclarado(file as File) },
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        // 400 invalid trae errores por campo; el resto (413/415/429/503/500) un mensaje general.
        if (body?.fields) setFieldErrors(body.fields as Record<string, string>)
        setErrorGeneral(body?.error ?? "No pudimos preparar la subida, intentá de nuevo")
        setEtapa("form")
        return
      }
      const init = body as InitResponse
      initRef.current = init
      subir(init)
    } catch {
      setErrorGeneral("Error de conexión. Intentá de nuevo.")
      setEtapa("form")
    }
  }

  function subir(init: InitResponse) {
    const archivo = file
    if (!archivo) return
    setEtapa("uploading")
    setProgreso(0)
    setFallo(null)
    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr
    xhr.open("PUT", init.upload.url)
    // El content-type tiene que ser EXACTAMENTE el que firmó el server: si difiere, R2 rechaza
    // el PUT con 403 SignatureDoesNotMatch.
    xhr.setRequestHeader("content-type", init.upload.headers["content-type"])
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgreso(Math.min(100, Math.round((e.loaded / e.total) * 100)))
    }
    xhr.onload = () => {
      xhrRef.current = null
      if (xhr.status >= 200 && xhr.status < 300) {
        confirmar(init.id)
        return
      }
      // Error del PUT (red, CORS o 403): recuperable. NO se llama al confirm: la fila sigue
      // `uploading` y la URL sigue viva, así que se puede reintentar la subida.
      setFallo({ mensaje: "No se pudo subir el archivo, probá de nuevo.", etapa: "put", reintentable: true })
      setEtapa("form")
    }
    xhr.onerror = () => {
      xhrRef.current = null
      setFallo({ mensaje: "No se pudo subir el archivo, probá de nuevo.", etapa: "put", reintentable: true })
      setEtapa("form")
    }
    xhr.onabort = () => {
      xhrRef.current = null
    }
    xhr.send(archivo)
  }

  async function confirmar(id: string) {
    setEtapa("confirming")
    setFallo(null)
    try {
      const res = await fetch(`/api/portal/comprobantes/${id}/confirm`, { method: "POST" })
      if (res.ok) {
        const body = await res.json().catch(() => null)
        const dup = body?.duplicateOf?.submittedAt as string | undefined
        if (dup) {
          setAvisoDuplicado(
            new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date(dup)),
          )
        }
        setEtapa("done")
        // Refresca el dashboard (saldos/pagos y el historial de informados).
        router.refresh()
        return
      }
      if (res.status === 202) {
        setEtapa("queued")
        return
      }
      const body = await res.json().catch(() => null)
      const mensaje = body?.error ?? "No pudimos procesar el comprobante, intentá de nuevo"
      // 409 upload_missing: la subida no llegó, se reintenta el PUT. 502/503: reintentar el
      // confirm. 413/415/422/404: el archivo o la fila quedaron rechazados, no tiene sentido
      // reintentar la misma subida.
      if (res.status === 409 && body?.code === "upload_missing") {
        setFallo({ mensaje: "La subida no llegó, reintentá.", etapa: "put", reintentable: true })
      } else if (res.status === 502 || res.status === 503) {
        setFallo({ mensaje, etapa: "confirm", reintentable: true })
      } else {
        setFallo({ mensaje, etapa: "confirm", reintentable: false })
        initRef.current = null
      }
      setEtapa("form")
    } catch {
      setFallo({ mensaje: "No pudimos procesar el comprobante, intentá de nuevo.", etapa: "confirm", reintentable: true })
      setEtapa("form")
    }
  }

  function reintentar() {
    if (!fallo?.reintentable) return
    setErrorGeneral("")
    const init = initRef.current
    if (fallo.etapa === "confirm" && init) {
      void confirmar(init.id)
      return
    }
    // fallo.etapa === "put": si la URL sigue viva se reintenta el PUT a la misma key (sin
    // crear fila nueva); si venció, se arranca de cero con un init nuevo.
    if (init && new Date(init.upload.expiresAt).getTime() > Date.now()) {
      subir(init)
    } else {
      initRef.current = null
      void iniciar()
    }
  }

  function cerrar() {
    // Aborta la subida en curso (si hay una). El confirm, si ya arrancó, sigue server-side:
    // la fila queda pendiente igual.
    xhrRef.current?.abort()
    onClose()
  }

  function handleEnviar() {
    setErrorGeneral("")
    if (!validar()) return
    initRef.current = null
    void iniciar()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) cerrar() }}
      title="Informar pago"
      className="max-w-xl"
      footer={
        etapa === "done" || etapa === "queued" ? (
          <div className="flex gap-2 justify-end">
            <Button onClick={cerrar}>Listo</Button>
          </div>
        ) : (
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={cerrar} disabled={ocupado}>Cancelar</Button>
            {fallo?.reintentable && etapa === "form" ? (
              <Button onClick={reintentar}>
                {fallo.etapa === "put" ? "Reintentar subida" : "Reintentar"}
              </Button>
            ) : (
              <Button onClick={handleEnviar} loading={ocupado} disabled={ocupado}>
                {etapa === "uploading" ? "Subiendo…" : etapa === "confirming" ? "Procesando…" : "Enviar comprobante"}
              </Button>
            )}
          </div>
        )
      }
    >
      {etapa === "done" && (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <CheckCircle2 size={40} strokeWidth={1.4} style={{ color: "var(--green)" }} />
          <p className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Recibimos tu comprobante</p>
          <p className="text-sm max-w-sm" style={{ color: "var(--ink-soft)" }}>
            Lo vamos a revisar y cargar en nuestro sistema.
          </p>
          {avisoDuplicado && (
            <p className="text-sm max-w-sm rounded-lg px-3 py-2" style={{ color: "var(--amber)", background: "var(--amber-soft, #fef3c7)" }}>
              Ojo: ya nos habías mandado este mismo archivo el {avisoDuplicado}. Lo recibimos igual,
              pero puede que sea un informe repetido.
            </p>
          )}
        </div>
      )}

      {etapa === "queued" && (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Info size={40} strokeWidth={1.4} style={{ color: "var(--blue)" }} />
          <p className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Estamos procesando tu comprobante</p>
          <p className="text-sm max-w-sm" style={{ color: "var(--ink-soft)" }}>
            La subida llegó bien y está siendo procesada. Si en unos minutos no aparece, volvé a intentarlo.
          </p>
        </div>
      )}

      {(etapa === "form" || etapa === "creating" || etapa === "uploading" || etapa === "confirming") && (
        <div className="flex flex-col gap-4">
          <Field label="Archivo del comprobante" error={fieldErrors.file}>
            <FileDropZone
              file={file}
              onChange={(f) => { setFile(f); setFieldErrors((prev) => ({ ...prev, file: "" })) }}
              accept={ACCEPT}
              hint="PDF, JPG o PNG · hasta 20 MB"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Monto (ARS)" error={fieldErrors.amount}>
              <Input
                inputMode="decimal"
                placeholder="Ej: 150000,50"
                value={monto}
                disabled={ocupado}
                aria-invalid={Boolean(fieldErrors.amount)}
                onChange={(e) => { setMonto(e.target.value); setFieldErrors((prev) => ({ ...prev, amount: "" })) }}
              />
            </Field>
            <Field label="Fecha del pago" error={fieldErrors.paidOn}>
              <Input
                type="date"
                value={paidOn}
                max={hoyAR()}
                disabled={ocupado}
                aria-invalid={Boolean(fieldErrors.paidOn)}
                onChange={(e) => { setPaidOn(e.target.value); setFieldErrors((prev) => ({ ...prev, paidOn: "" })) }}
              />
            </Field>
          </div>

          <Field label="Medio de pago" error={fieldErrors.method}>
            <Select
              options={METODOS}
              value={method}
              placeholder="Elegí el medio"
              disabled={ocupado}
              aria-invalid={Boolean(fieldErrors.method)}
              onValueChange={(v) => { setMethod(v); setFieldErrors((prev) => ({ ...prev, method: "" })) }}
            />
          </Field>

          {method === "otro" && (
            <Field label="¿Qué medio fue?" error={fieldErrors.methodOther}>
              <Input
                placeholder="Ej: Mercado Pago, link de pago…"
                value={methodOther}
                disabled={ocupado}
                aria-invalid={Boolean(fieldErrors.methodOther)}
                onChange={(e) => { setMethodOther(e.target.value); setFieldErrors((prev) => ({ ...prev, methodOther: "" })) }}
              />
            </Field>
          )}

          <Field label="Notas (opcional)" error={fieldErrors.notes} hint={`Hasta ${MAX_NOTES_CHARS} caracteres. Ej: número de operación.`}>
            <Textarea
              value={notes}
              maxLength={MAX_NOTES_CHARS}
              disabled={ocupado}
              aria-invalid={Boolean(fieldErrors.notes)}
              onChange={(e) => { setNotes(e.target.value); setFieldErrors((prev) => ({ ...prev, notes: "" })) }}
            />
          </Field>

          {etapa === "form" && yaInformados.length > 0 && (
            <div
              className="flex flex-col gap-1.5 rounded-[var(--radius)] p-3"
              style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
            >
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-faint)" }}>
                Ya informaste
              </p>
              {yaInformados.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-xs">
                  <span style={{ color: "var(--ink-soft)" }}>
                    {fmtFecha(c.paidOn)} · {fmtMonto(c.amount)}
                  </span>
                  <Badge tone={c.status === "loaded" ? "success" : "warning"}>
                    {c.status === "loaded" ? "Cargado" : "Pendiente"}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          {(etapa === "uploading" || etapa === "confirming") && (
            <div className="flex flex-col gap-1.5">
              <Progress value={etapa === "confirming" ? 100 : progreso} />
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                {etapa === "confirming" ? "Procesando el comprobante…" : `Subiendo… ${progreso}%`}
              </p>
            </div>
          )}

          {(errorGeneral || fallo) && etapa === "form" && (
            <p className="rounded-[var(--radius)] p-3 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
              {fallo?.mensaje ?? errorGeneral}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
