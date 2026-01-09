// script.js — BG liquid mesh gradient + BG HSL -> ClearDepth -> Main (hero+beads+FG bokeh+petals) -> Bloom

import * as THREE from 'three';
import { OrbitControls } from 'jsm/controls/OrbitControls.js';
import { EffectComposer } from 'jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'jsm/postprocessing/UnrealBloomPass.js';
import { Pass } from 'jsm/postprocessing/Pass.js';
import { GLTFLoader } from 'jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'jsm/loaders/RGBELoader.js';
import { MeshSurfaceSampler } from 'jsm/math/MeshSurfaceSampler.js';

/* ---------------- LOADER (drives HTML/CSS loader) ---------------- */
const loaderEl = document.getElementById('page-loader');
const loaderBarEl = document.getElementById('page-loader-bar');

function loaderSet(p) {
  if (!loaderBarEl) return;
  const v = Math.max(0.06, Math.min(1, p)); // keep it visible
  loaderBarEl.style.transform = `scaleX(${v})`;
}
function loaderDone() {
  if (!loaderEl) return;
  loaderSet(1);
  loaderEl.style.transition = 'opacity 450ms ease';
  loaderEl.style.opacity = '0';
  setTimeout(() => loaderEl.remove(), 520);
}

/* ---------------- CONFIG ---------------- */
const MODEL_GLTF = 'https://broti1987.github.io/FKW-Aayat-Animation/models/Aayat_s.glb';
const BEAD_GLTF  = 'https://broti1987.github.io/FKW-Aayat-Animation/models/Aayat3.glb';
const TRACK_GLTF = 'https://broti1987.github.io/FKW-Aayat-Animation/models/Aayat3.glb';
const HDRI_PATH  = 'https://broti1987.github.io/FKW-Aayat-Animation/env/street.hdr';

const RENDERER_EXPOSURE   = 1;
const GOLD_COLOR          = 0xEAC697;
const GOLD_ENV_INTENSITY  = 2;
const GOLD_ROUGHNESS      = 0.15;

const HERO_SCALE  = 17.0;
const TRACK_SCALE = 17.0;

const PARTICLE_COUNT = 400;
const SCATTER_RADIUS = 5.0 / HERO_SCALE;
const BEAD_SCALE     = 0.055 / HERO_SCALE;
const INWARD_BIAS    = 0;

const FADE_DURATION  = 0;
const FADE_EASE      = (t)=> t*t*(3 - 2*t);
const SHOW_TRACK_MODEL = false;

/* --- BG gradient --- */
const MG_COLORS = [
  new THREE.Color(0xBCE9F2),
  new THREE.Color(0xFAF5F0),
  new THREE.Color(0xFEF5EE)
];
const LIQUID = {
  SPEED: 2.0, SCALE_R: 0.75, SCALE_B: 0.4, SCALE_Y: 0.4,
  GAIN: 0.2, GRAIN_AMT: 0.5, GRAIN_MIX: 0.15,
  EXTRA1: 0xFAF5F0, EXTRA2: 0xFEF5EE, EXTRA3: 0xFAF5F0,
  EXTRA4: 0xFAF5F0, EXTRA5: 0xFAF5F0, EXTRA6: 0xFAF5F0
};

/* --- FG bokeh --- */
const FG_BOKEH_COUNT     = 10;
const FG_BOKEH_OPACITY   = 0.5;
const FG_BOKEH_COLOR     = 0xF2D38A;
const FG_BOKEH_DIST_MIN  = 0.1;
const FG_BOKEH_DIST_MAX  = 0.2;
const FG_BOKEH_SIZE_MIN  = 0.0015;
const FG_BOKEH_SIZE_MAX  = 0.005;
const FG_BOKEH_TWINKLE   = { min: 0.3, max: 0.85 };
const FG_BOKEH_DRIFT     = 0.025;
const FG_BOKEH_SCATTER   = 0.9;
const FG_BACK_IN_SLOW    = 20;
const FG_SCATTER_OUT_FAST= 20;
const FG_HOVER_AMP       = 0.03;
const FG_HOVER_FREQ_MIN  = 0.03;
const FG_HOVER_FREQ_MAX  = 0.35;

/* --- Petals --- */
const FG_PETAL_COUNT      = 1000;
const FG_PETAL_COLORS     = [0xF89B57, 0xF9BF68, 0xFFEF72];
const FG_PETAL_OPACITY    = 0.95;
const FG_PETAL_SIZE_MIN   = 0.001;
const FG_PETAL_SIZE_MAX   = 0.006;
const FG_PETAL_DRIFT      = FG_BOKEH_DRIFT;
const FG_PETAL_SPIN_MIN   = -1.5;
const FG_PETAL_SPIN_MAX   =  1.5;

