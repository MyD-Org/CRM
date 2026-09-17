"use client"

import { useState } from "react"
import { Alert, Badge, Button, Card, Checkbox, Dialog, Field, Input, Select, Table, useToast } from "@myd-org/ui"
import type { EscalonDto, ProveedorDto } from "@/lib/cuotas-repo"
import { CUOTAS_MAX, CUOTAS_MIN, PROVEEDORES } from "@/lib/cuotas"
import { textoTasa, type TasaCuotas, type TasasMP } from "@/lib/mp-tasas"

// Configuración → Medios de pago / Cuotas (admin y superadmin). Por proveedor de pago (hoy sólo
// Mercado Pago, para todas las tarjetas de crédito) el tenant define escalones: desde un monto
// mínimo (con IVA) se ofrecen hasta N cuotas. Para un monto, el Shop usa el mayor máximo de los
// escalones alcanzados; si no alcanza ninguno, 1 pago. Aplican igual a todos los productos.
//
// El sin interés y las tasas NO se configuran acá: son los que devuelve Mercado Pago (tasa 0 =
// sin interés, se activa en su panel). Al lado se muestran las tasas reales para decidir.
//
// Cada guardado persiste y avisa al Shop; si el aviso no llegó (`propagado: false`) el cambio
// igual quedó guardado y se informa que el Shop lo toma en su próximo ciclo.

interface Props {
  initialProveedores: ProveedorDto[]
  initialEscalones: EscalonDto[]
  tasasMP: TasasMP
}

type ApiError = { error?: string; code?: string; campo?: string }
type Errores = Record<string, string>

const textoCuotas = (n: number) => (n === 1 ? "1 pago" : `${n} cuotas`)

const CUOTAS_OPCIONES = Array.from({ length: CUOTAS_MAX - CUOTAS_MIN + 1 }, (_, i) => i + CUOTAS_MIN).map((n) => ({
  value: String(n),
  label: n === 1 ? "1 pago" : `Hasta ${n} cuotas`,
}))

const ars = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 })
const hora = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" })

async function enviar(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as (ApiError & Record<string, unknown>) | null
  return { res, json }
}

const ordenarEscalones = (a: EscalonDto, b: EscalonDto) => Number(a.montoMinimo) - Number(b.montoMinimo) || a.cuotasMax - b.cuotasMax

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

// ─── Tasas reales de Mercado Pago ────────────────────────────────────────────────────────

function TasasMercadoPago({ tasasMP }: { tasasMP: TasasMP }) {
  return (
    <Card
      title="Tasas de Mercado Pago"
      description="Lo que hoy cobra Mercado Pago por cantidad de cuotas. El sin interés se activa en tu cuenta de Mercado Pago, no acá."
    >
      {tasasMP.estado === "sin_clave" && (
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
          Para ver las tasas, configurá la variable <code>MP_PUBLIC_KEY</code> con la public key de Mercado Pago.
        </p>
      )}
      {tasasMP.estado === "error" && (
        <Alert tone="warning" title="No pudimos consultar las tasas">
          Mercado Pago no respondió. La configuración de cuotas funciona igual; probá recargar más tarde.
        </Alert>
      )}
      {tasasMP.estado === "ok" && (
        <div className="flex flex-col gap-2">
          <Table<TasaCuotas>
            rows={tasasMP.tasas}
            rowKey={(t) => String(t.cuotas)}
            columns={[
              { key: "cuotas", header: "Cuotas", render: (t) => textoCuotas(t.cuotas) },
              {
                key: "tasa",
                header: "Tasa",
                render: (t) => (t.tasaPct === 0 ? <Badge tone="success">Sin interés</Badge> : textoTasa(t)),
              },
            ]}
          />
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            Tasa más alta entre bancos, Visa y Mastercard. Consultado {hora.format(new Date(tasasMP.consultadoEn))}.
          </p>
        </div>
      )}
    </Card>
  )
}

// ─── Formularios ─────────────────────────────────────────────────────────────────────────

type ProveedorForm = { id?: string; proveedor: string; orden: string; activo: boolean }
type EscalonForm = { id?: string; proveedorId: string; cuotasMax: string; montoMinimo: string; activo: boolean }

