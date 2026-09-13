"use client"

import { useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@myd-org/ui"

// ── Paginación contra el server (común a las tablas del dashboard y a los historiales) ──
//
// Nada se trae entero: un cliente con 1282 facturas o 387 pagos rompía el dashboard. Cada tabla
// pide una ventana al server (y el server se la pide al ERP cuando aplica). Los filtros que el
// server sabe resolver viajan como parámetros; lo que no sabe resolver, directamente no se
// ofrece — un filtro, una búsqueda o un orden que solo mira la página cargada le hace creer al
// cliente que algo no existe.

export interface Ventana<T> {
  /** Índice de la primera fila mostrada dentro del total. En celular siempre 0: se acumula. */
  start: number
  items: T[]
  total: number
}

export function usePaginado<T>({
  url,
  pick,
  inicial,
  totalInicial,
  pageSize,
}: {
  /** Endpoint del portal, ej. "/api/portal/pagos". */
  url: string
  /** Cómo sacar las filas de la respuesta: { pagos, total }, { presupuestos, total }… */
  pick: (data: Record<string, unknown>) => T[]
  /** Primera página, la que trajo el server component. */
  inicial: T[]
  totalInicial: number
  pageSize: number
}) {
  // `null` = la primera página tal como vino del server, sin filtros ni navegación.
  const [vista, setVista] = useState<Ventana<T> | null>(null)
  const [prevInicial, setPrevInicial] = useState(inicial)
  if (prevInicial !== inicial) {
    // El server component volvió a renderizar: lo cargado puede estar viejo.
    setPrevInicial(inicial)
    setVista(null)
  }
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState("")
  const consultaRef = useRef(0)
  const paramsRef = useRef(new URLSearchParams())

  const items = vista ? vista.items : inicial
  const total = vista ? vista.total : totalInicial
  const desde = vista ? vista.start : 0
  const hayMas = desde + items.length < total

  async function pedir(start: number, params: URLSearchParams) {
    const q = new URLSearchParams(params)
    q.set("start", String(start))
    const res = await fetch(`${url}?${q}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "No pudimos cargar los datos")
    return { items: pick(data), total: Number(data.total ?? 0) }
  }

  async function correr(fn: (consulta: number) => Promise<void>) {
    // Toda consulta nueva invalida las anteriores: tocar dos filtros o dos páginas seguidas
    // puede resolverse desordenado y dejar en pantalla un resultado viejo.
    const consulta = ++consultaRef.current
    setCargando(true)
    setError("")
    try {
      await fn(consulta)
    } catch (err) {
      if (consultaRef.current === consulta) setError(err instanceof Error ? err.message : "No pudimos cargar los datos")
    } finally {
      if (consultaRef.current === consulta) setCargando(false)
    }
  }

  /** Aplica filtros nuevos y vuelve a la primera página. Sin parámetros, vuelve a lo inicial. */
  function filtrar(params: URLSearchParams) {
    paramsRef.current = params
    if ([...params.keys()].length === 0) {
      ++consultaRef.current // invalida lo que esté en vuelo
      setVista(null)
      setCargando(false)
      setError("")
      return
    }
    return correr(async (consulta) => {
      const page = await pedir(0, params)
      if (consultaRef.current === consulta) setVista({ start: 0, ...page })
    })
  }

  /** Desktop: reemplaza por la página pedida. */
  function irAPagina(start: number) {
    return correr(async (consulta) => {
      const page = await pedir(start, paramsRef.current)
      if (consultaRef.current === consulta) setVista({ start, ...page })
    })
  }

  /** Celular: suma la tanda siguiente. */
  function cargarMas() {
    const actuales = items
    return correr(async (consulta) => {
      const page = await pedir(desde + actuales.length, paramsRef.current)
      if (consultaRef.current === consulta) setVista({ start: desde, items: [...actuales, ...page.items], total: page.total })
    })
  }

  return { items, total, desde, hayMas, cargando, error, filtrar, irAPagina, cargarMas, pageSize, setVista }
}

/** Controles de página: flechas en desktop, "Cargar más" en celular. */
export function Paginacion({
  desde,
  cantidad,
  total,
  hayMas,
  cargando,
  error,
  pageSize,
  onIrAPagina,
  onCargarMas,
}: {
  desde: number
  cantidad: number
  total: number
  hayMas: boolean
  cargando: boolean
  error: string
  pageSize: number
  onIrAPagina: (start: number) => void
  onCargarMas: () => void
}) {
  const esDesktop = useEsDesktop()
  if (total === 0 && !error) return null
  return (
    <div className="flex flex-col items-center gap-2 pt-4">
      {error && <p className="text-xs" style={{ color: "var(--red)" }}>{error}</p>}
      {esDesktop ? (
        (hayMas || desde > 0) && (
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => onIrAPagina(Math.max(0, desde - pageSize))} disabled={cargando || desde === 0}>
              Anterior
            </Button>
            <p className="text-xs tabular-nums" style={{ color: "var(--ink-faint)" }}>
              {cargando ? "Cargando…" : `${desde + 1}–${desde + cantidad} de ${total}`}
            </p>
            <Button variant="ghost" onClick={() => onIrAPagina(desde + pageSize)} disabled={cargando || !hayMas}>
              Siguiente
            </Button>
          </div>
        )
      ) : hayMas ? (
        <>
          <Button variant="ghost" onClick={onCargarMas} disabled={cargando}>
            {cargando ? "Cargando…" : "Cargar más"}
          </Button>
          <p className="text-xs" style={{ color: "var(--ink-faint)" }}>Mostrando {cantidad} de {total}</p>
        </>
      ) : null}
    </div>
  )
}

const MQ_DESKTOP = "(min-width: 640px)"

/**
 * Desktop o celular, para elegir cómo se recorre el historial: flechas de página en
 * pantalla grande, "Cargar más" en chica. La tabla es la misma en los dos.
 *
 * Arranca en `false` y se corrige después de montar: en el server no hay `window`, y
 * asumir desktop haría que el HTML del server no coincida con el del cliente.
 */
export function useEsDesktop() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(MQ_DESKTOP)
      mq.addEventListener("change", onChange)
      return () => mq.removeEventListener("change", onChange)
    },
    () => window.matchMedia(MQ_DESKTOP).matches,
    () => false, // en el server no hay `window`: se asume celular y se corrige al hidratar
  )
}
