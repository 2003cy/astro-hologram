import * as THREE from "three";

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Loads stars.json + atlas image.
 * Each star gets its own CanvasTexture cropped from the atlas —
 * no UV offset tricks, no texture cloning.
 */
export async function buildStarfield(jsonUrl) {
  const resp = await fetch(jsonUrl);
  const data = await resp.json();
  const { meta, stars } = data;

  const atlasUrl = new URL(meta.atlas, new URL(jsonUrl, location.href)).href;
  const atlasImage = await loadImage(atlasUrl);

  const group = new THREE.Group();

  for (const star of stars) {
    const { px_x, px_y, px_w, px_h } = star;

    const canvas = document.createElement("canvas");
    canvas.width = px_w;
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
    sprite.position.set(star.x, star.y, star.z);
    sprite.scale.set(px_w, px_h, 1);

    group.add(sprite);
  }

  return { group, meta };
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
  mesh.position.set(0, 0, meta.bg_z_scene);

  return mesh;
}

/**
 * RGBD nebula: displaced PlaneGeometry where brightness drives Z depth.
 * Vertex shader sets absolute Z = zOffset + depth * depthScale.
 *   depth=0 (dark background) → zOffset       (back face of nebula)
 *   depth=1 (bright core)     → zOffset + depthScale  (front face)
 * Both zOffset and depthScale come from export/nebula_meta.json.
 */
export async function buildNebulaRGBD(colorUrl, depthUrl, meta, sceneWidth,
                                       zOffset = 0, depthScale = 1) {
  const loader = new THREE.TextureLoader();
  const [colorTex, depthTex] = await Promise.all([
    new Promise((res, rej) => loader.load(colorUrl, res, undefined, rej)),
    new Promise((res, rej) => loader.load(depthUrl, res, undefined, rej)),
  ]);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  // Depth texture must stay linear — no sRGB gamma decode.
  // Three.js r152+ defaults to SRGBColorSpace for PNG, which causes the GPU to
  // apply d^2.2 decode when sampling, compressing the depth range by ~40-60%.
  depthTex.colorSpace   = THREE.NoColorSpace;
  depthTex.minFilter    = THREE.LinearFilter;
  depthTex.generateMipmaps = false;

  const geo = new THREE.PlaneGeometry(sceneWidth, sceneWidth, 512, 512);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColorMap:   { value: colorTex },
      uDepthMap:   { value: depthTex },
      uZOffset:    { value: zOffset },
      uDepthScale: { value: depthScale },
      uOpacity:    { value: 0.6 },
      uBrightness: { value: 1.5 }, // compensates geometric dimming from vertex displacement
    },
    vertexShader: /* glsl */`
      uniform sampler2D uDepthMap;
      uniform float uZOffset;
      uniform float uDepthScale;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        float d = texture2D(uDepthMap, uv).r;
        vec3 pos = position;
        pos.z = uZOffset + d * uDepthScale;
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
