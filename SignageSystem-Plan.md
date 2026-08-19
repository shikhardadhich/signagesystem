# SignageSystem (holloapp.in) — Implementation Plan
**Based on:** SignageSystem-Understanding.md · **Approach:** Fresh Next.js/Supabase build, MVP-first, milestones without dates · **v1.1 (gap review applied)** · **Date:** 2 Aug 2026

---

## Guiding decisions (locked)

- **Fresh build.** New codebase on Next.js + TypeScript + Tailwind + shadcn/ui + Supabase + Vercel. The Express prototype is reference material: we port its *behaviours* (displays never show a login box, unknown URLs land on marketing, local fallback keeps screens alive) — not its code.
- **MVP-first.** The release line is drawn after M6: a cafe owner can sign up, publish a screen, run a trial, and pay. Modules, analytics and AI land after that line.
- **Monorepo, three apps from day one:** `apps/marketing` (holloapp.in), `apps/admin` (app.holloapp.in), `apps/display` (display.holloapp.in), plus `packages/` for shared DB types, pack schemas, and UI primitives. Deployed as separate Vercel projects.
- **Cafe pack is built as the first instance of a pack abstraction** — pack definitions are data (schema of fields + layout renderer), never hardcoded screens.

## Modularity rules (enforced, not aspirational)

- **Dependency direction:** `apps/*` → `packages/*`, never app→app, never package→app. Enforced with an ESLint boundary rule in CI.
- **Package layout:** `packages/db` (generated Supabase types + query helpers), `packages/packs` (pack SDK: content schemas + renderers), `packages/ui` (shared primitives/design tokens), `packages/config` (shared tsconfig/eslint).
- **Pack SDK contract defined in M3 and treated as public API:** a pack exports `{ id, version, contentSchema (zod), Renderer, Editor fields }`. Modules export the same shape as composable blocks. If Jewelry (M10) needs a contract change, that's a versioned SDK change, not a patch.
- **Display renderer consumes a versioned, read-only JSON contract** (`GET /api/display/<publicId>` → published content + pack id/version), so the display app has zero knowledge of the database and can be cached at the edge.
- **Feature flags** (simple DB-backed) from M0, so incomplete modules/AI ship dark instead of long-lived branches.

---

## Milestone 0 — Foundations
*Everything else depends on this. No user-visible output.*

