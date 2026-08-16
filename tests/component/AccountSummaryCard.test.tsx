/**
 * Component tests for AccountSummaryCard
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import AccountSummaryCard from "@/components/ledger/AccountSummaryCard";

describe("AccountSummaryCard", () => {
  const defaultProps = {
    accountName: "Test Account",
    accountNumber: "1234",
    accountType: "asset",
    balance: "1000.00",
    transactionCount: 5,
    currency: "USD",
  };

  it("should render account information correctly", () => {
    render(<AccountSummaryCard {...defaultProps} />);

    expect(screen.getByText("Asset")).toBeInTheDocument();
    expect(screen.getByText("Test Account")).toBeInTheDocument();
    expect(screen.getByText("#1234")).toBeInTheDocument();
    expect(screen.getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.getByText("5 transactions")).toBeInTheDocument();
  });

  it("should display correct type icon and colors for asset", () => {
    render(<AccountSummaryCard {...defaultProps} />);

    const badge = screen.getByText("A").closest("div");
    expect(badge).toHaveStyle({
      backgroundColor: "var(--badge-bg)",
      color: "var(--badge-text)",
    });
  });

  it("should handle negative balances correctly", () => {
    render(<AccountSummaryCard {...defaultProps} balance="-500.00" />);

    const balanceElement = screen.getByText("-$500.00");
    expect(balanceElement).toHaveStyle({
      color: "var(--balance-color)",
    });
  });

  it("should not display account number when not provided", () => {
    const propsWithoutNumber = { ...defaultProps, accountNumber: null };
    render(<AccountSummaryCard {...propsWithoutNumber} />);

    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });

  it("should display singular transaction text for count of 1", () => {
    render(<AccountSummaryCard {...defaultProps} transactionCount={1} />);

    expect(screen.getByText("1 transaction")).toBeInTheDocument();
  });

  it("should handle different account types", () => {
    const types = [
      { type: "liability", icon: "L", label: "Liability" },
      { type: "equity", icon: "E", label: "Equity" },
      { type: "revenue", icon: "R", label: "Revenue" },
      { type: "expense", icon: "X", label: "Expense" },
    ];

    types.forEach(({ type, icon, label }) => {
      const { unmount } = render(<AccountSummaryCard {...defaultProps} accountType={type} />);

      expect(screen.getByText(icon)).toBeInTheDocument();
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    });
  });

  it("should handle unknown account types", () => {
    render(<AccountSummaryCard {...defaultProps} accountType="unknown" />);

    expect(screen.getByText("?")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("should format currency correctly", () => {
    const currencyTests = [
      { balance: "0", expected: "$0.00" },
      { balance: "100", expected: "$100.00" },
      { balance: "1234.56", expected: "$1,234.56" },
      { balance: "-100.50", expected: "-$100.50" },
    ];

    currencyTests.forEach(({ balance, expected }) => {
      const { unmount } = render(<AccountSummaryCard {...defaultProps} balance={balance} />);

      expect(screen.getByText(expected)).toBeInTheDocument();
      unmount();
    });
  });

  it("should render more menu button", () => {
    render(<AccountSummaryCard {...defaultProps} />);

    const moreButton = screen.getByRole("button");
    expect(moreButton).toBeInTheDocument();
    expect(moreButton).toHaveAttribute("type", "button");
  });

  it("should handle different currencies", () => {
    render(<AccountSummaryCard {...defaultProps} currency="EUR" balance="1000.00" />);

    expect(screen.getByText("€1,000.00")).toBeInTheDocument();
  });

  it("should format account type names correctly", () => {
    const typeTests = [
      { type: "cost_of_goods_sold", label: "Cost Of Goods Sold" },
      { type: "cost_of_revenue", label: "Cost Of Revenue" },
      { type: "other_income", label: "Other Income" },
      { type: "other_expense", label: "Other Expense" },
    ];

    typeTests.forEach(({ type, label }) => {
      const { unmount } = render(<AccountSummaryCard {...defaultProps} accountType={type} />);

      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    });
  });
});
