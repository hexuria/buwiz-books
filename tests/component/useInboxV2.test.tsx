import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInboxV2Badge } from "../../src/components/inbox-v2/useInboxV2";

/**
 * The sidebar badge is the Inbox list's own length. There is one Inbox, so the list is always
 * fetched; no rollout flag is asked first.
 */

const api = vi.hoisted(() => ({ listInboxV2: vi.fn() }));
vi.mock("../../src/routes/api/-inbox-v2", () => api);

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useInboxV2Badge", () => {
  it("shows nothing until the list has loaded, then its length", async () => {
    api.listInboxV2.mockResolvedValue({ items: [], truncated: false, beingRead: 0 });
    const { result } = renderHook(() => useInboxV2Badge(), { wrapper });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(0));
    expect(api.listInboxV2).toHaveBeenCalledTimes(1);
  });

  it("is the list's length, with a plus past its ceiling, never the papers being read", async () => {
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

  it("shows nothing when the list cannot be read", async () => {
    api.listInboxV2.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useInboxV2Badge(), { wrapper });
    await waitFor(() => expect(api.listInboxV2).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });
});
