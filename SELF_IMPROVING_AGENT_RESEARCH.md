# Self-Improving AI Agent Harness — Research & Phased Plan

**Status:** Research (primary-source grounded). Companion to [AI_MULTIPROVIDER_PLAN.md](./AI_MULTIPROVIDER_PLAN.md) (multi-provider `aiComplete` façade + finance harness). That plan gives us a provider-agnostic AI layer; this document covers how to make that layer **improve itself over time** — something we have zero mechanism for today.

**Method note:** every claim below is cited to the source that owns it — official docs, arXiv papers, first-party engineering posts, or SDK repos — not secondary write-ups.

---

## TL;DR

1. **"Self-improving" in production ≠ the model rewriting itself.** The proven pattern is a _loop around the model_: capture real outcomes → curate them into eval datasets → grade candidate prompt/config changes against those datasets → promote only changes that pass, with humans gating promotion. Anthropic's own agent guidance is explicit that autonomy needs "extensive testing in sandboxed environments, along with appropriate guardrails" ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).
2. **We are unusually well-positioned for feedback capture.** Our 8 AI call sites (bill/receipt/statement OCR, date/transaction parse, classification, matching) all produce structured output that **users then correct in the UI**. A user's correction _is_ a ground-truth label — a stronger signal than thumbs up/down. Anthropic's eval guidance says to "convert user-reported failures into test cases" and that "20–50 simple tasks drawn from real failures is a great start" ([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
3. **Our eval graders are mostly free.** Because the multi-provider plan makes Zod the single output-schema language, most grading is code-based (field-exact-match on OCR amounts/dates — Anthropic's preferred "fast, objective, reproducible" grader class), with LLM-as-judge only for genuinely fuzzy fields. Evals can run in **Vitest**, which we already use — no new framework required.
4. **Automated prompt optimization is real but Python-first.** DSPy is "a Python framework" (python ≥ 3.10) per [dspy.ai](https://dspy.ai/); GEPA (reflective prompt evolution, [arXiv 2507.19457](https://arxiv.org/abs/2507.19457)) beats RL-style GRPO by up to 20% with 35× fewer rollouts. The TypeScript path is [Ax](https://github.com/ax-llm/ax) (self-described "pretty much 'official' DSPy framework for TypeScript", ships GEPA + few-shot bootstrapping) — or run the optimizer offline in a Python sidecar and check the winning prompt into git. Either way, **optimized prompts are build artifacts that pass CI evals + human review before deploy**, never runtime self-modification.
5. **Do not build on OpenAI's Evals platform** — its own docs state the platform "is being deprecated, becoming read-only October 31, 2026" ([OpenAI Evals guide](https://developers.openai.com/api/docs/guides/evals)). Own the dataset + runner in-repo instead; optionally layer Braintrust/LangSmith for UI.
6. **Safety rails are non-negotiable for a finance app.** Our OCR inputs are third-party documents = the exact _indirect prompt injection_ threat model Anthropic documents, with a financial-advisor chatbot as their worked example ([Mitigate jailbreaks and prompt injections](https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)). Any memory/lessons store the AI writes must be treated as an attack surface (path traversal + poisoning guidance in the [memory tool docs](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/memory-tool)). All prompt/skill changes go through git (versioned, rollbackable) behind the eval gate.

---

## 1. Eval-driven improvement loops (the core)

**Anthropic's official eval guidance** ([Define success criteria + develop tests, platform.claude.com](https://platform.claude.com/docs/en/docs/test-and-evaluate/develop-tests)) gives three design principles, quoted:

- _"Design evals that mirror your real-world task distribution. Don't forget to factor in edge cases!"_ (be task-specific — for us: rotated receipts, multi-currency statements, handwritten bills, ambiguous dates like `03/04/2025`).
- _"Structure questions to allow for automated grading (for example, multiple-choice, string match, code-graded, LLM-graded)."_
- _"Prioritize volume over quality: more questions with slightly lower signal automated grading is better than fewer questions with high-quality human hand-graded evals."_

It also documents the grader menu we'd use: exact match, embedding similarity, ROUGE-L, and LLM-based grading (Likert / binary), with the best practice that it's _"generally best practice to use a different model to evaluate than the model used to generate the evaluated output."_

**Anthropic's agent-eval post** ([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)) adds the operational vocabulary:

- An eval = task + grader(s); three grader types: **code-based** ("fast, objective, reproducible"), **model-based** ("flexible, scalable… require calibration"), **human** ("gold standard… higher cost").
- _"A good task is one where two domain experts would independently reach the same pass/fail verdict."_ — for accounting outputs (amounts, account codes, dates) this is trivially satisfiable, which is why our domain evals so well.
- Start from _"the manual checks you run during development"_ and _"convert user-reported failures into test cases."_ _"20-50 simple tasks drawn from real failures is a great start."_
- Track **pass@k** vs **pass^k** (reliability); for finance workflows we care about pass^k — every run must be right.
- Timing: _"evals get harder to build the longer you wait."_

**OpenAI Evals**: the [openai/evals repo](https://github.com/openai/evals) is _"a framework for evaluating large language models (LLMs) or systems built using LLMs"_ with a registry + model-graded YAML evals, but contributions are restricted ("we are currently not accepting evals with custom code!") and users are pointed to the hosted dashboard. The hosted [Evals guide](https://developers.openai.com/api/docs/guides/evals) documents a clean data model worth copying (JSONL datasets, `string_check` graders, `{{ item.* }}` / `{{ sample.output_text }}` templating) — **but the page states the platform becomes read-only October 31, 2026**, so it's a design reference, not a dependency.

**Third-party platforms** (optional layer, not required): [Braintrust human review](https://www.braintrust.dev/docs/guides/human-review) exists to _"capture structured human judgment on production traces to build ground truth, validate automated scores, and surface edge cases your scorers miss"_ and to _"curate production logs into evaluation datasets."_ [LangSmith](https://docs.langchain.com/langsmith/attach-user-feedback) offers `createFeedback(runId, key, {score, comment})` in TypeScript to attach feedback to traces. Both are viable later; neither is needed for Phase 1–2 because our corrections land in our own Postgres anyway.

**Implication for Buwiz Books:** the eval loop is: production run log (Postgres, Drizzle) → curated JSONL/table dataset per task (`ocr-bill`, `date-parse`, `tx-match`, `classify-doc`) → Vitest suite that replays the dataset through `aiComplete` with a pinned prompt version → code graders (Zod parse success, field equality on amount/date/party, tolerance rules) + a small LLM-judge for fuzzy fields → CI regression gate.

## 2. Memory & reflection mechanisms

**Reflexion** ([Shinn et al., arXiv 2303.11366](https://arxiv.org/abs/2303.11366)) — _"Reflexion agents verbally reflect on task feedback signals, then maintain their own reflective text in an episodic memory buffer to induce better decision-making in subsequent trials."_ No weight updates; feedback can be scalar or natural language. Results: 91% pass@1 on HumanEval vs GPT-4's 80%. **Two distinct uses for us:** (a) _within-request_ — the multi-provider plan's §2.5 repair loop (Zod validation failure → feed error back → retry) is exactly a one-shot Reflexion loop; (b) _across-requests_ — distill recurring correction patterns ("this org's vendor X invoices put the total in the footer") into a per-org "lessons" note injected into future prompts.

**Voyager** ([Wang et al., arXiv 2305.16291](https://arxiv.org/abs/2305.16291)) — lifelong-learning agent with three components: automatic curriculum, an **"ever-growing skill library of executable code for storing and retrieving complex behaviors,"** and iterative prompting incorporating _"environment feedback, execution errors, and self-verification for program improvement."_ The skill library compounds capability while _"preventing catastrophic forgetting."_ **Lesson:** improvements should be stored as versioned, retrievable artifacts (prompts/skills/few-shot exemplars), not as an opaque growing blob.

**Anthropic memory tool** ([official docs](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/memory-tool)) — GA on the Messages API (`{"type": "memory_20250818", "name": "memory"}`); Claude reads/writes files under `/memories`, **client-side**: _"your application executes each request against storage you control."_ The TypeScript SDK ships `betaMemoryTool` + `BetaLocalFilesystemMemoryTool` helpers. Security guidance is explicit: validate every path (_"a malicious path such as `/memories/../../secrets.env` can reach files outside the `/memories` directory"_), cap file sizes, expire stale memories. Anthropic's [long-running-harness post](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) shows the same pattern as files: an initializer session writes progress/feature-checklist files; later sessions resume from them; _"it is unacceptable to remove or edit tests because this could lead to missing or buggy functionality."_

**Implication for Buwiz Books:** per-org lessons live in a normal Postgres table (org-scoped, RLS like everything else), size-capped, human-viewable in settings, and injected into prompts as clearly-delimited _data_. We don't need the API memory tool for Phase 1–3; it becomes relevant if we later ship a conversational bookkeeping agent.

## 3. Automated prompt optimization

- **DSPy** ([dspy.ai](https://dspy.ai/), MIT license) — _"a Python framework for building AI systems"_; requires _"python ≥ 3.10"_. Programming model: **signatures** (typed input/output declarations, _"portable, maintainable, and easy to iterate on"_) + **modules**; optimizers include **GEPA**, **MIPROv2** ("optimizing instructions and demonstrations"), **BootstrapFewShot**, COPRO, Ensemble. Philosophy: _"Give DSPy examples and a scoring function. It tunes your prompts automatically until quality converges."_ → **Python-only; not embeddable in our Bun/TS runtime.**
- **GEPA** ([Agrawal et al., arXiv 2507.19457](https://arxiv.org/abs/2507.19457), ICLR 2026 oral) — "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning." Samples trajectories, uses _"natural language reflection to learn high-level rules from trial and error,"_ and combines _"complementary lessons from the Pareto frontier of its own attempts."_ Beats GRPO by up to 20% using _"up to 35x fewer rollouts"_; beats MIPROv2 by >10%. This is the current state of the art for sample-efficient prompt optimization — important for us because rollouts cost real API money.
- **OPRO** ([Yang et al., arXiv 2309.03409](https://arxiv.org/abs/2309.03409)) — "Large Language Models as Optimizers." _"In each optimization step, the LLM generates new solutions from the prompt that contains previously generated solutions with their values."_ Up to 8% gain on GSM8K, up to 50% on Big-Bench Hard. Simple enough to hand-roll if we ever want a dependency-free optimizer.
- **TypeScript reality check:** [Ax](https://github.com/ax-llm/ax) is the production TS option — README: _"The pretty much 'official' DSPy framework for Typescript"_ / _"one programming model for building with LLMs across TypeScript, Python, Java, C++, Go, and Rust"_; supports **GEPA** ("multi-objective Pareto optimizer… returns a Pareto front") and `AxBootstrapFewShot`, with "portable optimizer artifacts, and evaluation/apply flows," and is _"designed to stay in the same latency class as direct provider calls."_ Alternative: keep the app free of new frameworks and run DSPy/GEPA **offline** in a `scripts/` Python sidecar (fine — optimization is a batch job, not a request-path concern), emitting a JSON prompt artifact the TS app loads.

**Implication for Buwiz Books:** optimization runs offline against the Phase-1 dataset with the Phase-2 graders as the metric; the output is a _versioned prompt artifact in git_, promoted only after the CI eval gate + PR review. Never optimize in the request path.

## 4. Self-improving harness frameworks (Claude Agent SDK + Skills)

- **What a "harness" is (Anthropic's definition):** infrastructure around the model — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) distinguishes **workflows** ("predefined code paths") from **agents** that "dynamically direct their own processes," and names the **evaluator-optimizer** workflow (generate → evaluate → refine loop) that our repair loop and eval gate instantiate. Core philosophy, quoted: _"Success in the LLM space isn't about building the most sophisticated system. It's about building the right system for your needs"_; add complexity _"only when it demonstrably improves outcomes."_ [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) shows the harness-as-files pattern (initializer, progress log, feature checklist, git recovery, end-to-end verification before marking anything done).
- **Claude Agent SDK** ([official docs](https://code.claude.com/docs/en/agent-sdk/overview)) — `@anthropic-ai/claude-agent-sdk` (TypeScript) gives _"the same tools, agent loop, and context management that power Claude Code"_: built-in Read/Edit/Bash/Grep tools, **hooks** (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`… — callback functions to "validate, log, block, or transform agent behavior"), **subagents** (scoped `AgentDefinition`s with restricted tool lists), **permissions** (`allowedTools`/`disallowedTools`), sessions, MCP, and filesystem config (`.claude/skills/*/SKILL.md`, `CLAUDE.md`).
- **Agent Skills** ([Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)) — a skill is _"a directory containing a SKILL.md file"_ loaded by progressive disclosure. The recommended improvement loop is eval-first: _"identify specific gaps in your agents' capabilities by running them on representative tasks and observing where they struggle,"_ then _"ask Claude to capture its successful approaches and common mistakes into reusable context and code within a skill."_ On autonomy, Anthropic is explicit that self-generation is aspirational, not current: _"we hope to enable agents to create, edit, and evaluate Skills on their own."_ Security: _"installing skills only from trusted sources"_; audit unfamiliar skills.

**Implication for Buwiz Books:** the Agent SDK is the right chassis for an **offline "improvement agent"** (Phase 3): a CI/cron job that reads the failure log, drafts prompt/lesson updates, runs the eval suite, and opens a PR — with hooks auditing every file touch and permissions restricting it to the prompts directory. It is _not_ needed inside the product's request path, where the multi-provider `aiComplete` façade already fits our structured-output workloads.

## 5. Feedback capture in-product

- **Our best signal is corrections, not thumbs.** Every OCR/parse/classify/match result is shown in an editable form; the diff between AI output and what the user saves is a labeled example. This matches Anthropic's instruction to build evals from _"user-reported failures"_ ([Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)) and Braintrust's model where **"Expected values: corrections that show what the correct output should have been"** sit alongside **"Scores: numeric ratings like thumbs up/down (1 or 0)"** ([Braintrust user feedback](https://www.braintrust.dev/docs/instrument/user-feedback)).
- If we later want a hosted review UI: Braintrust `logger.logFeedback({id, scores, comment, metadata})` attaches feedback to a logged span (return the span/request ID to the client so the feedback endpoint can reference it); its [human review](https://www.braintrust.dev/docs/guides/human-review) workflow then curates logs into datasets. LangSmith equivalent: `client.createFeedback(runId, "user_feedback", {score, comment})` ([LangSmith docs](https://docs.langchain.com/langsmith/attach-user-feedback)).
- **Recommendation: own the flywheel in Postgres first.** We already have Drizzle + RLS + org scoping; an `ai_run` table (task, prompt_version, provider/model, input ref, raw output, parsed output, latency, cost) + an `ai_run_feedback` table (correction diff, optional thumb, user id) is a day of work and keeps finance documents inside our trust boundary (no third-party data processor questions). Export-to-Braintrust later is trivial if we want their UI.

## 6. Safety rails — why unbounded self-modification is out

- **Anthropic's baseline stance** ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)): agents' _"autonomous nature means higher costs, and the potential for compounding errors. We recommend extensive testing in sandboxed environments, along with appropriate guardrails"_; agents should _"pause for human feedback at checkpoints"_; _"human review remains crucial."_
- **Indirect prompt injection is our #1 threat.** Uploaded bills/receipts/statements are third-party content; Anthropic's guardrails doc ([Mitigate jailbreaks and prompt injections](https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)) names OCR output explicitly (_"OCR text extracted from a user-uploaded image"_) and prescribes: deliver untrusted content **only in tool_result blocks / JSON-encoded** (_"JSON escaping provides unambiguous delimiters… an attacker cannot close a quote or tag to 'break out'"_), state an untrusted-content policy in the system prompt, apply least privilege (_"don't give Claude access to secrets it doesn't need, run tools in sandboxed environments"_), screen tool outputs with a lightweight classifier, and _"red-team your own agent."_ Their multilayered worked example is literally a financial-advisor bot.
- **Self-written memory is an attack surface.** The [memory tool docs](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/memory-tool) require path-traversal validation, size caps, and expiry on anything the model writes. For us: a poisoned invoice could try to write "always classify payments to X as refunds" into an org's lessons file → lessons must be size-capped, org-scoped, human-visible, and _never_ able to alter graders, schemas, or permissions.
- **Sandbox any code-executing improvement agent.** Claude Code's [sandboxing docs](https://code.claude.com/docs/en/sandboxing) describe OS-enforced isolation (Seatbelt on macOS, bubblewrap on Linux): default write access limited to the working directory, network via allowlisted domains through a proxy, and — key detail — _"the sandbox automatically denies write access to Claude Code's settings.json files at every scope… so a sandboxed command can't modify its own policy."_ Also: _"effective sandboxing requires both filesystem and network isolation. Without network isolation, a compromised agent could exfiltrate sensitive files."_ The same primitives ship standalone as [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime). Apply the identical principle to our improvement agent: it may write only `src/lib/ai/prompts/**`, and it opens PRs — it never deploys.
- **Versioning + rollback.** Prompts, lessons-schema, and eval datasets live in git with immutable version IDs recorded on every `ai_run` row; rollback = revert commit; the CI eval gate (Anthropic's harness post: tests must not be weakened to pass — _"it is unacceptable to remove or edit tests"_) blocks silent regressions. Skills guidance reinforces the human gate: install/accept only _"from trusted sources"_ — and an AI-authored prompt is an untrusted source until reviewed.

---

## Phased recommendation for digits

Verified stack constraints: TypeScript-only runtime (Bun + Vite + TanStack Start + Nitro nightly), Zod v4, Vitest 4 + Playwright, Drizzle/Postgres with RLS ([package.json](./package.json)). No Python in the toolchain. All AI calls are already server-side Nitro fns behind org-permission wrappers ([AI_MULTIPROVIDER_PLAN.md](./AI_MULTIPROVIDER_PLAN.md) §1). Phases are sequenced so each ships value alone; 1–2 are prerequisites for everything else.

### Phase 1 — Capture the flywheel (run log + corrections + prompt registry)

1. **Prompt registry in code.** Move each call site's prompt into `src/lib/ai/prompts/<task>.ts` exporting `{ id, version, system, build(input) }`. Deterministic version string (semver or content hash). This is the unit everything else versions, evals, and optimizes.
2. **`ai_run` table** (Drizzle): task, promptId+version, provider/model (from the multi-provider router), input reference (document id — don't duplicate blobs), parsed output JSON, Zod-parse ok/fail, repair-loop count, latency, token usage. Written inside the existing server fns; org-scoped with RLS.
3. **`ai_run_feedback` table:** when a user saves an edited OCR/parse/match result, store the field-level diff vs. the AI output (+ optional thumbs widget on AI-generated surfaces). Corrections are ground truth per [Braintrust's scores/expected model](https://www.braintrust.dev/docs/instrument/user-feedback) and Anthropic's "convert user-reported failures into test cases."
4. **Curation script** `scripts/build-eval-dataset.ts`: pull corrected + uncorrected-sampled runs into per-task JSONL fixtures under `tests/evals/datasets/` (redact/synthesize where needed). Target per Anthropic: **20–50 tasks per category from real failures**.

_Effort: small. No new dependencies. Prereq for everything below._

### Phase 2 — Eval harness with a CI regression gate

1. **Vitest eval suite** `tests/evals/`: replays each dataset row through `aiComplete` (or, cheaper, through recorded-response fixtures for PR CI, live models on a nightly job). Graders per Anthropic's taxonomy:
   - **Code graders** (default): Zod parse success; exact match on amounts, dates, currencies, account codes; tolerance windows; LIKE-escaped-name checks. _"Fast, objective, reproducible."_
   - **LLM-as-judge** (only where needed): description/category plausibility — binary rubric, and per Anthropic _use a different model than the one that generated the output_.
2. **Metrics & gate:** report per-task pass rate; run flaky-sensitive tasks k times and track **pass^k** (finance = reliability). CI gate: a PR that changes a prompt version, model default, or adapter must not drop any task's pass rate below its recorded baseline (baseline file checked in, like a snapshot).
3. **Provider-change protection:** this same gate is what makes the multi-provider migration safe — switching a task from Gemini to Claude/GPT is just a config change that must pass the eval suite first.

_Effort: moderate. Uses existing Vitest infra. Deliverable: `bun test:evals` + nightly live-model run._

### Phase 3 — Reflection & lessons memory (bounded, human-visible)

1. **Request-path repair loop** (already planned as §2.5 of the multiprovider plan) = one-shot Reflexion: on Zod failure, feed the validation error back once. Log repair counts to `ai_run` — rising repair rates are an early-warning metric.
2. **Per-org lessons:** a weekly job summarizes that org's correction diffs into ≤N-token "lessons" notes (per task), stored org-scoped in Postgres, rendered in settings (transparency), injected into prompts as JSON-encoded _data_ with an untrusted-content preamble per [Anthropic's injection guidance](https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks). Guards from the [memory tool docs](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/memory-tool): size caps, expiry, no ability to reference or alter schemas/graders. A/B the lesson-injected prompt against baseline on the org's own eval slice before enabling.

### Phase 4 — Automated prompt iteration behind human review gates

1. **Optimizer, offline only.** Two viable routes — pick after a spike:
   - **[Ax](https://github.com/ax-llm/ax)** (TS): signatures + GEPA/bootstrap optimizers natively in our language; "portable optimizer artifacts" fit the check-into-git model.
   - **DSPy/GEPA Python sidecar** in `scripts/optimize/` (batch job, not app code): the reference implementations of [MIPROv2/GEPA](https://dspy.ai/), maximum optimizer maturity. GEPA's 35×-fewer-rollouts sample efficiency ([arXiv 2507.19457](https://arxiv.org/abs/2507.19457)) directly caps optimization API spend.
     The metric fed to the optimizer = the Phase-2 graders; the training/val split = the Phase-1 dataset.
2. **Improvement agent (optional, Claude Agent SDK):** a scheduled job using `@anthropic-ai/claude-agent-sdk` — subagent restricted via `allowedTools` + permissions to read the failure log and edit only `src/lib/ai/prompts/**` and `tests/evals/datasets/**`, `PostToolUse` hooks auditing every write, sandboxed execution ([sandboxing docs](https://code.claude.com/docs/en/sandboxing) / `@anthropic-ai/sandbox-runtime`) — that drafts a prompt-bump PR with the eval delta in the description.
3. **Promotion path (the hard gate, in order):** optimizer/agent proposes → CI eval gate (no task below baseline; datasets/graders unchanged — _"unacceptable to remove or edit tests"_) → **human PR review** → merge = new prompt version → `ai_run` rows record it → rollback is a git revert. No runtime path may mutate prompts, lessons-schema, graders, or its own permissions — the loop is closed by humans, per Anthropic's checkpoint guidance.

### Explicit non-goals

- No runtime self-modification of prompts/graders/permissions (Phase 4 promotion path is the only mutation channel).
- No dependency on OpenAI's Evals platform (read-only 2026-10-31).
- No fine-tuning workstream — prompt + exemplar optimization first; it's cheaper, provider-portable (we're multi-provider by design), and reversible.
- No third-party eval SaaS in the critical path (finance documents stay in our trust boundary; Braintrust/LangSmith remain an optional later UI layer).

---

## Sources

**Anthropic (docs + first-party engineering posts)**

- Develop tests / eval guidance — https://platform.claude.com/docs/en/docs/test-and-evaluate/develop-tests
- Demystifying evals for AI agents — https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Building effective agents — https://www.anthropic.com/engineering/building-effective-agents
- Effective harnesses for long-running agents — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Equipping agents for the real world with Agent Skills — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Memory tool — https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/memory-tool
- Mitigate jailbreaks and prompt injections — https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks
- Claude Agent SDK overview — https://code.claude.com/docs/en/agent-sdk/overview
- Claude Code sandboxing — https://code.claude.com/docs/en/sandboxing
- Sandbox runtime — https://github.com/anthropic-experimental/sandbox-runtime

**Papers (arXiv)**

- Reflexion: Language Agents with Verbal Reinforcement Learning — https://arxiv.org/abs/2303.11366
- Voyager: An Open-Ended Embodied Agent with Large Language Models — https://arxiv.org/abs/2305.16291
- GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning — https://arxiv.org/abs/2507.19457
- Large Language Models as Optimizers (OPRO) — https://arxiv.org/abs/2309.03409

**Frameworks & tooling (official docs/repos)**

- DSPy — https://dspy.ai/
- Ax (DSPy for TypeScript) — https://github.com/ax-llm/ax
- OpenAI Evals repo — https://github.com/openai/evals
- OpenAI Evals guide (deprecation notice) — https://developers.openai.com/api/docs/guides/evals
- Braintrust human review — https://www.braintrust.dev/docs/guides/human-review
- Braintrust user feedback (`logFeedback`) — https://www.braintrust.dev/docs/instrument/user-feedback
- LangSmith attach user feedback — https://docs.langchain.com/langsmith/attach-user-feedback

**Repo context**

- /Volumes/goldcoders/digits/AI_MULTIPROVIDER_PLAN.md (aiComplete façade, Zod-as-schema, 8 call sites, credential model)
- /Volumes/goldcoders/digits/package.json (Bun/TS/Vitest/Zod/Drizzle stack — no Python)
