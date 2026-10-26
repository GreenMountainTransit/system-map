# GMT system map

**Looking after the map? Start with [MAINTENANCE.md](MAINTENANCE.md)**, a step-by-step guide for routine tasks, fixes and checks.

A live map of Green Mountain Transit, hosted on GitHub Pages with no server.

- **System map**: https://greenmountaintransit.github.io/system-map/ shows every route and live bus, with a Routes / Frequency switch. Stops appear when you zoom in.
- **Route map**: https://greenmountaintransit.github.io/system-map/?route=2 (route number) shows one route, its live buses, its description and service hours, and its stops in order for each direction with the next scheduled times.
- **Frequency map**: https://greenmountaintransit.github.io/system-map/?view=frequency
- **Trip planner**: https://greenmountaintransit.github.io/system-map/?view=plan

Selecting a stop opens its details (a side panel on desktop, a bottom sheet on phones): next departures marked **Live** (Swiftly prediction) or **Scheduled**, all of today's times, ridership (the stop's total monthly boardings as a stock-style chart with 6M / YTD / 12M / All, growth or decline, and its rank among all stops and among the stops on each of its routes; stop level only, from GMT's ArcGIS Online stops data), accessibility and amenities, nearby food, shopping and restrooms, and what each route does. On a route page, a stop shows only that route.

Other features: service alerts and detours with temporary stops and their times (via the relay), "next service near you" from the locate button, or for any spot with the "pick a spot" button under it (nearest stop in each direction, walk time and next trips; on route pages the search also takes addresses), a trip planner with leave-now / leave-at / arrive-by, live bus destinations, a desktop 3D view where every live bus is a 3D GMT bus you can click to follow (with its speed), and clicking a stop gives a street-level view beside a GMT stop sign, watching for the next bus, local routes drawn on top of other route types, a collapsible Street View of each stop with the camera's position shown on the map, search for routes and stops, a clickable legend with route groups, Show all / Hide all, Map / Detailed / Satellite basemaps, direction arrows on routes, and phone-friendly bottom sheets.

## What's in the repo

| Path | What it does |
| --- | --- |
| `public/index.html` | The map page (all views). Holds the opening view (`HOME_BOUNDS`); keys and tokens are added at publish time from GitHub secrets. |
| `public/planner.js` | The trip planner: finds trips with transfers from the timetable (RAPTOR), and checks each trip's first bus against live predictions. |
| `public/bus3d.js`, `public/gmt-logo.png` | The 3D models for the 3D view: GMT buses (livery, logo, destination sign, driver) and the GMT bus stop sign. |
| `public/live.js` | Fetches live bus locations (`/vehicles`) and stop predictions (`/predictions`) from Swiftly in the visitor's browser and merges them with the timetable. |
| `scripts/build-data.mjs` | Turns GMT's GTFS into the route, stop, schedule and frequency files in `public/data/`, adds amenities and nearby places. |
| `scripts/prepare-amenities.mjs` | Turns the field-survey exports into `amenities.csv`. |
| `route-info.json` | Route descriptions and legend groups (edit by hand). |
| `amenities.csv` | Shelter, seating, schedule box and ADA pad for each stop. |
| `MAINTENANCE.md` | How to run and fix the map without a developer. |
| `src/worker.js` | The relay: a Cloudflare Worker that fetches live data, service alerts and detours from Swiftly once for all visitors, keeping the key private. Setup steps are in MAINTENANCE.md. |
| `.github/workflows/build-data.yml` | Nightly (and on every change): downloads GMT's GTFS, builds the data, adds the Swiftly key, publishes the site. |

The Mapbox token, relay address and optional Google key are stored as repository secrets, not in the code. With the relay (`RELAY_URL` secret), the Swiftly key lives only in Cloudflare and never appears on the page; without it, the page calls Swiftly directly with `SWIFTLY_KEY`. The workflow inserts it into the published page. Because the page calls Swiftly directly from visitors' browsers, the key is visible to anyone who inspects the live page, the same way Swiftly's own map works. If the key is ever misused, create a new one in Swiftly, update the secret, and re-run the workflow.

**Swiftly rate limit:** with the relay, Swiftly gets a fixed ~135 requests per 15 minutes however many people visit. Without it, the key's limit is shared by everyone using the map. Each open map asks for bus locations every 15 seconds, plus one predictions request every 15 seconds while a stop is open. If Swiftly answers "too many requests", the map pauses live requests (1 minute, doubling up to 10) and shows scheduled times meanwhile.

## Setup

