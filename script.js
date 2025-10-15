import {
  WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight,
  DirectionalLight, Clock, MathUtils, Quaternion, Vector3,
  QuaternionKeyframeTrack, AnimationMixer, SRGBColorSpace,
  LoopOnce, LoopRepeat, AnimationClip
} from 'https://unpkg.com/three@0.164.1/build/three.module.js?module';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js?module';
import { GLTFLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/GLTFLoader.js?module';
import { VRM, VRMUtils, VRMHumanBoneName, VRMLoaderPlugin }
  from 'https://unpkg.com/@pixiv/three-vrm@2.1.3/lib/three-vrm.module.js?module';

const animationClipCache = new Map();
let animationModulePromise = null;

const idleClipSources = {
  idle_loop: 'assets/animations/idle_loop.vrma',
  gesture_fight: 'assets/animations/gesture_fight.vrma',
  gesture_powerful: 'assets/animations/gesture_powerful.vrma',
};

const defaultPose = new Map();
const gestureActions = new Map();

let renderer;
let scene;
let camera;
let controls;
let currentVRM;
let mixer;
let gestureLock = false;
let idleAction;
let idleLoadNonce = 0;
let idleTimer = 0;
let baseIdleY = 0;
let baseIdleRotZ = 0;
let currentIdleKey = 'idle_loop';

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
  attachIdleHandlers();
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

      idleAction?.stop();
      idleAction = null;

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
      setupIdleAnimation(currentIdleKey);

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

async function setupIdleAnimation(targetKey = currentIdleKey) {
  if (!mixer) {
    currentIdleKey = targetKey;
    return;
  }

  const source = idleClipSources[targetKey];
  if (!source) {
    console.warn('[Landing] Unknown idle animation key:', targetKey);
    return;
  }

  currentIdleKey = targetKey;
  idleLoadNonce += 1;
  const loadNonce = idleLoadNonce;

  if (!currentVRM) {
    return;
  }

  try {
    const clip = await loadVRMAnimation(source, currentVRM);
    if (!clip || loadNonce !== idleLoadNonce) return;

    idleAction?.stop();
    idleAction = mixer.clipAction(clip);
    idleAction.reset();
    idleAction.setLoop(LoopRepeat, Infinity);
    idleAction.fadeIn(0.35).play();
  } catch (error) {
    if (loadNonce === idleLoadNonce) {
      console.warn('[Landing] Idle animation load failed:', error);
    }
  }
}

function setupGestureAnimations() {
  const wave = createGestureClip('LandingWave', [
    {
      bone: VRMHumanBoneName.RightUpperArm,
      keyframes: [
        { at: 0.18, axis: 'x', degrees: -24 },
        { at: 0.46, axis: 'x', degrees: -32 },
        { at: 0.74, axis: 'x', degrees: -20 },
      ],
    },
    {
      bone: VRMHumanBoneName.RightLowerArm,
      keyframes: [
        { at: 0.2, axis: 'z', degrees: -48 },
        { at: 0.38, axis: 'z', degrees: 32 },
        { at: 0.56, axis: 'z', degrees: -36 },
        { at: 0.74, axis: 'z', degrees: 24 },
      ],
    },
    {
      bone: VRMHumanBoneName.RightHand,
      keyframes: [
        { at: 0.22, axis: 'y', degrees: 28 },
        { at: 0.4, axis: 'y', degrees: -28 },
        { at: 0.58, axis: 'y', degrees: 26 },
        { at: 0.76, axis: 'y', degrees: -18 },
      ],
    },
    {
      bone: VRMHumanBoneName.RightHand,
      keyframes: [
        { at: 0.26, axis: 'x', degrees: 10 },
        { at: 0.54, axis: 'x', degrees: -8 },
      ],
    },
    {
      bone: VRMHumanBoneName.LeftHand,
      keyframes: [
        { at: 0.2, axis: 'x', degrees: 6 },
        { at: 0.6, axis: 'x', degrees: -4 },
      ],
    },
  ], 1.6);
  if (wave) gestureActions.set('wave', wave);

  const nod = createGestureClip('LandingNod', [
    { bone: VRMHumanBoneName.Head, axis: 'x', degrees: -20 },
    { bone: VRMHumanBoneName.Spine, axis: 'x', degrees: -8 },
  ]);
  if (nod) gestureActions.set('nod', nod);

  const hype = createGestureClip('LandingHype', [
    {
      bone: VRMHumanBoneName.RightUpperArm,
      keyframes: [
        { at: 0.18, axis: ['x', 'z'], degrees: -36 },
        { at: 0.42, axis: ['x', 'z'], degrees: -18 },
        { at: 0.68, axis: ['x', 'z'], degrees: -40 },
      ],
    },
    {
      bone: VRMHumanBoneName.RightLowerArm,
      keyframes: [
        { at: 0.2, axis: 'z', degrees: -30 },
        { at: 0.46, axis: 'z', degrees: 24 },
        { at: 0.7, axis: 'z', degrees: -34 },
      ],
    },
    {
      bone: VRMHumanBoneName.RightHand,
      keyframes: [
        { at: 0.22, axis: 'y', degrees: 18 },
        { at: 0.5, axis: 'y', degrees: -14 },
        { at: 0.74, axis: 'y', degrees: 16 },
      ],
    },
    {
      bone: VRMHumanBoneName.LeftUpperArm,
      keyframes: [
        { at: 0.2, axis: ['x', 'z'], degrees: -26 },
        { at: 0.48, axis: ['x', 'z'], degrees: -12 },
        { at: 0.76, axis: ['x', 'z'], degrees: -30 },
      ],
    },
    {
      bone: VRMHumanBoneName.LeftLowerArm,
      keyframes: [
        { at: 0.24, axis: 'z', degrees: 18 },
        { at: 0.52, axis: 'z', degrees: -22 },
        { at: 0.8, axis: 'z', degrees: 16 },
      ],
    },
    {
      bone: VRMHumanBoneName.LeftHand,
      keyframes: [
        { at: 0.28, axis: 'y', degrees: -16 },
        { at: 0.56, axis: 'y', degrees: 12 },
        { at: 0.82, axis: 'y', degrees: -14 },
      ],
    },
  ], 1.9);
  if (hype) gestureActions.set('hype', hype);
}

function createGestureClip(name, entries, duration = 1.4) {
  if (!currentVRM || !mixer) return null;

  const tracks = entries
    .map((entry) => {
      const node = getBone(entry.bone);
      if (!node) return null;

      const baseQuat = (defaultPose.get(entry.bone) ?? node.quaternion).clone();
      const frames = Array.isArray(entry.keyframes) && entry.keyframes.length
        ? entry.keyframes
        : (entry.axis !== undefined && entry.degrees !== undefined)
          ? [{ at: 0.6, axis: entry.axis, degrees: entry.degrees }]
          : [];

      if (!frames.length) return null;

      const times = [0];
      const values = [baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w];
      let workingQuat = baseQuat.clone();
      let lastNormalizedTime = 0.02;

      frames.forEach((frame, index) => {
        const totalFrames = frames.length;
        const normalized = frame.time ?? frame.at ?? ((index + 1) / (totalFrames + 1));
        const clamped = Math.min(0.95, Math.max(lastNormalizedTime + 0.03, normalized));
        const absoluteTime = duration * clamped;
        lastNormalizedTime = clamped;

        const axisVector = resolveAxisVector(frame.axis ?? entry.axis, frame.axisVector);
        const angleRad = MathUtils.degToRad(frame.degrees ?? entry.degrees ?? 0);
        const deltaQuat = new Quaternion().setFromAxisAngle(axisVector, angleRad);
        workingQuat = workingQuat.clone().multiply(deltaQuat);

        times.push(absoluteTime);
        values.push(workingQuat.x, workingQuat.y, workingQuat.z, workingQuat.w);
      });

      times.push(duration);
      values.push(baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w);

      return new QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, values);
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

function resolveAxisVector(axis, axisVectorOverride) {
  if (axisVectorOverride) {
    const vector = new Vector3(
      axisVectorOverride.x ?? axisVectorOverride[0] ?? 0,
      axisVectorOverride.y ?? axisVectorOverride[1] ?? 0,
      axisVectorOverride.z ?? axisVectorOverride[2] ?? 0,
    );
    if (vector.lengthSq() > 0) {
      return vector.normalize();
    }
  }

  if (Array.isArray(axis)) {
    const composite = axis.reduce((acc, component) => acc.add(axisToVector(component)), new Vector3());
    if (composite.lengthSq() > 0) {
      return composite.normalize();
    }
  }

  if (typeof axis === 'string') {
    return axisToVector(axis);
  }

  return axisToVector('z');
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

  idleAction?.fadeOut(0.2);

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

  idleAction?.reset().fadeIn(0.4).play();

  gestureLock = false;
}

function attachIdleHandlers() {
  const idleButtons = document.querySelectorAll('.idle-toolbar button[data-idle]');
  if (!idleButtons.length) return;

  idleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.idle;
      if (!key || key === currentIdleKey) return;

      idleButtons.forEach((btn) => {
        btn.classList.toggle('is-active', btn === button);
      });

      setupIdleAnimation(key);
    });
  });
}

