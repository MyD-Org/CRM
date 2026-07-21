import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  numeric,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

const bytea = customType<{ data: Buffer }>({
  dataType() { return "bytea" },
})

// Config por tenant — reemplaza las variables de entorno {PREFIX}_*
export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(), // ej. "central-led"
  name: text("name").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  logoPath: text("logo_path").notNull(),
  // Credenciales Alegra — ERP del portal (clientes, facturas, pagos, catálogo, cotizaciones).
  // Auth Basic email:token. alegraMock=true usa fixtures locales hasta tener el token real.
  alegraEmail: text("alegra_email").notNull().default(""),
  alegraToken: text("alegra_token").notNull().default(""),
  alegraMock: boolean("alegra_mock").notNull().default(false),
  whatsappNumber: text("whatsapp_number").notNull().default(""),
  resendFrom: text("resend_from").notNull(),
  aiApiUrl: text("ai_api_url").notNull().default(""),
  aiApiKey: text("ai_api_key").notNull().default(""),
  aiAgentId: text("ai_agent_id").notNull().default(""),
  // UUID del tenant en la ai-api (para auth de inbox/staff)
  aiTenantId: text("ai_tenant_id").notNull().default(""),
  // Horario de atención para el mensaje de handoff automático. Ej: "Lunes a Viernes 9-18hs"
  businessHours: text("business_hours"),
  // Condiciones de pago mostradas por el agente. Ej: [{ method: "Transferencia", discount: "5%" }]
  paymentConditions: jsonb("payment_conditions").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// Operadores del backoffice — empleados que usan la sección /admin
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // 'operator': puede usar el inbox y responder mensajes
    // 'superadmin': todo lo anterior + gestión de usuarios
    role: text("role").notNull().default("operator"),
    // Departamentos del operador (multi): un operador puede atender varias áreas (ej.
    // ['ventas', 'asesoramiento-tecnico']). Slugs, mismo formato que la tabla departments.
    // Se usa para el routing automático: matchea si el depto del handoff está incluido.
    departments: text("departments").array().notNull().default(sql`'{}'::text[]`),
    // Presencia para asignación de handoff: 'available' = el operador está atendiendo y
    // puede recibir conversaciones; 'away' = no se le asignan. Distinto de "cuenta activa"
    // (passwordHash): existir ≠ estar disponible ahora. Default 'away'. Ver ADR 0006.
    availability: text("availability").notNull().default("away"),
    availabilityChangedAt: timestamp("availability_changed_at", { withTimezone: true }),
    // null mientras el usuario no haya aceptado la invitación y seteado contraseña
    passwordHash: text("password_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("admin_users_email").on(t.email)],
)

// Catálogo de departamentos por tenant — se usa como fuente única para:
// (a) el select del formulario de usuarios en el backoffice, y
// (b) el catálogo de derivación que ai-api inyecta en el agente vía /api/internal/departments.
// Los valores guardados en admin_users.departments (array) y en conversation_assignments.department
// referencian `key` (slug estable). `label` es el nombre visible y se puede renombrar
// sin migrar datos. La lista es editable por tenant (no todos tienen "Cuentas Corrientes").
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("departments_tenant_key").on(t.tenantId, t.key)],
)

// Tokens para recuperar contraseña e invitaciones (mismo flujo):
// se genera un token aleatorio, se guarda el hash SHA-256, se envía el token plano por email.
export const adminPasswordTokens = pgTable(
  "admin_password_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    type: text("type").notNull(), // 'reset' | 'invite'
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("apt_token_hash").on(t.tokenHash)],
)

// Condiciones comerciales por cliente dentro de un tenant.
// Flexxus no las almacena, por eso viven en nuestra DB.
export const clientCommercialConditions = pgTable(
  "client_commercial_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    codigocliente: text("codigocliente").notNull(),
    condicionPago: text("condicion_pago").notNull(),
    plazoDias: integer("plazo_dias").notNull().default(30),
    listaPrecios: text("lista_precios").notNull().default(""),
    descuentos: jsonb("descuentos").notNull().default([]), // { concepto, porcentaje }[]
    vendedor: jsonb("vendedor").notNull().default({}), // { nombre, telefono, email }
    transporte: jsonb("transporte").notNull().default({}), // { modalidad, observaciones }
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ccc_tenant_cliente").on(t.tenantId, t.codigocliente)],
)

// Listas de precios cargadas desde Excel (temporal hasta integrar Alegra)
// Cada lista tiene N columnas de precio (ej: "Público", "Distribuidor", "Especial")
// configuradas en priceColumns: { key: "lista1", label: "Precio público" }[]
export const priceLists = pgTable("price_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(), // ej: "Cables de acometida"
  category: text("category").notNull(), // ej: "cables-acometida"
  // [{ key: "lista1", label: "Precio público" }, ...]
  priceColumns: jsonb("price_columns").notNull().default([]),
  fileData: bytea("file_data"),
  fileName: text("file_name"),
  active: boolean("active").notNull().default(true),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// Productos parseados del Excel de lista de precios
export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priceListId: uuid("price_list_id").notNull().references(() => priceLists.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    code: text("code").notNull(),
    description: text("description").notNull(),
    // { lista1: "14341.17", lista2: "12487.55", lista3: "0.00" }
    prices: jsonb("prices").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ci_tenant_code").on(t.tenantId, t.code),
    index("ci_price_list").on(t.priceListId),
  ],
)

