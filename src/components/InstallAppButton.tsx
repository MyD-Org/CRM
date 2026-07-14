"use client"

import { useEffect, useState } from "react"
import { Download, Share, Plus, X } from "lucide-react"

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

function isIos() {
  if (typeof navigator === "undefined") return false
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
}

function isIosSafari() {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  return isIos() && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
}

function isStandalone() {
  if (typeof window === "undefined") return false
  const displayMode = window.matchMedia?.("(display-mode: standalone)").matches
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true
  return Boolean(displayMode || iosStandalone)
}

export function InstallAppButton({ appName }: { appName: string }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosSheet, setShowIosSheet] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    // Detección de capacidades de cliente tras hydration: evita mismatch entre SSR y client
    // (userAgent y display-mode no existen en server). El eslint rule "set-state-in-effect"
    // no aplica bien a este patrón de "capability detection post-mount".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    if (isStandalone()) setInstalled(true)

    function onBeforeInstall(e: Event) {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    function onInstalled() {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  if (!mounted || installed) return null

  const canInstallNative = Boolean(deferredPrompt)
  const canShowIosGuide = isIosSafari()
  if (!canInstallNative && !canShowIosGuide) return null

  async function handleClick() {
    if (deferredPrompt) {
      await deferredPrompt.prompt()
      await deferredPrompt.userChoice
      setDeferredPrompt(null)
      return
    }
    setShowIosSheet(true)
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="fixed bottom-4 right-4 md:hidden z-40 inline-flex items-center gap-2 rounded-full shadow-md px-4 py-2.5 text-sm font-medium"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          color: "var(--ink, #111)",
        }}
        aria-label="Instalar app"
      >
        <Download size={16} />
        Instalar app
      </button>

      {showIosSheet && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 p-4 flex justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ios-install-title"
        >
          <div
            className="w-full max-w-md rounded-[var(--radius)] shadow-lg p-5 relative"
            style={{ background: "var(--card)", border: "1px solid var(--border)" }}
          >
            <button
              type="button"
              onClick={() => setShowIosSheet(false)}
              className="absolute top-3 right-3 p-1 rounded hover:bg-black/5"
              aria-label="Cerrar"
            >
              <X size={16} />
            </button>
            <h2 id="ios-install-title" className="font-semibold text-base mb-1">
              Instalá {appName}
            </h2>
            <p className="text-sm mb-4" style={{ color: "var(--muted-foreground, #666)" }}>
              Tres pasos para agregarlo a tu pantalla de inicio:
            </p>
            <ol className="flex flex-col gap-3 text-sm">
              <li className="flex items-center gap-3">
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 font-medium text-xs"
                  style={{ background: "var(--blue-soft, #e6f0ff)", color: "var(--blue, #0066ff)" }}
                >
                  1
                </span>
                <span className="flex items-center gap-1.5">
                  Tocá <Share size={16} className="inline" aria-label="Compartir" /> abajo (en Safari)
                </span>
              </li>
              <li className="flex items-center gap-3">
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 font-medium text-xs"
                  style={{ background: "var(--blue-soft, #e6f0ff)", color: "var(--blue, #0066ff)" }}
                >
                  2
                </span>
                <span className="flex items-center gap-1.5">
                  Elegí &quot;Agregar a inicio&quot; <Plus size={16} className="inline" aria-label="Más" />
                </span>
              </li>
              <li className="flex items-center gap-3">
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 font-medium text-xs"
                  style={{ background: "var(--blue-soft, #e6f0ff)", color: "var(--blue, #0066ff)" }}
                >
                  3
                </span>
                <span>Tocá &quot;Agregar&quot; arriba a la derecha</span>
              </li>
            </ol>
          </div>
        </div>
      )}
    </>
  )
}
