# Salida a producción: bots respondiendo desde el admin

> **Objetivo**: sacar a producción la parte del admin donde los bots responden a clientes
> (WhatsApp/IG/Messenger vía ai-api) de la forma más confiable posible.
>
> **Repos involucrados**: este CRM, `~/Documents/Fede/ai-api` y el contrato en
> `platform/contracts/crm-ai-api.md`.
>
> **Estado**: 📝 planificación — 2026-07-13.

---

## 1. Cómo funciona hoy (relevado, no asumido)

El CRM es una capa admin fina sobre la **ai-api**: los mensajes de los clientes los
recibe y responde la ai-api por su webhook de Meta. El CRM lista el inbox y controla
el modo por conversación.

### Lo que ya existe y está sólido ✅

| Pieza | Dónde | Detalle |
|---|---|---|
| Tracking de gasto | ai-api `src/usage/record.ts` + tabla `usage_records` | Tokens (input/output/cache) + `estimated_cost_usd` por tenant, conversación y modelo. Se graba en cada llamada. |
| Rate limits por tenant | ai-api `src/usage/limits.ts` | `tenants.settings.limits`: `messages_per_day` y `tokens_per_month`. Al excederse el bot **no consume modelo y deriva a humano**. |
| Anti-loop | ai-api `src/channels/inbound.ts` | Cliente repite el mismo texto 2+ veces → handoff automático. |
| Apagado por conversación | CRM `src/app/api/admin/inbox/[id]/mode/route.ts` | Toggle `bot` ↔ `human`, ya integrado al inbox del admin. |
| Firma de webhooks | ai-api `src/channels/signature.ts` | HMAC-SHA256 por tenant, comparación en tiempo constante. |
| Cola serial por contacto | ai-api `src/channels/inbound-queue.ts` | Dos mensajes seguidos del mismo cliente no corren turnos del modelo en paralelo. **Supone instancia única** (en memoria). |
| Fallback si el modelo falla | ai-api `src/channels/inbound.ts` | El cliente recibe aviso de demora, no silencio. |
| Retries de envío | ai-api `src/channels/sender.ts` | Backoff lineal + reconcile de eventos no procesados. Los no entregados quedan `'failed'` en `channel_messages`. |
| Auto-cierre de conversaciones | CRM `src/app/api/cron/auto-return-bot/route.ts` | Cron diario (vercel.json, 9:00): cierra conversaciones sin actividad +24hs. |

### Los dos gaps funcionales ❌

1. **No hay visibilidad del gasto**: los datos están en `usage_records` pero ningún
   endpoint los expone ni el admin los muestra.
2. **No hay kill switch global**: solo se puede apagar el bot conversación por
   conversación. Si responde mal, no hay botón de "pausar todo".

---

## 2. Feature A — Kill switch global del bot 🔴

**Diseño**: flag `botEnabled` en `tenants.settings` (jsonb, ai-api). Con el bot
apagado, los mensajes entrantes **derivan a la cola de humanos** (mismo path que el
rate limit excedido: se persiste el mensaje del cliente + `executeHandoff`). El
cliente no queda hablando solo; alguien lo atiende.

### Tareas

- [x] **ai-api**: gate `isBotEnabled()` en `src/channels/inbound.ts` antes de invocar el
      modelo (después del early-return de modo humano; persiste el mensaje y no responde).
      Módulo nuevo `src/channels/bot-status.ts` (read `settings.botEnabled` + write con
      merge jsonb `||`). Tests: `test/channels/bot-status.test.ts` +
      caso "kill switch" en `test/routes/webhooks-inbound.test.ts`.
- [x] **ai-api**: mismo gate en el path del **widget** (portal) en
      `src/routes/conversations.ts` → devuelve `503 { error: "bot_disabled" }` antes de
      abrir el stream. Test en `test/routes/conversations.test.ts`.
