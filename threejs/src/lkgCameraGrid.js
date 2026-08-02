import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const COLORS = {
  rail: 0x55d9ff, left: 0x35d6cf, center: 0xf2f6ff,
  right: 0xffa45b, focal: 0xc884ff, volume: 0x67e59a, depth: 0xf2d070,
};

function formatValue(value) {
  const abs = Math.abs(value);
  if (abs >= 100000) return value.toExponential(2);
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return Number(value.toFixed(2)).toString();
}

function rotationFromConfig(config) {
  const y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), config.trackballX);
  const x = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -config.trackballY);
  return y.multiply(x);
}

function disposeGroup(group) {
  group.traverse(child => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
    else child.material?.dispose();
  });
  group.clear();
}

export function buildLkgCameraGrid(config, sourceCamera, labelLayer) {
  const group = new THREE.Group();
  group.name = "looking-glass-camera-field";
  group.renderOrder = 40;
  const lineMaterials = new Set();
  let labels = [];
  let enabled = false;
  let xrPresenting = false;
  let rebuildFrame = 0;
  let cameraDistance = 0;
  const resolution = new THREE.Vector2(1, 1);

  function addLine(points, color, width = 1.8, opacity = 0.72) {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap(point => [point.x, point.y, point.z]));
    const material = new LineMaterial({
      color, linewidth: width, transparent: true, opacity,
      depthWrite: false, alphaToCoverage: true,
    });
    material.resolution.copy(resolution);
    lineMaterials.add(material);
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    group.add(line);
  }

  function addRectangle(corners, color, width = 1.8, opacity = 0.65) {
    addLine([...corners, corners[0]], color, width, opacity);
  }

  function addLabel(text, color, point) {
    if (!labelLayer) return;
    const element = document.createElement("span");
    element.className = "lkg-camera-label";
    element.textContent = text;
    element.style.color = color;
    labelLayer.appendChild(element);
    labels.push({ element, point });
  }

  function rebuild() {
    lineMaterials.clear();
    disposeGroup(group);
    labelLayer?.replaceChildren();
    labels = [];

    const diameter = Math.max(0.001, Number(config.targetDiam));
    const fovy = THREE.MathUtils.clamp(Number(config.fovy), 0.001, Math.PI - 0.001);
    const tanHalfFov = Math.tan(fovy * 0.5);
    cameraDistance = 0.5 * diameter / tanHalfFov;
    const aspect = Number(config.aspect) || 1;
    const viewCone = Number(config.viewCone) || 0;
    const viewCount = Math.max(1, Math.round(Number(config.numViews) || 1));
    const nearZ = diameter - sourceCamera.near;
    const farZ = diameter - sourceCamera.far;
    const focalHalfHeight = diameter * 0.5;
    const focalHalfWidth = focalHalfHeight * aspect;

    group.position.set(config.targetX, config.targetY, config.targetZ);
    group.quaternion.copy(rotationFromConfig(config));

    const offsets = Array.from({ length: viewCount }, (_, index) => {
      const fraction = (index + 0.5) / viewCount - 0.5;
      return cameraDistance * Math.tan(viewCone * fraction);
    });
    const centerIndex = Math.floor((viewCount - 1) * 0.5);

    addLine([
      new THREE.Vector3(offsets[0], 0, cameraDistance),
      new THREE.Vector3(offsets.at(-1), 0, cameraDistance),
    ], COLORS.rail, 3, 0.95);

    const markerRadius = Math.max(diameter * 0.008, 4);
    const markers = new THREE.InstancedMesh(
      new THREE.SphereGeometry(markerRadius, 10, 7),
      new THREE.MeshBasicMaterial({ color: COLORS.rail, depthWrite: false }),
      viewCount,
    );
    const markerMatrix = new THREE.Matrix4();
    offsets.forEach((offset, index) => {
      markerMatrix.makeTranslation(offset, 0, cameraDistance);
      markers.setMatrixAt(index, markerMatrix);
    });
    markers.instanceMatrix.needsUpdate = true;
    markers.renderOrder = 42;
    group.add(markers);

    const focalCorners = [
      new THREE.Vector3(-focalHalfWidth, -focalHalfHeight, 0),
      new THREE.Vector3(focalHalfWidth, -focalHalfHeight, 0),
      new THREE.Vector3(focalHalfWidth, focalHalfHeight, 0),
      new THREE.Vector3(-focalHalfWidth, focalHalfHeight, 0),
    ];
    const focalPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(focalHalfWidth * 2, focalHalfHeight * 2),
      new THREE.MeshBasicMaterial({
        color: COLORS.focal, transparent: true, opacity: 0.075,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    focalPlane.renderOrder = 38;
    group.add(focalPlane);
    addRectangle(focalCorners, COLORS.focal, 3, 0.95);

    const selected = [
      { index: 0, color: COLORS.left },
      { index: centerIndex, color: COLORS.center },
      { index: viewCount - 1, color: COLORS.right },
    ];
    for (const { index, color } of selected) {
      const cameraPoint = new THREE.Vector3(offsets[index], 0, cameraDistance);
      for (const corner of focalCorners) addLine([cameraPoint, corner], color, 1.3, 0.38);
      addLine([
        cameraPoint,
        new THREE.Vector3(offsets[index], 0, cameraDistance - diameter * 0.3),
      ], color, 2.4, 0.9);
      const arrowHead = new THREE.Mesh(
        new THREE.ConeGeometry(markerRadius * 0.75, markerRadius * 2.2, 10),
        new THREE.MeshBasicMaterial({ color, depthWrite: false }),
      );
      arrowHead.rotation.x = -Math.PI * 0.5;
      arrowHead.position.set(offsets[index], 0, cameraDistance - diameter * 0.3);
      arrowHead.renderOrder = 42;
      group.add(arrowHead);
    }

    const envelopeCornersAt = z => {
      const distance = cameraDistance - z;
      const halfHeight = Math.max(0.001, distance * tanHalfFov);
      const halfWidth = halfHeight * aspect;
      const leftCenter = offsets[0] * z / cameraDistance;
      const rightCenter = offsets.at(-1) * z / cameraDistance;
      return [
        new THREE.Vector3(Math.min(leftCenter, rightCenter) - halfWidth, -halfHeight, z),
        new THREE.Vector3(Math.max(leftCenter, rightCenter) + halfWidth, -halfHeight, z),
        new THREE.Vector3(Math.max(leftCenter, rightCenter) + halfWidth, halfHeight, z),
        new THREE.Vector3(Math.min(leftCenter, rightCenter) - halfWidth, halfHeight, z),
      ];
    };
    const nearCorners = envelopeCornersAt(nearZ);
    const farCorners = envelopeCornersAt(farZ);
    addRectangle(nearCorners, COLORS.volume, 2.2, 0.8);
    addRectangle(farCorners, COLORS.volume, 2.2, 0.5);
    for (let i = 0; i < 4; i++) addLine([nearCorners[i], farCorners[i]], COLORS.volume, 1.5, 0.32);

    addLine([
      new THREE.Vector3(0, 0, cameraDistance),
      new THREE.Vector3(0, 0, farZ),
    ], COLORS.depth, 2.2, 0.72);
    const tickHalf = diameter * 0.075;
    for (const z of [nearZ, 0, farZ]) {
      addLine([
        new THREE.Vector3(-tickHalf, 0, z),
        new THREE.Vector3(tickHalf, 0, z),
      ], z === 0 ? COLORS.focal : COLORS.depth, 2.4, 0.9);
    }

    addLabel("Left view", "#54e5dd", new THREE.Vector3(offsets[0], markerRadius * 2.5, cameraDistance));
    addLabel(`${viewCount} LKG views`, "#dbeeff", new THREE.Vector3(offsets[centerIndex], markerRadius * 3.5, cameraDistance));
    addLabel("Right view", "#ffb774", new THREE.Vector3(offsets.at(-1), markerRadius * 2.5, cameraDistance));
    addLabel("Focal plane · zero parallax", "#d7a4ff", new THREE.Vector3(0, focalHalfHeight * 1.08, 0));
    addLabel(`Near · ${formatValue(nearZ)} from focal`, "#82efab", new THREE.Vector3(0, tickHalf * 1.4, nearZ));
    addLabel(`Far · ${formatValue(farZ)} from focal`, "#82efab", new THREE.Vector3(0, tickHalf * 1.4, farZ));
    addLabel(
      `camera distance ${formatValue(cameraDistance)} · cone ${THREE.MathUtils.radToDeg(viewCone).toFixed(1)}°`,
      "#f2d070", new THREE.Vector3(0, -tickHalf * 1.6, cameraDistance),
    );
    group.visible = enabled && !xrPresenting;
  }

  function scheduleRebuild() {
    if (rebuildFrame) return;
    rebuildFrame = requestAnimationFrame(() => {
      rebuildFrame = 0;
      rebuild();
    });
  }

  function setVisible(value) {
    enabled = value;
    group.visible = enabled && !xrPresenting;
    if (labelLayer) labelLayer.style.display = group.visible ? "block" : "none";
  }

  function setXrPresenting(value) {
    xrPresenting = value;
    group.visible = enabled && !xrPresenting;
    if (labelLayer) labelLayer.style.display = group.visible ? "block" : "none";
  }

  function updateLabels(camera, renderer) {
    const visible = enabled && !xrPresenting && !renderer.xr.isPresenting;
    if (labelLayer) labelLayer.style.display = visible ? "block" : "none";
    if (!visible || !labelLayer) return;
    const rect = renderer.domElement.getBoundingClientRect();
    camera.updateMatrixWorld();
    group.updateMatrixWorld(true);
    for (const label of labels) {
      const world = label.point.clone().applyMatrix4(group.matrixWorld);
      const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
      if (view.z >= 0) {
        label.element.style.display = "none";
        continue;
      }
      const ndc = world.project(camera);
      if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 1.08 || Math.abs(ndc.y) > 1.08) {
        label.element.style.display = "none";
        continue;
      }
      label.element.style.display = "block";
      label.element.style.left = `${rect.left + (ndc.x * 0.5 + 0.5) * rect.width}px`;
      label.element.style.top = `${rect.top + (-ndc.y * 0.5 + 0.5) * rect.height}px`;
    }
  }

  function setResolution(width, height) {
    resolution.set(width, height);
    for (const material of lineMaterials) material.resolution.set(width, height);
  }

  config.addEventListener("on-config-changed", scheduleRebuild);
  rebuild();
  return {
    group,
    get cameraDistance() { return cameraDistance; },
    setVisible, setXrPresenting, setResolution, updateLabels,
  };
}
