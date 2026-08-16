# Responsive & mobile UI/UX standard

Buwiz Books was built desktop-only. This document is the audit that established that, the
target patterns, and the rollout order. It is the reference for any new page: **a page is not
done until it works at 375px.**

---

## 1. Audit findings

Measured against `src/` at the time of writing (~86k lines of TSX, ~40 routes).

| Finding                                                                | Count   | Why it breaks                                                             |
| ---------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| Responsive utilities (`sm:`/`md:`/`lg:`/`xl:`) in the entire codebase  | ~290    | For comparison, a mobile-first app this size carries thousands            |
| Large files (>250 lines) with **zero** responsive utilities            | 60      | Includes every high-traffic page                                          |
| `<table>` elements with **no** `overflow-x` wrapper and **no** `min-w` | 21 / 21 | Columns squash to unreadable, or get clipped by an ancestor               |
| `grid grid-cols-12` pseudo-table rows                                  | 18      | 12 columns rendered at 375px — every cell ~26px wide                      |
| Hand-rolled modals (`fixed inset-0`), no shared primitive              | 36      | Each re-invents sizing; none adapt to viewport                            |
| Controls ≤32px tall (`h-6`/`h-7`/`h-8`)                                | 287     | Below the 44px minimum touch target                                       |
| Text at ≤11px (`text-[9px]`/`[10px]`/`[11px]`)                         | 601     | Below the 16px iOS input threshold; triggers zoom-on-focus                |
| `public/manifest.webmanifest`                                          | missing | Linked from `__root.tsx:67` → **404 on every page load**; not installable |
| Service worker / offline handling                                      | none    | No PWA capability at all                                                  |

### The clipping failure mode

