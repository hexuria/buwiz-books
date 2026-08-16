/**
 * The `.ob-*` stylesheet shared by /onboarding and /create-organization.
 *
 * Both routes are the same thing — a glass card on a gradient, with the same form, the same
 * inputs and the same success panel — and both used to carry their own copy of these rules.
 *
 * These class names are UNSCOPED GLOBALS injected as a plain <style> element. That was already
 * true of the two copies this module replaces, and they never collided because the two routes
 * cannot co-render: /onboarding is in SIDEBARLESS_ROUTES (__root.tsx) so it replaces the shell,
 * /create-organization renders inside it, and neither renders the other. Sharing one string does
 * not change that. It does make a third consumer cheap to add, and a third consumer that renders
 * *alongside* either of these — a modal, a nested layout — would restyle it. If that comes up,
 * scope the names (CSS module, or a `[data-ob]` attribute selector) rather than adding a copy.
 */

/**
 * Which chrome the page sits in. This is the one difference between the two routes that is
 * real rather than accidental, and it decides two things: how tall the page is allowed to be,
 * and where the action buttons live.
 */
export type OnboardingPageChrome =
  /**
   * The page *is* the viewport — nothing above or below it, and the window is the scroller.
   * It may use viewport units, must clear the notch itself, and can pin its actions to the
   * bottom edge of the screen.
   */
  | "viewport-root"
  /**
   * The page renders inside AppSidebar's `flex-1 min-h-0 overflow-y-auto` region, beneath a
   * 56px app bar and above a bottom tab bar. A viewport unit here overflows by exactly that
   * chrome, the app bar already clears the top inset, and the bottom edge of the scroller is
   * covered by the tab bar — so nothing may be pinned to it.
   */
  | "inside-app-shell";

