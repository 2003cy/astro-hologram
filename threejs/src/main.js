import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildStarfield, buildNebula, buildNebulaRGBD } from "./starfield.js";
import { computeZ, computeXY } from "./distanceTransform.js";
import { buildAdaptiveGrid } from "./adaptiveGrid.js";
import { buildLkgCameraGrid } from "./lkgCameraGrid.js";
import { createStarInteraction } from "./starInteraction.js";

// --- Looking Glass config (must happen before renderer is created) ---
// targetX/Y/Z = focal point (where LG camera LOOKS AT), not camera position.
// LG camera auto-placed at: (targetX, targetY, targetZ + u)
//   where u = 0.5 * targetDiam / tan(0.5 * fovy)
// Near clip plane = targetDiam units in front of focal point.
const INITIAL_LG_CONFIG = Object.freeze({
  targetX: 80,
  targetY: 0,
  targetZ: -0.5,
  targetDiam: 2800,
  fovy: 0.19,
  depthiness: 1,
  trackballX: 0,
  trackballY: 0,
});
let lookingGlass = null;
let lgConfig = null;
let lgTrackballZ = 0;
let lgRollReference = null;

const homeScreen = document.getElementById("home-screen");
const sceneScreen = document.getElementById("scene-screen");
const enterSceneButton = document.getElementById("btn-enter-scene");
const exitSceneButton = document.getElementById("btn-exit-scene");
const sceneOptions = document.getElementById("scene-options");
const scenePickerStatus = document.getElementById("scene-picker-status");
let sceneActive = false;
let sceneInitialized = false;
let sceneInitPromise = null;
let sceneChoicesPromise = null;
let availableScenes = [];
let selectedSceneId = null;
let activeSceneId = null;

const APP_ROOT = new URL(import.meta.env.BASE_URL, window.location.href);

function appUrl(relativePath) {
  return new URL(relativePath, APP_ROOT).href;
}

function sceneBaseUrl(sceneId) {
  return appUrl(`scenes/${encodeURIComponent(sceneId)}/`);
}

function selectScene(sceneId, updateUrl = true) {
  const selected = availableScenes.find(scene => scene.id === sceneId);
  if (!selected) return;
  selectedSceneId = selected.id;
  for (const button of sceneOptions.querySelectorAll(".scene-option")) {
    const active = button.dataset.sceneId === selectedSceneId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  scenePickerStatus.textContent = `${selected.name} selected`;
  enterSceneButton.disabled = false;

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("scene", selectedSceneId);
    url.searchParams.delete("enter");
    window.history.replaceState(null, "", url);
  }
}

