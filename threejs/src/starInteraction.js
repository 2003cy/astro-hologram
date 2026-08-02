import * as THREE from "three";

const PICK_RADIUS_PX = 12;
const DRAG_TOLERANCE_PX = 5;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function number(value, digits = 2) {
  return finite(value) ? value.toFixed(digits) : "not available";
}

function measurement(value, error, digits, unit) {
  if (!finite(value)) return "not available";
  const uncertainty = finite(error) ? ` ± ${error.toFixed(digits)}` : "";
  return `${value.toFixed(digits)}${uncertainty} ${unit}`;
}

function raSexagesimal(degrees) {
  if (!finite(degrees)) return "not available";
  let totalSeconds = ((degrees % 360 + 360) % 360) / 15 * 3600;
  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds -= hours * 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${seconds.toFixed(2).padStart(5, "0")}s`;
}

function decSexagesimal(degrees) {
  if (!finite(degrees)) return "not available";
  const sign = degrees < 0 ? "−" : "+";
  let totalSeconds = Math.abs(degrees) * 3600;
  const deg = Math.floor(totalSeconds / 3600);
  totalSeconds -= deg * 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${sign}${String(deg).padStart(2, "0")}° ${String(minutes).padStart(2, "0")}′ ${seconds.toFixed(1).padStart(4, "0")}″`;
}

function appendSection(container, title, rows) {
  const populated = rows.filter(([, value]) => value != null);
  if (!populated.length) return;

  const heading = document.createElement("div");
  heading.className = "star-info-section-title";
  heading.textContent = title;
  container.appendChild(heading);

  const grid = document.createElement("dl");
  grid.className = "star-info-grid";
  for (const [label, value] of populated) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    grid.append(term, description);
  }
  container.appendChild(grid);
}

