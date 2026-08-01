import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { LookingGlassWebXRPolyfill, LookingGlassConfig } from "@lookingglass/webxr";
import { buildStarfield, buildNebula, buildNebulaRGBD } from "./starfield.js";
import { computeZ, computeXY } from "./distanceTransform.js";
import { buildAdaptiveGrid } from "./adaptiveGrid.js";

// --- Looking Glass config (must happen before renderer is created) ---
// targetX/Y/Z = focal point (where LG camera LOOKS AT), not camera position.
// LG camera auto-placed at: (targetX, targetY, targetZ + u)
//   where u = 0.5 * targetDiam / tan(0.5 * fovy)
// Near clip plane = targetDiam units in front of focal point.
const lgConfig = LookingGlassConfig;
lgConfig.targetX    = 80;
lgConfig.targetY    = 0;
lgConfig.targetZ    = -0.5;
lgConfig.targetDiam = 2800;
lgConfig.fovy       = 0.02;
lgConfig.depthiness = 1;
const initialLgTarget = {
  x: lgConfig.targetX,
  y: lgConfig.targetY,
  z: lgConfig.targetZ,
};
new LookingGlassWebXRPolyfill();

const homeScreen = document.getElementById("home-screen");
const sceneScreen = document.getElementById("scene-screen");
const enterSceneButton = document.getElementById("btn-enter-scene");
const exitSceneButton = document.getElementById("btn-exit-scene");
let sceneActive = false;
let sceneInitialized = false;
let sceneInitPromise = null;

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
sceneScreen.prepend(renderer.domElement);
const gridLabelLayer = document.getElementById("grid-label-layer");

// --- Collapsible scene-control drawer ---
const menuToggle = document.getElementById("menu-toggle");
const controlPanel = document.getElementById("transform-panel");

function setControlPanelOpen(open) {
  controlPanel.classList.toggle("open", open);
  controlPanel.setAttribute("aria-hidden", String(!open));
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close scene controls" : "Open scene controls");
}

menuToggle.addEventListener("click", () => {
  setControlPanelOpen(menuToggle.getAttribute("aria-expanded") !== "true");
});
window.addEventListener("keydown", event => {
  if (event.key === "Escape") setControlPanelOpen(false);
});

const vrBtn = VRButton.createButton(renderer);
vrBtn.style.top    = "12px";
vrBtn.style.left   = "12px";
vrBtn.style.bottom = "";
vrBtn.style.right  = "";
sceneScreen.appendChild(vrBtn);

// ---------------------------------------------------------------------------
// Desktop preview camera
const CAMERA_Z      = 5500;
const CAMERA_FOV    = 25;
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
let gridController = null;

const camera = new THREE.PerspectiveCamera(
  CAMERA_FOV,
  window.innerWidth / window.innerHeight,
  0.01,
  100000
);
camera.position.set(0, 0, CAMERA_Z);
camera.lookAt(CAMERA_TARGET);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CAMERA_TARGET);
controls.enableRotate  = true;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance   = 10;
controls.maxDistance   = 100000;
controls.update();
let cameraRollDeg = 0;

function applyCameraRoll() {
  if (cameraRollDeg !== 0) camera.rotateZ(THREE.MathUtils.degToRad(cameraRollDeg));
}

const initialCameraState = {
  position: camera.position.clone(),
  quaternion: camera.quaternion.clone(),
  target: controls.target.clone(),
  fov: camera.fov,
};

// WebXR writes the XR pose and projection back into the user camera each
// frame. Preserve the desktop camera so ending Looking Glass can return to
// the same interactive view without reloading the page.
let desktopCameraState = null;

renderer.xr.addEventListener("sessionstart", () => {
  desktopCameraState = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    target: controls.target.clone(),
    fov: camera.fov,
    zoom: camera.zoom,
    near: camera.near,
    far: camera.far,
  };
});

