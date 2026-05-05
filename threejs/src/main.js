import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { LookingGlassWebXRPolyfill, LookingGlassConfig } from "@lookingglass/webxr";
import { buildStarfield, buildNebula } from "./starfield.js";

// --- Looking Glass config (must happen before renderer is created) ---
const lgConfig = LookingGlassConfig;
lgConfig.targetY = 0;          // orbit centre depth
lgConfig.targetDiam = 3000;    // scene diameter in scene units
lgConfig.fovy = (25 * Math.PI) / 180;
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
// Camera config — edit these values to reposition the viewpoint
// Coordinate system: X=right, Y=up, Z=toward viewer (standard Three.js)
// Background plane sits at z=0; nearby stars have positive z (closer to camera)
const CAMERA_Z      = 2000;    // distance in front of background plane
const CAMERA_FOV    = 50;      // degrees
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0);  // image centre, bg depth
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
controls.enableRotate = false;   // camera always faces straight into the scene
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
