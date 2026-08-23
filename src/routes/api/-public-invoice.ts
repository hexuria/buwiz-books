/**
 * Public Invoice Server Functions — NO AUTH REQUIRED
 * Fetches invoice data for the public payment page.
 * Only exposes safe, read-only invoice data (no internal IDs or sensitive org info).
 * Runs on dbAdmin: there is no session, so no RLS org context can be set — this
 * path must not depend on the IS NULL policy bypass surviving the FORCE-RLS flip.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseOrgMetadata } from "../../lib/org-metadata";
import { dbAdmin } from "../../db";
import { resolveFunctionalCurrency } from "../../lib/functional-currency";
import { invoices, invoiceLineItems } from "../../db/schema/invoices";
import { parties } from "../../db/schema/parties";
import { financialAccounts } from "../../db/schema/financial-accounts";
import { organization } from "../../db/schema/auth";
import { eq, asc, and } from "drizzle-orm";

// ============================================================================
// Types
// ============================================================================

export interface PublicInvoiceLineItem {
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface PublicBankAccount {
  id: string;
  accountName: string;
  institutionName: string;
  accountNumber: string;
  routingNumber: string;
  swiftCode: string;
  iban: string;
  qrCodeUrl: string;
}

export interface PublicInvoiceData {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  status: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  notes: string | null;
  paymentTerms: string | null;
  customerName: string | null;
  /**
   * ISO 4217 code the invoice is denominated in. The pay page hard-coded USD
   * into the PayPal SDK URL and defaulted the PDF to dollars, so a peso
   * invoice was presented — and charged — in the wrong currency.
   */
  currency: string;
  lineItems: PublicInvoiceLineItem[];
  /** Org branding */
  orgName: string;
  orgLogoUrl: string;
  orgPhone: string;
  orgWebsite: string;
  orgAddressStreet: string;
  orgAddressCity: string;
  orgAddressState: string;
  orgAddressPostalCode: string;
  orgAddressCountry: string;
  /** Payment gateway configured for this org */
  paymentProvider: string;
  /** Public-safe gateway keys (safe to expose to browser) */
  stripePublishableKey: string;
  paypalClientId: string;
  paypalMode: string;
  /** Bank accounts enabled for manual payment display (show_on_payment_link = true) */
  bankAccounts: PublicBankAccount[];
}

// ============================================================================
// Schemas
// ============================================================================

const getPublicInvoiceSchema = z.object({
  invoiceId: z.string().uuid(),
});

// ============================================================================
// Get Public Invoice
// ============================================================================

/**
 * Fetch invoice data for the public payment page.
 * This is intentionally unauthenticated — anyone with the invoice ID can view it.
 * We only expose safe, customer-facing data (no internal account IDs, no org secrets).
 */