/** Everything that is genuinely common. Emitted first so the chrome block can win on ties. */
const SHARED_STYLES = /* css */ `
  /* ── Page paint ────────────────────────────────────────────── */
  /* The page *box* — height, padding, how the card is centred — is chrome-specific; see below. */
  .ob-page {
    display: flex;
    justify-content: center;
    background: linear-gradient(135deg, #f8fafc 0%, #fff 40%, #eef2ff 100%);
    position: relative;
    /* No overflow here. It used to be hidden, which silently clipped a card taller than the
       space available — the create form at 375px — leaving the actions unreachable. The blobs
       are already clipped by .ob-blobs. */
  }
  :root[data-theme="dark"] .ob-page,
  .dark .ob-page {
    background: linear-gradient(135deg, #0f172a 0%, #0f172a 40%, #1e1b4b 100%);
  }

  /* ── Loading spinner ───────────────────────────────────────── */
  .ob-spinner {
    width: 32px; height: 32px; border-radius: 50%;
    border: 4px solid #e2e8f0; border-top-color: #6366f1;
    animation: ob-spin 0.7s linear infinite;
  }
  .dark .ob-spinner { border-color: rgba(255,255,255,0.1); border-top-color: #6366f1; }
  .ob-spinner--small { width: 20px; height: 20px; border-width: 3px; }
  @keyframes ob-spin { to { transform: rotate(360deg); } }

  /* ── Blobs ─────────────────────────────────────────────────── */
  .ob-blobs { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
  .ob-blob {
    position: absolute; border-radius: 50%;
    filter: blur(80px); opacity: 0.5;
  }
  .ob-blob--top { top: -120px; right: -120px; width: 420px; height: 420px; background: rgba(99,102,241,0.12); }
  .ob-blob--bottom { bottom: -120px; left: -120px; width: 420px; height: 420px; background: rgba(59,130,246,0.12); }
  .ob-blob--center { top: 50%; left: 50%; transform: translate(-50%,-50%); width: 600px; height: 600px; background: rgba(99,102,241,0.05); }

  /* ── Card wrapper ──────────────────────────────────────────── */
  .ob-wrapper {
    position: relative; width: 100%; max-width: 520px; z-index: 1;
  }
  .ob-card {
    background: rgba(255,255,255,0.85);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border-radius: 20px;
    border: 1px solid #e2e8f0;
    box-shadow: 0 20px 60px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
    /* Tighter gutters at 375px so the fields keep a usable width. */
    padding: 28px 20px 24px;
  }
  .dark .ob-card {
    background: rgba(255,255,255,0.05);
    border-color: rgba(255,255,255,0.1);
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  @media (min-width: 640px) {
    .ob-card { padding: 36px 32px 28px; }
  }

  /* ── Logo ───────────────────────────────────────────────────── */
  .ob-logo-row { display: flex; justify-content: center; margin-bottom: 16px; }
  .ob-logo {
    width: 52px; height: 52px; border-radius: 14px;
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 24px rgba(99,102,241,0.3);
  }
  .ob-logo-letter { color: #fff; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }

  /* ── Step indicator ────────────────────────────────────────── */
  .ob-steps {
    display: flex; justify-content: center; gap: 8px;
    margin-bottom: 24px;
  }
  .ob-step-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #e2e8f0;
    transition: all 0.3s ease;
  }
  .dark .ob-step-dot { background: rgba(255,255,255,0.12); }
  .ob-step-dot--active {
    background: #6366f1;
    width: 24px; border-radius: 4px;
  }
  .ob-step-dot--done {
    background: #6366f1; width: 8px; border-radius: 50%;
  }

  /* ── Fade-in animation ─────────────────────────────────────── */
  @keyframes ob-fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .ob-fade-in { animation: ob-fade-in 0.35s ease-out; }
  @media (prefers-reduced-motion: reduce) {
    .ob-fade-in, .ob-success-check { animation: none; }
  }

  /* ── Header ────────────────────────────────────────────────── */
  .ob-header { text-align: center; margin-bottom: 24px; }
  .ob-title {
    font-size: 22px; font-weight: 700; letter-spacing: -0.3px;
    color: #1e293b; margin: 0 0 6px;
  }
  .dark .ob-title { color: #fff; }
  .ob-subtitle {
    font-size: 14px; color: #64748b; margin: 0; line-height: 1.5;
  }
  .dark .ob-subtitle { color: rgba(255,255,255,0.5); }
  @media (min-width: 640px) {
    .ob-subtitle { font-size: 13.5px; }
  }

  /* ── Path cards (Welcome step) ─────────────────────────────── */
  .ob-paths { display: flex; flex-direction: column; gap: 12px; }
  .ob-path-card {
    display: flex; align-items: center; gap: 12px;
    padding: 14px; border-radius: 14px;
    border: 1.5px solid #e2e8f0; background: #fff;
    cursor: pointer; transition: all 0.2s ease;
    text-align: left; width: 100%;
  }
  @media (min-width: 640px) {
    .ob-path-card { gap: 14px; padding: 16px 18px; }
  }
  .ob-path-card:hover {
    border-color: #6366f1;
    box-shadow: 0 4px 16px rgba(99,102,241,0.1);
    transform: translateY(-1px);
  }
  .dark .ob-path-card {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.1);
  }
  .dark .ob-path-card:hover {
    border-color: #6366f1;
    box-shadow: 0 4px 16px rgba(99,102,241,0.15);
  }

  .ob-path-icon {
    width: 40px; height: 40px; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  @media (min-width: 640px) {
    .ob-path-icon { width: 48px; height: 48px; }
  }
  .ob-path-icon--create {
    background: linear-gradient(135deg, rgba(99,102,241,0.12), rgba(79,70,229,0.08));
    color: #6366f1;
  }
  .ob-path-icon--join {
    background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(37,99,235,0.08));
    color: #3b82f6;
  }
  .ob-path-text { flex: 1; min-width: 0; }
  .ob-path-title {
    display: block; font-size: 15px; font-weight: 600;
    color: #1e293b; margin-bottom: 2px;
  }
  .dark .ob-path-title { color: #fff; }
  .ob-path-desc {
    display: block; font-size: 12.5px; color: #94a3b8; line-height: 1.4;
  }
  .dark .ob-path-desc { color: rgba(255,255,255,0.4); }
  .ob-path-arrow {
    color: #cbd5e1; flex-shrink: 0;
    transition: transform 0.2s ease;
  }
  .ob-path-card:hover .ob-path-arrow { transform: translateX(2px); color: #6366f1; }
  .dark .ob-path-arrow { color: rgba(255,255,255,0.2); }
  .dark .ob-path-card:hover .ob-path-arrow { color: #818cf8; }

  /* ── Form ───────────────────────────────────────────────────── */
  .ob-form { display: flex; flex-direction: column; gap: 14px; }
  .ob-field { display: flex; flex-direction: column; }
  .ob-field--half { flex: 1; min-width: 0; }
  /* Mobile-first: Industry and Currency stack, and pair up from sm. Two native selects side
     by side below 640px truncate their longest option labels. */
  .ob-row { display: flex; flex-direction: column; gap: 14px; }
  @media (min-width: 640px) {
    .ob-row { flex-direction: row; gap: 12px; }
  }
  .ob-label {
    display: block; font-size: 13px; font-weight: 600;
    color: #475569; margin-bottom: 6px; letter-spacing: 0.2px;
  }
  @media (min-width: 640px) {
    .ob-label { font-size: 12px; }
  }
  .dark .ob-label { color: rgba(255,255,255,0.5); }
  .ob-input, .ob-select {
    width: 100%; min-width: 0; padding: 12px 14px; border-radius: 12px;
    border: 1.5px solid #e2e8f0; background: #fff;
    /* 16px on phones: iOS Safari zooms the viewport on focus below that and never zooms back. */
    font-size: 16px; color: #1e293b;
    min-height: 48px;
    outline: none; transition: all 0.2s;
    box-sizing: border-box;
  }
  @media (min-width: 640px) {
    .ob-input, .ob-select { font-size: 14px; padding: 11px 14px; min-height: 0; }
  }
  .ob-input:focus, .ob-select:focus {
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
  }
  .ob-input::placeholder { color: #94a3b8; }
  .dark .ob-input, .dark .ob-select {
    background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1);
    color: #fff;
  }
  .dark .ob-input:focus, .dark .ob-select:focus {
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99,102,241,0.2);
  }
  .dark .ob-input::placeholder { color: rgba(255,255,255,0.3); }

  /* Slug composite input */
  .ob-slug-wrapper {
    display: flex; align-items: center; min-width: 0;
    border-radius: 12px; border: 1.5px solid #e2e8f0;
    background: #fff; overflow: hidden;
    transition: all 0.2s;
  }
  .ob-slug-wrapper:focus-within {
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
  }
  .dark .ob-slug-wrapper {
    background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1);
  }
  .dark .ob-slug-wrapper:focus-within {
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99,102,241,0.2);
  }
  /* The prefix is derived from VITE_APP_URL, so its width is not known at author time. Capping
     and ellipsing it keeps the editable slug usable at 375px instead of letting a long domain
     squeeze the input to nothing. The vertical padding matches the sibling input's, so the
     composite keeps one height whichever of the two is the taller box. */
  .ob-slug-prefix {
    flex: 0 1 auto; min-width: 0; max-width: 45%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 11px 4px 11px 14px;
    font-size: 14px; color: #94a3b8; font-weight: 500;
    user-select: none;
  }
  .dark .ob-slug-prefix { color: rgba(255,255,255,0.3); }
  .ob-input--slug {
    flex: 1 1 0; min-width: 0;
    border: none !important; border-radius: 0 !important;
    box-shadow: none !important; background: transparent !important;
    padding-left: 0;
  }

  .ob-hint {
    margin: 6px 0 0; font-size: 12px; color: #94a3b8; line-height: 1.4;
  }
  .dark .ob-hint { color: rgba(255,255,255,0.35); }

  /* ── Chart-of-accounts preset picker ───────────────────────── */
  .ob-preset-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 1rem 0 1.25rem;
    text-align: left;
  }
  .ob-preset-card {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    width: 100%;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--ob-border, #e2e8f0);
    border-radius: 0.75rem;
    background: transparent;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .ob-preset-card:hover {
    background: rgba(148, 163, 184, 0.08);
  }
  .ob-preset-card--active {
    border-color: #0d9488;
    background: rgba(13, 148, 136, 0.08);
  }
  .ob-preset-card__title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .ob-preset-card__badge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
    background: #0d9488;
    color: #fff;
  }
  .ob-preset-card__desc {
    font-size: 0.78rem;
    opacity: 0.75;
    line-height: 1.4;
  }
  .ob-preset-card__meta {
    font-size: 0.75rem;
    opacity: 0.55;
  }
  @media (min-width: 640px) {
    .ob-preset-card__badge { font-size: 0.62rem; }
    .ob-preset-card__meta { font-size: 0.72rem; }
  }

  /* ── Error ──────────────────────────────────────────────────── */
  .ob-error {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-radius: 10px;
    background: #fef2f2; border: 1px solid #fecaca;
    color: #dc2626; font-size: 13px; font-weight: 500;
    margin-bottom: 8px;
  }
  .dark .ob-error {
    background: rgba(220,38,38,0.1); border-color: rgba(220,38,38,0.3);
    color: #f87171;
  }

  /* ── Buttons ────────────────────────────────────────────────── */
  /* How the buttons are *arranged* belongs to .ob-actions, which is chrome-specific — so is
     the flex sizing of the buttons inside it. Everything here is the button itself. */
  .ob-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 48px; padding: 12px; border-radius: 12px; border: none;
    font-size: 15px; font-weight: 600; white-space: nowrap; cursor: pointer;
    transition: all 0.2s; outline: none;
  }
  @media (min-width: 640px) {
    .ob-btn { font-size: 14px; }
  }
  /* The touch-target floor is released at lg, not with the layout at sm: 640–1024px is tablet
     territory, which is still a thumb. Matches the min-h-11 lg:min-h-0 convention used elsewhere. */
  @media (min-width: 1024px) {
    .ob-btn { min-height: 0; }
  }
  .ob-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .ob-btn--primary {
    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
    color: #fff;
    box-shadow: 0 4px 14px rgba(99,102,241,0.35);
  }
  .ob-btn--primary:hover:not(:disabled) {
    box-shadow: 0 6px 20px rgba(99,102,241,0.45);
    transform: translateY(-1px);
  }
  .ob-btn--ghost {
    background: none; color: #64748b;
    padding: 11px 16px;
  }
  .ob-btn--ghost:hover:not(:disabled) { color: #1e293b; background: #f1f5f9; }
  .dark .ob-btn--ghost { color: rgba(255,255,255,0.5); }
  .dark .ob-btn--ghost:hover:not(:disabled) {
    color: #fff; background: rgba(255,255,255,0.06);
  }
  .ob-btn-spinner {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
    animation: ob-spin 0.7s linear infinite;
  }

  /* ── Success ────────────────────────────────────────────────── */
  /* The two routes had drifted apart here — /onboarding used a flex column with a green-gradient
     disc, /create-organization a text-align:center block with a pale mint disc and a dark-mode
     override. Both render the same four children (disc, title, subtitle, spinner), so the drift was
     accidental, not per-route. Unified on /onboarding's treatment; /create-organization's success
     screen is therefore a few px taller, uses the gradient disc in dark mode too, and gains the
     ob-pop entrance. */
  .ob-success {
    display: flex; flex-direction: column; align-items: center;
    text-align: center;
    padding: 20px 0 12px;
  }
  .ob-success-check {
    width: 64px; height: 64px; border-radius: 50%;
    background: linear-gradient(135deg, #22c55e, #16a34a);
    display: flex; align-items: center; justify-content: center;
    color: #fff; margin-bottom: 16px;
    box-shadow: 0 8px 24px rgba(34,197,94,0.3);
    animation: ob-pop 0.4s ease-out;
  }
  @keyframes ob-pop {
    0% { transform: scale(0.5); opacity: 0; }
    70% { transform: scale(1.1); }
    100% { transform: scale(1); opacity: 1; }
  }
  .ob-success-spinner { margin-top: 16px; display: flex; justify-content: center; }

  /* ── Footer ─────────────────────────────────────────────────── */
  .ob-footer {
    font-size: 0.75rem;
    color: rgba(0,0,0,0.3);
    margin-top: 0.5rem;
  }
  .dark .ob-footer { color: rgba(255,255,255,0.25); }

  .ob-signout {
    background: none;
    border: none;
    font-size: 0.8125rem;
    color: rgba(0,0,0,0.4);
    cursor: pointer;
    padding: 0.25rem 0.75rem;
    margin-top: 1rem;
    border-radius: 6px;
    transition: color 0.15s, background 0.15s;
    display: inline-flex; align-items: center;
    min-height: 44px;
  }
  @media (min-width: 1024px) {
    .ob-signout { min-height: 0; display: inline-block; }
  }
  .ob-signout:hover {
    color: #e53e3e;
    background: rgba(229, 62, 62, 0.06);
  }
  .dark .ob-signout { color: rgba(255,255,255,0.35); }
  .dark .ob-signout:hover { color: #fc8181; background: rgba(252, 129, 129, 0.08); }
`;

