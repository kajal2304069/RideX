import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { RideChat } from "@/components/RideChat";
import { LocationStatus } from "@/components/LocationStatus";
import { TripStage } from "@/components/TripStage";
import { vehicleIcon } from "@/pages/ride/vehicleIcons";
import { Car, Bike } from "lucide-react";

vi.mock("@/lib/socket", () => ({ connectSocket: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }), disconnectSocket: vi.fn() }));
const wrap = (ui: JSX.Element) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe("ride chat", () => {
  let mock: MockAdapter;
  beforeEach(() => { mock = new MockAdapter(api); new MockAdapter(axios); useAuth.setState({ user: { id: "me", email: "a@b.c", fullName: "Ann", phone: null, roles: ["RIDER"] }, status: "authenticated" }); });

  it("shows the conversation oldest first and sends a quick reply", async () => {
    mock.onGet("/chat/rides/r1/messages").reply(200, { success: true, data: { messages: [
      { id: "2", senderId: "me", body: "Second", createdAt: "2026-01-01T10:02:00Z" },
      { id: "1", senderId: "d1", body: "First", createdAt: "2026-01-01T10:01:00Z" },
    ] } });
    mock.onPost("/chat/rides/r1/messages").reply(201, { success: true, data: {} });
    wrap(<RideChat rideId="r1" otherName="Divya" onClose={() => undefined} />);
    const first = await screen.findByText("First");
    expect(first.compareDocumentPosition(screen.getByText("Second")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Please wait 2 minutes" }));
    await waitFor(() => expect(JSON.parse(mock.history.post[0].data)).toEqual({ body: "Please wait 2 minutes" }));
  });

  it("does not send an empty message", async () => {
    mock.onGet("/chat/rides/r1/messages").reply(200, { success: true, data: { messages: [] } });
    wrap(<RideChat rideId="r1" otherName="Divya" onClose={() => undefined} />);
    expect(await screen.findByText(/No messages yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });
});

describe("location status", () => {
  it("is silent while all is well when quiet, but still explains a refusal", () => {
    const { rerender } = render(<LocationStatus quiet status="live" error="" retry={() => undefined} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<LocationStatus quiet status="denied" error="Location is blocked." retry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Location is blocked.");
  });
});

describe("trip stage and icons", () => {
  it("renders the map, route card and sheet, and the round buttons", () => {
    render(<TripStage map={<div>MAP</div>} top={<div>ROUTE</div>} sheet={<div>SHEET</div>} fabsRight={<button>Locate</button>} />);
    for (const t of ["MAP", "ROUTE", "SHEET"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Locate" }).length).toBeGreaterThan(0);
  });
  it("picks an icon per vehicle type with a safe default", () => {
    expect(vehicleIcon("BIKE")).toBe(Bike);
    expect(vehicleIcon("something-new")).toBe(Car);
    expect(vehicleIcon(undefined)).toBe(Car);
  });
});