// ── Catálogo cacheado desde Alegra (híbrido: cache local para navegar/buscar; el
// precio/stock exacto se confirma en vivo en el momento decisivo). Ver ADR catálogo Alegra. ──

// Categorías de ítems de Alegra (espejo local). Refrescadas por la sync.
export const catalogCategories = pgTable(
  "catalog_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    alegraId: text("alegra_id").notNull(),
    name: text("name").notNull(),
    parentAlegraId: text("parent_alegra_id"), // null = categoría raíz
    status: text("status").notNull().default("active"), // 'active' | 'inactive' (stale)
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cat_tenant_alegra").on(t.tenantId, t.alegraId)],
)

// Productos de Alegra (espejo local). El precio/stock acá es un SNAPSHOT de la última sync,
// para mostrar y buscar; para el número exacto se confirma en vivo (getItemsLive). Ver ADR.
export const catalogProducts = pgTable(
  "catalog_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    alegraId: text("alegra_id").notNull(),
    code: text("code"), // = reference de Alegra (puede faltar en algunos ítems)
    name: text("name").notNull(),
    description: text("description"),
    categoryAlegraId: text("category_alegra_id"),
    // Todas las listas de precio del ítem: [{ idPriceList, name, price }] (diseño flexible)
    prices: jsonb("prices").notNull().default([]),
    stock: numeric("stock"), // snapshot de inventario
    status: text("status").notNull().default("active"), // 'active' | 'inactive' (stale/baja)
    images: jsonb("images").notNull().default([]),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cp_tenant_alegra").on(t.tenantId, t.alegraId),
    index("cp_tenant_code").on(t.tenantId, t.code),
    index("cp_tenant_category").on(t.tenantId, t.categoryAlegraId),
  ],
)

// Bitácora de cada corrida de sync (observabilidad + "última sincronización" en el admin).
export const catalogSyncLog = pgTable(
  "catalog_sync_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    trigger: text("trigger").notNull(), // 'cron' | 'manual'
    status: text("status").notNull().default("running"), // 'running' | 'ok' | 'error'
    itemsSynced: integer("items_synced").notNull().default(0),
    categoriesSynced: integer("categories_synced").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("csl_tenant_started").on(t.tenantId, t.startedAt)],
)

// Reglas de notificación por tenant (editables por SQL hasta que exista el panel)
export const notificationRules = pgTable("notification_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id)
    .unique(),
  daysBefore: jsonb("days_before").notNull().default([3, 1]), // días antes del vencimiento
  daysAfter: jsonb("days_after").notNull().default([1, 7, 15]), // días de mora
  channels: jsonb("channels").notNull().default(["email"]), // 'email' | 'whatsapp'
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// Historial de notificaciones enviadas — el unique index hace la deduplicación
export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    codigocliente: text("codigocliente").notNull(),
    facturaId: text("factura_id").notNull(),
    type: text("type").notNull(), // ej. 'before_due_3' | 'after_due_7'
    channel: text("channel").notNull(), // 'email' | 'whatsapp'
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(), // 'sent' | 'failed'
    error: text("error"),
    readAt: timestamp("read_at", { withTimezone: true }), // null = no leída
  },
  (t) => [
    index("nl_tenant_cliente_sent").on(t.tenantId, t.codigocliente, t.sentAt),
    uniqueIndex("nl_dedup").on(t.tenantId, t.codigocliente, t.facturaId, t.type, t.channel),
  ],
)

// Bitácora del copiloto: cada vez que el operador manda un mensaje que venía del "Copiar" del
// copiloto (insert-en-draft), guardamos si lo mandó tal cual o lo editó. Es la métrica que
// dispara el switch copilot → bot-first en ventas (criterio: ~80%+ as-is durante ~2 semanas).
// Ver docs/superpowers/plans/2026-07-16-copiar-a-draft.md.
export const copilotDraftEvents = pgTable(
  "copilot_draft_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    conversationId: text("conversation_id").notNull(),
    operatorId: uuid("operator_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
    // 'as-is': el operador mandó exactamente lo que el copiloto sugirió.
    // 'edited': el operador tocó el texto antes de mandar.
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cde_tenant_created").on(t.tenantId, t.createdAt)],
)

// Asignación conversación → operador, DUEÑA en el CRM (no en ai-api). Ver ADR 0006.
// El bot de ai-api solo etiqueta el departamento y deriva a humano sin dueño; el CRM
// decide y persiste acá qué operador atiende cada conversación, para que no se mezclen.
// El unique(tenant, conversation) garantiza un único operador por conversación.
export const conversationAssignments = pgTable(
  "conversation_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // conversationId es el UUID opaco de la conversación en ai-api.
    conversationId: text("conversation_id").notNull(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    // Snapshot informativo del depto al que se ruteó el handoff (viene de ai-api).
    department: text("department"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ca_tenant_conversation").on(t.tenantId, t.conversationId),
    index("ca_tenant_operator").on(t.tenantId, t.operatorId),
  ],
)

// Suscripciones Web Push de los operadores (una por browser/dispositivo). El CRM es dueño de
// las suscripciones porque los operadores son usuarios del CRM; ai-api solo dispara eventos.
// El endpoint es globalmente único (lo emite el push service del navegador), así que sirve de
// clave de deduplicación: un mismo browser re-suscribiéndose hace upsert de sus claves.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    // Datos de la PushSubscription del navegador (endpoint + claves ECDH).
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ps_endpoint").on(t.endpoint),
    index("ps_tenant_operator").on(t.tenantId, t.operatorId),
  ],
)
