"use client"

import { useState } from "react"
import { Alert, Badge, Button, Card, Checkbox, Dialog, Field, Input, Select, Table, useToast } from "@myd-org/ui"
import type { MedioDto, OpcionDto } from "@/lib/cuotas-repo"

// Configuración → Medios de pago / Cuotas (admin y superadmin). El tenant elige QUÉ ofrece en el
// Shop: medios (proveedor + código) y, por medio, opciones de cuotas con monto mínimo (con IVA)
// y vigencia opcional. Aplican igual a todos los productos: no hay campos de producto ni de
// categoría. Las tasas reales las trae el Shop del proveedor.
//
// Cada guardado persiste y avisa al Shop; si el aviso no llegó (`propagado: false`) el cambio
// igual quedó guardado y se informa que el Shop lo toma en su próximo ciclo.

interface Props {
  initialMedios: MedioDto[]
  initialOpciones: OpcionDto[]
}

type ApiError = { error?: string; code?: string; campo?: string }
type Errores = Record<string, string>

const CUOTAS_OPCIONES = Array.from({ length: 23 }, (_, i) => String(i + 2)).map((v) => ({ value: v, label: `${v} cuotas` }))

const AVISO_SIN_INTERES =
  "El sin interés también tiene que estar activo en tu cuenta del proveedor (ej. Mercado Pago). Si no lo está, el Shop muestra la tasa real en lugar de \"sin interés\"."

const ars = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 })

