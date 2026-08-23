import { describe, expect, it, vi } from "vitest";

import { AiSettingsUnavailableError, getOrgAiSettings } from "../../../src/lib/ai/settings";
import type { DbExecutor } from "../../../src/db";

describe("organization AI settings database adapter", () => {
  it("turns a settings query failure into a fail-closed typed error", async () => {
    // getOrgAiSettings takes the caller's executor now (org-context
    // discipline) — the failing executor is passed directly, no module mock.
    const limitMock = vi.fn().mockRejectedValueOnce(new Error("database unavailable"));
    const executor = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: limitMock })),
        })),
      })),
    } as unknown as DbExecutor;

    await expect(getOrgAiSettings(executor, "org-settings-failure")).rejects.toBeInstanceOf(
      AiSettingsUnavailableError,
    );
  });
});
