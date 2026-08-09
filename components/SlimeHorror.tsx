"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { Font, FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";

const FONT_URL = "/fonts/SlimeHorror-Regular.typeface.json";

// Large, soft, low-frequency blobs — not fine grain — so the surface reads
// as inflated slime rather than rough stone.
function createBumpTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 45; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const radius = 20 + Math.random() * 70;
    const raised = Math.random() > 0.4;

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, raised ? "#b0b0b0" : "#505050");
    gradient.addColorStop(1, "#808080");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2);
  return texture;
}

// A couple of bright "studio card" planes, captured into a cube render
// target and used as the material's envMap. Moving/rotating these — rather
// than moving a light — is what makes the highlight read as a reflection of
// something, with a shape and edge that follows the glossy surface.
function createReflectionEnvironment() {
  const environmentScene = new THREE.Scene();
  environmentScene.background = new THREE.Color("#0a0a0a");

  const reflectionGroup = new THREE.Group();
  environmentScene.add(reflectionGroup);

  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 0.15),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  strip.position.set(-1.5, 2, 2);
  strip.rotation.x = -0.3;
  reflectionGroup.add(strip);

  const wash = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  wash.position.set(2, -1, 2);
  wash.rotation.x = -0.2;
  reflectionGroup.add(wash);

  return { environmentScene, reflectionGroup, cards: [strip, wash] };
}

export interface SlimeHorrorProps {
  value: string;
  className?: string;
  color?: string;
}

