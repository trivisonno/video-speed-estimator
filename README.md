# Video Speed Estimator

A browser-based tool for frame-by-frame video analysis of vehicle speed, inspired by the PLA (pixel/photogrammetric) speed-analysis technique used in crash reconstruction (see [vcrashusa.com/blog/pla-estimator](https://www.vcrashusa.com/blog/pla-estimator)).

Everything runs client-side in your browser. **No video, image, or click data is ever uploaded anywhere** — the app is a single static page you can even run offline.

**[Open the tool](https://trivisonno.github.io/video-speed-estimator/)** (once GitHub Pages is enabled — see below).

## What it does

1. **Load a video file** from your computer (dashcam, surveillance, phone footage, etc.).
2. **Determine the frame rate**:
   - Trust a known FPS (from the file's properties / `ffprobe`), or
   - Estimate it from burned-in timestamps: step to a few frames spread across a long span, type in the overlay clock reading you see at each one, and the tool fits a line (linear regression) across all your samples to get an average FPS. Because the fit uses many widely-spaced samples rather than one interval, occasional dropped or duplicated frames get averaged out instead of throwing off the whole estimate. A goodness-of-fit (R²) indicator flags typos or inconsistent footage.
3. **Calibrate scale (distance per pixel)**: click two points spanning a known real-world distance — typically a vehicle's wheelbase, but any known distance works (lane width, a sign, etc.). You can add more than one calibration at different points in the video if the subject's distance from the camera changes a lot; the scale is linearly interpolated between calibration points.
4. **Track points frame by frame**: step through the video and click the pixel location of a feature (e.g. front wheel contact patch) on two independent tracks (e.g. front wheel / rear wheel). A zoomed loupe follows your cursor for precise placement. Points and calibration lines are drawn as an overlay so you can review your work.
5. **Get speed results**: per-interval and overall average speed (ft/s, mph, km/h) computed locally, or export the raw `time, x, y` data for each track to paste into an external tool such as [vcrashusa.com/pla-estimator](https://www.vcrashusa.com/pla-estimator).

## Known limitations

- **Frame stepping is time-based, not codec-based.** Browsers don't expose true frame-accurate seeking through the HTML5 `<video>` element, so "next frame" advances by `1 / FPS` seconds rather than decoding the literal next frame. Use the ±10 ms nudge buttons and the zoom loupe to fine-tune alignment on ambiguous or duplicated frames.
- **Auto-detected FPS is best-effort.** The "Try auto-detect" button attempts `captureStream()`, which isn't supported (or reliable) in every browser/file combination. Reading the FPS from the file's actual properties (e.g. with `ffprobe`) or using the timestamp method are more dependable.
- **Perspective/parallax**: a single calibration assumes the tracked point stays at roughly the same distance from the camera as the calibration line. For vehicles that travel a long distance toward/away from the camera, add calibration measurements at multiple points along the path — the tool interpolates scale between them.

## Using it

Just open `index.html` in a modern desktop browser (Chrome/Edge recommended for best video codec + `captureStream` support). No build step, server, or dependencies required.

### Keyboard shortcuts
- `←` / `→` — previous / next frame
- `Space` — play / pause
- `1` / `2` — switch active track

### Saving your work
Use **Save project (.json)** to save your FPS settings, calibrations, and tracked points (not the video itself). Reload the same video file and use **Load project (.json)** to resume exactly where you left off.

## Development

The core math (FPS regression, calibration-scale interpolation, speed calculation) lives in `js/calc.js`, a dependency-free module usable from both the browser and Node, so it can be unit tested in isolation from the DOM/canvas UI code in `js/app.js`.

## License

MIT
