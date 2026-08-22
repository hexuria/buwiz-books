/**
 * The database guarantees behind a received 2307.
 *
 * Claiming one certificate twice overstates the creditable withholding tax and
 * understates income tax due — enforced by a unique index rather than left to
 * application discipline, because the capture path will eventually be an OCR
 * pipeline and a retried upload is the obvious way to double-claim.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type postgres from "postgres";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("tax_certificates", () => {
  let sql: postgres.Sql;
  let ORG: string;

  beforeAll(async () => {
    const conn = await createTestDb();
    sql = conn.sql;
    ORG = crypto.randomUUID();
    await sql`INSERT INTO auth_organizations (id, name, slug)
              VALUES (${ORG}, 'Cert Org', ${`cert-${ORG.slice(0, 8)}`})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM tax_certificates WHERE organization_id = ${ORG}`;
    await sql`DELETE FROM auth_organizations WHERE id = ${ORG}`;
    await sql.end();
  });

  function insert(over: Record<string, unknown> = {}) {
    const row = {
      payor_tin: "123456789000",
      payor_registered_name: "ACME CORPORATION",
      certificate_number: "2307-0001",
      period_start: "2026-04-01",
      period_end: "2026-06-30",
      atc: "WC010",
      income_payment: "100000",
      tax_withheld: "10000",
      ...over,
    };
    return sql`
      INSERT INTO tax_certificates
        (organization_id, payor_tin, payor_registered_name, certificate_number,
         period_start, period_end, atc, income_payment, tax_withheld)
      VALUES (${ORG}, ${row.payor_tin as string}, ${row.payor_registered_name as string},
              ${row.certificate_number as string | null}, ${row.period_start as string},
              ${row.period_end as string}, ${row.atc as string},
              ${row.income_payment as string}, ${row.tax_withheld as string})
      RETURNING id`;
  }

  it("accepts a well-formed certificate", async () => {
    await expect(insert({ certificate_number: "OK-1" })).resolves.toBeDefined();
  });

  it("refuses the same certificate claimed twice", async () => {
    await insert({ certificate_number: "DUP-1" });
    await expect(insert({ certificate_number: "DUP-1" })).rejects.toThrow(/natural_key/);
  });

  it("allows the same number from a DIFFERENT payor", async () => {
    // Certificate numbers are only unique within an issuer.
    await insert({ certificate_number: "SHARED-1" });
    await expect(
      insert({ certificate_number: "SHARED-1", payor_tin: "999888777000" }),
    ).resolves.toBeDefined();
  });

  it("allows the same number for a different period", async () => {
    await insert({ certificate_number: "PER-1" });
    await expect(
      insert({
        certificate_number: "PER-1",
        period_start: "2026-07-01",
        period_end: "2026-09-30",
      }),
    ).resolves.toBeDefined();
  });

  it("allows several certificates with no number yet", async () => {
    // Capture before the number is known is legitimate; the partial index must
    // not make two such rows collide.
    await insert({ certificate_number: null });
    await expect(insert({ certificate_number: null })).resolves.toBeDefined();
  });

  describe("amount constraints", () => {
    it("refuses tax withheld exceeding the payment", async () => {
      await expect(
        insert({ certificate_number: "BAD-1", income_payment: "1000", tax_withheld: "5000" }),
      ).rejects.toThrow(/withheld_le_payment/);
    });

    it("refuses negative amounts", async () => {
      await expect(insert({ certificate_number: "BAD-2", tax_withheld: "-1" })).rejects.toThrow(
        /amounts_check/,
      );
    });

    it("allows a zero-tax certificate", async () => {
      // Legitimate: an exempt payee still receives a certificate.
      await expect(
        insert({ certificate_number: "ZERO-1", tax_withheld: "0" }),
      ).resolves.toBeDefined();
    });
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(
      insert({ certificate_number: "BAD-3", period_start: "2026-06-30", period_end: "2026-04-01" }),
    ).rejects.toThrow(/period_check/);
  });

  it("refuses an unknown status", async () => {
    const [row] = await insert({ certificate_number: "ST-1" });
    await expect(
      sql`UPDATE tax_certificates SET certificate_status = 'maybe' WHERE id = ${row.id}`,
    ).rejects.toThrow(/status_check/);
  });

  it("defaults a new certificate to pending, not received", async () => {
    // The honest default: the accrual is recognised when payment arrives, the
    // paper usually later. Defaulting to `received` would hide every at-risk
    // credit.
    const [row] = await insert({ certificate_number: "DEF-1" });
    const [stored] = await sql`
      SELECT certificate_status FROM tax_certificates WHERE id = ${row.id}`;
    expect(stored.certificate_status).toBe("pending");
  });
});