const escalonVacio = (proveedorId: string): EscalonForm => ({ proveedorId, cuotasMax: "3", montoMinimo: "", activo: true })

export function CuotasTab({ initialProveedores, initialEscalones, tasasMP }: Props) {
  const [proveedores, setProveedores] = useState(initialProveedores)
  const [escalones, setEscalones] = useState(initialEscalones)
  const [proveedorForm, setProveedorForm] = useState<ProveedorForm | null>(null)
  const [escalonForm, setEscalonForm] = useState<EscalonForm | null>(null)
  const [borrar, setBorrar] = useState<EscalonDto | null>(null)
  const [errores, setErrores] = useState<Errores>({})
  const [guardando, setGuardando] = useState(false)
  const { toast } = useToast()

  const disponibles = PROVEEDORES.filter((p) => !proveedores.some((c) => c.proveedor === p.id))

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

  async function guardarProveedor() {
    if (!proveedorForm) return
    setGuardando(true)
    setErrores({})
    try {
      const body = {
        proveedor: proveedorForm.proveedor,
        orden: proveedorForm.orden.trim() === "" ? 0 : Number(proveedorForm.orden),
        activo: proveedorForm.activo,
      }
      const { res, json } = proveedorForm.id
        ? await enviar(`/api/admin/cuotas/proveedores/${proveedorForm.id}`, "PATCH", body)
        : await enviar("/api/admin/cuotas/proveedores", "POST", body)
      if (!res.ok || !json) return manejarError(res, json)
      const proveedor = json.proveedor as ProveedorDto
      setProveedores((prev) =>
        [...prev.filter((p) => p.id !== proveedor.id), proveedor].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre)),
      )
      setProveedorForm(null)
      avisarGuardado(proveedorForm.id ? "Proveedor actualizado" : "Proveedor agregado", json.propagado)
    } catch {
      setErrores({ general: "Error de conexión. Intentá de nuevo." })
    } finally {
      setGuardando(false)
    }
  }

  async function guardarEscalon() {
    if (!escalonForm) return
    setGuardando(true)
    setErrores({})
    try {
      const body = {
        proveedorId: escalonForm.proveedorId,
        cuotasMax: Number(escalonForm.cuotasMax),
        montoMinimo: escalonForm.montoMinimo.trim(),
        activo: escalonForm.activo,
      }
      const { res, json } = escalonForm.id
        ? await enviar(`/api/admin/cuotas/escalones/${escalonForm.id}`, "PATCH", body)
        : await enviar("/api/admin/cuotas/escalones", "POST", body)
      if (!res.ok || !json) return manejarError(res, json)
      const escalon = json.escalon as EscalonDto
      setEscalones((prev) => [...prev.filter((e) => e.id !== escalon.id), escalon])
      setEscalonForm(null)
      avisarGuardado(escalonForm.id ? "Escalón actualizado" : "Escalón agregado", json.propagado)
    } catch {
      setErrores({ general: "Error de conexión. Intentá de nuevo." })
    } finally {
      setGuardando(false)
    }
  }

  /** Activar/desactivar directo desde la tabla (sin abrir el formulario). */
  async function alternarActivo(tipo: "proveedores" | "escalones", id: string, activo: boolean) {
    try {
      const { res, json } = await enviar(`/api/admin/cuotas/${tipo}/${id}`, "PATCH", { activo })
      if (!res.ok || !json) {
        toast({ title: json?.error ?? "No pudimos actualizar", tone: "danger" })
        return
      }
      if (tipo === "proveedores") {
        const proveedor = json.proveedor as ProveedorDto
        setProveedores((prev) => prev.map((p) => (p.id === proveedor.id ? proveedor : p)))
      } else {
        const escalon = json.escalon as EscalonDto
        setEscalones((prev) => prev.map((e) => (e.id === escalon.id ? escalon : e)))
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
      const { res, json } = await enviar(`/api/admin/cuotas/escalones/${borrar.id}`, "DELETE")
      if (!res.ok && res.status !== 404) {
        toast({ title: json?.error ?? "No pudimos borrar el escalón", tone: "danger" })
        return
      }
      setEscalones((prev) => prev.filter((e) => e.id !== borrar.id))
      setBorrar(null)
      if (res.ok) avisarGuardado("Escalón borrado", json?.propagado)
    } catch {
      toast({ title: "Error de conexión. Intentá de nuevo.", tone: "danger" })
    } finally {
      setGuardando(false)
    }
  }

  const abrirProveedor = (form: ProveedorForm) => {
    setErrores({})
    setProveedorForm(form)
  }
  const abrirEscalon = (form: EscalonForm) => {
    setErrores({})
    setEscalonForm(form)
  }

  const setP = (patch: Partial<ProveedorForm>) => setProveedorForm((f) => (f ? { ...f, ...patch } : f))
  const setE = (patch: Partial<EscalonForm>) => setEscalonForm((f) => (f ? { ...f, ...patch } : f))

  const opcionesProveedor = proveedorForm?.id
    ? PROVEEDORES.filter((p) => p.id === proveedorForm.proveedor)
    : disponibles
  const montoBorrar = borrar ? Number(borrar.montoMinimo) : 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
      <div className="flex flex-col gap-4 lg:col-span-2 min-w-0">
        <Card
          title="Proveedores de pago"
          description="Las cuotas se configuran por proveedor y aplican a todas las tarjetas de crédito."
        >
          <div className="flex flex-col gap-3">
            <Table<ProveedorDto>
              rows={proveedores}
              rowKey={(p) => p.id}
              empty={<p className="text-sm py-4" style={{ color: "var(--ink-soft)" }}>Todavía no hay proveedores: el Shop cobra en 1 pago.</p>}
              columns={[
                { key: "nombre", header: "Proveedor", render: (p) => p.nombre },
                { key: "orden", header: "Orden", render: (p) => p.orden, align: "right", hideBelow: "sm" },
                { key: "estado", header: "Estado", render: (p) => <EstadoBadge activo={p.activo} /> },
                {
                  key: "acciones",
                  header: "",
                  align: "right",
                  render: (p) => (
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => abrirProveedor({ id: p.id, proveedor: p.proveedor, orden: String(p.orden), activo: p.activo })}>
                        Editar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => alternarActivo("proveedores", p.id, !p.activo)}>
                        {p.activo ? "Desactivar" : "Activar"}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
            {disponibles.length > 0 && (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => abrirProveedor({ proveedor: disponibles[0]?.id ?? "", orden: String(proveedores.length), activo: true })}
                >
                  Agregar proveedor
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card
          title="Cuotas por monto"
          description="Desde cada monto mínimo (con IVA) el Shop ofrece hasta esa cantidad de cuotas. Se compara contra el precio final, el total del carrito o el del pedido. Si el monto no alcanza ningún escalón, se cobra en 1 pago."
        >
          <div className="flex flex-col gap-4">
            {proveedores.length === 0 && (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Agregá un proveedor para cargarle escalones de cuotas.</p>
            )}

            {proveedores.map((proveedor) => {
              const filas = escalones.filter((e) => e.proveedorId === proveedor.id).sort(ordenarEscalones)
              return (
                <section key={proveedor.id} className="flex flex-col gap-2" aria-label={`Escalones de ${proveedor.nombre}`}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {proveedor.nombre} {!proveedor.activo && <Badge tone="neutral">Proveedor inactivo</Badge>}
                    </h3>
                    <Button size="sm" variant="secondary" onClick={() => abrirEscalon(escalonVacio(proveedor.id))}>
                      Agregar escalón
                    </Button>
                  </div>
                  <Table<EscalonDto>
                    rows={filas}
                    rowKey={(e) => e.id}
                    empty={<p className="text-sm py-3" style={{ color: "var(--ink-soft)" }}>Sin escalones: sólo 1 pago.</p>}
                    columns={[
                      {
                        key: "minimo",
                        header: "Desde",
                        render: (e) => (Number(e.montoMinimo) > 0 ? ars.format(Number(e.montoMinimo)) : "Cualquier monto"),
                      },
                      { key: "cuotas", header: "Hasta", render: (e) => textoCuotas(e.cuotasMax) },
                      { key: "estado", header: "Estado", render: (e) => <EstadoBadge activo={e.activo} /> },
                      {
                        key: "acciones",
                        header: "",
                        align: "right",
                        render: (e) => (
                          <div className="flex gap-1 justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                abrirEscalon({
                                  id: e.id,
                                  proveedorId: e.proveedorId,
                                  cuotasMax: String(e.cuotasMax),
                                  montoMinimo: Number(e.montoMinimo) > 0 ? e.montoMinimo : "",
                                  activo: e.activo,
                                })
                              }
                            >
                              Editar
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => alternarActivo("escalones", e.id, !e.activo)}>
                              {e.activo ? "Desactivar" : "Activar"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setBorrar(e)}>
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
      </div>

      <TasasMercadoPago tasasMP={tasasMP} />

      <Dialog
        open={proveedorForm !== null}
        onOpenChange={(open) => { if (!open) setProveedorForm(null) }}
        title={proveedorForm?.id ? "Editar proveedor" : "Agregar proveedor"}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setProveedorForm(null)}>Cancelar</Button>
            <Button loading={guardando} disabled={guardando} onClick={guardarProveedor}>Guardar</Button>
          </div>
        }
      >
        {proveedorForm && (
          <div className="flex flex-col gap-3">
            <Field label="Proveedor" error={errores.proveedor}>
              <Select
                options={opcionesProveedor.map((p) => ({ value: p.id, label: p.nombre }))}
                value={proveedorForm.proveedor}
                onValueChange={(proveedor) => setP({ proveedor })}
                disabled={Boolean(proveedorForm.id)}
                aria-label="Proveedor"
                aria-invalid={Boolean(errores.proveedor)}
              />
            </Field>
            <Field label="Orden" hint="Menor primero." error={errores.orden}>
              <Input type="number" min={0} step={1} value={proveedorForm.orden} onChange={(e) => setP({ orden: e.target.value })} aria-invalid={Boolean(errores.orden)} />
            </Field>
            <CheckboxLabel id="proveedor-activo" checked={proveedorForm.activo} onChange={(activo) => setP({ activo })} label="Activo" />
            {errores.general && <p className="text-sm" style={{ color: "var(--red)" }}>{errores.general}</p>}
          </div>
        )}
      </Dialog>

      <Dialog
        open={escalonForm !== null}
        onOpenChange={(open) => { if (!open) setEscalonForm(null) }}
        title={escalonForm?.id ? "Editar escalón" : "Agregar escalón"}
        description={escalonForm ? proveedores.find((p) => p.id === escalonForm.proveedorId)?.nombre : undefined}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setEscalonForm(null)}>Cancelar</Button>
            <Button loading={guardando} disabled={guardando} onClick={guardarEscalon}>Guardar</Button>
          </div>
        }
      >
        {escalonForm && (
          <div className="flex flex-col gap-3">
            <Field label="Monto mínimo (con IVA)" hint="Vacío = cualquier monto." error={errores.montoMinimo}>
              <Input
                inputMode="decimal"
                placeholder="180000"
                value={escalonForm.montoMinimo}
                onChange={(e) => setE({ montoMinimo: e.target.value })}
                aria-invalid={Boolean(errores.montoMinimo)}
              />
            </Field>
            <Field label="Máximo de cuotas" error={errores.cuotasMax}>
              <Select
                options={CUOTAS_OPCIONES}
                value={escalonForm.cuotasMax}
                onValueChange={(cuotasMax) => setE({ cuotasMax })}
                aria-label="Máximo de cuotas"
                aria-invalid={Boolean(errores.cuotasMax)}
              />
            </Field>
            <CheckboxLabel id="escalon-activo" checked={escalonForm.activo} onChange={(activo) => setE({ activo })} label="Activo" />
            {errores.general && <p className="text-sm" style={{ color: "var(--red)" }}>{errores.general}</p>}
          </div>
        )}
      </Dialog>

      <Dialog
        open={borrar !== null}
        onOpenChange={(open) => { if (!open) setBorrar(null) }}
        title="Borrar escalón"
        description="Se borra definitivamente. Si sólo querés dejar de ofrecerlo por un tiempo, desactivalo."
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
            ¿Borrar &quot;{montoBorrar > 0 ? `desde ${ars.format(montoBorrar)}` : "cualquier monto"}, hasta {textoCuotas(borrar.cuotasMax)}&quot;?
          </p>
        )}
      </Dialog>
    </div>
  )
}
