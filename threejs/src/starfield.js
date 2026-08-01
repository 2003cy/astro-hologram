import * as THREE from "three";
import { computeZ, computeXY } from "./distanceTransform.js";

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Loads stars.json + atlas image and builds a Three.js Group of sprites.
 *
 * @param {string} jsonUrl  - URL to stars.json
 * @param {object} cfg      - data/export/scene_config.json contents (transform params)
 * @returns {{ group, sprites, rawStars, meta }}
 *   sprites and rawStars are parallel arrays; iterate both to update Z positions.
 */
export async function buildStarfield(jsonUrl, cfg) {
  const resp = await fetch(jsonUrl);
  const data = await resp.json();
  const { meta, stars } = data;

  const atlasUrl = new URL(meta.atlas, new URL(jsonUrl, location.href)).href;
  const atlasImage = await loadImage(atlasUrl);

  const group   = new THREE.Group();
  const sprites = [];

  for (const star of stars) {
    const { px_x, px_y, px_w, px_h } = star;

    const canvas = document.createElement("canvas");
    canvas.width  = px_w;
    canvas.height = px_h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(atlasImage, px_x, px_y, px_w, px_h, 0, 0, px_w, px_h);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const sprite = new THREE.Sprite(mat);
    const xy = computeXY(star.x, star.y, star.dist_pc, cfg);
    sprite.position.set(xy.x, xy.y, computeZ(star.dist_pc, cfg));
    sprite.scale.set(px_w, px_h, 1);

    group.add(sprite);
    sprites.push(sprite);
  }

  return { group, sprites, rawStars: stars, meta };
}

/**
 * Background nebula plane at z = meta.bg_z_scene (default XY plane, faces camera).
 */
export async function buildNebula(nebulaUrl, meta, sceneWidth) {
  const texture = await new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(nebulaUrl, resolve, undefined, reject);
  });
  texture.colorSpace = THREE.SRGBColorSpace;

  const geo = new THREE.PlaneGeometry(sceneWidth, sceneWidth);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.6,
  });

  const mesh = new THREE.Mesh(geo, mat);
  // PlaneGeometry default: lies in XY plane, normal faces +Z toward camera — no rotation needed
  mesh.position.set(0, 0, meta.bg_z_scene ?? 0);

  return mesh;
}

/**
 * RGBD nebula: displaced PlaneGeometry where a preprocessed signal drives Z.
 * Python performs star/background separation and smoothing. The vertex shader
 * applies the selected visual transform to that signal at render time.
 */
export async function buildNebulaRGBD(colorUrl, signalUrl, meta, sceneWidth,
                                       depthScale = 1) {
  const loader = new THREE.TextureLoader();
  const [colorTex, depthTex] = await Promise.all([
    new Promise((res, rej) => loader.load(colorUrl, res, undefined, rej)),
    new Promise((res, rej) => loader.load(signalUrl, res, undefined, rej)),
  ]);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  // Depth texture must stay linear — no sRGB gamma decode.
  // Three.js r152+ defaults to SRGBColorSpace for PNG, which causes the GPU to
  // apply d^2.2 decode when sampling, compressing the depth range by ~40-60%.
  depthTex.colorSpace    = THREE.NoColorSpace;
  depthTex.minFilter     = THREE.LinearFilter;
  depthTex.generateMipmaps = false;

  const geo = new THREE.PlaneGeometry(sceneWidth, sceneWidth, 512, 512);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColorMap:   { value: colorTex },
      uSignalMap:  { value: depthTex },
      uDepthScale: { value: depthScale },
      uDepthCenter:{ value: 0 },
      uZCenter:    { value: meta.bg_z_scene ?? 0 },
      uTransform:  { value: 3 },
      uOpacity:    { value: 0.6 },
      uBrightness: { value: 1.5 }, // compensates geometric dimming from vertex displacement
    },
    vertexShader: /* glsl */`
      uniform sampler2D uSignalMap;
      uniform float uDepthScale;
      uniform float uDepthCenter;
      uniform float uZCenter;
      uniform int uTransform;
      varying vec2 vUv;

      float transformSignal(float x) {
        x = clamp(x, 0.0, 1.0);
        if (uTransform == 0) return x;
        if (uTransform == 1) return sqrt(x);
        if (uTransform == 2) return pow(x, 1.0 / 3.0);
        if (uTransform == 3) return log(1.0 + 99.0 * x) / log(100.0);
        if (uTransform == 4) return x * x;
        return x > 0.05 ? x : 0.0;
      }

      void main() {
        vUv = uv;
        float signal = texture2D(uSignalMap, uv).r;
        float d = transformSignal(signal);
        vec3 pos = position;
        pos.z = uZCenter + (d - uDepthCenter) * uDepthScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uColorMap;
      uniform float uOpacity;
      uniform float uBrightness;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(uColorMap, vUv);
        gl_FragColor = vec4(c.rgb * uBrightness, uOpacity);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0, 0);
  return mesh;
}
