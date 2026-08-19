# SignageSystem — Document of Understanding
**Source:** PRD v1.0 · **Domain:** `holloapp.in` · **Status:** PRD agreed; an early prototype exists (see §13) · **Date:** 2 Aug 2026

---

## 1. What we are building (in one paragraph)

A multi-tenant SaaS platform that lets a non-designer business owner turn a TV into a branded, interactive customer-facing screen in under five minutes. The user never designs anything. They pick an **Experience Pack** for their industry, drop in a logo, some product photos and a few lines of text, and the platform renders a premium display at a public URL. The differentiator is *engagement* (selfie walls, QR interactions, live rates) rather than *content management*, which is what incumbents sell.

**Positioning boundary that drives every design decision:** this is not Canva, not a template editor, not a CMS. The moment we ship a freeform canvas, we have lost the product.

---

## 2. Core domain model

```
Tenant (company)
├── Subscription / Billing
├── Users            → Owner | Location Manager
├── Brand Settings   (logo, colors, tagline)
├── Media Library    (tenant-scoped, quota'd, reusable)
├── Experience Packs (entitlements)
└── Locations  (max 10 per tenant)
      └── Screens (max 10 per location)
            ├── Experience Pack instance
            ├── Modules (enabled per screen)
            ├── Content (menu, offers, gallery)
            └── Analytics / Health
```

Invariants to enforce at the DB level, not the app level:
- Every Screen belongs to exactly one Location. No orphans.
- If a tenant has no Location at screen-creation time, a **Default Location** is created implicitly.
- 10 locations / 10 screens per location are hard caps in this release.

**Key concepts, disambiguated:**

| Term | Meaning |
|---|---|
| **Experience Pack** | The industry template that defines the *whole* screen layout and the content fields the user fills in. V1 = Cafe. One pack per screen. |
| **Module** | An optional add-on block within a screen (Selfie Wall, Gold Rate, Weather, Clock, QR Feedback). Enabled per screen, some pack-specific, some common. |
| **Location** | A physical venue. The unit of access control for Location Managers. |
| **Screen** | A rendering surface with an immutable public ID. The billing unit. |

---

## 3. Users and permissions

**Owner** — full control: company, users, billing, locations, screens, module purchases, media, analytics.

**Location Manager** — scoped to exactly one location. Can edit branding/menu, upload media, manage that location's screens, view that location's analytics. Cannot touch subscription, cannot create users, cannot see other locations.

This maps cleanly to Supabase RLS: every row carries `tenant_id`, and location-scoped tables also carry `location_id`. Policies check `tenant_id` always, and `location_id ∈ user's assigned locations` for managers. No API endpoint should ever trust a client-supplied tenant ID.

---

## 4. Critical flows

### Onboarding (target: under 5 minutes)
Register → verify email → create company → choose Experience Pack (Cafe) → company name + logo + tagline → create first Location → **default Screen auto-created** → upload menu images → Publish → live URL issued → screen running.

The "under 5 minutes" target is a real constraint, not a marketing line. It rules out: a step where the user picks a layout, a step where the user configures modules, and any blocking AI call.

### Screen URL
Immutable short IDs only: `display.holloapp.in/8XK4PQ` (or `holloapp.in/display/8XK4PQ`). Never `/cafe/location/screen`. Names change, IDs must not. This also avoids leaking tenant structure publicly.

### Clone Screen
Duplicate an existing screen's config, reassign to another location, edit the differences. This is the main multi-location scaling path and should be first-class, not an afterthought.

### Trial
1 free screen, 7 days. **The clock starts on first Publish**, not on signup — so a user exploring the admin portal doesn't burn trial days. Needs an explicit `trial_started_at` set at publish time, plus a defined post-expiry behaviour for the public display (open question, see §8).

---

## 5. Public display renderer

- Target resolution 1920×1080, auto-refresh, **no authentication**.
- Stateless and cache-friendly by design — the display should keep working through backend hiccups.
- Screen health telemetry flows the other way: online/offline, last seen, browser, resolution, internet status.

This is the component with the highest reliability bar in the whole system. A cafe's TV showing an error page during lunch rush is the worst possible failure mode.

---

## 6. Commercial model

- Subscription priced **per screen**: ₹999/mo for 1, ₹3999/mo for 5, Enterprise custom.
- Modules are optional paid add-ons enabled per screen.
- Media Library has a per-tenant storage quota.

Implication: screen count is both an entitlement check and a billing signal, so screen create/delete/publish must be transactional with the subscription state.

---

## 7. AI features (assistive, never blocking)

