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

  // fps = 1 / (seconds of real time per one Next-Frame step)
  function fpsFromStepSamples(samples) {
    if (samples.length < 2) return null;
    const fit = linregress(samples.map(s => s.steps), samples.map(s => s.t));
    if (!fit || fit.slope <= 0) return null;
    return { fps: 1 / fit.slope, r2: fit.r2 };
  }

  // Interpolate calibration scale (real units per pixel) at time tSec,
  // from a list of { tMs, scale } sorted or unsorted.
  function scaleAtTime(calibrations, tSec) {
    if (!calibrations.length) return null;
    const cs = [...calibrations].sort((a, b) => a.tMs - b.tMs);
    const tMs = Math.round(tSec * 1000);
    if (cs.length === 1) return cs[0].scale;
    if (tMs <= cs[0].tMs) return cs[0].scale;
    if (tMs >= cs[cs.length - 1].tMs) return cs[cs.length - 1].scale;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = cs[i], b = cs[i + 1];
      if (tMs >= a.tMs && tMs <= b.tMs) {
        const frac = (tMs - a.tMs) / ((b.tMs - a.tMs) || 1);
        return a.scale + (b.scale - a.scale) * frac;
      }
    }
    return cs[0].scale;
  }

  function feetPerSecToUnits(ftPerS) {
    return { fps: ftPerS, mph: ftPerS * 0.681818, kph: ftPerS * 1.09728 };
  }

  // Build per-interval speed results for a sorted list of {t,x,y} points,
  // given a calibrations array usable by scaleAtTime.
  function computeIntervals(points, calibrations) {
    const intervals = [];
    for (let i = 1; i < points.length; i++) {
      const p1 = points[i - 1], p2 = points[i];
      const dt = p2.t - p1.t;
      if (dt <= 0) continue;
      const dpx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const s1 = scaleAtTime(calibrations, p1.t);
      const s2 = scaleAtTime(calibrations, p2.t);
      const scale = (s1 !== null && s2 !== null) ? (s1 + s2) / 2 : null;
      const distFt = scale !== null ? dpx * scale : null;
      const speedFtS = distFt !== null ? distFt / dt : null;
      intervals.push({ t1: p1.t, t2: p2.t, dt, dpx, distFt, speedFtS });
    }
    return intervals;
  }

  function overallSpeed(points, calibrations) {
    if (points.length < 2 || !calibrations.length) return null;
    const intervals = computeIntervals(points, calibrations);
    const totalDt = points[points.length - 1].t - points[0].t;
    const totalDist = intervals.reduce((acc, iv) => acc + (iv.distFt || 0), 0);
    return totalDt > 0 ? totalDist / totalDt : null;
  }

  return {
    parseTimestamp,
    linregress,
    fpsFromStepSamples,
    scaleAtTime,
    feetPerSecToUnits,
    computeIntervals,
    overallSpeed,
  };
}));
