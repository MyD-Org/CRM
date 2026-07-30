// Preferencia "el copiloto queda abierto", persistida en el navegador y compartida entre las
// conversaciones (y entre pestañas).
//
// Por qué un store y no un useState + useEffect: localStorage no existe en el server, así que
// leerlo en el inicializador haría que el HTML del server diga "cerrado" y el cliente lo pinte
// "abierto" → mismatch de hidratación. Y restaurarlo con un setState dentro de un useEffect es
// justo lo que corta el lint del repo (react-hooks/set-state-in-effect). useSyncExternalStore
// es la herramienta pensada para esto: tiene un snapshot aparte para el server.

const KEY = "assistOpen"

const listeners = new Set<() => void>()

export function subscribeAssistOpen(onChange: () => void): () => void {
  listeners.add(onChange)
  // 'storage' solo dispara en las OTRAS pestañas: si el operador tiene dos abiertas, la
  // preferencia se mantiene igual en las dos.
  window.addEventListener("storage", onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onChange)
  }
}

// Devuelve un boolean (valor primitivo estable): useSyncExternalStore compara por identidad y
// con un objeto nuevo en cada llamada entraría en un loop de renders.
export function getAssistOpen(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1"
  } catch {
    // Safari en modo privado puede tirar al tocar localStorage; el copiloto no es crítico.
    return false
  }
}

export function setAssistOpen(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, open ? "1" : "0")
  } catch {
    /* ver getAssistOpen */
  }
  for (const l of listeners) l()
}
