// script.js (ES modules)
import * as THREE from 'three';
import { OrbitControls } from 'jsm/controls/OrbitControls.js';
import { EffectComposer } from 'jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'jsm/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'jsm/loaders/RGBELoader.js';
import { MeshSurfaceSampler } from 'jsm/math/MeshSurfaceSampler.js';

/* ===========================
   CONFIG — tweak freely
=========================== */
const MODEL_GLTF = new URL('https://github.com/broti1987/FKW-Aayat-Animation/raw/refs/heads/main/models/Aayat3.glb', import.meta.url).href;
const BEAD_GLTF  = new URL('https://github.com/broti1987/FKW-Aayat-Animation/raw/refs/heads/main/models/Aayat.glb',   import.meta.url).href;
const HDRI_PATH  = new URL('./env/studio.hdr',     import.meta.url).href;

const PARTICLE_COUNT = 1200;   // number of beads
const SCATTER_RADIUS = 5.0;    // outward scatter distance
const BEAD_SCALE     = 0.03;   // bead size
const INWARD_BIAS    = 0.075;  // how far to push beads slightly inside the shell along the normal

// Fade controls
const FADE_DURATION = 0.05;    // seconds; set 0 for instant dissolve
const FADE_EASE = (t)=> t*t*(3 - 2*t); // smoothstep-like ease

/* ===========================
   STATE
=========================== */
let scene, camera, renderer, composer, controls;
let heroGroup = null;
let heroMeshes = [];
let heroMaterial = null;
let goldBeadMaterial = null;

let particles = null;
let basePositions = null;    // Float32Array (xyz...)
let offsets = null;          // Float32Array (xyz...)
let instanceQuat = null;     // Quaternion[] aligned to normals
let backgroundStars = null;

let scatterStrength = 0;
let heroOpacity = 1.0;       // <-- NEW: reversible fade control

const clock = new THREE.Clock();

/* ===========================
   INIT
=========================== */
init();
async function init() {
  const canvas = document.getElementById('webgl');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x27221C);
  scene.fog = new THREE.Fog(0x6A533D, 4, 16);

  camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);
  camera.position.set(0,0,5);

  renderer = new THREE.WebGLRenderer({ antialias:true, canvas });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;

  // Minimal lights (static). Gold will primarily come from HDRI.
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.2);
  dir1.position.set(-3,-3,5);
  scene.add(dir1);

  const dir2 = new THREE.DirectionalLight(0xffffff, 0.2);
  dir2.position.set(8,12,-12);
  scene.add(dir2);

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  // Controls (no zoom)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = false;
  controls.enableDamping = true;

  // PostFX
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 1.0, 0.15));

  // Background starfield
  backgroundStars = makeStarfield();
  scene.add(backgroundStars);

  // Shared gold PBR base (will clone for hero to control opacity independently)
  const baseGold = new THREE.MeshStandardMaterial({
    color: 0xC4A46D,     // warm gold hue
    metalness: 1.0,
    roughness: 0.25,
    envMapIntensity: 1
  });

  // Load HDRI (optional, but recommended for gold look)
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const hdr = await new RGBELoader().loadAsync(HDRI_PATH);
    const envMap = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose(); pmrem.dispose();
    scene.environment = envMap;
  } catch (e) {
    console.warn('HDRI load failed or skipped — gold will be less reflective.', e);
  }

  // Now load the hero and bead, build the particle system
  const [beadGeom, hero] = await Promise.all([
    loadBeadGeometry(BEAD_GLTF),
    loadHero(MODEL_GLTF)
  ]);

  // Materials: clone baseGold for hero so we can fade hero independently
  goldBeadMaterial = baseGold;                  // beads use baseGold
  heroMaterial     = baseGold.clone();          // hero uses a clone
  heroMaterial.transparent = true;
  heroMaterial.opacity = 1.0;

  // Apply hero material and collect hero meshes
  heroMeshes = [];
  hero.traverse(obj=>{
    if (obj.isMesh) {
      obj.material = heroMaterial;
      heroMeshes.push(obj);
    }
  });

  heroGroup = hero;
  scene.add(heroGroup);

  // Sample beads from hero using MeshSurfaceSampler, placed slightly inward along normals
  const { positions, normals } = await samplePointsFromModel(heroMeshes, PARTICLE_COUNT, INWARD_BIAS);
  basePositions = positions;                                   // Float32Array
  offsets       = makeScatterOffsets(positions.length/3, SCATTER_RADIUS);
  instanceQuat  = makeQuatsFromNormals(normals);

  // Build instanced beads (visible on load)
  particles = buildBeads(beadGeom, goldBeadMaterial, basePositions, instanceQuat, BEAD_SCALE);
  particles.visible = true;
  scene.add(particles);

  // Start the loop
  animate();
}

