/**
 * Email Service — Resend Integration
 * Provides invoice email sending via Resend SDK.
 * Supports org-level Resend API keys (overrides env variable).
 */
import { Resend } from "resend";
import { createLogger } from "@/lib/logger";

const envResendApiKey = process.env.RESEND_API_KEY;
const envMailFrom = process.env.MAIL_FROM ?? "invoices@resend.dev";
const logger = createLogger("services.email");

// Shared Resend instance for env-level key (lazy singleton)
let envResend: Resend | null = null;
function getEnvResend(): Resend | null {
  if (!envResendApiKey) return null;
  if (!envResend) envResend = new Resend(envResendApiKey);
  return envResend;
}

/**
 * Currency symbols we are confident about in a customer-facing email.
 *
 * Anything not listed falls back to the ISO code — "PHP 1,500.00" is
 * unambiguous, whereas guessing the wrong symbol is not. This template used to
 * hard-code "$", so every Philippine invoice went out denominated in dollars.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  PHP: "₱",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
};

function formatInvoiceAmount(total: string, currency: string): string {
  const code = currency.trim().toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${total}` : `${code} ${total}`;
}

// Utility to extract just the email portion from a string like "Name <email@domain.com>"
/**
 * Escape a value for interpolation into an email's HTML body. Customer and
 * organization names, memos and invoice numbers are user-controlled: a
 * vendor named `<img src=x onerror=...>` must render as text in the
 * recipient's mail client, not execute in whatever renders the HTML.
 */
export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractEmail(fromStr: string): string {
  const match = fromStr.match(/<([^>]+)>/);
  return match ? match[1].trim() : fromStr.trim();
}

export interface InvoiceEmailData {
  to: string;
  invoiceNumber: string;
  customerName: string;
  total: string;
  /**
   * ISO 4217 code the invoice is denominated in. Required: the template used
   * to hard-code a "$" prefix, so a Philippine invoice went out to the
   * customer reading "$1,500.00" for an amount that was pesos.
   */
  currency: string;
  dueDate: string;
  fromCompany: string;
  fromEmail?: string;
  subject?: string;
  memo?: string;
  /** Invoice ID used to build the payment link URL */
  invoiceId?: string;
  /** Org-level Resend API key — overrides env variable if provided */
  resendApiKey?: string;
  /** Optional PDF attachment (base64-encoded content + filename). */
  pdfAttachment?: { filename: string; content: string };
}

/**
 * Send an invoice email via Resend.
 * If an org-level API key is provided it takes precedence over the env key.
 * If no API key is available at all, logs a warning and returns success (for dev).
 */