/* --- Group spin control (independent) --- */
const BOKEH_GROUP_ROT = { axis: new THREE.Vector3(0, 1, 0), speed:  0.05 };
const PETAL_GROUP_ROT = { axis: new THREE.Vector3(0, 1, 0), speed: -0.05 };
const HERO_GROUP_ROT  = { axis: new THREE.Vector3(0, 1, 0), speed:  0.08 };

/* --- BG HSL --- */
const BG_HSL = { hueShift: 0.0, satMul: 1.5, lightAdd: 0.0 };

/* --- HERO idle breathing & return-to-zero --- */
const HERO_BREATH = { amp: 0.6, freq: 0.2 };
const HERO_RETURN_SPEED = 3.0;
const SCROLL_TOP_EPS = 0.001;

/* ---------------- STATE ---------------- */
let renderer, composer;
let bgScene, bgCamera, bgMaterial;
let scene, camera, controls;

let heroGroup = null, heroMaterial = null;
let trackGroup = null, trackMeshes = [];
let particles = null, basePositions = null, offsets = null, instanceQuat = null;
let heroOpacity = 1.0;

const clock = new THREE.Clock();

let fgBokehGroup = null, fgBokehSprites = [], fgBokehParams = [];
let fgPetalGroup = null, fgPetalSprites = [], fgPetalParams = [];

let bokehSpin = null;
let petalSpin = null;
let heroSpin  = null;

let fgScatterTarget = 0.0, fgScatter = 0.0;

/* -------- Passes & Shaders -------- */
class ClearDepthPass extends Pass {
  constructor(){ super(); this.needsSwap = false; }
  render(r){ r.clearDepth(); }
}

const HSLShader = {
  uniforms: { tDiffuse:{value:null}, uHueShift:{value:0}, uSatMul:{value:1}, uLightAdd:{value:0} },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
  fragmentShader: `
    precision highp float; varying vec2 vUv;
    uniform sampler2D tDiffuse; uniform float uHueShift,uSatMul,uLightAdd;
    vec3 rgb2hsl(vec3 c){ float maxc=max(max(c.r,c.g),c.b), minc=min(min(c.r,c.g),c.b);
      float h=0., s=0., l=(maxc+minc)*.5, d=maxc-minc;
      if(d>1e-6){ s=d/(1.-abs(2.*l-1.));
        if(maxc==c.r) h=((c.g-c.b)/d+(c.g<c.b?6.:0.));
        else if(maxc==c.g) h=((c.b-c.r)/d+2.); else h=((c.r-c.g)/d+4.); h/=6.;
      } return vec3(h,s,l); }
    float hue2rgb(float p,float q,float t){ if(t<0.)t+=1.; if(t>1.)t-=1.;
      if(t<1./6.) return p+(q-p)*6.*t; if(t<.5) return q; if(t<2./3.) return p+(q-p)*(2./3.-t)*6.; return p; }
    vec3 hsl2rgb(vec3 hsl){ float h=hsl.x,s=clamp(hsl.y,0.,1.),l=clamp(hsl.z,0.,1.); if(s<=0.) return vec3(l);
      float q=l<.5?l*(1.+s):l+s-l*s, p=2.*l-q;
      return vec3(hue2rgb(p,q,h+1./3.), hue2rgb(p,q,h), hue2rgb(p,q,h-1./3.)); }
    void main(){ vec4 col=texture2D(tDiffuse,vUv); vec3 hsl=rgb2hsl(col.rgb);
      hsl.x=fract(hsl.x+uHueShift); hsl.y=clamp(hsl.y*uSatMul,0.,1.); hsl.z=clamp(hsl.z+uLightAdd,0.,1.);
      gl_FragColor=vec4(hsl2rgb(hsl), col.a); }
  `
};

/* ---------- Space conversion helpers for beads ---------- */
function worldArrayToLocal(obj, posArray){
  const v = new THREE.Vector3(); obj.updateMatrixWorld(true);
  for (let i=0;i<posArray.length;i+=3){
    v.set(posArray[i],posArray[i+1],posArray[i+2]); obj.worldToLocal(v);
    posArray[i]=v.x; posArray[i+1]=v.y; posArray[i+2]=v.z;
  }
  return posArray;
}
function worldNormalsToLocal(obj, normals){
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const nrmMat = new THREE.Matrix3().setFromMatrix4(inv).transpose();
  const v = new THREE.Vector3();
  for (let i=0;i<normals.length;i+=3){
    v.set(normals[i],normals[i+1],normals[i+2]).applyMatrix3(nrmMat).normalize();
    normals[i]=v.x; normals[i+1]=v.y; normals[i+2]=v.z;
  }
  return normals;
}

