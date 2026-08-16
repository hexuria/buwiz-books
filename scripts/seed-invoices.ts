/**
 * Seed Invoices — Creates sample invoices for development/testing
 * Usage: bun seed:invoices
 */
import { db } from "../src/db";
import { invoices, invoiceLineItems } from "../src/db/schema/invoices";
import { parties } from "../src/db/schema/parties";
import { eq, sql } from "drizzle-orm";

async function seedInvoices() {
  console.log("🧾 Seeding invoices…");

  // Resolve organization ID
  const orgId =
    process.env.ORG_ID ||
    ((await db.execute(sql`SELECT id FROM organization LIMIT 1`)) as any)?.[0]?.id;
  if (!orgId) {
    console.error("❌ No organization found. Set ORG_ID or create an org first.");
    process.exit(1);
  }
  console.log(`  → Using organization: ${orgId}`);

  const [revenueAccount] = (await db.execute(
    sql`SELECT id FROM accounts WHERE organization_id = ${orgId} AND account_type = 'revenue' LIMIT 1`,
  )) as any[];

  if (!revenueAccount?.id) {
    console.error("❌ No revenue account found. Ensure COA is seeded before invoices.");
    process.exit(1);
  }
  const revenueAccountId = revenueAccount.id;

  // Find or create customers
  const existingCustomers = await db
    .select({ id: parties.id, name: parties.name })
    .from(parties)
    .where(eq(parties.partyType, "customer"));

  let customerIds: string[] = existingCustomers.map((c) => c.id);

  if (customerIds.length === 0) {
    console.log("  → Creating sample customers…");
    const sampleCustomers = [
      {
        organizationId: orgId,
        name: "Acme Corp",
        partyType: "customer" as const,
        email: "billing@acme.com",
        paymentTerms: "Net 30",
      },
      {
        organizationId: orgId,
        name: "TechStart Inc",
        partyType: "customer" as const,
        email: "ap@techstart.io",
        paymentTerms: "Net 15",
      },
      {
        organizationId: orgId,
        name: "Global Services Ltd",
        partyType: "customer" as const,
        email: "finance@globalservices.com",
        paymentTerms: "Net 45",
      },
      {
        organizationId: orgId,
        name: "Blue Ocean Media",
        partyType: "customer" as const,
        email: "accounts@blueocean.com",
        paymentTerms: "Net 30",
      },
    ];

    const created = await db.insert(parties).values(sampleCustomers).returning({ id: parties.id });
    customerIds = created.map((c) => c.id);
  }

  console.log(`  → Found ${customerIds.length} customers`);

  // Today and helper dates
  const today = new Date();
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().split("T")[0];
  };
  const daysFromNow = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().split("T")[0];
  };
  const todayStr = today.toISOString().split("T")[0];

  const sampleInvoices = [
    // Draft invoices
    {
      invoiceNumber: "INV-0001",
      customerId: customerIds[0],
      issueDate: todayStr,
      dueDate: daysFromNow(30),
      status: "draft" as const,
      subtotal: "2500.00",
      total: "2500.00",
      balanceDue: "2500.00",
      amountPaid: "0",
      paymentTerms: "Net 30",
      notes: "Website redesign project — Phase 1",
      lineItems: [
        {
          description: "Website Redesign — Discovery & Planning",
          quantity: "1",
          unitPrice: "1500.00",
          amount: "1500.00",
          sortOrder: 0,
        },
        {
          description: "UI/UX Design Mockups",
          quantity: "1",
          unitPrice: "1000.00",
          amount: "1000.00",
          sortOrder: 1,
        },
      ],
    },
    {
      invoiceNumber: "INV-0002",
      customerId: customerIds[1 % customerIds.length],
      issueDate: todayStr,
      dueDate: daysFromNow(15),
      status: "draft" as const,
      subtotal: "4800.00",
      total: "4800.00",
      balanceDue: "4800.00",
      amountPaid: "0",
      paymentTerms: "Net 15",
      notes: "Monthly retainer — February 2026",
      lineItems: [
        {
          description: "Software Development Retainer",
          quantity: "40",
          unitPrice: "120.00",
          amount: "4800.00",
          sortOrder: 0,
        },
      ],
    },
    // Sent invoices
    {
      invoiceNumber: "INV-0003",
      customerId: customerIds[2 % customerIds.length],
      issueDate: daysAgo(5),
      dueDate: daysFromNow(25),
      status: "sent" as const,
      subtotal: "8750.00",
      total: "8750.00",
      balanceDue: "8750.00",
      amountPaid: "0",
      sentAt: new Date(daysAgo(5)),
      paymentTerms: "Net 30",
      lineItems: [
        {
          description: "Enterprise API Integration",
          quantity: "1",
          unitPrice: "5000.00",
          amount: "5000.00",
          sortOrder: 0,
        },
        {
          description: "Data Migration Services",
          quantity: "1",
          unitPrice: "2500.00",
          amount: "2500.00",
          sortOrder: 1,
        },
        {
          description: "Testing & QA",
          quantity: "25",
          unitPrice: "50.00",
          amount: "1250.00",
          sortOrder: 2,
        },
      ],
    },
    // Overdue invoices
    {
      invoiceNumber: "INV-0004",
      customerId: customerIds[3 % customerIds.length],
      issueDate: daysAgo(45),
      dueDate: daysAgo(15),
      status: "overdue" as const,
      subtotal: "3200.00",
      total: "3200.00",
      balanceDue: "3200.00",
      amountPaid: "0",
      sentAt: new Date(daysAgo(44)),
      paymentTerms: "Net 30",
      lineItems: [
        {
          description: "Video Production — Product Launch",
          quantity: "1",
          unitPrice: "2400.00",
          amount: "2400.00",
          sortOrder: 0,
        },
        {
          description: "Social Media Assets",
          quantity: "8",
          unitPrice: "100.00",
          amount: "800.00",
          sortOrder: 1,
        },
      ],
    },
    // Paid invoices
    {
      invoiceNumber: "INV-0005",
      customerId: customerIds[0],
      issueDate: daysAgo(60),
      dueDate: daysAgo(30),
      status: "paid" as const,
      subtotal: "6000.00",
      total: "6000.00",
      balanceDue: "0",
      amountPaid: "6000.00",
      sentAt: new Date(daysAgo(59)),
      paidAt: new Date(daysAgo(28)),
      paymentTerms: "Net 30",
      lineItems: [
        {
          description: "Annual Support Contract",
          quantity: "1",
          unitPrice: "6000.00",
          amount: "6000.00",
          sortOrder: 0,
        },
      ],
    },
    {
      invoiceNumber: "INV-0006",
      customerId: customerIds[1 % customerIds.length],
      issueDate: daysAgo(40),
      dueDate: daysAgo(25),
      status: "paid" as const,
      subtotal: "1500.00",
      total: "1500.00",
      balanceDue: "0",
      amountPaid: "1500.00",
      sentAt: new Date(daysAgo(39)),
      paidAt: new Date(daysAgo(22)),
      paymentTerms: "Net 15",
      lineItems: [
        {
          description: "Logo Design & Branding Guidelines",
          quantity: "1",
          unitPrice: "1500.00",
          amount: "1500.00",
          sortOrder: 0,
        },
      ],
    },
  ];

  for (const inv of sampleInvoices) {
    const { lineItems: items, ...invoiceData } = inv;
    const [created] = await db
      .insert(invoices)
      .values({
        ...invoiceData,
        organizationId: orgId,
        discountAmount: "0",
        taxAmount: "0",
      })
      .returning();

    if (items.length > 0) {
      await db.insert(invoiceLineItems).values(
        items.map((item) => ({
          invoiceId: created.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount,
          sortOrder: item.sortOrder,
          revenueAccountId: revenueAccountId,
        })),
      );
    }

    console.log(`  ✓ ${invoiceData.invoiceNumber} (${invoiceData.status}) — $${invoiceData.total}`);
  }

  console.log(`\n✅ Seeded ${sampleInvoices.length} invoices with line items\n`);
  process.exit(0);
}

seedInvoices().catch((err) => {
  console.error("❌ Failed to seed invoices:", err);
  process.exit(1);
});
