import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BillingReturnNotice } from "../../src/routes/business-groups";

describe("Enterprise billing return notice", () => {
  it("treats a Checkout success redirect as unverified provider state", () => {
    render(<BillingReturnNotice status="success" onDismiss={() => {}} />);

    expect(screen.getByText("Checkout returned for verification")).toBeInTheDocument();
    expect(screen.getByText(/no subscription change is trusted yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Subscription received")).not.toBeInTheDocument();
  });
});