async function loadSceneChoices() {
  try {
    const response = await fetch(appUrl("scenes/manifest.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`Scene manifest returned ${response.status}`);
    const manifest = await response.json();
    availableScenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
    sceneOptions.replaceChildren();

    for (const scene of availableScenes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scene-option";
      button.dataset.sceneId = scene.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.textContent = scene.name;
      button.addEventListener("click", () => selectScene(scene.id));
      sceneOptions.appendChild(button);
    }

    if (!availableScenes.length) {
      scenePickerStatus.textContent = "No complete scene exports were found";
      return;
    }
    const requestedScene = new URL(window.location.href).searchParams.get("scene");
    const initialScene = availableScenes.some(scene => scene.id === requestedScene)
      ? requestedScene
      : availableScenes[0].id;
    selectScene(initialScene, false);
  } catch (error) {
    console.error(error);
    scenePickerStatus.textContent = "Could not load the scene list";
    enterSceneButton.disabled = true;
  }
}

// WebGL and Looking Glass are initialized on first entry, leaving the home
// screen lightweight and avoiding an early navigator.xr override.
let renderer = null;
let vrBtn = null;
let lgControlsCollapsed = true;
const gridLabelLayer = document.getElementById("grid-label-layer");
const lkgCameraLabelLayer = document.getElementById("lkg-camera-label-layer");
let lkgCameraGrid = null;
let starInteraction = null;

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

// Native <details> toggles are instantaneous. Keep their independent open
// state, but animate the content height so each submenu rolls down naturally.
const sectionAnimations = new WeakMap();
for (const section of document.querySelectorAll(".control-section")) {
  const summary = section.querySelector(":scope > summary");
  const content = section.querySelector(":scope > .section-content");
  if (!summary || !content) continue;

  section.dataset.expanded = String(section.open);
  summary.addEventListener("click", event => {
    event.preventDefault();

    const opening = section.dataset.expanded !== "true";
    section.dataset.expanded = String(opening);

    const previousAnimation = sectionAnimations.get(section);
    const wasOpen = section.open;
    const currentHeight = content.getBoundingClientRect().height;
    previousAnimation?.cancel();

    if (opening && !section.open) section.open = true;
    const fullHeight = content.scrollHeight;
    const startHeight = wasOpen ? currentHeight : 0;
    const endHeight = opening ? fullHeight : 0;

    content.style.overflow = "hidden";
    const animation = content.animate([
      {
        height: `${startHeight}px`,
        opacity: opening ? 0.35 : 1,
        transform: opening ? "translateY(-7px)" : "translateY(0)",
      },
      {
        height: `${endHeight}px`,
        opacity: opening ? 1 : 0.25,
        transform: opening ? "translateY(0)" : "translateY(-7px)",
      },
    ], {
      duration: opening ? 170 : 130,
      easing: opening ? "cubic-bezier(0.22, 1, 0.36, 1)" : "ease-in",
      fill: "forwards",
    });

    sectionAnimations.set(section, animation);
    animation.addEventListener("finish", () => {
      if (sectionAnimations.get(section) !== animation) return;
      sectionAnimations.delete(section);
      if (!opening) section.open = false;
      animation.cancel();
      content.style.overflow = "";
    });
  });
}

function labelLookingGlassButton() {
  if (vrBtn.textContent === "ENTER VR") vrBtn.textContent = "ENTER LOOKING GLASS";
  if (vrBtn.textContent === "EXIT VR") vrBtn.textContent = "EXIT LOOKING GLASS";
  if (vrBtn.textContent?.includes("LOOKING GLASS")) {
    vrBtn.style.width = "150px";
  }
}

function enhanceLookingGlassControls(panel) {
  if (panel.dataset.collapsible === "true") return;
  panel.dataset.collapsible = "true";

  const header = panel.firstElementChild;
  if (!header) return;
  header.textContent = "LKG Controls";
  header.style.textAlign = "left";
  header.style.paddingRight = "34px";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "looking-glass-controls-toggle";
  toggle.style.position = "absolute";
  toggle.style.top = "8px";
  toggle.style.right = "10px";
  toggle.style.width = "26px";
  toggle.style.height = "26px";
  toggle.style.padding = "0";
  toggle.style.border = "1px solid rgba(255,255,255,0.45)";
  toggle.style.borderRadius = "6px";
  toggle.style.background = "rgba(0,0,0,0.35)";
  toggle.style.color = "white";
  toggle.style.cursor = "pointer";
  toggle.style.fontSize = "16px";

  function applyCollapsedState() {
    for (const child of [...panel.children].slice(1)) {
      if (child.dataset.lgOriginalDisplay == null) {
        child.dataset.lgOriginalDisplay = child.style.display;
      }
      child.style.display = lgControlsCollapsed ? "none" : child.dataset.lgOriginalDisplay;
    }
    panel.style.width = lgControlsCollapsed ? "190px" : "320px";
    panel.style.padding = lgControlsCollapsed ? "10px 15px" : "15px";
    header.style.marginBottom = lgControlsCollapsed ? "0" : "8px";
    toggle.textContent = lgControlsCollapsed ? "+" : "−";
    toggle.title = lgControlsCollapsed ? "Expand Looking Glass controls" : "Collapse Looking Glass controls";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!lgControlsCollapsed));
  }

  toggle.addEventListener("click", () => {
    lgControlsCollapsed = !lgControlsCollapsed;
    applyCollapsedState();
  });
  header.appendChild(toggle);
  applyCollapsedState();
}

const lgControlsObserver = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.id === "LookingGlassWebXRControls") enhanceLookingGlassControls(node);
      const panel = node.querySelector?.("#LookingGlassWebXRControls");
      if (panel) enhanceLookingGlassControls(panel);
    }
  }
});
lgControlsObserver.observe(document.body, { childList: true, subtree: true });

// ---------------------------------------------------------------------------
// Desktop preview camera
const CAMERA_Z      = 5500;
const CAMERA_FOV    = 25;
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const astronomyRoot = new THREE.Group();
astronomyRoot.name = "astronomy-root";
scene.add(astronomyRoot);
let gridController = null;

const camera = new THREE.PerspectiveCamera(
  CAMERA_FOV,
  window.innerWidth / window.innerHeight,
  0.01,
  100000
);
camera.position.set(0, 0, CAMERA_Z);
camera.lookAt(CAMERA_TARGET);

let controls = null;
let cameraRollDeg = 0;

function applyCameraRoll() {
  if (cameraRollDeg !== 0) camera.rotateZ(THREE.MathUtils.degToRad(cameraRollDeg));
}

const initialCameraState = {
  position: camera.position.clone(),
  quaternion: camera.quaternion.clone(),
  target: CAMERA_TARGET.clone(),
  fov: camera.fov,
};