/**
 * The page owns the viewport. It may use dvh (not vh — mobile browser chrome makes 100vh
 * taller than the visible viewport), it is the element that has to clear the notch, and the
 * window is the scroller the action bar sticks to.
 */
const VIEWPORT_ROOT_STYLES = /* css */ `
  .ob-page {
    min-height: 100dvh;
    align-items: center;
    padding-top: calc(16px + env(safe-area-inset-top));
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
  }
  @media (min-width: 640px) {
    .ob-page {
      padding-top: 24px;
      padding-bottom: 24px;
      padding-left: 24px;
      padding-right: 24px;
    }
  }

  /* ── Actions ────────────────────────────────────────────────── */
  /* Pinned to the bottom of the viewport while the step scrolls, so the advance action is
     always in thumb reach — possible only because nothing overlays the bottom edge here.
     Bleeds to the card edge with an opaque strip: the card is translucent and content would
     otherwise read through the bar. The DOM order is Back-then-primary, so this is a plain
     row with the primary flexing to fill. */
  .ob-actions {
    display: flex; gap: 10px; justify-content: flex-end;
    margin: 20px -20px 0;
    position: sticky; bottom: 0; z-index: 2;
    padding: 12px 20px;
    padding-bottom: calc(12px + env(safe-area-inset-bottom));
    background: rgba(255,255,255,0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid #e2e8f0;
  }
  .dark .ob-actions {
    background: rgba(15,23,42,0.85);
    border-top-color: rgba(255,255,255,0.1);
  }
  .ob-actions--stacked { flex-direction: column; align-items: stretch; }
  /* The form's own submit — full width is the deliberate choice here, not a fallback. */
  .ob-actions .ob-btn--primary { flex: 1; }
  @media (min-width: 640px) {
    .ob-actions {
      position: static;
      margin: 20px 0 0;
      padding: 0;
      background: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      border-top: none;
    }
    .dark .ob-actions { background: none; }
    .ob-actions .ob-btn--primary { flex: 0 0 auto; }
  }
`;

