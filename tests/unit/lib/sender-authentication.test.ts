import { describe, expect, it } from "vitest";
import {
  describeSenderAuthentication,
  domainsAligned,
  evaluateSenderAuthentication,
  isSenderKnownToParty,
  judgeEmailSenders,
  parseAuthenticationResults,
  parseHeaderSection,
  parseMailbox,
  readSenderAuthentication,
  senderAddressesIn,
  type SenderAuthentication,
} from "@/lib/inbox/sender-authentication";

const FROM = '"Paper Street Supply, Inc." <billing@paperstreet.example>';

/** What the receiving server (Amazon SES) stamps on a message that passed. */
const SES_PASS = [
  "Authentication-Results: amazonses.com;",
  " spf=pass (spfCheck: domain of mail.paperstreet.example designates 203.0.113.7 as",
  " permitted sender) client-ip=203.0.113.7; envelope-from=bounce@mail.paperstreet.example;",
  " helo=mail.paperstreet.example;",
  " dkim=pass header.i=@paperstreet.example;",
  " dmarc=pass header.from=paperstreet.example;",
].join("\r\n");

/** A header section as stored, the receiving server's trace fields on top. */
function message(input: { results?: string[]; from?: string[] } = {}): string {
  return [
    "Return-Path: <bounce@mail.paperstreet.example>",
    "Received: from mail.paperstreet.example (mail.paperstreet.example [203.0.113.7])",
    " by inbound-smtp.us-east-1.amazonaws.com with SMTP id abc123",
    " for books@in.buwiz.test; Tue, 25 Aug 2026 10:00:00 +0000 (UTC)",
    "X-SES-Spam-Verdict: PASS",
    ...(input.results ?? [SES_PASS]),
    ...(input.from ?? [`From: ${FROM}`]).map((line) =>
      /^From\s*:/u.test(line) ? line : `From: ${line}`,
    ),
    "To: books@in.buwiz.test",
    "Subject: Invoice INV-1042",
    "Message-ID: <inv-1042@paperstreet.example>",
    "",
    "Please find the invoice attached.",
  ].join("\r\n");
}

function evaluate(headerSection: string | null, providerFrom: string | null = FROM) {
  return evaluateSenderAuthentication({ headerSection, providerFrom });
}

function results(value: string) {
  return [`Authentication-Results: ${value}`];
}

describe("parseHeaderSection", () => {
  it("unfolds, keeps order and duplicates, and stops at the blank line", () => {
    const headers = parseHeaderSection(
      [
        "From MAILER-DAEMON Tue Aug 25 10:00:00 2026",
        "Received: from a.example",
        "\tby b.example",
        "Authentication-Results: first.example; dmarc=fail",
        "Authentication-Results: second.example; dmarc=pass",
        "SUBJECT: Hello",
        "",
        "Authentication-Results: body.example; dmarc=pass",
      ].join("\n"),
    );
    expect(headers).toEqual([
      { name: "received", value: "from a.example by b.example" },
      { name: "authentication-results", value: "first.example; dmarc=fail" },
      { name: "authentication-results", value: "second.example; dmarc=pass" },
      { name: "subject", value: "Hello" },
    ]);
  });
});

describe("parseMailbox", () => {
  it.each([
    [FROM, "billing@paperstreet.example"],
    ["Billing@PaperStreet.Example", "billing@paperstreet.example"],
    ["billing@paperstreet.example (Accounts)", "billing@paperstreet.example"],
    ["=?UTF-8?Q?Paper_Street?= <billing@paperstreet.example>", "billing@paperstreet.example"],
    // A display name that looks like an address is only a name.
    ['"billing@paperstreet.example" <thief@lookalike.example>', "thief@lookalike.example"],
  ])("reads %s", (value, address) => {
    expect(parseMailbox(value)?.address).toBe(address);
  });

  it.each([
    ["a list", "billing@paperstreet.example, thief@lookalike.example"],
    ["a list behind a name", "Paper Street <billing@paperstreet.example>, thief@lookalike.example"],
    ["two angle addresses", "<billing@paperstreet.example> <thief@lookalike.example>"],
    ["a group", "Accounts: billing@paperstreet.example;"],
    ["an open quote", '"Paper Street <billing@paperstreet.example>'],
    ["an open comment", "billing@paperstreet.example (Accounts"],
    ["a single-label domain", "billing@localhost"],
    ["no address", "Paper Street Supply"],
  ])("refuses %s", (_label, value) => {
    expect(parseMailbox(value)).toBeNull();
  });
});

