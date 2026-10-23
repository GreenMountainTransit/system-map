# Maintaining the GMT system map

This guide is for GMT staff who keep the map running. Almost everything here is done in a web browser, on GitHub's website or in a service's account settings. No coding is needed for routine work.

**In one paragraph:** the map is a web page hosted free on GitHub Pages. Every night, an automated job (a GitHub "workflow") downloads GMT's published schedule (GTFS) from Trillium, turns it into the files the map reads, and republishes the site. Live bus locations and arrival predictions come straight from Swiftly in each visitor's browser. If anything goes wrong in the nightly job, the last good version of the map stays up.

---

## 1. Accounts and who owns them

Keep every account under a GMT-owned login, with at least two staff who can get in. Fill in this table and keep it current.

| Service | What it's for | Where to manage it | Owner / admins |
| --- | --- | --- | --- |
| GitHub (organization `GreenMountainTransit`, repo `system-map`) | Hosts the site and runs the nightly update | github.com → the repo → Settings | |
| Swiftly | Live bus locations and arrival predictions (`SWIFTLY_KEY`) | Swiftly dashboard / GMT's Swiftly rep | |
| Mapbox (GMT Planning account) | The basemap and trip planner address search (`MAPBOX_TOKEN` secret) | account.mapbox.com → Tokens | |
| Cloudflare (GMT Planning account) | The relay (Worker `gmt-live-relay`) that fetches live data from Swiftly; holds the Swiftly key | dash.cloudflare.com → Workers & Pages | |
| Google Cloud (optional) | Street View inside stop details (`GOOGLE_MAPS_KEY`) | console.cloud.google.com → APIs & Services | |
| Trillium | Publishes GMT's GTFS (the link in the workflow file) | GMT's Trillium contact | |
| CivicPlus | The ridegmt.com pages that embed the map | CivicPlus admin | |

---

## 2. Routine checks

**Monthly (5 minutes)**
1. Open the repo's **Actions** tab. The recent **Build map data and publish** runs should have green checkmarks. One red X now and then is fine (the next night usually works). Several in a row means something needs attention; see section 4.
2. Open the map and click a stop. Under "Next departures" you should see **● Live predictions**. Buses should appear on the map.

**Quarterly (15 minutes)**
1. **Mapbox usage:** account.mapbox.com → Statistics. The free plan covers 50,000 map loads a month; address searches (geocoding) and the trip planner's walking paths (directions) each have their own free allowance.
2. **Feed expiry:** open the latest run in **Actions** → **build** → **Build data**. Look for a yellow warning that the feed ends soon. If you see one, check with Trillium that a new GTFS is coming.
3. **Outdated-step warnings:** in the same run, look for yellow warnings mentioning "deprecated" or "Node.js". See section 6.

---

## 3. Common tasks

### Edit a route's description
Descriptions appear when hovering a route, in stop details, and at the top of route pages.
1. In the repo, click `route-info.json`, then the **pencil icon**.
2. Find the route number in the `"routes"` list and change the text between the quotation marks. Keep the quotes, and keep the comma at the end of the line if there was one.
3. **Commit changes**. The site rebuilds itself in about two minutes.

If you break the file's formatting (a missing quote or comma), the build fails and the old version stays up. Open the failed run to see the line number, then fix it.

### A new route appears, or a route changes groups
New routes appear on the map automatically, in **Local routes** (300-series routes go to **School trippers** automatically).
- To give it a description, add a line to `"routes"` in `route-info.json`, like `"12": "Downtown Burlington to …",`
- To put it in a different group, add its number to that group's `"routes"` list near the top of `route-info.json`.
- To change whether a group is shown when the map opens, change its `"default"` to `"on"`, `"off"` or `"sundays"`.

### Update stop amenities (shelters, seating, schedule boxes, ADA pads)
Amenities come from `amenities.csv`: one row per stop ID, with `yes`/`no` columns.
- **Small changes:** click `amenities.csv` → pencil icon, edit the row, and commit. Or edit it in Excel, **Save As → CSV**, and upload it to the top level of the repo.
- **From new field-survey exports:** someone with Node.js installed runs
  `node scripts/prepare-amenities.mjs gmt_stop_inspect.csv shelter_fixed_asset_inventory.csv`
  and uploads the resulting `amenities.csv`. This keeps only the yes/no columns, so internal notes and condition ratings stay private.
- After a build, the **Build data** step reports how many stops matched a row. If GMT renumbers stops, regenerate the file.

