"use client"

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Button, Dialog } from "@myd-org/ui"

// Guard compartido de "cambios sin guardar". Un form llama a useUnsavedGuard(dirty) y
// el AdminShell intercepta la navegación (clicks del sidebar + logout) si algún form
// registrado quedó sucio, mostrando un Dialog de confirmación.
//
// El registro es un set de ids: soporta múltiples forms al mismo tiempo (aunque hoy la
// app tiene solo uno por página). El hook también engancha `beforeunload` para cubrir
// refresh, cerrar la pestaña y tipear otra URL — casos donde no podemos interceptar
// con un Dialog nuestro y el navegador maneja la confirmación.

type Ctx = {
  // Chequeo síncrono para usar en un onClick antes de decidir preventDefault().
  isDirty: () => boolean
  // Registra/desregistra un form. `id` viene del useId() del consumidor.
  setDirty: (id: string, dirty: boolean) => void
  // Muestra el Dialog si hay algo sucio. Resuelve `true` si el usuario elige salir.
  // Si no hay nada sucio, resuelve `true` sin mostrar nada.
  confirmLeave: () => Promise<boolean>
}

const UnsavedGuardContext = createContext<Ctx | null>(null)

export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const dirtyIdsRef = useRef(new Set<string>())
  // Mientras el Dialog está abierto, guardamos el `resolve` de la promesa que devolvió
  // confirmLeave() — al elegir stay/leave, resolvemos con false/true y cerramos.
  const [pendingResolve, setPendingResolve] = useState<((v: boolean) => void) | null>(null)

  const isDirty = useCallback(() => dirtyIdsRef.current.size > 0, [])

  const setDirty = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyIdsRef.current.add(id)
    else dirtyIdsRef.current.delete(id)
  }, [])

  const confirmLeave = useCallback(() => {
    if (dirtyIdsRef.current.size === 0) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      // El setter con function-form evita que React interprete la resolve como updater.
      setPendingResolve(() => resolve)
    })
  }, [])

  const closeDialog = useCallback(
    (proceed: boolean) => {
      pendingResolve?.(proceed)
      setPendingResolve(null)
    },
    [pendingResolve],
  )

  return (
    <UnsavedGuardContext.Provider value={{ isDirty, setDirty, confirmLeave }}>
      {children}
      <Dialog
        open={pendingResolve !== null}
        onOpenChange={(open) => {
          // Cerrar por ESC / click fuera = quedarse (default seguro, no descarta cambios).
          if (!open) closeDialog(false)
        }}
        title="Tenés cambios sin guardar"
        description="Si salís los vas a perder."
        headerBorder={false}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => closeDialog(false)}>
              Quedarme
            </Button>
            <Button variant="danger" onClick={() => closeDialog(true)}>
              Salir sin guardar
            </Button>
          </div>
        }
      />
    </UnsavedGuardContext.Provider>
  )
}

// Hook para forms: llamalo con un `dirty: boolean`. Se registra en el contexto y
// engancha el `beforeunload` del navegador solo mientras esté sucio.
export function useUnsavedGuard(dirty: boolean): void {
  const ctx = useContext(UnsavedGuardContext)
  const id = useId()

  useEffect(() => {
    if (!ctx) return
    ctx.setDirty(id, dirty)
    return () => ctx.setDirty(id, false)
  }, [ctx, id, dirty])

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      // Chrome/Firefox: preventDefault + returnValue = "" muestra el prompt nativo.
      // Safari respeta solo returnValue. El texto que muestra es del navegador, no nuestro.
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])
}

// Hook para el Shell: expone el contexto para poder interceptar navegación
// (sync isDirty + async confirmLeave). Devuelve null si no está adentro del Provider,
// para no forzar a tests o storybooks a envolver todo.
export function useUnsavedGuardCtx(): Ctx | null {
  return useContext(UnsavedGuardContext)
}
