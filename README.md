# GMT 3D Restore + Route Choice Fix

Replace `public/index.html` and `public/planner.js` in the GitHub repository.

- 3D control now remains available regardless of touchscreen / pointer classification and screen width. It preserves the existing 3D bus models, follow camera and 3D buildings.
- `planner.js` is the latest route-choice improvement with walking transfers and no same-route direction reversals.
- No changes to `public/live.js` or Cloudflare.

The 3D button in the previous HTML was explicitly hidden on coarse-pointer devices, including touchscreen computers and all phones. This fix removes that gate. If 3D still does not appear, inspect browser console for an initialization exception; a running map may have an older cached HTML version. Test 3D on your target mobile devices for performance before public launch.
