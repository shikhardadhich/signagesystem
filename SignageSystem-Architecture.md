# SignageSystem (holloapp.in) — Modular Architecture
**Companion to:** SignageSystem-Understanding.md, SignageSystem-Plan.md (v1.1) · **Date:** 2 Aug 2026

---

## 1. System overview

```
                        ┌──────────────────────────────────────────┐
                        │                 Vercel                   │
                        │                                          │
  Visitor ────────────▶ │  apps/marketing      holloapp.in         │
                        │                                          │
  Owner / Manager ────▶ │  apps/admin          app.holloapp.in     │──┐
                        │                                          │  │
  TV (kiosk) ─────────▶ │  apps/display        display.holloapp.in │──┤
                        │   └─ edge-cached, read-only              │  │
  Customer phone ─────▶ │      (QR upload pages live here too)     │  │
                        └──────────────────────────────────────────┘  │
                                                                      ▼
                        ┌──────────────────────────────────────────┐
                        │                Supabase                  │
                        │  Auth · Postgres (RLS) · Storage · Edge  │
                        └──────────────────────────────────────────┘
                                          │
                     ┌────────────┬───────┴──────┬─────────────┐
                     ▼            ▼              ▼             ▼
                  Razorpay     Resend        AI providers   Weather/Rates
                  (webhooks)   (email)       (behind flags)  (module APIs)
```

Three deployables, one backend, all integrations behind adapters (§6).

---

## 2. Monorepo layout

```
signagesystem/
├── apps/
│   ├── marketing/          # Next.js, mostly static/ISR, SEO
│   ├── admin/              # Next.js, authenticated, server actions
│   └── display/            # Next.js, anonymous, edge-cached, minimal JS
├── packages/
│   ├── core/               # Domain types, entitlement rules, id generation, errors
│   ├── db/                 # Generated Supabase types + typed query/mutation helpers
│   ├── packs/              # Pack SDK + pack implementations (cafe/, jewelry/…)
│   ├── modules/            # Module SDK + module implementations (clock/, selfie-wall/…)
│   ├── ui/                 # Design tokens, shared primitives (shadcn-based)
│   ├── contracts/          # Zod schemas for every API payload (display, heartbeat, webhooks)
│   └── config/             # Shared tsconfig, eslint (incl. boundary rules), tailwind preset
├── supabase/
│   ├── migrations/         # Versioned SQL, the only way schema changes
│   ├── functions/          # Edge functions (webhooks, AI jobs, cron)
│   └── tests/              # RLS policy tests (pgTAP)
└── turbo.json
```

### Dependency rules (CI-enforced)

```
apps/marketing ─┐
apps/admin ─────┼──▶ packages/* only
apps/display ───┘
packages/packs ───▶ core, ui, contracts, modules
packages/modules ─▶ core, ui, contracts
packages/db ──────▶ core
packages/ui ──────▶ config
packages/core ────▶ (nothing internal)
```

Never: app→app, package→app, core→anything. `packages/db` is imported **only by apps/admin and edge functions** — display and marketing consume HTTP contracts, not the database. An ESLint `import/no-restricted-paths` (or `eslint-plugin-boundaries`) rule fails CI on violation.

---

## 3. The two extension seams

Modularity here means: **new industries and new add-ons ship as packages, with zero changes to apps or schema.**

### 3.1 Pack SDK (`packages/packs`)

A pack is data + two components:

```ts
interface ExperiencePack<TContent> {
  id: string;                     // "cafe"
  version: string;                // "1.2.0" — screens pin this at publish
  contentSchema: z.Schema<TContent>; // slots: branding, hero, menu, offers…
  defaultContent: TContent;       // what a fresh screen shows pre-edit
  moduleSlots: SlotSpec[];        // where modules may render (corner, ticker, takeover)
  Renderer: FC<{ content: TContent; modules: ActiveModule[]; brand: Brand }>;
  editorFields: EditorFieldSpec[];// drives the form-based editor — no custom editor code per pack
}
```

Consequences:

- The **admin editor is generic**: it renders `editorFields` against `contentSchema`. Adding Jewelry pack = new folder in `packages/packs`, a registry entry, zero admin-app changes.
- The **display app is generic**: it looks up `Renderer` by `(packId, version)` from the registry and feeds it the published content JSON.
- The **database is generic**: screen content is a JSONB column validated against `contentSchema` on write. Pack changes never require migrations.
- **Versioning:** registry keeps old renderer versions; a screen renders the version it published with until the owner accepts an upgrade.

### 3.2 Module SDK (`packages/modules`)