1. **Pages**: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
2. **Swiftly key**: in **Settings → Secrets and variables → Actions**, click **New repository secret**. Name: `SWIFTLY_KEY`. Value: GMT's Swiftly API key.
3. **Street View (optional)**: add a Google Maps Embed API key as the secret `GOOGLE_MAPS_KEY` to show Street View inside stop details (free; see MAINTENANCE.md). Without it, stop details link out to Google Maps.
4. **Mapbox token**: add a public Mapbox token (starts with `pk.`, URL restriction `https://greenmountaintransit.github.io`) as the secret `MAPBOX_TOKEN`. The build stops if it's missing.
5. **Publish**: run the workflow from the **Actions** tab (**Build map data and publish → Run workflow**).

## Embedding in CivicPlus

Add a **Custom HTML** widget to the page and paste an iframe. Homepage:

```html
<iframe src="https://greenmountaintransit.github.io/system-map/" title="GMT system map: all routes and live buses"
  width="100%" height="600" style="border:0" loading="lazy" allow="geolocation; fullscreen" allowfullscreen></iframe>
```

Route page (route number at the end). Route pages opened this way have no "All routes" link, so riders stay on that route; links from the system map add `&back=1` to show it:

```html
<iframe src="https://greenmountaintransit.github.io/system-map/?route=2" title="Route 2 live map and arrival times"
  width="100%" height="650" style="border:0" loading="lazy" allow="geolocation; fullscreen" allowfullscreen></iframe>
```

In an embed, the map starts behind a light shade with **Click to activate system map** (or route map), so mouse-wheel scrolling moves the page instead of the map; the shade returns a few seconds after the pointer leaves. Opened directly or full screen, it's skipped.

Keep `allow="geolocation; fullscreen" allowfullscreen` so the locate button and the **Expand** button (bottom right) work inside the page. Expand uses the browser's full-screen mode; on iPhones, or embeds without that permission, it opens the map as its own page and **Minimize** returns to the page it came from.

Test on a copied page first, as CivicPlus recommends for custom HTML.

## Editing route descriptions and legend groups

`route-info.json` holds the one-line description for each route (shown on hover, in stop popups and on route pages) and the legend groups. Edit it on GitHub and commit; the site rebuilds on its own. Frequencies and operating days are calculated from the GTFS automatically.

## Trip planner

