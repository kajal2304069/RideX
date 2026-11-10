Headless-browser checks (manual, not in CI). With the API on :4000 (demo data seeded with `node backend/scripts/seedDemo.mjs`) and `npm run dev` in `frontend/`:

    npm i playwright-core
    CHROME=/path/to/chrome node shots1.mjs   # landing, sign-in, home, booking at phone / iPad / laptop sizes
    CHROME=/path/to/chrome node shots2.mjs   # rent, buy, repair, earnings, admin... at three sizes (reports sideways overflow)
    CHROME=/path/to/chrome node live2.mjs    # a real ride: rider books, driver accepts, rider tracks it live

`lib.mjs` stands in for map tiles and photos so the screens render without internet (for screenshots only).
Use `RATE_LIMIT_MAX=2000 AUTH_RATE_LIMIT_MAX=200` on the API while running them.
