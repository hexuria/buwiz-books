import React from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  EntityReadinessBadge,
  EntityReadinessPanel,
} from "../../src/components/business-groups/EntityReadinessPanel";
import type {
  EntityReadiness,
  EntityReadinessSummary,
} from "../../src/lib/business-groups/performance";

const readiness: EntityReadiness[] = [
  {
    organizationId: "organization-ready",
    name: "Northline Services",
    groupIds: ["group-operating"],
    groupNames: ["Operating Companies"],
    status: "ready",
    projectionAsOf: "2026-08-01T11:58:00.000Z",
    syncActivityAt: "2026-08-01T11:58:30.000Z",
    syncAgeSeconds: 0,
    ledgerLagSeconds: 0,
  },
  {
    organizationId: "organization-stale",
    name: "Juniper Industrial",
    groupIds: ["group-operating", "group-regional"],
    groupNames: ["Operating Companies", "Regional Portfolio"],
    status: "stale",
    projectionAsOf: "2026-08-01T11:40:00.000Z",
    syncActivityAt: "2026-08-01T11:47:59.000Z",
    syncAgeSeconds: 721,
    ledgerLagSeconds: 60,
  },
];

const summary: EntityReadinessSummary = {
  total: 2,
  page: 1,
  pageSize: 25,
  returnedCount: 2,
  statusCounts: { missing: 0, pending: 0, building: 0, ready: 1, stale: 1, failed: 0 },
};

describe("EntityReadinessPanel", () => {
  it("summarizes readiness and exposes business details through a native disclosure", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EntityReadinessPanel readiness={readiness} summary={summary} sourceMode="projected" />,
    );

    expect(screen.getByRole("heading", { name: "Business data readiness" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("1/2 current");
    expect(screen.getAllByText("Delayed").length).toBeGreaterThan(0);

    await user.click(screen.getByText("Juniper Industrial"));

    expect(screen.getAllByText("Request or job age").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ledger projection gap").length).toBeGreaterThan(0);
    expect(screen.getByText("13 minutes")).toBeVisible();
    expect(screen.getByText("1 minute")).toBeVisible();
    expect(screen.getAllByText("Operating Companies, Regional Portfolio").length).toBeGreaterThan(
      0,
    );
    expect(container.querySelector('time[datetime="2026-08-01T11:40:00.000Z"]')).not.toBeNull();
  });

  it("does not render projection UI for live-ledger readiness", () => {
    const { container } = render(
      <EntityReadinessPanel readiness={[]} summary={null} sourceMode="live_ledger" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps live-ledger badges out of the performance ranking", () => {
    const { container } = render(<EntityReadinessBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states that live totals remain available in shadow mode", () => {
    render(<EntityReadinessPanel readiness={readiness} summary={summary} sourceMode="shadow" />);
    expect(screen.getByText(/Live-ledger totals remain available/)).toBeVisible();
  });

  it("paginates a bounded readiness result without rendering hidden rows", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const oversizedReadiness = Array.from({ length: 30 }, (_, index) => ({
      ...readiness[index % readiness.length],
      organizationId: `organization-${index}`,
      name: `Business ${index}`,
    }));
    render(
      <EntityReadinessPanel
        readiness={oversizedReadiness}
        summary={{ ...summary, total: 30, pageSize: 25, returnedCount: 25 }}
        sourceMode="projected"
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(25);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