/* iframe scroll proxy */
let externalScrollY = 0, useExternalScroll = false;
window.addEventListener('message', (e) => {
  const d = e?.data;
  if (d && d.type === 'wf-scroll' && typeof d.scrollY === 'number') {
    externalScrollY = d.scrollY; useExternalScroll = true;
  }
});
function getScrollY(){ return useExternalScroll ? externalScrollY : window.scrollY; }

/* ---------------- INIT ---------------- */
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

async function init(){
  loaderSet(0.06); // show instantly

  const canvas = document.getElementById('webgl');
  if (!canvas) { console.warn('No #webgl canvas'); loaderDone(); return; }

  // Manager drives the loader
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, loaded, total) => loaderSet(total ? loaded / total : 0);
  manager.onLoad = () => loaderDone();
  manager.onError = () => loaderDone();

  const gltfLoader = new GLTFLoader(manager);
  const rgbeLoader = new RGBELoader(manager);

  renderer = new THREE.WebGLRenderer({ antialias:true, canvas, alpha:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDERER_EXPOSURE;
  renderer.setClearColor(0x000000, 0.0);
  renderer.autoClear = true;

  // BG scene
  bgScene  = new THREE.Scene();
  bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  bgMaterial = new THREE.ShaderMaterial(makeMeshGradientShader(MG_COLORS, LIQUID));
  const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial);
  bgQuad.frustumCulled = false; bgScene.add(bgQuad);

  // Main scene
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x89D9E9, 8, 10);

  camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);
  camera.position.set(0,0,5.2);

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.6); dir1.position.set(3,-3,5);  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.4); dir2.position.set(8,12,-12); scene.add(dir2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = false; controls.enableDamping = true;

  // Composer
  composer = new EffectComposer(renderer);
  const bgPass = new RenderPass(bgScene, bgCamera); bgPass.clear = true; composer.addPass(bgPass);

  const bgHslPass = new ShaderPass(HSLShader);
  bgHslPass.uniforms.uHueShift.value = BG_HSL.hueShift;
  bgHslPass.uniforms.uSatMul.value   = BG_HSL.satMul;
  bgHslPass.uniforms.uLightAdd.value = BG_HSL.lightAdd;
  composer.addPass(bgHslPass);

  composer.addPass(new ClearDepthPass());

  const mainPass = new RenderPass(scene, camera); mainPass.clear = false; composer.addPass(mainPass);
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.2, 2, 0.9));

  const baseGold = new THREE.MeshStandardMaterial({
    color: GOLD_COLOR, metalness: 1.0, roughness: GOLD_ROUGHNESS,
    envMapIntensity: GOLD_ENV_INTENSITY, transparent: true, opacity: 0.0
  });

  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const hdr = await rgbeLoader.loadAsync(HDRI_PATH);
    const envMap = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose(); pmrem.dispose();
    scene.environment = envMap;
  } catch(e){ console.warn('HDRI load failed', e); }

  const [beadGeom, hero, track] = await Promise.all([
    loadBeadGeometry(BEAD_GLTF, gltfLoader),
    loadGLTFScene(MODEL_GLTF, gltfLoader),
    loadGLTFScene(TRACK_GLTF, gltfLoader)
  ]);

  hero.scale.setScalar(HERO_SCALE);
  track.scale.setScalar(TRACK_SCALE);

  heroMaterial = baseGold.clone(); heroMaterial.opacity = 1.0;
  hero.traverse(o=>{ if(o.isMesh){ o.material = heroMaterial; }});
  heroGroup = hero;
  scene.add(heroGroup);

  trackGroup = track; trackGroup.visible = SHOW_TRACK_MODEL; scene.add(trackGroup);
  trackGroup.updateMatrixWorld(true);
  trackGroup.traverse(o => { if (o.isMesh && o.geometry) trackMeshes.push(o); });

  const { positions, normals } = await samplePointsFromModel(trackMeshes, PARTICLE_COUNT, INWARD_BIAS);

  // Convert sampled WORLD data into HERO-LOCAL space so beads stick to the track as hero moves
  scene.updateMatrixWorld(true);
  heroGroup.updateMatrixWorld(true);
  worldArrayToLocal(heroGroup, positions);
  worldNormalsToLocal(heroGroup, normals);

  basePositions = positions;
  offsets = makeScatterOffsets(positions.length/3, SCATTER_RADIUS);
  instanceQuat  = makeQuatsFromNormals(normals);

  particles = buildBeads(beadGeom, baseGold, basePositions, instanceQuat, BEAD_SCALE);
  particles.visible = false;
  heroGroup.add(particles);

  // ----- Independent spin wrappers -----
  BOKEH_GROUP_ROT.axis.normalize();
  PETAL_GROUP_ROT.axis.normalize();
  HERO_GROUP_ROT.axis.normalize();

  heroSpin = new THREE.Group();
  scene.add(heroSpin);
  heroSpin.add(heroGroup);

  bokehSpin    = new THREE.Group();
  fgBokehGroup = new THREE.Group();
  heroGroup.add(bokehSpin);
  bokehSpin.add(fgBokehGroup);
  createForegroundBokeh(fgBokehGroup, heroGroup);

  petalSpin    = new THREE.Group();
  fgPetalGroup = new THREE.Group();
  heroGroup.add(petalSpin);
  petalSpin.add(fgPetalGroup);
  createForegroundPetals(fgPetalGroup, heroGroup);

  animate();
}