renderer.xr.addEventListener("sessionend", () => {
  if (desktopCameraState) {
    camera.position.copy(desktopCameraState.position);
    camera.quaternion.copy(desktopCameraState.quaternion);
    camera.fov = desktopCameraState.fov;
    camera.zoom = desktopCameraState.zoom;
    camera.near = desktopCameraState.near;
    camera.far = desktopCameraState.far;
    controls.target.copy(desktopCameraState.target);
    desktopCameraState = null;
  }

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  controls.enabled = true;
  controls.update();

  // Let the polyfill finish dismantling its quilt framebuffer first. Its last
  // XR view can otherwise leave a small viewport/scissor in the lower-left.
  requestAnimationFrame(() => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const canvas = renderer.domElement;
    const gl = renderer.getContext();

    renderer.setRenderTarget(null);
    renderer.resetState();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height, true);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);

    // Also reset the actual GL state because the Looking Glass layer manages
    // its quilt viewport below Three.js' renderer-state cache.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, canvas.width, canvas.height);

    if (sceneActive) {
      renderer.setAnimationLoop(renderFrame);
      renderer.clear();
      renderer.render(scene, camera);
    } else {
      renderer.setAnimationLoop(null);
    }
  });
});

// --- Load assets ---
const BASE = "/";

const NEBULA_TRANSFORMS = {
  linear: 0, sqrt: 1, cbrt: 2, log: 3, power2: 4, threshold: 5,
};

function transformNebulaSignal(x, name) {
  x = Math.min(1, Math.max(0, x));
  if (name === "linear") return x;
  if (name === "sqrt") return Math.sqrt(x);
  if (name === "cbrt") return Math.cbrt(x);
  if (name === "power2") return x * x;
  if (name === "threshold") return x > 0.05 ? x : 0;
  return Math.log10(1 + 99 * x) / Math.log10(100);
}

function transformedSignalCenter(meta, name) {
  const hist = meta.signal_histogram;
  if (!hist?.centers?.length || hist.centers.length !== hist.counts?.length) return 0;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < hist.centers.length; i++) {
    weighted += transformNebulaSignal(hist.centers[i], name) * hist.counts[i];
    total += hist.counts[i];
  }
  return total > 0 ? weighted / total : 0;
}

// Update all sprite positions when transform params change (no rebuild needed).
function applyTransform(sprites, rawStars, cfg) {
  for (let i = 0; i < sprites.length; i++) {
    const s  = rawStars[i];
    const xy = computeXY(s.x, s.y, s.dist_pc, cfg);
    sprites[i].position.x = xy.x;
    sprites[i].position.y = xy.y;
    sprites[i].position.z = computeZ(s.dist_pc, cfg);
  }
}

