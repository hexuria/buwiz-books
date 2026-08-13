import { describe, expect, it, vi } from "vitest";

const { limitMock } = vi.hoisted(() => ({ limitMock: vi.fn() }));

vi.mock("../../../src/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: limitMock })),
      })),
    })),
  },
}));

import { AiSettingsUnavailableError, getOrgAiSettings } from "../../../src/lib/ai/settings";

describe("organization AI settings database adapter", () => {
  it("turns a settings query failure into a fail-closed typed error", async () => {
    limitMock.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(getOrgAiSettings("org-settings-failure")).rejects.toBeInstanceOf(
      AiSettingsUnavailableError,
    );
  });
});
