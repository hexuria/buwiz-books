import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "../../src/components/ui/EmptyState";
import { CheckCircleIcon, SearchIcon } from "../../src/components/ui/icons";

describe("EmptyState", () => {
  it("renders the title, description, icon and action", () => {
    const { container } = render(
      <EmptyState
        icon={<SearchIcon size={28} strokeWidth={1.5} />}
        title="No matching transactions"
        description="Try a different transaction, vendor, or source name."
        action={<button type="button">Reload</button>}
      />,
    );

    expect(screen.getByText("No matching transactions")).toBeInTheDocument();
    expect(
      screen.getByText("Try a different transaction, vendor, or source name."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // A real glyph, not the grey placeholder box this component replaced.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("omits the action wrapper when no action is given", () => {
    render(
      <EmptyState
        icon={<SearchIcon />}
        title="This queue is clear"
        description="Nothing to review."
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("maps each tone to its own tint", () => {
    const tintOf = (tone: "neutral" | "success" | "error" | "info") => {
      const { container, unmount } = render(
        <EmptyState icon={<CheckCircleIcon />} title="t" description="d" tone={tone} />,
      );
      const className = container.querySelector("svg")!.parentElement!.className;
      unmount();
      return className;
    };

    expect(tintOf("success")).toContain("emerald");
    expect(tintOf("error")).toContain("rose");
    expect(tintOf("info")).toContain("teal");
    expect(tintOf("neutral")).toContain("slate");
  });

  it("uses the larger metrics at size md", () => {
    const circleOf = (size: "sm" | "md") => {
      const { container, unmount } = render(
        <EmptyState icon={<CheckCircleIcon />} title="t" description="d" size={size} />,
      );
      const className = container.querySelector("svg")!.parentElement!.className;
      unmount();
      return className;
    };

    // Reproduces reconciliations.tsx (h-14) and documents.tsx (h-20) exactly, so retrofitting
    // either of those later is a pure deletion with no visual diff.
    expect(circleOf("sm")).toContain("h-14");
    expect(circleOf("md")).toContain("h-20");
  });
});

describe("inline SVG icons", () => {
  it("hides decorative glyphs from assistive tech", () => {
    const { container } = render(<SearchIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
  });

  it("keeps the repo's inline-SVG convention rather than an icon package", () => {
    const { container } = render(<SearchIcon size={14} strokeWidth={2} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.getAttribute("stroke-width")).toBe("2");
  });
});