### Set up the relay (one time)
The relay is a small Cloudflare Worker. It fetches live data from Swiftly every 15 seconds (alerts every 60) and shares it with every visitor, so the Swiftly key never appears on the public page and Swiftly sees about 135 requests per 15 minutes no matter how busy the site is. It also carries **service alerts** and **detours** (from Swiftly Service Adjustments), which browsers can't read from Swiftly directly.

1. Sign in at dash.cloudflare.com with the GMT Planning account. Open **Workers & Pages** (under **Compute** in newer layouts) → **Create** → **Hello World** → name it `gmt-live-relay` → **Deploy**.
2. Click **Edit code**. Open `relay/worker.js` from this repo (click it, then the **copy raw file** button), select everything in Cloudflare's editor, paste over it, and click **Deploy**.
3. Go back to the Worker → **Settings → Variables and Secrets** → **Add**: Type **Secret**, name `SWIFTLY_KEY`, value: the **Website Key** from Swiftly. **Deploy**.
4. Copy the Worker's address from its overview page (like `https://gmt-live-relay.<name>.workers.dev`). Open it in a browser: it should say "GMT live map relay is running." Adding `/v1/vehicles` should show bus data.
5. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**: name `RELAY_URL`, value: the Worker address (no slash at the end).
6. **Actions → Build map data and publish → Run workflow**. The "Add keys" step should say "Using the relay; the Swiftly key stays private."
7. Check the map: buses show, a stop says "● Live predictions", and the browser console (F12) shows requests to the Worker, none to `api.goswift.ly`.

To stop using the relay (for example while troubleshooting), delete the `RELAY_URL` secret and re-run the workflow: the map goes back to calling Swiftly directly with `SWIFTLY_KEY` (which puts the key in the page).

### Smoother bus following (after Swiftly raises the limit)
In 3D view, following a bus asks the relay for its position every 5 seconds and glides the 3D bus between reports. The relay refreshes positions from Swiftly every 15 seconds by default. Once Swiftly's limit is at least 600 requests per 15 minutes, add a **Text** variable `VEHICLES_TTL` = `5` to the Worker (Settings → Variables and Secrets) and deploy, so positions update every 5 seconds. Remove it to go back to 15.

### Detours and service alerts
- **Detours** appear when GMT staff set one up in Swiftly **Service Adjustments**: the detour path is drawn like the rest of the route (solid, route color, direction arrows), the bypassed stretch of the regular route fades back, closed stops are marked ×, and temporary stops are labeled with their names. Clicking a temporary stop shows its next times: live when Swiftly predicts them, otherwise estimated from the detour's timing. Nothing to do in this repo.
- **Service alerts** entered in Swiftly appear in a banner at the top of the map, on affected route pages, in affected stops' details, and as a warning mark next to the route in the list.
- Both need the relay. Without it, the map works the same but shows neither.

### Replace the Swiftly key (with the relay)
Update the Worker's `SWIFTLY_KEY` secret in Cloudflare (step 3 above). Nothing needs to change in GitHub.

### Replace the Swiftly key (without the relay)
1. Get the new key from Swiftly.
2. Repo → **Settings → Secrets and variables → Actions** → `SWIFTLY_KEY` → **Update**, paste the new key, and save.
3. **Actions → Build map data and publish → Run workflow**. In the run, the "Add keys" step should say "SWIFTLY_KEY added."

