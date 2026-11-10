import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Help } from "@/pages/help/Help";
import { GUIDES } from "@/pages/help/guides";
import { ART } from "@/pages/help/art";

describe("how-to guide", () => {
  it("every step has a picture, English and Hindi text", () => {
    for (const g of GUIDES) for (const s of g.steps) {
      expect(ART[s.art], `${g.id}: missing art ${s.art}`).toBeDefined();
      expect(s.en.length).toBeGreaterThan(5);
      expect(s.hi.length).toBeGreaterThan(5);
    }
  });
  it("opens the guide named in the address and switches to Hindi", async () => {
    render(<MemoryRouter initialEntries={["/help?guide=rent"]}><Help /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /Rent a vehicle/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "हिन्दी" }));
    expect(screen.getByRole("heading", { name: /गाड़ी किराये पर लें/ })).toBeInTheDocument();
  });
  it("gives each picture a text alternative", () => {
    render(<MemoryRouter initialEntries={["/help?guide=ride"]}><Help /></MemoryRouter>);
    expect(screen.getAllByRole("img").length).toBe(GUIDES.find((g) => g.id === "ride")!.steps.length);
  });
});
