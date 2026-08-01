import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { computeXY, computeZ } from "./distanceTransform.js";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const ANGULAR_LINE_STEPS = 160;

function wrapDeltaDeg(value, reference) {
  return ((value - reference + 540) % 360) - 180;
}

// FITS RA---TAN/DEC--TAN world -> intermediate plane, followed by the
// inverse PC/CDELT transform. Returned pixels use the 0-based convention.
function worldToPixel(raDeg, decDeg, wcs) {
  const ra0 = wcs.crval[0] * DEG;
  const dec0 = wcs.crval[1] * DEG;
  const ra = (wcs.crval[0] + wrapDeltaDeg(raDeg, wcs.crval[0])) * DEG;
  const dec = decDeg * DEG;
  const dra = ra - ra0;

  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const sinDec0 = Math.sin(dec0), cosDec0 = Math.cos(dec0);
  const denom = sinDec * sinDec0 + cosDec * cosDec0 * Math.cos(dra);
  if (denom <= 0) return null;

  const xi = cosDec * Math.sin(dra) / denom * RAD;
  const eta = (sinDec * cosDec0 - cosDec * sinDec0 * Math.cos(dra)) / denom * RAD;

  const m00 = wcs.cdelt[0] * wcs.pc[0][0];
  const m01 = wcs.cdelt[0] * wcs.pc[0][1];
  const m10 = wcs.cdelt[1] * wcs.pc[1][0];
  const m11 = wcs.cdelt[1] * wcs.pc[1][1];
  const det = m00 * m11 - m01 * m10;
  if (Math.abs(det) < 1e-15) return null;

  const dx = (m11 * xi - m01 * eta) / det;
  const dy = (-m10 * xi + m00 * eta) / det;
  return { x: wcs.crpix[0] - 1 + dx, y: wcs.crpix[1] - 1 + dy };
}

function ticksBetween(min, max, target = 5) {
  const count = Math.max(2, Math.round(target));
  const step = (max - min) / count;
  const values = Array.from(
    { length: count },
    (_, index) => min + (index + 0.5) * step,
  );
  return { values, step };
}

function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function adaptiveDistanceTicks(rawStars) {
  const distances = rawStars
    .map(s => s.dist_pc)
    .filter(d => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (!distances.length) return [100, 300, 1000, 3000, 10000];

  const min = percentile(distances, 0.02);
  const max = percentile(distances, 0.98);
  const ticks = [];
  const multipliers = [1, 2, 5];
  for (let decade = Math.floor(Math.log10(min)); decade <= Math.ceil(Math.log10(max)); decade++) {
    for (const multiplier of multipliers) {
      const value = multiplier * 10 ** decade;
      if (value >= min * 0.8 && value <= max * 1.25) ticks.push(value);
    }
  }
  return ticks;
}

function formatDistance(pc) {
  if (pc >= 1000) return `${Number((pc / 1000).toPrecision(3))} kpc`;
  return `${Number(pc.toPrecision(3))} pc`;
}

function formatRa(deg, stepDeg) {
  let hours = ((deg / 15) % 24 + 24) % 24;
  const h = Math.floor(hours);
  const minutes = (hours - h) * 60;
  if (stepDeg >= 0.25) return `${String(h).padStart(2, "0")}h ${String(Math.round(minutes)).padStart(2, "0")}m`;
  const m = Math.floor(minutes);
  const s = Math.round((minutes - m) * 60);
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function formatDec(deg, stepDeg) {
  const sign = deg < 0 ? "−" : "+";
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minutes = (abs - d) * 60;
  if (stepDeg >= 0.25) return `${sign}${String(d).padStart(2, "0")}° ${String(Math.round(minutes)).padStart(2, "0")}′`;
  const m = Math.floor(minutes);
  const s = Math.round((minutes - m) * 60);
  return `${sign}${String(d).padStart(2, "0")}° ${String(m).padStart(2, "0")}′ ${String(s).padStart(2, "0")}″`;
}

function disposeGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    child.geometry?.dispose();
    if (child.material) {
      child.userData.labelTexture?.dispose();
      child.material.dispose();
    }
  }
}