// WebXR writes the XR pose and projection back into the user camera each
// frame. Preserve the desktop camera so ending Looking Glass can return to
// the same interactive view without reloading the page.
let desktopCameraState = null;

function restoreAstronomyRoot() {
  astronomyRoot.position.set(0, 0, 0);
  astronomyRoot.quaternion.identity();
  astronomyRoot.updateMatrixWorld(true);
}

function captureLgRollReference() {
  if (!lgConfig) return null;
  const yRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    lgConfig.trackballX,
  );
  const xRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -lgConfig.trackballY,
  );
  return {
    opticalAxis: new THREE.Vector3(0, 0, 1)
      .applyQuaternion(yRotation.multiply(xRotation))
      .normalize(),
    pivot: new THREE.Vector3(
      lgConfig.targetX,
      lgConfig.targetY,
      lgConfig.targetZ,
    ),
  };
}

function applyLgSceneRoll() {
  if (!renderer?.xr.isPresenting || !lgConfig || lgTrackballZ === 0) {
    restoreAstronomyRoot();
    return;
  }

  // Freeze the roll axis and pivot when the LKG session starts. Following the
  // live X/Y trackball here would rotate the scene again during every mouse
  // drag and couple the official controls back into this custom scene roll.
  lgRollReference ??= captureLgRollReference();
  const sceneRotation = new THREE.Quaternion().setFromAxisAngle(
    lgRollReference.opticalAxis,
    -lgTrackballZ,
  );

  astronomyRoot.quaternion.copy(sceneRotation);
  astronomyRoot.position.copy(lgRollReference.pivot).sub(
    lgRollReference.pivot.clone().applyQuaternion(sceneRotation),
  );
  astronomyRoot.updateMatrixWorld(true);
}

function handleXRSessionStart() {
  lkgCameraGrid?.setXrPresenting(true);
  lgRollReference = lgTrackballZ !== 0 ? captureLgRollReference() : null;
  desktopCameraState = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    target: controls.target.clone(),
    fov: camera.fov,
    zoom: camera.zoom,
    near: camera.near,
    far: camera.far,
  };
  applyLgSceneRoll();
}

function handleXRSessionEnd() {
  restoreAstronomyRoot();
  lgRollReference = null;
  lkgCameraGrid?.setXrPresenting(false);
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
    renderer.setRenderTarget(null);
    renderer.resetState();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height, true);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);

    // The public renderer reset is normally sufficient. Only touch raw WebGL
    // when the quilt viewport/scissor survived session teardown.
    const gl = renderer.getContext();
    const viewport = gl.getParameter(gl.VIEWPORT);
    const needsFallback = gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null
      || gl.isEnabled(gl.SCISSOR_TEST)
      || viewport[0] !== 0 || viewport[1] !== 0
      || viewport[2] !== canvas.width || viewport[3] !== canvas.height;
    if (needsFallback) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, canvas.width, canvas.height);
      renderer.resetState();
    }

    if (sceneActive) {
      renderer.setAnimationLoop(renderFrame);
      renderer.clear();
      renderer.render(scene, camera);
    } else {
      renderer.setAnimationLoop(null);
    }
  });
}

