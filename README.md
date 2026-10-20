# GMT system map

One map page with two views. The page and its data are hosted on GitHub Pages; a small Cloudflare Worker supplies live bus locations and arrival times (GitHub Pages can't keep the Swiftly key private or run code).

- **System map**: `https://greenmountaintransit.github.io/system-map/` shows every route and every live bus. Stops appear when you zoom in.
- **Route map**: `https://greenmountaintransit.github.io/system-map/?route=ROUTE_ID` shows one route, its live buses, and an ordered stop list for each direction with the next 3 arrivals.

Selecting any stop shows its next 3 arrivals across all routes, marked **Live** (Swiftly prediction) or **Scheduled** (timetable, used when no live prediction exists yet), plus wheelchair access and any amenities you've entered.

## What's in here

| Path | What it does |
| --- | --- |
| `public/` | Everything GitHub Pages publishes: the map page (both views) and the built `data/` folder. |
| `src/worker.js` | The `/api/vehicles` and `/api/arrivals` endpoints. Holds the Swiftly key; reads schedule data from GitHub Pages. |
| `.github/workflows/build-data.yml` | Rebuilds the data from GMT's GTFS nightly and publishes the site. |
| `scripts/build-data.mjs` | Turns GMT's GTFS zip (and the amenity sheet) into `public/data/`. |
| `amenities-template.csv` | Starting point for the stop amenity sheet. |

## First-time setup

**1. GitHub repository.** Create a new repo named `system-map` under the `greenmountaintransit` account (a separate repo keeps this apart from the opendata site's build) and push this folder to it. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.

**2. Data build.** In `.github/workflows/build-data.yml`, set `GTFS_URL` to the direct link to GMT's GTFS zip. If you have amenity data, commit it as `amenities.csv` in the repo root. Then run the workflow from the **Actions** tab. When it finishes, the map is at https://greenmountaintransit.github.io/system-map/ (live buses won't show until step 3 is done).

**3. Cloudflare Worker** (needs Node.js 18+ and a free Cloudflare account):

```
npm install
npx wrangler login
npx wrangler secret put SWIFTLY_KEY      # paste GMT's Swiftly API key
npx wrangler deploy
```

Wrangler prints the Worker's URL, like `https://gmt-system-map.your-account.workers.dev`. `DATA_BASE` in `wrangler.toml` already points at the GitHub Pages data folder; change it if you use a different repo name.

**4. Connect the page.** In `public/index.html`, set `API_BASE` to the Worker URL and `MAPBOX_TOKEN` to your Mapbox public token. In your Mapbox account, restrict the token to `greenmountaintransit.github.io` and `ridegmt.com`. Commit; the workflow republishes the site.

To test locally: run `npm run build -- ./gtfs` with an unzipped GTFS, serve the page with `npx serve -l 8000 public`, and run `npx wrangler dev --var SWIFTLY_KEY:your-key --var DATA_BASE:http://localhost:8000/data/` with `API_BASE` set to `http://localhost:8787`.

## Embedding in CivicPlus

On each page, add a **Custom HTML** widget and paste an iframe. GitHub Pages uses HTTPS, which CivicPlus requires. Homepage:

```html
<iframe src="https://greenmountaintransit.github.io/system-map/" title="GMT system map: all routes and buses"
  width="100%" height="600" style="border:0" loading="lazy" allow="geolocation"></iframe>
```

Route page (use the route's `route_id` from GMT's GTFS `routes.txt`):

```html
<iframe src="https://greenmountaintransit.github.io/system-map/?route=2" title="Route 2 live map and arrival times"
  width="100%" height="650" style="border:0" loading="lazy" allow="geolocation"></iframe>
```

Test on a copied page first, as CivicPlus recommends for custom HTML.

## Keeping it current

- **Schedule changes** are picked up automatically: the workflow rebuilds from GMT's published GTFS every night, so a new GTFS posted before a service change is live the next morning. To publish sooner, run the workflow by hand from the **Actions** tab. The Worker picks up new data within about an hour.
- **Amenities**: edit `amenities.csv` (one row per stop, `yes`/`no` columns) and commit it; the site rebuilds on its own. Editing in Excel and saving as CSV works. Columns: `shelter, bench, bike_rack, trash_can, lighting, real_time_sign, notes`. To add a new amenity type, add a column to the CSV and one entry to `AMENITY_COLUMNS` in `scripts/build-data.mjs`.

## How arrival times are worked out

The Worker fetches Swiftly's GTFS-realtime trip updates at most once every 15 seconds and shares the result with every visitor. For each stop it takes the scheduled trips for the current service day (including trips running past midnight), applies live predictions where Swiftly has them, drops canceled trips and skipped stops, and returns the next 3. Trips that Swiftly isn't predicting yet, usually ones that haven't started, show their scheduled time. Buses aren't listed at a route's final stop, since riders can't board them there.

## If something looks wrong

- **"Live bus locations are unavailable"**: check the Swiftly key (`npx wrangler secret put SWIFTLY_KEY`) and run `npx wrangler tail` to see the error.
- **Buses appear in gray or are missing**: the `route_id` values in Swiftly's feed must match GMT's GTFS. Re-run the build with the current GTFS.
- **"Map data is missing"**: check the latest run in the repo's **Actions** tab. Usually `GTFS_URL` is wrong or the download failed.
- **Buses show but arrival times say "unavailable"**: check that `DATA_BASE` in `wrangler.toml` is right; `DATA_BASE` + `routes.json` should open in a browser.
