/* Video Speed Estimator
 * Frame-by-frame pixel tracking + speed reconstruction, entirely client-side.
 *
 * Data model notes:
 * - Track points and calibrations are keyed by media TIME (ms, integer), not
 *   by frame number, since that's what speed math needs (real elapsed
 *   seconds). Each is also tagged with the real frame number active when it
 *   was created, for display/export only.
 * - "frame number" (state.frameIndex) is a REAL count of decoded video
 *   frames from the start of the video, not a guess derived from time * fps.
 *   It's tracked via requestVideoFrameCallback (rVFC) while the video is
 *   played or stepped frame-by-frame. It becomes unknown (null, shown as
 *   "?") after any seek that isn't frame-accurate (dragging the seek bar,
 *   the +-10ms nudge), because there's no way to know how many real frames
 *   such a seek crossed without decoding all of them. It's always known at
 *   t=0, and is restored when jumping back to a point/calibration/sample
 *   that recorded its own frame number when it was created.
 * - Prev/Next Frame stepping lands on the actual next/previous decoded
 *   frame (via rVFC), not an assumed 1/fps time delta, so it works
 *   correctly on variable-frame-rate footage. FPS itself is now purely
 *   informational (e.g. for the burned-in-timestamp cross-check) and is
 *   never used to derive a frame number or a step size.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const videoFileInput = document.getElementById('videoFile');
  const videoInfo = document.getElementById('videoInfo');
  const stage = document.getElementById('stage');
  const ctx = stage.getContext('2d');
  const loupe = document.getElementById('loupe');
  const loupeCtx = loupe.getContext('2d');
  const coordReadout = document.getElementById('coordReadout');
  const stageLoading = document.getElementById('stageLoading');
  const stageLoadingText = document.getElementById('stageLoadingText');

  const playBtn = document.getElementById('playBtn');
  const prevFrameBtn = document.getElementById('prevFrameBtn');
  const nextFrameBtn = document.getElementById('nextFrameBtn');
  const prevNudgeBtn = document.getElementById('prevNudgeBtn');
  const nextNudgeBtn = document.getElementById('nextNudgeBtn');
  const playRate = document.getElementById('playRate');
  const seekBar = document.getElementById('seekBar');
  const frameReadout = document.getElementById('frameReadout');

  const fpsModeManual = document.getElementById('fpsModeManual');
  const fpsModeTimestamps = document.getElementById('fpsModeTimestamps');
  const fpsManualBlock = document.getElementById('fpsManualBlock');
  const fpsTimestampBlock = document.getElementById('fpsTimestampBlock');
  const manualFps = document.getElementById('manualFps');
  const detectFpsBtn = document.getElementById('detectFpsBtn');
  const tsInput = document.getElementById('tsInput');
  const addTsSampleBtn = document.getElementById('addTsSampleBtn');
  const tsSampleBody = document.getElementById('tsSampleBody');
  const tsQuality = document.getElementById('tsQuality');
  const effectiveFpsOut = document.getElementById('effectiveFpsOut');
  const frameIntervalOut = document.getElementById('frameIntervalOut');
  const fpsBadge = document.getElementById('fpsBadge');

  const calibPreset = document.getElementById('calibPreset');
  const calibDistance = document.getElementById('calibDistance');
  const calibUnit = document.getElementById('calibUnit');
  const pickCalibBtn = document.getElementById('pickCalibBtn');
  const cancelCalibBtn = document.getElementById('cancelCalibBtn');
  const calibBody = document.getElementById('calibBody');
  const calibBadge = document.getElementById('calibBadge');

  const tabTrackA = document.getElementById('tabTrackA');
  const tabTrackB = document.getElementById('tabTrackB');
  const renameTrackA = document.getElementById('renameTrackA');
  const renameTrackB = document.getElementById('renameTrackB');
  const trackBody = document.getElementById('trackBody');
  const lockTracksToggle = document.getElementById('lockTracksToggle');

  const resAvg = document.getElementById('resAvg');
  const resSub = document.getElementById('resSub');
  const resultsBody = document.getElementById('resultsBody');

  const copyABtn = document.getElementById('copyABtn');
  const copyBBtn = document.getElementById('copyBBtn');
  const copyBothBtn = document.getElementById('copyBothBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const exportPreview = document.getElementById('exportPreview');

  const saveProjectBtn = document.getElementById('saveProjectBtn');
  const loadProjectBtn = document.getElementById('loadProjectBtn');
  const loadProjectFile = document.getElementById('loadProjectFile');

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  const state = {
    videoLoaded: false,
    videoName: null,
    fpsMode: 'manual',
    tsSamples: [], // { frame, t, mediaTime }
    frameIndex: null, // real decoded frame count from video start; null = unknown (lost sync via a non-frame-accurate seek)
    totalFrames: null, // learned for real once frame-accurate playback/stepping reaches the end
    rvfcSupported: typeof video.requestVideoFrameCallback === 'function',
    lastFrameDuration: null, // seconds; running estimate, used to size the backward-step search window
    busy: false, // an async frame-accurate operation (step, resync scan, total-frame count) is in progress
    scanning: false, // specifically a full resync/total-frame scan (not a single-frame step) — hides the stage behind a loading overlay, since it plays through footage the user didn't ask to watch
    effectiveFps: null, // informational only (burned-in-timestamp cross-check); never drives stepping
    calibrations: [], // { tMs, frame, x1,y1,x2,y2, pixelDist, realDist, unit, scale (ft per px) }
    calibMode: false,
    calibClicks: [],
    activeTrack: 'A',
    // When true, placing a point auto-switches the active track to the other
    // one, so the very next click (still on the same paused frame, no seek
    // in between) lands on the identical video.currentTime. This is what
    // keeps track A/B's time columns aligned to the same frames instead of
    // drifting apart across two independent passes through the video.
    lockTracks: true,
    tracks: {
      A: { label: 'Front wheel', color: '#ff6b6b', points: new Map() }, // tMs -> {t,x,y,frame}
      B: { label: 'Rear wheel', color: '#4da3ff', points: new Map() },
    },
    playing: false,
  };

  const UNIT_TO_FEET = { in: 1 / 12, ft: 1, m: 3.280839895, cm: 3.280839895 / 100 };

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function fmt(n, d = 3) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return Number(n).toFixed(d);
  }

  function tKey(t) { return Math.round(t * 1000); }

  function setEffectiveFps(fps) {
    state.effectiveFps = fps && fps > 0 ? fps : null;
    if (state.effectiveFps) {
      effectiveFpsOut.textContent = state.effectiveFps.toFixed(3);
      frameIntervalOut.textContent = (1000 / state.effectiveFps).toFixed(2) + ' ms';
      fpsBadge.textContent = 'set';
    } else {
      effectiveFpsOut.textContent = '—';
      frameIntervalOut.textContent = '—';
      fpsBadge.textContent = 'not set';
    }
    updateTransportEnabled();
    renderFrameReadout();
    renderTrackTable();
    recomputeResults();
  }

  function updateTransportEnabled() {
    const ready = state.videoLoaded && !state.busy;
    [playBtn, prevFrameBtn, nextFrameBtn, prevNudgeBtn, nextNudgeBtn, playRate, seekBar].forEach(el => {
      el.disabled = !ready;
    });
    pickCalibBtn.disabled = !state.videoLoaded;
    // Loading a different file mid-scan would pull the video element out
    // from under an in-flight scanFramesFromStart() promise.
    videoFileInput.disabled = state.busy;
  }

  // Covers the stage with a spinner while a full frame-accurate scan
  // (countTotalFrames / resyncFrameIndex) drives the video element through
  // footage the user never asked to watch, instead of letting it flash by.
  function showStageLoading(text) {
    stageLoadingText.textContent = text;
    stageLoading.classList.remove('hidden');
  }

  function hideStageLoading() {
    stageLoading.classList.add('hidden');
  }

  // ---------------------------------------------------------------------
  // Video loading
  // ---------------------------------------------------------------------
  videoFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    video.src = url;
    state.videoName = file.name;
    state.videoLoaded = false;
    state.frameIndex = null;
    state.totalFrames = null;
    state.lastFrameDuration = null;
    videoInfo.textContent = 'Loading ' + file.name + '…';
    // Safari's <video> element can't demux Matroska at all (it relies on
    // AVFoundation, which only natively handles MP4/MOV/M4V) — that's a
    // browser/container limitation, not something detectable via codec
    // support alone, so warn proactively rather than waiting for the
    // generic 'error' event to fire with no useful detail.
    if (/\.mkv$/i.test(file.name) && !video.canPlayType('video/x-matroska; codecs="avc1.640028"')) {
      videoInfo.innerHTML += `<br><span style="color:var(--warn)">This browser may not support .mkv playback (notably Safari never does) &mdash; if loading fails, re-mux to .mp4 first (same video/audio streams, no re-encode: <code>ffmpeg -i input.mkv -c copy output.mp4</code>) and load that instead.</span>`;
    }
  });

  video.addEventListener('loadedmetadata', () => {
    stage.width = video.videoWidth;
    stage.height = video.videoHeight;
    state.videoLoaded = true;
    state.frameIndex = 0; // start of video is always a known frame
    state.totalFrames = null;
    videoInfo.innerHTML = `<b>${escapeHtml(state.videoName)}</b><br>${video.videoWidth}&times;${video.videoHeight} &middot; duration ${video.duration.toFixed(2)}s`;
    if (!state.rvfcSupported) {
      videoInfo.innerHTML += `<br><span style="color:var(--warn)">This browser doesn't support frame-accurate stepping (requestVideoFrameCallback) &mdash; frame numbers will be unavailable.</span>`;
    }
    updateTransportEnabled();
    saveProjectBtn.disabled = false;
    seekBar.max = Math.floor(video.duration * 1000);
    video.currentTime = 0;
    if (state.rvfcSupported) countTotalFrames();
  });

  video.addEventListener('seeked', () => {
    drawFrame();
    renderFrameReadout();
    renderTrackTable();
  });

  video.addEventListener('ended', () => {
    if (state.frameIndex !== null) state.totalFrames = state.frameIndex + 1;
    renderFrameReadout();
  });

  video.addEventListener('error', () => {
    const isMkv = /\.mkv$/i.test(state.videoName || '');
    videoInfo.innerHTML = isMkv
      ? `Could not load "${escapeHtml(state.videoName)}" &mdash; this browser can't play .mkv (Safari never supports the Matroska container, regardless of codec). Re-mux it to .mp4 without re-encoding: <code>ffmpeg -i "${escapeHtml(state.videoName)}" -c copy output.mp4</code>, then load output.mp4 instead.`
      : `Could not load this video file/codec in your browser.`;
  });

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------
  function drawFrame() {
    if (!state.videoLoaded) return;
    ctx.drawImage(video, 0, 0, stage.width, stage.height);
    drawOverlays();
  }

  function drawOverlays() {
    const curKey = tKey(video.currentTime);

    state.calibrations.forEach(c => {
      ctx.strokeStyle = 'rgba(255,220,80,0.9)';
      ctx.lineWidth = Math.max(1, stage.width / 500);
      ctx.beginPath();
      ctx.moveTo(c.x1, c.y1);
      ctx.lineTo(c.x2, c.y2);
      ctx.stroke();
      [[c.x1, c.y1], [c.x2, c.y2]].forEach(([x, y]) => drawMarker(x, y, 'rgba(255,220,80,0.9)', 5));
    });

    if (state.calibMode && state.calibClicks.length) {
      state.calibClicks.forEach(([x, y]) => drawMarker(x, y, '#ffe066', 6));
    }

    const currentLabels = [];
    ['A', 'B'].forEach(key => {
      const track = state.tracks[key];
      const pts = [...track.points.entries()].sort((a, b) => a[0] - b[0]);
      ctx.strokeStyle = track.color;
      ctx.lineWidth = Math.max(1, stage.width / 700);
      ctx.beginPath();
      pts.forEach(([, p], i) => {
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      pts.forEach(([tms, p]) => {
        const isCurrent = tms === curKey;
        drawMarker(p.x, p.y, track.color, isCurrent ? 8 : 4, isCurrent);
        // Label only the point(s) on the frame you're currently looking at,
        // so you can read off the exact recorded x/y and check it against
        // the corresponding row in the track table — labeling every
        // historical point on the path would make the frame unreadable.
        if (isCurrent) currentLabels.push({ x: p.x, y: p.y, color: track.color, text: `${key}: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}` });
      });
    });
    // Drawn in a separate pass, after all markers/paths, so a label never
    // gets painted over by the other track's line or marker.
    currentLabels.forEach(l => drawCoordLabel(l.x, l.y, l.color, l.text));
  }

  function drawCoordLabel(x, y, color, text) {
    const fontSize = Math.max(11, Math.round(stage.width / 90));
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = 'top';
    const paddingX = 5, paddingY = 3;
    const boxW = ctx.measureText(text).width + paddingX * 2;
    const boxH = fontSize + paddingY * 2;
    let lx = x + 12, ly = y + 12;
    if (lx + boxW > stage.width) lx = x - boxW - 12;
    if (ly + boxH > stage.height) ly = y - boxH - 12;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(lx, ly, boxW, boxH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx + 0.5, ly + 0.5, boxW - 1, boxH - 1);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, lx + paddingX, ly + paddingY);
  }

  function drawMarker(x, y, color, r, ring) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (ring) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function renderFrameReadout() {
    const f = state.frameIndex !== null ? state.frameIndex : '?';
    const total = state.totalFrames !== null ? state.totalFrames : '?';
    frameReadout.textContent = `frame ${f} / ${total} · t=${video.currentTime.toFixed(3)}s`;
    seekBar.value = Math.round(video.currentTime * 1000);
    addTsSampleBtn.disabled = state.frameIndex === null;
  }

  // ---------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------
  function pauseUi() {
    video.pause();
    state.playing = false;
    playBtn.textContent = '▶ Play';
  }

  // --- real frame-accurate stepping, via requestVideoFrameCallback ---
  // rVFC hands us the actual decoded frame's mediaTime, so we can detect
  // "the next real frame landed" instead of guessing a time delta from an
  // assumed FPS. This is what makes stepping correct on variable-frame-rate
  // footage (the whole reason the old assumed-FPS stepping could skip or
  // stall on many real frames per press).

  function waitForSeekedEvent() {
    return new Promise(resolve => {
      const handler = () => { video.removeEventListener('seeked', handler); resolve(); };
      video.addEventListener('seeked', handler);
    });
  }

  function noteFrameDuration(dt) {
    if (dt > 0 && dt < 1) {
      state.lastFrameDuration = state.lastFrameDuration ? (state.lastFrameDuration * 0.7 + dt * 0.3) : dt;
    }
  }

  function onFrameLanded() {
    drawFrame();
    renderFrameReadout();
    renderTrackTable();
  }

  // Fallback for browsers without rVFC: approximate stepping by seeking a
  // fixed time delta. Frame numbers are unavailable in this path.
  function legacyStep(n) {
    const dt = n / (state.effectiveFps || 30);
    video.currentTime = Math.min(Math.max(0, video.currentTime + dt), video.duration);
    state.frameIndex = null;
  }

  async function stepFrameForward() {
    if (!state.videoLoaded || state.busy) return;
    pauseUi();
    if (!state.rvfcSupported) { legacyStep(1); return; }
    const startTime = video.currentTime;
    if (startTime >= video.duration - 1e-4) return;
    state.busy = true;
    try {
      const metadata = await new Promise(resolve => {
        const onFrame = (now, meta) => {
          if (meta.mediaTime > startTime + 1e-4) resolve(meta);
          else video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        video.play();
      });
      video.pause();
      noteFrameDuration(metadata.mediaTime - startTime);
      if (state.frameIndex !== null) state.frameIndex += 1;
      onFrameLanded();
    } finally {
      state.busy = false;
    }
  }

  // Plays forward from the current (already-seeked) position and returns the
  // mediaTime of the last real frame strictly before targetTime, or null if
  // the seek already landed at/after targetTime (search window was too small).
  function scanForwardBefore(targetTime) {
    return new Promise(resolve => {
      let lastGood = null;
      const onFrame = (now, meta) => {
        if (meta.mediaTime < targetTime - 1e-4) {
          lastGood = meta.mediaTime;
          video.requestVideoFrameCallback(onFrame);
        } else {
          video.pause();
          resolve(lastGood);
        }
      };
      video.requestVideoFrameCallback(onFrame);
      video.play();
    });
  }

  async function stepFrameBackward() {
    if (!state.videoLoaded || state.busy) return;
    pauseUi();
    if (!state.rvfcSupported) { legacyStep(-1); return; }
    const startTime = video.currentTime;
    if (startTime <= 1e-6) return; // already at the very first frame
    state.busy = true;
    try {
      let back = state.lastFrameDuration ? state.lastFrameDuration * 1.5 : 0.05;
      for (let attempt = 0; attempt < 6; attempt++) {
        const seekTo = Math.max(0, startTime - back);
        video.currentTime = seekTo;
        await waitForSeekedEvent();
        const lastGood = await scanForwardBefore(startTime);
        if (lastGood !== null) {
          noteFrameDuration(startTime - lastGood);
          video.currentTime = lastGood;
          await waitForSeekedEvent();
          if (lastGood <= 1e-6) state.frameIndex = 0;
          else if (state.frameIndex !== null) state.frameIndex -= 1;
          onFrameLanded();
          return;
        }
        if (seekTo <= 1e-6) break;
        back *= 2.5; // window was too small (skipped straight past a real frame) — widen and retry
      }
      // Gave up finding a distinct earlier frame in a reasonable window — land at the start.
      video.currentTime = 0;
      await waitForSeekedEvent();
      state.frameIndex = 0;
      onFrameLanded();
    } finally {
      state.busy = false;
    }
  }

  // Resolves with the metadata of the next real frame strictly after
  // afterTime, or null if there is no next frame (true end of stream).
  // Deliberately does NOT sustain playback — it calls play() then pauses
  // again the instant one new frame lands.

  // Frame-accurate resync/count: plays continuously from t=0, tallying every
  // real decoded frame via rVFC, until the first frame at/after targetTime
  // lands (or the stream truly ends). This is the only way to learn an
  // exact real frame number for an arbitrary point, or the true total,
  // without relying on any assumed frame rate — there's no browser API that
  // exposes it directly.
  //
  // A single sustained play() call — rather than a play()-then-pause()
  // cycle repeated once per frame — is what makes this fast: each
  // play()/pause() transition carries its own startup latency, and paying
  // that per frame (potentially thousands of times for a long clip) is what
  // used to make this take far longer than the video's own length, visibly
  // longer than a user should have to wait just from loading a file. Sustained
  // playback avoids that, while staying frame-accurate: the rVFC-undercounting
  // problem is specific to FAST-FORWARDED playback (confirmed separately: at
  // 16x, a ~55.5s/1112-frame clip only fired ~209 callbacks, matching the
  // display's refresh rate over the fast-forwarded wall-clock time, not the
  // real frame count) — not to ordinary 1x playback, where the display's
  // refresh rate comfortably exceeds ordinary video frame rates.
  function scanFramesFromStart(targetTime, statusText) {
    return new Promise(resolve => {
      const afterSeek = () => {
        video.removeEventListener('seeked', afterSeek);
        // The seek above also fires the ordinary global 'seeked' handler,
        // which repaints the frame readout from (stale) state — reassert
        // the status message so it isn't clobbered for the scan's duration.
        if (statusText) frameReadout.textContent = statusText;
        let count = 0;
        let landedTime = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.removeEventListener('ended', onEnded);
          video.pause();
          resolve({ frameIndex: count, mediaTime: landedTime });
        };
        const onEnded = () => finish();
        const onFrame = (now, meta) => {
          if (done) return;
          if (meta.mediaTime > landedTime + 1e-4) {
            count += 1;
            landedTime = meta.mediaTime;
          }
          if (landedTime >= targetTime - 1e-4) { finish(); return; }
          video.requestVideoFrameCallback(onFrame);
        };
        video.addEventListener('ended', onEnded);
        video.requestVideoFrameCallback(onFrame);
        video.play().catch(() => {});
      };
      video.addEventListener('seeked', afterSeek);
      video.currentTime = 0;
    });
  }

  // Runs once per video load: establishes the real total frame count by
  // decoding the whole file, then returns the player to the start. Hidden
  // behind a loading overlay (rather than the visible stage) and run at a
  // lower priority than user interaction — see showStageLoading.
  async function countTotalFrames() {
    if (!state.videoLoaded || state.busy) return;
    state.busy = true;
    state.scanning = true;
    updateTransportEnabled();
    showStageLoading('Preparing video…');
    try {
      const result = await scanFramesFromStart(video.duration);
      state.totalFrames = result.frameIndex + 1;
      video.currentTime = 0;
      await waitForSeekedEvent();
      state.frameIndex = 0;
      onFrameLanded();
    } finally {
      state.busy = false;
      state.scanning = false;
      updateTransportEnabled();
      renderFrameReadout();
      hideStageLoading();
    }
  }

  // Resyncs state.frameIndex to the exact real frame after a non-frame-
  // accurate seek (e.g. releasing the seek bar), by scanning from the start.
  async function resyncFrameIndex(targetTime) {
    if (!state.videoLoaded || state.busy || !state.rvfcSupported) return;
    state.busy = true;
    state.scanning = true;
    updateTransportEnabled();
    const statusText = 'Resyncing frame number…';
    frameReadout.textContent = statusText;
    showStageLoading('Resyncing frame…');
    try {
      const result = await scanFramesFromStart(targetTime, statusText);
      video.currentTime = result.mediaTime;
      await waitForSeekedEvent();
      state.frameIndex = result.frameIndex;
      onFrameLanded();
    } finally {
      state.busy = false;
      state.scanning = false;
      updateTransportEnabled();
      renderFrameReadout();
      hideStageLoading();
    }
  }

  function nudge(ms) {
    pauseUi();
    video.currentTime = Math.min(Math.max(0, video.currentTime + ms / 1000), video.duration);
    state.frameIndex = video.currentTime <= 1e-6 ? 0 : null;
  }

  prevFrameBtn.addEventListener('click', () => stepFrameBackward());
  nextFrameBtn.addEventListener('click', () => stepFrameForward());
  prevNudgeBtn.addEventListener('click', () => nudge(-10));
  nextNudgeBtn.addEventListener('click', () => nudge(10));

  // Keeps state.frameIndex accurate during normal Play, by counting real
  // presented frames via rVFC rather than trusting elapsed wall-clock time.
  function trackFrameIndexWhilePlaying() {
    if (!state.rvfcSupported) return;
    let lastMediaTime = video.currentTime;
    const onFrame = (now, meta) => {
      if (video.paused || video.ended) return;
      if (state.frameIndex !== null && meta.mediaTime > lastMediaTime + 1e-4) {
        state.frameIndex += 1;
        lastMediaTime = meta.mediaTime;
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  playBtn.addEventListener('click', () => {
    if (state.playing) {
      pauseUi();
    } else {
      video.playbackRate = parseFloat(playRate.value);
      video.play();
      trackFrameIndexWhilePlaying();
      state.playing = true;
      playBtn.textContent = '⏸ Pause';
    }
  });

  playRate.addEventListener('change', () => { video.playbackRate = parseFloat(playRate.value); });

  let rafId = null;
  video.addEventListener('play', () => {
    const loop = () => {
      if (video.paused || video.ended) { rafId = null; return; }
      // A background frame scan also drives play(): its progress is shown
      // via the stage overlay/status text instead, so skip the normal
      // per-frame repaint (it would both waste cycles on a hidden canvas
      // and spam the frame readout with a rapidly ticking count).
      if (!state.scanning) {
        drawFrame();
        renderFrameReadout();
      }
      rafId = requestAnimationFrame(loop);
    };
    if (!rafId) rafId = requestAnimationFrame(loop);
  });
  video.addEventListener('pause', () => {
    state.playing = false;
    playBtn.textContent = '▶ Play';
  });

  seekBar.addEventListener('input', () => {
    // Live scrubbing preview: cheap, but not frame-accurate, so the frame
    // number is shown as unknown until 'change' (drag release) resyncs it.
    pauseUi();
    video.currentTime = seekBar.value / 1000;
    state.frameIndex = video.currentTime <= 1e-6 ? 0 : null;
  });

  seekBar.addEventListener('change', () => {
    // Drag released (or arrow-key nudge on the focused slider): now worth
    // paying for an exact resync scan so the frame number doesn't stay "?".
    if (video.currentTime <= 1e-6) return; // already resolved to frame 0 above
    resyncFrameIndex(video.currentTime);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (!state.videoLoaded) return;
    if (e.key === 'ArrowRight') { stepFrameForward(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { stepFrameBackward(); e.preventDefault(); }
    else if (e.key === '1') setActiveTrack('A');
    else if (e.key === '2') setActiveTrack('B');
    else if (e.key === ' ') { playBtn.click(); e.preventDefault(); }
  });

  // ---------------------------------------------------------------------
  // FPS: mode switching
  // ---------------------------------------------------------------------
  fpsModeManual.addEventListener('change', () => { state.fpsMode = 'manual'; refreshFpsUi(); });
  fpsModeTimestamps.addEventListener('change', () => { state.fpsMode = 'timestamps'; refreshFpsUi(); });

  function refreshFpsUi() {
    fpsManualBlock.style.display = state.fpsMode === 'manual' ? '' : 'none';
    fpsTimestampBlock.style.display = state.fpsMode === 'timestamps' ? '' : 'none';
    if (state.fpsMode === 'manual') {
      setEffectiveFps(parseFloat(manualFps.value) || null);
    } else {
      recomputeFpsFromSamples();
    }
  }

  manualFps.addEventListener('input', () => {
    if (state.fpsMode === 'manual') setEffectiveFps(parseFloat(manualFps.value) || null);
  });

  detectFpsBtn.addEventListener('click', async () => {
    try {
      if (!video.captureStream) throw new Error('captureStream unsupported');
      const stream = video.captureStream();
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings ? track.getSettings() : {};
      track.stop();
      if (settings.frameRate) {
        manualFps.value = settings.frameRate.toFixed(3);
        setEffectiveFps(settings.frameRate);
        videoInfo.innerHTML += `<br><span style="color:var(--good)">Detected ~${settings.frameRate.toFixed(2)} fps (best-effort, verify).</span>`;
      } else {
        throw new Error('no frameRate reported');
      }
    } catch (err) {
      videoInfo.innerHTML += `<br><span style="color:var(--warn)">Auto-detect not available in this browser for this file &mdash; enter FPS manually.</span>`;
    }
  });

  // --- timestamp regression ---
  addTsSampleBtn.addEventListener('click', () => {
    const t = VSECalc.parseTimestamp(tsInput.value);
    if (t === null) { alert('Could not parse timestamp. Use HH:MM:SS.mmm, MM:SS.mmm, or plain seconds.'); return; }
    if (state.frameIndex === null) {
      alert('Current frame number is unknown here (you likely dragged the seek bar). Step or play back to this point from a known frame so it can be counted accurately, then add the sample.');
      return;
    }
    state.tsSamples.push({ frame: state.frameIndex, t, mediaTime: video.currentTime });
    tsInput.value = '';
    renderTsSamples();
    recomputeFpsFromSamples();
  });

  function renderTsSamples() {
    tsSampleBody.innerHTML = '';
    state.tsSamples.forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${s.frame}</td><td>${VSECalc.formatTimestamp(s.t)}</td><td><button class="small danger" data-i="${i}">&times;</button></td>`;
      tr.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.tsSamples.splice(i, 1);
        renderTsSamples();
        recomputeFpsFromSamples();
      });
      tr.addEventListener('click', () => { video.currentTime = s.mediaTime; state.frameIndex = s.frame; });
      tsSampleBody.appendChild(tr);
    });
  }

  function recomputeFpsFromSamples() {
    if (state.fpsMode !== 'timestamps') return;
    const n = state.tsSamples.length;
    if (n < 2) {
      tsQuality.style.display = 'none';
      setEffectiveFps(null);
      return;
    }
    // Regression of overlay timestamp vs. real decoded frame number: slope
    // is the real seconds elapsed per frame, so fps = 1/slope. Regressing
    // over many widely-spaced samples averages out any dropped or
    // duplicated frames, rather than trusting any single interval.
    if (new Set(state.tsSamples.map(s => s.frame)).size < 2) {
      setEffectiveFps(null);
      tsQuality.style.display = '';
      tsQuality.className = 'calib-quality warn';
      tsQuality.textContent = 'All samples landed on the same frame number, so no frame rate can be estimated. Add samples from different frames, spread widely apart in time.';
      return;
    }
    const result = VSECalc.fpsFromFrameSamples(state.tsSamples);
    if (!result) {
      setEffectiveFps(null);
      tsQuality.style.display = '';
      tsQuality.className = 'calib-quality warn';
      tsQuality.textContent = 'Could not fit a frame rate to these samples — check that frame numbers increase in the same direction as the timestamps and that no timestamp was mistyped.';
      return;
    }

    setEffectiveFps(result.fps);
    tsQuality.style.display = '';
    if (result.r2 > 0.999) {
      tsQuality.className = 'calib-quality good';
      tsQuality.textContent = `Fit quality R²=${result.r2.toFixed(5)} — consistent frame timing across samples.`;
    } else {
      tsQuality.className = 'calib-quality warn';
      tsQuality.textContent = `Fit quality R²=${result.r2.toFixed(5)} — samples don't fit a single rate well; check for mistyped timestamps or add more widely-spaced samples.`;
    }
  }

  // ---------------------------------------------------------------------
  // Calibration
  // ---------------------------------------------------------------------
  calibPreset.addEventListener('change', () => {
    if (calibPreset.value) {
      calibDistance.value = calibPreset.value;
      calibUnit.value = 'in';
    }
  });

  pickCalibBtn.addEventListener('click', () => {
    const dist = parseFloat(calibDistance.value);
    if (!dist || dist <= 0) { alert('Enter a known distance first.'); return; }
    state.calibMode = true;
    state.calibClicks = [];
    pickCalibBtn.style.display = 'none';
    cancelCalibBtn.style.display = '';
  });

  cancelCalibBtn.addEventListener('click', () => {
    state.calibMode = false;
    state.calibClicks = [];
    pickCalibBtn.style.display = '';
    cancelCalibBtn.style.display = 'none';
    drawFrame();
  });

  function finishCalibration() {
    const [p1, p2] = state.calibClicks;
    const pixelDist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const dist = parseFloat(calibDistance.value);
    const unit = calibUnit.value;
    state.calibrations.push({
      tMs: tKey(video.currentTime), frame: state.frameIndex, x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
      pixelDist, realDist: dist, unit,
    });
    state.calibMode = false;
    state.calibClicks = [];
    pickCalibBtn.style.display = '';
    cancelCalibBtn.style.display = 'none';
    calibBadge.textContent = state.calibrations.length + ' set';
    renderCalibTable();
    drawFrame();
    recomputeResults();
  }

  // Sorts by real frame number when both sides have one (the normal case,
  // since calibration is added while paused on a known frame); falls back to
  // time for the rare calibration added during a non-frame-accurate seek,
  // where the frame number is unknown.
  function calibSortCompare(a, b) {
    const fa = a.frame !== null && a.frame !== undefined ? a.frame : null;
    const fb = b.frame !== null && b.frame !== undefined ? b.frame : null;
    if (fa !== null && fb !== null) return fa - fb;
    return a.tMs - b.tMs;
  }

  function renderCalibTable() {
    calibBody.innerHTML = '';
    state.calibrations.sort(calibSortCompare).forEach((c, i) => {
      const tr = document.createElement('tr');
      const f = c.frame;
      tr.innerHTML = `<td>${i + 1}</td><td>${f !== null && f !== undefined ? f : (c.tMs / 1000).toFixed(2) + 's'}</td><td>${c.pixelDist.toFixed(1)}</td><td>${c.realDist} ${c.unit}</td><td><button class="small danger" data-i="${i}">&times;</button></td>`;
      tr.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.calibrations.splice(i, 1);
        calibBadge.textContent = state.calibrations.length ? state.calibrations.length + ' set' : 'none';
        renderCalibTable();
        drawFrame();
        recomputeResults();
      });
      tr.addEventListener('click', () => { video.currentTime = c.tMs / 1000; state.frameIndex = (f !== null && f !== undefined) ? f : null; });
      calibBody.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------------
  // Track picking
  // ---------------------------------------------------------------------
  function setActiveTrack(key) {
    state.activeTrack = key;
    tabTrackA.classList.toggle('active-A', key === 'A');
    tabTrackB.classList.toggle('active-B', key === 'B');
    renderTrackTable();
  }
  tabTrackA.addEventListener('click', () => setActiveTrack('A'));
  tabTrackB.addEventListener('click', () => setActiveTrack('B'));

  lockTracksToggle.addEventListener('change', () => {
    state.lockTracks = lockTracksToggle.checked;
  });

  renameTrackA.addEventListener('input', () => {
    state.tracks.A.label = renameTrackA.value || 'Track A';
    document.getElementById('labelTrackA').textContent = state.tracks.A.label;
    recomputeResults();
  });
  renameTrackB.addEventListener('input', () => {
    state.tracks.B.label = renameTrackB.value || 'Track B';
    document.getElementById('labelTrackB').textContent = state.tracks.B.label;
    recomputeResults();
  });

  function stageCoordsFromEvent(e) {
    const rect = stage.getBoundingClientRect();
    const scaleX = stage.width / rect.width;
    const scaleY = stage.height / rect.height;
    return [
      (e.clientX - rect.left) * scaleX,
      (e.clientY - rect.top) * scaleY,
    ];
  }

  stage.addEventListener('mousemove', (e) => {
    if (!state.videoLoaded) return;
    const [x, y] = stageCoordsFromEvent(e);
    loupe.classList.add('visible');
    updateLoupe(x, y);
    coordReadout.textContent = `x: ${x.toFixed(1)} · y: ${y.toFixed(1)}`;
  });

  stage.addEventListener('mouseleave', () => {
    loupe.classList.remove('visible');
    loupeCtx.clearRect(0, 0, loupe.width, loupe.height);
    coordReadout.textContent = 'x: — · y: —';
  });

  stage.addEventListener('click', (e) => {
    if (!state.videoLoaded || state.busy) return;
    const [x, y] = stageCoordsFromEvent(e);

    if (state.calibMode) {
      state.calibClicks.push([x, y]);
      drawFrame();
      if (state.calibClicks.length === 2) finishCalibration();
      return;
    }

    const key = tKey(video.currentTime);
    state.tracks[state.activeTrack].points.set(key, { t: video.currentTime, x, y, frame: state.frameIndex });
    drawFrame();
    // Switch to the other track next, while still paused on this exact
    // frame (no seek happens in between) — so its point, when clicked, gets
    // the identical tKey(video.currentTime) rather than one from whatever
    // frame the user happens to be on during a separate pass later.
    if (state.lockTracks) {
      setActiveTrack(state.activeTrack === 'A' ? 'B' : 'A');
    } else {
      renderTrackTable();
    }
    recomputeResults();
  });

  function updateLoupe(x, y) {
    const zoom = 6;
    const halfSrc = (loupe.width / zoom) / 2;
    const sx = Math.max(0, Math.min(stage.width - halfSrc * 2, x - halfSrc));
    const sy = Math.max(0, Math.min(stage.height - halfSrc * 2, y - halfSrc));
    loupeCtx.imageSmoothingEnabled = false;
    loupeCtx.clearRect(0, 0, loupe.width, loupe.height);
    loupeCtx.drawImage(stage, sx, sy, halfSrc * 2, halfSrc * 2, 0, 0, loupe.width, loupe.height);
    const cx = (x - sx) * zoom;
    const cy = (y - sy) * zoom;
    loupeCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    loupeCtx.lineWidth = 1;
    loupeCtx.beginPath();
    loupeCtx.moveTo(cx - 12, cy); loupeCtx.lineTo(cx + 12, cy);
    loupeCtx.moveTo(cx, cy - 12); loupeCtx.lineTo(cx, cy + 12);
    loupeCtx.stroke();
    loupeCtx.strokeStyle = 'rgba(255,0,0,0.9)';
    loupeCtx.beginPath();
    loupeCtx.arc(cx, cy, 3, 0, Math.PI * 2);
    loupeCtx.stroke();
  }

  function renderTrackTable() {
    trackBody.innerHTML = '';
    const curKey = tKey(video.currentTime);
    const pts = [...state.tracks[state.activeTrack].points.entries()].sort((a, b) => a[0] - b[0]);
    pts.forEach(([key, p], i) => {
      const tr = document.createElement('tr');
      if (key === curKey) tr.classList.add('current');
      const f = p.frame;
      tr.innerHTML = `<td>${i + 1}</td><td>${f !== null && f !== undefined ? f : '?'}</td><td>${p.t.toFixed(3)}</td><td>${p.x.toFixed(1)}</td><td>${p.y.toFixed(1)}</td><td><button class="small danger" data-key="${key}">&times;</button></td>`;
      tr.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.tracks[state.activeTrack].points.delete(key);
        renderTrackTable();
        drawFrame();
        recomputeResults();
      });
      tr.addEventListener('click', () => { video.currentTime = p.t; state.frameIndex = (f !== null && f !== undefined) ? f : null; });
      trackBody.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------
  function feetPerSecToUnits(fps) {
    return VSECalc.feetPerSecToUnits(fps);
  }

  // The single real-world distance the cross-ratio method needs between
  // Track A's and Track B's features (e.g. the wheelbase). Averaging every
  // calibration entry is safe because, unlike the old scale-based model,
  // this is one constant, not something that needs re-measuring as the
  // vehicle's apparent size changes — multiple entries are just repeated
  // measurements of the same real length, worth averaging for robustness.
  function referenceLengthFeet() {
    if (!state.calibrations.length) return null;
    const feet = state.calibrations.map(c => c.realDist * UNIT_TO_FEET[c.unit]);
    return feet.reduce((a, b) => a + b, 0) / feet.length;
  }

  // Track A and Track B points at every instant where BOTH have a point
  // (same tMs key — see the "Lock" track-switching feature), time-sorted.
  // These are the paired (A,B) observations the cross-ratio method needs.
  function pairedTrackPoints() {
    const a = state.tracks.A.points, b = state.tracks.B.points;
    const keys = [...a.keys()].filter(k => b.has(k)).sort((x, y) => x - y);
    return keys.map(k => {
      const pa = a.get(k), pb = b.get(k);
      return { t: pa.t, ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y, frameA: pa.frame, frameB: pb.frame };
    });
  }

  function recomputeResults() {
    const pairs = pairedTrackPoints();
    const l = referenceLengthFeet();
    const intervals = (l !== null && pairs.length >= 2) ? VSECalc.computeCrossRatioIntervals(pairs, l) : [];
    const overall = intervals.length ? VSECalc.overallCrossRatioSpeed(intervals) : null;

    renderSpeedCard(overall, pairs.length, l);

    resultsBody.innerHTML = '';
    if (!intervals.length) {
      let reason = 'need matching Track A + Track B points on the same frame';
      if (pairs.length >= 2 && l === null) reason = 'need a reference length (see Section 3)';
      resultsBody.innerHTML = `<tr><td colspan="9" style="color:var(--muted)">Track matching points on both Track A and Track B (same frame), with a reference length set, to see per-interval speeds — ${reason}.</td></tr>`;
    } else {
      intervals.forEach((iv, i) => {
        const tr = document.createElement('tr');
        if (!iv.reliable) tr.style.opacity = '0.5';
        const units = iv.speedFtS !== null ? feetPerSecToUnits(iv.speedFtS) : null;
        const label = (iv.f1 !== null && iv.f2 !== null) ? `${iv.f1}→${iv.f2}` : `${fmt(iv.t1, 2)}s→${fmt(iv.t2, 2)}s`;
        const straightPct = Number.isFinite(iv.straightness) ? (iv.straightness * 100).toFixed(1) + '%' : '—';
        tr.title = iv.reliable ? '' : 'Excluded from the overall average — too far from collinear (turning) or degenerate points.';
        tr.innerHTML = `<td>${i + 1}</td>` +
          `<td>${label}</td>` +
          `<td>${fmt(iv.dt, 3)}</td>` +
          `<td>${iv.case !== null ? iv.case : '—'}</td>` +
          `<td>${straightPct}</td>` +
          `<td>${iv.distFt !== null ? fmt(iv.distFt, 2) + ' ft' : '—'}</td>` +
          `<td>${units ? fmt(units.fps, 2) + ' ft/s' : '—'}</td>` +
          `<td>${units ? fmt(units.mph, 1) : '—'}</td>` +
          `<td>${units ? fmt(units.kph, 1) : '—'}</td>`;
        resultsBody.appendChild(tr);
      });
    }
  }

  function renderSpeedCard(overall, pairCount, l) {
    if (overall === null) {
      resAvg.textContent = '—';
      if (pairCount < 2) resSub.textContent = `need ≥2 matching Track A+B points (have ${pairCount})`;
      else if (l === null) resSub.textContent = 'need a reference length';
      else resSub.textContent = 'no reliable (straight-enough) interval';
      return;
    }
    const u = feetPerSecToUnits(overall);
    resAvg.textContent = fmt(u.mph, 1) + ' mph';
    resSub.textContent = `${fmt(u.kph, 1)} km/h · ${fmt(u.fps, 2)} ft/s · ${pairCount} paired pts · ref ${fmt(l, 2)} ft`;
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------
  function trackTsv(key) {
    const track = state.tracks[key];
    const pts = [...track.points.entries()].sort((a, b) => a[0] - b[0]);
    const lines = ['time\tx\ty'];
    pts.forEach(([, p]) => lines.push(`${p.t.toFixed(4)}\t${p.x.toFixed(2)}\t${p.y.toFixed(2)}`));
    return lines.join('\n');
  }

  async function copyText(text) {
    exportPreview.value = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      exportPreview.select();
      document.execCommand('copy');
    }
  }

  copyABtn.addEventListener('click', () => copyText(trackTsv('A')));
  copyBBtn.addEventListener('click', () => copyText(trackTsv('B')));
  copyBothBtn.addEventListener('click', () => {
    const a = [...state.tracks.A.points.entries()].sort((x, y) => x[0] - y[0]);
    const b = [...state.tracks.B.points.entries()].sort((x, y) => x[0] - y[0]);
    const n = Math.max(a.length, b.length);
    const lines = [`${state.tracks.A.label}_t\t${state.tracks.A.label}_x\t${state.tracks.A.label}_y\t${state.tracks.B.label}_t\t${state.tracks.B.label}_x\t${state.tracks.B.label}_y`];
    for (let i = 0; i < n; i++) {
      const pa = a[i] ? a[i][1] : null;
      const pb = b[i] ? b[i][1] : null;
      lines.push([
        pa ? pa.t.toFixed(4) : '', pa ? pa.x.toFixed(2) : '', pa ? pa.y.toFixed(2) : '',
        pb ? pb.t.toFixed(4) : '', pb ? pb.x.toFixed(2) : '', pb ? pb.y.toFixed(2) : '',
      ].join('\t'));
    }
    copyText(lines.join('\n'));
  });

  downloadCsvBtn.addEventListener('click', () => {
    const a = [...state.tracks.A.points.entries()].sort((x, y) => x[0] - y[0]);
    const b = [...state.tracks.B.points.entries()].sort((x, y) => x[0] - y[0]);
    const lines = [`track,frame,time_s,x_px,y_px`];
    a.forEach(([, p]) => lines.push(`${state.tracks.A.label},${p.frame ?? ''},${p.t.toFixed(4)},${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    b.forEach(([, p]) => lines.push(`${state.tracks.B.label},${p.frame ?? ''},${p.t.toFixed(4)},${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (state.videoName || 'tracks') + '.csv';
    link.click();
    URL.revokeObjectURL(url);
  });

  // ---------------------------------------------------------------------
  // Project save / load
  // ---------------------------------------------------------------------
  saveProjectBtn.addEventListener('click', () => {
    const project = {
      videoName: state.videoName,
      fpsMode: state.fpsMode,
      manualFps: parseFloat(manualFps.value) || null,
      tsSamples: state.tsSamples,
      calibrations: state.calibrations,
      tracks: {
        A: { label: state.tracks.A.label, points: [...state.tracks.A.points.entries()] },
        B: { label: state.tracks.B.label, points: [...state.tracks.B.points.entries()] },
      },
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (state.videoName || 'project') + '.speedproj.json';
    link.click();
    URL.revokeObjectURL(url);
  });

  loadProjectBtn.addEventListener('click', () => loadProjectFile.click());
  loadProjectFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(reader.result);
        if (p.videoName && p.videoName !== state.videoName) {
          if (!confirm(`This project was saved for "${p.videoName}", but the currently loaded video is "${state.videoName || 'none'}". Load anyway?`)) return;
        }
        state.fpsMode = p.fpsMode || 'manual';
        (p.fpsMode === 'timestamps' ? fpsModeTimestamps : fpsModeManual).checked = true;
        manualFps.value = p.manualFps || '';
        state.tsSamples = p.tsSamples || [];
        state.calibrations = p.calibrations || [];
        state.tracks.A.label = p.tracks?.A?.label || 'Front wheel';
        state.tracks.B.label = p.tracks?.B?.label || 'Rear wheel';
        state.tracks.A.points = new Map(p.tracks?.A?.points || []);
        state.tracks.B.points = new Map(p.tracks?.B?.points || []);
        renameTrackA.value = state.tracks.A.label;
        renameTrackB.value = state.tracks.B.label;
        document.getElementById('labelTrackA').textContent = state.tracks.A.label;
        document.getElementById('labelTrackB').textContent = state.tracks.B.label;
        refreshFpsUi();
        renderTsSamples();
        recomputeFpsFromSamples();
        calibBadge.textContent = state.calibrations.length ? state.calibrations.length + ' set' : 'none';
        renderCalibTable();
        renderTrackTable();
        drawFrame();
        recomputeResults();
      } catch (err) {
        alert('Could not read project file: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  refreshFpsUi();
  updateTransportEnabled();
})();