async function init() {
  // Load shared config (written by notebook, editable for defaults)
  const defaultCfg = {
    transform: "log10", bg_dist_pc: 3162.2777, bg_z_scene: 0,
    depth_coeff: 0.1, no_parallax_dist_factor: 1.2, img_w: 3000,
    pixel_scale_arcsec: 1.0, xy_mode: "raw", nebula_pos_shift: 0, scene_shift: 0,
    nebula_transform: "log",
    grid_line_width: 1.55, grid_brightness: 1, grid_angular_density: 10,
    grid_distance_shells: 7, grid_labels: true, grid_sightlines: true,
  };
  // baseCfg = true defaults (data/export/scene_config.json), always used for Reset button
  let baseCfg;
  try {
    baseCfg = await fetch(BASE + "scene_config.json").then(r => r.json());
  } catch (e) {
    console.warn("data/export/scene_config.json not found, using defaults:", e);
    baseCfg = defaultCfg;
  }
  baseCfg = { ...defaultCfg, ...baseCfg };

  const cfg = { ...baseCfg };

  const { group: starGroup, sprites, rawStars, meta } =
    await buildStarfield(BASE + "stars.json", cfg);
  scene.add(starGroup);

  const grid = buildAdaptiveGrid(cfg, rawStars, meta, gridLabelLayer);
  gridController = grid;
  scene.add(grid.group);
  if (!grid.supported) console.warn("RA/Dec grid disabled: TAN WCS metadata is unavailable.");

  const sceneWidth = 3000;

  let nebMeta = { nebula_depth_scale: 1, nebula_z_center: 0, default_transform: "log" };
  try {
    nebMeta = await fetch(BASE + "nebula_meta.json").then(r => r.json());
    console.log("Nebula meta:", nebMeta);
  } catch (e) {
    console.warn("nebula_meta.json not found, using defaults:", nebMeta);
  }

  const nebula = await buildNebula(BASE + "nebula.png", meta, sceneWidth);
  nebula.position.z = nebMeta.nebula_z_center;
  scene.add(nebula);

  const nebulaRGBD = await buildNebulaRGBD(
    BASE + "nebula.png",
    BASE + "nebula_signal.png",
    meta,
    sceneWidth,
    nebMeta.nebula_depth_scale,
  );
  nebulaRGBD.visible = false;
  scene.add(nebulaRGBD);

  if (!cfg.nebula_transform) cfg.nebula_transform = nebMeta.default_transform ?? "log";

  function applyNebulaTransform() {
    const name = NEBULA_TRANSFORMS[cfg.nebula_transform] != null
      ? cfg.nebula_transform : "log";
    nebulaRGBD.material.uniforms.uTransform.value = NEBULA_TRANSFORMS[name];
    nebulaRGBD.material.uniforms.uDepthCenter.value = transformedSignalCenter(nebMeta, name);
  }
  applyNebulaTransform();

  // Applies nebula_pos_shift and scene_shift together.
  // scene_shift also moves the star group so all objects shift in unison.
  function applyShifts() {
    const ss = cfg.scene_shift ?? 0;
    const ns = cfg.nebula_pos_shift ?? 0;
    starGroup.position.z = ss;
    grid.group.position.z = ss;
    nebula.position.z    = nebMeta.nebula_z_center + ns + ss;
    nebulaRGBD.material.uniforms.uZCenter.value = nebMeta.nebula_z_center + ns + ss;
  }
  applyShifts();

  // --- Scene toggle state ---
  let rgbdMode  = true;
  let showStars = true;
  let showGrid  = true;

  const btnStars    = document.getElementById("btn-stars");
  const btnNebula3d = document.getElementById("btn-nebula3d");
  const btnGrid      = document.getElementById("btn-grid");

  function applyVisibility() {
    starGroup.visible  = showStars;
    nebula.visible     = !rgbdMode;
    nebulaRGBD.visible = rgbdMode;
    grid.group.visible = showGrid && grid.supported;
    btnStars.classList.toggle("active", showStars);
    btnNebula3d.classList.toggle("active", rgbdMode);
    btnGrid.classList.toggle("active", showGrid && grid.supported);
    btnGrid.disabled = !grid.supported;
  }

  btnStars.addEventListener("click",    () => { showStars = !showStars; applyVisibility(); });
  btnNebula3d.addEventListener("click", () => { rgbdMode  = !rgbdMode;  applyVisibility(); });
  btnGrid.addEventListener("click",     () => { showGrid  = !showGrid;   applyVisibility(); });

  // --- Transform panel UI ---
  const savedCfg = { ...baseCfg }; // snapshot of data/export/scene_config.json defaults for Reset

  const btnLog10      = document.getElementById("btn-log10");
  const btnLinear     = document.getElementById("btn-linear");
  const btnXyRaw      = document.getElementById("btn-xy-raw");
  const btnXyCorrected = document.getElementById("btn-xy-corrected");

  const sliderBgDist    = document.getElementById("slider-bg-dist");
  const inputBgDist     = document.getElementById("input-bg-dist");
  const sliderDepthCoef = document.getElementById("slider-depth-coef");
  const valDepthCoef    = document.getElementById("val-depth-coef");
  const sliderNoPar       = document.getElementById("slider-no-par");
  const valNoPar          = document.getElementById("val-no-par");
  const sliderNebulaShift = document.getElementById("slider-nebula-shift");
  const valNebulaShift    = document.getElementById("val-nebula-shift");
  const sliderSceneShift  = document.getElementById("slider-scene-shift");
  const valSceneShift     = document.getElementById("val-scene-shift");
  const btnReset          = document.getElementById("btn-reset");
  const sliderGridWidth      = document.getElementById("slider-grid-width");
  const valGridWidth         = document.getElementById("val-grid-width");
  const sliderGridBrightness = document.getElementById("slider-grid-brightness");
  const valGridBrightness    = document.getElementById("val-grid-brightness");
  const sliderGridDensity    = document.getElementById("slider-grid-density");
  const valGridDensity       = document.getElementById("val-grid-density");
  const sliderGridShells     = document.getElementById("slider-grid-shells");
  const valGridShells        = document.getElementById("val-grid-shells");
  const btnGridLabels        = document.getElementById("btn-grid-labels");
  const btnGridSightlines    = document.getElementById("btn-grid-sightlines");
  const cameraFields = {
    x: [document.getElementById("slider-camera-x"), document.getElementById("val-camera-x")],
    y: [document.getElementById("slider-camera-y"), document.getElementById("val-camera-y")],
    z: [document.getElementById("slider-camera-z"), document.getElementById("val-camera-z")],
    roll: [document.getElementById("slider-camera-roll"), document.getElementById("val-camera-roll")],
    targetX: [document.getElementById("slider-target-x"), document.getElementById("val-target-x")],
    targetY: [document.getElementById("slider-target-y"), document.getElementById("val-target-y")],
    targetZ: [document.getElementById("slider-target-z"), document.getElementById("val-target-z")],
    fov: [document.getElementById("slider-camera-fov"), document.getElementById("val-camera-fov")],
  };
  const cameraDefaults = {
    x: initialCameraState.position.x,
    y: initialCameraState.position.y,
    z: initialCameraState.position.z,
    roll: 0,
    targetX: initialCameraState.target.x,
    targetY: initialCameraState.target.y,
    targetZ: initialCameraState.target.z,
    fov: initialCameraState.fov,
  };
  const btnResetCameraPosition = document.getElementById("btn-reset-camera-position");
  const btnResetCameraRotation = document.getElementById("btn-reset-camera-rotation");
  const btnCameraNorth = document.getElementById("btn-camera-north");
  const btnResetCameraTarget = document.getElementById("btn-reset-camera-target");
  const btnResetCameraLens = document.getElementById("btn-reset-camera-lens");
  const nebulaTransformButtons = [...document.querySelectorAll("[data-nebula-transform]")];

  function setCameraField(name, value, digits = 0) {
    const [slider, input] = cameraFields[name];
    slider.value = value;
    input.value = Number(value).toFixed(digits);
  }

  function editableCameraState() {
    return renderer.xr.isPresenting && desktopCameraState
      ? desktopCameraState
      : { position: camera.position, target: controls.target, fov: camera.fov };
  }

  function syncCameraUI() {
    const state = editableCameraState();
    setCameraField("x", state.position.x);
    setCameraField("y", state.position.y);
    setCameraField("z", state.position.z);
    setCameraField("roll", cameraRollDeg, 1);
    setCameraField("targetX", state.target.x);
    setCameraField("targetY", state.target.y);
    setCameraField("targetZ", state.target.z);
    setCameraField("fov", state.fov, 1);
  }

  function resetCamera() {
    const state = editableCameraState();
    state.position.copy(initialCameraState.position);
    state.target.copy(initialCameraState.target);
    state.fov = initialCameraState.fov;
    if (renderer.xr.isPresenting && desktopCameraState) {
      desktopCameraState.quaternion.copy(initialCameraState.quaternion);
    } else {
      camera.position.copy(state.position);
      camera.quaternion.copy(initialCameraState.quaternion);
      camera.fov = state.fov;
      controls.target.copy(state.target);
    }
    cameraRollDeg = 0;
    lgConfig.targetX = initialLgTarget.x;
    lgConfig.targetY = initialLgTarget.y;
    lgConfig.targetZ = initialLgTarget.z;
    if (!renderer.xr.isPresenting) {
      camera.updateProjectionMatrix();
      controls.update();
    }
    syncCameraUI();
  }

  function resetCameraPosition() {
    const state = editableCameraState();
    state.position.copy(initialCameraState.position);
    if (!renderer.xr.isPresenting) camera.position.copy(state.position);
    lgConfig.targetX = initialLgTarget.x;
    lgConfig.targetY = initialLgTarget.y;
    lgConfig.targetZ = initialLgTarget.z;
    if (!renderer.xr.isPresenting) controls.update();
    syncCameraUI();
  }

  function resetCameraRotation() {
    cameraRollDeg = 0;
    syncCameraUI();
  }

  function alignCameraToNorth() {
    const wcs = cfg.wcs;
    if (!wcs?.pc || !wcs?.cdelt) return;

    const m00 = wcs.cdelt[0] * wcs.pc[0][0];
    const m01 = wcs.cdelt[0] * wcs.pc[0][1];
    const m10 = wcs.cdelt[1] * wcs.pc[1][0];
    const m11 = wcs.cdelt[1] * wcs.pc[1][1];
    const determinant = m00 * m11 - m01 * m10;
    if (Math.abs(determinant) < 1e-15) return;

    // Inverse WCS linear transform for a pure +Dec displacement (north).
    const northPixelX = -m01 / determinant;
    const northPixelY = m00 / determinant;
    const northRaw = new THREE.Vector2(northPixelX, -northPixelY).normalize().multiplyScalar(100);
    const distance = cfg.bg_dist_pc;
    const centerXY = computeXY(0, 0, distance, cfg);
    const northXY = computeXY(northRaw.x, northRaw.y, distance, cfg);
    const z = computeZ(distance, cfg);
    const center = new THREE.Vector3(centerXY.x, centerXY.y, z);
    const north = new THREE.Vector3(northXY.x, northXY.y, z);

    controls.update();
    starGroup.updateMatrixWorld(true);
    center.applyMatrix4(starGroup.matrixWorld).project(camera);
    north.applyMatrix4(starGroup.matrixWorld).project(camera);
    const dx = north.x - center.x;
    const dy = north.y - center.y;
    if (Math.hypot(dx, dy) < 1e-8) return;

    cameraRollDeg = -THREE.MathUtils.radToDeg(Math.atan2(dx, dy));
    cameraRollDeg = THREE.MathUtils.euclideanModulo(cameraRollDeg + 180, 360) - 180;
    syncCameraUI();
  }

  function resetCameraTarget() {
    const state = editableCameraState();
    state.target.copy(initialCameraState.target);
    if (!renderer.xr.isPresenting) {
      controls.target.copy(state.target);
      controls.update();
    }
    syncCameraUI();
  }

  function resetCameraLens() {
    const state = editableCameraState();
    state.fov = initialCameraState.fov;
    if (!renderer.xr.isPresenting) {
      camera.fov = state.fov;
      camera.updateProjectionMatrix();
    }
    syncCameraUI();
  }

  function bindCameraField(name, apply) {
    const [slider, input] = cameraFields[name];
    const update = value => {
      if (!Number.isFinite(value)) return syncCameraUI();
      const clamped = THREE.MathUtils.clamp(value, Number(slider.min), Number(slider.max));
      apply(clamped);
      if (!renderer.xr.isPresenting) controls.update();
      syncCameraUI();
    };
    slider.addEventListener("input", () => update(Number(slider.value)));
    input.addEventListener("change", () => update(Number(input.value)));
    slider.addEventListener("dblclick", () => {
      if (["x", "y", "z"].includes(name)) {
        const state = editableCameraState();
        state.position[name] = cameraDefaults[name];
        if (!renderer.xr.isPresenting) camera.position[name] = cameraDefaults[name];
        const targetKey = `target${name.toUpperCase()}`;
        lgConfig[targetKey] = initialLgTarget[name];
        controls.update();
        syncCameraUI();
      } else {
        update(cameraDefaults[name]);
      }
    });
  }

  for (const axis of ["x", "y", "z"]) {
    bindCameraField(axis, value => {
      const state = editableCameraState();
      const delta = value - state.position[axis];
      state.position[axis] = value;
      if (!renderer.xr.isPresenting) camera.position[axis] = value;
      const targetKey = `target${axis.toUpperCase()}`;
      lgConfig[targetKey] += delta;
    });
  }
  for (const [name, axis] of [["targetX", "x"], ["targetY", "y"], ["targetZ", "z"]]) {
    bindCameraField(name, value => {
      const state = editableCameraState();
      state.target[axis] = value;
      if (!renderer.xr.isPresenting) controls.target[axis] = value;
    });
  }

  bindCameraField("roll", value => { cameraRollDeg = value; });
  bindCameraField("fov", value => {
    const state = editableCameraState();
    state.fov = value;
    if (!renderer.xr.isPresenting) {
      camera.fov = value;
      camera.updateProjectionMatrix();
    }
  });
  btnResetCameraPosition.addEventListener("click", resetCameraPosition);
  btnResetCameraRotation.addEventListener("click", resetCameraRotation);
  btnCameraNorth.addEventListener("click", alignCameraToNorth);
  btnResetCameraTarget.addEventListener("click", resetCameraTarget);
  btnResetCameraLens.addEventListener("click", resetCameraLens);
  controls.addEventListener("change", syncCameraUI);
  btnCameraNorth.disabled = !cfg.wcs?.pc || !cfg.wcs?.cdelt;

  function syncUIFromCfg() {
    btnLog10.classList.toggle("active",       cfg.transform === "log10");
    btnLinear.classList.toggle("active",      cfg.transform === "linear");
    btnXyRaw.classList.toggle("active",       cfg.xy_mode !== "corrected");
    btnXyCorrected.classList.toggle("active", cfg.xy_mode === "corrected");
    for (const button of nebulaTransformButtons) {
      button.classList.toggle("active", button.dataset.nebulaTransform === cfg.nebula_transform);
    }

    sliderBgDist.value  = cfg.bg_dist_pc;
    inputBgDist.value   = Math.round(cfg.bg_dist_pc);

    sliderDepthCoef.value = cfg.depth_coeff;
    valDepthCoef.value = cfg.depth_coeff.toFixed(2);

    sliderNoPar.value = cfg.no_parallax_dist_factor;
    valNoPar.value = cfg.no_parallax_dist_factor.toFixed(1);

    sliderNebulaShift.value = cfg.nebula_pos_shift;
    valNebulaShift.value = cfg.nebula_pos_shift;

    sliderSceneShift.value = cfg.scene_shift;
    valSceneShift.value = cfg.scene_shift;

    sliderGridWidth.value = cfg.grid_line_width;
    valGridWidth.value = cfg.grid_line_width;
    sliderGridBrightness.value = cfg.grid_brightness;
    valGridBrightness.value = Number(cfg.grid_brightness).toFixed(2);
    sliderGridDensity.value = cfg.grid_angular_density;
    valGridDensity.value = cfg.grid_angular_density;
    sliderGridShells.value = cfg.grid_distance_shells;
    valGridShells.value = cfg.grid_distance_shells;
    btnGridLabels.classList.toggle("active", cfg.grid_labels);
    btnGridSightlines.classList.toggle("active", cfg.grid_sightlines);
  }

  let gridRebuildFrame = 0;
  function scheduleGridRebuild() {
    cancelAnimationFrame(gridRebuildFrame);
    gridRebuildFrame = requestAnimationFrame(() => grid.rebuild(cfg));
  }

  function onCfgChanged() {
    applyTransform(sprites, rawStars, cfg);
    scheduleGridRebuild();
  }

  btnLog10.addEventListener("click", () => {
    cfg.transform = "log10"; syncUIFromCfg(); onCfgChanged();
  });
  btnLinear.addEventListener("click", () => {
    cfg.transform = "linear"; syncUIFromCfg(); onCfgChanged();
  });
  btnXyRaw.addEventListener("click", () => {
    cfg.xy_mode = "raw"; syncUIFromCfg(); onCfgChanged();
  });
  btnXyCorrected.addEventListener("click", () => {
    cfg.xy_mode = "corrected"; syncUIFromCfg(); onCfgChanged();
  });
  for (const button of nebulaTransformButtons) {
    button.addEventListener("click", () => {
      cfg.nebula_transform = button.dataset.nebulaTransform;
      syncUIFromCfg();
      applyNebulaTransform();
    });
  }

  sliderBgDist.addEventListener("dblclick",    () => { cfg.bg_dist_pc              = savedCfg.bg_dist_pc;              syncUIFromCfg(); onCfgChanged(); });
  sliderDepthCoef.addEventListener("dblclick", () => { cfg.depth_coeff             = savedCfg.depth_coeff;             syncUIFromCfg(); onCfgChanged(); });
  sliderNoPar.addEventListener("dblclick",     () => { cfg.no_parallax_dist_factor = savedCfg.no_parallax_dist_factor; syncUIFromCfg(); onCfgChanged(); });
  sliderNebulaShift.addEventListener("dblclick", () => { cfg.nebula_pos_shift = savedCfg.nebula_pos_shift ?? 0; syncUIFromCfg(); applyShifts(); });
  sliderSceneShift.addEventListener("dblclick",  () => { cfg.scene_shift      = savedCfg.scene_shift      ?? 0; syncUIFromCfg(); applyShifts(); });

  sliderBgDist.addEventListener("input", () => {
    cfg.bg_dist_pc = parseFloat(sliderBgDist.value);
    inputBgDist.value = Math.round(cfg.bg_dist_pc);
    onCfgChanged();
  });
  inputBgDist.addEventListener("change", () => {
    const v = parseFloat(inputBgDist.value);
    if (!isNaN(v) && v > 0) {
      cfg.bg_dist_pc = v;
      sliderBgDist.value = v;
      onCfgChanged();
    }
  });

  sliderDepthCoef.addEventListener("input", () => {
    cfg.depth_coeff = parseFloat(sliderDepthCoef.value);
    valDepthCoef.value = cfg.depth_coeff.toFixed(2);
    onCfgChanged();
  });
  valDepthCoef.addEventListener("change", () => {
    const v = parseFloat(valDepthCoef.value);
    if (!isNaN(v) && v >= 0.01 && v <= 5) {
      cfg.depth_coeff = v;
      sliderDepthCoef.value = v;
      onCfgChanged();
    }
  });

  sliderNoPar.addEventListener("input", () => {
    cfg.no_parallax_dist_factor = parseFloat(sliderNoPar.value);
    valNoPar.value = cfg.no_parallax_dist_factor.toFixed(1);
    onCfgChanged();
  });
  valNoPar.addEventListener("change", () => {
    const v = parseFloat(valNoPar.value);
    if (!isNaN(v) && v >= 0.5 && v <= 3.0) {
      cfg.no_parallax_dist_factor = v;
      sliderNoPar.value = v;
      onCfgChanged();
    }
  });

  sliderNebulaShift.addEventListener("input", () => {
    cfg.nebula_pos_shift = parseFloat(sliderNebulaShift.value);
    valNebulaShift.value = cfg.nebula_pos_shift;
    applyShifts();
  });
  valNebulaShift.addEventListener("change", () => {
    const v = parseFloat(valNebulaShift.value);
    if (!isNaN(v)) { cfg.nebula_pos_shift = v; sliderNebulaShift.value = v; applyShifts(); }
  });

  sliderSceneShift.addEventListener("input", () => {
    cfg.scene_shift = parseFloat(sliderSceneShift.value);
    valSceneShift.value = cfg.scene_shift;
    applyShifts();
  });

  function bindGridNumber(slider, input, key, digits = 0) {
    const apply = value => {
      cfg[key] = value;
      slider.value = value;
      input.value = digits ? value.toFixed(digits) : value;
      scheduleGridRebuild();
    };
    slider.addEventListener("input", () => apply(parseFloat(slider.value)));
    input.addEventListener("change", () => {
      const value = parseFloat(input.value);
      if (Number.isFinite(value) && value >= parseFloat(slider.min) && value <= parseFloat(slider.max)) apply(value);
      else syncUIFromCfg();
    });
    slider.addEventListener("dblclick", () => apply(savedCfg[key]));
  }

  bindGridNumber(sliderGridWidth, valGridWidth, "grid_line_width", 2);
  bindGridNumber(sliderGridBrightness, valGridBrightness, "grid_brightness", 2);
  bindGridNumber(sliderGridDensity, valGridDensity, "grid_angular_density");
  bindGridNumber(sliderGridShells, valGridShells, "grid_distance_shells");

  btnGridLabels.addEventListener("click", () => {
    cfg.grid_labels = !cfg.grid_labels;
    syncUIFromCfg();
    scheduleGridRebuild();
  });
  btnGridSightlines.addEventListener("click", () => {
    cfg.grid_sightlines = !cfg.grid_sightlines;
    syncUIFromCfg();
    scheduleGridRebuild();
  });
  valSceneShift.addEventListener("change", () => {
    const v = parseFloat(valSceneShift.value);
    if (!isNaN(v)) { cfg.scene_shift = v; sliderSceneShift.value = v; applyShifts(); }
  });

  btnReset.addEventListener("click", () => {
    Object.assign(cfg, savedCfg);
    syncUIFromCfg();
    onCfgChanged();
    applyNebulaTransform();
    applyShifts();
    resetCamera();
  });

  syncUIFromCfg();
  syncCameraUI();
  applyVisibility();

  console.log(`Loaded ${sprites.length} stars`);
  console.log("Scene config:", cfg);
}