Menu Generator (photos → layout), Offer Generator (text → banner + colors + type + CTA), Image Enhancement (lighting, denoise, sharpening, restaurant color grading), Social Wall (auto enhance/frame/brand selfies), Weekly Insights (e.g. "Pizza Combo drove 35% more QR scans — run every Friday").

Principle #7 is the guardrail: every AI path needs a manual fallback and a timeout. If the AI is down, the user still publishes.

---

## 8. Explicitly out of scope in V1

Scheduling · video (images only) · multi-language · white-label · mobile player · remote control · POS/Reviews/Instagram integrations · heatmaps and conversion analytics.

---

## 9. Architecture

**Stack:** Next.js + TypeScript + Tailwind + shadcn/ui · Supabase (Postgres, RLS, Storage, Auth) · Vercel.

**Three logical applications, separated from day one** even if co-deployed:

| App | Domain | Character |
|---|---|---|
| Marketing site | `holloapp.in` | Static, SEO-driven, public |
| Admin portal | `app.holloapp.in` | Authenticated, stateful, mobile-first |
| Display renderer | `display.holloapp.in` | Anonymous, stateless, cached, reliability-critical |

The reasoning holds: these three have opposite requirements on auth, caching, and uptime. Merging them means the display renderer inherits the admin portal's auth middleware and deploy cadence — exactly what you don't want on a screen running in a restaurant.

---

## 10. Product principles (the decision filter)

1. No design skills required — professional screen in under 5 minutes
2. Experience over content
3. Multi-tenant by design
4. Modular — packs and modules ship without touching core
5. Mobile-first administration
6. Scalable SaaS with strict tenant isolation
7. AI-assisted, not AI-dependent

---

## 11. Open questions to resolve before build

1. **Post-trial display behaviour** — does the screen go dark, show a branded "subscription required" card, or keep running read-only? Affects churn and customer perception in-venue.
2. **Location Manager assignment** — the PRD says "one assigned location". Is that a permanent 1:1, or can an Owner reassign? Modelling it as a join table costs nothing now and avoids a migration later.
3. **Offline resilience** — what does the display do when the venue's internet drops? Last-known-good cache in the browser seems necessary given the reliability bar.
4. **Health reporting mechanism** — heartbeat polling interval, and what "offline" threshold triggers an alert (and to whom).
5. **Module purchase model** — per-screen one-time, per-screen recurring, or tenant-wide? Affects billing schema.
6. **Media quota enforcement** — hard block on upload, or soft warning? And what counts against quota after AI enhancement generates derivatives.
7. **Experience Pack versioning** — when we improve the Cafe pack, do live screens update automatically or pin to the version they were published with?
8. **Screen ID collision + guessability** — short IDs are good for cleanliness; confirm the alphabet and length give enough entropy that a public display can't be trivially enumerated.
9. **Analytics attribution** — "visitor engagement" needs a concrete definition before it can be instrumented.

---

## 12. Existing prototype ("Cafe Selfie Wall")

The `SignageSystem` repo already contains a working single-app prototype: Node/Express, Firebase + Supabase, deployed on Vercel. It proves out the core loop — TV menu board, QR selfie upload from phone, staff moderation, 15-second takeover — plus an early jewellery screen. It is genuinely useful prior art for the display renderer and the Selfie Wall module.

It differs from the PRD in ways that matter, and these are the migration items rather than bugs:

| Prototype today | PRD target |
|---|---|
| Name-based public URLs (`/<cafe>`, `/jewel`) | Immutable short IDs (`/8XK4PQ`) |
| Cafe ≈ tenant; no location layer | Tenant → Location → Screen, with caps |
| Two roles: staff (one site) / owner (all) | Owner / Location Manager, RLS-enforced |
| Hardcoded cafe + jewel screens | Experience Packs as data, modules per screen |
| Single Express app, all surfaces | Three separated apps |
| No billing, trial, or quotas | Per-screen subscription, 7-day trial, media quota |

The decision to make explicitly: **evolve the prototype or restart on Next.js/Supabase**. The PRD's stack is a rewrite of the prototype's, so "evolve" mostly means porting the display renderer's hard-won reliability behaviour (public kiosk pages, no-session displays, local-disk fallback) rather than the code itself. Two ideas in the prototype's README are worth carrying forward verbatim: displays must never show a login box, and an unknown URL should land on marketing rather than a 404.

---

## 13. What I'd sequence first

Foundations that everything else depends on, in order: tenant + auth + RLS → location/screen model with caps → media library → Cafe Experience Pack renderer → publish + public URL → trial + billing → modules → analytics → AI layer.

The Cafe pack is the whole product in V1. It should be built as the first *instance* of a pack abstraction, not as a hardcoded screen that we later try to generalize.