function segmentBoundaryHits(a, b, width, height, margin) {
  const hits = [];
  const boundaries = [
    { edge: "left", value: margin, axis: "x" },
    { edge: "right", value: width - margin, axis: "x" },
    { edge: "top", value: margin, axis: "y" },
    { edge: "bottom", value: height - margin, axis: "y" },
  ];
  for (const boundary of boundaries) {
    const delta = boundary.axis === "x" ? b.x - a.x : b.y - a.y;
    if (Math.abs(delta) < 1e-8) continue;
    const start = boundary.axis === "x" ? a.x : a.y;
    const t = (boundary.value - start) / delta;
    if (t < 0 || t > 1) continue;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x >= margin - 0.5 && x <= width - margin + 0.5 &&
        y >= margin - 0.5 && y <= height - margin + 0.5) {
      hits.push({ x, y, edge: boundary.edge });
    }
  }
  return hits;
}

function candidateScore(candidate, kind, width, height) {
  if (kind === "ra") {
    const edgeBonus = candidate.edge === "bottom" ? 0 : candidate.edge === "top" ? 1000 : 2000;
    return edgeBonus + Math.abs(candidate.x - width / 2);
  }
  if (kind === "dec") {
    const edgeBonus = candidate.edge === "left" ? 0 : candidate.edge === "right" ? 1000 : 2000;
    return edgeBonus + Math.abs(candidate.y - height / 2);
  }
  const edgeBonus = candidate.edge === "right" ? 0 : candidate.edge === "bottom" ? 1000 : 2000;
  return edgeBonus + Math.abs(candidate.y - height / 2);
}

function overlaps(a, b, padding = 4) {
  return a.left < b.right + padding && a.right > b.left - padding &&
    a.top < b.bottom + padding && a.bottom > b.top - padding;
}

function lineFromPoints(points, color, opacity, options) {
  const positions = [];
  for (const point of points) positions.push(point.x, point.y, point.z);
  const geometry = new LineGeometry();
  geometry.setPositions(positions);
  // Encode visual strength in the color instead of alpha. Transparent grid
  // lines accumulate at crossings and make the intersections look like dots.
  const lineColor = new THREE.Color(color).multiplyScalar(
    Math.min(1, opacity * 1.7 * options.brightness)
  );
  const material = new LineMaterial({
    color: lineColor,
    linewidth: options.lineWidth,
    transparent: false,
    opacity: 1,
    depthWrite: false,
    alphaToCoverage: true,
  });
  return new Line2(geometry, material);
}

