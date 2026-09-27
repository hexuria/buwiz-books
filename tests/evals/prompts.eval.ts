// ============================================================================
// Prompt-regression evals (recorded mode — NO network, NO database).
//
// This is the CI-safe half of the harness: it replays stored provider
// responses through the real schemas, validators, and graders, and snapshots
// the rendered prompt for every task. A prompt edit that changes behavior
// shows up here before it reaches a customer's ledger.
//
// Live-model evals are a separate nightly workflow with its own budget cap.
// ============================================================================
import { describe, expect, it } from "vitest";
import { PROMPT_FIXTURES } from "./fixtures/prompt-inputs";
import { getTaskEntry } from "../../src/lib/ai/prompts/index";
import { parseModelJson } from "../../src/lib/ai/parse-model-json";
import { generateStructuredJev } from "../../src/lib/ai/adapters/jev";
import { JEV_MODEL, JEV_TASKS } from "../../src/lib/ai/chains";
import { JEV_MOCK_RESPONSES } from "../../src/lib/ai/fixtures/mock-responses";
import { redactPII, toRedactedPrompt } from "../../src/lib/ai/redact";
import { toStrictJsonSchema } from "../../src/lib/ai/schema-strict";
import { checkInvariants, gradeCase, money, dateExact, type FieldSpec } from "./graders";
import { RECORDED_CASES } from "./fixtures/recorded";

const MODE = process.env.AI_EVALS_MODE ?? "recorded";

describe(`prompt rendering (mode: ${MODE})`, () => {
  for (const fixture of PROMPT_FIXTURES) {
    it(`${fixture.task} renders deterministically`, () => {
      const entry = getTaskEntry(fixture.task);
      const first = entry.prompt.build(fixture.input as never);
      const second = entry.prompt.build(fixture.input as never);

      // Same input ⇒ same prompt. A nondeterministic prompt (an un-injected
      // clock, a Set iteration) makes every downstream eval untrustworthy.
      expect(first).toBe(second);
      expect(first.length).toBeGreaterThan(0);
      expect(first).toMatchSnapshot();
    });

    it(`${fixture.task} declares a prompt version`, () => {
      const entry = getTaskEntry(fixture.task);
      expect(entry.prompt.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.schemaHash).toMatch(/^[0-9a-f]{16}$/);
    });
  }
});

describe(`recorded extraction cases (mode: ${MODE})`, () => {
  for (const testCase of RECORDED_CASES) {
    it(`${testCase.task}: ${testCase.name}`, () => {
      const entry = getTaskEntry(testCase.task);
      const parsed = parseModelJson(entry.schema, testCase.recordedResponse);

      expect(parsed.ok, `output failed schema validation: ${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.ok) return;

      // Invariants first: an output that is structurally illegal is wrong
      // whatever the fixture expected, and the message is more useful than a
      // field mismatch downstream of it.
      if (testCase.invariants?.length) {
        const violations = checkInvariants(
          parsed.data as Record<string, unknown>,
          testCase.invariants,
        ).filter((result) => !result.passed);
        if (violations.length > 0) {
          throw new Error(
            `Output invariants failed: ${violations.map((v) => `${v.name} — ${v.detail}`).join("; ")}`,
          );
        }
      }

      const grade = gradeCase(
        testCase.expected,
        parsed.data as Record<string, unknown>,
        testCase.fields,
      );
      if (!grade.passed) {
        const failures = grade.fields.filter((f) => !f.passed);
        throw new Error(
          `Graded fields failed: ${failures
            .map(
              (f) =>
                `${f.field} expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual)}`,
            )
            .join("; ")}`,
        );
      }
      expect(grade.score).toBe(1);
    });
  }
});

// Jev cases carry the raw HTTP body. Replaying it through the REAL adapter
// (stubbed fetch, so still no network) checks the assumed wire mapping end to
// end: what we send is redacted and schema-constrained, and what we read back
// is exactly the recorded text the graders above scored.
describe(`recorded Jev wire replay (mode: ${MODE})`, () => {
  const JEV_CASES = RECORDED_CASES.filter((testCase) => testCase.provider === "jev");

  it("covers both tasks Jev serves", () => {
    expect(new Set(JEV_CASES.map((testCase) => testCase.task))).toEqual(new Set(JEV_TASKS));
  });

  it("the AI_MODE=mock Jev answers are recorded Jev responses", () => {
    for (const task of JEV_TASKS) {
      const recorded = JEV_CASES.filter((c) => c.task === task).map((c) => c.recordedResponse);
      expect(recorded, task).toContain(JEV_MOCK_RESPONSES[task]);
    }
  });

  for (const testCase of JEV_CASES) {
    it(`${testCase.task}: ${testCase.name}`, async () => {
      expect(testCase.recordedWire, "a Jev case must carry its wire body").toBeDefined();
      const entry = getTaskEntry(testCase.task);
      const { prompt } = toRedactedPrompt(entry.prompt.build(testCase.input as never));
      const sent: Array<{ url: string; body: Record<string, unknown> }> = [];

      const result = await generateStructuredJev({
        apiKey: "recorded-replay",
        baseURL: "https://jev.recorded.invalid/v1",
        model: JEV_MODEL,
        prompt,
        schema: entry.schema,
        schemaName: entry.prompt.id.replace(/-/g, "_"),
        temperature: entry.generation?.temperature,
        fetch: async (url, init) => {
          sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify(testCase.recordedWire), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      // Request side: one call, redacted content only, schema-constrained.
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe("https://jev.recorded.invalid/v1/chat/completions");
      const messages = sent[0].body.messages as Array<{ role: string; content: string }>;
      expect(messages).toEqual([{ role: "user", content: String(prompt) }]);
      expect(redactPII(messages[0].content).hits).toEqual([]);
      expect(sent[0].body.response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: entry.prompt.id.replace(/-/g, "_"),
          strict: true,
          schema: toStrictJsonSchema(entry.schema),
        },
      });

      // Response side: the adapter yields exactly the graded text, and a
      // missing usage block is estimated rather than left unpriced.
      expect(result.text).toBe(testCase.recordedResponse);
      expect(result.usage.tokensIn).toBeGreaterThan(0);
      expect(result.usage.tokensOut).toBeGreaterThan(0);
      expect(result.usageEstimated).toBe(
        (testCase.recordedWire as { usage?: unknown }).usage === undefined,
      );
      expect(parseModelJson(entry.schema, result.text).ok).toBe(true);
    });
  }
});

describe("grader sanity", () => {
  const fields: FieldSpec[] = [
    { path: "amount", grader: money, critical: true },
    { path: "date", grader: dateExact, critical: true },
  ];

  it("treats equal money written differently as equal", () => {
    const grade = gradeCase(
      { amount: "42.50", date: "2026-01-05" },
      { amount: 42.5, date: "2026-01-05" },
      fields,
    );
    expect(grade.passed).toBe(true);
  });

  it("fails a one-cent difference", () => {
    const grade = gradeCase(
      { amount: "42.50", date: "2026-01-05" },
      { amount: "42.51", date: "2026-01-05" },
      fields,
    );
    expect(grade.passed).toBe(false);
  });
});
