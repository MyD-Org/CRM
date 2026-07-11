# Deploy a Vercel

Guía para deployar el CRM en Vercel con Postgres en la nube (Neon). El repo ya está
en GitHub (`MyD-Org/CRM`); el deploy se hace por la integración GitHub↔Vercel (cada push
a `main` redeploya solo).

> Los **valores secretos** no viven en este doc. Copialos de tu `.env.local` o generá
> nuevos donde se indica.

## 1. Base de datos (Neon)

1. Crear un proyecto en [neon.tech](https://neon.tech) (o usar Vercel → Storage → Postgres,
   que por debajo es Neon). Elegir la región más cercana (ej. `aws-sa-east-1`).
2. Copiar el **connection string pooled** (`postgres://…-pooler.…neon.tech/…?sslmode=require`).
3. Aplicar el schema y el seed contra Neon (desde tu máquina):

   ```bash
   DATABASE_URL="<connection string de Neon>" npm run db:migrate
   DATABASE_URL="<connection string de Neon>" npm run db:seed
   ```

   `db:migrate` incluye la migración `0008` que elimina las columnas de Flexxus.

## 2. Proyecto en Vercel

1. En [vercel.com](https://vercel.com) → **Add New → Project** → importar `MyD-Org/CRM`.
2. Framework: Next.js (autodetectado). No cambiar build/output.
3. Cargar las variables de entorno (sección siguiente) en **Production**.
4. Deploy. Los crons de `vercel.json` (`/api/cron/notifications` diario,
   `/api/cron/auto-return-bot` horario) quedan activos automáticamente.

## 3. Variables de entorno (Production)

### Base de datos
| Var | Valor |
|---|---|
| `DATABASE_URL` | Connection string pooled de Neon |

### Secretos — generar nuevos para prod
Los de `.env.local` son placeholders de dev. Generar con `openssl`:
```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 32      # CRON_SECRET
```
| Var | Cómo |
|---|---|
| `SESSION_SECRET` | Nuevo (firma sesiones y los `crm_token` del agente) |
| `CRON_SECRET` | Nuevo (protege los endpoints de cron) |

### Secretos — reutilizar los de `.env.local`
`INTERNAL_SECRET` y `STAFF_TOKEN_SECRET` son **compartidos con ai-api**: si los cambiás,
actualizalos también allá.
| Var | Nota |
|---|---|
| `INTERNAL_SECRET` | Compartido con ai-api |
| `STAFF_TOKEN_SECRET` | Compartido con ai-api |
| `RESEND_API_KEY` | Envío de emails (el `RESEND_FROM` debe ser un dominio verificado en Resend) |
| `ADMIN_EMAIL` | Login del backoffice |
| `ADMIN_PASSWORD` | Login del backoffice — usar una contraseña fuerte en prod |

### Routing / tenant
| Var | Valor |
|---|---|
| `TENANT_IDS` | `central-led` |
| `TENANT_OVERRIDE` | `central-led` — **necesario** mientras uses el dominio `*.vercel.app`. El middleware resuelve el tenant por subdominio; sin override, `xxx.vercel.app` no matchea y todo da 404. Al pasar a subdominios reales (`central-led.tudominio.com`) se quita. |
| `NEXT_PUBLIC_BASE_URL` | La URL pública del deploy (ej. `https://crm-xxx.vercel.app`) |

### Tienda (opcional)
| Var | Valor |
|---|---|
| `SHOP_ENABLED` | `false` (o `true` si el shop está deployado) |
| `NEXT_PUBLIC_SHOP_URL` | URL del shop, solo si `SHOP_ENABLED=true` |

### Tenant `central-led`
| Var | Valor |
|---|---|
| `CENTRAL_LED_NAME` | `Central LED` |
| `CENTRAL_LED_SUBTITLE` | `Materiales Eléctricos e Iluminación` |
| `CENTRAL_LED_LOGO` | `/logos/central-led.svg` |
| `CENTRAL_LED_WHATSAPP` | `5493757300293` |
| `CENTRAL_LED_RESEND_FROM` | `portal@central-led.com` |
| `CENTRAL_LED_MOCK` | `true` → el portal corre con **datos de prueba** hasta tener las credenciales de Alegra de Central LED. Setear `CENTRAL_LED_ALEGRA_EMAIL` + `CENTRAL_LED_ALEGRA_TOKEN` y quitar `MOCK` para datos reales. |
| `CENTRAL_LED_AI_API_URL` | URL de prod de **ai-api** (el chat requiere ai-api deployado; si no lo está, dejá el flag `ai-chat-enabled` en off) |
| `CENTRAL_LED_AI_API_KEY` | De `.env.local` |
| `CENTRAL_LED_AI_AGENT_ID` | De `.env.local` |
| `CENTRAL_LED_AI_TENANT_ID` | De `.env.local` |

### NO cargar en prod
- `GITHUB_TOKEN` — no se usa en runtime.
- `AI_CHAT_ENABLED` — flag de dev; en prod el chat se controla con Vercel Flags (`ai-chat-enabled`).

## 4. Checklist post-deploy
- [ ] Migraciones + seed corridos contra Neon.
- [ ] El portal abre sin 404 (con `TENANT_OVERRIDE=central-led`).
- [ ] Login del backoffice (`/admin`) con `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- [ ] Si se usa email: dominio de `RESEND_FROM` verificado en Resend.
- [ ] Si se usa el chat: `ai-api` deployado y `ai-chat-enabled` activo.
