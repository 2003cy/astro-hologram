import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { LookingGlassWebXRPolyfill, LookingGlassConfig } from "@lookingglass/webxr";
import { buildStarfield, buildNebula, buildNebulaRGBD } from "./starfield.js";
import { computeZ, computeXY } from "./distanceTransform.js";

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
new LookingGlassWebXRPolyfill();

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const vrBtn = VRButton.createButton(renderer);
vrBtn.style.top    = "12px";
vrBtn.style.left   = "12px";
vrBtn.style.bottom = "";
vrBtn.style.right  = "";
document.body.appendChild(vrBtn);

renderer.xr.addEventListener("sessionend", () => {
  if (_cfg) sessionStorage.setItem("xr_cfg", JSON.stringify(_cfg));
  location.reload();
});

// ---------------------------------------------------------------------------
// Desktop preview camera
const CAMERA_Z      = 5500;
const CAMERA_FOV    = 25;
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

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

// --- Load assets ---
const BASE = "./export/";

// Holds the live cfg object so the sessionend handler can snapshot it before reload.
let _cfg = null;

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
  };
  // baseCfg = true defaults (scene_config.json), always used for Reset button
  let baseCfg;
  try {
    baseCfg = await fetch("/scene_config.json").then(r => r.json());
  } catch (e) {
    console.warn("scene_config.json not found, using defaults:", e);
    baseCfg = defaultCfg;
  }

  // cfg = working copy; restored from sessionStorage if coming back from VR exit
  const xrCfg = sessionStorage.getItem("xr_cfg");
  let cfg;
  if (xrCfg) {
    sessionStorage.removeItem("xr_cfg");
    cfg = { ...baseCfg, ...JSON.parse(xrCfg) };
  } else {
    cfg = { ...baseCfg };
  }

  const { group: starGroup, sprites, rawStars, meta } =
    await buildStarfield(BASE + "stars.json", cfg);
  scene.add(starGroup);

  const sceneWidth = 3000;

  let nebMeta = { nebula_z_offset: 0, nebula_depth_scale: 1, nebula_z_center: 0 };
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
    BASE + "nebula_depth.png",
    meta,
    sceneWidth,
    nebMeta.nebula_z_offset,
    nebMeta.nebula_depth_scale,
  );
  nebulaRGBD.visible = false;
  scene.add(nebulaRGBD);

  // Applies nebula_pos_shift and scene_shift together.
  // scene_shift also moves the star group so all objects shift in unison.
  function applyShifts() {
    const ss = cfg.scene_shift ?? 0;
    const ns = cfg.nebula_pos_shift ?? 0;
    starGroup.position.z = ss;
    nebula.position.z    = nebMeta.nebula_z_center + ns + ss;
    nebulaRGBD.material.uniforms.uZOffset.value = nebMeta.nebula_z_offset + ns + ss;
  }
  applyShifts();

  // --- Scene toggle state ---
  let rgbdMode  = false;
  let showStars = true;

  const btnStars    = document.getElementById("btn-stars");
  const btnNebula3d = document.getElementById("btn-nebula3d");

  function applyVisibility() {
    starGroup.visible  = showStars;
    nebula.visible     = !rgbdMode;
    nebulaRGBD.visible = rgbdMode;
    btnStars.classList.toggle("active", showStars);
    btnNebula3d.classList.toggle("active", rgbdMode);
  }

  btnStars.addEventListener("click",    () => { showStars = !showStars; applyVisibility(); });
  btnNebula3d.addEventListener("click", () => { rgbdMode  = !rgbdMode;  applyVisibility(); });

  // --- Transform panel UI ---
  const savedCfg = { ...baseCfg }; // snapshot of scene_config.json defaults for Reset

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

  function syncUIFromCfg() {
    btnLog10.classList.toggle("active",       cfg.transform === "log10");
    btnLinear.classList.toggle("active",      cfg.transform === "linear");
    btnXyRaw.classList.toggle("active",       cfg.xy_mode !== "corrected");
    btnXyCorrected.classList.toggle("active", cfg.xy_mode === "corrected");

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
  }

  function onCfgChanged() {
    applyTransform(sprites, rawStars, cfg);
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
    if (!isNaN(v) && v >= 0.01 && v <= 0.5) {
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
  valSceneShift.addEventListener("change", () => {
    const v = parseFloat(valSceneShift.value);
    if (!isNaN(v)) { cfg.scene_shift = v; sliderSceneShift.value = v; applyShifts(); }
  });

  btnReset.addEventListener("click", () => {
    Object.assign(cfg, savedCfg);
    syncUIFromCfg();
    onCfgChanged();
    applyShifts();
  });

  syncUIFromCfg();

  console.log(`Loaded ${sprites.length} stars`);
  console.log("Scene config:", cfg);
  _cfg = cfg;
}

init().catch(console.error);

// --- Zoom-compensation state ---
// --- Resize handler ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Render loop ---
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
