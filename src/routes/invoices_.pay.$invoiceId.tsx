/**
 * Public Invoice Payment Page — /invoices/pay/$invoiceId
 * Customer-facing, no auth required. Works on all screen sizes.
 *
 * Gateway logic lives in Nitro server routes (server/routes/api/payments/)
 * — never bundled to the client. No Node.js packages imported here.
 */
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { getPublicInvoice, markPublicInvoiceViewed } from "./api/-public-invoice";
import type { PublicInvoiceData, PublicBankAccount } from "./api/-public-invoice";
import { formatCurrency } from "@/utils/format";
import { brand } from "@/config/brand";
import { usePrefersReducedMotion } from "@/hooks/useBreakpoint";

export const Route = createFileRoute("/invoices_/pay/$invoiceId")({
  component: PublicPaymentPage,
});

// ============================================================================
// Stylesheet
// ============================================================================

/**
 * This page renders outside the app shell and is written with inline `style` objects, so its
 * responsive behaviour lives here instead of in Tailwind variants. Mobile-first: the base rules
 * are the phone layout and the single `min-width: 768px` block adds the two-column desktop split.
 *
 * Expressing the split in CSS rather than in a `window.innerWidth` state also means the server
 * renders the phone layout for a phone, instead of hydrating a desktop tree and reflowing.
 */
const PAGE_STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
* { box-sizing: border-box; }

.payment-page {
  display: flex;
  flex-direction: column;
  /* dvh tracks the visible viewport once mobile browser chrome is accounted for; the vh
     declaration is the fallback for engines that drop the dvh one. */
  min-height: 100vh;
  min-height: 100dvh;
  width: 100%;
  font-family: Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
}

.payment-left { width: 100%; padding: 1.75rem 1.25rem; }
.payment-left-footer { margin-top: 1.5rem; }
.payment-org { margin-bottom: 1.75rem; }
.payment-total { font-size: 2.25rem; }

.payment-right { align-items: flex-start; padding: 1.75rem 1.25rem; }
/* Clears the pinned pay bar, so the last control is never trapped underneath it. */
.payment-right--paybar { padding-bottom: calc(env(safe-area-inset-bottom) + 6.5rem); }
.payment-heading { font-size: 1.4rem; }

/* The design's micro-labels are ~10px — below the mobile floor in §8 of the responsive
   standard. Each variant returns to its original desktop size once there is room for it. */
.payment-eyebrow,
.payment-eyebrow--xs { font-size: 0.72rem; }

/* A label and a monospace IBAN cannot share a 375px row, so they stack. */
.payment-bank-row { flex-direction: column; align-items: flex-start; gap: 4px; }
.payment-bank-label { margin-right: 0; }

.payment-paybar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #fff;
  border-top: 1px solid #e2e8f0;
  box-shadow: 0 -6px 20px rgba(15,23,42,0.08);
}

.payment-skeleton-left { min-height: 30vh; min-height: 30dvh; }