/* ---------------- LOADERS ---------------- */
async function loadGLTFScene(url, gltfLoader){
  const gltf = await gltfLoader.loadAsync(url);
  return gltf.scene;
}
async function loadBeadGeometry(p, gltfLoader){
  const gltf = await gltfLoader.loadAsync(p);
  let geo=null;
  gltf.scene.traverse(ch=>{ if(ch.isMesh && !geo) geo = ch.geometry.clone(); });
  if(!geo) geo = new THREE.SphereGeometry(0.02,12,12);
  if(!geo.attributes.normal){ geo = geo.clone(); geo.computeVertexNormals(); }
  return geo;
}

/* ------------- SAMPLING HELPERS ------------- */
async function samplePointsFromModel(meshes, count, inwardBias=0.0){
  const positions=new Float32Array(count*3), normals=new Float32Array(count*3);
  const areas=meshes.map(m=>estimateArea(m.geometry));
  const total=areas.reduce((a,b)=>a+b,0)||1;
  const per=areas.map(a=>Math.max(1, Math.round(count*(a/total))));
  let written=0; const pos=new THREE.Vector3(), nrm=new THREE.Vector3();

  for(let i=0;i<meshes.length;i++){
    const mesh=meshes[i];
    let todo=per[i]; if (written/3 + todo > count) todo = count - (written/3);
    if (todo<=0) continue;
    const dup=mesh.clone(); dup.applyMatrix4(mesh.matrixWorld);
    const sampler=new MeshSurfaceSampler(dup).build();
    for(let k=0;k<todo;k++){
      sampler.sample(pos,nrm);
      pos.addScaledVector(nrm, -inwardBias);
      positions[written]=pos.x; positions[written+1]=pos.y; positions[written+2]=pos.z;
      normals[written]=nrm.x; normals[written+1]=nrm.y; normals[written+2]=nrm.z;
      written+=3;
    }
  }
  while (written/3 < count){
    positions[written]=0; positions[written+1]=0; positions[written+2]=0;
    normals[written]=0; normals[written+1]=1; normals[written+2]=0;
    written+=3;
  }
  return { positions, normals };
}
function estimateArea(geometry){
  const pos=geometry.attributes.position, idx=geometry.index;
  if(!pos) return 0;
  let area=0; const a=new THREE.Vector3(), b=new THREE.Vector3(), c=new THREE.Vector3();
  if(idx){
    for(let i=0;i<idx.count;i+=3){
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i+1));
      c.fromBufferAttribute(pos, idx.getX(i+2));
      area += triangleArea(a,b,c);
    }
  } else {
    for(let i=0;i<pos.count;i+=3){
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i+1);
      c.fromBufferAttribute(pos, i+2);
      area += triangleArea(a,b,c);
    }
  }
  return Math.max(area, 1e-6);
}
function triangleArea(a,b,c){
  const ab=new THREE.Vector3().subVectors(b,a);
  const ac=new THREE.Vector3().subVectors(c,a);
  return new THREE.Vector3().crossVectors(ab,ac).length()*0.5;
}