/**
 * The page is a flex child of AppSidebar's scroll region. Growing to fill that parent is the
 * equivalent of a viewport unit that stays correct at every breakpoint; the app bar above has
 * already cleared the top inset.
 *
 * No align-items: center, deliberately — a flex item taller than a centered container overflows
 * equally top and bottom, and the top half cannot be scrolled to. This form exceeds the viewport
 * on a phone, which put the Create button out of reach. The auto margins below centre the card
 * when it fits and top-align it when it does not.
 */
const INSIDE_APP_SHELL_STYLES = /* css */ `
  .ob-page {
    flex: 1 0 auto;
    min-height: 100%;
    padding: 16px max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  }
  @media (min-width: 640px) {
    .ob-page { padding: 24px; }
  }
  .ob-wrapper { margin: auto; }
  .ob-page > .ob-spinner { margin: auto; }

  /* ── Actions ────────────────────────────────────────────────── */
  /* Not sticky: the bottom edge of this scroll region is covered by the bottom tab bar, so a
     bar pinned there would sit under it. Stacked and full-width on a phone instead — "Create
     Organization" wraps to two lines in half of a 375px card. The primary is first in the DOM
     so it stacks on top; row-reverse from sm restores the desktop order (Cancel left). */
  .ob-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 24px; }
  .ob-actions .ob-btn { flex: 0 0 auto; }
  @media (min-width: 640px) {
    .ob-actions { flex-direction: row-reverse; gap: 12px; }
    .ob-actions .ob-btn { flex: 1; }
  }
`;

/** Build the `.ob-*` sheet for a page, given the chrome it renders in. */
export function buildOnboardingStyles(chrome: OnboardingPageChrome): string {
  return (
    SHARED_STYLES + (chrome === "viewport-root" ? VIEWPORT_ROOT_STYLES : INSIDE_APP_SHELL_STYLES)
  );
}
