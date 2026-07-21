"use client"

import { useEffect, useState } from "react"
import { Bell, BellOff, X } from "lucide-react"

// Aviso para activar las notificaciones push del inbox. Diseño a propósito "oculto": no hay
// toggle permanente para prender/apagar. Reaparece en CADA entrada al backoffice mientras el
// operador todavía no las tenga activas (permiso sin decidir); "Ahora no" solo lo cierra en
// esta visita, no lo silencia para siempre. Si ya dio permiso, re-sincroniza la suscripción en
// silencio (sin UI). Si las bloqueó, no insistimos (el navegador ya no deja re-preguntar).
//
// Nota de navegadores: el permiso NO puede pedirse solo al cargar (iOS Safari exige un gesto
// del usuario; Chrome bloquea el prompt automático). Por eso el aviso lleva un botón — ese
// click es el gesto que el navegador necesita.

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

function isStandalone() {
  if (typeof window === "undefined") return false
  const displayMode = window.matchMedia?.("(display-mode: standalone)").matches
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true
  return Boolean(displayMode || iosStandalone)
}

function isIos() {
  if (typeof navigator === "undefined") return false
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
}

async function subscribe(vapidKey: string): Promise<boolean> {
  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    }))
  const res = await fetch("/api/admin/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  })
  return res.ok
}

export function NotificationsPrompt() {
  const [mode, setMode] = useState<"hidden" | "prompt" | "blocked">("hidden")
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

  useEffect(() => {
    let cancelled = false

    // Al abrir/mirar el backoffice, el operador "ya vio" las notis → limpiamos el badge del
    // ícono y reseteamos el contador del service worker. clearAppBadge borra el numerito ya;
    // el mensaje al SW pone su contador en 0 para que el próximo push arranque de cero.
    function clearBadge() {
      const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> }
      nav.clearAppBadge?.().catch(() => {})
      navigator.serviceWorker?.ready
        .then((reg) => reg.active?.postMessage({ type: "badge-reset" }))
        .catch(() => {})
    }
    clearBadge()
    const onVisible = () => {
      if (document.visibilityState === "visible") clearBadge()
    }
    document.addEventListener("visibilitychange", onVisible)

    async function init() {
      const supported =
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window
      // Sin soporte, sin claves, o iOS sin instalar (no expone PushManager): no molestamos.
      if (!supported || !vapidKey || (isIos() && !isStandalone())) return

      try {
        await navigator.serviceWorker.register("/sw.js")
      } catch {
        return
      }

      // Ya tiene el permiso dado → re-sincroniza la suscripción en silencio, sin aviso.
      if (Notification.permission === "granted") {
        subscribe(vapidKey).catch(() => {})
        return
      }
      // Bloqueado: el navegador ya no deja re-preguntar por JS. Mostramos un cartel que explica
      // cómo desbloquear desde los ajustes del sitio (el botón "Activar" no serviría).
      if (Notification.permission === "denied") {
        if (!cancelled) setMode("blocked")
        return
      }

      // Permiso sin decidir: mostramos el aviso. Reaparece en cada entrada hasta que active.
      if (!cancelled) setMode("prompt")
    }
    init()
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "Ahora no"/✕: solo cierra el aviso en esta visita. Vuelve a aparecer en la próxima entrada
  // mientras el operador no active las notificaciones.
  function dismiss() {
    setMode("hidden")
  }

  async function activate() {
    if (!vapidKey) return setMode("hidden")
    // iOS exige que requestPermission salga del gesto del usuario: la llamamos SINCRÓNICAMENTE
    // (primera línea, sin await antes) y disparamos el prompt. Cerramos el modal enseguida y
    // hacemos la suscripción en segundo plano: así el modal SIEMPRE se cierra al tocar, aunque
    // la suscripción/permiso tarde o quede colgada (bug del modal que no cerraba en iOS PWA).
    const permissionPromise = Notification.requestPermission()
    setMode("hidden")
    try {
      const permission = await permissionPromise
      if (permission === "granted") await subscribe(vapidKey)
    } catch {
      // best-effort: el push es opcional, un fallo no debe afectar la UI
    }
  }

  if (mode === "hidden") return null

  if (mode === "blocked") {
    return (
      <div className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
        <div className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-card p-4 shadow-lg">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-subtle/15">
            <BellOff className="h-5 w-5 text-text" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text">Notificaciones bloqueadas</p>
            <p className="mt-0.5 text-sm text-subtle">
              Las bloqueaste en este navegador. Activalas desde el candado de la barra de direcciones
              (Notificaciones → Permitir) para enterarte de tus conversaciones.
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Cerrar"
            className="shrink-0 rounded p-1 text-subtle transition-colors hover:text-text"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
      <div className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-card p-4 shadow-lg">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-subtle/15">
          <Bell className="h-5 w-5 text-text" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">Activá las notificaciones</p>
          <p className="mt-0.5 text-sm text-subtle">
            Te avisamos cuando te asignen o deriven una conversación, aunque no tengas el CRM abierto.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={activate}
              className="rounded-full bg-text px-4 py-1.5 text-sm font-semibold text-card transition-opacity hover:opacity-90"
            >
              Activar
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-full px-3 py-1.5 text-sm font-medium text-subtle transition-colors hover:text-text"
            >
              Ahora no
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Cerrar"
          className="shrink-0 rounded p-1 text-subtle transition-colors hover:text-text"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  )
}