/* ------------- INSTANCING HELPERS ------------- */
function makeScatterOffsets(count,radius){
  const arr=new Float32Array(count*3);
  for(let i=0;i<count;i++){
    const v=new THREE.Vector3(Math.random()-0.5,Math.random()-0.5,Math.random()-0.5).normalize();
    arr.set([v.x*radius,v.y*radius,v.z*radius], i*3);
  }
  return arr;
}
function makeQuatsFromNormals(normals){
  const forward = new THREE.Vector3(0,0,1);
  const list = new Array(normals.length/3);
  for (let i=0; i<list.length; i++){
    const n = new THREE.Vector3(normals[i*3], normals[i*3+1], normals[i*3+2]).normalize();
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(forward, n);
    list[i] = q.clone();
  }
  return list;
}
function buildBeads(geom, material, posArray, quats, scale){
  const count=posArray.length/3;
  const inst=new THREE.InstancedMesh(geom, material, count);
  const dummy=new THREE.Object3D();
  for(let i=0;i<count;i++){
    dummy.position.set(posArray[i*3],posArray[i*3+1],posArray[i*3+2]);
    if(quats) dummy.quaternion.copy(quats[i]);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

/* ---------------- FG: BOKEH ---------------- */
function createBokehTexture(size=256){
  const cvs = document.createElement('canvas'); cvs.width = cvs.height = size;
  const ctx = cvs.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0.0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,size,size);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function createForegroundBokeh(group, target){
  const box = new THREE.Box3().setFromObject(target);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);

  const rad = Math.max(0.001, sphere.radius);
  const tex = createBokehTexture(256);

  for (let i=0; i<FG_BOKEH_COUNT; i++){
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: FG_BOKEH_COLOR,
      transparent: true,
      opacity: FG_BOKEH_OPACITY,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true
    });
    const spr = new THREE.Sprite(mat);

    const dir = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize();
    const dist = rad * THREE.MathUtils.lerp(FG_BOKEH_DIST_MIN, FG_BOKEH_DIST_MAX, Math.random());
    const basePos = dir.multiplyScalar(dist);
    spr.position.copy(basePos);

    const baseScale = THREE.MathUtils.lerp(rad*FG_BOKEH_SIZE_MIN, rad*FG_BOKEH_SIZE_MAX, Math.random());
    spr.scale.set(baseScale, baseScale, 1);

    const axis = new THREE.Vector3().randomDirection().normalize();
    const angVel = THREE.MathUtils.lerp(-1, 1, Math.random()) * FG_BOKEH_DRIFT;
    const phase = Math.random() * Math.PI * 2;
    const speed = THREE.MathUtils.lerp(0.25, 0.9, Math.random());

    const hoverAxis = new THREE.Vector3().randomDirection().normalize();
    const hoverAmp  = rad * FG_HOVER_AMP * THREE.MathUtils.lerp(0.6, 1.4, Math.random());
    const hoverFreq = THREE.MathUtils.lerp(FG_HOVER_FREQ_MIN, FG_HOVER_FREQ_MAX, Math.random());

    const scatterOffset = new THREE.Vector3().randomDirection().normalize().multiplyScalar(rad * FG_BOKEH_SCATTER);

    fgBokehSprites.push(spr);
    fgBokehParams.push({ basePos, axis, angVel, phase, speed, baseScale, hoverAxis, hoverAmp, hoverFreq, scatterOffset });
    group.add(spr);
  }
}
function updateForegroundBokeh(t, dt){
  const kOut = 1.0 - Math.exp(-FG_SCATTER_OUT_FAST * dt);
  const kIn  = 1.0 - Math.exp(-FG_BACK_IN_SLOW  * dt);
  fgScatter += (fgScatter < fgScatterTarget)
    ? (fgScatterTarget - fgScatter) * kOut
    : (fgScatterTarget - fgScatter) * kIn;

  const q = new THREE.Quaternion();
  for (let i=0; i<fgBokehSprites.length; i++){
    const spr = fgBokehSprites[i], p = fgBokehParams[i];

    q.setFromAxisAngle(p.axis, p.angVel * dt);
    p.basePos.applyQuaternion(q);

    const hover = p.hoverAxis.clone().multiplyScalar(Math.sin(t * p.hoverFreq + p.phase) * p.hoverAmp);
    const scatter = p.scatterOffset.clone().multiplyScalar(fgScatter);

    spr.position.copy(p.basePos).add(hover).add(scatter);

    const tw = (Math.sin(t * p.speed + p.phase) * 0.5 + 0.5);
    spr.material.opacity = THREE.MathUtils.lerp(FG_BOKEH_TWINKLE.min, FG_BOKEH_TWINKLE.max, tw) * (1.0 - 0.4*fgScatter);

    const scalePulse = THREE.MathUtils.lerp(0.9, 1.15, tw) * (1.0 - 0.5*fgScatter);
    spr.scale.set(p.baseScale * scalePulse, p.baseScale * scalePulse, 1);
  }
}

