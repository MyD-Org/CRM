"use client"

import { useEffect, useRef } from "react"

/**
 * Poll que se pausa cuando la pestaña deja de estar visible, y que al volver hace un fetch
 * inmediato antes de reanudar el intervalo.
 *
 * Por qué: el inbox queda abierto en una pestaña todo el día. Con la pestaña oculta el poll
 * no le avisa nada a nadie —no cambiamos el título, no hay sonido, no hay badge desde el
 * cliente: el aviso real de un mensaje nuevo llega por Web Push, que corre en el service
 * worker (public/sw.js) aun con el navegador cerrado— pero cada pasada igual pega contra la
 * DB de la ai-api. Neon cobra el tiempo con el compute despierto y solo autosuspende tras
 * ~5 min SIN conexiones, así que un poll de 5-10s por pestaña abierta lo mantenía prendido
 * 24/7 y se comía el plan.
 *
 * El fetch inmediato al volver a la pestaña es lo que hace que pausar sea seguro: nunca hay
 * una ventana en la que estés mirando el inbox con datos viejos esperando el próximo tick.
 *
 * No dispara nada al montar: el estado inicial ya viene del render del server, y los
 * llamadores que quieren una carga inmediata la hacen explícita (ver InboxList).
 */
export function useVisiblePoll(poll: () => void | Promise<void>, intervalMs: number): void {
  // El callback se re-crea en cada render (depende del estado del componente); lo guardamos
  // en un ref para no reiniciar el intervalo en cada render.
  const saved = useRef(poll)
  useEffect(() => {
    saved.current = poll
  })

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    const start = () => {
      if (!timer) timer = setInterval(() => void saved.current(), intervalMs)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void saved.current()
        start()
      } else {
        stop()
      }
    }

    // Al montar arrancamos el intervalo solo si la pestaña ya está visible (montar en una
    // pestaña de fondo —p. ej. abierta con ctrl+click— no debe empezar a pollear).
    if (document.visibilityState === "visible") start()
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [intervalMs])
}
