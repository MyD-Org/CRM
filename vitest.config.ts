import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"
import { TEST_DATABASE_URL } from "./test/integration/db-url"

// Dos tipos de test, separados en "projects":
//  - unit:        funciones puras, sin DB ni runtime de Next. Rápidos, corren en CI sin nada.
//  - integration: queries reales de drizzle contra una DB Postgres LOCAL de test (crm_test),
//                 que el globalSetup crea y migra sola. Nunca toca una DB real (ver db-url.ts).
//
// `npm test` corre solo unit (rápido). `npm run test:integration` corre los de DB.
// `npm run test:all` corre ambos.

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) }
const SESSION_SECRET = "test-session-secret-at-least-32-characters-long"

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          env: { SESSION_SECRET },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          env: { SESSION_SECRET, DATABASE_URL: TEST_DATABASE_URL },
          globalSetup: ["./test/integration/global-setup.ts"],
          // Comparten la misma DB de test → sin paralelismo entre archivos para no pisarse.
          fileParallelism: false,
        },
      },
    ],
  },
})