The app shell is `flex h-screen overflow-hidden` ([AppSidebar.tsx:592](../../src/components/AppSidebar.tsx#L592)).
Combined with unbounded content this means overflow does **not** produce a scrollbar — it is
silently **clipped and unreachable**. A DOM probe at 375px on `/accounts` confirmed
`document.scrollWidth === clientWidth === 375` while table headers and filter text were visibly
cut off. This is worse than a horizontal scrollbar: the user cannot get to the content at all.

### Hardcoded canvas widths

Fixed pixel widths are the second systemic cause. These are not max-widths on a centered
container — they are applied to the layout itself, duplicated by copy-paste across near-identical
routes:

| Width                      | Sites                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `w-[1400px]`               | `transactions_.$transactionId`, `invoices_.draft.$invoiceId_.review`                                                                                 |
| `w-[1200px]`               | `invoices_.$invoiceId`                                                                                                                               |
| `w-[1132px]`               | `CategoryManagerLayout`, `locations`, `departments`                                                                                                  |
| `w-[1119px]` + `w-[735px]` | `entities.$entityType.$partyId`, `entities.banks_.$bankId`, `locations_.$locationId`, `departments_.$departmentId`, `accounts_/category/$categoryId` |
| `w-[1680px]`               | `inbox`                                                                                                                                              |

The `w-[1119px]` + `w-[735px]` pair appearing in five files is the same two-column detail layout
pasted five times. Fixing it once in a shared layout fixes five routes.

### Navigation

`SidebarContext` auto-collapses the sidebar to a 60px icon rail at ≤1024px and stops there. At
375px that rail is a permanent 16% of the viewport, shows **icons with no labels**, and there is
no drawer, no hamburger, and no bottom navigation. Navigation is guesswork.

`useMediaQuery` initialises to `false` and only corrects in `useEffect`, so **the first render is
always the desktop branch**. Any component that renders a mobile variant off this hook flashes the
desktop layout first.

---

## 2. Breakpoint system

Tailwind v4 defaults, used mobile-first. Write the phone layout as the base and add complexity
upward — never `max-*` variants, which invert the cascade and fight each other.

| Token  | Min width | Target                                  |
| ------ | --------- | --------------------------------------- |
| (base) | 0         | Phone portrait, 320–639px               |
| `sm:`  | 640px     | Phone landscape / small tablet portrait |
| `md:`  | 768px     | Tablet portrait                         |
| `lg:`  | 1024px    | Tablet landscape / small laptop         |
| `xl:`  | 1280px    | Desktop                                 |
| `2xl:` | 1536px    | Wide desktop                            |

**The two lines that matter most:**

- **`lg` (1024px)** — the _navigation_ boundary. Below it, the sidebar is an overlay drawer;
  at and above, it is a persistent rail/panel.
- **`md` (768px)** — the _data_ boundary. Below it, tables become cards and modals become
  sheets; at and above, tabular layout is viable.

Test at **375 / 390 / 768 / 1024 / 1280**. 375px (iPhone SE) is the floor we support.

### JS-side breakpoints

Use `useBreakpoint()` / `useIsMobile()` (`src/hooks/useBreakpoint.ts`), which are hydration-safe.
Prefer CSS variants; reach for the hook only when the two layouts cannot share a DOM tree (e.g.
mounting a drawer vs. a rail, or virtualised list vs. table).

---

## 3. Navigation & app shell

| Viewport | Pattern                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `< lg`   | Top app bar (56px) with hamburger + page title + 1 primary action. Off-canvas drawer with **labelled** items, backdrop, swipe-to-close, ESC. Bottom tab bar for the ≤5 primary destinations. |
| `≥ lg`   | Persistent sidebar, collapsible to icon rail. No top bar, no bottom bar.                                                                                                                     |

Rules:

- The drawer traps focus, locks body scroll, closes on route change, and restores focus on close.
- Bottom tab bar sits above the home indicator (`env(safe-area-inset-bottom)`).
- Never render an icon-only rail as the _sole_ navigation on a phone — icons without labels are
  unlearnable for a 20-destination app.
- Deep destinations that do not fit the tab bar live under a "More" tab, not hidden in a rail.

---

## 4. Tables — the core of this work

Accounting is tabular, so this is the highest-value section. Three strategies; pick per table by
how the data is used, not by convenience.

> **What the rollout learned.** The column-driven `DataTable` component **has been deleted**. It
> finished the rollout with zero consumers: every list surface declined it for a structural reason,
> not out of laziness — the ledger shares a grid with `AccountGroupedList` and hosts inline
> comboboxes; invoices and bills wrap rows in collapsible status groups with user-toggled column
> sets; documents needs a per-row thumbnail slot; and departments/locations render a recursive
> tree. All five hand-applied §4.1 instead, consistently. Five independent refusals for five
> different structural reasons is the answer, so the component went rather than staying as a
> tempting dead end.
>
> So treat §4.1 as a **pattern to implement**, not an API to call. Hand-applying it against your
> own row shape is the expected outcome, not a failure. What you should reuse is `TableScroll`
> (§4.2) and `RowActionsMenu` (§4.4), which every surface did adopt and which are the only two
> exports left in `src/components/ui/DataTable.tsx`. Don't rebuild the column-driven variant —
> the file's header comment records why.

### 4.1 Strategy A — Card list (default for list pages)

Below `md`, each row becomes a card. This is the right default for **browse-and-drill-in** tables:
ledger, invoices, bills, documents, entities, categories.

Design each card from an explicit field priority, decided per table:

```
┌────────────────────────────────────────┐
│ PRIMARY (identity)          AMOUNT     │  ← what the user scans for
│ SECONDARY · SECONDARY                  │  ← date, counterparty
│ [status chip]                    [⋯]   │  ← state + overflow actions
└────────────────────────────────────────┘
```

- **Primary** — the identifying field. Truncates last, never wraps to 3 lines.
- **Amount** — right-aligned, tabular numerals (`font-variant-numeric: tabular-nums`),
  never truncated. Money is why the user is here.
- **Secondary** — 2–3 fields max, middle-dot separated, `text-sm`, muted.
- **Tertiary** — omitted on mobile; available on the detail page. Do not shrink to 9px to fit.
- The whole card is one tap target to the detail view; the overflow `⋯` stops propagation.

### 4.2 Strategy B — Scroll container with pinned identity column

For **compare-across-columns** tables where the grid itself is the point: trial balance, general
ledger, financial statements, reconciliation line matching.

```html
<div class="overflow-x-auto -mx-4 px-4">
  <table class="min-w-[720px] w-full">
    …
  </table>
</div>
```

- `min-w-*` on the table is **mandatory** — without it the table squashes instead of scrolling.
- The negative-margin/padding pair lets the scroll region bleed to the screen edge while keeping
  content aligned to the page gutter.
- Pin the identity column: `sticky left-0 z-10` with an opaque background and a right border.
- Pin the header: `sticky top-0 z-20`. The intersection cell needs `z-30`.
- Add `-webkit-overflow-scrolling: touch` and a scroll shadow so the affordance is discoverable —
  a table that scrolls with no visual hint reads as truncated.

### 4.3 Strategy C — Column priority / progressive disclosure

For wide tables where some columns are genuinely optional. Tag columns `essential | high | low`
and reveal by breakpoint:

| Priority    | Shown from | Example                     |
| ----------- | ---------- | --------------------------- |
| `essential` | always     | Name, Amount                |
| `high`      | `md:`      | Date, Status                |
| `low`       | `lg:`      | Created by, Reference, Memo |

Combine with an expandable row (chevron reveals hidden fields inline) so nothing is unreachable.

### 4.4 Table rules that apply to every strategy

- **Never** render `grid-cols-12` unconditionally. Use `grid-cols-1 md:grid-cols-12`, or replace
  with the card pattern.
- Sticky headers need an opaque background — a transparent sticky header smears rows underneath.
- **Row actions**: never a row of text buttons. Below `md`, collapse to a single `⋯` that opens a
  bottom sheet with labelled, full-width, 48px actions. Destructive actions last, in red, separated.
- **Bulk selection**: checkboxes need a 44px hit area; the batch action bar becomes a fixed bottom
  bar above the safe area showing "N selected" + primary action + overflow.
- **Sorting**: the header cell is the control (44px min height). On mobile, expose sort via a
  toolbar control — a sheet with the sort fields — rather than requiring a tap on a 26px header.
- **Pagination**: replace numbered pages with "Load more"/infinite scroll below `md`; page-number
  strips overflow and the targets are tiny.
- **Empty / loading / error states** must be authored for the card layout too, not just the table.
- **Column alignment**: text left, money right, status centered — at every breakpoint.

---

## 5. Modals, sheets & overlays

Replace all 36 hand-rolled `fixed inset-0` blocks with one primitive that picks its presentation
from the viewport and the task.

| Content                                         | `< md`                 | `≥ md`                     |
| ----------------------------------------------- | ---------------------- | -------------------------- |
| Short confirm / destructive check               | Alert dialog, centered | Alert dialog, centered     |
| Choose from a list; row actions; filters; sort  | **Bottom sheet**       | Popover or centered dialog |
| Form, multi-field editor, import wizard, viewer | **Full-screen**        | Centered dialog, `max-w-*` |

Rules:

- **Full-screen on mobile** means a real screen: sticky header with a close/back affordance on the
  left, title centered or left, primary action right; body scrolls; footer actions pinned above the
  safe area and full-width.
- **Bottom sheets** get a grab handle, drag-to-dismiss, backdrop tap-to-close, and `max-h-[85dvh]`.
- Use `dvh`, never `vh` — mobile browser chrome makes `100vh` overflow. The codebase currently uses
  `h-[calc(100vh-0px)]` in `inbox.tsx`, which is exactly this bug.
- Lock body scroll while open, and **preserve scroll position** on close.
- Focus trap, ESC to close, `aria-modal`, labelled by the title, focus restored to the trigger.
- Never nest a modal in a modal on mobile — push a second full-screen layer with a back affordance.
- Sheets and full-screen modals must respect `env(safe-area-inset-*)`.

---

## 6. Actions & buttons

The user's specific observation — buttons growing instead of adapting — is a real pattern here.
`NewCategoryDropdown` renders a full-width two-line pill at 375px.

| Context                     | `< md`                              | `≥ md`                    |
| --------------------------- | ----------------------------------- | ------------------------- |
| Page primary action         | Icon button in app bar, **or** FAB  | Labelled button           |
| Page secondary actions (2+) | `⋯` overflow → bottom sheet         | Labelled buttons inline   |
| Row actions                 | `⋯` → bottom sheet                  | Icon buttons on row hover |
| Toolbar filters             | Single "Filters (2)" button → sheet | Inline chips + dropdowns  |
| Destructive                 | Inside overflow, red, last, confirm | Same                      |

Rules:

- **Minimum 44×44px hit area** for anything tappable. Use padding or a pseudo-element to reach it —
  the icon can stay 16–18px. 287 controls currently violate this.
- An icon-only button **must** have `aria-label`, and a tooltip on pointer devices.
- Never let a button stretch full-width just because its container did. Full-width is a deliberate
  choice for a form's primary submit, not a fallback.
- Buttons must not wrap to two lines. If the label does not fit, it is the wrong control — use an
  icon button.
- Keep 8px minimum between adjacent tap targets.

---

## 7. Forms & inputs

- **`font-size: 16px` minimum on every input.** iOS Safari zooms the viewport on focus for anything
  smaller, and does not zoom back out. With 601 sub-11px text instances this is a live bug.
- One column below `md`; multi-column grids only at `md:` and up.
- Labels above inputs on mobile, never beside — side labels halve the input width.
- Correct `inputmode` / `type` so the right keyboard appears: `inputmode="decimal"` for money,
  `type="email"`, `type="tel"`, `autocomplete` on identity fields.
- Sticky form footer for save/cancel above the safe area on long forms.
- Validation messages inline under the field; scroll the first error into view on submit.
- Date pickers: use a sheet on mobile, popover on desktop. A 313-line custom `DayPicker` at 375px
  needs a full-width layout, not a shrunken calendar.

---

## 8. Touch, typography & density

- Body text `text-sm` (14px) minimum on mobile; `text-xs` (12px) only for genuinely secondary
  metadata, never for values the user must read.
- Retire `text-[9px]` and `text-[10px]` on mobile entirely.
- Line length 45–75 characters — cap prose containers with `max-w-prose`.
- Increase vertical padding on mobile rows (`py-3` → `py-4`); density that works with a mouse is
  hostile to a thumb.
- Respect `prefers-reduced-motion` on sheet/drawer transitions.
- Hover-only affordances (row action buttons revealed on `group-hover`) **do not exist on touch** —
  every hover-revealed action needs a persistent mobile equivalent.

---

## 9. PWA

1. `public/manifest.webmanifest` — currently missing while linked. `name`, `short_name`,
   `start_url`, `display: standalone`, `theme_color`, `background_color`, 192/512 icons plus a
   `maskable` variant.
2. `viewport-fit=cover` in the viewport meta, and `env(safe-area-inset-*)` padding on fixed
   top/bottom chrome.
3. `theme-color` meta synced to the active light/dark theme.
4. Service worker: precache the shell, network-first for data, and an offline fallback page.
   Accounting data is authoritative server-side — **do not** cache mutations optimistically or
   attempt offline writes. Reads may be stale-while-revalidate; writes must fail loudly when offline.
5. `apple-mobile-web-app-*` meta for iOS standalone.

---

## 10. Rollout order

Ordered by (users affected × severity) ÷ cost. This is the plan as written, kept as a record —
P0.3 and P0.4 were built and then deleted unused (§10a), so do not read them as a list of what
exists today.

**P0 — foundation, unblocks everything else**

1. `useBreakpoint` hook (hydration-safe) — replaces the desktop-flashing `useMediaQuery`.
2. `Modal` / `Sheet` primitive.
3. `DataTable` primitive (card + scroll strategies).
4. `IconButton`, `ResponsiveToolbar`, `PageHeader`.
5. App shell: drawer + top bar + bottom tabs.
6. PWA manifest + safe areas.

**P1 — pages the user named, highest traffic**

7. `/inbox` — `w-[1680px]`, `100vh` bug, three-pane layout with no mobile fallback.
8. `/review-agents` — card grid + config panels.
9. `/accounts` Category Manager — `w-[1132px]`, `grid-cols-12` rows, oversized header button.
10. `/transactions` ledger — the densest table in the app.

**P2 — shared layouts (one fix, five routes)**

11. Extract the `w-[1119px]` + `w-[735px]` detail layout into a responsive `EntityDetailLayout`,
    then adopt it in the five detail routes.
12. `/locations`, `/departments` list pages (`w-[1132px]`, `grid-cols-12`).

**P3 — remaining surfaces**

13. `/invoices`, `/bills`, `/documents`, `/reconciliations`, `/financials` (statement tables →
    Strategy B with pinned first column).
14. `/organization/*` settings, `/profile`, `/onboarding`.
15. The 36 modals, migrated to the primitive.

---

## 10a. Known divergences

Recorded rather than quietly tolerated, so the next person does not mistake them for intent.

- **Between `md` and `lg` the entity detail side panel presents as a centered dialog**, not a
  sheet, because `Modal`'s mobile modes key off `useIsMobile()` (below `md`) while the docked
  column only appears at `lg`. Tablets get a dialog for what becomes a panel 256px later. The same
  divergence applies to `DayPicker`, which is a sheet below `md` and a dialog from `md` to `lg`.

Resolved in this pass, kept here only so the entries are not re-opened:

- `departments.tsx` and `locations.tsx` no longer duplicate each other. Both are now ~120-line
  config objects (paths, icons, query keys, the six server functions, 22 label strings) rendering
  `src/components/dimensions/DimensionListPage.tsx`; the mobile `FilterBar` sheet exists once.
- The `.ob-*` stylesheet is one module, `src/routes/-onboarding-styles.ts`.
  `buildOnboardingStyles(chrome)` emits the shared rules plus one of two chrome blocks —
  `"viewport-root"` for `/onboarding` (`100dvh`, safe-area padding, sticky action bar) and
  `"inside-app-shell"` for `/create-organization` (`flex: 1 0 auto`, `margin: auto` centring,
  `row-reverse` actions). The class names are still unscoped globals; a third consumer rendering
  alongside either route would restyle it, and the fix then is to scope the names, not to fork.

- The four rival mobile-filter implementations are now one. `BillFilterSheet.tsx` and the
  route-local `StatusFilterSheet` in departments/locations are deleted; bills, departments,
  locations, documents, `EntityListPage` and `InvoiceListView` all drive `FilterBar`. Each surface
  keeps its own anchored popover above `md` and mounts `FilterBar` only below it, because
  `FilterBar`'s desktop branch lays its children out inline and these toolbars are single-line.
- `AdaptiveButton`, `PageHeader`, the column-driven `DataTable` and `ConfirmDialog` are deleted —
  all four ended the rollout with zero importers. The local `PageHeader` inside `review-agents.tsx`
  is a route-private function and is unrelated. Confirms are written directly against
  `<Modal mobile="center" size="sm">`.

## 11. Definition of done

A page ships when, at **375 / 768 / 1280**:

- `document.scrollWidth === clientWidth` — no horizontal overflow or clipping.
- Every action reachable on desktop is reachable on mobile.
- No tap target below 44×44px; no input below 16px.
- Tables use one of the three declared strategies, deliberately chosen.
- Modals present per the §5 table.
- Fixed chrome respects safe-area insets.
- No hover-only affordance without a touch equivalent.
