// Skeleton compartido de todas las pantallas del admin.
//
// Sin este archivo, las páginas `force-dynamic` bloquean la navegación entera: el click
// queda sin respuesta visual hasta que el servidor terminó de renderear (inbox = varias
// llamadas a ai-api + DB). Con el boundary, Next pinta esto al instante y además puede
// PREFETCHEAR el resto del árbol al hacer hover sobre el link, cosa que en rutas dinámicas
// sin loading.tsx no hace.
export default function AdminLoading() {
  return (
    <div className="p-4 md:p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando…</span>

      {/* Título */}
      <div className="mb-4 md:mb-6 pl-10 md:pl-0">
        <Bar className="h-5 w-32" />
        <Bar className="h-3.5 w-64 mt-2 hidden md:block" />
      </div>

      {/* Filas genéricas: sirven igual para el inbox, usuarios y catálogo */}
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-[var(--radius)]"
            style={{ background: "var(--card)", border: "1px solid var(--border)" }}
          >
            <Bar className="h-8 w-8 shrink-0 rounded-full" />
            <div className="flex-1 min-w-0">
              <Bar className="h-3.5 w-40 max-w-full" />
              <Bar className="h-3 w-56 max-w-full mt-2" />
            </div>
            <Bar className="h-3 w-12 shrink-0 hidden md:block" />
          </div>
        ))}
      </div>
    </div>
  )
}

function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded ${className}`}
      style={{ background: "var(--border)" }}
    />
  )
}