- [ ] **ai-widget**: manejar el `503 bot_disabled` en la UI del widget (mensaje "asistente
      no disponible" / ocultar input). ← **pendiente (repo ai-widget)**
- [x] **ai-api**: endpoints staff `GET/POST /v1/inbox/bot-status` en `src/routes/inbox.ts`.
- [x] **CRM**: ruta proxy `GET/POST /api/admin/inbox/bot-status` + helpers
      `getBotStatus`/`setBotStatus` en `src/lib/inbox-api.ts`.
- [x] **CRM**: toggle en el header del inbox (`BotKillSwitch.tsx`) con badge de estado
      (activo/pausado) y confirmación al apagar.
- [x] **platform**: documentado en `contracts/crm-ai-api.md` (sección "Kill switch global").
- [x] **Decidido (2026-07-13)**: cualquier usuario del Backoffice puede pausar el bot
      (sin restricción de rol). La sesión ya trae `session.role` (`operator`/`superadmin`)
      por si en el futuro se quiere restringir a `superadmin` — sería un chequeo de 1 línea.

> **Estado (2026-07-13)**: kill switch ✅ implementado y testeado en **ambas superficies**
> — canales (WhatsApp/IG/Messenger, persiste sin responder) y widget del portal (503
> `bot_disabled`). ai-api en verde (307 tests), typecheck CRM ok. Falta: UI del widget
> para el `bot_disabled` (repo ai-widget) y la decisión de permisos. Aún no probado en un
> entorno corriendo (solo tests) — ver §5 game day.

## 3. Feature B — Panel de gasto del bot 🟡

Los datos ya existen; es exponerlos y mostrarlos.

> **Decisión (2026-07-13, con Ema)**: el panel de gasto/uso **va a vivir en el proyecto
> `ia-dashboard`, no en el CRM**. Por ahora se dejó implementado en el CRM pero **detrás
> de un feature flag apagado por default** (`BOT_USAGE_PANEL_ENABLED`, ver `src/lib/flags.ts`),
> para poder activarlo puntualmente y sacarlo limpio cuando migre. El endpoint de la
> ai-api (`GET /v1/inbox/usage`) queda y probablemente lo reuse ia-dashboard.

### Tareas

- [x] **ai-api**: endpoint staff `GET /v1/inbox/usage?days=N` que agrega `usage_records`
      del tenant: hoy, mes, breakdown diario y por modelo (`src/usage/summary.ts` +
      `src/routes/inbox.ts`). Fronteras de día/mes en horario AR. Test: `test/usage/summary.test.ts`.
      Verificado vivo: hoy/mes/diario/por-modelo con datos reales.
- [x] **CRM**: ruta proxy `GET /api/admin/inbox/usage` + `getUsageSummary` en `inbox-api.ts`.
- [x] **CRM**: página "Uso del bot" (`/admin/uso` + `UsagePanel.tsx`): tiles hoy/mes,
      selector de rango, mini-gráfico diario, desglose por modelo. **Gateada por flag**
      (`botUsagePanelEnabled`) y solo superadmin.
- [ ] **platform**: documentar el endpoint en `contracts/crm-ai-api.md`. ← pendiente
- [ ] **ia-dashboard**: migrar el panel a ese proyecto (consumiendo el mismo endpoint). ← futuro

### Protecciones de costo que NO requieren código (hacer YA)

- [ ] **Spend limit + billing alert en console.anthropic.com** sobre la API key de la
      ai-api. Es el verdadero seguro contra factura sorpresa. ~5 minutos.
- [ ] Configurar `tenants.settings.limits` (`messages_per_day`, `tokens_per_month`)
      para el tenant de Central LED en la DB de prod de la ai-api. El guardrail ya
      está implementado; solo hay que setear los valores.

---

## 4. Checklist de confiabilidad (además de A y B)

### 🔴 Bloqueantes para salir

- [x] **Alertas de errores — Sentry wireado en ambos repos (2026-07-13)**, gateado por
      DSN (no-op sin la env var):
  - **ai-api**: `src/observability/sentry.ts` (`initSentry`/`captureError`/`flushSentry`).
    Init en `server.ts`; captura en el error handler 5xx (`app.ts`) y en el catch del
    **turno del bot** (`inbound.ts` — la señal "el bot se rompió"). Env: `SENTRY_DSN`.
  - **CRM**: `src/instrumentation.ts` (server, `onRequestError`) + `src/instrumentation-client.ts`
    (browser). Sin `withSentryConfig` (no toca Turbopack; build verificada OK). Env:
    `SENTRY_DSN` (server) y `NEXT_PUBLIC_SENTRY_DSN` (cliente).
  - **Pendiente (acción del usuario)**: crear la cuenta/proyecto en Sentry y cargar los
    DSN en las envs de prod (Vercel + Railway). Hasta entonces no reporta nada.
  - Complemento barato futuro: badge en el admin de "mensajes no entregados" (los
    `'failed'` ya están en `channel_messages`).
- [ ] **WhatsApp real de Meta** (hoy la cuenta de Central LED es sandbox, `isTest=true`):
  - [ ] App de Meta en modo **Live** (no development).
  - [ ] Número real verificado + display name aprobado.
  - [ ] **Token permanente de system user** (no el temporal de 24hs/60 días — expira
        en silencio y el bot deja de responder).
  - [ ] Conocer el tier inicial de mensajería (~1k conversaciones/día al arranque).
  - [ ] **Coexistence** (recomendado para Central LED): usar la **app del celular** y
        la **Cloud API sobre el MISMO número al mismo tiempo** (función de Meta desde
        mayo 2025, disponible en Argentina — solo excluye Nigeria/Sudáfrica). El bot
        vive en la API, la atención manual puede seguir desde el celu, todo se
        sincroniza al inbox. **No requiere número nuevo ni migración destructiva.**
        Limitaciones: no sincroniza grupos, edición de mensajes restringida, y los
        **templates solo se mandan desde la API/CRM** (no desde la app).
  - [ ] Validar con el BSP/proveedor cómo se comporta la ventana de 24hs / templates
        pagos cuando un humano responde desde el celu en modo Coexistence.

> **Ventana de 24hs y costo de mensajes de Meta** (adicional al costo de tokens de Claude):
> dentro de las 24hs desde el último mensaje del cliente, responder es **gratis** (el
> reloj se reinicia con cada mensaje del cliente). Pasadas las 24hs no se puede mandar
> texto libre por la API: hay que usar una **plantilla pre-aprobada, que se paga por
> mensaje** (fracciones de USD, varía por país/categoría — verificar rate card de Meta
> para Argentina). El CRM ya expone `within_window` por conversación (`inbox-api.ts`);
> falta que la UI avise "fuera de ventana → requiere plantilla". El gasto real del bot =
> tokens de Claude + mensajes de plantilla de Meta; conviene separarlos en el panel (§3).
>
> **Costos con Coexistence** (verificado): activar Coexistence **no tiene costo extra**
> de Meta. Los mensajes enviados **desde la app del celular son siempre gratis** — no
> generan ventana, no facturan, no cuentan para el uso de la API (facturación de app y
> API son independientes). Lo único pago sigue siendo la **plantilla iniciada por el
> negocio fuera de ventana, enviada por la API**. Para uso reactivo (cliente pregunta →
> le responden) el costo de Meta es ~cero; lo pago aparece solo con campañas/reenganches
> proactivos. (Costo del BSP/proveedor, si se usa uno, es aparte.)
- [ ] **Kill switch probado antes de salir** (ver game day, sección 5).

### 🟡 Importantes (primera semana)

- [ ] **Uptime monitoring**: UptimeRobot (gratis) pegándole al health de la ai-api
      (Railway) y del CRM (Vercel). Si la ai-api se cae, el bot no responde y Meta
      reintenta webhooks solo por tiempo limitado — hay que enterarse en minutos.
- [ ] **Instancia única en Railway**: la cola serial por contacto es en memoria.
      Verificar 1 réplica y cómo maneja Railway el overlap durante deploys (si la
      instancia vieja y la nueva conviven unos segundos, procesan webhooks en paralelo).
- [ ] **Backups de las DBs**: verificar retención de point-in-time restore en Neon
      (CRM) y en la DB de la ai-api. Ya hubo un incidente por una fila de tenant
      vacía en prod; con conversaciones reales, backup verificado no es opcional.
- [ ] **Env vars de prod repasadas**: `CRON_SECRET` (Vercel), `internalSecret`
      CRM↔ai-api, `aiApiUrl`/`aiTenantId` en la fila del tenant (ya pasó que estaba
      vacía), `ANTHROPIC_API_KEY`.
- [ ] **Notificaciones a operadores** al escalar un chat (revisar que
      `src/lib/notifications.ts` cubra el handoff, no solo el cron diario).

### 🟢 Deseables (iteración)

- [ ] Errores de la ai-api en el admin con estado claro (hoy varias rutas devuelven
      `ai-api error` genérico / 500).
- [ ] Marcar/reportar una respuesta mala del bot para iterar el prompt.
- [ ] Kill switch fino: por canal (WhatsApp sí, IG no) o por horario.
- [ ] Revisión del prompt del agente: que no prometa precios/plazos que no puede cumplir.
- [ ] Roles en el admin (quién puede apagar el bot / cambiar configuración).

---

## 5. Game day + runbook (medio día, antes de salir)

Ensayo de ~30 minutos con anotación de resultados:

- [ ] Apagar el bot con el kill switch → ¿los mensajes nuevos caen a la cola de
      humanos? ¿el admin lo muestra?
- [ ] Simular ai-api caída → ¿qué ve el cliente? ¿qué ve el admin? ¿llega la alerta?
- [ ] Exceder `messages_per_day` → ¿deriva a humano y avisa al cliente?
- [ ] Mandar el mismo mensaje 3 veces → ¿handoff por repetición?
- [ ] Escribir el **runbook de 1 página**: "si el bot responde mal → botón X; si no
      responde → chequear Y (UptimeRobot/Railway); si Meta rechaza webhooks → Z".
      Quien opere el inbox tiene que poder resolverlo sin desarrollador.

## 6. Rollout

- [ ] Primeros días con **alguien mirando el inbox en horario laboral** (el pase a
      `human` está a un click). Definir quién.
- [ ] Revisar el gasto diario los primeros 3-5 días (aunque sea en la consola de
      Anthropic hasta tener el panel).

---

## 7. Futuro (DIFERIDO) — Hacerse Meta Tech Provider + Embedded Signup + Coexistence

> **Decisión (2026-07-13)**: **Central LED sale con su propia cuenta de Meta (Modelo B)**,
> que es lo que el código ya soporta hoy. Hacerse Tech Provider lleva tiempo (trámites de
> Meta de semanas) y NO se pone en el camino crítico. Se sigue tramitando en paralelo,
> pero **no construimos nada del modelo de proveedor por ahora**. Esta sección queda como
> referencia para cuando se retome.
>
> Central LED se conecta a **su propia Meta App** con Coexistence (la función de
> Coexistence NO requiere ser proveedor — el propio cliente la activa en su onboarding de
> WhatsApp). O sea: Central LED mantiene su celu + bot sobre su cuenta, sin depender de que
> MyD-Org sea proveedor.

### Cambio de arquitectura: Modelo B → modelo de proveedor

| | Hoy (Modelo B) | Modelo de proveedor |
|---|---|---|
| Meta App | Una **por tenant** | **Una sola** de MyD-Org |
| Secretos | `appSecret`/`verifyToken`/`accessToken` por cuenta en `channel_accounts` | App única; **token por WABA** obtenido en el onboarding |
| Onboarding | Manual (cliente configura webhook a mano) | **Embedded Signup** (botón "Conectar WhatsApp") |
| Webhook | `/webhooks/meta/:accountId` por cuenta | Uno solo, ruteo por `phone_number_id` |
| Coexistence | — | Se ofrece dentro del flujo de Embedded Signup |

**Ventaja del código actual**: la ai-api **ya rutea por `phone_number_id`**
(`getChannelAccountByExternalId` en `src/channels/accounts.ts`), que es el primitivo del
modelo de proveedor. Es adaptar `secrets` (app-única + token por WABA) y agregar el flujo
de Embedded Signup, **no reescribir el ruteo**.

### Tareas del track (paralelo, no bloquea el resto)

- [ ] **Meta — trámites (semanas, ya iniciados)**: Business Verification de MyD-Org,
      creación de la Meta App única, **App Review** de `whatsapp_business_messaging` +
      `whatsapp_business_management`, Advanced Access, privacy policy + video de demo.
- [ ] **Embedded Signup**: implementar el flujo de onboarding en el admin (botón
      "Conectar WhatsApp" → autorización del cliente → alta automática de la
      `channel_account` con su `phone_number_id` y token).
- [ ] **Coexistence en el flujo**: configurar el Embedded Signup en modo Coexistence
      para que el cliente mantenga la app del celu (ver §4 y sus limitaciones).
- [ ] **Refactor de `channels/accounts.ts`**: `secrets` pasa de "app propia por tenant"
      a "app única + token por WABA". Mantener compatibilidad con las cuentas Modelo B
      existentes durante la transición.
- [ ] **platform**: actualizar `contracts/meta-channels.md` con el modelo de proveedor.

### Decisión tomada: Central LED en Modelo B (cuenta propia)

Central LED sale **ya en Modelo B** (su propia Meta App + Coexistence sobre su número).
Si en el futuro MyD-Org es Tech Provider, se migra el canal al Embedded Signup; la
migración es del setup de canal, no del resto del sistema (bot, inbox, kill switch,
etc. quedan igual).

> El modelo de proveedor **no es requisito** para que el bot de Central LED funcione —
> es solo para escalar a muchos clientes sin trabajo manual, y queda para después.

---

## 7. Orden de ataque sugerido

| # | Ítem | Esfuerzo | Sección |
|---|---|---|---|
| 1 | Spend limit Anthropic + límites del tenant | 15 min, hoy | §3 |
| 2 | Kill switch global (Feature A) | ~1 día | §2 |
| 3 | WhatsApp real: modo Live + token permanente | proyecto Meta (paralelo) | §4 🔴 |
| 4 | Sentry / alertas de errores | medio día | §4 🔴 |
| 5 | UptimeRobot + verificar réplicas/backups | ~1 h | §4 🟡 |
| 6 | Panel de gasto (Feature B) | ~1 día | §3 |
| 7 | Game day + runbook | medio día | §5 |
| 8 | Rollout monitoreado | primera semana | §6 |

El panel de gasto va después del kill switch a propósito: con el spend limit de
Anthropic + `limits` del tenant ya estás protegida; verlo en el admin es iteración.

## 8. Decisiones abiertas

1. **Comportamiento del kill switch en el widget del portal** (canales ya definido:
   deriva a humanos). ¿Mensaje fijo o esconder la burbuja?
2. **Permisos**: ¿cualquier operador apaga el bot o solo admin?
3. **Valores concretos de `limits`** para Central LED (¿cuántos mensajes/día y
   tokens/mes son razonables para su volumen?).
