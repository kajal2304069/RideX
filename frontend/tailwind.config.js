/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brand: a deep ultramarine blue on a cool lavender-grey page, like a modern ride app.
        brand: { DEFAULT: "#1B1FD0", 700: "#1417A6", 600: "#171BBE", soft: "#E9EAFC", mid: "#C8CBF6" },
        ink: "#0D0F2B",
        concrete: "#EEF0F8",
        rule: "#E3E6F1",
        mute: "#5D6385",
        navy: { DEFAULT: "#0D0F2B", 2: "#171A45" },
        // The old product colours stay as small accents (ratings, statuses, icon chips) - buttons are always brand blue.
        ride: { DEFAULT: "#F5B301", ink: "#7A5600" },
        rent: { DEFAULT: "#0B8A8A", ink: "#075F5F" },
        market: { DEFAULT: "#5A3FD0", ink: "#3F2A9C" },
        repair: { DEFAULT: "#D9472B", ink: "#9C2F18" },
        earn: { DEFAULT: "#16A34A", ink: "#0F6B32" },
        admin: { DEFAULT: "#44546A", ink: "#2E3A4B" },
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        body: ['"Plus Jakarta Sans Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: { DEFAULT: "0.75rem", "4xl": "2rem", "5xl": "2.5rem" },
      boxShadow: {
        card: "0 1px 2px rgba(20,24,90,.04), 0 12px 32px -16px rgba(20,24,90,.20)",
        lift: "0 2px 6px rgba(20,24,90,.06), 0 22px 48px -18px rgba(20,24,90,.32)",
        sheet: "0 -12px 40px -12px rgba(20,24,90,.28)",
      },
    },
  },
  plugins: [],
};
