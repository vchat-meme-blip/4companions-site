import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight,
  DirectionalLight, Clock, MathUtils, Quaternion, Vector3,
  QuaternionKeyframeTrack, AnimationMixer, SRGBColorSpace,
  LoopOnce, AnimationClip
} from 'https://unpkg.com/three@0.164.1/build/three.module.js?module';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js?module';
import { GLTFLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/GLTFLoader.js?module';
import { VRM, VRMUtils, VRMHumanBoneName, VRMLoaderPlugin }
  from 'https://unpkg.com/@pixiv/three-vrm@2.1.3/lib/three-vrm.module.js?module';

const defaultPose = new Map();
const gestureActions = new Map();

let renderer;
let scene;
let camera;
let controls;
let currentVRM;
let mixer;
let gestureLock = false;
let idleTimer = 0;
let baseIdleY = 0;
let baseIdleRotZ = 0;

const clock = new Clock();

document.addEventListener('DOMContentLoaded', () => {
  setupRevealObserver();
  initialiseMockModal();
  initialiseHeroCanvas();
});

function setupRevealObserver() {
  const revealElements = document.querySelectorAll('.reveal');
  if (!revealElements.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });

  revealElements.forEach((element) => observer.observe(element));
}

function initialiseMockModal() {
  const previewButton = document.querySelector('.mock-preview');
  const modal = document.getElementById('mockPreviewModal');
  if (!previewButton || !modal) return;

  const dismissElements = modal.querySelectorAll('[data-dismiss]');

  const openModal = () => {
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    modal.focus();
  };

  const closeModal = () => {
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    previewButton.focus();
  };

  previewButton.addEventListener('click', openModal);
  dismissElements.forEach((el) => el.addEventListener('click', closeModal));

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal();
    }
  });
}

function initialiseHeroCanvas() {
  const canvas = document.getElementById('heroCanvas');
  if (!canvas) return;

  if (!window.WebGLRenderingContext) {
    canvas.parentElement?.classList.add('hero-stage--fallback');
    return;
  }

  renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  scene = new Scene();
  scene.background = null;

  camera = new PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20);
  camera.position.set(0.4, 1.5, 3.6);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.7;
  controls.target.set(0, 1.3, 0);

  addLighting();
  attachGestureHandlers();
  loadHeroVRM();
  window.addEventListener('resize', handleResize);
  animate();
}

function addLighting() {
  const hemiLight = new HemisphereLight(0xfaffff, 0x0a1214, 0.9);
  scene.add(hemiLight);

  const keyLight = new DirectionalLight(0xfff4c0, 1.15);
  keyLight.position.set(1.6, 2.2, 1.4);
  scene.add(keyLight);

  const rimLight = new DirectionalLight(0x59ffe0, 0.95);
  rimLight.position.set(-1.2, 1.6, -1.5);
  scene.add(rimLight);
}

function loadHeroVRM() {
  const gestureButtons = document.querySelectorAll('.gesture-toolbar button');
  gestureButtons.forEach((btn) => {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  });

  const loader = new GLTFLoader();
  loader.crossOrigin = 'anonymous';
  loader.register((parser) => new VRMLoaderPlugin(parser));

  loader.load(
    'assets/models/charizard.vrm',
    (gltf) => {
      const vrm = gltf.userData?.vrm;
      if (!vrm) {
        console.warn('[Landing] No VRM data found in GLTF.');
        gestureButtons.forEach((btn) => btn.setAttribute('disabled', 'true'));
        return;
      }

      if (currentVRM) {
        scene.remove(currentVRM.scene);
        currentVRM.dispose();
      }

      currentVRM = vrm;
      VRMUtils.removeUnnecessaryJoints(currentVRM.scene);
      VRMUtils.removeUnnecessaryVertices(currentVRM.scene);
      VRMUtils.rotateVRM0(gltf);

      currentVRM.scene.rotation.y = Math.PI;
      currentVRM.scene.position.set(0, 0.35, 0);
      currentVRM.scene.traverse((obj) => {
        obj.frustumCulled = false;
      });

      mixer?.stopAllAction();
      mixer = new AnimationMixer(currentVRM.scene);
      gestureActions.clear();

      idleTimer = 0;
      baseIdleY = currentVRM.scene.position.y;
      baseIdleRotZ = currentVRM.scene.rotation.z;

      scene.add(currentVRM.scene);
      captureDefaultPose();
      setupIdleBaseline();
      setupGestureAnimations();

      gestureButtons.forEach((btn) => {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      });
    },
    undefined,
    (error) => {
      console.warn('[Landing] Failed to load VRM:', error);
      gestureButtons.forEach((btn) => btn.setAttribute('disabled', 'true'));
    }
  );
}

function captureDefaultPose() {
  defaultPose.clear();
  const trackedBones = [
    VRMHumanBoneName.Hips,
    VRMHumanBoneName.Spine,
    VRMHumanBoneName.Neck,
    VRMHumanBoneName.Head,
    VRMHumanBoneName.RightUpperArm,
    VRMHumanBoneName.RightLowerArm,
    VRMHumanBoneName.RightHand,
    VRMHumanBoneName.LeftUpperArm,
    VRMHumanBoneName.LeftLowerArm,
    VRMHumanBoneName.LeftHand,
  ];

  trackedBones.forEach((boneName) => {
    const bone = getBone(boneName);
    if (bone) {
      defaultPose.set(boneName, bone.quaternion.clone());
    }
  });
}