export function createStarInteraction({
  layer,
  canvas,
  camera,
  renderer,
  sprites,
  rawStars,
  catalogUrl,
  canInteract,
  isSelectable,
}) {
  const marker = layer.querySelector(".star-selection-marker");
  const tag = layer.querySelector(".star-selection-tag");
  const card = layer.querySelector(".star-info-card");
  const closeButton = layer.querySelector(".star-info-close");
  const cardTitle = layer.querySelector(".star-info-title");
  const cardSubtitle = layer.querySelector(".star-info-subtitle");
  const cardBody = layer.querySelector(".star-info-body");

  let pointerStart = null;
  let selectedIndex = -1;
  let catalog = null;
  let catalogPromise = null;
  const world = new THREE.Vector3();
  const projected = new THREE.Vector3();

  function ensureCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (!catalogPromise) {
      catalogPromise = fetch(catalogUrl)
        .then(response => {
          if (!response.ok) throw new Error(`Could not load ${catalogUrl}: HTTP ${response.status}`);
          return response.json();
        })
        .then(data => {
          catalog = data.stars ?? [];
          return catalog;
        });
    }
    return catalogPromise;
  }

  function selectedRecord() {
    return catalog?.[selectedIndex] ?? {
      id: rawStars[selectedIndex]?.id,
      detection: {
        flux: rawStars[selectedIndex]?.flux,
        fwhm_px: rawStars[selectedIndex]?.fwhm,
      },
      gaia: rawStars[selectedIndex]?.g_mag == null ? null : {
        g_mag: rawStars[selectedIndex].g_mag,
      },
      derived: { distance_pc: rawStars[selectedIndex]?.dist_pc },
    };
  }

  function renderInformation() {
    if (selectedIndex < 0) return;
    const record = selectedRecord();
    const star = rawStars[selectedIndex];
    const gaia = record.gaia;
    const detection = record.detection ?? {};
    const distance = record.derived?.distance_pc ?? star.dist_pc;

    const title = gaia?.source_id ? `Gaia DR3 ${gaia.source_id}` : "Detected source";
    cardTitle.textContent = title;
    tag.textContent = gaia?.source_id ? `Gaia ${gaia.source_id}` : record.id ?? star.id ?? "Detected source";

    const summary = [];
    if (finite(gaia?.g_mag)) summary.push(`G ${gaia.g_mag.toFixed(2)}`);
    if (finite(distance)) summary.push(`${Math.round(distance).toLocaleString()} pc`);
    if (!gaia) summary.push("No Gaia match");
    cardSubtitle.textContent = summary.join("  ·  ");

    cardBody.replaceChildren();
    if (gaia) {
      appendSection(cardBody, "Position", [
        ["RA", finite(gaia.ra_deg) ? `${raSexagesimal(gaia.ra_deg)}  (${gaia.ra_deg.toFixed(7)}°)` : null],
        ["Dec", finite(gaia.dec_deg) ? `${decSexagesimal(gaia.dec_deg)}  (${gaia.dec_deg.toFixed(7)}°)` : null],
      ]);
      appendSection(cardBody, "Photometry", [
        ["G magnitude", finite(gaia.g_mag) ? number(gaia.g_mag, 3) : null],
        ["BP / RP", finite(gaia.bp_mag) || finite(gaia.rp_mag)
          ? `${number(gaia.bp_mag, 3)} / ${number(gaia.rp_mag, 3)}` : null],
        ["BP − RP", finite(gaia.bp_rp) ? number(gaia.bp_rp, 3) : null],
      ]);
      appendSection(cardBody, "Astrometry", [
        ["Parallax", measurement(gaia.parallax_mas, gaia.parallax_error_mas, 4, "mas")],
        ["Scene distance", finite(distance) ? `${Math.round(distance).toLocaleString()} pc` : "No valid parallax"],
        ["Proper motion RA", measurement(gaia.pmra_mas_yr, gaia.pmra_error_mas_yr, 3, "mas/yr")],
        ["Proper motion Dec", measurement(gaia.pmdec_mas_yr, gaia.pmdec_error_mas_yr, 3, "mas/yr")],
        ["Radial velocity", measurement(gaia.radial_velocity_km_s, gaia.radial_velocity_error_km_s, 2, "km/s")],
        ["RUWE", finite(gaia.ruwe) ? number(gaia.ruwe, 3) : null],
        ["Match separation", finite(gaia.match_sep_arcsec) ? `${gaia.match_sep_arcsec.toFixed(3)}″` : null],
      ]);
    } else {
      appendSection(cardBody, "Catalog", [["Gaia", "No matching Gaia DR3 source"]]);
    }

    appendSection(cardBody, "Image detection", [
      ["Image position", finite(detection.image_x) && finite(detection.image_y)
        ? `${detection.image_x.toFixed(2)}, ${detection.image_y.toFixed(2)} px` : null],
      ["Flux", finite(detection.flux) ? number(detection.flux, 2) : null],
      ["FWHM", finite(detection.fwhm_px) ? `${detection.fwhm_px.toFixed(2)} px` : null],
      ["Ellipticity", finite(detection.ellipticity) ? number(detection.ellipticity, 3) : null],
    ]);
  }

  function clear() {
    selectedIndex = -1;
    layer.classList.remove("has-selection");
  }

  async function select(index) {
    selectedIndex = index;
    layer.classList.add("has-selection");
    renderInformation();
    try {
      await ensureCatalog();
      if (selectedIndex === index) renderInformation();
    } catch (error) {
      console.warn("Star catalog unavailable; using render metadata only:", error);
    }
  }

  function pick(clientX, clientY) {
    if (!canInteract()) return;
    const rect = canvas.getBoundingClientRect();
    camera.updateMatrixWorld(true);

    let bestIndex = -1;
    let bestScore = Infinity;
    for (let i = 0; i < sprites.length; i++) {
      if (!isSelectable(i)) continue;
      sprites[i].getWorldPosition(world);
      projected.copy(world).project(camera);
      if (projected.z < -1 || projected.z > 1) continue;

      const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
      const dx = clientX - x;
      const dy = clientY - y;
      const radius = Math.max(PICK_RADIUS_PX, Math.min(20, Math.max(rawStars[i].px_w, rawStars[i].px_h) * 0.5));
      const score = (dx * dx + dy * dy) / (radius * radius);
      if (score <= 1 && score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) select(bestIndex);
    else clear();
  }

  function onPointerDown(event) {
    if (!canInteract() || event.button !== 0) return;
    pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event) {
    if (!pointerStart || pointerStart.id !== event.pointerId) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    pointerStart = null;
    if (Math.hypot(dx, dy) <= DRAG_TOLERANCE_PX) pick(event.clientX, event.clientY);
  }

  function refresh() {
    const enabled = canInteract();
    canvas.classList.toggle("star-selection-enabled", enabled);
    if (!enabled) clear();
    else if (selectedIndex >= 0 && !isSelectable(selectedIndex)) clear();
    if (enabled) ensureCatalog().catch(error => console.warn("Could not preload star catalog:", error));
  }

  function update() {
    if (selectedIndex < 0) return;
    if (!canInteract() || !isSelectable(selectedIndex) || renderer.xr.isPresenting) {
      layer.classList.remove("selection-on-screen");
      return;
    }

    // OrbitControls changes the camera before WebGLRenderer refreshes its
    // matrices. Update them here so the marker uses the same pose as this
    // frame's scene instead of trailing one frame behind while dragging.
    camera.updateMatrixWorld(true);
    const rect = canvas.getBoundingClientRect();
    sprites[selectedIndex].getWorldPosition(world);
    projected.copy(world).project(camera);
    if (projected.z < -1 || projected.z > 1) {
      layer.classList.remove("selection-on-screen");
      return;
    }

    const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
    const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      layer.classList.remove("selection-on-screen");
      return;
    }

    layer.classList.add("selection-on-screen");
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    tag.style.left = `${Math.min(window.innerWidth - 190, x + 20)}px`;
    tag.style.top = `${Math.max(12, y - 34)}px`;

    const cardWidth = 320;
    const cardHeight = card.offsetHeight || 360;
    const cardX = x + 28 + cardWidth <= window.innerWidth ? x + 28 : x - cardWidth - 28;
    const cardY = Math.min(Math.max(12, y + 24), Math.max(12, window.innerHeight - cardHeight - 12));
    card.style.left = `${Math.max(12, cardX)}px`;
    card.style.top = `${cardY}px`;
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", () => { pointerStart = null; });
  closeButton.addEventListener("click", clear);

  return { clear, refresh, update };
}
