import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, Empty, Field, Modal, Tabs } from "@/components/ui";
import { RideLine } from "@/components/RideLine";

describe("ui", () => {
  it("Field links the label to its control", () => {
    render(<Field label="Email">{(id) => <input id={id} />}</Field>);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });
  it("Button is disabled while busy and does not fire", async () => {
    const fn = vi.fn();
    render(<Button busy onClick={fn}>Pay</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(fn).not.toHaveBeenCalled();
  });
  it("Tabs reports the chosen tab", async () => {
    const fn = vi.fn();
    render(<Tabs tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} value="a" onChange={fn} />);
    await userEvent.click(screen.getByText("B"));
    expect(fn).toHaveBeenCalledWith("b");
  });
  it("Modal closes on Escape", async () => {
    const fn = vi.fn();
    render(<Modal title="Hi" onClose={fn}><p>body</p></Modal>);
    await userEvent.keyboard("{Escape}");
    expect(fn).toHaveBeenCalled();
  });
  it("Empty shows its title", () => { render(<Empty title="Nothing here" />); expect(screen.getByText("Nothing here")).toBeInTheDocument(); });
});

describe("RideLine", () => {
  it("marks the current station", () => {
    render(<RideLine status="DRIVER_ARRIVING" />);
    expect(screen.getByText("On the way").closest("li")).toHaveAttribute("aria-current", "step");
  });
  it("treats REQUESTED as searching", () => {
    render(<RideLine status="REQUESTED" />);
    expect(screen.getByText("Finding driver").closest("li")).toHaveAttribute("aria-current", "step");
  });
  it("shows no current station for a cancelled ride", () => {
    render(<RideLine status="CANCELLED_BY_RIDER" />);
    expect(document.querySelector("[aria-current]")).toBeNull();
  });
});