export function buildAdaptiveGrid(cfg, rawStars, starMeta, labelLayer) {
  const group = new THREE.Group();
  group.name = "adaptive-radec-distance-grid";
  group.renderOrder = 20;
  const wcs = cfg.wcs;
  const supported = wcs?.ctype?.[0]?.includes("RA---TAN") && wcs?.ctype?.[1]?.includes("DEC--TAN")
    && Array.isArray(wcs.footprint) && wcs.footprint.length >= 4;
  let labelTracks = [];

  function clearLabels() {
    labelTracks = [];
    labelLayer?.replaceChildren();
  }

  function addLabelTrack(text, color, kind, points) {
    if (!labelLayer || points.length < 2) return;
    const element = document.createElement("span");
    element.className = "grid-edge-label";
    element.textContent = text;
    element.style.color = color;
    labelLayer.appendChild(element);
    labelTracks.push({ element, kind, points });
  }

  function rebuild(currentCfg) {
    disposeGroup(group);
    clearLabels();
    if (!supported) return;

    const imgW = starMeta.img_w;
    const imgH = starMeta.img_h ?? starMeta.img_w;
    const raUnwrapped = wcs.footprint.map(p => wcs.crval[0] + wrapDeltaDeg(p[0], wcs.crval[0]));
    const decValues = wcs.footprint.map(p => p[1]);
    const raMin = Math.min(...raUnwrapped), raMax = Math.max(...raUnwrapped);
    const decMin = Math.min(...decValues), decMax = Math.max(...decValues);
    const options = {
      lineWidth: currentCfg.grid_line_width ?? 1.55,
      brightness: currentCfg.grid_brightness ?? 1,
      angularDensity: currentCfg.grid_angular_density ?? 10,
      distanceShells: currentCfg.grid_distance_shells ?? 7,
      labels: currentCfg.grid_labels ?? true,
      sightlines: currentCfg.grid_sightlines ?? true,
    };
    const raTicks = ticksBetween(raMin, raMax, options.angularDensity);
    const decTicks = ticksBetween(decMin, decMax, options.angularDensity);
    const raPadding = (raMax - raMin) * 0.02;
    const decPadding = (decMax - decMin) * 0.02;
    const raSampleMin = raMin - raPadding, raSampleMax = raMax + raPadding;
    const decSampleMin = decMin - decPadding, decSampleMax = decMax + decPadding;
    const allDistTicks = adaptiveDistanceTicks(rawStars);
    const shellCount = Math.min(options.distanceShells, allDistTicks.length);
    const distTicks = shellCount === allDistTicks.length
      ? allDistTicks
      : Array.from({ length: shellCount }, (_, i) =>
          allDistTicks[Math.round(i * (allDistTicks.length - 1) / (shellCount - 1))]
        );
    const nearDist = distTicks[0], farDist = distTicks[distTicks.length - 1];

    const scenePoint = (ra, dec, dist) => {
      const pixel = worldToPixel(ra, dec, wcs);
      if (!pixel || pixel.x < -2 || pixel.x > imgW + 1 || pixel.y < -2 || pixel.y > imgH + 1) return null;
      const rawX = pixel.x - starMeta.img_cx;
      const rawY = -(pixel.y - starMeta.img_cy);
      const xy = computeXY(rawX, rawY, dist, currentCfg);
      return new THREE.Vector3(xy.x, xy.y, computeZ(dist, currentCfg));
    };

    const addSampledLine = (sampler, steps, color, opacity) => {
      let run = [];
      const flush = () => {
        if (run.length > 1) group.add(lineFromPoints(run, color, opacity, options));
        run = [];
      };
      for (let i = 0; i <= steps; i++) {
        const point = sampler(i / steps);
        if (point) run.push(point); else flush();
      }
      flush();
    };

    const sampledPoints = (sampler, steps) => {
      const points = [];
      for (let i = 0; i <= steps; i++) {
        const point = sampler(i / steps);
        if (point) points.push(point);
      }
      return points;
    };

    // Angular coordinate nets on adaptive distance shells.
    for (const dist of distTicks) {
      const shellOpacity = dist === nearDist || dist === farDist ? 0.42 : 0.18;
      for (const ra of raTicks.values) {
        addSampledLine(
          t => scenePoint(ra, decSampleMin + (decSampleMax - decSampleMin) * t, dist),
          ANGULAR_LINE_STEPS, 0x49c6e5, shellOpacity,
        );
      }
      for (const dec of decTicks.values) {
        addSampledLine(
          t => scenePoint(raSampleMin + (raSampleMax - raSampleMin) * t, dec, dist),
          ANGULAR_LINE_STEPS, 0xe079c7, shellOpacity,
        );
      }
    }

    // Fixed RA/Dec sightlines. These become curves under corrected XY + log Z.
    if (options.sightlines) {
      for (const ra of raTicks.values) {
        for (const dec of decTicks.values) {
          addSampledLine(t => {
            const dist = nearDist * (farDist / nearDist) ** t;
            return scenePoint(ra, dec, dist);
          }, 48, 0x8a9aa8, 0.24);
        }
      }
    }

    // RA/Dec labels live near the configured background plane so they remain
    // readable in corrected mode; distance labels follow one edge sightline.
    if (!options.labels) return;
    const labelDist = distTicks.reduce((best, value) =>
      Math.abs(Math.log(value / currentCfg.bg_dist_pc)) < Math.abs(Math.log(best / currentCfg.bg_dist_pc)) ? value : best
    , distTicks[0]);
    for (const ra of raTicks.values) {
      addLabelTrack(
        formatRa(ra, raTicks.step), "#67d8f0", "ra",
        sampledPoints(
          t => scenePoint(ra, decSampleMin + (decSampleMax - decSampleMin) * t, labelDist),
          ANGULAR_LINE_STEPS,
        ),
      );
    }
    for (const dec of decTicks.values) {
      addLabelTrack(
        formatDec(dec, decTicks.step), "#ef91d8", "dec",
        sampledPoints(
          t => scenePoint(raSampleMin + (raSampleMax - raSampleMin) * t, dec, labelDist),
          ANGULAR_LINE_STEPS,
        ),
      );
    }
    for (const dist of distTicks) {
      addLabelTrack(
        formatDistance(dist), "#f2cf72", "distance",
        sampledPoints(
          t => scenePoint(raSampleMin + (raSampleMax - raSampleMin) * t, decMin, dist),
          ANGULAR_LINE_STEPS,
        ),
      );
    }
  }

  function updateLabels(camera, renderer) {
    const visible = supported && group.visible && labelTracks.length > 0;
    const showOverlay = visible && !renderer.xr.isPresenting;
    if (labelLayer) labelLayer.style.display = showOverlay ? "block" : "none";
    if (!visible) return;
    if (!showOverlay || !labelLayer) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const margin = 18;
    const placed = [];

    camera.updateMatrixWorld();
    group.updateMatrixWorld(true);
    for (const track of labelTracks) {
      track.element.style.display = "block";
      const projected = [];
      for (const worldPoint of track.points) {
        const viewPoint = worldPoint.clone().applyMatrix4(group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
        if (viewPoint.z >= 0) {
          projected.push(null);
          continue;
        }
        const ndc = worldPoint.clone().applyMatrix4(group.matrixWorld).project(camera);
        projected.push({
          x: (ndc.x * 0.5 + 0.5) * width,
          y: (-ndc.y * 0.5 + 0.5) * height,
          inDepth: ndc.z >= -1 && ndc.z <= 1,
        });
      }

      const candidates = [];
      for (let i = 1; i < projected.length; i++) {
        const a = projected[i - 1], b = projected[i];
        if (!a || !b || (!a.inDepth && !b.inDepth)) continue;
        candidates.push(...segmentBoundaryHits(a, b, width, height, margin));
      }

      if (!candidates.length) {
        const inside = projected.filter(point => point?.inDepth && point.x >= margin && point.x <= width - margin &&
          point.y >= margin && point.y <= height - margin);
        if (inside.length) {
          const fallback = inside.reduce((best, point) => {
            if (!best) return point;
            if (track.kind === "ra") return point.y > best.y ? point : best;
            if (track.kind === "dec") return point.x < best.x ? point : best;
            return point.x > best.x ? point : best;
          }, null);
          candidates.push({ ...fallback, edge: "grid" });
        }
      }

      candidates.sort((a, b) => candidateScore(a, track.kind, width, height) - candidateScore(b, track.kind, width, height));
      const element = track.element;
      let chosen = null;
      for (const candidate of candidates) {
        element.style.left = `${rect.left + candidate.x}px`;
        element.style.top = `${rect.top + candidate.y}px`;
        const halfWidth = element.offsetWidth / 2;
        const halfHeight = element.offsetHeight / 2;
        const box = {
          left: candidate.x - halfWidth, right: candidate.x + halfWidth,
          top: candidate.y - halfHeight, bottom: candidate.y + halfHeight,
        };
        if (!placed.some(other => overlaps(box, other))) {
          chosen = box;
          break;
        }
      }
      element.style.display = chosen ? "block" : "none";
      if (chosen) placed.push(chosen);
    }
  }

  rebuild(cfg);
  return { group, rebuild, updateLabels, supported };
}
