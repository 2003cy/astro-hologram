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