export const getPublicInvoice = createServerFn({ method: "GET" })
  .inputValidator((data) => getPublicInvoiceSchema.parse(data))
  .handler(async ({ data }) => {
    const { invoiceId } = data;

    // Fetch the invoice
    const [invoice] = await dbAdmin
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        customerId: invoices.customerId,
        organizationId: invoices.organizationId,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        status: invoices.status,
        subtotal: invoices.subtotal,
        discountAmount: invoices.discountAmount,
        taxAmount: invoices.taxAmount,
        total: invoices.total,
        amountPaid: invoices.amountPaid,
        balanceDue: invoices.balanceDue,
        notes: invoices.notes,
        paymentTerms: invoices.paymentTerms,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);

    if (!invoice) return null;

    // Status gate: a DRAFT has never been issued to anyone — the public link
    // must be indistinguishable from a nonexistent invoice. A VOIDED invoice
    // stays viewable (the customer legitimately received it) but is served
    // below with nothing due, so the page cannot ask for money.
    if (invoice.status === "draft") return null;

    // Fetch customer name
    let customerName: string | null = null;
    if (invoice.customerId) {
      const [customer] = await dbAdmin
        .select({ name: parties.name })
        .from(parties)
        .where(eq(parties.id, invoice.customerId))
        .limit(1);
      customerName = customer?.name ?? null;
    }

    // Fetch line items (only safe fields)
    const lineItems = await dbAdmin
      .select({
        description: invoiceLineItems.description,
        quantity: invoiceLineItems.quantity,
        unitPrice: invoiceLineItems.unitPrice,
        amount: invoiceLineItems.amount,
      })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId))
      .orderBy(asc(invoiceLineItems.sortOrder));

    // Fetch org branding + payment config
    const [org] = await dbAdmin
      .select({
        name: organization.name,
        metadata: organization.metadata,
      })
      .from(organization)
      .where(eq(organization.id, invoice.organizationId))
      .limit(1);

    const meta = parseOrgMetadata(org?.metadata);

    // The organization's books currency. This route runs on dbAdmin because
    // there is no session to derive an RLS context from; the lookup is scoped
    // to the invoice's own organization, which was already resolved above.
    const invoiceCurrency = await resolveFunctionalCurrency(dbAdmin, invoice.organizationId);

    // Fetch all bank accounts marked for payment display
    const bankRows = await dbAdmin
      .select({
        id: financialAccounts.id,
        accountName: financialAccounts.accountName,
        institutionName: financialAccounts.institutionName,
        accountNumber: financialAccounts.accountNumber,
        routingNumber: financialAccounts.routingNumber,
        swiftCode: financialAccounts.swiftCode,
        iban: financialAccounts.iban,
        qrCodeUrl: financialAccounts.qrCodeUrl,
      })
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.organizationId, invoice.organizationId),
          eq(financialAccounts.showOnPaymentLink, true),
          eq(financialAccounts.isActive, true),
        ),
      )
      .orderBy(asc(financialAccounts.accountName));

    const bankAccounts: PublicBankAccount[] = bankRows.map((b) => ({
      id: b.id,
      accountName: b.accountName,
      institutionName: b.institutionName ?? "",
      accountNumber: b.accountNumber ?? "",
      routingNumber: b.routingNumber ?? "",
      swiftCode: b.swiftCode ?? "",
      iban: b.iban ?? "",
      qrCodeUrl: b.qrCodeUrl ?? "",
    }));

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      status: invoice.status,
      subtotal: String(invoice.subtotal),
      discountAmount: String(invoice.discountAmount),
      taxAmount: String(invoice.taxAmount),
      total: String(invoice.total),
      amountPaid: String(invoice.amountPaid),
      // Belt over the void-time zeroing: a voided invoice NEVER shows a due
      // amount, whatever the stored column says.
      balanceDue: invoice.status === "voided" ? "0.00" : String(invoice.balanceDue),
      notes: invoice.notes,
      paymentTerms: invoice.paymentTerms,
      customerName,
      lineItems: lineItems.map((li) => ({
        description: li.description,
        quantity: String(li.quantity),
        unitPrice: String(li.unitPrice),
        amount: String(li.amount),
      })),
      currency: invoiceCurrency,
      orgName: org?.name ?? "Business",
      orgLogoUrl: meta.logoUrl ?? "",
      orgPhone: meta.phone ?? "",
      orgWebsite: meta.website ?? "",
      orgAddressStreet: meta.addressStreet ?? "",
      orgAddressCity: meta.addressCity ?? "",
      orgAddressState: meta.addressState ?? "",
      orgAddressPostalCode: meta.addressPostalCode ?? "",
      orgAddressCountry: meta.addressCountry ?? "",
      paymentProvider: meta.paymentProvider ?? "none",
      // Public-safe gateway keys — safe to return to the browser
      stripePublishableKey: meta.stripePublishableKey ?? "",
      paypalClientId: meta.paypalClientId ?? "",
      paypalMode: meta.paypalMode ?? "sandbox",
      // Bank accounts with showOnPaymentLink = true
      bankAccounts,
    } satisfies PublicInvoiceData;
  });

/**
 * Explicit view receipt. Keeping this as POST makes invoice reads cache-safe and prevents
 * link previewers/prefetchers from mutating accounting workflow state with a GET request.
 */
export const markPublicInvoiceViewed = createServerFn({ method: "POST" })
  .inputValidator((data) => getPublicInvoiceSchema.parse(data))
  .handler(async ({ data }) => {
    await dbAdmin
      .update(invoices)
      .set({ status: "viewed", updatedAt: new Date() })
      .where(and(eq(invoices.id, data.invoiceId), eq(invoices.status, "sent")));
    return { success: true };
  });