function setupIdleBaseline() {
  idleTimer = 0;
  baseIdleY = currentVRM.scene.position.y;
  baseIdleRotZ = currentVRM.scene.rotation.z;
}

function setupGestureAnimations() {
  const wave = createGestureClip('LandingWave', [
    { bone: VRMHumanBoneName.RightUpperArm, axis: 'z', degrees: -50 },
    { bone: VRMHumanBoneName.RightLowerArm, axis: 'z', degrees: -65 },
    { bone: VRMHumanBoneName.RightHand, axis: 'z', degrees: -30 },
  ]);
  if (wave) gestureActions.set('wave', wave);

  const nod = createGestureClip('LandingNod', [
    { bone: VRMHumanBoneName.Head, axis: 'x', degrees: -20 },
    { bone: VRMHumanBoneName.Spine, axis: 'x', degrees: -8 },
  ]);
  if (nod) gestureActions.set('nod', nod);

  const hype = createGestureClip('LandingHype', [
    { bone: VRMHumanBoneName.RightUpperArm, axis: 'x', degrees: -60 },
    { bone: VRMHumanBoneName.LeftUpperArm, axis: 'x', degrees: -60 },
    { bone: VRMHumanBoneName.RightLowerArm, axis: 'x', degrees: -20 },
    { bone: VRMHumanBoneName.LeftLowerArm, axis: 'x', degrees: -20 },
  ], 1.6);
  if (hype) gestureActions.set('hype', hype);
}

function createGestureClip(name, entries, duration = 1.4) {
  if (!currentVRM || !mixer) return null;
  const tracks = entries
    .map(({ bone, axis, degrees }) => {
      const node = getBone(bone);
      if (!node) return null;

      const baseQuat = (defaultPose.get(bone) ?? node.quaternion).clone();
      const axisVector = axisToVector(axis);
      const deltaQuat = new Quaternion().setFromAxisAngle(axisVector, MathUtils.degToRad(degrees));
      const targetQuat = baseQuat.clone().multiply(deltaQuat);

      return new QuaternionKeyframeTrack(
        `${node.uuid}.quaternion`,
        [0, duration * 0.6, duration],
        [
          baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w,
          targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w,
          baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w,
        ],
      );
    })
    .filter(Boolean);

  if (!tracks.length) return null;

  const clip = new AnimationClip(name, duration, tracks);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.enabled = true;
  action.weight = 1;
  return action;
}

function axisToVector(axis) {
  switch (axis) {
    case 'x':
      return new Vector3(1, 0, 0);
    case 'y':
      return new Vector3(0, 1, 0);
    default:
      return new Vector3(0, 0, 1);
  }
}

function attachGestureHandlers() {
  const buttons = document.querySelectorAll('.gesture-toolbar button');
  if (!buttons.length) return;

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const gesture = button.dataset.gesture;
      if (gesture) {
        triggerGesture(gesture).catch((err) => console.warn('[Landing] Gesture error', err));
      }
    });
  });
}

async function triggerGesture(name) {
  if (!currentVRM || !mixer) return;
  if (gestureLock) return;

  const action = gestureActions.get(name);
  if (!action) return;

  gestureLock = true;

  gestureActions.forEach((otherAction, key) => {
    if (!otherAction || key === name) return;
    otherAction.stop();
  });

  action.reset();
  action.fadeIn(0.2).play();

  await new Promise((resolve) => {
    const onFinished = (event) => {
      if (event.action === action) {
        mixer.removeEventListener('finished', onFinished);
        action.fadeOut(0.25);
        resolve();
      }
    };

    mixer.addEventListener('finished', onFinished);

    const timeout = setTimeout(() => {
      mixer.removeEventListener('finished', onFinished);
      action.fadeOut(0.25);
      resolve();
    }, action.getClip().duration * 1000 + 400);

    action.getClip().userData = { timeout };
  });

  gestureLock = false;
}

function animate() {
  requestAnimationFrame(animate);
  resizeRendererToDisplaySize();
  const delta = clock.getDelta();

  controls?.update();

  if (currentVRM) {
    currentVRM.update(delta);
    mixer?.update(delta);
    applyIdleMotion(delta);
  }

  renderer?.render(scene, camera);
}

function applyIdleMotion(delta) {
  if (!currentVRM) return;
  idleTimer += delta;
  const floatOffset = Math.sin(idleTimer * 1.2) * 0.025;
  const sway = Math.sin(idleTimer * 0.85) * MathUtils.degToRad(1.4);

  currentVRM.scene.position.y = baseIdleY + floatOffset;
  currentVRM.scene.rotation.z = baseIdleRotZ + sway;
}

function handleResize() {
  if (!renderer || !camera) return;
  const canvas = renderer.domElement;
  const { clientWidth, clientHeight } = canvas;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}

function resizeRendererToDisplaySize() {
  if (!renderer || !camera) return;
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function getBone(boneName) {
  return currentVRM?.humanoid?.getBoneNode(boneName) ?? null;
}