describe("parseAuthenticationResults", () => {
  it("reads the receiving server's results, comments removed, continuations kept", () => {
    const parsed = parseAuthenticationResults(parseHeaderSection(SES_PASS)[0].value);
    expect(parsed?.authservId).toBe("amazonses.com");
    expect(parsed?.results.map((result) => [result.method, result.result])).toEqual([
      ["spf", "pass"],
      ["dkim", "pass"],
      ["dmarc", "pass"],
    ]);
    // SES writes envelope-from as its own segment after spf.
    expect(parsed?.results[0].properties.get("envelope-from")).toBe(
      "bounce@mail.paperstreet.example",
    );
    expect(parsed?.results[2].properties.get("header.from")).toBe("paperstreet.example");
  });

  it("has no authserv-id when the header starts with a result", () => {
    const parsed = parseAuthenticationResults(
      "spf=pass (sender IP is 203.0.113.7) smtp.mailfrom=paperstreet.example; dmarc=pass action=none header.from=paperstreet.example",
    );
    expect(parsed?.authservId).toBeNull();
    expect(parsed?.results.map((result) => result.method)).toEqual(["spf", "dmarc"]);
  });

  it("reads versions, quoted values and none", () => {
    expect(
      parseAuthenticationResults(
        'mx.example 1; dkim/1 = fail reason="bad signature; retry" header.d=paperstreet.example',
      ),
    ).toMatchObject({
      authservId: "mx.example",
      results: [{ method: "dkim", result: "fail" }],
    });
    expect(parseAuthenticationResults("mx.example; none")).toEqual({
      authservId: "mx.example",
      results: [],
    });
  });

  it("refuses an unclosed comment or quote", () => {
    expect(parseAuthenticationResults("amazonses.com; dmarc=pass (open")).toBeNull();
    expect(parseAuthenticationResults('amazonses.com; dkim=fail reason="open')).toBeNull();
  });
});

describe("domainsAligned", () => {
  it("is equal or one under the other, and never a sibling", () => {
    expect(domainsAligned("paperstreet.example", "paperstreet.example")).toBe(true);
    expect(domainsAligned("mail.paperstreet.example", "paperstreet.example")).toBe(true);
    expect(domainsAligned("paperstreet.example", "mail.paperstreet.example")).toBe(true);
    expect(domainsAligned("lookalike.example", "paperstreet.example")).toBe(false);
    expect(domainsAligned("notpaperstreet.example", "paperstreet.example")).toBe(false);
    expect(domainsAligned(null, "paperstreet.example")).toBe(false);
  });
});

