import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import { RememberThisPrompt } from "../../src/components/inbox-v2/RememberThisPrompt";

/**
 * "Remember this?" (Inbox v2 §7): pick a scope, see what it would have done to the last 12
 * months of papers, save. The server functions are mocked, so the assertions are on exactly what
 * would be sent — the permission checks themselves live on the server and are pinned in
 * tests/integration/inbox-memory.test.ts.
 */

const api = vi.hoisted(() => ({
  rememberCorrection: vi.fn(),
  previewMemoryScope: vi.fn(),
  listMemories: vi.fn(),
  enableMemory: vi.fn(),
  disableMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox-memory", () => api);

const CANDIDATE_ID = "00000000-0000-4000-8000-0000000000aa";

function preview(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    scope: "file_hash",
    keyLabel: "File receipt-4242.pdf",
    requiresAdmin: false,
    allowed: true,
    matched: 3,
    changed: 2,
    examined: 40,
    capped: false,
    windowMonths: 12,
    existingMemory: null,
    ...overrides,
  };
}

function renderPrompt(props: Partial<Parameters<typeof RememberThisPrompt>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RememberThisPrompt candidateId={CANDIDATE_ID} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  vi.clearAllMocks();
  api.previewMemoryScope.mockImplementation(async ({ data }: { data: { scope: string } }) =>
    preview({ scope: data.scope }),
  );
});

describe("RememberThisPrompt", () => {
  it("previews the default scope with what it would have changed", async () => {
    renderPrompt();
    expect(await screen.findByTestId("memory-preview-count")).toHaveTextContent(
      "Would have changed 2 of 3 past papers in the last 12 months.",
    );
    expect(screen.getByText("File receipt-4242.pdf")).toBeInTheDocument();
    expect(api.previewMemoryScope).toHaveBeenCalledWith({
      data: { candidateId: CANDIDATE_ID, scope: "file_hash" },
    });
    expect(screen.getByRole("radio", { name: /This file/u })).toBeChecked();
  });

  it("offers the four scopes and previews the one picked", async () => {
    const user = userEvent.setup();
    renderPrompt();
    for (const label of ["This file", "This sender", "This party", "These words"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label, "u") })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("radio", { name: /This sender/u }));
    await waitFor(() =>
      expect(api.previewMemoryScope).toHaveBeenLastCalledWith({
        data: { candidateId: CANDIDATE_ID, scope: "sender_party" },
      }),
    );
  });

  it("saves the correction for the chosen scope, pinned to the revision on screen", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const result = {
      memoryId: "00000000-0000-4000-8000-0000000000bb",
      matchKind: "party",
      keyLabel: "Staples",
      replaced: false,
      evalCaseId: "00000000-0000-4000-8000-0000000000cc",
    };
    api.rememberCorrection.mockResolvedValue(result);
    renderPrompt({ candidateRevision: 4, onSaved });
    await user.click(screen.getByRole("radio", { name: /This party/u }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(result));
    expect(api.rememberCorrection).toHaveBeenCalledWith({
      data: { candidateId: CANDIDATE_ID, scope: "party", expectedRevision: 4 },
    });
    expect(await screen.findByText("Remembered for Staples.")).toBeInTheDocument();
  });

  it("cannot save a scope the paper has nothing for, and says why", async () => {
    api.previewMemoryScope.mockResolvedValue({
      available: false,
      scope: "file_hash",
      reason: "This paper has no stored file to remember it by.",
    });
    renderPrompt();
    expect(
      await screen.findByText("This paper has no stored file to remember it by."),
    ).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("explains that a cross-party scope needs an owner or admin, and holds Save", async () => {
    const user = userEvent.setup();
    api.previewMemoryScope.mockImplementation(async ({ data }: { data: { scope: string } }) =>
      data.scope === "line_text"
        ? preview({
            scope: "line_text",
            keyLabel: "paper printer",
            requiresAdmin: true,
            allowed: false,
          })
        : preview({ scope: data.scope }),
    );
    renderPrompt();
    await user.click(screen.getByRole("radio", { name: /These words/u }));
    expect(await screen.findByText(/only an owner or admin can save it/u)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(api.rememberCorrection).not.toHaveBeenCalled();
  });

  it("lets an admin save a cross-party scope", async () => {
    api.previewMemoryScope.mockResolvedValue(
      preview({ scope: "line_text", requiresAdmin: true, allowed: true }),
    );
    renderPrompt({ defaultScope: "line_text" });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.queryByText(/only an owner or admin/u)).not.toBeInTheDocument();
  });

  it("says when no past paper matches, and when it replaces a memory", async () => {
    api.previewMemoryScope.mockResolvedValue(
      preview({ matched: 0, changed: 0, existingMemory: { id: "m1", enabled: false } }),
    );
    renderPrompt();
    expect(await screen.findByTestId("memory-preview-count")).toHaveTextContent(
      "No past papers in the last 12 months match.",
    );
    expect(screen.getByText(/replaces the answer already remembered/u)).toHaveTextContent(
      "it is turned off; saving turns it on",
    );
  });

  it("notes when the preview only read the newest papers", async () => {
    api.previewMemoryScope.mockResolvedValue(preview({ capped: true, examined: 500 }));
    renderPrompt();
    expect(await screen.findByTestId("memory-preview-count")).toHaveTextContent(
      "(Checked the newest 500.)",
    );
  });

  it("shows the server's reason when a save is refused", async () => {
    const user = userEvent.setup();
    api.rememberCorrection.mockRejectedValue(
      new Error("Correct the draft first — Remember this saves a person's correction."),
    );
    renderPrompt();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Correct the draft first");
  });

  it("can be dismissed", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderPrompt({ onDismiss });
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(api.rememberCorrection).not.toHaveBeenCalled();
  });

  it("asks what kind of paper an unknown-kind entry is, then saves with that kind", async () => {
    const user = userEvent.setup();
    api.previewMemoryScope.mockImplementation(
      async ({ data }: { data: { scope: string; docKind?: string } }) =>
        data.docKind
          ? preview({ scope: data.scope })
          : {
              available: false,
              scope: data.scope,
              reason: "Choose what kind of paper this is before remembering it.",
              kindOptions: ["purchase", "bill_accrual"],
            },
    );
    api.rememberCorrection.mockResolvedValue({
      memoryId: "m1",
      matchKind: "file_hash",
      keyLabel: "File receipt-4242.pdf",
      replaced: false,
      evalCaseId: "e1",
    });
    renderPrompt();

    const kind = await screen.findByLabelText("What kind of paper is this?");
    expect(saveButton()).toBeDisabled();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Choose a kind…",
      "Purchase or receipt (already paid)",
      "Vendor bill (to pay later)",
    ]);

    await user.selectOptions(kind, "purchase");
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(api.previewMemoryScope).toHaveBeenLastCalledWith({
      data: { candidateId: CANDIDATE_ID, scope: "file_hash", docKind: "purchase" },
    });

    await user.click(saveButton());
    await waitFor(() =>
      expect(api.rememberCorrection).toHaveBeenCalledWith({
        data: { candidateId: CANDIDATE_ID, scope: "file_hash", docKind: "purchase" },
      }),
    );
  });

  it("stays hidden when no kind of paper fits the entry", async () => {
    api.previewMemoryScope.mockResolvedValue({
      available: false,
      scope: "file_hash",
      reason: "Choose what kind of paper this is before remembering it.",
      kindOptions: [],
    });
    const { container } = renderPrompt();
    await waitFor(() => expect(api.previewMemoryScope).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
