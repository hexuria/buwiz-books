import { beforeEach, describe, expect, it, vi } from "vitest";
import { validatePayPalCaptureInput } from "../../../src/lib/paypal-capture-policy";
import { isValidPayPalOrderId } from "../../../src/lib/paypal-order-id";

describe("isValidPayPalOrderId", () => {
  const escapes: Array<[string, unknown]> = [
    ["parent-segment pivot", "../../payments/captures/8AB12345CD/refund?"],
    ["encoded traversal", "%2e%2e%2fpayments%2fcaptures%2fX%2frefund"],
    ["query truncation", "5O190127TN364715T?ignored="],
    ["fragment truncation", "5O190127TN364715T#"],
    ["backslash", "..\\..\\payments\\captures\\X\\void"],
    ["path separator", "orders/X/refund"],
    ["trailing newline", "5O190127TN364715T\n"],
    ["over the documented maximum", "A".repeat(37)],
    ["whitespace", " "],
    ["non-string", { toString: () => "5O190127TN364715T" }],
  ];

  for (const [name, value] of escapes) {
    it(`rejects ${name}`, () => {
      expect(isValidPayPalOrderId(value)).toBe(false);
    });
  }

  it("accepts a well-formed opaque order id", () => {
    expect(isValidPayPalOrderId("5O190127TN364715T")).toBe(true);
  });

  it("validates both identifiers before the handler can perform a privileged side effect", () => {
    expect(
      validatePayPalCaptureInput({
        orderId: "../../payments/captures/8AB12345CD/refund?",
        invoiceId: "11111111-2222-3333-4444-555555555555",
      }),
    ).toEqual({ ok: false, message: "orderID is not a valid PayPal order id" });
    expect(
      validatePayPalCaptureInput({
        orderId: "5O190127TN364715T",
        invoiceId: "11111111-2222-3333-4444-555555555555",
      }),
    ).toEqual({
      ok: true,
      orderId: "5O190127TN364715T",
      invoiceId: "11111111-2222-3333-4444-555555555555",
    });
  });
});

const { readBodyMock, getRequestIPMock, selectMock, enforceRateLimitMock } = vi.hoisted(() => ({
  readBodyMock: vi.fn(),
  getRequestIPMock: vi.fn(() => "203.0.113.1"),
  selectMock: vi.fn(() => {
    throw new Error("the invoice lookup must not run for malformed input");
  }),
  enforceRateLimitMock: vi.fn(),
}));

vi.mock("h3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("h3")>();
  return { ...actual, readBody: readBodyMock, getRequestIP: getRequestIPMock };
});
vi.mock("../../../src/db", () => ({ db: { select: selectMock } }));
vi.mock("../../../src/lib/request-guards", () => ({ enforceRateLimit: enforceRateLimitMock }));

import handler from "../../../server/routes/api/payments/paypal-capture.post";

const INVOICE_ID = "11111111-2222-3333-4444-555555555555";

async function post(body: unknown) {
  readBodyMock.mockResolvedValue(body);
  return (handler as unknown as (event: unknown) => Promise<unknown>)({} as never);
}

describe("PayPal capture route adapter", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockRejectedValue(new Error("no outbound request may be made"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("rejects malformed input before rate limiting, database access, or provider calls", async () => {
    await expect(
      post({
        orderID: "../../payments/captures/8AB12345CD/refund?",
        invoiceId: INVOICE_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a valid request to reach the rate limit and invoice lookup", async () => {
    await expect(post({ orderID: "5O190127TN364715T", invoiceId: INVOICE_ID })).rejects.toThrow(
      /invoice lookup must not run/,
    );

    expect(enforceRateLimitMock).toHaveBeenCalledOnce();
    expect(selectMock).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