async function enterScene() {
  enterSceneButton.disabled = true;
  enterSceneButton.textContent = sceneInitialized ? "Entering…" : "Loading scene…";

  try {
    if (!sceneInitPromise) sceneInitPromise = init();
    await sceneInitPromise;
    sceneInitialized = true;
  } catch (error) {
    console.error(error);
    sceneInitPromise = null;
    enterSceneButton.textContent = "Failed — retry";
    enterSceneButton.disabled = false;
    return;
  }

  homeScreen.hidden = true;
  sceneScreen.hidden = false;
  sceneActive = true;
  setControlPanelOpen(false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setAnimationLoop(renderFrame);
  enterSceneButton.textContent = "Enter 3D Scene";
  enterSceneButton.disabled = false;
}

async function exitScene() {
  sceneActive = false;
  setControlPanelOpen(false);

  const xrSession = renderer.xr.getSession();
  if (xrSession) {
    try {
      await xrSession.end();
    } catch (error) {
      console.warn("Could not end Looking Glass session cleanly:", error);
    }
  }

  renderer.setAnimationLoop(null);
  gridLabelLayer.style.display = "none";
  sceneScreen.hidden = true;
  homeScreen.hidden = false;
}

enterSceneButton.addEventListener("click", enterScene);
exitSceneButton.addEventListener("click", exitScene);

// --- Zoom-compensation state ---
// --- Resize handler ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Render loop ---
function renderFrame() {
  if (!sceneActive) return;
  if (!renderer.xr.isPresenting) {
    controls.update();
    applyCameraRoll();
  }
  gridController?.updateLabels(camera, renderer);
  renderer.render(scene, camera);
}