export default function SlimeHorror({
  value,
  className,
  color = "#000000",
}: SlimeHorrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buildTextRef = useRef<((text: string) => void) | null>(null);
  const valueRef = useRef(value);
  const applyColorRef = useRef<((color: string) => void) | null>(null);
  const colorRef = useRef(color);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let animationId = 0;
    let renderRequested = false;
    let frameCount = 0;
    let font: Font | null = null;
    let mesh: THREE.Mesh | null = null;
    let backingMesh: THREE.Mesh | null = null;
    let textBoundsSize: THREE.Vector3 | null = null;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    camera.position.set(0, 0, 7);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = "block";
    container.appendChild(renderer.domElement);

    // Gentle baseline fill so the material still reads as its own color
    // away from the reflected highlight, instead of going flat black.
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x0a0a0a, 0.4);
    scene.add(hemiLight);

    const { environmentScene, reflectionGroup, cards } =
      createReflectionEnvironment();

    const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    cubeRenderTarget.texture.mapping = THREE.CubeReflectionMapping;
    const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeRenderTarget);

    const bumpTexture = createBumpTexture();

    const material = new THREE.MeshPhysicalMaterial({
      color: colorRef.current,
      metalness: 0,
      roughness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.015,
      ior: 1.48,
      specularIntensity: 1,
      specularColor: "#ffffff",
      envMap: cubeRenderTarget.texture,
      envMapIntensity: 1.8,
      bumpMap: bumpTexture,
      bumpScale: 0.12,
    });

    // The single source of truth for the text's color: both layers share
    // this one material, so updating it here updates them together.
    function applyColor(nextColor: string) {
      material.color.set(nextColor);
      requestRender();
    }
    applyColorRef.current = applyColor;

    // Fit the camera to both dimensions of the text, not just its height —
    // wide strings need the horizontal FOV (which narrows with aspect on
    // portrait viewports), not the vertical one. Re-run on resize too, since
    // the fit distance depends on the current aspect ratio.
    function frameCamera() {
      if (!textBoundsSize) return;
      const verticalFov = (camera.fov * Math.PI) / 180;
      const horizontalFov =
        2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
      const distanceForHeight =
        textBoundsSize.y / 2 / Math.tan(verticalFov / 2);
      const distanceForWidth =
        textBoundsSize.x / 2 / Math.tan(horizontalFov / 2);
      const fitDistance =
        Math.max(distanceForHeight, distanceForWidth) * 1.5;
      camera.position.z = Math.max(fitDistance, 3);
    }

    let hasCapturedEnvironment = false;
    const ROTATION_SETTLE_EPSILON = 0.0005;
    const pointerTarget = { x: 0, y: 0 };

    // Render on demand rather than in a permanent RAF loop: a frame is only
    // scheduled when something could actually look different (pointer
    // moved, resize, font finished loading, text changed). animate()
    // reschedules itself only while the reflection is still catching up to
    // the pointer; once settled it goes idle until requestRender() fires
    // again.
    function requestRender() {
      if (renderRequested) return;
      renderRequested = true;
      animationId = requestAnimationFrame(animate);
    }

    function animate() {
      renderRequested = false;

      const targetRotationY = pointerTarget.x * 0.7;
      const targetRotationX = -pointerTarget.y * 0.3;
      const deltaY = targetRotationY - reflectionGroup.rotation.y;
      const deltaX = targetRotationX - reflectionGroup.rotation.x;
      reflectionGroup.rotation.y += deltaY * 0.08;
      reflectionGroup.rotation.x += deltaX * 0.08;

      // The reflection probe only needs to be refreshed while the cards are
      // still moving — once the lerp settles near the pointer's target,
      // re-rendering all six cube faces every other frame is wasted work.
      const isMoving =
        Math.abs(deltaY) > ROTATION_SETTLE_EPSILON ||
        Math.abs(deltaX) > ROTATION_SETTLE_EPSILON;

      frameCount++;
      if (!hasCapturedEnvironment || (isMoving && frameCount % 2 === 0)) {
        cubeCamera.update(renderer, environmentScene);
        hasCapturedEnvironment = true;
      }

      renderer.render(scene, camera);

      if (isMoving) {
        requestRender();
      }
    }

    function buildText(text: string) {
      if (!font) return;
      requestRender();

      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh = null;
      }
      if (backingMesh) {
        scene.remove(backingMesh);
        backingMesh.geometry.dispose();
        backingMesh = null;
      }

      if (!text) return;

      const geometry = new TextGeometry(text, {
        font,
        size: 1,
        depth: 0.16,
        curveSegments: 20,
        bevelEnabled: true,
        bevelThickness: 0.12,
        bevelSize: 0.1,
        bevelOffset: -0.02,
        bevelSegments: 12,
      });

      // A flat-fronted duplicate with no bevel, naturally recessed behind
      // the beveled front layer (same extrusion depth, no bevel expansion
      // outward). Its own caps come straight from triangulating the glyph
      // outline with no offset-curve math involved, so there's no self-
      // intersection for it to inherit. If the front layer's bevel folds at
      // a tight concave notch and gets backface-culled there, the camera
      // ray falls through to this solid cap instead of the page
      // background. Real counters (the hole inside "A") stay open on both
      // layers, since both come from the same glyph outline.
      const backingGeometry = new TextGeometry(text, {
        font,
        size: 1,
        depth: 0.16,
        curveSegments: 20,
        bevelEnabled: false,
      });

      // Center both geometries on the *visible* geometry's bounds so they
      // share one coordinate frame — centering each independently would
      // offset them slightly, since the non-beveled outline's bounding box
      // isn't quite the same as the beveled one's.
      geometry.computeBoundingBox();
      const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
      geometry.translate(-center.x, -center.y, -center.z);
      backingGeometry.translate(-center.x, -center.y, -center.z);
      geometry.computeVertexNormals();
      backingGeometry.computeVertexNormals();

      mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      backingMesh = new THREE.Mesh(backingGeometry, material);
      scene.add(backingMesh);

      // Frame the camera to the visible text's own bounding box so the
      // shot stays well composed regardless of how long the rendered
      // string is.
      const box = new THREE.Box3().setFromObject(mesh);
      textBoundsSize = box.getSize(new THREE.Vector3());
      frameCamera();
    }
    buildTextRef.current = buildText;

    function resize() {
      if (!container) return;
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight);
      frameCamera();
      requestRender();
    }
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    function handlePointerMove(event: PointerEvent) {
      const rect = container!.getBoundingClientRect();
      pointerTarget.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerTarget.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      requestRender();
    }
    container.addEventListener("pointermove", handlePointerMove);

    const loader = new FontLoader();
    loader.load(
      FONT_URL,
      (loadedFont) => {
        if (!active) return;
        font = loadedFont;
        buildText(valueRef.current);
      },
      undefined,
      (error) => {
        console.error("Failed to load slime font", error);
      },
    );

    return () => {
      active = false;
      buildTextRef.current = null;
      applyColorRef.current = null;
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      container.removeEventListener("pointermove", handlePointerMove);

      mesh?.geometry.dispose();
      backingMesh?.geometry.dispose();
      material.dispose();
      bumpTexture.dispose();
      cubeRenderTarget.dispose();
      cards.forEach((card) => {
        card.geometry.dispose();
        (card.material as THREE.Material).dispose();
      });
      renderer.dispose();

      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  useEffect(() => {
    valueRef.current = value;
    buildTextRef.current?.(value);
  }, [value]);

  useEffect(() => {
    colorRef.current = color;
    applyColorRef.current?.(color);
  }, [color]);

  return (
    <div className={className}>
      <div ref={containerRef} className="h-full w-full" aria-hidden="true" />
      <span className="sr-only">{value}</span>
    </div>
  );
}