function fechaCorta(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${d}/${m}/${y}`
}

function textoVigencia(o: OpcionDto): string {
  if (!o.vigenteDesde && !o.vigenteHasta) return "Siempre"
  if (o.vigenteDesde && o.vigenteHasta) return `${fechaCorta(o.vigenteDesde)} al ${fechaCorta(o.vigenteHasta)}`
  if (o.vigenteDesde) return `Desde ${fechaCorta(o.vigenteDesde)}`
  return `Hasta ${fechaCorta(o.vigenteHasta as string)}`
}

async function enviar(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as (ApiError & Record<string, unknown>) | null
  return { res, json }
}

function EstadoBadge({ activo }: { activo: boolean }) {
  return <Badge tone={activo ? "success" : "neutral"}>{activo ? "Activo" : "Inactivo"}</Badge>
}

function CheckboxLabel(props: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label htmlFor={props.id} className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: "var(--ink)" }}>
      <Checkbox id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
      {props.label}
    </label>
  )
}

// ─── Formularios ─────────────────────────────────────────────────────────────────────────

type MedioForm = { id?: string; proveedor: string; codigoProveedor: string; nombre: string; orden: string; activo: boolean }
type OpcionForm = {
  id?: string
  paymentMethodId: string
  cuotas: string
  sinInteres: boolean
  montoMinimo: string
  vigenteDesde: string
  vigenteHasta: string
  activo: boolean
}

const medioVacio = (orden: number): MedioForm => ({ proveedor: "mercadopago", codigoProveedor: "", nombre: "", orden: String(orden), activo: true })

const opcionVacia = (paymentMethodId: string): OpcionForm => ({
  paymentMethodId,
  cuotas: "3",
  sinInteres: false,
  montoMinimo: "",
  vigenteDesde: "",
  vigenteHasta: "",
  activo: true,
})

export function CuotasTab({ initialMedios, initialOpciones }: Props) {
  const [medios, setMedios] = useState(initialMedios)
  const [opciones, setOpciones] = useState(initialOpciones)
  const [medioForm, setMedioForm] = useState<MedioForm | null>(null)
  const [opcionForm, setOpcionForm] = useState<OpcionForm | null>(null)
  const [borrar, setBorrar] = useState<OpcionDto | null>(null)
  const [errores, setErrores] = useState<Errores>({})
  const [guardando, setGuardando] = useState(false)
  const { toast } = useToast()

  function avisarGuardado(titulo: string, propagado: unknown) {
    if (propagado === true) {
      toast({ title: titulo, tone: "success" })
    } else {
      toast({ title: titulo, description: "El Shop se actualizará en el próximo ciclo.", tone: "warning" })
    }
  }

  /** Traduce la respuesta de error: 422 con `campo` → error inline; el resto → error general. */
  function manejarError(res: Response, json: ApiError | null) {
    if (res.status === 404) {
      setErrores({ general: "No encontramos ese registro. Recargá la página." })
    } else if (res.status === 422 && json?.error) {
      const campo = json.campo && json.campo !== "body" ? json.campo : "general"
      setErrores({ [campo]: json.error })
    } else {
      setErrores({ general: json?.error ?? "No pudimos guardar. Intentá de nuevo." })
    }
  }

  async function guardarMedio() {
    if (!medioForm) return
    setGuardando(true)
    setErrores({})
    try {
      const body = {
        proveedor: medioForm.proveedor,
        codigoProveedor: medioForm.codigoProveedor,
        nombre: medioForm.nombre,
        orden: medioForm.orden.trim() === "" ? 0 : Number(medioForm.orden),
        activo: medioForm.activo,
      }
      const { res, json } = medioForm.id
        ? await enviar(`/api/admin/cuotas/medios/${medioForm.id}`, "PATCH", body)
        : await enviar("/api/admin/cuotas/medios", "POST", body)
      if (!res.ok || !json) return manejarError(res, json)
      const medio = json.medio as MedioDto
      setMedios((prev) => {
        const resto = prev.filter((m) => m.id !== medio.id)
        return [...resto, medio].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre))
      })
      setMedioForm(null)
      avisarGuardado(medioForm.id ? "Medio actualizado" : "Medio agregado", json.propagado)
    } catch {
      setErrores({ general: "Error de conexión. Intentá de nuevo." })
    } finally {
      setGuardando(false)
    }
  }

  async function guardarOpcion() {
    if (!opcionForm) return
    setGuardando(true)
    setErrores({})
    try {
      const body = {
        paymentMethodId: opcionForm.paymentMethodId,
        cuotas: Number(opcionForm.cuotas),
        sinInteres: opcionForm.sinInteres,
        montoMinimo: opcionForm.montoMinimo.trim(),
        vigenteDesde: opcionForm.vigenteDesde || null,
        vigenteHasta: opcionForm.vigenteHasta || null,
        activo: opcionForm.activo,
      }
      const { res, json } = opcionForm.id
        ? await enviar(`/api/admin/cuotas/opciones/${opcionForm.id}`, "PATCH", body)
        : await enviar("/api/admin/cuotas/opciones", "POST", body)
      if (!res.ok || !json) return manejarError(res, json)
      const opcion = json.opcion as OpcionDto
      setOpciones((prev) => [...prev.filter((o) => o.id !== opcion.id), opcion])
      setOpcionForm(null)
      avisarGuardado(opcionForm.id ? "Opción actualizada" : "Opción agregada", json.propagado)
    } catch {
      setErrores({ general: "Error de conexión. Intentá de nuevo." })
    } finally {
      setGuardando(false)
    }
  }

  /** Activar/desactivar directo desde la tabla (sin abrir el formulario). */
  async function alternarActivo(tipo: "medios" | "opciones", id: string, activo: boolean) {
    try {
      const { res, json } = await enviar(`/api/admin/cuotas/${tipo}/${id}`, "PATCH", { activo })
      if (!res.ok || !json) {
        toast({ title: json?.error ?? "No pudimos actualizar", tone: "danger" })
        return
      }
      if (tipo === "medios") {
        const medio = json.medio as MedioDto
        setMedios((prev) => prev.map((m) => (m.id === medio.id ? medio : m)))
      } else {
        const opcion = json.opcion as OpcionDto
        setOpciones((prev) => prev.map((o) => (o.id === opcion.id ? opcion : o)))
      }
      avisarGuardado(activo ? "Activado" : "Desactivado", json.propagado)
    } catch {
      toast({ title: "Error de conexión. Intentá de nuevo.", tone: "danger" })
    }
  }

  async function confirmarBorrar() {
    if (!borrar) return
    setGuardando(true)
    try {
      const { res, json } = await enviar(`/api/admin/cuotas/opciones/${borrar.id}`, "DELETE")
      if (!res.ok && res.status !== 404) {
        toast({ title: json?.error ?? "No pudimos borrar la opción", tone: "danger" })
        return
      }
      setOpciones((prev) => prev.filter((o) => o.id !== borrar.id))
      setBorrar(null)
      if (res.ok) avisarGuardado("Opción borrada", json?.propagado)
    } catch {
      toast({ title: "Error de conexión. Intentá de nuevo.", tone: "danger" })
    } finally {
      setGuardando(false)
    }
  }

  const abrirMedio = (form: MedioForm) => {
    setErrores({})
    setMedioForm(form)
  }
  const abrirOpcion = (form: OpcionForm) => {
    setErrores({})
    setOpcionForm(form)
  }

  const setM = (patch: Partial<MedioForm>) => setMedioForm((f) => (f ? { ...f, ...patch } : f))
  const setO = (patch: Partial<OpcionForm>) => setOpcionForm((f) => (f ? { ...f, ...patch } : f))

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Medios de pago"
        description="Los medios que el Shop ofrece para pagar en cuotas. El código tiene que coincidir con el del proveedor (en Mercado Pago: visa, master, amex…)."
      >
        <div className="flex flex-col gap-3">
          <Table<MedioDto>
            rows={medios}
            rowKey={(m) => m.id}
            empty={<p className="text-sm py-4" style={{ color: "var(--ink-soft)" }}>Todavía no hay medios de pago.</p>}
            columns={[
              { key: "nombre", header: "Nombre", render: (m) => m.nombre },
              { key: "codigo", header: "Proveedor / código", render: (m) => `${m.proveedor} / ${m.codigoProveedor}`, hideBelow: "sm" },
              { key: "orden", header: "Orden", render: (m) => m.orden, align: "right", hideBelow: "sm" },
              { key: "estado", header: "Estado", render: (m) => <EstadoBadge activo={m.activo} /> },
              {
                key: "acciones",
                header: "",
                align: "right",
                render: (m) => (
                  <div className="flex gap-1 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => abrirMedio({ ...m, orden: String(m.orden) })}>
                      Editar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => alternarActivo("medios", m.id, !m.activo)}>
                      {m.activo ? "Desactivar" : "Activar"}
                    </Button>
                  </div>
                ),
              },
            ]}
          />
          <div>
            <Button variant="secondary" onClick={() => abrirMedio(medioVacio(medios.length))}>
              Agregar medio
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="Opciones de cuotas"
        description="Aplican igual a todos los productos. El monto mínimo se compara con IVA contra el precio final (ficha), el total del carrito o el del pedido."
      >
        <div className="flex flex-col gap-4">
          <Alert tone="warning" title="Sobre el sin interés">
            {AVISO_SIN_INTERES}
          </Alert>

          {medios.length === 0 && (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Agregá un medio de pago para cargarle opciones de cuotas.</p>
          )}

          {medios.map((medio) => {
            const filas = opciones
              .filter((o) => o.paymentMethodId === medio.id)
              .sort((a, b) => a.cuotas - b.cuotas || (a.vigenteDesde ?? "").localeCompare(b.vigenteDesde ?? ""))
            return (
              <section key={medio.id} className="flex flex-col gap-2" aria-label={`Opciones de ${medio.nombre}`}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {medio.nombre} {!medio.activo && <Badge tone="neutral">Medio inactivo</Badge>}
                  </h3>
                  <Button size="sm" variant="secondary" onClick={() => abrirOpcion(opcionVacia(medio.id))}>
                    Agregar opción
                  </Button>
                </div>
                <Table<OpcionDto>
                  rows={filas}
                  rowKey={(o) => o.id}
                  empty={<p className="text-sm py-3" style={{ color: "var(--ink-soft)" }}>Sin opciones: sólo 1 pago.</p>}
                  columns={[
                    {
                      key: "cuotas",
                      header: "Cuotas",
                      render: (o) => (
                        <span className="flex items-center gap-2">
                          {o.cuotas} {o.sinInteres && <Badge tone="info">Sin interés</Badge>}
                        </span>
                      ),
                    },
                    { key: "minimo", header: "Monto mínimo", render: (o) => (Number(o.montoMinimo) > 0 ? ars.format(Number(o.montoMinimo)) : "Sin mínimo") },
                    { key: "vigencia", header: "Vigencia", render: textoVigencia, hideBelow: "sm" },
                    { key: "estado", header: "Estado", render: (o) => <EstadoBadge activo={o.activo} /> },
                    {
                      key: "acciones",
                      header: "",
                      align: "right",
                      render: (o) => (
                        <div className="flex gap-1 justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              abrirOpcion({
                                id: o.id,
                                paymentMethodId: o.paymentMethodId,
                                cuotas: String(o.cuotas),
                                sinInteres: o.sinInteres,
                                montoMinimo: Number(o.montoMinimo) > 0 ? o.montoMinimo : "",
                                vigenteDesde: o.vigenteDesde ?? "",
                                vigenteHasta: o.vigenteHasta ?? "",
                                activo: o.activo,
                              })
                            }
                          >
                            Editar
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => alternarActivo("opciones", o.id, !o.activo)}>
                            {o.activo ? "Desactivar" : "Activar"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setBorrar(o)}>
                            Borrar
                          </Button>
                        </div>
                      ),
                    },
                  ]}
                />
              </section>
            )
          })}
        </div>
      </Card>

      <Dialog
        open={medioForm !== null}
        onOpenChange={(open) => { if (!open) setMedioForm(null) }}
        title={medioForm?.id ? "Editar medio de pago" : "Agregar medio de pago"}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setMedioForm(null)}>Cancelar</Button>
            <Button loading={guardando} disabled={guardando} onClick={guardarMedio}>Guardar</Button>
          </div>
        }
      >
        {medioForm && (
          <div className="flex flex-col gap-3">
            <Field label="Proveedor" hint="Por ahora sólo mercadopago." error={errores.proveedor}>
              <Input value={medioForm.proveedor} onChange={(e) => setM({ proveedor: e.target.value })} aria-invalid={Boolean(errores.proveedor)} />
            </Field>
            <Field label="Código en el proveedor" hint="Ej. visa, master." error={errores.codigoProveedor}>
              <Input value={medioForm.codigoProveedor} onChange={(e) => setM({ codigoProveedor: e.target.value })} aria-invalid={Boolean(errores.codigoProveedor)} />
            </Field>
            <Field label="Nombre" hint="Lo que ve el cliente, ej. Visa." error={errores.nombre}>
              <Input value={medioForm.nombre} onChange={(e) => setM({ nombre: e.target.value })} aria-invalid={Boolean(errores.nombre)} />
            </Field>
            <Field label="Orden" hint="Menor primero." error={errores.orden}>
              <Input type="number" min={0} step={1} value={medioForm.orden} onChange={(e) => setM({ orden: e.target.value })} aria-invalid={Boolean(errores.orden)} />
            </Field>
            <CheckboxLabel id="medio-activo" checked={medioForm.activo} onChange={(activo) => setM({ activo })} label="Activo" />
            {errores.general && <p className="text-sm" style={{ color: "var(--red)" }}>{errores.general}</p>}
          </div>
        )}
      </Dialog>

      <Dialog
        open={opcionForm !== null}
        onOpenChange={(open) => { if (!open) setOpcionForm(null) }}
        title={opcionForm?.id ? "Editar opción de cuotas" : "Agregar opción de cuotas"}
        description={opcionForm ? medios.find((m) => m.id === opcionForm.paymentMethodId)?.nombre : undefined}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setOpcionForm(null)}>Cancelar</Button>
            <Button loading={guardando} disabled={guardando} onClick={guardarOpcion}>Guardar</Button>
          </div>
        }
      >
        {opcionForm && (
          <div className="flex flex-col gap-3">
            <Field label="Cuotas" error={errores.cuotas}>
              <Select
                options={CUOTAS_OPCIONES}
                value={opcionForm.cuotas}
                onValueChange={(cuotas) => setO({ cuotas })}
                aria-label="Cuotas"
                aria-invalid={Boolean(errores.cuotas)}
              />
            </Field>
            <CheckboxLabel id="opcion-sin-interes" checked={opcionForm.sinInteres} onChange={(sinInteres) => setO({ sinInteres })} label="Sin interés" />
            {opcionForm.sinInteres && <Alert tone="warning">{AVISO_SIN_INTERES}</Alert>}
            <Field label="Monto mínimo (con IVA)" hint="Vacío = sin mínimo." error={errores.montoMinimo}>
              <Input
                inputMode="decimal"
                placeholder="150000"
                value={opcionForm.montoMinimo}
                onChange={(e) => setO({ montoMinimo: e.target.value })}
                aria-invalid={Boolean(errores.montoMinimo)}
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Vigente desde" hint="Opcional, inclusive." error={errores.vigenteDesde}>
                <Input type="date" value={opcionForm.vigenteDesde} onChange={(e) => setO({ vigenteDesde: e.target.value })} aria-invalid={Boolean(errores.vigenteDesde)} />
              </Field>
              <Field label="Vigente hasta" hint="Opcional, inclusive." error={errores.vigenteHasta}>
                <Input type="date" value={opcionForm.vigenteHasta} onChange={(e) => setO({ vigenteHasta: e.target.value })} aria-invalid={Boolean(errores.vigenteHasta)} />
              </Field>
            </div>
            <CheckboxLabel id="opcion-activa" checked={opcionForm.activo} onChange={(activo) => setO({ activo })} label="Activa" />
            {errores.general && <p className="text-sm" style={{ color: "var(--red)" }}>{errores.general}</p>}
          </div>
        )}
      </Dialog>

      <Dialog
        open={borrar !== null}
        onOpenChange={(open) => { if (!open) setBorrar(null) }}
        title="Borrar opción de cuotas"
        description="Se borra definitivamente. Si sólo querés dejar de ofrecerla por un tiempo, desactivala."
        headerBorder={false}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setBorrar(null)}>Cancelar</Button>
            <Button variant="danger" loading={guardando} onClick={confirmarBorrar}>Borrar</Button>
          </div>
        }
      >
        {borrar && (
          <p className="text-sm" style={{ color: "var(--ink)" }}>
            ¿Borrar {borrar.cuotas} cuotas{borrar.sinInteres ? " sin interés" : ""}?
          </p>
        )}
      </Dialog>
    </div>
  )
}
