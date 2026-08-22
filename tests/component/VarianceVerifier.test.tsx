import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { VarianceVerifier } from "../../src/components/payroll/VarianceVerifier";
import type { PayrollVarianceReport } from "../../src/routes/api/-payroll-variances";

/**
 * D-N7 in the interface: the product files the CLIENT's figure, records the
 * variance and the acknowledgement immutably, and refuses to advance while an
 * unacknowledged blocking variance stands. The product is the control, not the
 * computer of record.
 *
 * The most important assertion here is a NEGATIVE one — that no control exists
 * to overwrite the register with the engine's figure. That would make the
 * ledger disagree with payslips already in employees' hands, in one click and
 * with no record.
 */
const emptyReport: PayrollVarianceReport = {
  runId: "run-1",
  status: "computed",
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  taxableYear: 2026,
  acknowledgedAt: null,
  acknowledgedBy: null,
  journalHeaderId: null,
  taxVariances: [],
  contributionVariances: [],
  contributionChecksSkipped: 0,
  totalLines: 12,
  blockers: [],
};

const withTaxVariance: PayrollVarianceReport = {
  ...emptyReport,
  taxVariances: [
    {
      lineId: "l1",
      employeePartyId: "e1",
      employeeName: "Maria Santos",
      computedTaxWithheld: "1500",
      reportedTaxWithheld: "1200",
      varianceAmount: "300",
      contributionVarianceAmount: null,
      contributionCheckStatus: "checked",
      expectedSssEmployeeShare: null,
      sssEmployeeShare: null,
      expectedPhilHealthEmployeeShare: null,
      philHealthEmployeeShare: null,
      expectedPagIbigEmployeeShare: null,
      pagIbigEmployeeShare: null,
    },
  ],
  blockers: ["1 tax variance(s) are unacknowledged."],
};

describe("VarianceVerifier", () => {
  it("offers NO control that replaces the register with the engine's figure", async () => {
    // The load-bearing assertion. Overwriting here would make the ledger
    // disagree with the payslips employees were handed.
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={vi.fn()} />);

    const buttons = screen.getAllByRole("button").map((b) => b.textContent?.toLowerCase() ?? "");
    for (const label of buttons) {
      expect(label).not.toMatch(/apply|use engine|overwrite|replace|correct|fix/);
    }
  });

  it("shows both figures side by side without preferring one", () => {
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={vi.fn()} />);
    expect(screen.getByText("Maria Santos")).toBeInTheDocument();
    expect(screen.getByText("1,200.00")).toBeInTheDocument();
    expect(screen.getByText("1,500.00")).toBeInTheDocument();
  });

  it("names the direction rather than showing a bare signed number", () => {
    // "300.00 under-withheld" reads correctly at a glance; "300.00" or "-300.00"
    // requires the reader to remember the sign convention.
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={vi.fn()} />);
    expect(screen.getByText(/under-withheld/)).toBeInTheDocument();
  });

  it("states that posting is blocked, and why", () => {
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={vi.fn()} />);
    expect(screen.getByText(/Posting and filing are blocked/)).toBeInTheDocument();
    expect(screen.getByText(/1 tax variance\(s\) are unacknowledged/)).toBeInTheDocument();
  });

  it("refuses to acknowledge without a reason", async () => {
    const onAcknowledge = vi.fn();
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={onAcknowledge} />);

    await userEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));

    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(screen.getByText(/Give a reason/)).toBeInTheDocument();
  });

  it("refuses a whitespace-only reason", async () => {
    const onAcknowledge = vi.fn();
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={onAcknowledge} />);

    await userEvent.type(screen.getByLabelText(/Why do these figures stand/), "   ");
    await userEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));

    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it("passes a trimmed reason through on acknowledgement", async () => {
    const onAcknowledge = vi.fn().mockResolvedValue(undefined);
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={onAcknowledge} />);

    await userEvent.type(
      screen.getByLabelText(/Why do these figures stand/),
      "  Started mid-month; register prorated.  ",
    );
    await userEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));

    expect(onAcknowledge).toHaveBeenCalledWith("Started mid-month; register prorated.");
  });

  it("surfaces a server-side failure instead of appearing to succeed", async () => {
    const onAcknowledge = vi.fn().mockRejectedValue(new Error("Run is already posted"));
    render(<VarianceVerifier report={withTaxVariance} onAcknowledge={onAcknowledge} />);

    await userEvent.type(screen.getByLabelText(/Why do these figures stand/), "reason");
    await userEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));

    expect(await screen.findByText("Run is already posted")).toBeInTheDocument();
  });

  it("says plainly when everything agrees", () => {
    render(<VarianceVerifier report={emptyReport} onAcknowledge={vi.fn()} />);
    expect(screen.getByText(/Every line agrees/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).not.toBeInTheDocument();
  });

  it("shows the recorded acknowledgement instead of the form once acknowledged", () => {
    render(
      <VarianceVerifier
        report={{
          ...withTaxVariance,
          acknowledgedAt: "2026-07-02T09:00:00.000Z",
          acknowledgedBy: "user-1",
        }}
        onAcknowledge={vi.fn()}
      />,
    );
    expect(screen.getByText("Acknowledged")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Acknowledge and unlock/ }),
    ).not.toBeInTheDocument();
  });

  it("hides the form once the run is posted", () => {
    // Acknowledging after posting would record a decision after the fact.
    render(
      <VarianceVerifier
        report={{ ...withTaxVariance, journalHeaderId: "jh-1", blockers: ["already posted"] }}
        onAcknowledge={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Acknowledge and unlock/ }),
    ).not.toBeInTheDocument();
  });

  describe("contribution variances", () => {
    const withContribution: PayrollVarianceReport = {
      ...emptyReport,
      contributionVariances: [
        {
          lineId: "l2",
          employeePartyId: "e2",
          employeeName: "Jose Cruz",
          computedTaxWithheld: null,
          reportedTaxWithheld: null,
          varianceAmount: null,
          contributionVarianceAmount: "150",
          contributionCheckStatus: "checked",
          expectedSssEmployeeShare: "1350",
          sssEmployeeShare: "1200",
          expectedPhilHealthEmployeeShare: "750",
          philHealthEmployeeShare: "750",
          expectedPagIbigEmployeeShare: "600",
          pagIbigEmployeeShare: "600",
        },
      ],
    };

    it("lists only the components that actually differ", () => {
      // Showing all three when one moved buries the finding.
      render(<VarianceVerifier report={withContribution} onAcknowledge={vi.fn()} />);
      expect(screen.getByText("SSS")).toBeInTheDocument();
      expect(screen.queryByText("PhilHealth")).not.toBeInTheDocument();
      expect(screen.queryByText("Pag-IBIG")).not.toBeInTheDocument();
    });

    it("explains why a contribution variance matters even when tax is right", () => {
      render(<VarianceVerifier report={withContribution} onAcknowledge={vi.fn()} />);
      expect(screen.getByText(/base that is itself wrong/)).toBeInTheDocument();
    });

    it("reports skipped checks rather than letting them read as clean", () => {
      render(
        <VarianceVerifier
          report={{ ...emptyReport, contributionChecksSkipped: 4 }}
          onAcknowledge={vi.fn()}
        />,
      );
      expect(screen.getByText(/An unchecked line is not a clean one/)).toBeInTheDocument();
    });
  });
});
