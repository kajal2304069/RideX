import { lazy, ReactNode, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth, Role } from "@/store/auth";
import { Shell } from "@/components/Shell";
import { Loading, Empty } from "@/components/ui";
import { AuthPage } from "@/pages/AuthPage";
import { BookRide } from "@/pages/ride/BookRide";
import { RideHistory } from "@/pages/ride/RideHistory";
import { Payments } from "@/pages/Payments";
import { Notifications } from "@/pages/Notifications";
import { Help } from "@/pages/help/Help";
import { Home } from "@/pages/Home";
import { Landing } from "@/pages/Landing";
import { Assistant } from "@/components/assistant/Assistant";
import { DriverConsole } from "@/pages/drive/DriverConsole";
import { Vehicles } from "@/pages/drive/Vehicles";
import { Earnings } from "@/pages/drive/Earnings";
import { RentBrowse } from "@/pages/rent/RentBrowse";
import { RentDetail } from "@/pages/rent/RentDetail";
import { RentBookings } from "@/pages/rent/RentBookings";
import { RentalDesk } from "@/pages/drive/RentalDesk";
import { MarketBrowse } from "@/pages/market/MarketBrowse";
import { MarketDetail } from "@/pages/market/MarketDetail";
import { Sell } from "@/pages/market/Sell";
import { BuyActivity } from "@/pages/market/BuyActivity";
import { Garages } from "@/pages/repair/Garages";
import { GarageDetail } from "@/pages/repair/GarageDetail";
import { RepairBookings } from "@/pages/repair/RepairBookings";
import { GarageDesk } from "@/pages/repair/GarageDesk";
const Admin = lazy(() => import("@/pages/admin/Admin").then((m) => ({ default: m.Admin })));

/** The front door: visitors see the landing page; people already signed in go straight to their home. */
function Front() {
  const status = useAuth((s) => s.status);
  if (status === "loading") return <Loading />;
  return status === "authenticated" ? <Navigate to="/home" replace /> : <Landing />;
}

function Guard({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { status, has } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <Loading />;
  if (status === "anonymous") return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (roles && !has(...roles)) {
    return <Empty title="This page is for a different kind of account">You're signed in, but your account doesn't have access here. Create another account with the right role to use it.</Empty>;
  }
  return <>{children}</>;
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  useEffect(() => { void bootstrap(); }, [bootstrap]);

  return (
    <>
    <Routes>
      <Route path="/" element={<Front />} />
      <Route path="/login" element={<AuthPage />} />
      <Route path="/guide" element={<div className="mx-auto max-w-6xl px-4 py-5 sm:px-6"><div className="mb-5 flex items-center justify-between"><a href="/" className="font-display text-2xl font-extrabold">Ride<span className="text-ride">X</span></a><a href="/login" className="btn btn-primary">Sign in · साइन इन</a></div><Help /></div>} />
      <Route element={<Guard><Shell /></Guard>}>
        <Route path="/home" element={<Home />} />
        <Route path="/ride" element={<Guard roles={["RIDER"]}><BookRide /></Guard>} />
        <Route path="/ride/history" element={<Guard roles={["RIDER"]}><RideHistory /></Guard>} />
        <Route path="/payments" element={<Payments />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/help" element={<Help />} />

        <Route path="/rent" element={<RentBrowse />} />
        <Route path="/rent/listings/:id" element={<RentDetail />} />
        <Route path="/rent/bookings" element={<RentBookings />} />

        <Route path="/buy" element={<MarketBrowse />} />
        <Route path="/buy/listings/:id" element={<MarketDetail />} />
        <Route path="/buy/activity" element={<BuyActivity />} />
        <Route path="/sell" element={<Guard roles={["SELLER", "VEHICLE_OWNER", "ADMIN"]}><Sell /></Guard>} />

        <Route path="/repair" element={<Garages />} />
        <Route path="/repair/garages/:id" element={<GarageDetail />} />
        <Route path="/repair/bookings" element={<RepairBookings />} />
        <Route path="/repair/garage" element={<Guard roles={["GARAGE_OWNER"]}><GarageDesk /></Guard>} />

        <Route path="/drive" element={<Guard roles={["DRIVER"]}><DriverConsole /></Guard>} />
        <Route path="/drive/vehicles" element={<Guard roles={["VEHICLE_OWNER"]}><Vehicles /></Guard>} />
        <Route path="/drive/rentals" element={<Guard roles={["VEHICLE_OWNER"]}><RentalDesk /></Guard>} />
        <Route path="/drive/earnings" element={<Guard roles={["DRIVER", "VEHICLE_OWNER"]}><Earnings /></Guard>} />

        <Route path="/admin" element={<Guard roles={["ADMIN"]}><Suspense fallback={<Loading />}><Admin /></Suspense></Guard>} />
        <Route path="*" element={<Empty title="Page not found">Check the address, or use the menu.</Empty>} />
      </Route>
    </Routes>
    <Assistant />
    </>
  );
}