/* ===========================
   LOADERS
=========================== */
async function loadHero(path){
  const gltf = await new GLTFLoader().loadAsync(path);
  return gltf.scene;
}

async function loadBeadGeometry(path){
  const gltf = await new GLTFLoader().loadAsync(path);
  let geo = null;
  gltf.scene.traverse(ch=>{
    if (ch.isMesh && !geo) geo = ch.geometry.clone();
  });
  if (!geo) {
    // fallback small sphere
    geo = new THREE.SphereGeometry(0.02, 12, 12);
  }
  if (!geo.attributes.normal) {
    geo = geo.clone();
    geo.computeVertexNormals();
  }
  return geo;
}

/* ===========================
   SAMPLING (MeshSurfaceSampler)
=========================== */
async function samplePointsFromModel(meshes, count, inwardBias = 0.0){
  const positions = new Float32Array(count*3);
  const normals   = new Float32Array(count*3);

  const areas = meshes.map(m=>estimateArea(m.geometry));
  const total = areas.reduce((a,b)=>a+b,0) || 1;
  const per   = areas.map(a=>Math.max(1, Math.round(count * (a/total))));

  let written = 0;
  const pos = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  for (let i=0; i<meshes.length; i++){
    const mesh = meshes[i];
    let todo = per[i];
    if (written/3 + todo > count) todo = count - written/3;
    if (todo <= 0) continue;

    const dup = mesh.clone();
    dup.applyMatrix4(mesh.matrixWorld);
    const sampler = new MeshSurfaceSampler(dup).build();

    for (let k=0; k<todo; k++){
      sampler.sample(pos, nrm);
      pos.addScaledVector(nrm, -inwardBias);

      positions[written+0] = pos.x;
      positions[written+1] = pos.y;
      positions[written+2] = pos.z;

      normals[written+0]   = nrm.x;
      normals[written+1]   = nrm.y;
      normals[written+2]   = nrm.z;

      written += 3;
    }
  }

  while (written/3 < count){
    positions[written+0]=0; positions[written+1]=0; positions[written+2]=0;
    normals[written+0]=0;   normals[written+1]=1;   normals[written+2]=0;
    written += 3;
  }

  return { positions, normals };
}

function estimateArea(geometry){
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  if (!pos) return 0;

  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  if (idx){
    for (let i=0; i<idx.count; i+=3){
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i+1));
      c.fromBufferAttribute(pos, idx.getX(i+2));
      area += triangleArea(a,b,c);
    }
  } else {
    for (let i=0; i<pos.count; i+=3){
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i+1);
      c.fromBufferAttribute(pos, i+2);
      area += triangleArea(a,b,c);
    }
  }
  return Math.max(area, 1e-6);
}
function triangleArea(a,b,c){
  const ab = new THREE.Vector3().subVectors(b,a);
  const ac = new THREE.Vector3().subVectors(c,a);
  return new THREE.Vector3().crossVectors(ab,ac).length()*0.5;
}

/* ===========================
   INSTANCING HELPERS
=========================== */
function makeScatterOffsets(count, radius){
  const arr = new Float32Array(count*3);
  for (let i=0; i<count; i++){
    let rx = Math.random()-0.5, ry = Math.random()-0.5, rz = Math.random()-0.5;
    const len = Math.max(1e-6, Math.hypot(rx,ry,rz));
    rx/=len; ry/=len; rz/=len;
    arr[i*3+0] = rx*radius;
    arr[i*3+1] = ry*radius;
    arr[i*3+2] = rz*radius;
  }
  return arr;
}
function makeQuatsFromNormals(normals){
  const forward = new THREE.Vector3(0,0,1); // bead forward (+Z)
  const q = new THREE.Quaternion();
  const list = new Array(normals.length/3);
  for (let i=0; i<list.length; i++){
    const n = new THREE.Vector3(
      normals[i*3+0],
      normals[i*3+1],
      normals[i*3+2]
    ).normalize();
    q.setFromUnitVectors(forward, n);
    list[i] = q.clone();
  }
  return list;
}

