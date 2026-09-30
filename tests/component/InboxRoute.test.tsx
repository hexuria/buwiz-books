import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

/**
 * /inbox is the Inbox v2 screen and nothing else: no rollout flag is read, no classic page can
 * render, and the URL's `?selected=` is the item the screen opens. Selecting another item writes
 * it back to the URL (replacing history when the screen asks, as after an approval).
 */

const router = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: (path: string) => (options: Record<string, unknown>) => ({
    options,
    fullPath: path,
    useSearch: () => router.search,
  }),
  useNavigate: () => router.navigate,
}));

type PageProps = {
  selectedId?: string;
  onSelect: (id: string | undefined, options?: { replace?: boolean }) => void;
};
const page = vi.hoisted(() => ({ props: null as PageProps | null }));
vi.mock("../../src/components/inbox-v2/InboxV2Page", () => ({
  InboxV2Page: (props: PageProps) => {
    page.props = props;
    return (
      <div data-testid="inbox">
        selected: {props.selectedId ?? "none"}
        <button type="button" onClick={() => props.onSelect("item-7")}>
          open item-7
        </button>
        <button type="button" onClick={() => props.onSelect(undefined, { replace: true })}>
          close
        </button>
      </div>
    );
  },
}));

type RouteOptions = {
  component: React.ComponentType;
  validateSearch: (search: Record<string, unknown>) => Record<string, unknown>;
};

async function loadRoute(): Promise<RouteOptions> {
  const { Route } = await import("../../src/routes/inbox");
  return (Route as unknown as { options: RouteOptions }).options;
}

beforeEach(() => {
  vi.clearAllMocks();
  router.search = {};
  page.props = null;
});

describe("/inbox", () => {
  it("renders the one Inbox with the URL's selection", async () => {
    router.search = { selected: "item-42" };
    const { component: Component } = await loadRoute();
    render(<Component />);
    expect(screen.getByTestId("inbox")).toHaveTextContent("selected: item-42");
    expect(screen.queryByText("Review queue")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Loading Inbox")).not.toBeInTheDocument();
  });

  it("writes a selection back to the URL, replacing history when asked", async () => {
    const user = userEvent.setup();
    const { component: Component } = await loadRoute();
    render(<Component />);

    await user.click(screen.getByRole("button", { name: "open item-7" }));
    expect(router.navigate).toHaveBeenCalledTimes(1);
    const first = router.navigate.mock.calls[0][0] as {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
      replace?: boolean;
    };
    expect(first.search({ selected: "item-1" })).toEqual({ selected: "item-7" });
    expect(first.replace).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "close" }));
    const second = router.navigate.mock.calls[1][0] as {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
      replace?: boolean;
    };
    expect(second.search({ selected: "item-7" })).toEqual({ selected: undefined });
    expect(second.replace).toBe(true);
  });

  it("keeps only a string selection; an old ?state= filter is dropped", async () => {
    const { validateSearch } = await loadRoute();
    expect(validateSearch({ selected: "item-9", state: "approved" })).toEqual({
      selected: "item-9",
    });
    expect(validateSearch({ selected: 12, state: "all" })).toEqual({ selected: undefined });
  });
});
