# Three.js Looking Glass Scene

This directory contains the browser-based 3D renderer for the astronomical hologram project. It uses Three.js for the scene and the Looking Glass WebXR integration to render a multi-view quilt for a Looking Glass display.

This document explains how scene depth relates to holographic sharpness. It is intended to be understandable without prior knowledge of the project or of light-field displays.

## How a Looking Glass display creates depth

A conventional screen shows one image. A Looking Glass display shows many slightly different views at the same time and directs them toward different horizontal viewing angles. As the viewer moves, each eye receives an appropriate view, producing binocular disparity and motion parallax without a headset.

The application first renders these views into a **quilt**: a large texture containing a grid of small camera images. The device calibration and Looking Glass runtime then interlace the quilt for the display optics.

The virtual cameras are arranged as an off-axis camera array. They point through a common **focal plane** (also called the zero-parallax plane):

- A point on the focal plane appears at the same horizontal position in every view.
- A point in front of or behind the plane moves horizontally between views.
- Greater distance from the focal plane produces greater view-to-view displacement and therefore stronger perceived depth.

This focal plane is the most stable and sharp part of the holographic volume. The complete camera volume is not uniformly sharp.

## Why holographic depth affects sharpness

Depth on a Looking Glass is produced by parallax. That same parallax limits sharpness. When an object is far from the focal plane, its copies occupy increasingly different positions in adjacent quilt views. The display optics and view filtering combine nearby views, so excessive displacement can appear as horizontal broadening, ghosting, or duplicated edges.

This effect is especially visible for astronomical point sources:

- Stars are small, bright, high-contrast features and reveal sub-pixel misalignment quickly.
- Nebulae are smoother, lower-frequency structures and can tolerate more displacement before looking visibly blurred.
- Making a star sprite smaller can reduce the apparent halo, but it does not reduce the geometric disparity of its center.

Holographic sharpness is therefore not ordinary photographic depth of field. It is mainly a function of multi-view disparity, quilt resolution, view filtering, display calibration, and the object's signed distance from the focal plane.

## Depth controls

The main Looking Glass quantities that determine the useful depth range are:

- **Focal plane / target** — the plane of zero disparity and maximum stability.
- **Depthiness** — scales the angular spread of the view array. Increasing it strengthens parallax but narrows the sharp depth range.
- **Field of view** — together with the scene diameter, determines camera distance and perspective.
- **Target diameter** — defines the scene scale used by the Looking Glass camera.
- **View cone and view count** — device-calibrated properties that determine angular separation between quilt views.

`depthiness` changes the view-array separation without changing the central framing. It should be treated as a depth-versus-sharpness control, not as a zoom control.

## Calibrated configuration used for this project

The following values were read from the local Looking Glass Go calibration and the current renderer configuration:

| Property | Value |
| --- | ---: |
| Device | Looking Glass Go Portrait |
| Physical panel | 1440 x 2560 pixels |
| Quilt texture | 4092 x 4092 pixels |
| Quilt layout | 11 columns x 6 rows |
| Number of views | 66 |
| Approximate tile size | 372 x 682 pixels per view |
| Calibrated view cone | 54 degrees |
| Scene target diameter | 2800 scene units |
| Looking Glass vertical FOV | 0.19 radians |
| Derived camera distance | approximately 14692 scene units |
| View filter | two-view filtering |

These numbers are device- and configuration-specific. A different Looking Glass model, quilt preset, FOV, target diameter, or filter mode changes the numerical ranges below.

## Defining a practical sharp range

There is no perfectly binary boundary between sharp and blurred. For this project, a useful engineering definition is based on the horizontal displacement of a point between adjacent quilt views:

- **Strict point-source range:** no more than 0.5 tile pixel of adjacent-view displacement. This is appropriate for Gaia stars and other compact, high-contrast sources.
- **Extended-source range:** no more than 1 tile pixel. This is a reasonable perceptual allowance for smooth nebular structure.

For a point at signed local depth `z` relative to the focal plane, the central adjacent-view displacement can be estimated by:

```text
pixel disparity = tileWidth * deltaF * abs(z)
                  ------------------------------------------
                  2 * aspect * tan(FOV / 2) * (distance - z)

deltaF = 2 * tan((viewCone * depthiness) / (2 * viewCount))
```

Positive `z` is toward the camera. For points behind the focal plane, `z` is negative and the denominator naturally becomes larger. This perspective term makes the front and rear limits slightly asymmetric.

## Strict sharp-depth ranges

Using the calibrated values above and the 0.5-pixel point-source criterion gives:

