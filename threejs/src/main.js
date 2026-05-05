import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { LookingGlassWebXRPolyfill, LookingGlassConfig } from "@lookingglass/webxr";
import { buildStarfield, buildNebula } from "./starfield.js";

// --- Looking Glass config (must happen before renderer is created) ---
// targetX/Y/Z = focal point (where LG camera LOOKS AT), not camera position.
// LG camera auto-placed at: (targetX, targetY, targetZ + u)
//   where u = 0.5 * targetDiam / tan(0.5 * fovy)
// Near clip plane = targetDiam units in front of focal point.
const lgConfig = LookingGlassConfig;
lgConfig.targetX = 80;                           // focal point at scene centre
lgConfig.targetY = 0;                           // focal point at scene centre
lgConfig.targetZ = -0.5;                           // focal plane at nebula (z=0); default is -0.5 — must override
lgConfig.targetDiam = 2400;                     // scene height at focal plane; also sets near clip = 2400 units in front of z=0
lgConfig.fovy = 0.02;           // LG cam distance u = 1200/tan(12.5°) ≈ 5413 units
lgConfig.depthiness = 1;                     // default value — preserves relative depth ratios from log10(d_pc)
new LookingGlassWebXRPolyfill();

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// VR button wired to Looking Glass via the polyfill
const vrBtn = VRButton.createButton(renderer);
document.getElementById("vr-button").appendChild(vrBtn);

// ---------------------------------------------------------------------------
// Desktop preview camera — independent of LG config, only affects browser view.
// Set Z ≈ LG cam distance (u≈5413) so preview perspective matches hologram.
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

// --- Orbit controls (desktop navigation) ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CAMERA_TARGET);
controls.enableRotate = true;   // camera always faces straight into the scene
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 10;
controls.maxDistance = 100000;
controls.update();

// --- Load assets ---
const BASE = "./export/";

async function init() {
  const { group: starGroup, meta } = await buildStarfield(BASE + "stars.json");
  scene.add(starGroup);

  const sceneWidth = 3000; // px, same as image width
  const nebula = await buildNebula(BASE + "nebula.png", meta, sceneWidth);
  scene.add(nebula);

  console.log(`Loaded ${starGroup.children.length} stars`);
  console.log("Meta:", meta);
}

init().catch(console.error);

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