function animate() {
  requestAnimationFrame(animate);
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
  const floatOffset = Math.sin(idleTimer * 1.2) * 0.01;
  const sway = Math.sin(idleTimer * 0.85) * MathUtils.degToRad(0.9);

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

async function loadVRMAnimation(url, vrm) {
  if (!vrm) return null;

  const resolvedUrl = new URL(url, window.location.href).toString();

  if (!animationModulePromise) {
    animationModulePromise = import('https://unpkg.com/@pixiv/three-vrm-animation@3.4.2/lib/three-vrm-animation.module.js?module');
  }

  const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await animationModulePromise;

  if (!animationClipCache.has(resolvedUrl)) {
    const loader = new GLTFLoader();
    loader.crossOrigin = 'anonymous';
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    animationClipCache.set(
      resolvedUrl,
      loader.loadAsync(resolvedUrl)
        .then((gltf) => {
          const animation = gltf.userData?.vrmAnimations?.[0];
          if (!animation) {
            throw new Error(`No VRM animation found in ${resolvedUrl}`);
          }
          return animation;
        })
        .catch((error) => {
          animationClipCache.delete(resolvedUrl);
          throw error;
        })
    );
  }

  const animationData = await animationClipCache.get(resolvedUrl);
  return createVRMAnimationClip(animationData, vrm);
}
