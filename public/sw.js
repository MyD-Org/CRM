/* Service worker del CRM.
 *
 * Alcance mínimo a propósito: SOLO Web Push (notificaciones) + badge del ícono. No cachea ni
 * intercepta fetch, así que no cambia el comportamiento de red de la app ni sirve contenido
 * viejo. Si en el futuro se quiere offline/caching, se agrega acá con cuidado.
 */

// ── Badge del ícono (numerito estilo WhatsApp) ───────────────────────────────
// Contador simple: sube +1 con cada push y se resetea cuando el operador abre el backoffice
// (el cliente manda 'badge-reset'). Persiste en IndexedDB porque el service worker se apaga
// entre eventos. Cuenta "notificaciones nuevas desde que abriste", no pendientes exactos.
function openBadgeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("crm-badge", 1)
    req.onupgradeneeded = () => req.result.createObjectStore("kv")
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function readCount() {
  return openBadgeDb().then(
    (db) =>
      new Promise((resolve) => {
        const req = db.transaction("kv", "readonly").objectStore("kv").get("count")
        req.onsuccess = () => resolve(req.result || 0)
        req.onerror = () => resolve(0)
      }),
  )
}

function writeCount(n) {
  return openBadgeDb().then(
    (db) =>
      new Promise((resolve) => {
        const tx = db.transaction("kv", "readwrite")
        tx.objectStore("kv").put(n, "count")
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      }),
  )
}

async function bumpBadge() {
  const next = (await readCount().catch(() => 0)) + 1
  await writeCount(next).catch(() => {})
  if (self.navigator.setAppBadge) await self.navigator.setAppBadge(next).catch(() => {})
}

async function resetBadge() {
  await writeCount(0).catch(() => {})
  if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge().catch(() => {})
}

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

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options)
      await bumpBadge()
    })(),
  )
})

// El cliente avisa que el operador abrió/miró el backoffice → limpiamos el badge.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "badge-reset") {
    event.waitUntil(resetBadge())
  }
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
