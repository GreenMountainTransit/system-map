GMT System Map - smooth 2D bus updates

Replace only these files in your GitHub repository:
  public/index.html
  public/live.js

Changes:
- 2D bus markers glide between successive Swiftly GPS positions over up to 12 seconds.
- Only real/new GPS observations start animation; no prediction beyond the latest observation.
- Large jumps over 350 meters snap rather than animate across streets.
- Layover buses starting within five minutes retain their Leaving soon label and do not glide.
- The existing 3D smooth-follow and 3D fleet motion are unchanged.
- Reduced-motion preference and background tabs avoid unnecessary animation.
- Both JavaScript files passed Node syntax checks.

No change to Cloudflare Worker, API polling, GTFS processing, or route-info.json.
