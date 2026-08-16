import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { EmptyCatalogNotice } from "../../src/components/review-agents/EmptyCatalogNotice";

/**
 * The state /review-agents was stuck in for as long as the catalog went unseeded.
 *
 * It cannot be reached through Playwright route interception — the page's query runs during SSR,
 * so there is no client request to stub — and emptying `review_rule_definitions` mid-suite would
 * corrupt every other spec, because it is a global table with no organization_id.
 */
describe("EmptyCatalogNotice", () => {
  it("names what is missing, what it costs, and who fixes it", () => {
    render(<EmptyCatalogNotice onReload={() => {}} />);

    expect(screen.getByText("No review agents are set up yet")).toBeInTheDocument();

    // The old copy was "No review agents are configured." — true, and useless.
    const description = screen.getByText(/shared catalogue/i);
    expect(description).toHaveTextContent(/nothing checks your books automatically/i);
    expect(description).toHaveTextContent(/no findings can be raised/i);
    expect(description).toHaveTextContent(/ask your administrator/i);
  });

  it("offers a way out rather than a dead end", async () => {
    const onReload = vi.fn();
    const user = userEvent.setup();

    render(<EmptyCatalogNotice onReload={onReload} />);
    await user.click(screen.getByRole("button", { name: "Reload" }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("renders a glyph rather than the grey placeholder box", () => {
    const { container } = render(<EmptyCatalogNotice onReload={() => {}} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("is a single full-width panel, not a two-column shell", () => {
    const { container } = render(<EmptyCatalogNotice onReload={() => {}} />);
    // The page renders this INSTEAD of the agent list/detail grid; a 320px empty rail beside the
    // words "no agents" was the original absurdity.
    expect(container.querySelectorAll("aside")).toHaveLength(0);
    expect(container.querySelector('[class*="lg:grid-cols-"]')).toBeNull();
  });
});
