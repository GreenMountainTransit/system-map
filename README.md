# GMT System Map Update

Replace `public/index.html` and `public/live.js` with the files in this ZIP. `live.js` is included unchanged to keep a complete matching pair.

- Preserve live bus status across mobile tray/route panel rebuilds.
- Service near you resets route visibility filters (on the system map).
- Both location and map-pin options list up to 16 nearest stops by distance, then next arrivals within each stop by departure time.
- Reuses existing GTFS and Swiftly relay data; no new API endpoints or Cloudflare Worker changes.

Note: On a dedicated `?route=` page, its page-wide route scope remains in effect for the map; open the system map for the full-network view.
