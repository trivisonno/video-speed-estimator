# Video Speed Estimator

A browser-based tool for frame-by-frame video analysis of vehicle speed, using the cross-ratio method for projective-invariant speed estimation.

Everything runs client-side in your browser. No video, image, or click data is ever uploaded anywhere — the app is a single static page you can run offline.

**[Open the tool](https://trivisonno.github.io/video-speed-estimator/)** (once GitHub Pages is enabled — see below).

## What it does

1. **Load a video file** from your computer (dashcam, surveillance, phone footage, etc.).
2. **Determine the frame rate**: trust a known FPS from the file's properties, or estimate it from burned-in overlay timestamps via a linear regression across several widely-spaced samples (dropped/duplicated frames average out rather than skewing the estimate; an R² indicator flags a bad fit).
3. **Set a reference length**: click the same two points you'll track as Track A and Track B (e.g. front & rear tire contact patches) at any one frame, and enter their known real-world distance apart — typically a vehicle's wheelbase. This single length is all the cross-ratio method needs.
4. **Track points frame by frame**: Track A and Track B should be two points on the same rigid body, tracked at matching frames (the "Lock" option keeps them in sync automatically). A zoomed loupe and on-screen coordinate readout help with precise placement.
5. **Get speed results**: per-interval and overall vehicle speed (ft/s, mph, km/h), computed locally via the cross-ratio method, or export the raw `time, x, y` data for each track.

## Method

Vehicle speed is estimated using the cross-ratio method described in:

> Choi, Y., Park, J., Yun, Y., Jeon, W.-J., & Kong, S.-H. (2026). Cross-ratio and vehicle dynamics-based speed estimation for traffic accident analysis. *Forensic Science International*, 378, 112675. https://doi.org/10.1016/j.forsciint.2025.112675

Because the cross-ratio of four collinear points is invariant under projective transformation, a vehicle's real-world displacement between two frames can be recovered directly from image pixel positions plus one known real-world length (e.g. the wheelbase) — without a per-frame pixel-to-real scale. This is what makes it robust to the vehicle's apparent size changing as it moves toward or away from the camera, unlike a plain scale calibration.

This tool implements the paper's core cross-ratio method with straightness-based frame-pair filtering (§3.1–3.3), which flags/excludes frame pairs where the tracked points deviate too far from collinear (typically because the vehicle was turning). It does not implement the paper's second correction (Algorithm 2, a bicycle-model steering-angle correction for curved paths), since that needs steering-angle/turning-radius inputs this tool doesn't collect.

Implementation details, including a correction to the paper's own Case 1 formula (Eq. 7, as printed, doesn't algebraically invert Eq. 6 for the point layout in Fig. 3 — verified both symbolically and numerically), are documented in `js/calc.js`.

## Known limitations

- **The reference length must be the true real-world distance between Track A's and Track B's specific features** (not an unrelated object elsewhere in the scene) — the cross-ratio method requires both points to be measurable at the same two frames used for tracking.
- **Cross-ratio assumes near-collinearity.** The straightness check excludes frame pairs where the vehicle was turning sharply enough to violate that assumption; a vehicle turning throughout the tracked segment may leave few or no reliable intervals.
- **Auto-detected FPS is best-effort.** The "Try auto-detect" button attempts `captureStream()`, which isn't supported (or reliable) in every browser/file combination. Reading FPS from the file's actual properties (e.g. with `ffprobe`) or using the timestamp method are more dependable.
- **Frame-accurate stepping depends on `requestVideoFrameCallback`**, which not all browsers support; where it's unavailable, frame numbers are shown as unknown and stepping falls back to a fixed time delta.

## Using it

Just open `index.html` in a modern desktop browser (Chrome/Edge recommended for best video codec + `requestVideoFrameCallback`/`captureStream` support). No build step, server, or dependencies required.

### Keyboard shortcuts
- `←` / `→` — previous / next frame
- `Space` — play / pause
- `1` / `2` — switch active track

### Saving your work
**Save project (.json)** writes your frame-rate settings, reference length, and tracked points to a file (not the video itself). Reload the same video file and use **Load project (.json)** to resume where you left off.

More detail on each step is available from the **Help** button in the app itself.

## Development

The core math (FPS regression, cross-ratio speed estimation) lives in `js/calc.js`, a dependency-free module usable from both the browser and Node, so it can be unit tested in isolation from the DOM/canvas UI code in `js/app.js`.

## License

MIT
