// ============================================================================
// POST /api/payments/paypal-capture — orderID may not steer the outbound call
//
// `orderID` arrives on an unauthenticated request body and used to be
// interpolated raw into the path of a fetch carrying the merchant's PayPal
// Bearer token. WHATWG URL parsing collapses "../" and "?" truncates the
// trailing "/capture", so the caller chose which PayPal endpoint ran as that
// merchant — including /v2/payments/captures/{id}/refund.
//
// The rule these tests pin down: a malformed orderID is rejected with a 400
// before ANY database read, rate-limit bucket, or outbound request happens.
// ============================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

const { readBodyMock, getRequestIPMock, selectMock, enforceRateLimitMock } = vi.hoisted(() => ({
  readBodyMock: vi.fn(),
  getRequestIPMock: vi.fn(() => "203.0.113.1"),
  selectMock: vi.fn(() => {
    throw new Error("the invoice lookup must not run for a malformed orderID");
  }),
  enforceRateLimitMock: vi.fn(),
}));

// h3 keeps its real defineEventHandler/createError — the thrown H3Error's
// statusCode is exactly what is under test — while the two request accessors
// are stubbed, since there is no live request here.
vi.mock("h3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("h3")>();
  return { ...actual, readBody: readBodyMock, getRequestIP: getRequestIPMock };
});

vi.mock("../../../src/db", () => ({ db: { select: selectMock } }));
vi.mock("../../../src/lib/request-guards", () => ({ enforceRateLimit: enforceRateLimitMock }));

import handler from "../../../server/routes/api/payments/paypal-capture.post";

const INVOICE_ID = "11111111-2222-3333-4444-555555555555";

/** Invoke the route with the given body; the event object is never read. */
async function post(body: unknown) {
  readBodyMock.mockResolvedValue(body);
  return (handler as unknown as (event: unknown) => Promise<unknown>)({} as never);
}

describe("paypal-capture orderID validation", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getRequestIPMock.mockReturnValue("203.0.113.1");
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValue(new Error("no outbound request may be made"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  // Each of these resolves, under WHATWG URL rules, to a PayPal path other than
  // the intended /v2/checkout/orders/<id>/capture.
  const escapes: Array<[string, string]> = [
    ["parent-segment pivot to a refund", "../../payments/captures/8AB12345CD/refund?"],
    ["encoded traversal", "%2e%2e%2fpayments%2fcaptures%2fX%2frefund"],
    ["query truncation", "5O190127TN364715T?ignored="],
    ["fragment truncation", "5O190127TN364715T#"],
    ["backslash", "..\\..\\payments\\captures\\X\\void"],
    ["path separator", "orders/X/refund"],
    ["trailing newline", "5O190127TN364715T\n"],
    ["over the documented maximum", "A".repeat(37)],
    ["empty after the required-fields check", " "],
  ];

  for (const [name, orderID] of escapes) {
    it(`rejects ${name} with a 400 and never calls out`, async () => {
      await expect(post({ orderID, invoiceId: INVOICE_ID })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(selectMock).not.toHaveBeenCalled();
      expect(enforceRateLimitMock).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-string orderID without coercing it", async () => {
    await expect(
      post({ orderID: { toString: () => "5O190127TN364715T" }, invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a well-formed PayPal order id and proceeds past validation", async () => {
    // Reaching the invoice lookup is the proof it passed the gate — that lookup
    // is mocked to throw, so nothing further runs.
    await expect(post({ orderID: "5O190127TN364715T", invoiceId: INVOICE_ID })).rejects.toThrow(
      /invoice lookup must not run/,
    );
    expect(enforceRateLimitMock).toHaveBeenCalledOnce();
  });
});