- Monorepo scaffold (Turborepo or npm workspaces), three Next.js apps, shared packages, CI (lint, typecheck, build).
- Supabase project: Auth (email + verification), Postgres, Storage buckets.
- Core schema with RLS from the first migration: `tenants`, `users`, `user_locations` (join table — resolves DoU open question #2), `locations`, `screens`, `media`, `subscriptions`, `packs`, `screen_modules`.
- Invariants in the DB: screen → exactly one location; caps of 10 locations/tenant and 10 screens/location enforced by trigger; default location auto-created.
- Screen public IDs: 6-char, unambiguous alphabet (no 0/O/1/I), ~10^9 space, generated server-side, unique index (resolves open question #8).
- Environment/config conventions, seed script with a demo tenant.
- **Environments:** local (Supabase CLI) → staging (Supabase branch + Vercel preview) → prod. All schema changes as versioned migrations; no dashboard-only changes.
- **Observability from day one:** Sentry (all three apps), structured server logs, uptime check on the display app.
- **Backups:** Supabase PITR enabled; restore procedure written down and tested once.

**Exit test:** two seeded tenants; SQL as tenant A can read nothing of tenant B; a Location Manager sees only their location's rows.

## Milestone 1 — Auth, tenancy, roles
- Register → email verify → create company (tenant) flow in `apps/admin`.
- Owner and Location Manager roles; invite flow for managers (assign locations via join table).
- Session handling, protected routes, role-aware navigation shell (mobile-first).
- Transactional email provider chosen and wired (Resend or Postmark) — verification, invites, and later billing/offline alerts all need it; don't rely on Supabase's default sender in prod.

**Exit test:** owner invites a manager; manager can only see/edit their assigned location.

## Milestone 2 — Locations, screens, media
- Location CRUD (with cap), screen CRUD (with cap, auto default location).
- Screen record: name, resolution, orientation, status, pack, public ID.
- Media library: image upload to Supabase Storage, tenant-scoped, quota tracked with **soft warning at 80%, hard block at 100%** (resolves open question #6; AI derivatives count when we get there).
- **Image pipeline:** uploads validated (type/size), stripped of EXIF, and stored with generated display variants (1080p-fit WebP) via Supabase image transforms — displays must never load raw multi-MB originals.
- Storage quota **numbers defined per pricing tier** (e.g. 1 GB/screen) — the quota exists in the PRD but had no value.
- Clone screen (config copy + reassign location) — first-class from the start.

**Exit test:** create 10 screens on a location, 11th fails cleanly; clone a screen to another location.

## Milestone 3 — Cafe Experience Pack + editor
- Pack abstraction: a pack = JSON schema of content slots (branding, hero, menu sections, today's special, offers, gallery) + a renderer component keyed by pack ID.
- Cafe pack editor in admin: fill fields, upload images from media library, live preview. No canvas, no drag-drop — form-driven only.
- Draft vs published content versions per screen.

**Exit test:** a non-designer fills the form in <5 min and preview looks premium at 1920×1080.

## Milestone 4 — Display renderer + publish
- `apps/display`: route `/<publicId>`, no auth, renders published content for the screen's pack. 1920×1080-optimized, auto-refresh via polling published-version stamp.
- **Resilience (open question #3):** service-worker/localStorage last-known-good cache — if the network drops, the screen keeps showing the last published state, never an error page. Never a login box.
- Publish action in admin → live URL issued → this is the moment `trial_started_at` is set.
- **Screen pairing UX:** nobody should type a URL on a TV remote. Display app root shows a short pairing code; owner enters it in admin to bind the screen. (The raw `/publicId` URL still works for kiosk-configured devices.)
- Screen health heartbeat: display pings every 60s with browser/resolution/online; admin shows Online/Offline/Last-seen; offline threshold 3 missed beats (resolves open question #4 — alerting deferred to M7). Heartbeat authenticated with a per-screen token issued at pairing and rate-limited, so health data can't be spoofed for any screen ID.
- Display content endpoint is read-only, edge-cached, and rate-limited; enumeration attempts on public IDs are throttled.

**Exit test:** publish, open URL on a TV browser, kill wifi for 5 minutes — screen content persists; admin shows it offline.

## Milestone 5 — Marketing site
- `apps/marketing` on holloapp.in: hero, experience-pack cards (Cafe active, others "coming soon"), features, interactive demo (a real display renderer embed of a demo tenant), pricing, FAQ, footer, register/login links.
- Unknown display IDs and stray URLs redirect here.
- **Legal pages:** Privacy Policy and Terms — required before taking payments (M6) and before anonymous selfie uploads (M7); must cover India's DPDP Act since selfies are personal data of venue customers.
- The interactive demo runs off a protected, seeded demo tenant that CI resets nightly so it can't rot or be vandalised.

## Milestone 6 — Trial + billing ⟵ **MVP release line**
- 7-day trial, 1 screen, starts at first publish. Countdown surfaced in admin.
- Payment provider: **Razorpay** (Indian market, ₹ pricing) — per-screen subscription, plan tiers ₹999/1, ₹3999/5, enterprise contact.
- Screen publish/create checks entitlements transactionally.
- **Billing is a webhook-driven state machine**, not request-time checks: Razorpay webhooks (signed, idempotent, replay-safe) move subscription state; the app only reads that state. Covers failed payments (dunning emails + grace), cancellation, and upgrades.
- **Downgrade rule defined:** if paid screens < published screens, owner chooses which screens pause; nothing is auto-deleted.
- **Trial-abuse guard:** one trial per verified email + payment-method-free trial capped at 1 screen; revisit if abuse appears (don't over-build).
- **Post-trial behaviour (open question #1): screen stays live for a 3-day grace period with a small unbranded corner notice in admin only, then the display shows the tenant's branding with a neutral "screen paused" card — never a raw error, never SignageSystem advertising in the customer's venue.** (Flagged as a product decision to confirm.)

**Exit test:** full journey — register → publish → trial expiry → pay → screen restored.

---

## Post-MVP

## Milestone 7 — Modules
- Module framework: per-screen enable/disable, module = schema + renderer block composed into the pack layout.
- Common modules first: Clock, Weather, QR Feedback. Then Cafe: Selfie Wall + Customer Gallery (port prototype's QR upload → moderation → takeover loop). Jewelry modules (Gold/Silver rate) prepare the second pack.
- **Anonymous-upload hardening (Selfie Wall):** strict file type/size validation server-side, rate limit per IP + per screen, CAPTCHA-on-abuse, moderation mandatory before display (no auto-publish path), consent notice on the upload page (DPDP), and a retention policy for uploaded selfies.
- Billing model for paid modules: tenant-wide recurring add-on (simplest; revisit per-screen later — open question #5 provisionally resolved).
- Offline alerting (email to owner) added to screen health.

## Milestone 8 — Analytics V1
- Define "visitor engagement" concretely (open question #9): QR scans + selfie uploads + module interactions, each an event row.
- Uptime from heartbeats; dashboards per screen/location; manager sees own location only.

## Milestone 9 — AI layer
- All features behind timeouts with manual fallback (Principle 7).
- Order: Image Enhancement (highest value per effort) → Offer Generator → Menu Generator → Social Wall auto-enhance → Weekly Insights.

## Milestone 10 — Second pack (Jewelry) + pack versioning
- Ship Jewelry pack to prove the abstraction; whatever core changes it forces, make before selling it.
- Pack versioning (open question #7): screens pin the version at publish; owner gets an "update available" prompt — no silent live changes.

---

## Cross-cutting workstreams

- **Security:** every table RLS'd; server actions re-validate tenant/location/role; display endpoints expose only published content for one screen ID; all public endpoints rate-limited.
- **Testing pyramid:** unit tests on pack schemas and entitlement logic; RLS policy tests in SQL; Playwright flows for onboarding/publish/trial/billing-webhook; visual snapshot of each pack at 1080p. CI gates: lint, typecheck, tests, boundary rule — nothing merges red.
- **Ways of working:** trunk-based with short-lived branches + PR review (even solo — self-review against a checklist), conventional commits, feature flags over long branches, ADR file for decisions like the ones at the bottom of this plan.
- **Performance budget (display app):** first paint < 2s on a low-end smart-TV browser, total page weight < 1.5 MB excluding images, images lazy-rotated. Measured in CI with Lighthouse.
- **Tenant data lifecycle:** account deletion path (tenant purge incl. Storage), selfie retention job, and data-export on request — needed for DPDP, cheap to build early, painful to retrofit.
- **Timezones:** every location stores its IANA timezone (matters for analytics day-bucketing now, scheduling in Phase 2).
- **Prototype harvest:** before M3, extract the prototype's board layouts, moderation UX and kiosk lessons into notes; before M7, its selfie flow.

## Dependency spine

```
M0 → M1 → M2 → M3 → M4 → M6 (MVP)
                 M5 (parallel from M2)
M4 → M7 → M8        M3 → M9        M7 → M10
```

## Decisions needing your confirmation before the relevant milestone

1. Razorpay as payment provider (M6).
2. Post-trial grace-period behaviour as specified (M6).
3. Paid modules billed tenant-wide, not per-screen (M7).
4. Manager↔location as many-to-many join table even though V1 UI only assigns one (M1).
5. Transactional email provider — Resend vs Postmark (M1).
6. Storage quota numbers per tier (M2).
7. Downgrade rule — owner picks which screens pause (M6).
8. Selfie retention period, e.g. auto-delete after 30 days (M7).