function buildBeads(geom, material, posArray, quats, scale){
  const count = posArray.length/3;
  const inst = new THREE.InstancedMesh(geom, material, count);
  const dummy = new THREE.Object3D();
  for (let i=0; i<count; i++){
    dummy.position.set(posArray[i*3+0], posArray[i*3+1], posArray[i*3+2]);
    if (quats) dummy.quaternion.copy(quats[i]);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

/* ===========================
   HERO OPACITY CONTROL
=========================== */
function setHeroOpacity(alpha){
  const a = THREE.MathUtils.clamp(alpha, 0, 1);
  heroOpacity = a;
  if (heroMaterial){
    heroMaterial.opacity = a;
    heroMaterial.needsUpdate = true;
  }
}

/* ===========================
   BACKGROUND STARS
=========================== */
function makeStarfield(){
  const group = new THREE.Group();
  const starGeom = new THREE.SphereGeometry(0.02, 8, 8);
  const starMat  = new THREE.MeshBasicMaterial({ color: 0x9bd3ff });
  const N = 1200;
  const inst = new THREE.InstancedMesh(starGeom, starMat, N);
  const d = new THREE.Object3D();
  for (let i=0; i<N; i++){
    const r = 18 + Math.random()*12;
    const u = Math.random(), v = Math.random();
    const theta = Math.acos(2*u - 1), phi = 2*Math.PI*v;
    d.position.set(
      r*Math.sin(theta)*Math.cos(phi),
      r*Math.cos(theta),
      r*Math.sin(theta)*Math.sin(phi)
    );
    d.scale.setScalar(0.6 + Math.random()*1.2);
    d.updateMatrix();
    inst.setMatrixAt(i, d.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);
  return group;
}

/* ===========================
   LOOP
=========================== */
function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t  = clock.elapsedTime;

  // gentle rotation
  if (heroGroup)  { heroGroup.rotation.y  = t*0.1; heroGroup.rotation.x  = Math.sin(t*0.1)*0.05; }
  if (particles)  { particles.rotation.y  = t*0.1; particles.rotation.x  = Math.sin(t*0.1)*0.05; }
  if (backgroundStars){
    backgroundStars.rotation.y = t*0.02;
    backgroundStars.rotation.x = Math.sin(t*0.05)*0.01;
  }

  // reversible fade based on scroll position
  const scrolled = window.scrollY > 0 ? 1 : 0;          // target 0 (top) or 1 (scrolled)
  const targetOpacity = 1 - scrolled;                   // hero 1 at top, 0 when scrolled
  const step = FADE_DURATION > 0 ? Math.min(1, dt/FADE_DURATION) : 1;
  const easedStep = FADE_EASE(step);
  setHeroOpacity(THREE.MathUtils.lerp(heroOpacity, targetOpacity, easedStep));

  // Scatter beads with scroll (independent of fade)
  if (particles && basePositions && offsets){
    scatterStrength = THREE.MathUtils.clamp(window.scrollY / innerHeight, 0, 1);
    const s = scatterStrength;

    const dummy = new THREE.Object3D();
    const count = basePositions.length/3;
    for (let i=0; i<count; i++){
      const ox = basePositions[i*3+0];
      const oy = basePositions[i*3+1];
      const oz = basePositions[i*3+2];
      const dx = offsets[i*3+0]*s;
      const dy = offsets[i*3+1]*s;
      const dz = offsets[i*3+2]*s;

      dummy.position.set(ox+dx, oy+dy, oz+dz);
      if (instanceQuat) dummy.quaternion.copy(instanceQuat[i]);
      dummy.scale.setScalar(BEAD_SCALE);
      dummy.updateMatrix();
      particles.setMatrixAt(i, dummy.matrix);
    }
    particles.instanceMatrix.needsUpdate = true;
  }

  controls.update();
  composer.render();
}

/* ===========================
   RESIZE
=========================== */
window.addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