| Depthiness | Behind focal plane | In front of focal plane | Total sharp thickness |
| ---: | ---: | ---: | ---: |
| 0.25 | -618 | +570 | 1188 |
| 0.50 | -303 | +291 | 593 |
| 0.75 | -200 | +195 | 395 |
| 1.00 | -150 | +147 | 297 |
| 1.25 | -120 | +118 | 237 |
| 1.50 | -100 | +98 | 198 |
| 2.00 | -75 | +74 | 148 |

All values are in scene units measured along the current Looking Glass viewing direction.

## Extended-source ranges

Using the more permissive 1-pixel criterion for smooth nebular content gives:

| Depthiness | Behind focal plane | In front of focal plane | Total acceptable thickness |
| ---: | ---: | ---: | ---: |
| 0.25 | -1290 | +1097 | 2388 |
| 0.50 | -618 | +570 | 1188 |
| 0.75 | -406 | +385 | 791 |
| 1.00 | -303 | +291 | 593 |
| 1.25 | -241 | +233 | 475 |
| 1.50 | -200 | +195 | 395 |
| 2.00 | -150 | +147 | 297 |

The extended-source table should not be used to judge star sharpness. A nebula can remain visually continuous at a depth where point sources already show horizontal ghosting.

## Current astronomical scene coverage

For the currently exported Gaia-star and nebula depth distributions, the strict 0.5-pixel range contains approximately:

| Depthiness | Gaia stars in strict range | Nebula pixels in strict range |
| ---: | ---: | ---: |
| 0.50 | 100% | 100% |
| 0.75 | 99.3% | 100% |
| 1.00 | 95.6% | 99.9% |
| 1.25 | 89.4% | 99.4% |
| 1.50 | 80.3% | 98.9% |
| 2.00 | 63.2% | 97.3% |

This difference is expected: the nebula distribution is concentrated near its central surface, while the catalog stars occupy a wider depth interval.

## Coordinate-system requirement

The relevant depth is not necessarily the object's Three.js world `z` coordinate. It is the signed distance from the current focal plane along the current Looking Glass camera direction:

```text
localDepth = dot(objectPosition - focalTarget, cameraForward)
```

The sharp-range tables apply to `localDepth`. When the Looking Glass view rotates, the focal plane rotates as well. A geometrically flat object can therefore span a large local-depth interval even if all of its vertices have the same world `z` value.

For example, a 3000-unit-wide plane rotated about one axis produces an approximate depth half-range of:

| Plane tilt | Additional depth half-range |
| ---: | ---: |
| 5 degrees | about 131 units |
| 10 degrees | about 260 units |
| 20 degrees | about 513 units |

At `depthiness = 1.0`, the strict point-source range is only about -150 to +147 units. A modest plane tilt can therefore become the dominant source of off-focus disparity.

## Recommended operating ranges

For this scene and device:

- **Maximum point-source sharpness:** use `depthiness = 0.5`.
- **Balanced astronomical presentation:** use approximately `0.7-0.8`; `0.75` is a strong general-purpose value.
- **Stronger holographic depth:** use `1.0`, accepting some loss of sharpness in the most distant stars.
- **Deliberately exaggerated depth:** values above `1.25` should be used with care for sparse, high-contrast star fields.

The most important content should remain near the focal plane. The visible scene may extend beyond the strict range, but high-contrast points outside it should be expected to broaden or ghost before smooth nebular structures do.

## Limits of the calculation

The ranges in this document are geometric engineering thresholds, not measurements of the display's complete optical point-spread function. Perceived sharpness also depends on:

- optical crosstalk and the individual display calibration;
- viewer position and eye tracking or viewing zone;
- fullscreen state, browser scaling, and operating-system display scaling;
- quilt interpolation and filtering;
- source brightness, contrast, sprite size, and additive blending;
- the spatial frequency of the rendered content.

The Looking Glass calibration does not expose a complete optical modulation-transfer function, so an absolute perceptual cutoff cannot be derived from the API alone. Final presentation settings should be validated on the physical display, while the ranges above provide a consistent basis for scene design.

## References

- [Looking Glass camera and focal-plane concepts](https://lfdocs.lookingglassfactory.com/keyconcepts/camera)
- [Looking Glass quilt format](https://lfdocs.lookingglassfactory.com/keyconcepts/quilts)
- [Hologram Camera capture volume and focal plane](https://lfdocs.lookingglassfactory.com/software/index/prefabs/hologram-camera)
- [Looking Glass post-processing and focal distance](https://lfdocs.lookingglassfactory.com/software/index/package-integrations/post-processing)

