import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInboxV2Badge, useInboxV2Enabled } from "../../src/components/inbox-v2/useInboxV2";

/**
 * The flag hook fails closed — a failed read means the classic Inbox — and the sidebar badge is the
 * v2 list's own length, fetched only for organizations on v2.
 */

const api = vi.hoisted(() => ({ getInboxV2Enabled: vi.fn(), listInboxV2: vi.fn() }));
vi.mock("../../src/routes/api/-inbox-v2", () => api);

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useInboxV2Enabled", () => {
  it("is on only when the server says so", async () => {
    api.getInboxV2Enabled.mockResolvedValue({ enabled: true });
    const { result } = renderHook(() => useInboxV2Enabled(), { wrapper });
    expect(result.current).toEqual({ enabled: false, isPending: true });
    await waitFor(() => expect(result.current).toEqual({ enabled: true, isPending: false }));
  });

  it("falls back to the classic Inbox when the flag cannot be read", async () => {
    api.getInboxV2Enabled.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useInboxV2Enabled(), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.enabled).toBe(false);
  });
});

describe("useInboxV2Badge", () => {
  it("does not fetch the list, and shows nothing, for a classic-Inbox org", async () => {
    api.getInboxV2Enabled.mockResolvedValue({ enabled: false });
    const { result } = renderHook(() => useInboxV2Badge(), { wrapper });
    await waitFor(() => expect(api.getInboxV2Enabled).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
    expect(api.listInboxV2).not.toHaveBeenCalled();
  });

  it("is the list's length, with a plus past its ceiling, never the papers being read", async () => {
    api.getInboxV2Enabled.mockResolvedValue({ enabled: true });
    api.listInboxV2.mockResolvedValue({
      items: [{ id: "a" }, { id: "b" }],
      truncated: false,
      beingRead: 4,
    });
    const first = renderHook(() => useInboxV2Badge(), { wrapper });
    await waitFor(() => expect(first.result.current).toBe(2));

    api.listInboxV2.mockResolvedValue({ items: [{ id: "a" }], truncated: true, beingRead: 0 });
    const second = renderHook(() => useInboxV2Badge(), { wrapper });
    await waitFor(() => expect(second.result.current).toBe("1+"));
  });
});