/* ---------------- PETALS ---------------- */
function createPetalTexture(size=256){
  const s = size;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = s;
  const ctx = cvs.getContext('2d');

  ctx.clearRect(0,0,s,s);
  ctx.translate(s/2, s*0.60);

  const r = s*0.32;
  ctx.beginPath();
  ctx.moveTo(0,-r*1.5);
  ctx.bezierCurveTo( r*0.95, -r*0.9,  r*0.75,  r*0.15,  0,  r*0.95);
  ctx.bezierCurveTo(-r*0.75,  r*0.15, -r*0.95, -r*0.9,  0, -r*1.5);
  ctx.closePath();

  const grad = ctx.createRadialGradient(0, r*0.1, 0, 0, 0, r*1.4);
  grad.addColorStop(0.00, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.60, 'rgba(255,255,255,0.65)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0.0)');

  ctx.fillStyle = grad;
  ctx.fill();

  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function createForegroundPetals(group, target){
  const box = new THREE.Box3().setFromObject(target);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const rad = Math.max(0.001, sphere.radius);

  const tex = createPetalTexture(256);
  const geom = new THREE.PlaneGeometry(1, 1);

  for (let i=0; i<FG_PETAL_COUNT; i++){
    const color = FG_PETAL_COLORS[i % FG_PETAL_COLORS.length];
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color,
      transparent: true,
      opacity: FG_PETAL_OPACITY,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });

    const mesh = new THREE.Mesh(geom, mat);

    const dir = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize();
    const dist = rad * THREE.MathUtils.lerp(FG_BOKEH_DIST_MIN, FG_BOKEH_DIST_MAX, Math.random());
    const basePos = dir.multiplyScalar(dist);
    mesh.position.copy(basePos);

    const baseScale = THREE.MathUtils.lerp(rad*FG_PETAL_SIZE_MIN, rad*FG_PETAL_SIZE_MAX, Math.random());
    const aspect = THREE.MathUtils.lerp(0.7, 1.3, Math.random());
    mesh.scale.set(baseScale*aspect, baseScale, 1);

    const axis = new THREE.Vector3().randomDirection().normalize();
    const angVel = THREE.MathUtils.lerp(-1, 1, Math.random()) * FG_PETAL_DRIFT;

    const hoverAxis = new THREE.Vector3().randomDirection().normalize();
    const hoverAmp  = rad * FG_HOVER_AMP * THREE.MathUtils.lerp(0.6, 1.4, Math.random());
    const hoverFreq = THREE.MathUtils.lerp(FG_HOVER_FREQ_MIN, FG_HOVER_FREQ_MAX, Math.random());

    const scatterOffset = new THREE.Vector3().randomDirection().normalize().multiplyScalar(rad * FG_BOKEH_SCATTER);

    const spinAxis = new THREE.Vector3().randomDirection().normalize();
    const spinVel  = THREE.MathUtils.lerp(FG_PETAL_SPIN_MIN, FG_PETAL_SPIN_MAX, Math.random());

    fgPetalSprites.push(mesh);
    fgPetalParams.push({
      basePos, axis, angVel,
      phase: Math.random()*Math.PI*2,
      hoverAxis, hoverAmp, hoverFreq,
      scatterOffset,
      baseScale: mesh.scale.clone(),
      spinAxis, spinVel
    });

    group.add(mesh);
  }
}
function updateForegroundPetals(t, dt){
  const kOut = 1.0 - Math.exp(-FG_SCATTER_OUT_FAST * dt);
  const kIn  = 1.0 - Math.exp(-FG_BACK_IN_SLOW  * dt);
  fgScatter += (fgScatter < fgScatterTarget)
    ? (fgScatterTarget - fgScatter) * kOut
    : (fgScatterTarget - fgScatter) * kIn;

  const q = new THREE.Quaternion();
  for (let i=0; i<fgPetalSprites.length; i++){
    const mesh = fgPetalSprites[i], p = fgPetalParams[i];

    q.setFromAxisAngle(p.axis, p.angVel * dt);
    p.basePos.applyQuaternion(q);

    const hover = p.hoverAxis.clone().multiplyScalar(Math.sin(t * p.hoverFreq + p.phase) * p.hoverAmp);
    const scatter = p.scatterOffset.clone().multiplyScalar(fgScatter);

    mesh.position.copy(p.basePos).add(hover).add(scatter);

    const tw = (Math.sin(t * 0.6 + p.phase) * 0.5 + 0.5);
    const scalePulse = THREE.MathUtils.lerp(0.95, 1.10, tw) * (1.0 - 0.4*fgScatter);
    mesh.scale.set(p.baseScale.x * scalePulse, p.baseScale.y * scalePulse, 1);

    mesh.rotateOnAxis(p.spinAxis, p.spinVel * dt);
    mesh.material.opacity = FG_PETAL_OPACITY * (1.0 - 0.35*fgScatter);
  }
}