describe("evaluateSenderAuthentication", () => {
  it("passes on the receiving server's DMARC pass for the From domain", () => {
    expect(evaluate(message())).toEqual({
      version: 1,
      passed: true,
      reason: "passed",
      method: "dmarc",
      fromAddress: "billing@paperstreet.example",
      fromDomain: "paperstreet.example",
      authservId: "amazonses.com",
      results: { dmarc: "pass", dkim: "pass", spf: "pass" },
    });
  });

  it("passes on DKIM or SPF aligned with the From domain when DMARC did not", () => {
    expect(
      evaluate(
        message({
          results: results(
            "amazonses.com; spf=fail smtp.mailfrom=elsewhere.example; dkim=pass header.d=paperstreet.example; dmarc=none",
          ),
        }),
      ),
    ).toMatchObject({ passed: true, method: "dkim" });
    expect(
      evaluate(
        message({
          results: results(
            "amazonses.com; spf=pass smtp.mailfrom=bounce@mail.paperstreet.example; dkim=none; dmarc=none",
          ),
        }),
      ),
    ).toMatchObject({ passed: true, method: "spf" });
  });

  it.each([
    [
      "SPF passed for another domain",
      "amazonses.com; spf=pass smtp.mailfrom=thief@lookalike.example; dkim=none; dmarc=fail header.from=paperstreet.example",
    ],
    [
      "DKIM passed for the mail provider, not the vendor",
      "amazonses.com; spf=softfail smtp.mailfrom=esp.example; dkim=pass header.d=esp.example; dmarc=fail header.from=paperstreet.example",
    ],
    [
      "DMARC passed for another From domain",
      "amazonses.com; dmarc=pass header.from=lookalike.example",
    ],
    ["only neutral results", "amazonses.com; spf=neutral; dkim=temperror; dmarc=none"],
    ["no results at all", "amazonses.com; none"],
  ])("fails when %s", (_label, value) => {
    expect(evaluate(message({ results: results(value) }))).toMatchObject({
      passed: false,
      reason: "failed",
      method: null,
      fromDomain: "paperstreet.example",
    });
  });

  it("believes only the topmost results: a forged pass below the receiving server's is ignored", () => {
    const spoofed = message({
      results: [
        "Authentication-Results: amazonses.com; spf=fail smtp.mailfrom=thief@lookalike.example; dkim=none; dmarc=fail header.from=paperstreet.example",
        "Authentication-Results: amazonses.com; dmarc=pass header.from=paperstreet.example",
      ],
    });
    expect(evaluate(spoofed)).toMatchObject({
      passed: false,
      reason: "failed",
      results: { dmarc: "fail", dkim: "none", spf: "fail" },
    });
  });

  it("does not believe results from any other server, whatever they say", () => {
    expect(
      evaluate(
        message({
          results: results("mx.lookalike.example; dmarc=pass header.from=paperstreet.example"),
        }),
      ),
    ).toMatchObject({
      passed: false,
      reason: "untrusted_results",
      authservId: "mx.lookalike.example",
    });
    expect(
      evaluate(
        message({ results: results("spf=pass smtp.mailfrom=paperstreet.example; dmarc=pass") }),
      ),
    ).toMatchObject({ passed: false, reason: "untrusted_results", authservId: null });
    // Another receiving server can be trusted explicitly.
    expect(
      evaluateSenderAuthentication({
        headerSection: message({
          results: results("mx.google.com; dmarc=pass header.from=paperstreet.example"),
        }),
        providerFrom: FROM,
        trustedAuthservIds: ["mx.google.com"],
      }),
    ).toMatchObject({ passed: true, method: "dmarc", authservId: "mx.google.com" });
  });

  it("reads names and results case-insensitively", () => {
    expect(
      evaluate(
        message({
          results: results("AmazonSES.com; DMARC=PASS header.from=PaperStreet.Example."),
        }),
      ),
    ).toMatchObject({ passed: true, method: "dmarc" });
  });

  it.each([
    ["no header section", null, "no_headers"],
    ["an empty header section", "  ", "no_headers"],
    ["no results header", message({ results: [] }), "no_results"],
    [
      "unreadable results",
      message({ results: results("amazonses.com; dmarc=pass (unclosed") }),
      "unparseable",
    ],
    ["no From", message({ from: [] }), "no_from"],
    ["two From headers", message({ from: [FROM, "thief@lookalike.example"] }), "no_from"],
    [
      "a second From in obsolete syntax",
      message({ from: [FROM, "From : thief@lookalike.example"] }),
      "no_from",
    ],
    [
      "a From list",
      message({ from: ["billing@paperstreet.example, thief@lookalike.example"] }),
      "no_from",
    ],
  ])("does not pass with %s", (_label, headerSection, reason) => {
    expect(evaluate(headerSection)).toMatchObject({ passed: false, reason, method: null });
  });

  it("does not pass when Resend's From is not the header's From", () => {
    expect(evaluate(message(), "Paper Street <thief@lookalike.example>")).toMatchObject({
      passed: false,
      reason: "from_mismatch",
    });
    expect(evaluate(message(), null)).toMatchObject({ passed: false, reason: "from_mismatch" });
    // Resend may drop the display name's quotes; the address is what is compared.
    expect(
      evaluate(message(), "Paper Street Supply, Inc. <billing@paperstreet.example>"),
    ).toMatchObject({ passed: true });
  });

  it("keeps the reported From on a verdict it could not read headers for", () => {
    expect(evaluate(null)).toMatchObject({
      fromAddress: "billing@paperstreet.example",
      fromDomain: "paperstreet.example",
    });
  });
});

describe("readSenderAuthentication", () => {
  it("reads back what the job stored", () => {
    const stored = JSON.parse(JSON.stringify(evaluate(message())));
    expect(readSenderAuthentication(stored)).toEqual(evaluate(message()));
  });

  it.each([
    ["nothing", undefined],
    ["a string", "passed"],
    ["another version", { ...evaluate(message()), version: 2 }],
    ["an unknown reason", { ...evaluate(message()), reason: "trusted" }],
    ["no results", { ...evaluate(message()), results: null }],
  ])("refuses %s", (_label, value) => {
    expect(readSenderAuthentication(value)).toBeNull();
  });

  it("believes a pass only whole", () => {
    const pass = evaluate(message());
    for (const tampered of [
      { ...pass, reason: "failed" },
      { ...pass, method: null },
      { ...pass, fromDomain: "lookalike.example" },
      { ...pass, fromAddress: null },
    ]) {
      expect(readSenderAuthentication(tampered)).toMatchObject({ passed: false, method: null });
    }
    expect(readSenderAuthentication({ ...pass, passed: false })).toMatchObject({
      passed: false,
      reason: "failed",
    });
  });
});

