/* Service worker del CRM.
 *
 * Alcance mínimo a propósito: SOLO Web Push (notificaciones). No cachea ni intercepta fetch,
 * así que no cambia el comportamiento de red de la app ni sirve contenido viejo. Si en el
 * futuro se quiere offline/caching, se agrega acá con cuidado (versionar y limpiar cachés).
 */

// Muestra la notificación cuando llega un push desde el servidor (src/lib/push.ts).
self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: "Notificación", body: event.data ? event.data.text() : "" }
  }

  const title = data.title || "CRM"
  const options = {
    body: data.body || "",
    // Ícono del tenant (SVG), resuelto en el servidor; fallback a un asset del CRM.
    icon: data.icon || "/logo.svg",
    tag: data.tag, // agrupa/reemplaza avisos del mismo hilo
    renotify: Boolean(data.tag),
    data: { url: data.url || "/admin/inbox" },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// Al tocar la notificación: enfoca una pestaña ya abierta del CRM (y navega) o abre una nueva.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || "/admin/inbox"

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Si ya hay una ventana del mismo origen, la reusamos.
        if ("focus" in client) {
          client.navigate(targetUrl).catch(() => {})
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
    }),
  )
})

// Activa el SW nuevo inmediatamente (sin esperar a que se cierren las pestañas viejas).
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))