export async function sendInvoiceEmail(
  data: InvoiceEmailData,
): Promise<{ success: boolean; messageId?: string }> {
  const subject = data.subject ?? `Invoice ${data.invoiceNumber} from ${data.fromCompany}`;
  // Symbol where we know one, ISO code otherwise — an unfamiliar code reads
  // unambiguously, a wrong symbol does not.
  const amount = formatInvoiceAmount(data.total, data.currency);

  // Resend requires the `from` address to use a verified domain.
  // Always use MAIL_FROM (verified domain) as the actual sender.
  // We extract just the email address here so we can inject the dynamic company name.
  // The user's preferred email becomes the `replyTo` so replies reach them.
  const verifiedFrom = extractEmail(envMailFrom);
  const replyTo = data.fromEmail || undefined;

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const paymentUrl = data.invoiceId ? `${appUrl}/invoices/pay/${data.invoiceId}` : "#";

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <div style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); border-radius: 12px; padding: 32px; color: white; margin-bottom: 24px;">
        <h2 style="margin: 0 0 4px; font-size: 18px; font-weight: 600;">${escapeHtml(data.fromCompany)}</h2>
        <p style="margin: 0; opacity: 0.7; font-size: 13px;">${escapeHtml(data.invoiceNumber)}</p>
      </div>

      <div style="background: #f8fafc; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
        <p style="margin: 0 0 8px; font-size: 28px; font-weight: 700; color: #1e293b;">${escapeHtml(amount)}</p>
        <p style="margin: 0; font-size: 13px; color: #64748b;">Due ${escapeHtml(data.dueDate)}</p>
      </div>

      <p style="color: #475569; line-height: 1.6;">
        Hi ${escapeHtml(data.customerName)},<br /><br />
        Please find your invoice <strong>${escapeHtml(data.invoiceNumber)}</strong> for <strong>${escapeHtml(amount)}</strong>.
        ${data.memo ? `<br /><br />${escapeHtml(data.memo)}` : ""}
      </p>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${paymentUrl}" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; text-decoration: none; padding: 14px 48px; border-radius: 8px; font-weight: 600; font-size: 15px;">
          Review &amp; Pay
        </a>
      </div>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="font-size: 12px; color: #94a3b8; text-align: center;">
        &copy; ${new Date().getFullYear()} ${escapeHtml(data.fromCompany)}
      </p>
    </div>
  `;

  // Determine which Resend instance to use: org-level key first, then env key
  let resend: Resend | null = null;
  if (data.resendApiKey) {
    resend = new Resend(data.resendApiKey);
  } else {
    resend = getEnvResend();
  }

  if (!resend) {
    // Fail loudly: returning success here would let the invoice transition to "sent"
    // (and post its A/R journal) while no email was ever delivered.
    logger.error("No Resend API key configured; cannot send invoice email", {
      invoiceNumber: data.invoiceNumber,
      to: data.to,
    });
    throw new Error(
      "Email is not configured. Add a Resend API key in organization settings (or RESEND_API_KEY) before sending invoices.",
    );
  }

  const result = await resend.emails.send({
    from: `${data.fromCompany} <${verifiedFrom}>`,
    to: data.to,
    replyTo,
    subject,
    html: htmlBody,
    ...(data.pdfAttachment
      ? {
          attachments: [
            { filename: data.pdfAttachment.filename, content: data.pdfAttachment.content },
          ],
        }
      : {}),
  });

  if (result.error) {
    logger.error("Failed to send invoice email", {
      invoiceNumber: data.invoiceNumber,
      to: data.to,
      error: result.error,
    });
    throw new Error(`Email send failed: ${result.error.message}`);
  }

  return { success: true, messageId: result.data?.id };
}

// ---------------------------------------------------------------------------
// Approver Invitation Email
// ---------------------------------------------------------------------------

export interface ApproverInviteEmailData {
  to: string;
  inviterName: string;
  workspaceName: string;
  joinUrl: string;
  /** Org-level Resend API key — overrides env variable if provided */
  resendApiKey?: string;
}

/**
 * Send an approver invitation email via Resend.
 * Subject: "You are being invited as an Approver on {workspaceName}"
 */
export async function sendApproverInviteEmail(
  data: ApproverInviteEmailData,
): Promise<{ success: boolean; messageId?: string }> {
  const subject = `You are being invited as an Approver on ${data.workspaceName}`;
  const senderEmail = extractEmail(envMailFrom);

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <div style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); border-radius: 12px; padding: 32px; color: white; margin-bottom: 24px;">
        <h2 style="margin: 0 0 4px; font-size: 18px; font-weight: 600;">${escapeHtml(data.workspaceName)}</h2>
        <p style="margin: 0; opacity: 0.7; font-size: 13px;">Approver Invitation</p>
      </div>

      <div style="background: #f8fafc; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
        <p style="margin: 0; font-size: 15px; color: #1e293b; line-height: 1.6;">
          <strong>${escapeHtml(data.inviterName)}</strong> has invited you to join
          <strong>${escapeHtml(data.workspaceName)}</strong> as a bill approver.
        </p>
      </div>

      <p style="color: #475569; line-height: 1.6; font-size: 14px;">
        As an approver you'll be able to review, approve, or reject bills before
        they are processed for payment.
      </p>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${escapeHtml(data.joinUrl)}" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; text-decoration: none; padding: 14px 48px; border-radius: 8px; font-weight: 600; font-size: 15px;">
          Accept Invitation
        </a>
      </div>

      <p style="font-size: 12px; color: #94a3b8;">
        If you didn't expect this invitation you can safely ignore this email.
      </p>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="font-size: 12px; color: #94a3b8; text-align: center;">
        &copy; ${new Date().getFullYear()} ${escapeHtml(data.workspaceName)}
      </p>
    </div>
  `;

  // Determine which Resend instance to use: org-level key first, then env key
  let resend: Resend | null = null;
  if (data.resendApiKey) {
    resend = new Resend(data.resendApiKey);
  } else {
    resend = getEnvResend();
  }

  if (!resend) {
    logger.warn("No Resend API key configured; skipping approver invite email", {
      to: data.to,
      workspaceName: data.workspaceName,
    });
    return { success: true };
  }

  const result = await resend.emails.send({
    from: `${data.workspaceName} <${senderEmail}>`,
    to: data.to,
    subject,
    html: htmlBody,
  });

  if (result.error) {
    logger.error("Failed to send approver invite email", {
      to: data.to,
      workspaceName: data.workspaceName,
      error: result.error,
    });
    throw new Error(`Email send failed: ${result.error.message}`);
  }

  return { success: true, messageId: result.data?.id };
}
