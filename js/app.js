/* Video Speed Estimator
 * Frame-by-frame pixel tracking + speed reconstruction, entirely client-side.
 *
 * Data model notes:
 * - Track points and calibrations are keyed by media TIME (ms, integer), not
 *   by a derived frame number. This avoids a circular dependency where frame
 *   stepping needs an FPS but FPS-discovery (timestamp regression) needs frame
 *   stepping to happen first.
 * - "frame index" shown to the user is a cosmetic value (time * effectiveFps),
 *   recomputed on demand once an FPS is known.
 * - FPS timestamp-regression uses an independent step counter that increments
 *   only when the user presses Next/Prev Frame, under the assumption each
 *   press advances exactly one real video frame.
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

  const resLabelA = document.getElementById('resLabelA');
  const resLabelB = document.getElementById('resLabelB');
  const resAvgA = document.getElementById('resAvgA');
  const resAvgB = document.getElementById('resAvgB');
  const resSubA = document.getElementById('resSubA');
  const resSubB = document.getElementById('resSubB');
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
    tsSamples: [], // { steps, t }
    stepCounter: 0, // increments/decrements with Next/Prev Frame clicks only
    effectiveFps: null,
    navFps: 30, // fallback step size while fps is unknown/being discovered
    calibrations: [], // { tMs, x1,y1,x2,y2, pixelDist, realDist, unit, scale (ft per px) }
    calibMode: false,
    calibClicks: [],
    activeTrack: 'A',
    tracks: {
      A: { label: 'Front wheel', color: '#ff6b6b', points: new Map() }, // tMs -> {t,x,y}
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

  function stepFps() { return state.effectiveFps || state.navFps || 30; }

  function displayFrame(t) {
    const fps = state.effectiveFps;
    return fps ? Math.round(t * fps) : null;
  }

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
    const ready = state.videoLoaded;
    [playBtn, prevFrameBtn, nextFrameBtn, prevNudgeBtn, nextNudgeBtn, playRate, seekBar].forEach(el => {
      el.disabled = !ready;
    });
    pickCalibBtn.disabled = !state.videoLoaded;
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
    videoInfo.textContent = 'Loading ' + file.name + '…';
  });

  video.addEventListener('loadedmetadata', () => {
    stage.width = video.videoWidth;
    stage.height = video.videoHeight;
    state.videoLoaded = true;
    state.stepCounter = 0;
    videoInfo.innerHTML = `<b>${escapeHtml(state.videoName)}</b><br>${video.videoWidth}&times;${video.videoHeight} &middot; duration ${video.duration.toFixed(2)}s`;
    updateTransportEnabled();
    saveProjectBtn.disabled = false;
    seekBar.max = Math.floor(video.duration * 1000);
    video.currentTime = 0;
  });

  video.addEventListener('seeked', () => {
    drawFrame();
    renderFrameReadout();
    renderTrackTable();
  });

  video.addEventListener('error', () => {
    videoInfo.textContent = 'Could not load this video file/codec in your browser.';
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
      });
    });
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
    const f = displayFrame(video.currentTime);
    const totalFrames = state.effectiveFps ? Math.round(video.duration * state.effectiveFps) : '—';
    frameReadout.textContent = `frame ${f !== null ? f : '—'} / ${totalFrames} · steps=${state.stepCounter} · t=${video.currentTime.toFixed(3)}s`;
    seekBar.value = Math.round(video.currentTime * 1000);
  }

  // ---------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------
  function pauseUi() {
    video.pause();
    state.playing = false;
    playBtn.textContent = '▶ Play';
  }

  function stepFrames(n) {
    pauseUi();
    const dt = n / stepFps();
    video.currentTime = Math.min(Math.max(0, video.currentTime + dt), video.duration);
    state.stepCounter += n;
  }

  function nudge(ms) {
    pauseUi();
    video.currentTime = Math.min(Math.max(0, video.currentTime + ms / 1000), video.duration);
  }

  prevFrameBtn.addEventListener('click', () => stepFrames(-1));
  nextFrameBtn.addEventListener('click', () => stepFrames(1));
  prevNudgeBtn.addEventListener('click', () => nudge(-10));
  nextNudgeBtn.addEventListener('click', () => nudge(10));

  playBtn.addEventListener('click', () => {
    if (state.playing) {
      pauseUi();
    } else {
      video.playbackRate = parseFloat(playRate.value);
      video.play();
      state.playing = true;
      playBtn.textContent = '⏸ Pause';
    }
  });

  playRate.addEventListener('change', () => { video.playbackRate = parseFloat(playRate.value); });

  let rafId = null;
  video.addEventListener('play', () => {
    const loop = () => {
      if (video.paused || video.ended) { rafId = null; return; }
      drawFrame();
      renderFrameReadout();
      rafId = requestAnimationFrame(loop);
    };
    if (!rafId) rafId = requestAnimationFrame(loop);
  });
  video.addEventListener('pause', () => {
    state.playing = false;
    playBtn.textContent = '▶ Play';
  });

  seekBar.addEventListener('input', () => {
    pauseUi();
    video.currentTime = seekBar.value / 1000;
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (!state.videoLoaded) return;
    if (e.key === 'ArrowRight') { stepFrames(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { stepFrames(-1); e.preventDefault(); }
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
    state.tsSamples.push({ steps: state.stepCounter, t, mediaTime: video.currentTime });
    tsInput.value = '';
    renderTsSamples();
    recomputeFpsFromSamples();
  });

  function renderTsSamples() {
    tsSampleBody.innerHTML = '';
    state.tsSamples.forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${s.steps}</td><td>${s.t.toFixed(3)}s</td><td><button class="small danger" data-i="${i}">&times;</button></td>`;
      tr.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.tsSamples.splice(i, 1);
        renderTsSamples();
        recomputeFpsFromSamples();
      });
      tr.addEventListener('click', () => { video.currentTime = s.mediaTime; });
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
    // Regression of overlay timestamp vs Next-Frame step count: slope is the
    // real seconds elapsed per step, so fps = 1/slope. Regressing over many
    // widely-spaced samples averages out any dropped or duplicated frames,
    // rather than trusting any single interval.
    const result = VSECalc.fpsFromStepSamples(state.tsSamples);
    if (!result) { tsQuality.style.display = 'none'; setEffectiveFps(null); return; }

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
    const realFeet = dist * UNIT_TO_FEET[unit];
    const scale = realFeet / pixelDist; // feet per pixel
    state.calibrations.push({
      tMs: tKey(video.currentTime), x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
      pixelDist, realDist: dist, unit, scale,
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

  function renderCalibTable() {
    calibBody.innerHTML = '';
    state.calibrations.sort((a, b) => a.tMs - b.tMs).forEach((c, i) => {
      const tr = document.createElement('tr');
      const f = displayFrame(c.tMs / 1000);
      tr.innerHTML = `<td>${i + 1}</td><td>${f !== null ? f : (c.tMs / 1000).toFixed(2) + 's'}</td><td>${c.pixelDist.toFixed(1)}</td><td>${c.realDist} ${c.unit}</td><td>${(c.scale * 12).toFixed(4)} in/px</td><td><button class="small danger" data-i="${i}">&times;</button></td>`;
      tr.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.calibrations.splice(i, 1);
        calibBadge.textContent = state.calibrations.length ? state.calibrations.length + ' set' : 'none';
        renderCalibTable();
        drawFrame();
        recomputeResults();
      });
      tr.addEventListener('click', () => { video.currentTime = c.tMs / 1000; });
      calibBody.appendChild(tr);
    });
  }

  function scaleAtTime(tSec) {
    return VSECalc.scaleAtTime(state.calibrations, tSec);
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

  renameTrackA.addEventListener('input', () => {
    state.tracks.A.label = renameTrackA.value || 'Track A';
    document.getElementById('labelTrackA').textContent = state.tracks.A.label;
    resLabelA.textContent = state.tracks.A.label;
  });
  renameTrackB.addEventListener('input', () => {
    state.tracks.B.label = renameTrackB.value || 'Track B';
    document.getElementById('labelTrackB').textContent = state.tracks.B.label;
    resLabelB.textContent = state.tracks.B.label;
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
    updateLoupe(x, y);
  });

  stage.addEventListener('mouseleave', () => {
    loupeCtx.clearRect(0, 0, loupe.width, loupe.height);
  });

  stage.addEventListener('click', (e) => {
    if (!state.videoLoaded) return;
    const [x, y] = stageCoordsFromEvent(e);

    if (state.calibMode) {
      state.calibClicks.push([x, y]);
      drawFrame();
      if (state.calibClicks.length === 2) finishCalibration();
      return;
    }

    const key = tKey(video.currentTime);
    state.tracks[state.activeTrack].points.set(key, { t: video.currentTime, x, y });
    drawFrame();
    renderTrackTable();
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
      const f = displayFrame(p.t);
      tr.innerHTML = `<td>${i + 1}</td><td>${f !== null ? f : '—'}</td><td>${p.t.toFixed(3)}</td><td>${p.x.toFixed(1)}</td><td>${p.y.toFixed(1)}</td><td><button class="small danger" data-key="${key}">&times;</button></td>`;
      tr.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.tracks[state.activeTrack].points.delete(key);
        renderTrackTable();
        drawFrame();
        recomputeResults();
      });
      tr.addEventListener('click', () => { video.currentTime = p.t; });
      trackBody.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------
  function feetPerSecToUnits(fps) {
    return VSECalc.feetPerSecToUnits(fps);
  }

  function computeTrackResults(key) {
    const track = state.tracks[key];
    const pts = [...track.points.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    const intervals = VSECalc.computeIntervals(pts, state.calibrations).map(iv => ({
      ...iv, f1: displayFrame(iv.t1), f2: displayFrame(iv.t2),
    }));
    const overall = VSECalc.overallSpeed(pts, state.calibrations);
    return { intervals, overall, pointCount: pts.length };
  }

  function recomputeResults() {
    const rA = computeTrackResults('A');
    const rB = computeTrackResults('B');

    renderSpeedCard(resAvgA, resSubA, rA);
    renderSpeedCard(resAvgB, resSubB, rB);
    resLabelA.textContent = state.tracks.A.label;
    resLabelB.textContent = state.tracks.B.label;

    resultsBody.innerHTML = '';
    const rows = [];
    ['A', 'B'].forEach(key => {
      const r = key === 'A' ? rA : rB;
      r.intervals.forEach(iv => rows.push({ key, iv }));
    });
    if (!rows.length) {
      resultsBody.innerHTML = '<tr><td colspan="8" style="color:var(--muted)">Track at least 2 points on a track, with calibration set, to see per-interval speeds.</td></tr>';
    } else {
      rows.forEach(({ key, iv }) => {
        const tr = document.createElement('tr');
        const units = iv.speedFtS !== null ? feetPerSecToUnits(iv.speedFtS) : null;
        const label = (iv.f1 !== null && iv.f2 !== null) ? `${iv.f1}→${iv.f2}` : `${fmt(iv.t1, 2)}s→${fmt(iv.t2, 2)}s`;
        tr.innerHTML = `<td><span class="tag ${key}">${key}</span></td>` +
          `<td>${label}</td>` +
          `<td>${fmt(iv.dt, 3)}</td>` +
          `<td>${fmt(iv.dpx, 1)}</td>` +
          `<td>${iv.distFt !== null ? fmt(iv.distFt, 2) + ' ft' : '—'}</td>` +
          `<td>${units ? fmt(units.fps, 2) + ' ft/s' : '—'}</td>` +
          `<td>${units ? fmt(units.mph, 1) : '—'}</td>` +
          `<td>${units ? fmt(units.kph, 1) : '—'}</td>`;
        resultsBody.appendChild(tr);
      });
    }
  }

  function renderSpeedCard(valueEl, subEl, result) {
    if (result.overall === null) {
      valueEl.textContent = '—';
      subEl.textContent = result.pointCount < 2 ? 'need ≥2 points' : 'need calibration';
      return;
    }
    const u = feetPerSecToUnits(result.overall);
    valueEl.textContent = fmt(u.mph, 1) + ' mph';
    subEl.textContent = `${fmt(u.kph, 1)} km/h · ${fmt(u.fps, 2)} ft/s · ${result.pointCount} pts`;
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
    a.forEach(([, p]) => lines.push(`${state.tracks.A.label},${displayFrame(p.t) ?? ''},${p.t.toFixed(4)},${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    b.forEach(([, p]) => lines.push(`${state.tracks.B.label},${displayFrame(p.t) ?? ''},${p.t.toFixed(4)},${p.x.toFixed(2)},${p.y.toFixed(2)}`));
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
