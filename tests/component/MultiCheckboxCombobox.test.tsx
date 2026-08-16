import React from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MultiCheckboxCombobox } from "../../src/components/ui/MultiCheckboxCombobox";

const options = [
  { value: "operating", label: "Operating Companies", description: "3 linked businesses" },
  { value: "regional", label: "Regional Portfolio", description: "2 linked businesses" },
];

describe("MultiCheckboxCombobox", () => {
  it("exposes checkbox-style multi-selection and keeps at least one group selected", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MultiCheckboxCombobox
        ariaLabel="Select Business Groups"
        options={options}
        value={["operating"]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Select Business Groups" }));
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");

    await user.click(screen.getByRole("option", { name: /Regional Portfolio/ }));
    expect(onChange).toHaveBeenCalledWith(["operating", "regional"]);

    await user.click(screen.getByRole("option", { name: /Operating Companies/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("filters options by group name", async () => {
    const user = userEvent.setup();
    render(
      <MultiCheckboxCombobox
        ariaLabel="Select Business Groups"
        options={options}
        value={["operating", "regional"]}
        onChange={() => {}}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Select Business Groups" }));
    await user.type(screen.getByRole("searchbox", { name: "Search groups" }), "regional");

    expect(screen.getByRole("option", { name: /Regional Portfolio/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Operating Companies/ })).toBeNull();
  });
});
