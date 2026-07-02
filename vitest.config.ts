import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Vitest mínimo para unit tests de funciones puras (sin DB ni Next runtime):
// firma/verificación del crm_token con tenant, y comparación de secretos en tiempo
// constante. Resuelve el alias "@/..." igual que tsconfig.json.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // SESSION_SECRET es obligatorio a nivel de módulo (fail-fast en session-secret.ts).
    env: {
      SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
    },
  },
})