async function initializeRuntime() {
  if (renderer) return;

  const [{ LookingGlassWebXRPolyfill, LookingGlassConfig }, { VRButton }] = await Promise.all([
    import("@lookingglass/webxr"),
    import("three/addons/webxr/VRButton.js"),
  ]);
  lgConfig = LookingGlassConfig;
  lookingGlass = new LookingGlassWebXRPolyfill({ ...INITIAL_LG_CONFIG });

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.addEventListener("sessionstart", handleXRSessionStart);
  renderer.xr.addEventListener("sessionend", handleXRSessionEnd);
  sceneScreen.prepend(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAMERA_TARGET);
  controls.enableRotate = true;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 10;
  controls.maxDistance = 100000;
  controls.update();

  // @lookingglass/webxr 0.6.0 leaves its app-canvas mouse, wheel, and keyboard
  // handlers attached after a session ends. These guards are registered before
  // the library creates its XR layer, so desktop input still reaches
  // OrbitControls but cannot fall through to the dormant Looking Glass handlers.
  const stopDormantLkgInput = event => {
    if (!renderer.xr.isPresenting) event.stopImmediatePropagation();
  };
  renderer.domElement.addEventListener("mousemove", stopDormantLkgInput);
  renderer.domElement.addEventListener("wheel", stopDormantLkgInput);
  renderer.domElement.addEventListener("keydown", stopDormantLkgInput);
  renderer.domElement.addEventListener("keyup", stopDormantLkgInput);

  vrBtn = VRButton.createButton(renderer);
  vrBtn.style.top = "12px";
  vrBtn.style.left = "12px";
  vrBtn.style.bottom = "";
  vrBtn.style.right = "";
  vrBtn.hidden = true;
  sceneScreen.appendChild(vrBtn);
  new MutationObserver(labelLookingGlassButton).observe(vrBtn, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  labelLookingGlassButton();
}

// --- Load assets ---
let BASE = null;

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
    transform: "log10", bg_dist_pc: 2000, bg_z_scene: 0,
    depth_coeff: 0.1, no_parallax_dist_factor: 1.2, img_w: 3000,
    pixel_scale_arcsec: 1.0, xy_mode: "raw", nebula_pos_shift: 0, scene_shift: 0,
    show_no_parallax_stars: false,
    star_selection_enabled: true,
    star_size_scale: 0.4,
    small_star_protection: true,
    min_star_core_px: 0.9,
    nebula_transform: "linear",
    nebula_brightness: 1.0,
    nebula_opacity: 1.0,
    camera_roll_deg: 0,
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

  const {
    group: starGroup,
    sprites,
    rawStars,
    meta,
    setSizeScale: setStarSizeScale,
    updateSmallStarProtection,
  } =
    await buildStarfield(BASE + "stars.json", cfg);
  astronomyRoot.add(starGroup);

  const grid = buildAdaptiveGrid(cfg, rawStars, meta, gridLabelLayer);
  gridController = grid;
  astronomyRoot.add(grid.group);
  lkgCameraGrid = buildLkgCameraGrid(lgConfig, camera, lkgCameraLabelLayer);
  lkgCameraGrid.setResolution(window.innerWidth, window.innerHeight);
  scene.add(lkgCameraGrid.group);
  if (!grid.supported) console.warn("RA/Dec grid disabled: TAN WCS metadata is unavailable.");

  const sceneWidth = meta.img_w ?? cfg.img_w ?? 3000;
  const sceneHeight = meta.img_h ?? cfg.img_h ?? sceneWidth;

  let nebMeta = { nebula_depth_scale: 1, nebula_z_center: 0, default_transform: "log" };
  try {
    nebMeta = await fetch(BASE + "nebula_meta.json").then(r => r.json());
    console.log("Nebula meta:", nebMeta);
  } catch (e) {
    console.warn("nebula_meta.json not found, using defaults:", nebMeta);
  }

  const nebula = await buildNebula(
    BASE + "nebula.png",
    meta,
    sceneWidth,
    sceneHeight,
  );
  nebula.position.z = nebMeta.nebula_z_center;
  astronomyRoot.add(nebula);

  const nebulaRGBD = await buildNebulaRGBD(
    BASE + "nebula.png",
    BASE + "nebula_signal.png",
    meta,
    sceneWidth,
    sceneHeight,
    nebMeta.nebula_depth_scale,
  );
  nebulaRGBD.visible = false;
  astronomyRoot.add(nebulaRGBD);

  if (!cfg.nebula_transform) cfg.nebula_transform = nebMeta.default_transform ?? "log";

  function applyNebulaTransform() {
    const name = NEBULA_TRANSFORMS[cfg.nebula_transform] != null
      ? cfg.nebula_transform : "log";
    nebulaRGBD.material.uniforms.uTransform.value = NEBULA_TRANSFORMS[name];
    nebulaRGBD.material.uniforms.uDepthCenter.value = transformedSignalCenter(nebMeta, name);
  }
  applyNebulaTransform();

  function applyNebulaAppearance() {
    const brightness = Math.max(0, Number(cfg.nebula_brightness) || 0);
    const opacity = THREE.MathUtils.clamp(Number(cfg.nebula_opacity) || 0, 0, 1);
    nebula.material.color.setScalar(brightness);
    nebula.material.opacity = opacity;
    nebulaRGBD.material.uniforms.uBrightness.value = brightness;
    nebulaRGBD.material.uniforms.uOpacity.value = opacity;
  }
  applyNebulaAppearance();

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
  let showGrid  = false;
  let showLkgCameraGrid = false;
  let showLkgActions = false;

  const btnStars    = document.getElementById("btn-stars");
  const btnNebula3d = document.getElementById("btn-nebula3d");
  const btnGrid      = document.getElementById("btn-grid");
  const btnLkgCamGrid = document.getElementById("btn-lkg-cam-grid");
  const btnShowLkgActions = document.getElementById("btn-show-lkg-actions");
  const btnStarSelection = document.getElementById("btn-star-selection");

  function applyLkgActionVisibility() {
    vrBtn.hidden = !showLkgActions;
    btnLkgCamGrid.hidden = !showLkgActions;
    btnShowLkgActions.classList.toggle("active", showLkgActions);
    btnShowLkgActions.setAttribute("aria-pressed", String(showLkgActions));
  }

  starInteraction = createStarInteraction({
    layer: document.getElementById("star-interaction-layer"),
    canvas: renderer.domElement,
    camera,
    renderer,
    sprites,
    rawStars,
    catalogUrl: BASE + (meta.catalog ?? "star_catalog.json"),
    canInteract: () => cfg.star_selection_enabled && showStars && !renderer.xr.isPresenting,
    isSelectable: index => showStars && sprites[index].visible,
  });

  function applyVisibility() {
    starGroup.visible  = showStars;
    nebula.visible     = !rgbdMode;
    nebulaRGBD.visible = rgbdMode;
    grid.group.visible = showGrid && grid.supported;
    lkgCameraGrid.setVisible(showLkgCameraGrid);
    btnStars.classList.toggle("active", showStars);
    btnNebula3d.classList.toggle("active", rgbdMode);
    btnGrid.classList.toggle("active", showGrid && grid.supported);
    btnLkgCamGrid.classList.toggle("active", showLkgCameraGrid);
    btnGrid.disabled = !grid.supported;
    starInteraction.refresh();
  }

  btnStars.addEventListener("click",    () => { showStars = !showStars; applyVisibility(); });
  btnNebula3d.addEventListener("click", () => { rgbdMode  = !rgbdMode;  applyVisibility(); });
  btnGrid.addEventListener("click",     () => { showGrid  = !showGrid;   applyVisibility(); });
  btnShowLkgActions.addEventListener("click", () => {
    showLkgActions = !showLkgActions;
    applyLkgActionVisibility();
  });
  btnLkgCamGrid.addEventListener("click", () => {
    showLkgCameraGrid = !showLkgCameraGrid;
    controls.maxDistance = showLkgCameraGrid
      ? Math.max(100000, lkgCameraGrid.cameraDistance * 2.5)
      : 100000;
    applyVisibility();
  });

  // --- Transform panel UI ---
  const savedCfg = { ...baseCfg }; // snapshot of data/export/scene_config.json defaults for Reset

  const btnLog10      = document.getElementById("btn-log10");
  const btnLinear     = document.getElementById("btn-linear");
  const btnXyRaw      = document.getElementById("btn-xy-raw");
  const btnXyCorrected = document.getElementById("btn-xy-corrected");
  const btnShowNoParallax = document.getElementById("btn-show-no-parallax");
  const sliderStarSize = document.getElementById("slider-star-size");
  const valStarSize = document.getElementById("val-star-size");
  const btnSmallStarProtection = document.getElementById("btn-small-star-protection");
  const sliderMinStarCore = document.getElementById("slider-min-star-core");
  const valMinStarCore = document.getElementById("val-min-star-core");

  const sliderBgDist    = document.getElementById("slider-bg-dist");
  const inputBgDist     = document.getElementById("input-bg-dist");
  const sliderDepthCoef = document.getElementById("slider-depth-coef");
  const valDepthCoef    = document.getElementById("val-depth-coef");
  const sliderNoPar       = document.getElementById("slider-no-par");
  const valNoPar          = document.getElementById("val-no-par");
  const sliderNebulaShift = document.getElementById("slider-nebula-shift");
  const valNebulaShift    = document.getElementById("val-nebula-shift");
  const sliderNebulaBrightness = document.getElementById("slider-nebula-brightness");
  const valNebulaBrightness    = document.getElementById("val-nebula-brightness");
  const sliderNebulaOpacity    = document.getElementById("slider-nebula-opacity");
  const valNebulaOpacity       = document.getElementById("val-nebula-opacity");
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
  const configuredCameraRoll = Number(cfg.camera_roll_deg);
  const cameraDefaults = {
    x: initialCameraState.position.x,
    y: initialCameraState.position.y,
    z: initialCameraState.position.z,
    roll: Number.isFinite(configuredCameraRoll)
      ? THREE.MathUtils.clamp(configuredCameraRoll, -180, 180)
      : 0,
    targetX: initialCameraState.target.x,
    targetY: initialCameraState.target.y,
    targetZ: initialCameraState.target.z,
    fov: initialCameraState.fov,
  };
  cameraRollDeg = cameraDefaults.roll;
  const btnResetCameraPosition = document.getElementById("btn-reset-camera-position");
  const btnResetCameraRotation = document.getElementById("btn-reset-camera-rotation");
  const btnCameraNorth = document.getElementById("btn-camera-north");
  const btnResetCameraTarget = document.getElementById("btn-reset-camera-target");
  const btnResetCameraLens = document.getElementById("btn-reset-camera-lens");
  const btnResetLgView = document.getElementById("btn-reset-lg-view");
  const btnResetLgTrackball = document.getElementById("btn-reset-lg-trackball");
  const sliderLgTrackballZ = document.getElementById("slider-lg-trackball-z");
  const valLgTrackballZ = document.getElementById("val-lg-trackball-z");
  const lgFields = {
    targetX: [document.getElementById("slider-lg-target-x"), document.getElementById("val-lg-target-x")],
    targetY: [document.getElementById("slider-lg-target-y"), document.getElementById("val-lg-target-y")],
    targetZ: [document.getElementById("slider-lg-target-z"), document.getElementById("val-lg-target-z")],
    targetDiam: [document.getElementById("slider-lg-diameter"), document.getElementById("val-lg-diameter")],
    fovy: [document.getElementById("slider-lg-fovy"), document.getElementById("val-lg-fovy")],
    depthiness: [document.getElementById("slider-lg-depthiness"), document.getElementById("val-lg-depthiness")],
    trackballX: [document.getElementById("slider-lg-trackball-x"), document.getElementById("val-lg-trackball-x")],
    trackballY: [document.getElementById("slider-lg-trackball-y"), document.getElementById("val-lg-trackball-y")],
  };
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

  function syncLgUI() {
    for (const [name, [slider, input]] of Object.entries(lgFields)) {
      const value = Number(lgConfig[name]);
      slider.value = value;
      input.value = Number.isInteger(value) ? value : Number(value.toFixed(3));
    }
    sliderLgTrackballZ.value = lgTrackballZ;
    valLgTrackballZ.value = Number(lgTrackballZ.toFixed(3));
  }

  // Looking Glass' built-in mouse/keyboard controls update the shared config
  // directly. Reflect those external changes back into this menu once per frame.
  let lgUiSyncFrame = 0;
  function scheduleLgUiSync() {
    if (lgUiSyncFrame) return;
    lgUiSyncFrame = requestAnimationFrame(() => {
      lgUiSyncFrame = 0;
      syncLgUI();
    });
  }
  lgConfig.addEventListener("on-config-changed", scheduleLgUiSync);

  function resetLgView() {
    lookingGlass.update({ ...INITIAL_LG_CONFIG });
    lgTrackballZ = 0;
    applyLgSceneRoll();
    syncLgUI();
  }

  function resetLgTrackball() {
    lookingGlass.update({
      trackballX: INITIAL_LG_CONFIG.trackballX,
      trackballY: INITIAL_LG_CONFIG.trackballY,
    });
    lgTrackballZ = 0;
    applyLgSceneRoll();
    syncLgUI();
  }

  function updateLgTrackballZ(value) {
    if (!Number.isFinite(value)) return syncLgUI();
    const nextValue = THREE.MathUtils.clamp(
      value,
      Number(sliderLgTrackballZ.min),
      Number(sliderLgTrackballZ.max),
    );
    if (lgTrackballZ === 0 && nextValue !== 0) {
      lgRollReference = captureLgRollReference();
    } else if (nextValue === 0) {
      lgRollReference = null;
    }
    lgTrackballZ = nextValue;
    applyLgSceneRoll();
    syncLgUI();
  }

  function bindLgField(name) {
    const [slider, input] = lgFields[name];
    const update = value => {
      if (!Number.isFinite(value)) return syncLgUI();
      const clamped = THREE.MathUtils.clamp(value, Number(slider.min), Number(slider.max));
      lookingGlass.update({ [name]: clamped });
      syncLgUI();
    };
    slider.addEventListener("input", () => update(Number(slider.value)));
    input.addEventListener("change", () => update(Number(input.value)));
    slider.addEventListener("dblclick", () => update(INITIAL_LG_CONFIG[name]));
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
    cameraRollDeg = cameraDefaults.roll;
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
    if (!renderer.xr.isPresenting) controls.update();
    syncCameraUI();
  }

  function resetCameraRotation() {
    cameraRollDeg = cameraDefaults.roll;
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
      update(cameraDefaults[name]);
    });
  }

  for (const axis of ["x", "y", "z"]) {
    bindCameraField(axis, value => {
      const state = editableCameraState();
      state.position[axis] = value;
      if (!renderer.xr.isPresenting) camera.position[axis] = value;
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
  for (const name of Object.keys(lgFields)) bindLgField(name);
  sliderLgTrackballZ.addEventListener("input", () => {
    updateLgTrackballZ(Number(sliderLgTrackballZ.value));
  });
  valLgTrackballZ.addEventListener("change", () => {
    updateLgTrackballZ(Number(valLgTrackballZ.value));
  });
  sliderLgTrackballZ.addEventListener("dblclick", () => updateLgTrackballZ(0));
  btnResetLgView.addEventListener("click", resetLgView);
  btnResetLgTrackball.addEventListener("click", resetLgTrackball);
  controls.addEventListener("change", syncCameraUI);
  btnCameraNorth.disabled = !cfg.wcs?.pc || !cfg.wcs?.cdelt;

  function syncUIFromCfg() {
    btnLog10.classList.toggle("active",       cfg.transform === "log10");
    btnLinear.classList.toggle("active",      cfg.transform === "linear");
    btnXyRaw.classList.toggle("active",       cfg.xy_mode !== "corrected");
    btnXyCorrected.classList.toggle("active", cfg.xy_mode === "corrected");
    btnShowNoParallax.classList.toggle("active", cfg.show_no_parallax_stars);
    btnShowNoParallax.setAttribute("aria-pressed", String(cfg.show_no_parallax_stars));
    btnStarSelection.classList.toggle("active", cfg.star_selection_enabled);
    btnStarSelection.setAttribute("aria-pressed", String(cfg.star_selection_enabled));
    sliderStarSize.value = cfg.star_size_scale;
    valStarSize.value = Number(cfg.star_size_scale).toFixed(2);
    btnSmallStarProtection.classList.toggle("active", cfg.small_star_protection);
    btnSmallStarProtection.setAttribute("aria-pressed", String(cfg.small_star_protection));
    sliderMinStarCore.value = cfg.min_star_core_px;
    valMinStarCore.value = Number(cfg.min_star_core_px).toFixed(2);
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
    sliderNebulaBrightness.value = cfg.nebula_brightness;
    valNebulaBrightness.value = Number(cfg.nebula_brightness).toFixed(2);
    sliderNebulaOpacity.value = cfg.nebula_opacity;
    valNebulaOpacity.value = Number(cfg.nebula_opacity).toFixed(2);

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
    applyStarVisibilityFilter();
    scheduleGridRebuild();
  }

  function applyStarVisibilityFilter() {
    for (let i = 0; i < sprites.length; i++) {
      sprites[i].visible = cfg.show_no_parallax_stars || rawStars[i].dist_pc != null;
    }
    starInteraction.refresh();
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
  btnShowNoParallax.addEventListener("click", () => {
    cfg.show_no_parallax_stars = !cfg.show_no_parallax_stars;
    syncUIFromCfg();
    applyStarVisibilityFilter();
  });
  btnStarSelection.addEventListener("click", () => {
    cfg.star_selection_enabled = !cfg.star_selection_enabled;
    syncUIFromCfg();
    starInteraction.refresh();
  });
  btnSmallStarProtection.addEventListener("click", () => {
    cfg.small_star_protection = !cfg.small_star_protection;
    syncUIFromCfg();
    updateSmallStarProtection(cfg.small_star_protection, cfg.min_star_core_px);
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
  sliderStarSize.addEventListener("dblclick",  () => { cfg.star_size_scale         = savedCfg.star_size_scale;         syncUIFromCfg(); setStarSizeScale(cfg.star_size_scale); });
  sliderMinStarCore.addEventListener("dblclick", () => { cfg.min_star_core_px = savedCfg.min_star_core_px; syncUIFromCfg(); updateSmallStarProtection(cfg.small_star_protection, cfg.min_star_core_px); });
  sliderNebulaShift.addEventListener("dblclick", () => { cfg.nebula_pos_shift = savedCfg.nebula_pos_shift ?? 0; syncUIFromCfg(); applyShifts(); });
  sliderNebulaBrightness.addEventListener("dblclick", () => { cfg.nebula_brightness = savedCfg.nebula_brightness ?? 1; syncUIFromCfg(); applyNebulaAppearance(); });
  sliderNebulaOpacity.addEventListener("dblclick", () => { cfg.nebula_opacity = savedCfg.nebula_opacity ?? 1; syncUIFromCfg(); applyNebulaAppearance(); });
  sliderSceneShift.addEventListener("dblclick",  () => { cfg.scene_shift      = savedCfg.scene_shift      ?? 0; syncUIFromCfg(); applyShifts(); });

  sliderBgDist.addEventListener("input", () => {
    cfg.bg_dist_pc = parseFloat(sliderBgDist.value);
    inputBgDist.value = Math.round(cfg.bg_dist_pc);
    onCfgChanged();
  });
  sliderStarSize.addEventListener("input", () => {
    cfg.star_size_scale = Number(sliderStarSize.value);
    valStarSize.value = cfg.star_size_scale.toFixed(2);
    setStarSizeScale(cfg.star_size_scale);
  });
  valStarSize.addEventListener("change", () => {
    const value = Number(valStarSize.value);
    if (Number.isFinite(value)) {
      cfg.star_size_scale = THREE.MathUtils.clamp(value, Number(sliderStarSize.min), Number(sliderStarSize.max));
      syncUIFromCfg();
      setStarSizeScale(cfg.star_size_scale);
    }
  });
  sliderMinStarCore.addEventListener("input", () => {
    cfg.min_star_core_px = Number(sliderMinStarCore.value);
    valMinStarCore.value = cfg.min_star_core_px.toFixed(2);
    updateSmallStarProtection(cfg.small_star_protection, cfg.min_star_core_px);
  });
  valMinStarCore.addEventListener("change", () => {
    const value = Number(valMinStarCore.value);
    if (Number.isFinite(value)) {
      cfg.min_star_core_px = THREE.MathUtils.clamp(value, Number(sliderMinStarCore.min), Number(sliderMinStarCore.max));
      syncUIFromCfg();
      updateSmallStarProtection(cfg.small_star_protection, cfg.min_star_core_px);
    }
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

  sliderNebulaBrightness.addEventListener("input", () => {
    cfg.nebula_brightness = Number(sliderNebulaBrightness.value);
    valNebulaBrightness.value = cfg.nebula_brightness.toFixed(2);
    applyNebulaAppearance();
  });
  valNebulaBrightness.addEventListener("change", () => {
    const value = Number(valNebulaBrightness.value);
    if (Number.isFinite(value) && value >= 0 && value <= 3) {
      cfg.nebula_brightness = value;
      sliderNebulaBrightness.value = value;
      applyNebulaAppearance();
    } else {
      syncUIFromCfg();
    }
  });
  sliderNebulaOpacity.addEventListener("input", () => {
    cfg.nebula_opacity = Number(sliderNebulaOpacity.value);
    valNebulaOpacity.value = cfg.nebula_opacity.toFixed(2);
    applyNebulaAppearance();
  });
  valNebulaOpacity.addEventListener("change", () => {
    const value = Number(valNebulaOpacity.value);
    if (Number.isFinite(value) && value >= 0 && value <= 1) {
      cfg.nebula_opacity = value;
      sliderNebulaOpacity.value = value;
      applyNebulaAppearance();
    } else {
      syncUIFromCfg();
    }
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
    applyNebulaAppearance();
    applyShifts();
    resetCamera();
    resetLgView();
  });

  syncUIFromCfg();
  applyStarVisibilityFilter();
  syncCameraUI();
  syncLgUI();
  applyLkgActionVisibility();
  applyVisibility();

  console.log(`Loaded ${sprites.length} stars`);
  console.log("Scene config:", cfg);
}

async function enterScene() {
  enterSceneButton.disabled = true;
  await sceneChoicesPromise;
  if (!selectedSceneId) return;

  // Scene objects and their UI listeners are initialized once per document.
  // Reload only when the user explicitly chooses a different data set; normal
  // Exit Scene remains instant and does not refresh the page.
  if (sceneInitialized && activeSceneId !== selectedSceneId) {
    const url = new URL(window.location.href);
    url.searchParams.set("scene", selectedSceneId);
    url.searchParams.set("enter", "1");
    window.location.assign(url);
    return;
  }

  BASE = sceneBaseUrl(selectedSceneId);
  activeSceneId = selectedSceneId;
  enterSceneButton.textContent = sceneInitialized ? "Entering…" : "Loading scene…";

  try {
    await initializeRuntime();
    if (!sceneInitPromise) sceneInitPromise = init();
    await sceneInitPromise;
    sceneInitialized = true;
  } catch (error) {
    console.error(error);
    sceneInitPromise = null;
    enterSceneButton.textContent = "Failed — retry";
    enterSceneButton.disabled = false;
    scenePickerStatus.textContent = `Could not load ${selectedSceneId}`;
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
  restoreAstronomyRoot();
  lgRollReference = null;
  setControlPanelOpen(false);
  starInteraction?.clear();

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
  lkgCameraLabelLayer.style.display = "none";
  sceneScreen.hidden = true;
  homeScreen.hidden = false;
}

enterSceneButton.addEventListener("click", enterScene);
exitSceneButton.addEventListener("click", exitScene);

sceneChoicesPromise = loadSceneChoices();
sceneChoicesPromise.then(() => {
  const url = new URL(window.location.href);
  if (url.searchParams.get("enter") !== "1" || !selectedSceneId) return;
  url.searchParams.delete("enter");
  window.history.replaceState(null, "", url);
  enterScene();
});

// --- Zoom-compensation state ---
// --- Resize handler ---
window.addEventListener("resize", () => {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  lkgCameraGrid?.setResolution(window.innerWidth, window.innerHeight);
});

// --- Render loop ---
function renderFrame() {
  if (!sceneActive) return;
  if (!renderer.xr.isPresenting) {
    controls.update();
    applyCameraRoll();
  }
  gridController?.updateLabels(camera, renderer);
  lkgCameraGrid?.updateLabels(camera, renderer);
  starInteraction?.update();
  renderer.render(scene, camera);
}