describe("isSenderKnownToParty", () => {
  const vendor = senderAddressesIn("AP <ap@paperstreet.example>; billing@paperstreet.example");

  it("knows the party's domain and its subdomains", () => {
    expect(vendor.map((entry) => entry.address)).toEqual([
      "ap@paperstreet.example",
      "billing@paperstreet.example",
    ]);
    expect(
      isSenderKnownToParty(
        { address: "invoices@paperstreet.example", domain: "paperstreet.example" },
        vendor,
      ),
    ).toBe(true);
    expect(
      isSenderKnownToParty(
        { address: "noreply@billing.paperstreet.example", domain: "billing.paperstreet.example" },
        vendor,
      ),
    ).toBe(true);
  });

  it("never matches a lookalike, a parent, or a public suffix", () => {
    const known = senderAddressesIn("ap@mail.paperstreet.example, billing@vendor.com.ph");
    for (const sender of [
      { address: "billing@paperstreet-billing.example", domain: "paperstreet-billing.example" },
      { address: "billing@notpaperstreet.example", domain: "notpaperstreet.example" },
      { address: "billing@paperstreet.example", domain: "paperstreet.example" },
      { address: "billing@com.ph", domain: "com.ph" },
    ]) {
      expect(isSenderKnownToParty(sender, known)).toBe(false);
    }
    expect(
      isSenderKnownToParty({ address: "x@paperstreet.example", domain: "paperstreet.example" }, []),
    ).toBe(false);
  });

  it("matches only the exact address at a shared mailbox provider", () => {
    const known = senderAddressesIn("juan.delacruz@gmail.com, maria@yahoo.com.ph");
    expect(
      isSenderKnownToParty({ address: "juan.delacruz@gmail.com", domain: "gmail.com" }, known),
    ).toBe(true);
    expect(isSenderKnownToParty({ address: "thief@gmail.com", domain: "gmail.com" }, known)).toBe(
      false,
    );
    expect(
      isSenderKnownToParty({ address: "thief@yahoo.com.ph", domain: "yahoo.com.ph" }, known),
    ).toBe(false);
  });
});

describe("judgeEmailSenders", () => {
  const pass = evaluate(message());
  const known = senderAddressesIn("ap@paperstreet.example");

  it("verifies a passed sender the party uses", () => {
    expect(judgeEmailSenders({ verdicts: [pass], known })).toEqual({
      verified: true,
      detail: null,
    });
  });

  it.each<[string, readonly unknown[], typeof known | null, string]>([
    ["no message on record", [], known, "no inbound message is on record"],
    ["no verdict recorded", [undefined], known, "it was not checked when it arrived"],
    [
      "an authentication failure",
      [
        evaluate(
          message({
            results: results(
              "amazonses.com; spf=fail; dkim=none; dmarc=fail header.from=paperstreet.example",
            ),
          }),
        ),
      ],
      known,
      "nothing passed for paperstreet.example (DMARC fail, DKIM none, SPF fail)",
    ],
    [
      "a sender the party has not used",
      [pass],
      senderAddressesIn("ap@othersupply.example"),
      "paperstreet.example is not a domain this party has used",
    ],
    [
      "no party",
      [pass],
      null,
      "no vendor or customer to check billing@paperstreet.example against",
    ],
    [
      "one message of two failing",
      [pass, evaluate(message({ results: [] }))],
      known,
      "it carries no authentication results",
    ],
  ])("does not verify %s", (_label, verdicts, knownSenders, detail) => {
    expect(judgeEmailSenders({ verdicts, known: knownSenders })).toEqual({
      verified: false,
      detail,
    });
  });

  it("names the address at a shared mailbox provider", () => {
    const gmail: SenderAuthentication = {
      ...pass,
      fromAddress: "thief@gmail.com",
      fromDomain: "gmail.com",
    };
    expect(
      judgeEmailSenders({ verdicts: [gmail], known: senderAddressesIn("juan@gmail.com") }),
    ).toEqual({ verified: false, detail: "thief@gmail.com is not an address this party has used" });
  });
});

describe("describeSenderAuthentication", () => {
  it("names the server whose results were not believed", () => {
    expect(
      describeSenderAuthentication(
        evaluate(message({ results: results("mx.lookalike.example; dmarc=pass") })),
      ),
    ).toBe("its authentication results are from mx.lookalike.example, not the receiving server");
    expect(describeSenderAuthentication(evaluate(null))).toBe(
      "its original headers were not available",
    );
  });
});