The **Trip planner** tab finds bus trips between two places, including transfers. Riders type an address, place or stop (addresses come from Mapbox's geocoder, using the same Mapbox account), use their location, or click the map. It works entirely in the browser from the published GTFS:

- It searches with RAPTOR, the method most journey planners use, for trips with up to 3 buses (2 transfers), walking up to about 10 minutes to and from stops and up to about 5 minutes between stops when transferring, with at least 2 minutes to change buses. These settings are at the top of `public/planner.js`.
- Live data: Swiftly only lets browsers get predictions one stop at a time, so each suggested trip's **first bus** is checked live (on time, late or early); later legs use the timetable. Fully live transfer timing would need the GTFS-realtime feed through a relay.
- Empty From/To boxes suggest the rider's recent places (kept only in their browser) and GMT's busiest stops (from ridership data); matching recent places appear instantly while typing.
- A ? button (top left of the map) shows Helpful hints beside every map button until it's clicked again; hovering a button shows its label; on a device's first visit, hints point out the location, choose-a-location and full-screen buttons for 6 seconds.
- Riders can show trips by fastest, least walking or fewest transfers, choose to bike to and from the bus on bike-friendly routes (Mapbox cycling directions), see walking and biking the whole way (listed first when faster than the bus), and limit them to wheelchair-accessible stops (stops marked not accessible in the GTFS or the stop survey are avoided). Each trip shows its walking time and an estimated cost of driving it instead, with an explanation of the method.
- Searches (trip planner, main Routes tab and route pages) find places (like City Hall), addresses, towns and GMT stops in Chittenden, Washington and Franklin counties, Chittenden first. A searched place is labeled on the map with nearby service and a Directions button that opens the trip planner with it as the destination (starting from your location when allowed).
- Trip options list bus trips first, then walking and biking (marked "Faster than the bus" when they are); Fastest / Least walking / Fewest transfers appear once trips are planned. Each trip compares a month of twice-a-day riding (20 days, with GMT's daily and monthly fare caps) against driving. "Choose your start and finish on the map" guides riders through two taps; on phones, choosing a trip zooms to it with its details in a tray halfway up the screen. Map clicks drop green START and red FINISH pins right away; the From/To boxes have clear buttons, and times are chosen with hour, minute and AM/PM menus. Bike-and-bus trips note how much climbing they avoid compared with biking the whole way. Place search uses Mapbox's Search Box API (billed per request after a free monthly allowance), falling back to Mapbox's address search if it's unavailable. Walking paths use Mapbox walking directions. The planner boards and leaves each bus at the stop with the shortest walk for the same trip, and draws walks along real streets.

## Frequency map

The **Frequency** view colors each street by how often a local bus comes there on weekdays: rush hour (7–9 AM and 4–6 PM, the default), midday (9 AM–3 PM) or evening (7–10 PM). Tiers: every 15–20 min, 21–30 min, 31–60 min, and less than hourly.

- It's an average: the minutes in the time window divided by the number of buses, using whichever direction has more buses.
- It's measured by street, not by stop, so routes sharing a street add up even where they use different stops (for example Routes 1 and 11 on Market Street).
- Direction is ignored on the map: each street is drawn once, as a single line, whichever way the buses run.
- Commuter/express, school and shopping routes are left out.

The legend is clickable to show or hide each tier. Link straight to it with `?view=frequency`.

## What updates automatically

Every night the workflow downloads GMT's current GTFS and rebuilds everything that comes from it: routes, names, colors, route shapes, stops, stop order, timepoints, schedules and arrival times, frequencies and the service wording ("every 20 min peak, 30 min other times"), first and last trips, and the frequency map. New routes appear on their own (300-series routes go in School trippers automatically; anything else not listed in `route-info.json` goes in Local routes).

Not automatic: route descriptions and group assignments in `route-info.json`, stop amenities in `amenities.csv` (if GMT renumbers stops, regenerate it), and the opening map view (`HOME_BOUNDS` in `public/index.html`).

## Nearby places

Each build looks up restaurants and cafes, shops and pharmacies, and public restrooms within about 200 m of every stop from OpenStreetMap (one Overpass API query). If the lookup fails, the build continues and stops show without them; the next nightly build tries again. To improve the data, edit OpenStreetMap directly.

## Hands-off running

Once set up, nothing needs doing when GMT publishes a new GTFS: each night the workflow downloads the current feed and rebuilds everything as of that day (Vermont time). There are no hard-coded dates.

Safeguards:
- **Bad or expired feeds don't go live.** If the GTFS fails to download, has no routes or stops, or has no service in the coming 7 days (expired, or only future service), the build stops, the current site stays up, and GitHub emails the repo admins about the failed run. The run's log also warns when the feed will expire within two weeks.
- **The nightly schedule stays on.** GitHub turns off scheduled workflows in public repos after 60 days without activity; the workflow's keepalive job adds an empty commit after 45 quiet days to prevent that.
- **Live data degrades gracefully.** If Swiftly is down or rate-limited, the map shows scheduled times. If the nearby-places lookup fails, stops show without it.

### Testing an older GTFS

In **Actions → Build map data and publish → Run workflow**, fill in either or both boxes:
- **GTFS link**: a .zip URL for another feed (for example an archived version from the Mobility Database).
- **Build date**: build as if it were that day (YYYY-MM-DD), for a feed whose dates are in the past.

This publishes the test build to the live site, so do it when traffic is low. Routes, stops, frequencies and service wording reflect the test feed and date, but arrival times always use the real clock, so stops may show no upcoming buses. When you're done, run the workflow again with both boxes empty to go back to the current feed.

## Keeping it current

- **Schedule changes** are picked up automatically: the workflow rebuilds from GMT's published GTFS every night. To publish sooner, run it by hand from **Actions**.
- **Amenities** come from `amenities.csv` in the repo root (one row per stop ID, `yes`/`no` columns: `shelter, seating, schedule_box`, plus optional `bike_rack, trash_can, lighting, real_time_sign, notes`). It's generated from the two field-survey exports (stop inspection and shelter asset inventory) with `node scripts/prepare-amenities.mjs <gmt_stop_inspect.csv> <shelter_fixed_asset_inventory.csv>`, which keeps only the yes/no columns so internal details stay out of the public repo. Commit the new `amenities.csv` and the site rebuilds on its own. To show a new amenity type, add a column and one entry to `AMENITY_COLUMNS` in `scripts/build-data.mjs`.
- **New Swiftly key**: update the `SWIFTLY_KEY` secret, then run the workflow.

## If something looks wrong

- **"Live buses aren't connected yet"**: the `SWIFTLY_KEY` secret is missing. Add it and re-run the workflow. The run's **Add Swiftly key** step says whether it found the key.
- **"Live bus locations are unavailable right now"** or a stop says **"Live predictions are unavailable"**: Swiftly rejected the request, is down, or the rate limit was reached. Check the key in the secret; open the browser console (F12) for details.
- **No basemap**: check the Mapbox token's URL restriction is exactly `https://greenmountaintransit.github.io`.
- **"Map data is missing"**: check the latest run in **Actions**; usually the GTFS download failed.