### Replace the Mapbox token
The token is stored as a GitHub secret, not in the code.
1. At account.mapbox.com (GMT Planning's account) → **Tokens** → **Create a token**. Leave every **Secret scope** unchecked (the token must start with `pk.`). Under **URL restrictions** add `https://greenmountaintransit.github.io`.
2. Repo → **Settings → Secrets and variables → Actions** → `MAPBOX_TOKEN` → **Update**, paste the token, and save.
3. **Actions → Build map data and publish → Run workflow**. In the run, the "Add keys" step should say "MAPBOX_TOKEN added."
4. Check the map loads, then delete the old token in Mapbox.

### Turn on embedded Street View (optional, free)
Without this, the Street View section in stop details shows a link that opens Google Maps.
1. In Google Cloud Console, create a project for GMT, attach a billing account (required by Google, but the Maps Embed API is free), and enable the **Maps Embed API**.
2. **APIs & Services → Credentials → Create credentials → API key**. Then edit the key and restrict it:
   - **Application restrictions:** Websites → `https://greenmountaintransit.github.io/*`
   - **API restrictions:** Maps Embed API only.
3. Add it to the repo as a secret named `GOOGLE_MAPS_KEY` (same steps as the Swiftly key), then run the workflow.

### Ridership in stop details
The **Ridership** section in each stop's details comes from GMT's ArcGIS Online layer `Detail_Ridership_V2` (one record per month, route and stop). Rows where `routes_token` is `|0|` are the layer's all-routes summary rows (for the AGOL dashboard) and are skipped, so boardings aren't double-counted. The build adds the remaining route rows together, so only stop-level totals are published; route-level numbers never reach the site. Ranks compare stop totals, among all stops and among the stops each route serves. The nightly build reads every month in it. Riders can view the last 6 months, year to date, the last 12 months, or all months.
- New months appear automatically the night after the layer is updated.
- If the layer moves, put its new address (ending in `/FeatureServer/0`) in `route-info.json` under `"ridership"` → `"layer"`. The `"dashboard"` line sets where "Explore the stops dashboard" links to.
- The build expects these fields: `date` (first day of the month), `stop_id`, `total_boardings`, and `routes_token` (to skip the `|0|` summary rows). If they're renamed, the build log shows "Ridership data unavailable" and stops show without the section; the rest of the map is unaffected.
- The layer must stay shared publicly.

### Trillium changes the GTFS link
Open `.github/workflows/build-data.yml` → pencil icon → find the line with `ccta-vt-us.zip`, replace the link (keep the quotes), and commit.

### Change the opening map view
In `public/index.html`, find `HOME_BOUNDS`. The two pairs are the southwest and northeast corners as [longitude, latitude]. To get coordinates, right-click a spot in Google Maps; Google shows latitude first, so swap the order.

### Embed a route page on ridegmt.com
In CivicPlus, add a **Custom HTML** widget with:
```html
<iframe src="https://greenmountaintransit.github.io/system-map/?route=2" title="Route 2 live map and arrival times"
  width="100%" height="650" style="border:0" loading="lazy" allow="geolocation; fullscreen" allowfullscreen></iframe>
```
Change both `2`s to the route number. The system map is the same without `?route=2`. Keep `allow="geolocation; fullscreen" allowfullscreen`: it lets **Find my location** and the **Expand** button work inside the page. (Without `fullscreen`, Expand opens the map as its own page instead, which is also how it works on iPhones.)

---

## 4. When the nightly build fails

GitHub emails the repo admins (usually whoever last edited the workflow file). The live map keeps showing the last good version, so there's no emergency.

1. Open **Actions**, click the failed run (red X), then the **build** job, and expand the step with the red X.
2. Read the last few lines and match them below.

| What the log says | What it means | What to do |
| --- | --- | --- |
| `curl: (22) … 404` or `Could not resolve host` in **Download GTFS** | Trillium's link changed or was briefly down | Check the link opens in a browser. If it's down, wait a day. If it moved, update it (section 3). |
| `GTFS check failed: no service in the 7 days…` | The published feed is expired or only covers future dates | Contact Trillium. The map keeps the previous schedule until a good feed appears. |
| `GTFS check failed: no routes` / `no stops` | The download wasn't a real GTFS | Same as above. |
| `No MAPBOX_TOKEN secret set` | The Mapbox token secret is missing | Add it (section 3, Replace the Mapbox token). |
| `SyntaxError … route-info.json` or `Unexpected token` | A typo in `route-info.json` | Open the file and fix the quote or comma near the line mentioned, or undo the last change (section 5). |
| `Ridership data unavailable` (yellow warning) | The ArcGIS layer couldn't be read (moved, unshared, or fields renamed) | See "Ridership in stop details" in section 3. The map still publishes. |
| Map says "Live bus locations are unavailable" and the console shows errors from the Worker address | The relay can't reach Swiftly (wrong or missing `SWIFTLY_KEY` secret in Cloudflare) or the Worker is down | Open the Worker address in a browser; check its `SWIFTLY_KEY` secret; check Cloudflare's **Logs** tab for the Worker. |
| `Overpass … failed` (a yellow warning, not red) | The nearby-places lookup was unavailable | Nothing; stops show without nearby places until the next night. |
| A failure in **deploy** | GitHub Pages hiccup | Re-run the workflow (**Re-run jobs** button). |

To start a fresh build any time: **Actions → Build map data and publish → Run workflow**.

---

## 5. Undo a bad change

GitHub keeps every version of every file.
- **One file:** open the file → **History** (top right) → click the last good version → **…** → **View file**. Copy its contents, then edit the current file, paste over it, and commit.
- **A whole commit:** on the repo's main page, click the commit count (for example "123 commits"), click the bad commit, and use **Revert** if it's offered. Otherwise undo each file as above.

---

## 6. Yearly upkeep

These come from outside services changing, not from the map breaking.
- **GitHub workflow steps:** when GitHub retires a version of a step, the run log shows a yellow warning months in advance. In `.github/workflows/build-data.yml`, raise the version number it names (for example `actions/checkout@v4` to `@v5`), following GitHub's guidance in the warning.
- **Mapbox GL JS:** `public/index.html` loads version 3.6.0 (the two lines near the top containing `mapbox-gl-js/v3.6.0`). It doesn't need updating unless something stops working. If you update, change both lines to the same newer version, then test the map.
- **Swiftly:** if Swiftly changes its API, live buses or predictions stop, and stops show "Live predictions are unavailable." Ask Swiftly what changed. The code that talks to Swiftly is all in `public/live.js`.
- **Swiftly rate limit:** if the status line often says live data is unavailable at busy times, ask Swiftly to raise the key's limit.

---

## 7. Test an older GTFS

**Actions → Build map data and publish → Run workflow**, then fill in:
- **GTFS link:** the .zip address of the feed to test (for example an archived GMT feed from the Mobility Database).
- **Build date:** a day the feed covers, as YYYY-MM-DD.

This publishes the test build to the live site, so do it at a quiet time. Arrival times use the real clock, so stops may show no upcoming buses during the test. When you're done, run the workflow again with both boxes empty.

---

## 8. Emergency fallback

If the map ever has to come down, replace its iframe on ridegmt.com with the previous Swiftly embed. Keep that embed code here:

```html
<!-- paste the old Swiftly embed code here -->
```

---

## 9. Where things are in the code

Each section of the code starts with a comment line like `// ---------- stop details panel ----------`. Search for these with Ctrl+F.

| To change… | File | Search for |
| --- | --- | --- |
| Opening view | `public/index.html` | `HOME_BOUNDS` |
| Basemaps offered | `public/index.html` | `BASEMAPS` |
| How often live data refreshes | `public/index.html` | `REFRESH_MS` |
| Click-to-activate shade (embeds) | `public/index.html` | `Click to activate` |
| Route draw-in animation on first load | `public/index.html` | `animateBuild` |
| Walking limits for "service near you" | `public/index.html` | `const WALK` |
| 3D view and following a bus (desktop) | `public/index.html` | `setThreeD`, `startFollow` (size: `BUS_LEN`; how far behind live it replays: `FOLLOW_DELAY_MS`) |
| The detailed 3D bus (livery, logo, driver, signs) | `public/bus3d.js` and `public/assets/gmt-logo.png` | `texture`, `drawDriver` |
| Planner walking paths (Mapbox walking directions) | `public/index.html` | `fetchWalks` |
| Frequency tiers and colors | `public/index.html` | `const FREQ` and `tierOf` |
| Frequency time windows | `scripts/build-data.mjs` | `FREQ_WINDOWS` |
| How "nearby" is defined (meters) | `scripts/build-data.mjs` | `NEARBY_METERS` |
| Amenity labels | `scripts/build-data.mjs` | `AMENITY_COLUMNS` |
| Talking to Swiftly (direct) or the relay | `public/live.js` | `swiftly(`, `relay(` |
| The relay itself (refresh intervals, allowed sites) | `relay/worker.js` | `FEEDS`, `ALLOWED_ORIGINS` |
| Trip planner walking limits, transfer time, number of buses | `public/planner.js` | `ACCESS_M`, `TRANSFER_M`, `TRANSFER_BUFFER`, `MAX_RIDES` |
| Nightly schedule time | `.github/workflows/build-data.yml` | `cron` |

---

## 10. Glossary

- **GTFS:** the standard file format for transit schedules: routes, stops, trips and times. GMT's is published by Trillium.
- **Swiftly:** GMT's real-time vendor. Provides live bus positions and predicted arrival times.
- **Timepoint:** a stop with a scheduled time in the timetable; buses don't leave early from timepoints.
- **Workflow / Actions:** GitHub's automation. Ours is "Build map data and publish."
- **Secret:** a value stored privately in GitHub settings and added to the site at build time (`MAPBOX_TOKEN`, `RELAY_URL`, `GOOGLE_MAPS_KEY`, and `SWIFTLY_KEY` if not using the relay).
- **Relay:** the Cloudflare Worker that fetches live data from Swiftly for all visitors, keeping the key private.
- **Detour / trip modification:** a temporary route change set up in Swiftly Service Adjustments.
- **Commit:** saving a change to a file in the repo. Commits to map files trigger a rebuild.
