/* Pure calculation helpers, kept dependency- and DOM-free so they can be
 * unit tested with plain Node in addition to running in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VSECalc = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseTimestamp(str) {
    str = String(str).trim();
    if (!str) return null;
    if (/^-?\d+(\.\d+)?$/.test(str)) return parseFloat(str);
    const parts = str.split(':').map(s => s.trim());
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map(p => parseFloat(p));
    if (nums.some(n => Number.isNaN(n))) return null;
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
    return nums[0] * 60 + nums[1];
  }

  // Inverse of parseTimestamp: renders a raw seconds value (e.g. a
  // burned-in overlay timestamp, which is typically a clock reading rather
  // than a small video-relative offset) as HH:MM:SS.mmm.
  function formatTimestamp(totalSeconds) {
    const sign = totalSeconds < 0 ? '-' : '';
    const abs = Math.abs(totalSeconds);
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;
    const pad2 = n => String(n).padStart(2, '0');
    return `${sign}${pad2(h)}:${pad2(m)}:${s.toFixed(3).padStart(6, '0')}`;
  }

  // Least-squares fit of y = slope*x + intercept, with R^2.
  function linregress(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
    if (den === 0) return null;
    const slope = num / den;
    const intercept = meanY - slope * meanX;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const pred = slope * xs[i] + intercept;
      ssRes += (ys[i] - pred) ** 2;
      ssTot += (ys[i] - meanY) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
    return { slope, intercept, r2 };
  }

  // fps = 1 / (seconds of real time per real video frame), from a regression
  // of overlay timestamp vs. real decoded frame number.
  function fpsFromFrameSamples(samples) {
    if (samples.length < 2) return null;
    const fit = linregress(samples.map(s => s.frame), samples.map(s => s.t));
    if (!fit || fit.slope <= 0) return null;
    return { fps: 1 / fit.slope, r2: fit.r2 };
  }

  function feetPerSecToUnits(ftPerS) {
    return { fps: ftPerS, mph: ftPerS * 0.681818, kph: ftPerS * 1.09728 };
  }

  // --- Cross-ratio based vehicle speed ---
  //
  // See Choi et al., "Cross-ratio and vehicle dynamics-based speed
  // estimation for traffic accident analysis," Forensic Science
  // International 378 (2026) 112675.
  //
  // Requires two points tracked on the same rigid body (e.g. a vehicle's
  // front and rear wheel) at two moments in time, plus the single known
  // real-world distance between them (the "reference shape" — here, the
  // wheelbase). Because the cross-ratio of 4 collinear points is invariant
  // under projective transformation, this recovers the real displacement
  // between the two moments directly from image pixel positions, without
  // needing a per-frame pixel-to-real scale — unlike a plain scale
  // calibration, it isn't thrown off by the vehicle's apparent size
  // changing as it moves toward or away from the camera.
  //
  // Point naming follows the paper's Fig. 3: A, B are the two tracked
  // features at the earlier instant i (|AB| = l, the known reference
  // length); C, D are the SAME two features, in the same order, at the
  // later instant j.
  //
  // A note on Eq. (7): the paper's own Case 1 formula, as printed
  // (d = sqrt(l^2 - l^2/CR)), does not algebraically invert its own Eq. (6)
  // for the point layout shown in Fig. 3 — verified both symbolically and
  // by substituting numeric values back in. Case 3 (Eq. 9-10) does check
  // out exactly against the same figure. This uses the corrected Case 1
  // inversion, d = l / sqrt(CR + 1), derived directly from Eq. (6) and
  // Fig. 3's point layout.
  const STRAIGHTNESS_MAX_RATIO = 0.08; // RMS perpendicular deviation from the fitted midline, as a fraction of |AB| — beyond this the 4 points are too far from collinear (e.g. the vehicle is turning) to trust the cross-ratio.

  // Algorithm 1 (straightness index): fits a line through the i-frame and
  // j-frame midpoints, then sums the squared perpendicular distance of all
  // 4 points from it.
  function straightnessRSS(A, B, C, D) {
    const xim = (A.x + B.x) / 2, yim = (A.y + B.y) / 2;
    const xjm = (C.x + D.x) / 2, yjm = (C.y + D.y) / 2;
    const points = [A, B, C, D];
    if (Math.abs(xjm - xim) < 1e-9) {
      // Vertical midline — perpendicular distance is just the horizontal offset.
      return points.reduce((acc, p) => acc + (p.x - xim) ** 2, 0);
    }
    const a = (yjm - yim) / (xjm - xim);
    const b = yim - a * xim;
    const denom = a * a + 1;
    return points.reduce((acc, p) => acc + ((a * p.x - p.y + b) ** 2) / denom, 0);
  }

  // Computes the cross-ratio-derived displacement between two instants,
  // given A, B (positions of the two tracked features at the earlier
  // instant) and C, D (the same two features, same order, at the later
  // instant), and l (the known real distance between the features).
  function crossRatioInterval(A, B, C, D, l) {
    const dAB = Math.hypot(B.x - A.x, B.y - A.y);
    const dAC = Math.hypot(C.x - A.x, C.y - A.y);
    const dAD = Math.hypot(D.x - A.x, D.y - A.y);
    const dBC = Math.hypot(C.x - B.x, C.y - B.y);
    const dBD = Math.hypot(D.x - B.x, D.y - B.y);
    const EPS = 1e-6;

    const straightness = dAB > EPS ? Math.sqrt(straightnessRSS(A, B, C, D) / 4) / dAB : Infinity;
    const reliable = Number.isFinite(straightness) && straightness <= STRAIGHTNESS_MAX_RATIO;

    let caseNum = null, cr = null, distFt = null;
    if (dAB < EPS || dAC < EPS || dAD < EPS || dBC < EPS || dBD < EPS) {
      // Degenerate (coincident points) — can't form a cross-ratio.
    } else if (Math.abs(dAB - dAC) < 1e-6 * Math.max(dAB, dAC)) {
      // Case 2: the reference shape's displacement equals its own length.
      caseNum = 2;
      distFt = l;
    } else if (dAB > dAC) {
      // Case 1: displacement shorter than the reference length.
      caseNum = 1;
      cr = (dAD * dBC) / (dAC * dBD);
      if (Number.isFinite(cr) && cr > 0) distFt = l / Math.sqrt(cr + 1);
    } else {
      // Case 3: displacement longer than the reference length.
      caseNum = 3;
      cr = (dAC * dBD) / (dAD * dBC);
      if (Number.isFinite(cr) && cr > 1) distFt = l * Math.sqrt(cr / (cr - 1));
    }

    return { case: caseNum, cr, straightness, reliable: reliable && distFt !== null, distFt };
  }

  // Builds per-interval vehicle speed results for a time-sorted list of
  // paired observations `{ t, ax, ay, bx, by, frameA, frameB }` — one entry
  // per instant where BOTH tracked features have a position — given the
  // known real distance `l` (feet) between them.
  function computeCrossRatioIntervals(pairs, l) {
    const intervals = [];
    for (let i = 1; i < pairs.length; i++) {
      const p1 = pairs[i - 1], p2 = pairs[i];
      const dt = p2.t - p1.t;
      if (dt <= 0) continue;
      const A = { x: p1.ax, y: p1.ay }, B = { x: p1.bx, y: p1.by };
      const C = { x: p2.ax, y: p2.ay }, D = { x: p2.bx, y: p2.by };
      const res = crossRatioInterval(A, B, C, D, l);
      const speedFtS = res.reliable ? res.distFt / dt : null;
      intervals.push({
        t1: p1.t, t2: p2.t, dt,
        case: res.case, cr: res.cr, straightness: res.straightness, reliable: res.reliable,
        distFt: res.reliable ? res.distFt : null, speedFtS,
        f1: p1.frameA !== undefined ? p1.frameA : null,
        f2: p2.frameA !== undefined ? p2.frameA : null,
      });
    }
    return intervals;
  }

  function overallCrossRatioSpeed(intervals) {
    const valid = intervals.filter(iv => iv.reliable);
    if (!valid.length) return null;
    const totalDt = valid.reduce((acc, iv) => acc + iv.dt, 0);
    const totalDist = valid.reduce((acc, iv) => acc + iv.distFt, 0);
    return totalDt > 0 ? totalDist / totalDt : null;
  }

  return {
    parseTimestamp,
    formatTimestamp,
    linregress,
    fpsFromFrameSamples,
    feetPerSecToUnits,
    computeCrossRatioIntervals,
    overallCrossRatioSpeed,
  };
}));
