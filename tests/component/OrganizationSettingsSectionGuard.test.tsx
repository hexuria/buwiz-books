import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import type { ReviewRule } from "../../src/components/settings/ReviewRuleConfigForm";

/**
 * Settings sections are local state, not routes. Switching from Review Rules to any other section
 * unmounts it, and no router blocker sees that — so the page itself must ask before a switch would
 * drop an unsaved rule draft, and must not ask when there is nothing to lose.
 *
 * This renders the real settings page. Everything it reads from the server, the session and the
 * router is stubbed; the section switching and the Review Rules section are the real ones.
 */

const api = vi.hoisted(() => ({
  listReviewAgents: vi.fn(),
  updateReviewAgent: vi.fn(),
  runReviewAgents: vi.fn(),
  listReviewFindings: vi.fn(),
  listReviewRuns: vi.fn(),
  resolveReviewFinding: vi.fn(),
}));
vi.mock("../../src/routes/api/-review-agents", () => api);
// Review Rules closes with the rule snapshots card, which reads these two.
vi.mock("../../src/routes/api/-rule-snapshots", () => ({
  listRuleSnapshots: vi.fn(async () => []),
  createRuleSnapshot: vi.fn(),
  pinRoutineRuleSnapshot: vi.fn(),
  unpinRoutineRuleSnapshot: vi.fn(),
}));
vi.mock("../../src/routes/api/-routines", () => ({ listRoutines: vi.fn(async () => []) }));
// …and then with the Inbox's classification memories.
vi.mock("../../src/routes/api/-inbox-memory", () => ({
  listMemories: vi.fn(async () => []),
  enableMemory: vi.fn(),
  disableMemory: vi.fn(),
  deleteMemory: vi.fn(),
  rememberCorrection: vi.fn(),
  previewMemoryScope: vi.fn(),
}));
// Settings → Jev approval reads these; not under test here.
vi.mock("../../src/routes/api/-jev-lanes", () => ({
  listJevLanes: vi.fn(),
  promoteJevLane: vi.fn(),
  demoteJevLane: vi.fn(),
  updateJevLaneLimits: vi.fn(),
  updateJevApprovalSettingsFn: vi.fn(),
  getJevEntryApproval: vi.fn(),
  undoJevApprovalFn: vi.fn(),
}));

vi.mock("../../src/routes/api/-org-settings", () => ({
  getOrgSettings: vi.fn(async () => ({ id: "org-1", name: "Acme Books", slug: "acme" })),
  listOrgMembers: vi.fn(async () => []),
  updateOrgGeminiKeys: vi.fn(),
  updateOrgName: vi.fn(),
  updateMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
  createInvitation: vi.fn(),
  listInvitations: vi.fn(async () => []),
  updateOrgEmailSettings: vi.fn(),
  getOwnerEmail: vi.fn(),
  updateOrgBusinessInfo: vi.fn(),
  updateOrgImageGenerationSetting: vi.fn(),
  updateOrgInboxV2Setting: vi.fn(),
  getOrgAiCredentials: vi.fn(),
  addOrgAiCredential: vi.fn(),
  revokeOrgAiCredential: vi.fn(),
  getOrgAiSettingsForUi: vi.fn(),
  updateOrgAiSettings: vi.fn(),
}));
vi.mock("../../src/routes/api/-tax-module-state", () => ({
  getTaxModuleState: vi.fn(async () => ({
    state: "off",
    filingEnabled: false,
    country: null,
    records: {
      payrollRuns: 0,
      taxCertificates: 0,
      computedReturns: 0,
      withholdingRemittances: 0,
      taxProfiles: 0,
    },
    totalRecords: 0,
  })),
  updateOrganizationCountry: vi.fn(),
}));
// Pulls the export/import server functions in at import time; not under test here.
vi.mock("../../src/components/settings/ExportImportSection", () => ({
  ExportImportSection: () => null,
}));
vi.mock("../../src/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: () => ({ canAccess: true, isLoading: false }),
  // General's New Inbox switch is admin-only.
  useRole: () => ({ role: "owner", isLoading: false }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ orgId: "org-1" }),
    useSearch: () => ({}),
  }),
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useBlocker: () => ({ status: "idle" }),
}));

import { Route } from "../../src/routes/organization.$orgId.settings";

const MISSING_VENDOR = {
  definitionId: "00000000-0000-4000-8000-000000000001",
  key: "missing_vendor",
  name: "Missing Vendor",
  group: "book",
  description: null,
  configurable: true,
  formulaVersion: 1,
  configId: "cfg-missing-vendor",
  enabled: true,
  impact: "blocking",
  lookbackMonths: 3,
  configJson: "{}",
  version: 2,
  updatedAt: null,
  openFindingCount: 0,
  lastRunAt: null,
} satisfies ReviewRule;

function renderSettingsPage() {
  const SettingsPage = Route.options.component as unknown as React.ComponentType;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openReviewRules(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Review Rules" }));
  await user.click(await screen.findByRole("button", { name: "Edit Missing Vendor" }));
}

beforeEach(() => {
  api.listReviewAgents.mockReset().mockResolvedValue([MISSING_VENDOR]);
  api.updateReviewAgent.mockReset().mockResolvedValue({ id: "cfg", version: 3 });
});

describe("Organization settings — leaving Review Rules", () => {
  it("switches straight away when no rule has unsaved edits", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await openReviewRules(user);
    await user.click(screen.getByRole("button", { name: "General" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("heading", { name: "General", level: 2 })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Review Rules", level: 2 })).toBeNull();
  });

  it("asks in the page before a switch would drop an unsaved draft", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await openReviewRules(user);
    await user.click(screen.getByRole("switch", { name: "Enable Missing Vendor" }));
    await user.click(screen.getByRole("button", { name: "General" }));

    const prompt = await screen.findByRole("alertdialog");
    expect(prompt).toHaveTextContent("Discard them and open General?");
    // Asked before unmounting: the section and its draft are still there.
    expect(screen.getByRole("heading", { name: "Review Rules", level: 2 })).toBeVisible();

    await user.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("switch", { name: "Enable Missing Vendor" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(await screen.findByRole("heading", { name: "General", level: 2 })).toBeVisible();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not ask once the draft is saved", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await openReviewRules(user);
    await user.click(screen.getByRole("switch", { name: "Enable Missing Vendor" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateReviewAgent).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("heading", { name: "General", level: 2 })).toBeVisible();
  });
});
