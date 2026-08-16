import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { AccountCard } from "../../src/components/AccountCard";
import { mockAccount } from "../fixtures/mockData";

describe("AccountCard Component", () => {
  it("should render account details correctly", () => {
    render(<AccountCard account={mockAccount as any} />);

    expect(screen.getByText(mockAccount.name)).toBeInTheDocument();
    expect(screen.getByText(mockAccount.accountNumber)).toBeInTheDocument();
    expect(screen.getByText(mockAccount.accountType)).toBeInTheDocument();
  });

  it("should show icon if provided", () => {
    const accountWithIcon = { ...mockAccount, icon: "🏦" };
    render(<AccountCard account={accountWithIcon as any} />);

    expect(screen.getByText("🏦")).toBeInTheDocument();
  });

  it("should call onEdit when edit button is clicked", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    render(<AccountCard account={mockAccount as any} onEdit={onEdit} />);

    const editButton = screen.getByText("Edit Account");
    await user.click(editButton);

    expect(onEdit).toHaveBeenCalledWith(mockAccount.id);
  });

  it("should not show edit button if onEdit is not provided", () => {
    render(<AccountCard account={mockAccount as any} />);

    expect(screen.queryByText("Edit Account")).not.toBeInTheDocument();
  });
});