/* ---------------- OPACITY HELPERS ---------------- */
function setHeroOpacity(a){
  heroOpacity = THREE.MathUtils.clamp(a,0,1);
  if (heroMaterial){
    heroMaterial.opacity = heroOpacity;
    heroMaterial.depthWrite = heroOpacity >= 0.999;
    heroMaterial.needsUpdate = true;
  }
}
function setBeadOpacity(a){
  if(particles && particles.material){
    particles.material.opacity = a;
    particles.material.transparent = true;
    particles.material.depthWrite = a >= 1.0;
    particles.material.needsUpdate = true;
  }
}

/* ---------------- LOOP ---------------- */
const Q_IDENTITY = new THREE.Quaternion();

function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t  = clock.elapsedTime;

  const scrollS = THREE.MathUtils.clamp(getScrollY()/innerHeight, 0, 1);
  fgScatterTarget = scrollS;

  if (particles){
    if (scrollS > 0 && !particles.visible){ particles.visible = true;  setBeadOpacity(1.0); }
    else if (scrollS === 0 && particles.visible){ particles.visible = false; setBeadOpacity(0.0); }
  }

  const target = scrollS > 0 ? 0 : 1;
  const step   = FADE_DURATION > 0 ? Math.min(1, dt/FADE_DURATION) : 1;
  const eased  = FADE_EASE(step);
  setHeroOpacity(THREE.MathUtils.lerp(heroOpacity, target, eased));

  // Scatter beads with scroll (hero-local space)
  if (particles && basePositions && offsets){
    const s = scrollS;
    const dummy = new THREE.Object3D();
    const count = basePositions.length/3;
    for (let i=0; i<count; i++){
      dummy.position.set(
        basePositions[i*3]   + offsets[i*3]*s,
        basePositions[i*3+1] + offsets[i*3+1]*s,
        basePositions[i*3+2] + offsets[i*3+2]*s
      );
      if (instanceQuat) dummy.quaternion.copy(instanceQuat[i]);
      dummy.scale.setScalar(BEAD_SCALE);
      dummy.updateMatrix();
      particles.setMatrixAt(i, dummy.matrix);
    }
    particles.instanceMatrix.needsUpdate = true;
  }

  // HERO idle breathing & return-to-zero
  if (heroGroup && heroSpin){
    if (scrollS <= SCROLL_TOP_EPS){
      heroGroup.rotation.x = 0;
      heroGroup.rotation.z = 0;
      heroGroup.rotation.y = Math.sin(t * HERO_BREATH.freq) * HERO_BREATH.amp;

      const backK = 1.0 - Math.exp(-HERO_RETURN_SPEED * dt);
      heroSpin.quaternion.slerp(Q_IDENTITY, backK);
    } else {
      heroGroup.rotation.y = 0;
      heroSpin.rotateOnAxis(HERO_GROUP_ROT.axis, HERO_GROUP_ROT.speed * dt);
    }
  }

  if (bokehSpin) bokehSpin.rotateOnAxis(BOKEH_GROUP_ROT.axis, BOKEH_GROUP_ROT.speed * dt);
  if (petalSpin) petalSpin.rotateOnAxis(PETAL_GROUP_ROT.axis, PETAL_GROUP_ROT.speed * dt);

  if (bgMaterial?.uniforms?.uTime) bgMaterial.uniforms.uTime.value = t;
  updateForegroundBokeh(t, dt);
  updateForegroundPetals(t, dt);

  controls.update();
  composer.render();
}

/* ---------------- RESIZE ---------------- */
window.addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  if (bgMaterial?.uniforms?.uResolution){
    bgMaterial.uniforms.uResolution.value.set(innerWidth, innerHeight);
  }
});

