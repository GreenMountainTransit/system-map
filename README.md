# GMT system map

**For GMT staff:** see [Quick staff editing](#quick-staff-editing-no-coding) and [Operations and maintenance](#operations-and-maintenance) below. This is the only project documentation file to maintain.

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
| `src/worker.js` | The relay: a Cloudflare Worker that fetches live data, service alerts and detours from Swiftly once for all visitors, keeping the key private. Setup steps are in the Operations and maintenance section below. |
| `.github/workflows/build-data.yml` | Nightly (and on every change): downloads GMT's GTFS, builds the data, adds the Swiftly key, publishes the site. |

The Mapbox token, relay address and optional Google key are stored as repository secrets, not in the code. With the relay (`RELAY_URL` secret), the Swiftly key lives only in Cloudflare and never appears on the page; without it, the page calls Swiftly directly with `SWIFTLY_KEY`. The workflow inserts it into the published page. Because the page calls Swiftly directly from visitors' browsers, the key is visible to anyone who inspects the live page, the same way Swiftly's own map works. If the key is ever misused, create a new one in Swiftly, update the secret, and re-run the workflow.

**Swiftly rate limit:** with the relay, Swiftly gets a fixed ~135 requests per 15 minutes however many people visit. Without it, the key's limit is shared by everyone using the map. Each open map asks for bus locations every 15 seconds, plus one predictions request every 15 seconds while a stop is open. If Swiftly answers "too many requests", the map pauses live requests (1 minute, doubling up to 10) and shows scheduled times meanwhile.

## Setup

1. **Pages**: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
2. **Swiftly key**: in **Settings → Secrets and variables → Actions**, click **New repository secret**. Name: `SWIFTLY_KEY`. Value: GMT's Swiftly API key.
3. **Street View (optional)**: add a Google Maps Embed API key as the secret `GOOGLE_MAPS_KEY` to show Street View inside stop details (free; see the Operations and maintenance section below). Without it, stop details link out to Google Maps.
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
- Live data: with the relay, the trip planner applies Swiftly's live predictions (GTFS-realtime trip updates) to every trip before searching, so every bus and every transfer is timed live, as in Google Maps and Transit. If a delay means a connection would be missed, the planner suggests one that works. Each trip shows its live status, each bus is marked Live or Scheduled, and each transfer shows its live margin ("Tight connection" under 3 minutes). Today's trips re-plan every 30 seconds while on screen. Buses without a live prediction use the timetable.
- Empty From/To boxes suggest the rider's recent places (kept only in their browser) and GMT's busiest stops (from ridership data); matching recent places appear instantly while typing.
- A ? button (top left of the map) shows Helpful hints beside every map button until it's clicked again; hovering a button shows its label; on a device's first visit, hints point out the location, choose-a-location and full-screen buttons for 6 seconds.
- Riders can show trips by fastest, least walking or fewest transfers, choose to bike to and from the bus on bike-friendly routes (Mapbox cycling directions) with the bus taking the hills (bike times add about 10 seconds per meter climbed, using Mapbox elevation data, so the planner bikes the flat and downhill parts and rides the bus uphill; bike steps and the Bike option show the feet of climbing), see walking and biking the whole way (listed first when faster than the bus), and limit them to wheelchair-accessible stops (stops marked not accessible in the GTFS or the stop survey are avoided). Each trip shows its walking time and an estimated cost of driving it instead, with an explanation of the method.
- Searches (trip planner, main Routes tab and route pages) find places (like City Hall), addresses, towns and GMT stops in Chittenden, Washington and Franklin counties, Chittenden first. A searched place is labeled on the map with nearby service and a Directions button that opens the trip planner with it as the destination (starting from your location when allowed).
- Trip options list bus trips first, then walking and biking (marked "Faster than the bus" when they are); Fastest / Least walking / Fewest transfers appear once trips are planned. Each trip compares a month of twice-a-day riding (20 days, with GMT's daily and monthly fare caps) against driving. "Choose your start and finish on the map" guides riders through two taps; on phones, choosing a trip zooms to it with its details in a tray halfway up the screen. Map clicks drop green START and red FINISH pins right away; the From/To boxes have clear buttons, and times are chosen with hour, minute and AM/PM menus. Bike-and-bus trips note how much climbing they avoid compared with biking the whole way. Place search uses Mapbox's Search Box API (billed per request after a free monthly allowance), falling back to Mapbox's address search if it's unavailable. Walking paths use Mapbox walking directions. The planner boards and leaves each bus at the stop with the shortest walk for the same trip, and draws walks along real streets.

## Frequency map

The **Frequency** view colors each street by how often a local bus comes there on weekdays: rush hour (7–9 AM and 4–6 PM, the default), midday (9 AM–3 PM) or evening (7–10 PM). Tiers: every 15–20 min, 21–30 min, 31–60 min, and less than hourly.

- It's measured the way GMT schedules service: by **departures from each route's origin station**, the Downtown Transit Center (or, for Route 4, the Essex Junction Amtrak station). Each trip counts toward rush hour, midday or evening by the time it leaves the transit center (or arrives there, for trips heading in), on every street it serves. So a route with three departures an hour shows "every 20 minutes" all along its route, and a branch only some trips use shows how often those trips run.
- A street's frequency is the minutes in the period divided by the departures serving it (clockface: 3 an hour = every 20 min). Departures from the transit center set it; trips heading in only count on streets no outbound trip uses (such as one-way inbound streets).
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
- **Bad or expired feeds don't go live.** If the GTFS fails to download, has no routes or stops, or has no service in the coming 7 days (expired, or only future service), the build stops, the current site stays up, and a "Map update failed" issue opens on GitHub (emailing everyone watching the repo; it closes itself after the next successful build). The run's log also warns when the feed will expire within two weeks.
- **The nightly schedule stays on.** GitHub turns off scheduled workflows in public repos after 60 days without activity; the workflow's keepalive job adds an empty commit after 45 quiet days to prevent that.
- **Live data degrades gracefully.** If Swiftly is down or rate-limited, the map shows scheduled times. If the nearby-places lookup fails, stops show without it.

### Testing another GTFS (preview)

In **Actions → Build map data and publish → Run workflow**, paste a feed's .zip link into **GTFS URL** (for example an archived or upcoming version from the Mobility Database), add a **Build date** the feed covers if it's not current, and check **Test only**. The test feed is published as a preview at `?preview=1` (for example https://greenmountaintransit.github.io/system-map/?preview=1), behaving as if it were the build date, with a banner and no live buses; the live map stays on GMT's current feed. The preview stays until the next test (up to 90 days). See the Operations and maintenance section below for details.

## Keeping it current

- **Schedule changes** are picked up automatically: the workflow rebuilds from GMT's published GTFS every night. To publish sooner, run it by hand from **Actions**.
- **Amenities** come from `amenities.csv` in the repo root (one row per stop ID, `yes`/`no` columns: `shelter, seating, schedule_box`, plus optional `bike_rack, trash_can, lighting, real_time_sign, notes`). It's generated from the two field-survey exports (stop inspection and shelter asset inventory) with `node scripts/prepare-amenities.mjs <gmt_stop_inspect.csv> <shelter_fixed_asset_inventory.csv>`, which keeps only the yes/no columns so internal details stay out of the public repo. Commit the new `amenities.csv` and the site rebuilds on its own. To show a new amenity type, add a column and one entry to `AMENITY_COLUMNS` in `scripts/build-data.mjs`.
- **New Swiftly key**: update the `SWIFTLY_KEY` secret, then run the workflow.

## If something looks wrong

- **"Live buses aren't connected yet"**: the `SWIFTLY_KEY` secret is missing. Add it and re-run the workflow. The run's **Add Swiftly key** step says whether it found the key.
- **"Live bus locations are unavailable right now"** or a stop says **"Live predictions are unavailable"**: Swiftly rejected the request, is down, or the rate limit was reached. Check the key in the secret; open the browser console (F12) for details.
- **No basemap**: check the Mapbox token's URL restriction is exactly `https://greenmountaintransit.github.io`.
- **"Map data is missing"**: check the latest run in **Actions**; usually the GTFS download failed.

---

## Quick staff editing (no coding)

**Route blurbs and grouping:** Open `route-info.json` on GitHub, click the pencil, edit text within the quotes under `routes`, and commit. Preserve JSON commas/braces. For route groups, edit `groups`; valid `default` values are `on`, `off`, or `sundays`. A successful GitHub Actions run republishes the site. Do not edit generated files in `public/data/`.

**Stop amenities:** Edit `amenities.csv` by stop ID, preserving the existing column names. Small edits can be made directly on GitHub; larger edits can be saved as CSV.

**Frequency map:** It shows estimated **scheduled corridor service intensity**, based on reference departures at DTC or an origin terminal, not the precise headway at every stop. Routes sharing streets are combined; the current metric does not represent direction-specific waiting time or bus bunching. Explain this distinction to riders. `frequency_overrides` in `route-info.json` should be used only with a documented reason.

**After an edit:** Confirm **Actions → Build map data and publish** succeeded; test the home map, one route, a stop's today's departures, the trip planner, the frequency explanation, and a phone-size view. If the workflow fails, review the log; the previous successful site should remain available.

**Automation:** GTFS schedule, route shapes, stops, calendars, and published site rebuild daily. Swiftly live information is relayed through Cloudflare. Human edits should normally be limited to route blurbs, amenities, occasional overrides, credentials, or exception handling.

---

## Operations and maintenance

This guide is for GMT staff who keep the map running. Almost everything here is done in a web browser, on GitHub's website or in a service's account settings. No coding is needed for routine work.

**In one paragraph:** the map is a web page hosted free on GitHub Pages. Every night, an automated job (a GitHub "workflow") downloads GMT's published schedule (GTFS) from Trillium, turns it into the files the map reads, and republishes the site. Live bus locations, arrival predictions, service alerts and detours come from Swiftly through GMT's **relay** (a small Cloudflare Worker), which keeps the Swiftly key private and shares one copy of the live data with every visitor. If anything goes wrong in the nightly job, the last good version of the map stays up and a "Map update failed" issue is opened on GitHub, which emails everyone watching the repository. Riders can report problems from the map to planning@ridegmt.com.

---

### 1. Accounts and who owns them

Keep every account under a GMT-owned login, with at least two staff who can get in. Fill in this table and keep it current.

| Service | What it's for | Where to manage it | Owner / admins |
| --- | --- | --- | --- |
| GitHub (organization `GreenMountainTransit`, repo `system-map`) | Hosts the site and runs the nightly update | github.com → the repo → Settings | |
| Swiftly | Live bus locations, predictions, alerts and detours. The key is stored only in the Cloudflare relay (secret `SWIFTLY_KEY` on the Worker), not in GitHub. Rate limit: 1,000 requests per 15 minutes. | Swiftly dashboard / GMT's Swiftly rep | |
| Mapbox (GMT Planning account) | The basemap, place and address search, walking/cycling/driving directions and elevation for the trip planner (`MAPBOX_TOKEN` secret). Usage alert set at 80%. | account.mapbox.com → Tokens | |
| Cloudflare (GMT Planning account) | The relay (Worker `gmt-live-relay`) that fetches live data from Swiftly; holds the Swiftly key. Use the Workers paid plan ($5/month): the free plan stops at 100,000 requests a day. | dash.cloudflare.com → Workers & Pages | |
| Google Cloud (optional) | Street View inside stop details (`GOOGLE_MAPS_KEY`) | console.cloud.google.com → APIs & Services | |
| Trillium | Publishes GMT's GTFS (the link in the workflow file) | GMT's Trillium contact | |
| CivicPlus | The ridegmt.com pages that embed the map | CivicPlus admin | |
| planning@ridegmt.com | Where riders' "Report a problem with this map" emails go | GMT email | |

---

### 2. Routine checks

**Monthly (5 minutes)**
1. Open the repo's **Actions** tab. The recent **Build map data and publish** runs should have green checkmarks. One red X now and then is fine (the next night usually works). Several in a row means something needs attention; see section 4.
2. Open the map and click a stop. Under "Next departures" you should see **● Live predictions**. Buses should appear on the map.
3. Open the repo's **Issues** tab: there should be no open **"Map update failed"** issue (it closes itself after a successful build).
4. Look through the month's **problem reports** at planning@ridegmt.com (see "Rider problem reports" in section 3).

**Quarterly (15 minutes)**
1. **Mapbox usage:** account.mapbox.com → Statistics (an email alert is set at 80% of the free allowance). Each service has its own allowance: map loads; place and address searches (Search Box); directions (the trip planner's walking, cycling and driving routes, several per trip searched); and raster tiles (elevation for bike mode).
2. **Cloudflare usage:** dash.cloudflare.com → the relay Worker → **Metrics**. Every open map asks the relay for updates every few seconds, so requests grow with visitors. The paid plan covers 10 million a month.
3. **Feed expiry:** open the latest run in **Actions** → **build** → **Build data**. Look for a yellow warning that the feed ends soon. If you see one, check with Trillium that a new GTFS is coming.
4. **Outdated-step warnings:** in the same run, look for yellow warnings mentioning "deprecated" or "Node.js". See section 6.

---

### 3. Common tasks

#### Edit a route's description
Descriptions appear when hovering a route, in stop details, and at the top of route pages.
1. In the repo, click `route-info.json`, then the **pencil icon**.
2. Find the route number in the `"routes"` list and change the text between the quotation marks. Keep the quotes, and keep the comma at the end of the line if there was one.
3. **Commit changes**. The site rebuilds itself in about two minutes.

If you break the file's formatting (a missing quote or comma), the build fails and the old version stays up. Open the failed run to see the line number, then fix it.

#### A new route appears, or a route changes groups
New routes appear on the map automatically, in **Local routes** (300-series routes go to **School trippers** automatically).
- To give it a description, add a line to `"routes"` in `route-info.json`, like `"12": "Downtown Burlington to …",`
- To put it in a different group, add its number to that group's `"routes"` list near the top of `route-info.json`.
- To change whether a group is shown when the map opens, change its `"default"` to `"on"`, `"off"` or `"sundays"`.

#### Update stop amenities (shelters, seating, schedule boxes, ADA pads)
Amenities come from `amenities.csv`: one row per stop ID, with `yes`/`no` columns.
- **Small changes:** click `amenities.csv` → pencil icon, edit the row, and commit. Or edit it in Excel, **Save As → CSV**, and upload it to the top level of the repo.
- **From new field-survey exports:** someone with Node.js installed runs
  `node scripts/prepare-amenities.mjs gmt_stop_inspect.csv shelter_fixed_asset_inventory.csv`
  and uploads the resulting `amenities.csv`. This keeps only the yes/no columns, so internal notes and condition ratings stay private.
- After a build, the **Build data** step reports how many stops matched a row. If GMT renumbers stops, regenerate the file.

#### Set up the relay (one time)
The relay is a small Cloudflare Worker. It fetches live data from Swiftly every 15 seconds (alerts every 60) and shares it with every visitor, so the Swiftly key never appears on the public page and Swiftly sees a fixed number of requests no matter how busy the site is: about 135 per 15 minutes at the default settings, or 255 with `VEHICLES_TTL` = 5 (per Cloudflare location serving visitors; usually one to three). It also carries **service alerts** and **detours** (from Swiftly Service Adjustments), which browsers can't read from Swiftly directly.

1. Sign in at dash.cloudflare.com with the GMT Planning account. Open **Workers & Pages** (under **Compute** in newer layouts) → **Create** → **Hello World** → name it `gmt-live-relay` → **Deploy**.
2. The relay's code is `src/worker.js` in GitHub. If the Worker is connected to the repo (Cloudflare **Workers Builds**), committing a change to that file deploys it automatically; check the Worker's **Deployments** tab. Otherwise click **Edit code**, copy `src/worker.js` from GitHub (open it, then the **copy raw file** button), paste over everything in Cloudflare's editor, and click **Deploy**.
3. Go back to the Worker → **Settings → Variables and Secrets** → **Add**: Type **Secret**, name `SWIFTLY_KEY`, value: the **Website Key** from Swiftly. **Deploy**.
4. Copy the Worker's address from its overview page (like `https://gmt-live-relay.<name>.workers.dev`). Open it in a browser: it should say "GMT live map relay is running." Adding `/v1/vehicles` should show bus data.
5. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**: name `RELAY_URL`, value: the Worker address (no slash at the end).
6. **Actions → Build map data and publish → Run workflow**. The "Add keys" step should say "Using the relay; the Swiftly key stays private."
7. Check the map: buses show, a stop says "● Live predictions", and the browser console (F12) shows requests to the Worker, none to `api.goswift.ly`.

To stop using the relay (for example while troubleshooting), delete the `RELAY_URL` secret and re-run the workflow: the map goes back to calling Swiftly directly with `SWIFTLY_KEY` (which puts the key in the page).

#### Smoother bus movement (VEHICLES_TTL)
The relay refreshes bus positions from Swiftly every 15 seconds by default. Swiftly raised GMT's limit to **1,000 requests per 15 minutes** (October 2026), which allows 5-second updates: in Cloudflare, open the Worker → **Settings → Variables and Secrets** → add a **Text** variable `VEHICLES_TTL` = `5` and deploy. Buses then move every 5 seconds on the map and in 3D "follow a bus". That's about 255 Swiftly requests per 15 minutes per Cloudflare location, within the limit even with three locations busy. Remove the variable to go back to 15 seconds (for example if Swiftly reports the key going over its limit).

#### Detours and service alerts
- **Detours** appear when GMT staff set one up in Swiftly **Service Adjustments**: the detour path is drawn like the rest of the route (solid, route color, direction arrows), the bypassed stretch of the regular route fades back, closed stops are marked ×, and temporary stops are labeled with their names. Clicking a temporary stop shows its next times: live when Swiftly predicts them, otherwise estimated from the detour's timing. Nothing to do in this repo.
- **Service alerts** entered in Swiftly appear in a banner at the top of the map, on affected route pages, in affected stops' details, and as a warning mark next to the route in the list.
- Both need the relay. Without it, the map works the same but shows neither.

#### Replace the Swiftly key (with the relay)
Update the Worker's `SWIFTLY_KEY` secret in Cloudflare (step 3 above). Nothing needs to change in GitHub.

#### Replace the Swiftly key (without the relay -- fallback only)
GMT uses the relay, and the `SWIFTLY_KEY` GitHub secret was removed on purpose so the key can never end up in the public page. Only use this if the relay is retired.
1. Get the new key from Swiftly.
2. Repo → **Settings → Secrets and variables → Actions** → `SWIFTLY_KEY` → **Update**, paste the new key, and save.
3. **Actions → Build map data and publish → Run workflow**. In the run, the "Add keys" step should say "SWIFTLY_KEY added."

#### Replace the Mapbox token
The token is stored as a GitHub secret, not in the code.
1. At account.mapbox.com (GMT Planning's account) → **Tokens** → **Create a token**. Leave every **Secret scope** unchecked (the token must start with `pk.`). Under **URL restrictions** add `https://greenmountaintransit.github.io`.
2. Repo → **Settings → Secrets and variables → Actions** → `MAPBOX_TOKEN` → **Update**, paste the token, and save.
3. **Actions → Build map data and publish → Run workflow**. In the run, the "Add keys" step should say "MAPBOX_TOKEN added."
4. Check the map loads, then delete the old token in Mapbox.

#### Turn on embedded Street View (optional, free)
Without this, the Street View section in stop details shows a link that opens Google Maps.
1. In Google Cloud Console, create a project for GMT, attach a billing account (required by Google, but the Maps Embed API is free), and enable the **Maps Embed API**.
2. **APIs & Services → Credentials → Create credentials → API key**. Then edit the key and restrict it:
   - **Application restrictions:** Websites → `https://greenmountaintransit.github.io/*`
   - **API restrictions:** Maps Embed API only.
3. Add it to the repo as a secret named `GOOGLE_MAPS_KEY` (same steps as the Swiftly key), then run the workflow.

#### Trip planner: driving-cost comparison
Each suggested trip shows what driving it would cost in a typical car compared with the bus fare, with a **?** that explains the method. The figures are in `route-info.json` under `"trip_costs"`:
- `gas_price` and `gas_price_as_of`: update every few months (AAA's Vermont average is at gasprices.aaa.com/?state=VT).
- `bus_fare`, `bus_fare_discounted`, `bus_fare_daily_cap`, `bus_fare_monthly_cap`, `fare_url`: update if GMT's fares change (see ridegmt.com/166/Fare-Chart). The planner shows the regular fare, a "frequent riders pay about $1 a ride" line based on the monthly cap, the discounted fare, and a link to the fare chart. Shopping Specials count as free.
- `mpg` (now the Vermont statewide average, 22 mpg, with `mpg_source`), `maintenance_cents_per_mile`, `depreciation_cents_per_mile` and their sources: update when AAA publishes a new Your Driving Costs study (each September), or if you choose a different typical car.
Commit the file and the map picks up the new figures with the next build. Driving distances come from Mapbox driving directions (one request per trip searched, counted in Mapbox's free directions allowance).

#### Frequency map: checking routes and setting a route's frequency
- **How it's measured:** by each route's departures from its origin station -- the Downtown Transit Center, or the Essex Junction Amtrak station for Route 4 (a route that never goes downtown uses its most common first stop). Each trip counts toward a period by its time at the transit center, on every street it serves; streets shared by several routes add their departures together.
- The frequency map always shows GMT's **regular weekday schedule**: the services that run on most weekdays in the next two weeks, read from both GTFS calendar files (some services are defined only by date). Holidays and other one-day exceptions don't change it. In the evening view, hovering a street also shows each route's last weekday departure from the Downtown Transit Center. The **Build data** log says so: "Frequency map uses the regular weekday schedule (… trips …)".
- After each build, the **Build data** log has a line **"Frequency map by route: …"** listing every local route and how many frequency lines it got. A route with none gets a yellow warning saying why: no weekday trips, no trips during the rush hour / midday / evening windows, or every street it uses is already drawn under other routes (it still appears in those streets' route lists).
- **Manual settings for any route:** `route-info.json` → `"frequency_overrides"` has an entry for every local route. Leave it empty (`"5": {}`) to use the timetable. Add minutes for any period to **replace** the timetable figure for that route, faster or slower: `peak` (rush hour), `mid` (midday), `eve` (evening). For example, `"7": { "peak": 20 }` shows Route 7 every 20 minutes at rush hour and uses the timetable at other times, and `"8": { "peak": 60, "mid": 60 }` shows Route 8 hourly. Add `"inbound_only": true` to apply a setting only on trips heading to the Downtown Transit Center. Streets shared by several routes add their buses together (Route 7 every 20 + Route 8 every 60 = every 15). Leave out periods a route doesn't run (a setting for a period draws the route then). Commit the file and the next build uses it; the **Build data** log lists each route's settings.

#### Testing a new GTFS feed (preview link)
Use this to check a new schedule before it goes live, such as an upcoming feed from Trillium, or an older one. The live map stays on GMT's current feed throughout.
1. Get a link to the feed's `.zip` file. Trillium (support+ccta-vt-us@trilliumtransit.com) can share an upcoming feed, and MobilityData keeps every past version of GMT's feed at mobilitydatabase.org/feeds/gtfs/mdb-629 (each version has a download link).
2. In GitHub, open **Actions**, then **Build map data and publish**, then **Run workflow**.
3. Paste the link into **GTFS URL**. If the feed starts in the future (or ended in the past), put a date it covers in **Build date** (YYYY-MM-DD); the build only accepts a feed with service in the 7 days from that date.
4. Check **Test only**, then click **Run workflow**.
5. When it finishes, open the run. Its summary shows the dates the feed covers; its routes, stops and trips; the frequency map line; any warnings; and the **preview link**:
   **https://greenmountaintransit.github.io/system-map/?preview=1**
6. Open the preview link. It's the full map running on the test schedule, behaving as if it were the build date you entered, so departures and the trip planner use the test schedule. A dark red banner says it's a preview, with the feed's dates. Live buses are off in the preview, since they belong to today's real service. Route pages work too: add `&preview=1` (for example `?route=2&preview=1`).

The preview stays available (nightly builds keep it) until you run another test, for up to 90 days. If the test feed fails to build, nothing is published and the live map is unchanged. Test runs never open a "Map update failed" issue. The preview's data and build logs are also under **Artifacts** on the run's page as **test-map-data**.

When the new feed is ready to go live, Trillium publishes it at GMT's usual feed address and the nightly build picks it up automatically, so nothing needs changing.

#### Build failure alerts
If the nightly update fails, **the live map stays up** with its last good data, and two alerts go out:
- **A GitHub issue titled "Map update failed"** is opened automatically, with a link to the failed run. Everyone **watching** the repository gets it by email. To get these emails, open the repository on GitHub, click **Watch**, and choose **All activity** (or **Custom**, then **Issues**). Repeated failures add comments to the same issue rather than opening new ones, and the issue **closes itself** the next time the map updates successfully.
- **GitHub's own Actions email** goes to one person: whoever last changed the schedule in `.github/workflows/build-data.yml`. Turn it on at github.com/settings/notifications → System → Actions → **Email** and **Only notify for failed workflows**.

To see what went wrong: open the link in the issue, click the step with the red X, and read the last lines of its log. The most common cause is an expired GTFS feed (GMT's current feed ends January 1, 2027); the build refuses to publish a feed with no service in the next 7 days, so the map keeps its old data until Trillium publishes the new feed.

#### Rider problem reports
At the end of every view, the map says "Times, trip plans and cost savings are estimates" and offers **Report a problem with this map**, which opens an email to **planning@ridegmt.com** with the subject "Problem with the GMT system map". The email includes:
- **View:** which part of the map they were using (Routes, Trip planner, Frequency map, or a route page; "PREVIEW" if it was the test preview).
- **Map address:** a link that opens the map **exactly as the rider saw it**: the same tab, trip, routes and map position. Open it to reproduce the problem.
- **Device:** their browser and phone or computer, useful when something only happens on one kind of device.

To send reports somewhere else: in `public/index.html`, search for `REPORT_EMAIL` and change the address on that line.

#### Amenities set by stop name
`route-info.json` → `"amenity_overrides"` sets amenities for every stop whose name contains some text, whatever the stop survey says. It's used so every **Downtown Transit Center** bay shows a shelter, seating, a posted schedule and an ADA pad. The build log says how many stops it applied to.

#### Ridership in stop details
The **Ridership** section in each stop's details comes from GMT's ArcGIS Online layer `Detail_Ridership_V2` (one record per month, route and stop). Rows where `routes_token` is `|0|` are the layer's all-routes summary rows (for the AGOL dashboard) and are skipped, so boardings aren't double-counted. The build adds the remaining route rows together, so only stop-level totals are published; route-level numbers never reach the site. Ranks compare stop totals, among all stops and among the stops each route serves. The nightly build reads every month in it. Riders can view the last 6 months, year to date, the last 12 months, or all months.
- New months appear automatically the night after the layer is updated.
- If the layer moves, put its new address (ending in `/FeatureServer/0`) in `route-info.json` under `"ridership"` → `"layer"`. The `"dashboard"` line sets where "Explore the stops dashboard" links to.
- The build expects these fields: `date` (first day of the month), `stop_id`, `total_boardings`, and `routes_token` (to skip the `|0|` summary rows). If they're renamed, the build log shows "Ridership data unavailable" and stops show without the section; the rest of the map is unaffected.
- The layer must stay shared publicly.

#### Trillium changes the GTFS link
Open `.github/workflows/build-data.yml` → pencil icon → find the line starting `CURRENT_GTFS:` (the only place the link appears), replace the link after it, and commit. The commit runs a build with the new link; check it has a green checkmark.

#### Change the opening map view
In `public/index.html`, find `HOME_BOUNDS`. The two pairs are the southwest and northeast corners as [longitude, latitude]. To get coordinates, right-click a spot in Google Maps; Google shows latitude first, so swap the order.

#### Embed a route page on ridegmt.com
In CivicPlus, add a **Custom HTML** widget with:
```html
<iframe src="https://greenmountaintransit.github.io/system-map/?route=2" title="Route 2 live map and arrival times"
  width="100%" height="650" style="border:0" loading="lazy" allow="geolocation; fullscreen" allowfullscreen></iframe>
```
Change both `2`s to the route number. The system map is the same without `?route=2`. Keep `allow="geolocation; fullscreen" allowfullscreen`: it lets **Find my location** and the **Expand** button work inside the page. (Without `fullscreen`, Expand opens the map as its own page instead, which is also how it works on iPhones.)

---

### 4. When the nightly build fails

A **"Map update failed"** issue opens on GitHub (emailing everyone watching the repository), with a link to the failed run; it closes itself after the next successful build. The live map keeps showing the last good version, so there's no emergency.

1. Open **Actions**, click the failed run (red X), then the **build** job, and expand the step with the red X.
2. Read the last few lines and match them below.

| What the log says | What it means | What to do |
| --- | --- | --- |
| `curl: (22) … 404` or `Could not resolve host` in **Download GTFS** | Trillium's link changed or was briefly down | Check the link opens in a browser. If it's down, wait a day. If it moved, update it (section 3). |
| `GTFS check failed: no service in the 7 days…` | The published feed is expired or only covers future dates | Contact Trillium. The map keeps the previous schedule until a good feed appears. |
| `GTFS check failed: no routes` / `no stops`, or `Error: Missing trips.txt` | The download wasn't a complete GTFS | Same as above. |
| `No MAPBOX_TOKEN secret set` | The Mapbox token secret is missing | Add it (section 3, Replace the Mapbox token). |
| `SyntaxError … route-info.json` or `Unexpected token` | A typo in `route-info.json` | Open the file and fix the quote or comma near the line mentioned, or undo the last change (section 5). |
| `Ridership data unavailable` (yellow warning) | The ArcGIS layer couldn't be read (moved, unshared, or fields renamed) | See "Ridership in stop details" in section 3. The map still publishes. |
| Map says "Live bus locations are unavailable" and the console shows errors from the Worker address | The relay can't reach Swiftly (wrong or missing `SWIFTLY_KEY` secret in Cloudflare) or the Worker is down | Open the Worker address in a browser; check its `SWIFTLY_KEY` secret; check Cloudflare's **Logs** tab for the Worker. |
| `Overpass … failed` (a yellow warning, not red) | The nearby-places lookup was unavailable | Nothing; stops show without nearby places until the next night. |
| A failure in **deploy** | GitHub Pages hiccup | Re-run the workflow (**Re-run jobs** button). |

To start a fresh build any time: **Actions → Build map data and publish → Run workflow**.

---

#### Checking live data on a phone (or any device)
Add `?debug=1` to the map's address, for example `https://greenmountaintransit.github.io/system-map/?debug=1`, or `?route=2&debug=1` on a route page. A small panel in the bottom-left shows whether the relay is working, how many buses are on the map, today's date as the map sees it, how many detours Swiftly sent and how many are drawn, and how many alerts are active. Useful when something shows on one device but not another.

### 5. Undo a bad change

GitHub keeps every version of every file.
- **One file:** open the file → **History** (top right) → click the last good version → **…** → **View file**. Copy its contents, then edit the current file, paste over it, and commit.
- **A whole commit:** on the repo's main page, click the commit count (for example "123 commits"), click the bad commit, and use **Revert** if it's offered. Otherwise undo each file as above.

---

### 6. Yearly upkeep

These come from outside services changing, not from the map breaking.
- **GitHub workflow steps:** when GitHub retires a version of a step, the run log shows a yellow warning months in advance. In `.github/workflows/build-data.yml`, raise the version number it names (for example `actions/checkout@v4` to `@v5`), following GitHub's guidance in the warning.
- **Node.js (the build's runtime):** the workflow runs the build on Node.js 22 (`node-version: 22` in `.github/workflows/build-data.yml`), supported until April 2027. Before then, change it to `24` and run the workflow once to check it builds.
- **Mapbox GL JS:** `public/index.html` loads version 3.6.0 (the two lines near the top containing `mapbox-gl-js/v3.6.0`). It doesn't need updating unless something stops working. If you update, change both lines to the same newer version, then test the map.
- **Swiftly:** if Swiftly changes its API, live buses or predictions stop, and stops show "Live predictions are unavailable." Ask Swiftly what changed. The code that talks to Swiftly is all in `public/live.js`.
- **Swiftly rate limit:** if the status line often says live data is unavailable at busy times, ask Swiftly to raise the key's limit.

---

### 7. Test an older or upcoming GTFS

Use **Test only** and the preview link: see "Testing a new GTFS feed (preview link)" in section 3. The live map is never affected.

(Running the workflow with a different GTFS link **without** Test only publishes that feed to the live map until the next nightly build replaces it, around 4:15 AM. Only do that deliberately, at a quiet time.)

---

### 8. Emergency fallback

If the map ever has to come down, replace its iframe on ridegmt.com with the previous Swiftly embed. **Paste that embed code below before launch**, so it's at hand when needed:

```html
<!-- paste the old Swiftly embed code here -->
```

---

### 9. Where things are in the code

Each section of the code starts with a comment line like `// ---------- stop details panel ----------`. Search for these with Ctrl+F.

| To change… | File | Search for |
| --- | --- | --- |
| Opening view | `public/index.html` | `HOME_BOUNDS` |
| Basemaps offered | `public/index.html` | `BASEMAPS` |
| How often live data refreshes | `public/index.html` | `REFRESH_MS` |
| Click-to-activate shade (embeds) | `public/index.html` | `Click to activate` |
| Route draw-in animation on first load | `public/index.html` | `animateBuild` |
| Walking limits for "service near you" | `public/index.html` | `const WALK` |
| Place and address search | `public/index.html` | `searchPlaces` |
| Trip planner recent places and popular stops | `public/index.html` | `RECENT_MAX`, `popularStops` |
| Trip planner preferences (fastest, least walking, fewest transfers, wheelchair-accessible stops, bike to and from the bus) | `public/planner.js` | `sortByPref`, `acc`, `BIKE_ACCESS_M` |
| Walk / bike options and how trip options are sorted (one list, badge on top) | `public/index.html` | `fetchAlternatives`, `altCard`, `planResultsHtml` |
| Bike mode and hills: heights looked up for the start, finish and nearby stops; extra bike time per meter climbed; flatter bike routes chosen | `public/planner.js` (`CLIMB_SECS_PER_M`, `bikeHillSecs`) and `public/index.html` (`bikeElevations`, `streetRoute`, `climb`) |
| Directions from a searched place (Google Maps style) | `public/index.html` | `goDirections` |
| The ? Helpful hints, the first-visit hints, and hover labels on map buttons | `public/index.html` | `toggleHelp`, `ctrlHint`, `HOVER_LABELS` |
| Place and address search area (Chittenden, Washington and Franklin counties; Chittenden listed first) | `public/index.html` | `SERVICE_COUNTIES`, `VT_BBOX`, `chittendenFirst` |
| 3D view and following a bus (desktop) | `public/index.html` | `setThreeD`, `startFollow` (size: `BUS_LEN`; how far behind live it replays: `FOLLOW_DELAY_MS`) |
| The detailed 3D bus (livery, logo, driver, signs) and the 3D stop sign | `public/bus3d.js` and `public/gmt-logo.png` | `busTexture`, `drawDriver`, `signTexture` |
| 3D view: all buses in 3D, and street-level stop view | `public/index.html` | `fleetFrame`, `enterStopView` |
| Planner walking paths (Mapbox walking directions) | `public/index.html` | `fetchWalks` |
| Frequency tiers and colors | `public/index.html` | `const FREQ` and `tierOf` |
| Manual frequency settings for any route (frequency map) | `route-info.json` | `frequency_overrides` |
| Frequency time windows | `scripts/build-data.mjs` | `FREQ_WINDOWS` |
| How "nearby" is defined (meters) | `scripts/build-data.mjs` | `NEARBY_METERS` |
| Amenity labels | `scripts/build-data.mjs` | `AMENITY_COLUMNS` |
| Talking to Swiftly (direct) or the relay | `public/live.js` | `swiftly(`, `relay(` |
| The relay itself (refresh intervals, allowed sites) | `src/worker.js` | `FEEDS`, `ALLOWED_ORIGINS` |
| Trip planner walking limits, transfer time, number of buses | `public/planner.js` | `ACCESS_M`, `TRANSFER_M`, `TRANSFER_BUFFER`, `MAX_RIDES` |
| Live timing for every bus and transfer in the trip planner | `public/planner.js` | `applyLive` |
| "Stay on board" when a bus turns around and continues (same block, e.g. Route 96 at the St. Albans Park and Ride) | `public/planner.js` | `Stay on board`, `stayAt` |
| Trip lines drawn along each trip's own GTFS shape | `public/index.html` | `tripPath`, `shapeSlice` |
| Quickest walking route (several Mapbox options compared) | `public/index.html` | `streetRoute` |
| Frequency measured by transit center departures | `scripts/build-data.mjs` | `refTime`, `outbound` |
| Test preview (`?preview=1`) | `public/index.html` (`startPreview`) and `.github/workflows/build-data.yml` (`test_only`) |
| "Report a problem" email address | `public/index.html` | `REPORT_EMAIL` |
| Text colors (kept at WCAG AA contrast; check before darkening or lightening) | `public/index.html` | `--muted`, `--faint` |
| Nightly schedule time | `.github/workflows/build-data.yml` | `cron` |

---

### 10. Glossary

- **GTFS:** the standard file format for transit schedules: routes, stops, trips and times. GMT's is published by Trillium.
- **Swiftly:** GMT's real-time vendor. Provides live bus positions and predicted arrival times.
- **Timepoint:** a stop with a scheduled time in the timetable; buses don't leave early from timepoints.
- **Workflow / Actions:** GitHub's automation. Ours is "Build map data and publish."
- **Secret:** a value stored privately in GitHub settings and added to the site at build time (`MAPBOX_TOKEN`, `RELAY_URL`, `GOOGLE_MAPS_KEY`, and `SWIFTLY_KEY` if not using the relay).
- **Relay:** the Cloudflare Worker that fetches live data from Swiftly for all visitors, keeping the key private.
- **Detour / trip modification:** a temporary route change set up in Swiftly Service Adjustments.
- **Commit:** saving a change to a file in the repo. Commits to map files trigger a rebuild.
- **Block:** in GTFS, the trips one bus drives in a row. When a trip ends where the next one on its block begins, riders can stay on board, and the trip planner treats it as one ride.
- **Preview:** the map running on a test GTFS at `?preview=1`, built with **Test only**. Riders never see it unless given the link.
