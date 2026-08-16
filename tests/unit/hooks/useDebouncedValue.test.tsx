/**
 * Unit tests for useDebouncedValue hook
 */

import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("initial", 500));
    expect(result.current).toBe("initial");
  });

  it("should not update debounced value immediately when value changes", () => {
    const { result, rerender } = renderHook(({ value, delay }) => useDebouncedValue(value, delay), {
      initialProps: { value: "initial", delay: 500 },
    });

    expect(result.current).toBe("initial");

    rerender({ value: "updated", delay: 500 });
    expect(result.current).toBe("initial"); // Should still be initial
  });

  it("should update debounced value after delay", () => {
    const { result, rerender } = renderHook(({ value, delay }) => useDebouncedValue(value, delay), {
      initialProps: { value: "initial", delay: 500 },
    });

    rerender({ value: "updated", delay: 500 });
    expect(result.current).toBe("initial");

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe("updated");
  });

  it("should reset timer when value changes before delay expires", () => {
    const { result, rerender } = renderHook(({ value, delay }) => useDebouncedValue(value, delay), {
      initialProps: { value: "initial", delay: 500 },
    });

    rerender({ value: "first-update", delay: 500 });

    act(() => {
      vi.advanceTimersByTime(250); // Half the delay
    });

    rerender({ value: "second-update", delay: 100 });

    act(() => {
      vi.advanceTimersByTime(100); // Full delay from second update
    });

    expect(result.current).toBe("second-update");
  });

  it("should handle different data types", () => {
    const { result, rerender } = renderHook(({ value, delay }) => useDebouncedValue(value, delay), {
      initialProps: { value: 0, delay: 100 },
    });

    expect(result.current).toBe(0);

    rerender({ value: 42, delay: 100 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(42);

    rerender({ value: { test: "object" } as any, delay: 100 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toEqual({ test: "object" });
  });

  it("should handle zero delay", () => {
    const { result, rerender } = renderHook(({ value, delay }) => useDebouncedValue(value, delay), {
      initialProps: { value: "initial", delay: 0 },
    });

    rerender({ value: "updated", delay: 0 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(result.current).toBe("updated");
  });

  it("should cleanup timer on unmount", () => {
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    const { unmount } = renderHook(() => useDebouncedValue("test", 500));

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });

  it("should handle multiple rapid changes", () => {
    const { result, rerender } = renderHook(({ value, delay }) => useDebouncedValue(value, delay), {
      initialProps: { value: "initial", delay: 100 },
    });

    // Rapidly change value multiple times
    for (let i = 1; i <= 5; i++) {
      rerender({ value: `update-${i}`, delay: 100 });
    }

    // Should still be initial
    expect(result.current).toBe("initial");

    // After delay, should have the last value
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toBe("update-5");
  });
});
