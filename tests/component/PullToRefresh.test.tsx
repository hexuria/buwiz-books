import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PullToRefresh } from "../../src/components/ui/PullToRefresh";

function touch(clientY: number, clientX = 0) {
  return { cancelable: true, touches: [{ clientX, clientY }] };
}

describe("PullToRefresh", () => {
  it("refreshes after the user pulls past the threshold", async () => {
    let resolveRefresh: (() => void) | undefined;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh} threshold={40}>
        <div>Portfolio content</div>
      </PullToRefresh>,
    );
    const root = container.firstElementChild;

    expect(root).toHaveAttribute("data-pull-to-refresh", "true");
    fireEvent.touchStart(root!, touch(0));
    fireEvent.touchMove(root!, touch(120));
    expect(screen.getByRole("status")).toHaveTextContent("Release to refresh");

    fireEvent.touchEnd(root!);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing…");

    resolveRefresh?.();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("does not refresh when the gesture does not reach the threshold", async () => {
    const onRefresh = vi.fn();
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh} threshold={80}>
        <div>Portfolio content</div>
      </PullToRefresh>,
    );
    const root = container.firstElementChild;

    fireEvent.touchStart(root!, touch(0));
    fireEvent.touchMove(root!, touch(80));
    fireEvent.touchEnd(root!);

    await waitFor(() => expect(onRefresh).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores pulls that begin on controls", async () => {
    const onRefresh = vi.fn();
    render(
      <PullToRefresh onRefresh={onRefresh} threshold={40}>
        <button type="button">Keep scrolling</button>
      </PullToRefresh>,
    );
    const button = screen.getByRole("button", { name: "Keep scrolling" });

    fireEvent.touchStart(button, touch(0));
    fireEvent.touchMove(button, touch(120));
    fireEvent.touchEnd(button);

    await waitFor(() => expect(onRefresh).not.toHaveBeenCalled());
  });
});