```ts
interface Module<TConfig> {
  id: string;                     // "selfie-wall"
  slotTypes: SlotType[];          // which pack slots it can occupy
  configSchema: z.Schema<TConfig>;
  Renderer: FC<{ config: TConfig; screenCtx: ScreenCtx }>;
  server?: {                      // optional backend needs, mounted by convention
    routes?: RouteSpec[];         // e.g. selfie upload endpoint
    jobs?: CronSpec[];            // e.g. weather refresh, selfie retention purge
  };
  billing: "free" | "addon";
}
```

Packs declare **slots**; modules declare which slots they fit. Composition happens at render time from the `screen_modules` table. Selfie Wall's upload page and moderation queue ship inside the module package; the admin app mounts module admin UI by convention (`/admin/screens/:id/modules/:moduleId`).

---

## 4. Data architecture

### Schema (ownership chain → RLS)

```
tenants ─┬─ subscriptions        (Razorpay state machine, webhook-written)
         ├─ users ── user_locations ──┐
         ├─ media                     │
         ├─ tenant_packs              │   every row carries tenant_id;
         └─ locations ◀───────────────┘   location-scoped rows also carry location_id
               └─ screens
                     ├─ screen_content_versions   (draft / published JSONB, pack_id+version)
                     ├─ screen_modules            (module_id, config JSONB, enabled)
                     ├─ screen_health             (heartbeats, rolled up)
                     └─ events                    (qr_scan, selfie_upload… append-only)
```

### RLS in one sentence per role

- **Owner:** `tenant_id = auth.tenant()` on everything.
- **Location Manager:** same, **plus** `location_id IN (select … from user_locations)` on location-scoped tables, and explicit denies on `subscriptions`, `users`.
- **Anonymous (display/upload):** no direct table access at all — served only via the display API and module routes, which use scoped service credentials and expose published data for exactly one screen ID.

Caps (10 locations, 10 screens) and "screen must have a location" are DB triggers — invariants live below the app layer.

### Content lifecycle

```
edit (admin) → draft version → validate against contentSchema → publish
   → new immutable screen_content_versions row (pack version pinned)
   → display cache purged for that publicId
```

Published versions are immutable; rollback = re-point to a previous version.

---

## 5. Display path (the reliability-critical path)

```
TV browser ──▶ display.holloapp.in/8XK4PQ
                 │  static shell, service worker
                 ▼
        GET /api/display/8XK4PQ          (contracts.DisplayPayloadV1)
                 │  edge-cached (SWR, ~30s), rate-limited, read-only
                 ▼
        { packId, packVersion, content, modules[], brand, refreshHints }
                 │
                 ▼
        Renderer from packs registry  ──▶  1920×1080 output
                 │
                 └─ service worker caches last-good payload + images
                    network down ⇒ render cached payload, never an error
```

- Heartbeat: `POST /api/heartbeat` every 60s with per-screen token (issued at pairing). Invalid token = dropped, so health can't be spoofed.
- The display app imports `contracts`, `packs`, `modules`, `ui`, `core` — **never `db`**. It could be pointed at a mock server and still run; that's the test for the boundary.
- Pairing: display root shows a short code; admin claims it → server binds publicId + issues heartbeat token → display stores both locally.

## 6. Integration adapters

Every external service sits behind an interface in `packages/core`, implemented in edge functions or server code: `PaymentProvider` (Razorpay), `Mailer` (Resend), `ImageEnhancer` / `LayoutGenerator` / `InsightEngine` (AI — each with a `null` fallback implementation so AI outage degrades to manual, per Principle 7), `RatesSource` / `WeatherSource` (module data). Swapping a provider touches one adapter, no product code.

Billing flow: Razorpay webhook → edge function (verify signature, idempotency key) → writes `subscriptions` state → app reads state. The app never computes billing truth at request time.

---

## 7. Where things run

| Concern | Runs in |
|---|---|
| Admin CRUD, editor, publish | `apps/admin` server actions → `packages/db` |
| Display payload API | `apps/display` route handler, edge runtime, cached |
| Selfie upload + moderation routes | module `server.routes`, mounted in display (upload) and admin (moderation) |
| Razorpay/AI/cron jobs | Supabase edge functions |
| Content validation | `contracts`/`packs` schemas — shared by admin (write) and display (read), so both sides agree by construction |

---

## 8. How the architecture absorbs the roadmap

| Future feature | What changes |
|---|---|
| Jewelry / Mall / Hospital packs | New folder in `packages/packs` + registry entry |
| New module (Google Reviews, Instagram) | New folder in `packages/modules` + adapter |
| Scheduling (Phase 2) | New table + a `scheduleResolver` step before the display payload is built — renderers untouched |
| Video support | New media variant type in the image pipeline + slot capability flag |
| White label | Brand already flows through every Renderer as a prop; add domain mapping in display |
| Mobile player | New `apps/player` consuming the same `DisplayPayloadV1` contract |

If a feature can't be expressed as a pack, a module, an adapter, or a new consumer of an existing contract, that's the signal to stop and revisit the architecture — not to special-case it.
