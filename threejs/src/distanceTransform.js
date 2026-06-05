// Distance → scene Z transform functions.
// Z convention: bg_z_scene = background plane, positive Z = closer to camera.
//
// To add a new transform: add an entry to TRANSFORMS with signature
//   (dist_pc, bg_dist_pc, depth_scale) => z_offset_from_bg

export const TRANSFORMS = {

  log10: (dist_pc, bg_dist_pc, depth_scale) =>
    -(Math.log10(dist_pc) - Math.log10(bg_dist_pc)) * depth_scale,

  linear: (dist_pc, bg_dist_pc, depth_scale) =>
    -(dist_pc - bg_dist_pc) / bg_dist_pc * depth_scale,

};

// depth_scale = scene units per transform-unit.
// Matches the notebook formula: DEPTH_COEFF * IMG_W / 2
export function depthScale(cfg) {
  return cfg.depth_coeff * cfg.img_w / 2;
}

// Compute scene Z for one star.
// dist_pc = null means no Gaia parallax → placed behind background via no_parallax_dist_factor.
export function computeZ(dist_pc, cfg) {
  const scale = depthScale(cfg);
  const d     = (dist_pc != null) ? dist_pc : cfg.bg_dist_pc * cfg.no_parallax_dist_factor;
  const fn    = TRANSFORMS[cfg.transform] ?? TRANSFORMS.log10;
  return fn(d, cfg.bg_dist_pc, scale) + cfg.bg_z_scene;
}

// Perspective-correct XY for stars with known Gaia distance.
// Converts pixel offset to physical transverse distance (parsecs), computes the true
// line-of-sight distance to the background plane (d_at_bg, also in parsecs), then
// scales the pixel position by dist_pc / d_at_bg.
// Stars without parallax (dist_pc == null) are returned unchanged.
// cfg.pixel_scale_arcsec: arcsec per pixel from WCS astrometry solution.
export function computeXY(x_pix, y_pix, dist_pc, cfg) {
  if (dist_pc == null || cfg.xy_mode !== "corrected") return { x: x_pix, y: y_pix };
  const pixel_scale_rad = (cfg.pixel_scale_arcsec ?? 1.0) * (Math.PI / 648000);
  const d_pix    = Math.sqrt(x_pix * x_pix + y_pix * y_pix);
  const d_pix_pc = Math.tan(d_pix * pixel_scale_rad) * cfg.bg_dist_pc;
  const d_at_bg  = Math.sqrt(cfg.bg_dist_pc ** 2 + d_pix_pc ** 2);
  const scale    = dist_pc / d_at_bg;
  return { x: x_pix * scale, y: y_pix * scale };
}
