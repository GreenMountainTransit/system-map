# GMT System Map: non-coder editing guide

## Routine editing (no programming required)

1. Open **route-info.json** in the repository on GitHub, and click the pencil (Edit).
2. Under **routes**, find the quoted route number, such as `"7"`, and change only its description between the quotation marks.
3. Leave commas, braces and route-number keys intact. Click **Commit changes** to `main`.
4. Open **Actions → Build map data and publish**. Wait for a successful run, then refresh the published map. If the run fails, leave the prior successful site in place and ask a maintainer to check the build logs.

For route legend groups, edit the **groups** entries in the same file. The `default` values are `on`, `off`, or `sundays`. Route geometry, service calendars, stop lists, timetables and route names come from the published GTFS feed, not this file.

For stop amenities, edit **amenities.csv** with a spreadsheet editor, preserving column names and stop IDs. See MAINTENANCE.md for field definitions. Commit the CSV and wait for Actions.

## Frequency map — how to explain it to riders

It shows estimated scheduled local buses per hour on shared street segments, expressed in approximate intervals. Routes sharing streets are combined. The current build classifies trips using a reference time at DTC, or the route's origin when DTC is not served. This is a corridor-level average, not actual stop headways, and does not capture bunching or direction-specific departures. The stop timetable and trip planner are better for time-specific travel decisions.

The **frequency_overrides** block in route-info.json can replace timetable-derived estimates for specific routes and periods. Do not alter overrides solely to make the map look more frequent; verify against GTFS and record why a manual value is needed. The goal should be to retire unnecessary overrides when source feeds are reliable.

## Maintenance ownership

- **Daily, automated:** GTFS retrieval, rebuild, validation and site deployment through GitHub Actions.
- **Live, automated:** Swiftly requests through Cloudflare Worker; API secret remains outside GitHub Pages.
- **Only when information changes:** Route blurbs/groups, curated amenities, fare and driving-cost assumptions, manually overridden frequency values.
- **Occasional check:** Github Actions build failures, expiration of GTFS coverage, Swiftly relay freshness and key rotation.

## Go-live checks after any edit

Check the Actions run succeeded, route 1 and route 7 appear, route-specific pages open, a stop shows current-day departures, trip planning returns plausible itineraries, and the frequency map disclaimer is visible. Check at least one phone width. Never edit the generated files under public/data by hand, because the next automated run will overwrite them.

## Keeping maintenance close to zero

Use a single content configuration (`route-info.json`) instead of editing descriptions in HTML/JavaScript. Avoid introducing manually maintained service dates or static stop lists; derive those from GTFS each build. Do not promise completely zero maintenance: API credentials, feed outages, and exceptional service changes still require monitoring and ownership.