/* -------------- BG LIQUID SHADER -------------- */
function makeMeshGradientShader(colors, cfg){
  const cArr = new Float32Array([
    colors[0].r, colors[0].g, colors[0].b,
    colors[1].r, colors[1].g, colors[1].b,
    colors[2].r, colors[2].g, colors[2].b
  ]);
  return {
    uniforms: {
      uTime:{value:0}, uResolution:{value:new THREE.Vector2(innerWidth, innerHeight)},
      uMainColors:{value:cArr},
      uExtra1:{value:new THREE.Color(cfg.EXTRA1)}, uExtra2:{value:new THREE.Color(cfg.EXTRA2)},
      uExtra3:{value:new THREE.Color(cfg.EXTRA3)}, uExtra4:{value:new THREE.Color(cfg.EXTRA4)},
      uExtra5:{value:new THREE.Color(cfg.EXTRA5)}, uExtra6:{value:new THREE.Color(cfg.EXTRA6)},
      uSpeed:{value:cfg.SPEED}, uScaleR:{value:cfg.SCALE_R}, uScaleB:{value:cfg.SCALE_B}, uScaleY:{value:cfg.SCALE_Y},
      uGain:{value:cfg.GAIN}, uGrainAmt:{value:cfg.GRAIN_AMT}, uGrainMix:{value:cfg.GRAIN_MIX}
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
    fragmentShader: `
      precision highp float; varying vec2 vUv;
      uniform float uTime,uSpeed,uScaleR,uScaleB,uScaleY,uGain,uGrainAmt,uGrainMix;
      uniform vec2 uResolution; uniform float uMainColors[9];
      uniform vec3 uExtra1,uExtra2,uExtra3,uExtra4,uExtra5,uExtra6;
      vec3 mainColor(int i){ int j=i*3; return vec3(uMainColors[j],uMainColors[j+1],uMainColors[j+2]); }
      vec2 hash(vec2 p){ p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return -1.0+2.0*fract(sin(p)*43758.5453123); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p), u=f*f*(3.-2.*f);
        return mix( mix(dot(hash(i+vec2(0,0)),f-vec2(0,0)), dot(hash(i+vec2(1,0)),f-vec2(1,0)), u.x),
                    mix(dot(hash(i+vec2(0,1)),f-vec2(0,1)), dot(hash(i+vec2(1,1)),f-vec2(1,1)), u.x), u.y); }
      void main(){
        vec2 uv=vUv*2.-1.; uv.x*=uResolution.x/max(uResolution.y,1.); float t=uTime*(uSpeed*.5);
        float r1=noise(uv*(uScaleR*1.0)+t*.2), r2=noise(uv*(uScaleR*1.5)-t*.15), r3=noise(uv*(uScaleR*2.0)+t*.10);
        float redBlend=smoothstep(.35,.75,((r1+r2+r3)/3.)*.5+.5);
        float b1=noise((uv+vec2(.2,-.3))*(uScaleB*1.2)-t*.12), b2=noise((uv+vec2(-.4,.1))*(uScaleB*1.6)+t*.18), b3=noise((uv+vec2(.3,.2))*(uScaleB*2.0)-t*.09);
        float blueBlend=smoothstep(.35,.75,((b1+b2+b3)/3.)*.5+.5);
        float y1=noise((uv+vec2(.5,-.2))*(uScaleY*.9)+t*.07), y2=noise((uv+vec2(-.3,.4))*(uScaleY*1.1)-t*.05);
        float yellowBlend=smoothstep(.45,.70,((y1+y2)/2.)*.5+.5);
        vec3 color=mainColor(0); color=mix(color,mainColor(1),redBlend); color=mix(color,mainColor(2),blueBlend);
        color=mix(color,uExtra1,blueBlend*.30); color=mix(color,uExtra2,redBlend*.20);
        color=mix(color,uExtra3,redBlend*.35); color=mix(color,uExtra4,blueBlend*.20);
        color=mix(color,uExtra5,yellowBlend*.25); color=mix(color,uExtra6,yellowBlend*.30);
        color=clamp(pow(color, vec3(1.0/max(uGain,0.0001))), 0.0, 1.0);
        float grain=noise(gl_FragCoord.xy*4.0+vec2(sin(uTime*2.0),cos(uTime*3.0))*20.0)*uGrainAmt;
        color=mix(color, color*(1.0-grain), uGrainMix);
        gl_FragColor=vec4(color,1.0);
      }
    `
  };
}
