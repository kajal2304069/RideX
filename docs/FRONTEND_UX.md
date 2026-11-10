# Frontend and user-friendliness

## Stack
React 18 + Vite + TypeScript, Tailwind, TanStack Query (server state), Zustand (session + toasts), React Router, Leaflet/OpenStreetMap, Recharts (admin only, lazy-loaded), Socket.IO client.

## Identity
A "transit map": each product is a coloured line (Ride amber, Rent teal, Market violet, Repair vermilion, Earn green, Admin slate). The ride status is a literal line with stations. Square-ish panels, no shadows, strong ink-on-concrete contrast.

## Made for people who do not read much
- **How-to guide with pictures** (`/guide` before sign-in, `/help` after): 6 guides, one action per step, a drawing per step, short everyday words.
- **Hindi / English** switch, remembered per device.
- **Read aloud** per step or whole guide (browser speech; Hindi voice if the device has one).
- **Help is always one tap away**: yellow "Help · मदद" button in the menu (desktop and phone), a big "New here?" card on the sign-in page, and "How does this work? · कैसे करें?" under the title of every main page, opening the right guide.
- **Voice assistant** (mic button on every page): speak or type in one of 14 languages and hear the answer. See `VOICE_ASSISTANT.md`.
- Prices shown **before** booking; whole-rupee display (₹68,000, not ₹68,000.00); errors say what to do next in plain words.
- Money screens show every line (parts, labour, deposit, late fee) so nothing is a surprise.
- Idempotency keys make double-taps safe: a nervous second tap never charges twice.

## Accessibility
Labelled form controls, `aria-live` toasts, `aria-current` on the ride line, text alternatives on every picture and chart, keyboard-operable modals (Esc), 16 px+ body text (18 px in the guide), Atkinson Hyperlegible body font (designed for low-vision readers), works at 360 px width with a scrollable top nav.

## Honest gaps
Only English + Hindi; no voice input; screen-reader pass was done by roles/labels in tests, not with a real reader; map tiles need internet; chat/support/maintenance have APIs but no dedicated screens yet.

## Look, photos and maps (redesign)
- Layout: phone = top bar + bottom tabs + "More" sheet; iPad = icon rail; laptop = sidebar. Checked at 390, 820 and 1280 px.
- Photos are real photographs from Unsplash (free licence), loaded from their CDN; credits are on the Home page. If a photo cannot load, a dark gradient shows instead.
- Maps: set `VITE_GOOGLE_MAPS_API_KEY` in `.env` to use Google Maps with place search and "use my location". Enable Maps JavaScript API, Places API (New) and Geocoding API, and restrict the key by HTTP referrer. Without a key the app uses OpenStreetMap + Nominatim search. After changing the key: `docker compose up -d --build frontend`.
- Fares and routes still use the seeded Bangalore road graph, so pickup/destination outside that area may not get an estimate.

## Landing page, roles and live location (second redesign)
- **Visitors** now see a public landing page at `/` (what RideX is, six "What do you want to do?" cards, how it works for riders, drivers, buyers/sellers and garages). Each card opens sign-up with that role already ticked (`/login?mode=register&role=DRIVER`). Signed-in people go straight to a Home that matches their role.
- **Live location (device GPS):** the rider's pickup defaults to where they are; riders see themselves (blue dot), the driver and the route; drivers use real GPS by default (Demo mode is a checkbox) and see the customer's live position and distance to pickup, with a Navigate button that opens turn-by-turn directions.
- **Mechanics near you:** drivers get a panel (and map markers) of garages within 15 km with distance, Directions and Call; the rider's Garages page also shows directions.
- **New socket event:** `rider:location:update` ({lat, lng, accuracy}) is relayed to the ride room only for a rider whose ride has a driver. Nothing is stored. The driver console listens for it.
- **New vehicles:** listing condition `NEW` added (migration `1725000021_listing_condition_new`). The old frontend filter value `POOR` was wrong and is now `NEEDS_WORK`.
- **Assistant:** greets by sign-in status and role, and suggests questions for the page you are on. Two new answers: location/permissions and new vehicles.
- Help pictures are now icons and photo banners instead of cartoons.

## Third redesign: blue "ride app" look and live tracking
- **Look:** deep blue (`#1B1FD0`) on a soft lavender page, white rounded cards, pill buttons, Plus Jakarta Sans. One brand colour for every button (the old per-product colours are now only small accents).
- **Three layouts, one codebase:** phone = floating white pill menu at the bottom (current page is a blue capsule with its name, the rest are round icons), a welcome header on top; iPad = slim icon rail; laptop = full sidebar. Checked at 390, 820 and 1366 px with no sideways scrolling.
- **Map-first ride screens (`TripStage`):** on a phone the map fills the screen, a route card floats on top and a white sheet rises from the bottom; on iPad and laptop the same card and sheet float on the left of a big rounded map. The phone menu is hidden on this page so the map is not covered.
- **Booking:** pickup defaults to your current location; search or tap the map for the destination; vehicle types as a swipeable row; price, time, distance and a collapsible breakdown; one big Request button.
- **Live tracking (like a real ride app):** route card with green start dot and red destination pin; green route; a top-down car that faces the way it travels; a status banner (finding driver / approaching with minutes / arrived / underway with arrival time and a progress bar / reached with Pay); driver card with photo initial, rating, trips, vehicle and number plate; Call (only when the driver has shared a number) and Chat; share-my-trip, safety (call 112) and my-location buttons.
- **Chat** uses the ride's existing chat API and socket event, with one-tap quick replies for people who would rather not type.
- **Driver console:** online card, active-trip card with the customer, chat, Navigate and one big next-step button, ride requests as route cards, mechanics near you. It is a map beside panels (not full-screen) so the Earnings and Vehicles links stay one tap away.
- **Honest gaps:** the start code (PIN) some apps show is not built, so the plate number sits in that spot; share-trip sends text, not a live-tracking link; photos and map tiles need internet (checked here with stand-ins, not the real Unsplash and OpenStreetMap images).