@media (min-width: 768px) {
  .payment-page { flex-direction: row; }
  .payment-left { width: 45%; min-width: 340px; padding: 2.75rem 2.5rem; }
  .payment-left-footer { margin-top: 2rem; }
  .payment-org { margin-bottom: 2.5rem; }
  .payment-total { font-size: 2.75rem; }
  .payment-right { align-items: center; padding: 3rem; }
  .payment-right--paybar { padding-bottom: 3rem; }
  .payment-heading { font-size: 1.65rem; }
  .payment-eyebrow { font-size: 0.65rem; }
  .payment-eyebrow--xs { font-size: 0.62rem; }
  .payment-bank-row { flex-direction: row; align-items: center; gap: 8px; }
  .payment-bank-label { margin-right: 12px; }
  .payment-paybar { display: none; }
  .payment-skeleton-left { min-height: 0; }
}
`;

/** Rendered by every top-level branch — the skeleton needs these rules as much as the page does. */
function PageStyles() {
  return <style>{PAGE_STYLES}</style>;
}

/** Anchor the pinned mobile pay bar scrolls to. */
const PAYMENT_SECTION_ID = "payment-methods";

// ============================================================================
// Helpers
// ============================================================================

function formatDate(dateStr: string | Date | null | undefined) {
  if (!dateStr) return "—";
  const d = typeof dateStr === "string" ? new Date(`${dateStr}T00:00:00`) : new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="touch-target"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: "0.78rem",
        fontWeight: 600,
        color: copied ? "#10b981" : "#64748b",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "2px 0",
        transition: "color 0.15s",
        flexShrink: 0,
      }}
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

// ============================================================================
// Stripe Pay Button
// ============================================================================

function StripePayButton({ invoice }: { invoice: PublicInvoiceData }) {
  const stripeMutation = useMutation({
    mutationFn: async () => {
      const origin = window.location.origin;
      const base = `${origin}/invoices/pay/${invoice.id}`;
      const res = await fetch("/api/payments/stripe-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceId: invoice.id,
          successUrl: `${base}?paid=true`,
          cancelUrl: `${base}?cancelled=true`,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ message: "Unknown error" }))) as {
          message: string;
        };
        throw new Error(err.message ?? "Failed to create checkout session");
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    },
  });

  return (
    <div>
      <button
        type="button"
        disabled={stripeMutation.isPending}
        onClick={() => stripeMutation.mutate()}
        style={{
          width: "100%",
          // minHeight, not height: a long "Pay $1,234,567.89 with Card" label wraps at 375px
          // rather than overflowing a fixed box.
          minHeight: 54,
          padding: "0.75rem 1rem",
          textAlign: "center",
          lineHeight: 1.3,
          borderRadius: 14,
          background: stripeMutation.isPending
            ? "#475569"
            : "linear-gradient(135deg,#1e293b,#334155)",
          color: "#fff",
          fontSize: "0.92rem",
          fontWeight: 700,
          border: "none",
          cursor: stripeMutation.isPending ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          transition: "all 0.2s",
          boxShadow: stripeMutation.isPending ? "none" : "0 4px 12px rgba(0,0,0,0.15)",
        }}
      >
        {stripeMutation.isPending ? (
          <>
            <SpinnerIcon />
            Redirecting to Stripe…
          </>
        ) : (
          <>
            <CardIcon />
            Pay {formatCurrency(invoice.balanceDue)} with Card
          </>
        )}
      </button>
      {stripeMutation.isError && (
        <p style={{ marginTop: 8, fontSize: "0.78rem", color: "#ef4444", textAlign: "center" }}>
          {stripeMutation.error instanceof Error
            ? stripeMutation.error.message
            : "Something went wrong. Please try again."}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// PayPal Buttons
// ============================================================================

function PayPalPayButtons({
  invoice,
  onSuccess,
}: {
  invoice: PublicInvoiceData;
  onSuccess: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [sdkLoading, setSdkLoading] = useState(true);
  const rendered = useRef(false);

  const createOrderMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/payments/paypal-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: invoice.id }),
      });
      if (!res.ok) throw new Error("Failed to create PayPal order");
      const { orderID } = (await res.json()) as { orderID: string };
      return orderID;
    },
  });

  const capturePaymentMutation = useMutation({
    mutationFn: async (orderID: string) => {
      const res = await fetch("/api/payments/paypal-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderID, invoiceId: invoice.id }),
      });
      if (!res.ok) throw new Error("Failed to capture PayPal payment");
      const result = (await res.json()) as { status: string };
      if (result.status === "COMPLETED") {
        return true;
      }
      throw new Error(`Payment status: ${result.status}. Please contact support.`);
    },
  });

  useEffect(() => {
    if (!invoice.paypalClientId) {
      setError("PayPal is not configured on this account.");
      setSdkLoading(false);
      return;
    }
    const scriptId = "paypal-sdk-script";
    const existing = document.getElementById(scriptId);
    if (existing) {
      setSdkLoading(false);
      if (!rendered.current) renderButtons();
      return;
    }
    const script = document.createElement("script");
    script.id = scriptId;
    // The invoice's own currency, not a hard-coded USD: charging a peso
    // invoice through a USD-initialised SDK bills the wrong amount.
    script.src = `https://www.paypal.com/sdk/js?client-id=${invoice.paypalClientId}&currency=${invoice.currency}`;
    script.async = true;
    script.onload = () => {
      setSdkLoading(false);
      renderButtons();
    };
    script.onerror = () => {
      setError("Failed to load PayPal SDK.");
      setSdkLoading(false);
    };
    document.body.appendChild(script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.paypalClientId, invoice.currency]);

  function renderButtons() {
    const paypal = (
      window as Window & {
        paypal?: {
          Buttons: (opts: {
            style?: Record<string, unknown>;
            createOrder: () => Promise<string>;
            onApprove: (data: { orderID: string }) => Promise<void>;
            onError?: (err: unknown) => void;
            onCancel?: () => void;
          }) => { render: (el: HTMLElement) => void };
        };
      }
    ).paypal;
    if (!paypal || !containerRef.current || rendered.current) return;
    rendered.current = true;
    containerRef.current.innerHTML = "";
    paypal
      .Buttons({
        style: { layout: "vertical", color: "gold", shape: "rect", label: "pay", height: 46 },
        createOrder: async () => {
          return await createOrderMutation.mutateAsync();
        },
        onApprove: async (data: { orderID: string }) => {
          setError(null);
          try {
            await capturePaymentMutation.mutateAsync(data.orderID);
            onSuccess();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        },
        onError: (err) => setError(`PayPal error: ${String(err)}`),
        onCancel: () => setError("Payment was cancelled. No charge was made — you can try again."),
      })
      .render(containerRef.current);
  }

  return (
    <div>
      {sdkLoading && (
        <div
          style={{
            height: 46,
            background: "#f1f5f9",
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "#64748b",
            fontSize: "0.82rem",
          }}
        >
          <SpinnerIcon />
          Loading PayPal…
        </div>
      )}
      <div ref={containerRef} />
      {error && (
        <p style={{ marginTop: 8, fontSize: "0.78rem", color: "#ef4444", textAlign: "center" }}>
          {error}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Bank Transfer Section — one card per bank account
// ============================================================================

function BankTransferSection({
  bank,
  invoiceNumber,
  invoiceTotal,
}: {
  bank: PublicBankAccount;
  invoiceNumber: string;
  invoiceTotal: string;
}) {
  const hasIban = !!bank.iban;
  const hasRouting = !!bank.routingNumber;
  const hasSwift = !!bank.swiftCode;

  return (
    <div
      style={{
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 16,
        overflow: "hidden",
        marginBottom: "1rem",
      }}
    >
      {/* Bank header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0.875rem 1rem",
          background: "#f0f9ff",
          borderBottom: "1px solid #e2e8f0",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "#e0f2fe",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <BankIcon color="#0ea5e9" size={16} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "0.88rem", fontWeight: 700, color: "#0f172a" }}>
            {bank.accountName}
          </div>
          {bank.institutionName && (
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{bank.institutionName}</div>
          )}
        </div>
      </div>

      {/* Bank row details */}
      <BankRow label="Reference / Memo" value={`INV-${invoiceNumber}`} highlight copyable />
      {bank.accountNumber && <BankRow label="Account Number" value={bank.accountNumber} copyable />}
      {hasRouting && <BankRow label="Routing Number" value={bank.routingNumber} copyable />}
      {hasSwift && <BankRow label="SWIFT / BIC" value={bank.swiftCode} copyable />}
      {hasIban && <BankRow label="IBAN" value={bank.iban} copyable />}

      {/* QR Code */}
      {bank.qrCodeUrl && (
        <div style={{ padding: "1rem", textAlign: "center", borderTop: "1px solid #e2e8f0" }}>
          <p
            className="payment-eyebrow"
            style={{
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "#94a3b8",
              marginBottom: "0.625rem",
            }}
          >
            Scan to Pay
          </p>
          <img
            src={bank.qrCodeUrl}
            alt="Bank payment QR code"
            style={{
              width: 130,
              height: 130,
              maxWidth: "100%",
              objectFit: "contain",
              borderRadius: 10,
              border: "1px solid #e2e8f0",
              padding: 6,
              background: "#fff",
            }}
          />
        </div>
      )}

      <div
        style={{
          padding: "0.625rem 1rem",
          borderTop: "1px solid #f1f5f9",
          fontSize: "0.72rem",
          color: "#94a3b8",
          textAlign: "right",
        }}
      >
        Amount: <strong style={{ color: "#0f172a" }}>{formatCurrency(invoiceTotal)}</strong>
      </div>
    </div>
  );
}

function ContactFallback({ invoice }: { invoice: PublicInvoiceData }) {
  return (
    <div
      style={{
        border: "2px dashed #e2e8f0",
        borderRadius: 16,
        padding: "1.5rem 1.25rem",
        textAlign: "center",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: "#f1f5f9",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 1rem",
        }}
      >
        <BankIcon />
      </div>
      <p style={{ fontWeight: 600, color: "#334155", marginBottom: 6, fontSize: "0.95rem" }}>
        Contact us to arrange payment
      </p>
      <p style={{ fontSize: "0.82rem", color: "#64748b", lineHeight: 1.6 }}>
        Please reach out to <strong>{invoice.orgName}</strong> directly for payment instructions.
        {invoice.orgPhone && (
          <>
            <br />📞{" "}
            <a
              href={`tel:${invoice.orgPhone}`}
              className="touch-target"
              style={{ display: "inline-block", color: "#6366f1", textDecoration: "none" }}
            >
              {invoice.orgPhone}
            </a>
          </>
        )}
        {invoice.orgWebsite && (
          <>
            <br />🌐{" "}
            <a
              href={
                invoice.orgWebsite.startsWith("http")
                  ? invoice.orgWebsite
                  : `https://${invoice.orgWebsite}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="touch-target"
              style={{
                display: "inline-block",
                color: "#6366f1",
                textDecoration: "none",
                wordBreak: "break-word",
              }}
            >
              {invoice.orgWebsite}
            </a>
          </>
        )}
      </p>
    </div>
  );
}

function BankRow({
  label,
  value,
  highlight,
  copyable,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  copyable?: boolean;
}) {
  return (
    <div
      className="payment-bank-row"
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "0.75rem 1rem",
        borderBottom: "1px solid #e2e8f0",
        background: highlight ? "#f0f9ff" : "transparent",
      }}
    >
      <span
        className="payment-bank-label"
        style={{
          fontSize: "0.78rem",
          color: "#64748b",
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        <span
          style={{
            fontSize: "0.82rem",
            color: highlight ? "#0369a1" : "#0f172a",
            fontWeight: highlight ? 700 : 600,
            fontFamily: "monospace",
            wordBreak: "break-all",
          }}
        >
          {value}
        </span>
        {copyable && value && <CopyButton text={value} label={label} />}
      </div>
    </div>
  );
}

// ============================================================================
// Payment Portal Page
// ============================================================================

function PublicPaymentPage() {
  const { invoiceId } = Route.useParams();
  const search = useSearch({ strict: false }) as { paid?: string; cancelled?: string };
  const [paypalSucceeded, setPaypalSucceeded] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  const {
    data: invoice,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["public-invoice", invoiceId],
    queryFn: () =>
      (getPublicInvoice as (opts: { data: unknown }) => Promise<PublicInvoiceData | null>)({
        data: { invoiceId },
      }),
  });

  useEffect(() => {
    if (search.paid === "true") refetch();
  }, [search.paid, refetch]);

  useEffect(() => {
    if (invoice?.status === "sent") {
      void (markPublicInvoiceViewed as (opts: { data: unknown }) => Promise<unknown>)({
        data: { invoiceId },
      });
    }
  }, [invoice?.status, invoiceId]);

  if (isLoading) return <PaymentPageSkeleton />;

  if (!invoice) {
    return (
      <div
        className="payment-page"
        style={{
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          background: "#f8fafc",
        }}
      >
        <PageStyles />
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              background: "#fef2f2",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 1.5rem",
            }}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ef4444"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#1e293b", margin: "0 0 8px" }}>
            Invoice Not Found
          </h1>
          <p style={{ color: "#64748b", margin: 0 }}>
            This invoice doesn&apos;t exist or may have been removed.
          </p>
        </div>
      </div>
    );
  }

  const isPaid = invoice.status === "paid" || paypalSucceeded;
  const isVoided = invoice.status === "voided";
  const canPay = !isPaid && !isVoided && Number(invoice.balanceDue) > 0;

  const hasStripe = invoice.paymentProvider === "stripe" || invoice.paymentProvider === "both";
  const hasPayPal = invoice.paymentProvider === "paypal" || invoice.paymentProvider === "both";
  const hasOnlineGateway = hasStripe || hasPayPal;
  const showBankSection = canPay && invoice.paymentProvider === "none";

  return (
    <div className="payment-page">
      <PageStyles />

      {/* ── LEFT PANEL: Invoice Summary ── */}
      <div
        className="payment-left"
        style={{
          flexShrink: 0,
          background: "linear-gradient(160deg,#0f172a 0%,#1e293b 100%)",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Ambient glows */}
        <div
          style={{
            position: "absolute",
            top: "-15%",
            left: "-10%",
            width: "60%",
            height: "60%",
            background: "radial-gradient(circle,rgba(99,102,241,0.18),transparent 70%)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: "-10%",
            right: "-5%",
            width: "50%",
            height: "50%",
            background: "radial-gradient(circle,rgba(14,165,233,0.1),transparent 70%)",
            pointerEvents: "none",
          }}
        />

        <div style={{ position: "relative", zIndex: 1 }}>
          {/* Org header */}
          <div
            className="payment-org"
            style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}
          >
            {invoice.orgLogoUrl ? (
              <img
                src={invoice.orgLogoUrl}
                alt={invoice.orgName}
                style={{ height: 36, maxWidth: 160, objectFit: "contain" }}
              />
            ) : (
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: "linear-gradient(135deg,#6366f1,#0ea5e9)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  fontSize: "1.1rem",
                  fontWeight: 700,
                  color: "#fff",
                }}
              >
                {invoice.orgName.charAt(0).toUpperCase()}
              </div>
            )}
            <span
              style={{
                fontSize: "1rem",
                fontWeight: 600,
                color: "#f1f5f9",
                minWidth: 0,
                overflowWrap: "anywhere",
              }}
            >
              {invoice.orgName}
            </span>
          </div>

          <p
            className="payment-eyebrow--xs"
            style={{
              textTransform: "uppercase",
              letterSpacing: "0.15em",
              color: "#64748b",
              fontWeight: 600,
              margin: "0 0 0.4rem",
            }}
          >
            Invoice Summary
          </p>

          <div
            className="payment-total tabular-figures"
            style={{
              fontWeight: 800,
              color: "#fff",
              letterSpacing: "-0.03em",
              margin: "0 0 2rem",
              lineHeight: 1.1,
            }}
          >
            {formatCurrency(invoice.total)}
          </div>

          {/* Line Items */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.875rem",
              marginBottom: "1.75rem",
            }}
          >
            {invoice.lineItems.map((item, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "0.88rem",
                      color: "#e2e8f0",
                      fontWeight: 500,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {item.description || `Item ${idx + 1}`}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: 2 }}>
                    Qty: {item.quantity}
                  </div>
                </div>
                <div
                  className="tabular-figures"
                  style={{
                    fontSize: "0.88rem",
                    color: "#e2e8f0",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatCurrency(item.amount)}
                </div>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.08)",
              paddingTop: "1.25rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.45rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "0.83rem",
                color: "#64748b",
              }}
            >
              <span>Subtotal</span>
              <span>{formatCurrency(invoice.subtotal)}</span>
            </div>
            {Number(invoice.taxAmount) > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.83rem",
                  color: "#64748b",
                }}
              >
                <span>Tax</span>
                <span>{formatCurrency(invoice.taxAmount)}</span>
              </div>
            )}
            {Number(invoice.discountAmount) > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.83rem",
                  color: "#34d399",
                }}
              >
                <span>Discount</span>
                <span>−{formatCurrency(invoice.discountAmount)}</span>
              </div>
            )}
            <div
              className="tabular-figures"
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "1rem",
                fontWeight: 700,
                color: "#fff",
                paddingTop: "0.75rem",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                marginTop: "0.25rem",
              }}
            >
              <span>Total Due</span>
              <span>{formatCurrency(invoice.total)}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          className="payment-left-footer"
          style={{
            position: "relative",
            zIndex: 1,
            borderTop: "1px solid rgba(255,255,255,0.07)",
            paddingTop: "1.25rem",
          }}
        >
          <p style={{ fontSize: "0.75rem", color: "#64748b", lineHeight: 1.7, margin: 0 }}>
            Invoice #{invoice.invoiceNumber}&nbsp;·&nbsp;Issued {formatDate(invoice.issueDate)}
            &nbsp;·&nbsp;Due {formatDate(invoice.dueDate)}
          </p>
          <button
            type="button"
            onClick={async () => {
              const { generateInvoicePdf } = await import("../lib/generate-invoice-pdf");
              generateInvoicePdf({
                currency: invoice.currency,
                invoiceNumber: invoice.invoiceNumber,
                issueDate: invoice.issueDate,
                dueDate: invoice.dueDate,
                status: invoice.status,
                orgName: invoice.orgName,
                customerName: invoice.customerName,
                lineItems: invoice.lineItems,
                subtotal: invoice.subtotal,
                discountAmount: invoice.discountAmount,
                taxAmount: invoice.taxAmount,
                total: invoice.total,
                amountPaid: invoice.amountPaid,
                balanceDue: invoice.balanceDue,
                notes: invoice.notes,
                paymentTerms: invoice.paymentTerms,
              }).save(`Invoice-${invoice.invoiceNumber}.pdf`);
            }}
            style={{
              marginTop: 4,
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
              fontSize: "0.8rem",
              color: "#94a3b8",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              textDecoration: "underline",
              padding: "4px 0",
            }}
          >
            Download PDF
          </button>
          {(invoice.orgPhone || invoice.orgWebsite) && (
            <p
              style={{
                fontSize: "0.75rem",
                color: "#475569",
                marginTop: 0,
                overflowWrap: "anywhere",
              }}
            >
              {[invoice.orgPhone, invoice.orgWebsite].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL: Payment Actions ── */}
      <div
        className={canPay ? "payment-right payment-right--paybar" : "payment-right"}
        style={{
          flex: 1,
          background: "#ffffff",
          display: "flex",
          justifyContent: "center",
          minWidth: 0,
        }}
      >
        <div style={{ width: "100%", maxWidth: 480 }}>
          {/* Cancelled banner */}
          {search.cancelled === "true" && !isPaid && (
            <div
              style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 12,
                padding: "0.875rem 1.25rem",
                marginBottom: "1.5rem",
                fontSize: "0.83rem",
                color: "#92400e",
              }}
            >
              Payment was cancelled. No charge was made — you can try again below.
            </div>
          )}

          {/* PAID */}
          {isPaid && (
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 20,
                padding: "2.5rem 2rem",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: "50%",
                  background: "#dcfce7",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 1.25rem",
                }}
              >
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#16a34a"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2
                style={{ fontSize: "1.2rem", fontWeight: 700, color: "#14532d", margin: "0 0 6px" }}
              >
                Payment Received
              </h2>
              <p style={{ fontSize: "0.875rem", color: "#15803d", margin: 0 }}>
                Thank you. {formatCurrency(invoice.total)} has been paid in full.
              </p>
            </div>
          )}

          {/* VOIDED */}
          {isVoided && (
            <div
              style={{
                background: "#fff1f2",
                border: "1px solid #fecdd3",
                borderRadius: 20,
                padding: "2rem",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "#ffe4e6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 1rem",
                }}
              >
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#e11d48"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
              </div>
              <h2
                style={{ fontSize: "1.2rem", fontWeight: 700, color: "#881337", margin: "0 0 6px" }}
              >
                Invoice Voided
              </h2>
              <p style={{ fontSize: "0.875rem", color: "#9f1239", margin: 0 }}>
                This invoice is no longer active. Please contact {invoice.orgName} for assistance.
              </p>
            </div>
          )}

          {/* PAYMENT AREA (all non-paid, non-voided) */}
          {canPay && (
            <>
              <div style={{ marginBottom: "1.75rem" }}>
                <h2
                  className="payment-heading"
                  style={{
                    fontWeight: 700,
                    color: "#0f172a",
                    letterSpacing: "-0.02em",
                    margin: "0 0 0.5rem",
                  }}
                >
                  Complete your payment
                </h2>
                <p style={{ fontSize: "0.875rem", color: "#64748b", margin: 0 }}>
                  {hasOnlineGateway
                    ? "Choose a payment method below to finalize securely."
                    : showBankSection && invoice.bankAccounts.length > 0
                      ? "Transfer directly to any of our bank accounts below."
                      : "Contact us to arrange payment."}
                </p>
              </div>

              {/* Amount chip — also the scroll target of the pinned mobile pay bar */}
              <div
                id={PAYMENT_SECTION_ID}
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 14,
                  padding: "1rem 1.25rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: "1.5rem",
                  scrollMarginTop: "1rem",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    className="payment-eyebrow--xs"
                    style={{
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "#94a3b8",
                      marginBottom: 4,
                    }}
                  >
                    Amount to Pay
                  </div>
                  <div
                    className="tabular-figures"
                    style={{ fontSize: "1.35rem", fontWeight: 800, color: "#0f172a" }}
                  >
                    {formatCurrency(invoice.balanceDue)}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    color: "#94a3b8",
                    background: "#f1f5f9",
                    padding: "4px 10px",
                    borderRadius: 8,
                    flexShrink: 0,
                  }}
                >
                  USD
                </span>
              </div>

              {/* Gateway buttons */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
                {hasStripe && <StripePayButton invoice={invoice} />}
                {hasStripe && hasPayPal && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
                    <span style={{ fontSize: "0.72rem", color: "#94a3b8", fontWeight: 500 }}>
                      or
                    </span>
                    <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
                  </div>
                )}
                {hasPayPal && (
                  <PayPalPayButtons invoice={invoice} onSuccess={() => setPaypalSucceeded(true)} />
                )}

                {/* Bank transfer (when payment provider is none) */}
                {showBankSection && (
                  <div style={{ marginTop: "0.25rem" }}>
                    {invoice.bankAccounts.length > 0 ? (
                      invoice.bankAccounts.map((bank) => (
                        <BankTransferSection
                          key={bank.id}
                          bank={bank}
                          invoiceNumber={invoice.invoiceNumber}
                          invoiceTotal={invoice.total}
                        />
                      ))
                    ) : (
                      <ContactFallback invoice={invoice} />
                    )}
                  </div>
                )}
              </div>

              {/* Security badge — only for online payments */}
              {hasOnlineGateway && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    marginTop: "1.25rem",
                    color: "#94a3b8",
                    fontSize: "0.72rem",
                    fontWeight: 500,
                  }}
                >
                  <LockIcon />
                  Secure 256-bit SSL encryption
                </div>
              )}
            </>
          )}

          {/* Customer + Terms */}
          {invoice.customerName && (
            <div
              style={{
                marginTop: "2.5rem",
                paddingTop: "1.5rem",
                borderTop: "1px solid #f1f5f9",
              }}
            >
              <div style={{ marginBottom: "1rem" }}>
                <div
                  className="payment-eyebrow"
                  style={{
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "#94a3b8",
                    marginBottom: 4,
                  }}
                >
                  Billed To
                </div>
                <div style={{ fontWeight: 600, color: "#1e293b" }}>{invoice.customerName}</div>
              </div>
              {invoice.paymentTerms && (
                <div>
                  <div
                    className="payment-eyebrow"
                    style={{
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "#94a3b8",
                      marginBottom: 4,
                    }}
                  >
                    Terms
                  </div>
                  <div style={{ fontSize: "0.875rem", color: "#334155" }}>
                    {invoice.paymentTerms}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: "2rem" }}>
            <span
              className="payment-eyebrow"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "5px 12px",
                background: "#f1f5f9",
                borderRadius: 8,
                fontWeight: 700,
                color: "#475569",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              Powered by {brand.appName}
            </span>
          </div>
        </div>
      </div>

      {/* ── Pinned mobile pay bar ──
          The invoice summary is arbitrarily long, so on a phone the pay controls can sit several
          screens down. This keeps the amount and a route to the controls on screen throughout;
          it only scrolls, it never initiates a payment. Hidden at md, where both panels are
          visible side by side. */}
      {canPay && (
        <div
          className="payment-paybar pb-safe-3"
          style={{
            paddingTop: "0.75rem",
            paddingLeft: "max(env(safe-area-inset-left), 1rem)",
            paddingRight: "max(env(safe-area-inset-right), 1rem)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              className="payment-eyebrow--xs"
              style={{
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "#94a3b8",
              }}
            >
              Amount Due
            </div>
            <div
              className="tabular-figures"
              style={{ fontSize: "1.15rem", fontWeight: 800, color: "#0f172a" }}
            >
              {formatCurrency(invoice.balanceDue)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              document.getElementById(PAYMENT_SECTION_ID)?.scrollIntoView({
                behavior: prefersReducedMotion ? "auto" : "smooth",
                block: "start",
              });
            }}
            style={{
              flexShrink: 0,
              minHeight: 48,
              padding: "0 1.25rem",
              borderRadius: 12,
              border: "none",
              background: "linear-gradient(135deg,#1e293b,#334155)",
              color: "#fff",
              fontSize: "0.95rem",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {hasOnlineGateway ? "Pay now" : "How to pay"}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Icons
// ============================================================================

function CardIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function BankIcon({ color = "#64748b", size = 18 }: { color?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="22" x2="21" y2="22" />
      <line x1="6" y1="18" x2="6" y2="11" />
      <line x1="10" y1="18" x2="10" y2="11" />
      <line x1="14" y1="18" x2="14" y2="11" />
      <line x1="18" y1="18" x2="18" y2="11" />
      <polygon points="12 2 20 7 4 7" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ animation: "spin 0.8s linear infinite" }}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </svg>
  );
}

// ============================================================================
// Skeleton
// ============================================================================

function PaymentPageSkeleton() {
  return (
    <div className="payment-page">
      <PageStyles />
      <div
        className="payment-left payment-skeleton-left"
        style={{
          flexShrink: 0,
          background: "linear-gradient(160deg,#0f172a 0%,#1e293b 100%)",
        }}
      />
      <div
        className="payment-right"
        style={{
          flex: 1,
          background: "#fff",
          display: "flex",
          justifyContent: "center",
          minWidth: 0,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 480,
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <div style={{ height: 32, width: "60%", borderRadius: 8, background: "#f1f5f9" }} />
          <div style={{ height: 18, width: "45%", borderRadius: 8, background: "#f1f5f9" }} />
          <div style={{ height: 64, borderRadius: 14, background: "#f8fafc", marginTop: 16 }} />
          <div style={{ height: 54, borderRadius: 14, background: "#f1f5f9" }} />
        </div>
      </div>
    </div>
  );
}
