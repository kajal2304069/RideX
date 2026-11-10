import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Landing } from "@/pages/Landing";
import { AuthPage } from "@/pages/AuthPage";
import { suggestionsFor, greeting } from "@/components/assistant/context";
import { distanceM, directionsUrl } from "@/lib/maps";

const wrap = (ui: JSX.Element, at = "/") => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter></QueryClientProvider>);

describe("landing page", () => {
  it("offers a sign-up path for every kind of person, with the role in the link", () => {
    wrap(<Landing />);
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    for (const r of ["RIDER", "BUYER", "SELLER", "DRIVER", "VEHICLE_OWNER", "GARAGE_OWNER"]) expect(links).toContain(`/login?mode=register&role=${r}`);
  });
  it("shows different steps for a driver", async () => {
    wrap(<Landing />);
    await userEvent.click(screen.getByRole("tab", { name: /I want to drive/ }));
    expect(screen.getByText(/Find a mechanic/)).toBeInTheDocument();
  });
  it("mentions new and second-hand", () => {
    wrap(<Landing />);
    expect(screen.getAllByText(/new or second-hand/i).length).toBeGreaterThan(0);
  });
});

describe("role sign-up", () => {
  it("opens on Create account with the chosen role ticked", () => {
    wrap(<AuthPage />, "/login?mode=register&role=DRIVER");
    expect(screen.getByRole("heading", { name: /Create your account/ })).toBeInTheDocument();
    const box = within(screen.getByRole("group", { name: /What will you do/ })).getByRole("checkbox", { name: /Drive/ });
    expect(box).toBeChecked();
    expect(within(screen.getByRole("group", { name: /What will you do/ })).getByRole("checkbox", { name: /Ride and rent/ })).not.toBeChecked();
  });
  it("opens on Sign in by default", () => {
    wrap(<AuthPage />, "/login");
    expect(screen.getByRole("heading", { name: /Welcome back/ })).toBeInTheDocument();
  });
});

describe("assistant context", () => {
  it("helps a visitor sign up, and a driver find mechanics", () => {
    expect(suggestionsFor({ signedIn: false, roles: [], page: "other", hi: false })[0]).toMatch(/create an account/i);
    expect(suggestionsFor({ signedIn: true, roles: ["DRIVER"], page: "drive", hi: false }).join(" ")).toMatch(/mechanic/i);
    expect(suggestionsFor({ signedIn: true, roles: ["BUYER"], page: "buy", hi: true }).length).toBeGreaterThan(0);
  });
  it("greets by sign-in status", () => {
    expect(greeting({ signedIn: false, roles: [], hi: false })).toMatch(/not signed in/);
    expect(greeting({ signedIn: true, first: "Ravi", roles: ["RIDER"], hi: false })).toMatch(/Ravi.*rider/);
  });
});

describe("location helpers", () => {
  it("measures distance and builds a directions link", () => {
    const d = distanceM({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9816, lng: 77.5946 });
    expect(d).toBeGreaterThan(1050); expect(d).toBeLessThan(1150);
    expect(directionsUrl({ lat: 1, lng: 2 }, { lat: 3, lng: 4 })).toContain("destination=1,2");
  });
});
