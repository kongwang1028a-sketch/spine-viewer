/*
 * Spine 多組檢視器（spine-ts 3.8 webgl）
 * - 一次匯入多組 Spine（檔案 / 資料夾 / 拖放），同時播放
 * - 跟隨：一組 Spine 每幀對齊另一組第 0 軌的動畫名與播放時間（例：特效層跟著本體播同一段動畫）
 * - 骨頭掛點：文字掛在骨頭上（同 Cocos socket）
 * - 播放順序：錄製 / 編輯 / 播放 Start → Loop×N → End
 * - 靜 / 動態切換：圖層角色 + 全部 / 靜態 / 動態 / 疊圖 / 閃爍
 */
'use strict';

const $ = sel => document.querySelector(sel);
const LS_LAYER = 'spineViewer.layer.';
const LS_GLOBAL = 'spineViewer.global';
const LS_ATT = 'spineViewer.attachments';
const LS_ORDER = 'spineViewer.order';
const FPS = 30;
const EMPTY = '<empty>';

// ---------- storage（private window 會丟例外，一律包起來） ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* ignore */
    }
  },
};

// ---------- state ----------
const S = {
  layers: [],
  attachments: [],
  selectedId: null,
  selectedBone: null,
  paused: false,
  speed: 1,
  compare: 'both',
  overlayOpacity: 0.5,
  blinkInterval: 0.5,
  blinkPhase: false,
  blinkT: 0,
  clock: 0, // 淡入淡出的全域計時（全部從頭 / R 歸零）
  bg: '#2b2b2b',
  grid: true,
  frame: '',
  showBoneNames: false,
  cam: {x: 0, y: 0, scale: 1},
  fonts: ['sans-serif', 'Arial', 'Impact'],
  cursor: null,
};
let nextId = 1;

Object.assign(S, pick(store.get(LS_GLOBAL, {}), ['compare', 'overlayOpacity', 'blinkInterval', 'bg', 'grid', 'frame', 'showBoneNames']));
S.compare = S.compare || 'both';

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ---------- WebGL ----------
const canvas = $('#gl');
const overlay = $('#ov');
const octx = overlay.getContext('2d');
const mctx = new spine.webgl.ManagedWebGLRenderingContext(canvas, {alpha: false, preserveDrawingBuffer: true});
const gl = mctx.gl;
const renderer = new spine.webgl.SceneRenderer(canvas, mctx, true);
{
  const d = renderer.skeletonDebugRenderer;
  d.drawRegionAttachments = false;
  d.drawBoundingBoxes = false;
  d.drawMeshHull = false;
  d.drawMeshTriangles = false;
  d.drawPaths = false;
  d.drawClipping = false;
}

const dpr = () => window.devicePixelRatio || 1;

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr()));
  const h = Math.max(1, Math.round(r.height * dpr()));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = overlay.width = w;
    canvas.height = overlay.height = h;
  }
  gl.viewport(0, 0, w, h);
  const cam = renderer.camera;
  cam.setViewport(w, h);
  cam.zoom = 1 / (S.cam.scale * dpr());
  cam.position.x = S.cam.x;
  cam.position.y = S.cam.y;
  cam.update();
}

/** 世界座標（Y 朝上）→ overlay 裝置像素 */
function w2s(x, y) {
  const k = S.cam.scale * dpr();
  return [canvas.width / 2 + (x - S.cam.x) * k, canvas.height / 2 - (y - S.cam.y) * k];
}
/** overlay CSS 像素 → 世界座標 */
function s2w(px, py) {
  const k = S.cam.scale * dpr();
  return [(px * dpr() - canvas.width / 2) / k + S.cam.x, -(py * dpr() - canvas.height / 2) / k + S.cam.y];
}

function makeTexture(img, premultiply) {
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!premultiply);
  const t = new spine.webgl.GLTexture(mctx, img, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  return t;
}

function reuploadTexture(t, premultiply, minF, magF, uW, vW) {
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!premultiply);
  t.update(false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (minF) t.setFilters(minF, magF);
  if (uW) t.setWraps(uW, vW);
}

// ---------- 小工具 ----------
let toastTimer = 0;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), isError ? 6000 : 2500);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const getLayer = id => S.layers.find(l => l.id === id) || null;
const selLayer = () => getLayer(S.selectedId);
const baseName = p => p.slice(p.lastIndexOf('/') + 1);
const dirName = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const stem = n => n.replace(/\.[^.]+$/, '');
const extOf = n => ((n.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片讀取失敗：' + file.name));
    img.src = URL.createObjectURL(file);
  });
}

/** 讀 3.8 binary 的字串（varint 長度 + 1） */
function readBinStr(bin, o) {
  let b = bin[o++];
  let len = b & 0x7f;
  let shift = 7;
  while (b & 0x80 && shift < 35) {
    b = bin[o++];
    len |= (b & 0x7f) << shift;
    shift += 7;
  }
  if (len === 0) return [null, o];
  len--;
  return [new TextDecoder().decode(bin.subarray(o, o + len)), o + len];
}
function detectBinaryVersion(bin) {
  const ok = v => typeof v === 'string' && /^\d+\.\d+/.test(v);
  try {
    const [, o] = readBinStr(bin, 0);
    const [v] = readBinStr(bin, o);
    if (ok(v)) return v;
  } catch (e) { /* ignore */ }
  try {
    const [v] = readBinStr(bin, 8); // 4.x：hash 是 8 bytes
    if (ok(v)) return v;
  } catch (e) { /* ignore */ }
  return null;
}

// ---------- BMFont（Cocos 點陣字 .fnt 文字格式 + PNG） ----------
const BM_PREFIX = '[BMFont] ';
const bmFonts = new Map(); // 下拉顯示名稱 → 字型資料
const isBmFont = name => typeof name === 'string' && name.startsWith(BM_PREFIX);

function parseFntAttrs(line) {
  const o = {};
  const re = /(\w+)=("([^"]*)"|\S+)/g;
  let m;
  while ((m = re.exec(line))) o[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return o;
}
function parseFnt(text) {
  if (/^\s*</.test(text)) throw new Error('XML 格式的 .fnt 目前不支援，請用 BMFont 文字格式匯出');
  const f = {size: 0, lineHeight: 0, base: 0, pages: [], chars: new Map(), kerning: new Map()};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tag = line.split(/\s+/, 1)[0];
    const a = parseFntAttrs(line);
    if (tag === 'info') f.size = Math.abs(+a.size || 0);
    else if (tag === 'common') {
      f.lineHeight = +a.lineHeight || 0;
      f.base = +a.base || 0;
    } else if (tag === 'page') f.pages[+a.id || 0] = a.file;
    else if (tag === 'char') {
      f.chars.set(+a.id, {
        x: +a.x, y: +a.y, w: +a.width, h: +a.height,
        xo: +a.xoffset || 0, yo: +a.yoffset || 0, adv: +a.xadvance || 0, page: +a.page || 0,
      });
    } else if (tag === 'kerning') f.kerning.set(`${a.first},${a.second}`, +a.amount || 0);
  }
  if (!f.chars.size) throw new Error('.fnt 裡沒有任何字元');
  if (!f.size) f.size = f.lineHeight || 32;
  if (!f.lineHeight) f.lineHeight = f.size;
  return f;
}

let bmTmp = null;
let bmTint = null;
/** 在 (0,0) 置中畫點陣字；color 非白色時跟 Cocos 一樣用乘色染色 */
function drawBmText(ctx, font, text, size, color, spacingX) {
  const k = (size || font.size) / font.size;
  const lines = String(text).split('\n');
  const glyphsOf = s => {
    const out = [];
    let x = 0;
    let prev = null;
    for (const ch of s) {
      const id = ch.codePointAt(0);
      const g = font.chars.get(id);
      if (prev != null) x += (font.kerning.get(`${prev},${id}`) || 0) + spacingX;
      if (g) out.push({g, x});
      x += g ? g.adv : id === 32 ? font.size / 3 : 0;
      prev = id;
    }
    return {out, w: x};
  };
  const laid = lines.map(glyphsOf);
  const totalH = font.lineHeight * lines.length;
  const W = Math.max(1, ...laid.map(l => l.w));
  const pad = 4;
  if (!bmTmp) bmTmp = document.createElement('canvas');
  bmTmp.width = Math.ceil(W + pad * 2);
  bmTmp.height = Math.ceil(totalH + pad * 2);
  const t = bmTmp.getContext('2d');
  t.clearRect(0, 0, bmTmp.width, bmTmp.height);
  laid.forEach((l, i) => {
    const ox = pad + (W - l.w) / 2;
    const oy = pad + i * font.lineHeight;
    for (const {g, x} of l.out) {
      const img = font.images[g.page];
      if (img && g.w && g.h) t.drawImage(img, g.x, g.y, g.w, g.h, ox + x + g.xo, oy + g.yo, g.w, g.h);
    }
  });
  let src = bmTmp;
  if (color && color.toLowerCase() !== '#ffffff' && color.toLowerCase() !== '#fff') {
    // 乘色：整張一次 multiply，再用原字形當遮罩（destination-in 要整張一次套，逐字套會互相清掉）
    if (!bmTint) bmTint = document.createElement('canvas');
    bmTint.width = bmTmp.width;
    bmTint.height = bmTmp.height;
    const c = bmTint.getContext('2d');
    c.drawImage(bmTmp, 0, 0);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = color;
    c.fillRect(0, 0, bmTint.width, bmTint.height);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(bmTmp, 0, 0);
    c.globalCompositeOperation = 'source-over';
    src = bmTint;
  }
  ctx.drawImage(src, (-W / 2 - pad) * k, (-totalH / 2 - pad) * k, src.width * k, src.height * k);
}

function atlasPageNames(text) {
  const lines = text.split(/\r?\n/);
  const pages = [];
  let expectPage = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      expectPage = true;
      continue;
    }
    if (expectPage) {
      pages.push(line);
      expectPage = false;
    }
  }
  return pages;
}

// ---------- 圖層 ----------
const PERSIST_KEYS = [
  'role', 'x', 'y', 'scale', 'flipX', 'alpha', 'pma', 'texPma', 'speed', 'loop', 'skin', 'anim', 'defaultMix',
  'seq', 'seqLoopAll', 'followName', 'followPos', 'followOffX', 'followOffY', 'freeze', 'freezeTime', 'debug',
  'pins', 'tracks', 'mixes',
  'fadeOn', 'fadeClockName', 'fadeFrom', 'fadeInDelay', 'fadeInDur', 'fadeOutOn', 'fadeOutAt', 'fadeOutDur', 'fadeEase',
];

function newLayerBase(type, name) {
  return {
    id: nextId++, type, name, visible: true, role: 'normal',
    x: 0, y: 0, scale: 1, flipX: false, alpha: 1,
    pma: false, texPma: false,
    // spine
    speed: 1, loop: true, skin: null, anim: null, defaultMix: 0,
    followId: null, followName: null, followPos: true, followOffX: 0, followOffY: 0,
    freeze: false, freezeTime: 0, debug: false,
    // 定位骨頭：[{bone, x, y, on}]，x/y = sp.Skeleton 節點座標（同遊戲 convertToNodeSpaceAR 的結果）
    pins: [],
    // 多軌：第 1 軌以上同時播（第 0 軌 = 動畫 / 播放順序）。[{track, anim, loop, alpha, speed, delay, add, on}]
    tracks: [],
    // 動畫配對 mix（同 sp.Skeleton.setMix(from, to, duration)）：[{from, to, dur}]
    mixes: [],
    // 淡入淡出（＝ Cocos UIOpacity + tween）：計時用全域時鐘或某組 Spine 的動畫時間
    fadeOn: false, fadeClockName: '', fadeFrom: 0, fadeInDelay: 0, fadeInDur: 0.5,
    fadeOutOn: false, fadeOutAt: 1.5, fadeOutDur: 0.5, fadeEase: 'linear',
    seq: [], seqLoopAll: false, seqRun: null, rec: null,
    error: null, version: null, warn: null,
  };
}

function persistLayer(l) {
  const obj = pick(l, PERSIST_KEYS);
  obj.followName = l.followId ? getLayer(l.followId)?.name || null : null;
  store.set(LS_LAYER + l.name, obj);
  saveOrder();
}
let persistTimer = 0;
const persistPending = new Set();
function persistSoon(l) {
  persistPending.add(l);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    for (const x of persistPending) if (S.layers.includes(x)) persistLayer(x);
    persistPending.clear();
    saveAttachments();
  }, 300);
}
function saveOrder() {
  const prev = store.get(LS_ORDER, []);
  const names = S.layers.map(l => l.name);
  // 保留這次沒匯入、但以前排過的名稱的相對位置
  const merged = names.concat(prev.filter(n => !names.includes(n)));
  store.set(LS_ORDER, merged);
}
function saveGlobal() {
  store.set(LS_GLOBAL, pick(S, ['compare', 'overlayOpacity', 'blinkInterval', 'bg', 'grid', 'frame', 'showBoneNames']));
}
function saveAttachments() {
  const mine = S.attachments
    .map(a => ({...a, layerName: getLayer(a.layerId)?.name}))
    .filter(a => a.layerName)
    .map(a => {
      const c = {...a};
      delete c.layerId;
      return c;
    });
  // 沒匯入的圖層的掛點也留著
  const loaded = new Set(S.layers.map(l => l.name));
  const others = store.get(LS_ATT, []).filter(a => !loaded.has(a.layerName));
  store.set(LS_ATT, others.concat(mine));
}

function uniqueName(name) {
  if (!S.layers.some(l => l.name === name)) return name;
  let i = 2;
  while (S.layers.some(l => l.name === `${name} (${i})`)) i++;
  return `${name} (${i})`;
}

function applySaved(l, saved) {
  if (!saved) return;
  Object.assign(l, pick(saved, PERSIST_KEYS));
  l.seq = Array.isArray(l.seq) ? l.seq.map(s => ({anim: s.anim, times: +s.times || 0, mix: s.mix ?? ''})) : [];
  l.tracks = Array.isArray(l.tracks) ? l.tracks.map(sanitizeTrack) : [];
  l.mixes = Array.isArray(l.mixes) ? l.mixes.map(m => ({from: String(m.from || ''), to: String(m.to || ''), dur: Math.max(0, +m.dur || 0)})) : [];
  l.pins = Array.isArray(l.pins) ? l.pins.map(p => ({bone: String(p.bone), x: +p.x || 0, y: +p.y || 0, on: p.on !== false})) : [];
}

async function createSpineLayer({name, skelFile, kind, jsonText, atlasText, pageFiles}) {
  const l = newLayerBase('spine', uniqueName(name));
  applySaved(l, store.get(LS_LAYER + name, null));
  const imgs = {};
  for (const [page, file] of pageFiles) imgs[page] = await loadImage(file);
  l.pages = [];
  const atlas = new spine.TextureAtlas(atlasText, path => {
    const img = imgs[path];
    if (!img) throw new Error('atlas 列的貼圖沒匯入：' + path);
    const t = makeTexture(img, l.texPma);
    return t;
  });
  l.pages = atlas.pages;
  l.atlas = atlas;
  const loader = new spine.AtlasAttachmentLoader(atlas);
  let data;
  if (kind === 'skel') {
    const bin = new Uint8Array(await skelFile.arrayBuffer());
    l.version = detectBinaryVersion(bin);
    try {
      data = new spine.SkeletonBinary(loader).readSkeletonData(bin);
    } catch (e) {
      throw new Error(`${name}：讀取失敗（檔案版本 ${l.version || '未知'}，本工具 runtime 是 3.8）\n${e.message}`);
    }
  } else {
    const json = JSON.parse(jsonText);
    l.version = json.skeleton?.spine || null;
    try {
      data = new spine.SkeletonJson(loader).readSkeletonData(json);
    } catch (e) {
      throw new Error(`${name}：讀取失敗（檔案版本 ${l.version || '未知'}，本工具 runtime 是 3.8）\n${e.message}`);
    }
  }
  if (l.version && !/^3\.8/.test(l.version)) l.warn = `檔案版本 ${l.version}，本工具 runtime 是 3.8，顯示可能不正確`;
  setupSkeleton(l, data);
  return l;
}

function setupSkeleton(l, data) {
  l.data = data;
  l.sk = new spine.Skeleton(data);
  if (l.skin && data.findSkin(l.skin)) l.sk.setSkinByName(l.skin);
  else l.skin = data.defaultSkin ? data.defaultSkin.name : null;
  l.sk.setToSetupPose();
  l.sk.updateWorldTransform();
  const asd = new spine.AnimationStateData(data);
  l.asd = asd;
  rebuildMix(l);
  l.st = new spine.AnimationState(asd);
  l.st.addListener({complete: entry => onComplete(l, entry)});
  const first = l.anim && data.findAnimation(l.anim) ? l.anim : data.animations[0]?.name;
  if (first) playAnim(l, first);
  applyTracks(l);
}

// ---------- 多軌（第 1 軌以上，同 Cocos skeleton.setAnimation(trackIndex, name, loop)） ----------
const MAX_TRACK = 9;
/** 預設 mix ＋ 配對 mix 重新寫進 AnimationStateData（同 Cocos defaultMix / setMix） */
function rebuildMix(l) {
  if (!l.asd) return;
  l.asd.defaultMix = +l.defaultMix || 0;
  l.asd.animationToMixTime = {};
  for (const m of l.mixes || []) {
    if (m.from && m.to && l.data.findAnimation(m.from) && l.data.findAnimation(m.to)) l.asd.setMix(m.from, m.to, +m.dur || 0);
  }
}
function sanitizeTrack(t) {
  return {
    track: Math.max(1, Math.min(MAX_TRACK, Math.round(+t.track) || 1)),
    anim: String(t.anim || ''),
    loop: t.loop !== false,
    alpha: t.alpha == null || t.alpha === '' ? 1 : Math.max(0, Math.min(1, +t.alpha || 0)),
    speed: t.speed == null || t.speed === '' ? 1 : +t.speed || 0,
    delay: Math.max(0, +t.delay || 0),
    add: !!t.add,
    mix: Math.max(0, +t.mix || 0),
    on: t.on !== false,
  };
}
/** 把設定套到某一軌（從頭播）；關掉 / 沒這個動畫就清掉該軌 */
function applyTrack(l, t) {
  const anim = t.on && t.anim && l.data.findAnimation(t.anim);
  if (!anim) {
    clearExtraTrack(l, t.track);
    return null;
  }
  let e;
  if (t.mix > 0) {
    // 有 mix：空動畫 ＋ addAnimation 才會從 setup 漸進（直接 set 到空軌不會混；沒被套用過的空動畫也會被略過）
    l.st.setEmptyAnimation(t.track, 0);
    e = l.st.addAnimation(t.track, t.anim, t.loop, t.delay);
    e.delay = t.delay;
  } else {
    e = l.st.setAnimation(t.track, t.anim, t.loop);
    e.delay = t.delay;
  }
  e.mixDuration = t.mix;
  e.alpha = t.alpha;
  e.timeScale = t.speed;
  e.mixBlend = t.add ? spine.MixBlend.add : spine.MixBlend.replace;
  return e;
}
/** 清掉某一軌；骨架回 setup，第 0 軌下一幀會重新套上，只有多軌 key 的骨頭 / 插槽回原樣 */
function clearExtraTrack(l, idx, mix = 0) {
  const cur = l.st.getCurrent(idx);
  if (!cur) return;
  if (mix > 0 && cur.animation && cur.animation.name !== EMPTY) {
    l.st.setEmptyAnimation(idx, mix); // 漸出回 setup
    return;
  }
  l.st.clearTrack(idx);
  l.sk.setToSetupPose();
}
/** 全部多軌從頭（重播 / 載入時） */
function applyTracks(l) {
  const used = new Set((l.tracks || []).filter(t => t.on).map(t => t.track));
  for (let i = 1; i <= MAX_TRACK; i++) if (!used.has(i)) clearExtraTrack(l, i);
  for (const t of l.tracks || []) if (t.on) applyTrack(l, t);
}
/** 不需要重播的屬性（權重 / 速度 / 疊加 / 循環）直接改進行中的 TrackEntry */
function updateTrackLive(l, t) {
  let e = l.st.getCurrent(t.track);
  if (e && e.animation && e.animation.name === EMPTY && e.next) e = e.next; // 還在 mix 進場前
  if (!e || !e.animation || e.animation.name !== t.anim) return applyTrack(l, t);
  e.alpha = t.alpha;
  e.timeScale = t.speed;
  e.mixBlend = t.add ? spine.MixBlend.add : spine.MixBlend.replace;
  e.loop = t.loop;
  return e;
}
/** 逐格倒退 / 拖時間軸時，第 1 軌以上跟著位移 */
function shiftExtraTracks(l, delta) {
  for (let i = 1; i < l.st.tracks.length; i++) {
    const e = l.st.tracks[i];
    if (!e) continue;
    if (e.delay > 0) {
      e.delay = Math.max(0, e.delay - delta);
      continue;
    }
    e.trackTime = Math.max(0, e.trackTime + delta * (e.timeScale || 0));
  }
}

function duplicateLayer(src) {
  let l;
  if (src.type === 'spine') {
    l = newLayerBase('spine', uniqueName(src.name));
    Object.assign(l, pick(src, PERSIST_KEYS));
    l.seq = src.seq.map(s => ({...s}));
    l.pages = src.pages;
    l.atlas = src.atlas;
    l.version = src.version;
    l.warn = src.warn;
    l.followId = src.followId;
    l.x += 50;
    setupSkeleton(l, src.data);
  } else {
    l = newLayerBase('image', uniqueName(src.name));
    Object.assign(l, pick(src, PERSIST_KEYS));
    l.tex = src.tex;
    l.img = src.img;
    l.w = src.w;
    l.h = src.h;
    l.x += 50;
  }
  addLayer(l);
}

async function createImageLayer(file) {
  const name = stem(baseName(file.name));
  const l = newLayerBase('image', uniqueName(name));
  l.role = 'static';
  applySaved(l, store.get(LS_LAYER + name, null));
  l.img = await loadImage(file);
  l.tex = makeTexture(l.img, l.texPma);
  l.w = l.img.width;
  l.h = l.img.height;
  return l;
}

function addLayer(l) {
  // 照上次的順序插入
  const order = store.get(LS_ORDER, []);
  const myIdx = order.indexOf(l.name);
  let at = S.layers.length;
  if (myIdx >= 0) {
    for (let i = 0; i < S.layers.length; i++) {
      const oi = order.indexOf(S.layers[i].name);
      if (oi > myIdx) {
        at = i;
        break;
      }
    }
  }
  S.layers.splice(at, 0, l);
  // 還原掛點
  for (const a of store.get(LS_ATT, [])) {
    if (a.layerName === l.name && !S.attachments.some(x => x.uid === a.uid && x.layerId === l.id)) {
      const c = {...a, layerId: l.id};
      delete c.layerName;
      S.attachments.push(c);
    }
  }
  resolveFollows();
  selectOnly(l.id);
}

function resolveFollows() {
  for (const l of S.layers) {
    if (l.type !== 'spine') continue;
    if (!l.followId && l.followName) {
      const src = S.layers.find(x => x.type === 'spine' && x.name === l.followName && x !== l);
      if (src) l.followId = src.id;
    }
    if (l.followId && !getLayer(l.followId)) l.followId = null;
  }
}

// ---------- 選取（多選） ----------
// S.selectedId = 主選取（右側屬性面板顯示它）；S.multi = 所有被選取的圖層 id
S.multi = new Set();
S.anchorId = null;
function selectOnly(id) {
  if (S.selectedId !== id) S.selectedBone = null;
  S.selectedId = id;
  S.multi = new Set(id == null ? [] : [id]);
  S.anchorId = id;
}
function selectedLayers() {
  return S.layers.filter(l => S.multi.has(l.id));
}

function removeLayers(list) {
  const ids = new Set(list.map(l => l.id));
  if (!ids.size) return;
  const firstIdx = S.layers.findIndex(l => ids.has(l.id));
  S.layers = S.layers.filter(x => !ids.has(x.id));
  S.attachments = S.attachments.filter(a => !ids.has(a.layerId));
  for (const x of S.layers) if (ids.has(x.followId)) x.followId = null;
  for (const id of ids) S.multi.delete(id);
  if (ids.has(S.selectedId)) {
    // 選刪掉那段的下一個（沒有就上一個）
    const next = S.layers[Math.min(firstIdx, S.layers.length - 1)];
    selectOnly(next ? next.id : null);
  }
  if (ids.has(S.anchorId)) S.anchorId = S.selectedId;
  S.selectedBone = null;
  saveOrder();
  renderLayers();
  renderProps();
}
function removeLayer(l) {
  removeLayers([l]);
}
function removeSelected() {
  const list = selectedLayers();
  if (!list.length) return;
  if (list.length > 1 && !confirm(`從檢視器移除 ${list.length} 個圖層？（不會動到原始檔案）`)) return;
  removeLayers(list);
}

// ---------- 匯入 ----------
/**
 * 拖放的檔案一律用 getAsFile() 取（同步、在第一個 await 前取完，之後 DataTransfer 就失效）。
 * 只有資料夾才走 FileSystemEntry：用 file:// 開頁面時 Chrome 的 entry.file() 會丟
 * EncodingError（"A URI supplied to the API was malformed..."），檔案不能靠它。
 */
async function filesFromDataTransfer(dt) {
  const items = [...dt.items].filter(i => i.kind === 'file');
  // 全部在第一個 await 前取：getAsFileSystemHandle() 回 Promise，但要同步呼叫
  const grabbed = items.map(i => ({
    entry: i.webkitGetAsEntry ? i.webkitGetAsEntry() : null,
    handle: i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null,
    file: i.getAsFile(),
  }));
  if (!grabbed.length) return {list: [...dt.files].map(f => ({file: f, path: f.name})), hasDir: false};
  const out = [];
  let hasDir = false;
  let dirFailed = false;
  for (const g of grabbed) {
    if (g.entry && g.entry.isDirectory) {
      hasDir = true;
      // 優先用 File System Access API（file:// 下也能讀）；不支援或失敗才走舊的 entry
      const handle = g.handle ? await g.handle : null;
      try {
        if (handle && handle.kind === 'directory') await walkHandle(handle, '', out);
        else await walkEntry(g.entry, '', out);
      } catch (e) {
        console.error(e);
        dirFailed = true;
      }
    } else if (g.file) {
      out.push({file: g.file, path: g.file.name});
    }
  }
  if (dirFailed) {
    toast(
      location.protocol === 'file:'
        ? '用 file:// 開頁面時瀏覽器不允許讀拖進來的資料夾。\n請改用上方「匯入資料夾」按鈕，或選取資料夾裡的檔案直接拖進來。'
        : '資料夾讀取失敗，請改用上方「匯入資料夾」按鈕。',
      true
    );
  }
  return {list: out, hasDir};
}
async function walkHandle(dir, prefix, out) {
  const base = prefix + dir.name + '/';
  for await (const h of dir.values()) {
    if (h.kind === 'file') {
      const f = await h.getFile();
      out.push({file: f, path: base + f.name});
    } else if (h.kind === 'directory') {
      await walkHandle(h, base, out);
    }
  }
}
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    out.push({file: f, path: prefix + f.name});
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await walkEntry(e, prefix + entry.name + '/', out);
    } while (batch.length);
  }
}

/** opts.hidden：匯入的圖層預設不顯示（匯入資料夾時用，素材多時再自己勾要看的） */
async function importFiles(list, opts = {}) {
  list = list.filter(x => !/\.meta$/i.test(x.path));
  const addNew = l => {
    if (opts.hidden) l.visible = false;
    addLayer(l);
  };
  if (!list.length) return;
  const skels = [];
  const atlases = [];
  const images = [];
  const fonts = [];
  const fnts = [];
  const workspaces = [];
  for (const it of list) {
    const n = baseName(it.path).toLowerCase();
    const e = extOf(n);
    if (e === 'skel' || n.endsWith('.skel.bytes')) skels.push({...it, kind: 'skel'});
    else if (e === 'atlas' || n.endsWith('.atlas.txt')) atlases.push(it);
    else if (['png', 'jpg', 'jpeg', 'webp'].includes(e)) images.push(it);
    else if (['ttf', 'otf', 'woff', 'woff2'].includes(e)) fonts.push(it);
    else if (e === 'fnt') fnts.push(it);
    else if (e === 'json') {
      const text = await it.file.text();
      let obj = null;
      try {
        obj = JSON.parse(text);
      } catch (err) { /* not json */ }
      if (obj && obj.skeleton && obj.bones) skels.push({...it, kind: 'json', jsonText: text});
      else if (obj && obj.spineViewerWorkspace) workspaces.push(obj);
    }
  }
  for (const f of fonts) await loadFont(f.file);

  const atlasStem = a => stem(baseName(a.path).replace(/\.txt$/i, ''));
  const skelStem = s => baseName(s.path).replace(/\.skel\.bytes$/i, '').replace(/\.(skel|json)$/i, '');
  const usedImages = new Set();
  const errors = [];
  let added = 0;
  let bmLoaded = 0;
  for (const it of fnts) {
    const nm = stem(baseName(it.path));
    try {
      const font = parseFnt(await it.file.text());
      font.images = [];
      for (let p = 0; p < Math.max(1, font.pages.length); p++) {
        const page = font.pages[p] || '';
        const dir = dirName(it.path);
        const img =
          images.find(i => page && i.path === dir + page) ||
          images.find(i => page && baseName(i.path) === baseName(page)) ||
          // .fnt 寫的檔名跟實際 PNG 不同時（例如寫 X_0.png、實際是 X.png），同資料夾同名 PNG 當第一頁
          (p === 0 ? images.find(i => dirName(i.path) === dir && stem(baseName(i.path)) === nm) : null);
        if (!img) throw new Error(`缺貼圖 ${page || nm + '.png'}`);
        usedImages.add(img);
        font.images[p] = await loadImage(img.file);
      }
      const label = BM_PREFIX + nm;
      bmFonts.set(label, font);
      if (!S.fonts.includes(label)) S.fonts.push(label);
      bmLoaded++;
    } catch (e) {
      errors.push(`${nm}.fnt：${e.message}`);
    }
  }
  for (const s of skels) {
    const st = skelStem(s);
    const atlas =
      atlases.find(a => atlasStem(a) === st && dirName(a.path) === dirName(s.path)) ||
      atlases.find(a => atlasStem(a) === st) ||
      (atlases.length === 1 ? atlases[0] : null);
    if (!atlas) {
      errors.push(`${st}：找不到同名 .atlas`);
      continue;
    }
    const atlasText = await atlas.file.text();
    const pageFiles = [];
    const missing = [];
    for (const page of atlasPageNames(atlasText)) {
      const want = dirName(atlas.path) + page;
      const img =
        images.find(i => i.path === want) ||
        images.find(i => baseName(i.path) === baseName(page) && dirName(i.path) === dirName(atlas.path)) ||
        images.find(i => baseName(i.path) === baseName(page));
      if (img) {
        pageFiles.push([page, img.file]);
        usedImages.add(img);
      } else missing.push(page);
    }
    if (missing.length) {
      errors.push(`${st}：缺貼圖 ${missing.join(', ')}`);
      continue;
    }
    try {
      const l = await createSpineLayer({name: st, skelFile: s.file, kind: s.kind, jsonText: s.jsonText, atlasText, pageFiles});
      addNew(l);
      added++;
    } catch (e) {
      console.error(e);
      errors.push(e.message);
    }
  }
  const loose = images.filter(i => !usedImages.has(i));
  // 整個資料夾拖進來時，atlas 用不到的 PNG 太多就先問
  if (loose.length && (loose.length <= 12 || confirm(`有 ${loose.length} 張沒被 atlas 用到的圖片，要全部加成圖片圖層嗎？`))) {
    for (const i of loose) {
      try {
        addNew(await createImageLayer(i.file));
        added++;
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  for (const ws of workspaces) applyWorkspace(ws);
  renderLayers();
  renderProps();
  if (errors.length) toast(errors.join('\n'), true);
  else if (added) toast(opts.hidden ? `已匯入 ${added} 個圖層（資料夾匯入預設全關，勾選要看的）` : `已匯入 ${added} 個圖層`);
  else if (fonts.length || bmLoaded) toast(`已載入字型 ${fonts.length + bmLoaded} 個${bmLoaded ? `（點陣字 ${bmLoaded}）` : ''}，在掛點的「字型」選`);
}

async function loadFont(file) {
  const fam = stem(baseName(file.name));
  try {
    const ff = new FontFace(fam, await file.arrayBuffer());
    await ff.load();
    document.fonts.add(ff);
    if (!S.fonts.includes(fam)) S.fonts.push(fam);
  } catch (e) {
    toast('字型載入失敗：' + file.name, true);
  }
}

// ---------- 播放 ----------
function playAnim(l, name, opts = {}) {
  if (l.type !== 'spine' || !l.data.findAnimation(name)) return null;
  const loop = opts.loop ?? l.loop;
  const e = l.st.setAnimation(0, name, loop);
  if (opts.mix != null && opts.mix !== '') e.mixDuration = +opts.mix;
  l.anim = name;
  return e;
}

function restartLayer(l) {
  if (l.type !== 'spine' || l.followId) return;
  if (l.seq.length && (l.seqRun || l.seqWasPlaying)) {
    seqPlay(l);
    return;
  }
  const cur = l.st.getCurrent(0);
  if (cur && cur.animation && cur.animation.name !== EMPTY) {
    const e = playAnim(l, cur.animation.name, {loop: cur.loop, mix: 0});
    if (e) e.trackTime = 0;
  } else if (l.anim) playAnim(l, l.anim, {mix: 0});
}

function restartAll() {
  for (const l of S.layers) restartLayer(l);
  for (const l of S.layers) if (l.type === 'spine') applyTracks(l);
  // 跟隨者重新對齊
  for (const l of S.layers) if (l.followId) l._srcEntry = null;
  S.blinkT = 0;
  S.blinkPhase = false;
  S.clock = 0;
}

// ---------- 播放順序 ----------
function seqPlay(l) {
  if (!l.seq.length) return;
  stopRecording(l, false);
  l.seqRun = {i: 0, count: 0, entry: null};
  l.seqWasPlaying = true;
  seqStart(l);
}
function seqStart(l) {
  const r = l.seqRun;
  if (!r) return;
  let guard = 0;
  while (guard++ <= l.seq.length) {
    const step = l.seq[r.i];
    if (!step) {
      if (l.seqLoopAll && l.seq.length) {
        r.i = 0;
        continue;
      }
      l.seqRun = null;
      renderSeqHighlight();
      return;
    }
    if (!l.data.findAnimation(step.anim)) {
      toast(`${l.name}：沒有動畫 ${step.anim}，跳過`, true);
      r.i++;
      continue;
    }
    r.count = 0;
    r.entry = playAnim(l, step.anim, {loop: +step.times !== 1, mix: step.mix});
    renderSeqHighlight();
    refreshAnimHighlight();
    return;
  }
}
function seqNext(l) {
  const r = l.seqRun;
  if (!r) return;
  const isLast = r.i >= l.seq.length - 1;
  if (isLast && !l.seqLoopAll) {
    if (r.entry) r.entry.loop = false; // 停在最後一格
    l.seqRun = null;
    renderSeqHighlight();
    return;
  }
  r.i = isLast ? 0 : r.i + 1;
  seqStart(l);
}
function seqStop(l) {
  l.seqRun = null;
  l.seqWasPlaying = false;
  renderSeqHighlight();
}
function onComplete(l, entry) {
  // 錄製：數這段播了幾次
  if (l.rec && l.rec.entry === entry) l.rec.count++;
  const r = l.seqRun;
  if (!r || entry !== r.entry) return;
  r.count++;
  const step = l.seq[r.i];
  if (step && +step.times > 0 && r.count >= +step.times) seqNext(l);
}

function startRecording(l) {
  seqStop(l);
  l.seq = [];
  l.rec = {entry: null, count: 0};
  toast('錄製中：依序點動畫，再按一次「⏺」結束');
}
function recordClick(l, name) {
  finishRecStep(l);
  const e = playAnim(l, name, {loop: true});
  l.seq.push({anim: name, times: 1, mix: ''});
  l.rec.entry = e;
  l.rec.count = 0;
}
function finishRecStep(l) {
  const rec = l.rec;
  if (!rec || !rec.entry || !l.seq.length) return;
  const e = rec.entry;
  const dur = e.animationEnd - e.animationStart;
  // 停在中途也算一次（最少 1 次）
  const times = Math.max(1, rec.count + (dur > 0 && e.trackTime - rec.count * dur > dur * 0.5 ? 1 : 0));
  l.seq[l.seq.length - 1].times = times;
}
function stopRecording(l, announce = true) {
  if (!l.rec) return;
  finishRecStep(l);
  l.rec = null;
  persistLayer(l);
  if (announce) toast(`已記錄 ${l.seq.length} 段`);
}

// ---------- 跟隨 ----------
function followDepth(l, seen = new Set()) {
  if (!l.followId || seen.has(l.id)) return 0;
  seen.add(l.id);
  const src = getLayer(l.followId);
  return src ? 1 + followDepth(src, seen) : 0;
}
function syncFollow(l, src) {
  const se = src.st.getCurrent(0);
  const fe = l.st.getCurrent(0);
  const name = se && se.animation ? se.animation.name : null;
  if (!name || name === EMPTY || !l.data.findAnimation(name)) {
    if (fe && fe.animation && fe.animation.name !== EMPTY) l.st.setEmptyAnimation(0, 0);
    l.followMissing = name && name !== EMPTY ? name : null;
    l._srcEntry = se;
    return;
  }
  l.followMissing = null;
  let e = fe;
  if (se !== l._srcEntry || !fe || !fe.animation || fe.animation.name !== name) {
    e = l.st.setAnimation(0, name, se.loop);
    e.mixDuration = se.mixDuration;
    l._srcEntry = se;
    l.anim = name;
  }
  e.loop = se.loop;
  e.trackTime = se.trackTime;
  e.timeScale = se.timeScale;
}

/** 圖層實際位置 / 縮放（跟隨時取對方的） */
function layerXform(l) {
  if (l.followId && l.followPos) {
    const src = getLayer(l.followId);
    if (src) {
      const p = layerXform(src);
      return {x: p.x + (+l.followOffX || 0), y: p.y + (+l.followOffY || 0), scale: p.scale, flipX: p.flipX};
    }
  }
  return {x: +l.x || 0, y: +l.y || 0, scale: +l.scale || 0, flipX: !!l.flipX};
}

/** 圖層目前畫面上的範圍（世界座標）；Spine 用當下姿勢的 bounding box */
const bVec = [new spine.Vector2(), new spine.Vector2()];
function layerBounds(l) {
  if (l.type === 'spine') {
    if (!l.sk) return null;
    l.sk.getBounds(bVec[0], bVec[1], []);
    if (!isFinite(bVec[0].x) || !isFinite(bVec[1].x) || bVec[1].x <= 0) return null;
    return {x0: bVec[0].x, y0: bVec[0].y, x1: bVec[0].x + bVec[1].x, y1: bVec[0].y + bVec[1].y};
  }
  const p = layerXform(l);
  const w = Math.abs(l.w * p.scale);
  const h = Math.abs(l.h * p.scale);
  return {x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2};
}
/** 點到的圖層：已選取的優先，其次取範圍最小的（避免大範圍特效蓋住底下的圖） */
function pickLayer(wx, wy) {
  let best = null;
  let bestKey = Infinity;
  for (const l of S.layers) {
    if (!roleVisible(l)) continue;
    const b = layerBounds(l);
    if (!b || wx < b.x0 || wx > b.x1 || wy < b.y0 || wy > b.y1) continue;
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    const key = S.multi.has(l.id) ? -1e15 + area : area;
    if (key <= bestKey) {
      best = l;
      bestKey = key;
    }
  }
  return best;
}
const dragPos = l => {
  const p = layerXform(l);
  return l.followId && l.followPos ? [+l.followOffX || 0, +l.followOffY || 0] : [p.x, p.y];
};

// ---------- 每幀 ----------
function tick(dt, realDt) {
  S.blinkT += realDt;
  if (S.compare === 'blink' && S.blinkT >= (+S.blinkInterval || 0.5)) {
    S.blinkT = 0;
    S.blinkPhase = !S.blinkPhase;
  }
  S.clock += dt;
  const spines = S.layers.filter(l => l.type === 'spine').sort((a, b) => followDepth(a) - followDepth(b));
  for (const l of spines) {
    const src = l.followId ? getLayer(l.followId) : null;
    if (src && src.type === 'spine') {
      l.st.update(dt * (+src.speed || 0));
      syncFollow(l, src);
    } else if (l.freeze) {
      const ft = +l.freezeTime || 0;
      const e = l.st.getCurrent(0);
      if (e) e.trackTime = ft;
      for (const t of l.tracks || []) {
        const te = t.on ? l.st.getCurrent(t.track) : null;
        if (!te) continue;
        te.delay = 0;
        te.trackTime = Math.max(0, (ft - t.delay) * t.speed);
      }
      l.st.update(0);
    } else {
      l.st.update(dt * (+l.speed || 0));
    }
    const p = layerXform(l);
    l.sk.x = p.x;
    l.sk.y = p.y;
    l.sk.scaleX = p.scale * (p.flipX ? -1 : 1);
    l.sk.scaleY = p.scale;
    l.st.apply(l.sk);
    l.sk.updateWorldTransform();
    applyPins(l);
  }
}

// ---------- 定位骨頭（模擬程式在執行期把骨頭擺到某處，例如飛行軌跡動畫的終點骨頭） ----------
const skelToWorld = (l, x, y) => [l.sk.x + x * l.sk.scaleX, l.sk.y + y * l.sk.scaleY];
const worldToSkel = (l, wx, wy) => [(wx - l.sk.x) / (l.sk.scaleX || 1), (wy - l.sk.y) / (l.sk.scaleY || 1)];
const boneDepth = b => {
  let d = 0;
  for (let p = b.parent; p; p = p.parent) d++;
  return d;
};
const pinVec = new spine.Vector2();
/** 動畫套完後把骨頭蓋到指定位置（每幀都蓋，動畫有 key 也一樣），子骨頭、約束跟著重算 */
function applyPins(l) {
  const pins = (l.pins || []).filter(p => p.on);
  if (!pins.length) return;
  const list = pins
    .map(p => ({p, b: l.sk.findBone(p.bone)}))
    .filter(x => x.b)
    .sort((a, b) => boneDepth(a.b) - boneDepth(b.b));
  for (const {p, b} of list) {
    const [wx, wy] = skelToWorld(l, +p.x || 0, +p.y || 0);
    if (b.parent) {
      pinVec.set(wx, wy);
      b.parent.worldToLocal(pinVec);
      b.x = pinVec.x;
      b.y = pinVec.y;
    } else {
      b.x = +p.x || 0;
      b.y = +p.y || 0;
    }
    l.sk.updateWorldTransform();
  }
}
/** 畫面上的定位點（CSS 像素）附近 → {l, i} */
function pickPin(px, py) {
  const d = dpr();
  let best = null;
  let bestDist = 12 * d;
  for (const l of S.layers) {
    if (l.type !== 'spine' || !roleVisible(l)) continue;
    (l.pins || []).forEach((p, i) => {
      if (!p.on) return;
      const [x, y] = w2s(...skelToWorld(l, +p.x || 0, +p.y || 0));
      const dist = Math.hypot(x - px * d, y - py * d);
      if (dist < bestDist) {
        bestDist = dist;
        best = {l, i};
      }
    });
  }
  return best;
}

function roleVisible(l) {
  if (!l.visible) return false;
  if (l.role === 'normal') return true;
  switch (S.compare) {
    case 'static':
      return l.role === 'static';
    case 'dynamic':
      return l.role === 'dynamic';
    case 'blink':
      return (S.blinkPhase ? 'static' : 'dynamic') === l.role;
    default:
      return true;
  }
}

// ---------- 淡入淡出 ----------
const EASES = {
  linear: t => t,
  quadIn: t => t * t,
  quadOut: t => t * (2 - t),
  quadInOut: t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  sineInOut: t => (1 - Math.cos(Math.PI * t)) / 2,
  cubicOut: t => 1 - (1 - t) ** 3,
};
const clamp01 = v => Math.max(0, Math.min(1, v));
/** 淡入淡出用的時間：全域時鐘，或指定 Spine 第 0 軌目前動畫播了多久（換動畫 / 重播會歸零） */
function fadeClock(l) {
  if (!l.fadeClockName) return S.clock;
  const src = S.layers.find(x => x.type === 'spine' && x.name === l.fadeClockName);
  const e = src?.st.getCurrent(0);
  return e ? e.trackTime : 0;
}
/** 0~1，乘在圖層透明度上；淡出是從當下的值再乘到 0（同 Cocos 對 UIOpacity tween） */
function fadeAlpha(l) {
  if (!l.fadeOn) return 1;
  const t = fadeClock(l);
  const ease = EASES[l.fadeEase] || EASES.linear;
  const from = clamp01(+l.fadeFrom || 0);
  const d = +l.fadeInDelay || 0;
  const dur = Math.max(0, +l.fadeInDur || 0);
  let a = t < d ? from : dur <= 0 || t >= d + dur ? 1 : from + (1 - from) * ease((t - d) / dur);
  if (l.fadeOutOn) {
    const o = +l.fadeOutAt || 0;
    const od = Math.max(0, +l.fadeOutDur || 0);
    if (t >= o) a *= 1 - ease(od <= 0 ? 1 : Math.min(1, (t - o) / od));
  }
  return clamp01(a);
}
const layerAlpha = l => clamp01(+l.alpha) * fadeAlpha(l);

const tmpColor = new spine.Color();
function drawLayer(l, alphaMul) {
  if (l.type === 'spine') {
    l.sk.color.a = layerAlpha(l) * alphaMul;
    renderer.drawSkeleton(l.sk, l.pma);
  } else {
    const p = layerXform(l);
    const w = l.w * p.scale * (p.flipX ? -1 : 1);
    const h = l.h * p.scale;
    renderer.enableRenderer(renderer.batcher);
    renderer.batcher.setBlendMode(l.pma ? gl.ONE : gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const a = layerAlpha(l) * alphaMul;
    tmpColor.set(l.pma ? a : 1, l.pma ? a : 1, l.pma ? a : 1, a);
    renderer.drawTexture(l.tex, p.x - w / 2, p.y - h / 2, w, h, tmpColor);
  }
}

const gridColor = new spine.Color(1, 1, 1, 0.07);
const axisColor = new spine.Color(1, 1, 1, 0.28);
const frameColor = new spine.Color(1, 0.8, 0.2, 0.7);
function drawGrid() {
  const [x0, y1] = s2w(0, 0);
  const r = canvas.getBoundingClientRect();
  const [x1, y0] = s2w(r.width, r.height);
  let step = 100;
  while (step * S.cam.scale < 25) step *= 2;
  while (step * S.cam.scale > 200) step /= 2;
  if (S.grid) {
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) renderer.line(x, y0, x, y1, gridColor);
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) renderer.line(x0, y, x1, y, gridColor);
  }
  renderer.line(x0, 0, x1, 0, axisColor);
  renderer.line(0, y0, 0, y1, axisColor);
  if (S.frame) {
    const [fw, fh] = S.frame.split('x').map(Number);
    renderer.rect(false, -fw / 2, -fh / 2, fw, fh, frameColor);
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function render() {
  resize();
  const [r, g, b] = hexToRgb(S.bg);
  gl.clearColor(r, g, b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.begin();
  drawGrid();
  const overlayMode = S.compare === 'overlay';
  for (const l of S.layers) {
    if (!roleVisible(l)) continue;
    if (overlayMode && l.role === 'static') continue; // 疊圖：靜態最後畫
    drawLayer(l, 1);
  }
  if (overlayMode) for (const l of S.layers) if (roleVisible(l) && l.role === 'static') drawLayer(l, +S.overlayOpacity);
  for (const l of S.layers) if (l.type === 'spine' && l.debug && l.visible) renderer.drawSkeletonDebug(l.sk, false);
  renderer.end();
  drawOverlay();
}

function drawOverlay() {
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const k = S.cam.scale * dpr();
  // 掛點
  for (const a of S.attachments) {
    const l = getLayer(a.layerId);
    if (!l || l.type !== 'spine' || !a.visible || !roleVisible(l)) continue;
    const bone = l.sk.findBone(a.bone);
    if (!bone) continue;
    const [sx, sy] = w2s(bone.worldX, bone.worldY);
    const rot = a.followRot ? bone.getWorldRotationX() : 0;
    const sc = (a.followScale ? bone.getWorldScaleX() : Math.abs(layerXform(l).scale)) * (+a.scale || 1);
    octx.save();
    octx.translate(sx, sy);
    octx.rotate((-rot * Math.PI) / 180);
    octx.scale(sc * k, sc * k);
    octx.translate(+a.dx || 0, -(+a.dy || 0));
    octx.globalAlpha = clamp01(+(a.opacity ?? 1)) * layerAlpha(l);
    const bm = isBmFont(a.font) ? bmFonts.get(a.font) : null;
    if (bm) {
      drawBmText(octx, bm, a.text, +a.size || bm.size, a.color, +a.spacingX || 0);
      octx.restore();
      continue;
    }
    octx.font = `${a.bold ? 'bold ' : ''}${+a.size || 40}px "${a.font || 'sans-serif'}"`;
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    if (+a.stroke > 0) {
      octx.lineJoin = 'round';
      octx.lineWidth = +a.stroke;
      octx.strokeStyle = a.strokeColor || '#000';
      octx.strokeText(a.text, 0, 0);
    }
    octx.fillStyle = a.color || '#fff';
    octx.fillText(a.text, 0, 0);
    octx.restore();
  }
  // 選取圖層的外框
  octx.save();
  octx.setLineDash([6 * dpr(), 4 * dpr()]);
  octx.lineWidth = dpr();
  for (const l of S.layers) {
    if (!S.multi.has(l.id) || !roleVisible(l)) continue;
    const b = layerBounds(l);
    if (!b) continue;
    const [ax, ay] = w2s(b.x0, b.y1);
    const [bx, by] = w2s(b.x1, b.y0);
    octx.strokeStyle = l.id === S.selectedId ? 'rgba(78,161,255,.95)' : 'rgba(78,161,255,.55)';
    octx.strokeRect(ax, ay, bx - ax, by - ay);
  }
  octx.restore();
  // 定位點
  octx.save();
  octx.font = `bold ${11 * dpr()}px sans-serif`;
  octx.textAlign = 'left';
  octx.textBaseline = 'middle';
  for (const l of S.layers) {
    if (l.type !== 'spine' || !roleVisible(l)) continue;
    for (const p of l.pins || []) {
      if (!p.on) continue;
      const [x, y] = w2s(...skelToWorld(l, +p.x || 0, +p.y || 0));
      const r = 8 * dpr();
      octx.lineWidth = 2 * dpr();
      octx.strokeStyle = '#000';
      octx.beginPath();
      octx.arc(x, y, r, 0, Math.PI * 2);
      octx.stroke();
      octx.strokeStyle = '#ff5fd2';
      octx.lineWidth = 1.5 * dpr();
      octx.beginPath();
      octx.arc(x, y, r, 0, Math.PI * 2);
      octx.moveTo(x - r * 1.6, y);
      octx.lineTo(x + r * 1.6, y);
      octx.moveTo(x, y - r * 1.6);
      octx.lineTo(x, y + r * 1.6);
      octx.stroke();
      const label = `${p.bone} (${Math.round(p.x)}, ${Math.round(p.y)})`;
      octx.lineWidth = 3 * dpr();
      octx.strokeStyle = 'rgba(0,0,0,.8)';
      octx.strokeText(label, x + r + 4 * dpr(), y - r);
      octx.fillStyle = '#ff9be6';
      octx.fillText(label, x + r + 4 * dpr(), y - r);
    }
  }
  octx.restore();
  // 骨骼名稱 / 選取骨頭
  const sl = selLayer();
  octx.font = `${11 * dpr()}px sans-serif`;
  octx.textAlign = 'left';
  octx.textBaseline = 'bottom';
  for (const l of S.layers) {
    if (l.type !== 'spine' || !l.debug || !l.visible || !S.showBoneNames) continue;
    octx.fillStyle = 'rgba(255,220,120,.85)';
    for (const bone of l.sk.bones) {
      const [x, y] = w2s(bone.worldX, bone.worldY);
      octx.fillText(bone.data.name, x + 4, y - 2);
    }
  }
  if (sl && sl.type === 'spine' && S.selectedBone) {
    const bone = sl.sk.findBone(S.selectedBone);
    if (bone) {
      const [x, y] = w2s(bone.worldX, bone.worldY);
      octx.strokeStyle = '#4ea1ff';
      octx.lineWidth = 2 * dpr();
      octx.beginPath();
      octx.arc(x, y, 7 * dpr(), 0, Math.PI * 2);
      octx.stroke();
      octx.fillStyle = '#4ea1ff';
      octx.font = `bold ${12 * dpr()}px sans-serif`;
      octx.fillText(bone.data.name, x + 9 * dpr(), y - 6 * dpr());
    }
  }
  // 選取的圖片圖層外框
  if (sl && sl.type === 'image' && sl.visible) {
    const p = layerXform(sl);
    const [x0, y0] = w2s(p.x - (sl.w * p.scale) / 2, p.y + (sl.h * p.scale) / 2);
    octx.strokeStyle = 'rgba(78,161,255,.6)';
    octx.lineWidth = 1 * dpr();
    octx.setLineDash([4 * dpr(), 4 * dpr()]);
    octx.strokeRect(x0, y0, sl.w * p.scale * k, sl.h * p.scale * k);
    octx.setLineDash([]);
  }
}

// ---------- 迴圈 ----------
let last = performance.now() / 1000;
let fpsAcc = 0;
let fpsN = 0;
let fps = 0;
function frame() {
  const now = performance.now() / 1000;
  const realDt = Math.min(now - last, 0.1);
  last = now;
  fpsAcc += realDt;
  fpsN++;
  if (fpsAcc >= 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  try {
    tick(S.paused ? 0 : realDt * S.speed, realDt);
    render();
    updateTimeline();
    updateStatus();
    updateLiveProps();
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(frame);
}

function stepFrames(n) {
  S.paused = true;
  updatePlayBtn();
  if (n > 0) {
    tick(n / FPS, 0);
    return;
  }
  S.clock = Math.max(0, S.clock + n / FPS);
  // 往回：AnimationState.update 不能給負值，直接改 trackTime（跟隨者下一幀會對齊）
  for (const l of S.layers) {
    if (l.type !== 'spine' || l.freeze) continue;
    const src = l.followId ? getLayer(l.followId) : l;
    shiftExtraTracks(l, (n / FPS) * (+src?.speed || 0));
  }
  for (const l of S.layers) {
    if (l.type !== 'spine' || l.followId) continue;
    const e = l.st.getCurrent(0);
    if (!e) continue;
    e.trackTime = Math.max(0, e.trackTime + n / FPS);
    if (l.freeze) l.freezeTime = +e.trackTime.toFixed(3);
  }
  tick(0, 0);
}

// ---------- UI：圖層列表 ----------
function renderLayers() {
  const ul = $('#layerList');
  $('#layerHint').style.display = S.layers.length ? 'none' : '';
  ul.innerHTML = S.layers
    .map(l => {
      const tags = [];
      if (l.type === 'image') tags.push('<span class="tag img">圖</span>');
      if (l.role === 'static') tags.push('<span class="tag static">靜</span>');
      if (l.role === 'dynamic') tags.push('<span class="tag dynamic">動</span>');
      if (l.followId) tags.push(`<span class="tag follow" title="跟隨 ${esc(getLayer(l.followId)?.name || '')}">跟</span>`);
      if (l.warn) tags.push(`<span class="tag err" title="${esc(l.warn)}">!</span>`);
      const cls = [S.multi.has(l.id) ? 'sel' : '', l.id === S.selectedId ? 'main-sel' : ''].join(' ');
      return `<li data-id="${l.id}" class="${cls}">
        <input type="checkbox" data-act="vis" ${l.visible ? 'checked' : ''} title="顯示">
        <span class="nm" title="${esc(l.name)}">${esc(l.name)}</span>${tags.join('')}
        <button class="ic" data-act="up" title="往下畫（上移）">▲</button>
        <button class="ic" data-act="down" title="往上畫（下移）">▼</button>
        <button class="ic" data-act="dup" title="複製一份">⧉</button>
        <button class="ic" data-act="del" title="移除">✕</button>
      </li>`;
    })
    .join('');
  const n = S.multi.size;
  const del = $('#btnDelSel');
  del.disabled = !n;
  del.textContent = n > 1 ? `刪除選取（${n}）` : '刪除選取';
  const show = $('#btnShowSel');
  show.disabled = !n;
  show.textContent = n > 1 ? `顯示選取（${n}）` : '顯示選取';
}

function setAllVisible(v) {
  for (const l of S.layers) l.visible = v;
  renderLayers();
}
$('#btnShowAll').onclick = () => setAllVisible(true);
$('#btnHideAll').onclick = () => setAllVisible(false);
$('#btnDelSel').onclick = removeSelected;
$('#btnShowSel').onclick = () => {
  for (const l of selectedLayers()) l.visible = true;
  renderLayers();
};

$('#layerList').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  const l = getLayer(+li.dataset.id);
  if (!l) return;
  const act = e.target.dataset.act;
  const inMulti = S.multi.has(l.id) && S.multi.size > 1;
  if (act === 'vis') {
    // 勾選的是多選中的一項 → 整批一起
    if (inMulti) {
      for (const x of selectedLayers()) x.visible = e.target.checked;
      renderLayers();
    } else l.visible = e.target.checked;
    return;
  }
  if (act === 'del' && inMulti) {
    removeSelected();
    return;
  }
  if (act === 'up' || act === 'down') {
    const i = S.layers.indexOf(l);
    const j = act === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < S.layers.length) {
      [S.layers[i], S.layers[j]] = [S.layers[j], S.layers[i]];
      saveOrder();
    }
  } else if (act === 'dup') {
    duplicateLayer(l);
  } else if (act === 'del') {
    removeLayer(l);
    return;
  } else if (e.shiftKey) {
    // 從錨點到這一項整段選起來（Ctrl+Shift = 加到現有選取）
    const ids = S.layers.map(x => x.id);
    let a = ids.indexOf(S.anchorId);
    if (a < 0) a = ids.indexOf(l.id);
    const b = ids.indexOf(l.id);
    const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    if (!(e.ctrlKey || e.metaKey)) S.multi = new Set();
    for (const id of range) S.multi.add(id);
    if (S.selectedId !== l.id) S.selectedBone = null;
    S.selectedId = l.id;
  } else if (e.ctrlKey || e.metaKey) {
    if (S.multi.has(l.id)) {
      S.multi.delete(l.id);
      if (S.selectedId === l.id) {
        S.selectedId = [...S.multi].pop() ?? null;
        S.selectedBone = null;
      }
    } else {
      S.multi.add(l.id);
      if (S.selectedId !== l.id) S.selectedBone = null;
      S.selectedId = l.id;
    }
    S.anchorId = l.id;
  } else {
    selectOnly(l.id);
  }
  renderLayers();
  renderProps();
});

// ---------- 自動對位（拿 Layout 圖比對，找元件該在的位置） ----------
// 做法：把元件「目前這一格」單獨畫到 FBO（世界 1:1）→ 取不透明的像素當樣板 →
// 在 Layout 圖上、目前位置 ±範圍內找 NCC（正規化相關）最高的位置；先 1/4 解析度粗找再全解析度細修，可選順便找縮放。
S.alignRefId = null;
S.alignRefAuto = true; // 使用者沒選過 → 永遠用最大張的圖片當參考
S.alignRange = 200;
S.alignScale = false;
S.alignUndo = [];
const ALIGN_MAX_SIDE = 768; // 樣板最大邊（像素）；元件比這大就降解析度比對
const ALIGN_COARSE = 4;
const ALIGN_MAX_PTS = 6000; // 細修用的樣板點上限
const ALIGN_MAX_PTS_COARSE = 800; // 粗找用

/** 單獨把圖層畫到離屏 framebuffer；回傳 {x0, y0, w, h, k(像素/世界單位), data(RGBA，由下往上)} */
function renderLayerAlone(l, maxSide = ALIGN_MAX_SIDE) {
  const b = layerBounds(l);
  if (!b) return null;
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  if (!(bw > 1 && bh > 1)) return null;
  const k = Math.min(1, maxSide / Math.max(bw, bh));
  const w = Math.max(1, Math.ceil(bw * k));
  const h = Math.max(1, Math.ceil(bh * k));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const data = new Uint8Array(w * h * 4);
  const saved = {alpha: l.alpha, fadeOn: l.fadeOn};
  try {
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const cam = renderer.camera;
    cam.setViewport(w, h);
    cam.zoom = 1 / k;
    cam.position.x = b.x0 + w / k / 2;
    cam.position.y = b.y0 + h / k / 2;
    l.alpha = 1;
    l.fadeOn = false;
    renderer.begin();
    drawLayer(l, 1);
    renderer.end();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  } finally {
    Object.assign(l, saved);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    resize();
  }
  return {x0: b.x0, y0: b.y0, w, h, k, data};
}

/** 圖片圖層的像素（快取） */
function imagePixels(l) {
  if (l._pix && l._pix.img === l.img) return l._pix;
  const c = document.createElement('canvas');
  c.width = l.w;
  c.height = l.h;
  const cx = c.getContext('2d', {willReadFrequently: true});
  cx.drawImage(l.img, 0, 0);
  l._pix = {img: l.img, data: cx.getImageData(0, 0, l.w, l.h).data};
  return l._pix;
}

/** 把 Layout 圖取樣到世界座標的格子（k 像素/單位）；圖外補中灰 */
function rasterizeRef(ref, gx0, gy0, gw, gh, k) {
  const pix = imagePixels(ref).data;
  const rp = layerXform(ref);
  const sx = rp.scale * (rp.flipX ? -1 : 1);
  const out = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) {
    const wy = gy0 + (gy + 0.5) / k;
    const py = Math.floor(ref.h / 2 - (wy - rp.y) / rp.scale);
    for (let gx = 0; gx < gw; gx++) {
      const wx = gx0 + (gx + 0.5) / k;
      const px = Math.floor((wx - rp.x) / sx + ref.w / 2);
      const o = (gy * gw + gx) * 3;
      if (px < 0 || py < 0 || px >= ref.w || py >= ref.h) {
        out[o] = out[o + 1] = out[o + 2] = 128;
        continue;
      }
      const i = (py * ref.w + px) * 4;
      const a = pix[i + 3] / 255;
      // 透明處當中灰，避免 Layout 圖的透明區被當成黑色
      out[o] = pix[i] * a + 128 * (1 - a);
      out[o + 1] = pix[i + 1] * a + 128 * (1 - a);
      out[o + 2] = pix[i + 2] * a + 128 * (1 - a);
    }
  }
  return out;
}

function downsampleGrid(g, gw, gh, f) {
  const w = Math.floor(gw / f);
  const h = Math.floor(gh / f);
  const out = new Float32Array(w * h * 3);
  const n = f * f;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, gg = 0, b = 0;
      for (let yy = 0; yy < f; yy++)
        for (let xx = 0; xx < f; xx++) {
          const i = ((y * f + yy) * gw + x * f + xx) * 3;
          r += g[i];
          gg += g[i + 1];
          b += g[i + 2];
        }
      const o = (y * w + x) * 3;
      out[o] = r / n;
      out[o + 1] = gg / n;
      out[o + 2] = b / n;
    }
  return {g: out, w, h};
}

/** 樣板點：{u, v（相對圖層原點，格子單位，含像素中心 0.5）, 值（零均值、單位長度）} */
function templatePoints(tpl, originX, originY, f, maxPts) {
  const {w, h, k, data, x0, y0} = tpl;
  const offU = (x0 - originX) * k;
  const offV = (y0 - originY) * k;
  const pts = [];
  const bw = Math.floor(w / f);
  const bh = Math.floor(h / f);
  const need = f === 1 ? 1 : Math.ceil(f * f * 0.75);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let yy = 0; yy < f; yy++)
        for (let xx = 0; xx < f; xx++) {
          const i = ((by * f + yy) * w + bx * f + xx) * 4;
          if (data[i + 3] < 200) continue; // 只拿幾乎不透明的像素（半透明光暈會跟背景混色）
          n++;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      if (n < need) continue;
      pts.push({u: (offU + (bx + 0.5) * f) / f, v: (offV + (by + 0.5) * f) / f, r: r / n, g: g / n, b: b / n});
    }
  // 太多點就均勻抽樣
  let list = pts;
  if (pts.length > maxPts) {
    const step = pts.length / maxPts;
    list = [];
    for (let i = 0; i < maxPts; i++) list.push(pts[Math.floor(i * step)]);
  }
  const N = list.length * 3;
  let mean = 0;
  for (const p of list) mean += p.r + p.g + p.b;
  mean /= N || 1;
  let ss = 0;
  for (const p of list) ss += (p.r - mean) ** 2 + (p.g - mean) ** 2 + (p.b - mean) ** 2;
  const norm = Math.sqrt(ss) || 1;
  const n = list.length;
  const U = new Float32Array(n), V = new Float32Array(n), T = new Float32Array(n * 3);
  list.forEach((p, i) => {
    U[i] = p.u;
    V[i] = p.v;
    T[i * 3] = (p.r - mean) / norm;
    T[i * 3 + 1] = (p.g - mean) / norm;
    T[i * 3 + 2] = (p.b - mean) / norm;
  });
  return {n, U, V, T, flat: ss / (N || 1) < 25}; // 樣板幾乎單色 → 比對不可靠
}

/** 原點落在格子 (ox, oy)、縮放 s 時的 NCC */
function nccAt(tp, grid, gw, gh, ox, oy, s) {
  const {n, U, V, T} = tp;
  let sr = 0, sr2 = 0, st = 0;
  for (let i = 0; i < n; i++) {
    let x = Math.floor(ox + U[i] * s);
    let y = Math.floor(oy + V[i] * s);
    if (x < 0) x = 0;
    else if (x >= gw) x = gw - 1;
    if (y < 0) y = 0;
    else if (y >= gh) y = gh - 1;
    const o = (y * gw + x) * 3;
    const r = grid[o], g = grid[o + 1], b = grid[o + 2];
    sr += r + g + b;
    sr2 += r * r + g * g + b * b;
    st += T[i * 3] * r + T[i * 3 + 1] * g + T[i * 3 + 2] * b;
  }
  const N = n * 3;
  const varR = sr2 - (sr * sr) / N;
  return varR > 1e-6 ? st / Math.sqrt(varR) : -1;
}

/** 找圖層在 Layout 圖上的最佳位置；回傳 {x, y, scaleMul, score} 或錯誤訊息字串 */
function alignLayer(l, ref, range, withScale) {
  if (l === ref) return '參考圖不能是自己';
  const tpl = renderLayerAlone(l);
  if (!tpl) return '這個圖層目前畫不出東西（看不到或範圍是 0）';
  const p = layerXform(l);
  const k = tpl.k;
  const scales = withScale ? [0.85, 0.875, 0.9, 0.925, 0.95, 0.975, 1, 1.025, 1.05, 1.075, 1.1, 1.125, 1.15] : [1];
  const smax = withScale ? 1.15 : 1;
  // 搜尋區（世界）：元件範圍放大到最大縮放，再加上搜尋範圍
  const ext = Math.max(Math.abs(tpl.x0 - p.x), Math.abs(tpl.x0 + tpl.w / k - p.x), Math.abs(tpl.y0 - p.y), Math.abs(tpl.y0 + tpl.h / k - p.y)) * smax;
  const f = ALIGN_COARSE;
  const half = Math.ceil(((ext + range) * k) / f + 2) * f;
  const gw = half * 2;
  const gh = half * 2;
  const gx0 = p.x - half / k;
  const gy0 = p.y - half / k;
  const grid = rasterizeRef(ref, gx0, gy0, gw, gh, k);
  const coarse = downsampleGrid(grid, gw, gh, f);
  const tpC = templatePoints(tpl, p.x, p.y, f, ALIGN_MAX_PTS_COARSE);
  const tpF = templatePoints(tpl, p.x, p.y, 1, ALIGN_MAX_PTS);
  if (tpF.n < 30) return '不透明的像素太少，沒辦法比對（換一格比較完整的畫面再試）';
  // 粗找：1/f 解析度、原點在目前位置 ±range
  const c0 = half / f;
  const rC = Math.ceil((range * k) / f);
  const top = [];
  for (const s of scales)
    for (let dy = -rC; dy <= rC; dy++)
      for (let dx = -rC; dx <= rC; dx++) {
        const sc = tpC.n >= 12 ? nccAt(tpC, coarse.g, coarse.w, coarse.h, c0 + dx, c0 + dy, s) : 0;
        if (top.length < 5 || sc > top[top.length - 1].sc) {
          top.push({sc, dx, dy, s});
          top.sort((a, b) => b.sc - a.sc);
          if (top.length > 5) top.pop();
        }
      }
  // 細修：全解析度，在前幾名附近 ±f 像素（有找縮放就再細分縮放）
  let best = {sc: -2, ox: half, oy: half, s: 1};
  const seen = new Set();
  for (const c of top) {
    const sList = withScale ? [-0.01, -0.005, 0, 0.005, 0.01].map(d => c.s + d) : [1];
    for (const s of sList)
      for (let yy = -f - 1; yy <= f + 1; yy++)
        for (let xx = -f - 1; xx <= f + 1; xx++) {
          const ox = half + c.dx * f + xx;
          const oy = half + c.dy * f + yy;
          const key = `${ox},${oy},${s.toFixed(4)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sc = nccAt(tpF, grid, gw, gh, ox, oy, s);
          if (sc > best.sc) best = {sc, ox, oy, s};
        }
  }
  let res = {x: gx0 + best.ox / k, y: gy0 + best.oy / k, scaleMul: best.s, score: best.sc, flat: tpF.flat};
  // 元件太大、上面是降解析度比的 → 用全解析度樣板在結果附近再修一次（精度回到 1 px）
  if (k < 1) {
    const tpl2 = renderLayerAlone(l, 4096);
    if (tpl2 && tpl2.k > k) {
      const k2 = tpl2.k;
      const tp2 = templatePoints(tpl2, p.x, p.y, 1, ALIGN_MAX_PTS);
      const ext2 = Math.max(Math.abs(tpl2.x0 - p.x), Math.abs(tpl2.x0 + tpl2.w / k2 - p.x), Math.abs(tpl2.y0 - p.y), Math.abs(tpl2.y0 + tpl2.h / k2 - p.y)) * best.s;
      const rad = Math.ceil(k2 / k) + 1;
      const half2 = Math.ceil(ext2 * k2) + rad + 2;
      const g2x0 = res.x - half2 / k2;
      const g2y0 = res.y - half2 / k2;
      const grid2 = rasterizeRef(ref, g2x0, g2y0, half2 * 2, half2 * 2, k2);
      let b2 = null;
      for (let yy = -rad; yy <= rad; yy++)
        for (let xx = -rad; xx <= rad; xx++) {
          const sc = nccAt(tp2, grid2, half2 * 2, half2 * 2, half2 + xx, half2 + yy, best.s);
          if (!b2 || sc > b2.sc) b2 = {sc, xx, yy};
        }
      if (b2) res = {...res, x: g2x0 + (half2 + b2.xx) / k2, y: g2y0 + (half2 + b2.yy) / k2, score: b2.sc};
    }
  }
  return res;
}

/** 對位一批圖層；結果寫回 X / Y（跟隨中的寫偏移）與縮放，並記可還原的狀態 */
function runAlign(list) {
  const ref = getLayer(S.alignRefId);
  if (!ref || ref.type !== 'image') {
    toast('先選一張參考 Layout 圖（PNG 圖片圖層）', true);
    return;
  }
  const targets = list.filter(l => l !== ref);
  if (!targets.length) {
    toast('要對位的圖層不能只有參考圖本身', true);
    return;
  }
  S.alignUsed = true;
  tick(0, 0); // 骨架位置跟上目前的 X / Y
  const undo = [];
  const lines = [];
  let anyLow = false;
  for (const l of targets) {
    const before = {id: l.id, x: l.x, y: l.y, scale: l.scale, followOffX: l.followOffX, followOffY: l.followOffY};
    const r = alignLayer(l, ref, Math.max(4, +S.alignRange || 200), S.alignScale && !(l.followId && l.followPos));
    if (typeof r === 'string') {
      lines.push(`${l.name}：${r}`);
      continue;
    }
    undo.push(before);
    const p = layerXform(l);
    const dx = r.x - p.x;
    const dy = r.y - p.y;
    if (l.followId && l.followPos) {
      l.followOffX = +((+l.followOffX || 0) + dx).toFixed(1);
      l.followOffY = +((+l.followOffY || 0) + dy).toFixed(1);
    } else {
      l.x = +r.x.toFixed(1);
      l.y = +r.y.toFixed(1);
      if (r.scaleMul !== 1) l.scale = +((+l.scale || 1) * r.scaleMul).toFixed(4);
    }
    persistSoon(l);
    const low = r.score < 0.6;
    anyLow ||= low;
    lines.push(
      `${l.name}：移動 (${dx.toFixed(1)}, ${dy.toFixed(1)})${r.scaleMul !== 1 ? `，縮放 ×${r.scaleMul.toFixed(3)}` : ''}，相似度 ${r.score.toFixed(2)}${low ? '（偏低，請確認）' : ''}${r.flat ? '（元件幾乎單色，可能不準）' : ''}`
    );
  }
  if (undo.length) S.alignUndo = undo;
  tick(0, 0);
  renderProps();
  toast(lines.join('\n'), anyLow);
}

function undoAlign() {
  if (!S.alignUndo.length) return;
  for (const u of S.alignUndo) {
    const l = getLayer(u.id);
    if (!l) continue;
    Object.assign(l, {x: u.x, y: u.y, scale: u.scale, followOffX: u.followOffX, followOffY: u.followOffY});
    persistSoon(l);
  }
  S.alignUndo = [];
  tick(0, 0);
  renderProps();
  toast('已還原對位前的位置');
}

// ---------- UI：屬性 ----------
function numField(label, key, step = 1, title = '') {
  return `<label title="${esc(title)}"><span class="k">${label}</span><input type="number" step="${step}" data-k="${key}"></label>`;
}

function renderProps() {
  const el = $('#props');
  const l = selLayer();
  if (!l) {
    el.innerHTML = '<p class="note">選一個圖層看屬性。</p>';
    return;
  }
  const isSpine = l.type === 'spine';
  const others = S.layers.filter(x => x.type === 'spine' && x !== l);
  let h = `<h3>${esc(l.name)} <small>${isSpine ? 'Spine ' + esc(l.version || '') : `圖片 ${l.w}×${l.h}`}</small></h3>`;
  if (l.warn) h += `<p class="warn">${esc(l.warn)}</p>`;

  // 基本
  h += `<details class="sec" open><summary>基本</summary><div class="body">
    <div class="row"><span class="k">角色</span>
      <select data-k="role"><option value="normal">一般（永遠顯示）</option><option value="static">靜態</option><option value="dynamic">動態</option></select></div>
    <div class="row">${numField('X', 'x')}${numField('Y', 'y')}</div>
    <div class="row">${numField('縮放', 'scale', 0.01)}<label><input type="checkbox" data-k="flipX">水平翻轉</label></div>
    <div class="row"><span class="k">透明度</span><input class="grow" type="range" min="0" max="1" step="0.01" data-k="alpha"></div>`;
  if (isSpine) {
    h += `<div class="row"><span class="k">跟隨</span><select class="grow" data-k="followId"><option value="">（不跟隨）</option>${others
      .map(o => `<option value="${o.id}">${esc(o.name)}</option>`)
      .join('')}</select></div>`;
    if (l.followId) {
      h += `<div class="row"><label><input type="checkbox" data-k="followPos">位置 / 縮放也跟</label>${numField('偏移X', 'followOffX')}${numField('偏移Y', 'followOffY')}</div>
      <p class="note">每幀對齊對方第 0 軌的動畫名與播放時間；對方的動畫這組沒有時播空動畫。</p>
      <p class="warn" id="followMissing"></p>`;
    }
  }
  h += `</div></details>`;

  if (isSpine) {
    const anims = l.data.animations;
    h += `<details class="sec" open><summary>動畫</summary><div class="body">
      <div class="row">
        <label><input type="checkbox" data-k="loop">循環</label>
        ${numField('速度', 'speed', 0.1)}
      </div>
      <div class="row">${numField('預設 mix', 'defaultMix', 0.05, '切換動畫時的混合秒數（AnimationStateData.defaultMix）')}
        ${l.data.skins.length > 1 ? `<span class="k">Skin</span><select data-k="skin">${l.data.skins.map(s => `<option>${esc(s.name)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="mixes">${l.mixes
        .map((m, i) => {
          const opts = cur => anims.map(a => `<option value="${esc(a.name)}" ${a.name === cur ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
          const bad = (m.from && !l.data.findAnimation(m.from)) || (m.to && !l.data.findAnimation(m.to));
          return `<div class="mix row" data-mi="${i}"><select class="grow" data-mk="from">${opts(m.from)}</select>→<select class="grow" data-mk="to">${opts(m.to)}</select>
            <input type="number" min="0" step="0.05" data-mk="dur" value="${m.dur}" style="width:56px" title="秒">
            <button class="btn small" data-mact="try" title="從頭播 from，播完 / 按下一段後接 to，看 mix 效果">▶</button><button class="btn small" data-mact="del" title="移除">✕</button>
            ${bad ? '<span class="warn">這組沒有這個動畫</span>' : ''}</div>`;
        })
        .join('')}</div>
      <div class="row"><button class="btn small" data-act="mixAdd" title="指定「從 A 切到 B」的 mix 秒數，蓋過預設 mix（同 sp.Skeleton.setMix）">＋ 動畫配對 mix</button>
        <span class="note">優先順序：播放順序那段填的 mix ＞ 配對 ＞ 預設</span></div>
      <div class="row"><label><input type="checkbox" data-k="freeze">凍結於</label><input type="number" step="0.01" min="0" data-k="freezeTime">秒
        <button class="btn small" data-act="freezeNow">用目前時間</button></div>
      <p class="note">凍結 = 停在某一格當靜態張用（角色設「靜態」就能跟動態切換比對）。</p>
      ${l.followId ? '<p class="note">跟隨中：動畫由跟隨對象決定，點下面的動畫不會生效。</p>' : ''}
      <div class="anims" id="animList">${anims
        .map(a => `<button data-anim="${esc(a.name)}"><span>${esc(a.name)}</span><span class="dur">${a.duration.toFixed(2)}s</span></button>`)
        .join('')}</div>
    </div></details>`;

    // 多軌
    const animOpts = cur => `<option value="">（選動畫）</option>${anims
      .map(a => `<option value="${esc(a.name)}" ${a.name === cur ? 'selected' : ''}>${esc(a.name)}</option>`)
      .join('')}`;
    h += `<details class="sec" ${l.tracks.length ? 'open' : ''}><summary>多軌播放${l.tracks.length ? `（${l.tracks.length}）` : ''}</summary><div class="body">
      <p class="note">第 0 軌 = 上面的動畫 / 播放順序；這裡加第 1 軌以上同時播，軌號大的蓋在上面（同 Cocos <code>setAnimation(trackIndex, name, loop)</code>）。只 key 部分骨頭 / 插槽的動畫（表情、手勢、光效）最適合疊上去。</p>
      <div class="tracks">${l.tracks
        .map((t, i) => {
          const missing = t.anim && !l.data.findAnimation(t.anim);
          const dup = t.on && l.tracks.some((o, j) => j !== i && o.on && o.track === t.track);
          return `<div class="trk" data-ti="${i}">
          <div class="row"><label><input type="checkbox" data-tk="on" ${t.on ? 'checked' : ''}>第</label><input type="number" min="1" max="${MAX_TRACK}" step="1" data-tk="track" value="${t.track}" style="width:44px">軌
            <select class="grow" data-tk="anim">${animOpts(t.anim)}</select><button class="btn small" data-tact="del" title="移除這一軌">✕</button></div>
          <div class="row"><label><input type="checkbox" data-tk="loop" ${t.loop ? 'checked' : ''}>循環</label>
            <label title="TrackEntry.alpha：這一軌蓋上去的比例">權重<input type="number" min="0" max="1" step="0.1" data-tk="alpha" value="${t.alpha}" style="width:52px"></label>
            <label title="TrackEntry.timeScale（再乘圖層速度）">速度<input type="number" step="0.1" data-tk="speed" value="${t.speed}" style="width:52px"></label>
            <label title="從頭播時延遲幾秒才開始（TrackEntry.delay）">延遲<input type="number" min="0" step="0.05" data-tk="delay" value="${t.delay}" style="width:52px"></label>
            <label title="這一軌進場 / 關掉時的漸變秒數（TrackEntry.mixDuration，從空動畫混進來）">mix<input type="number" min="0" step="0.05" data-tk="mix" value="${t.mix}" style="width:52px"></label>
            <label title="MixBlend.add：數值疊加在下面的軌上，而不是取代"><input type="checkbox" data-tk="add" ${t.add ? 'checked' : ''}>疊加</label></div>
          ${missing ? `<div class="warn">這組沒有動畫 ${esc(t.anim)}</div>` : ''}
          ${dup ? '<div class="warn">軌號重複：後面那筆會蓋掉前面的</div>' : ''}
        </div>`;
        })
        .join('')}</div>
      <div class="row"><button class="btn small" data-act="trackAdd">＋ 加一軌</button>
        <button class="btn small" data-act="trackReplay" ${l.tracks.length ? '' : 'disabled'} title="第 1 軌以上從頭（第 0 軌不動）">⟲ 多軌從頭</button>
        <span class="note">「全部從頭」（R）也會一起重播</span></div>
    </div></details>`;

    // 播放順序
    h += `<details class="sec" open><summary>播放順序</summary><div class="body">
      <div class="row">
        <button class="btn small ${l.rec ? 'rec' : ''}" data-act="rec">${l.rec ? '⏹ 結束錄製' : '⏺ 錄製'}</button>
        <button class="btn small" data-act="seqPlay" ${l.seq.length ? '' : 'disabled'}>▶ 播放</button>
        <button class="btn small" data-act="seqNext" title="N 鍵">⏭ 下一段</button>
        <button class="btn small" data-act="seqStop">■ 停止</button>
      </div>
      <div class="row">
        <button class="btn small" data-act="seqAdd">＋ 加一段</button>
        <button class="btn small" data-act="seqClear">清除</button>
        <label><input type="checkbox" data-k="seqLoopAll">整組循環</label>
        <button class="btn small" data-act="seqCopy" title="複製成 JSON 文字">複製</button>
        <button class="btn small" data-act="seqPaste" title="貼上 JSON 或「Start,Loop*3,End」格式">貼上</button>
      </div>
      <div class="seq" id="seqList">
        <div class="step head"><span></span><span>動畫</span><span>次數</span><span>mix</span><span></span></div>
        ${l.seq
          .map(
            (s, i) => `<div class="step" data-i="${i}">
          <span class="idx">${i + 1}</span>
          <select data-sk="anim">${anims.map(a => `<option ${a.name === s.anim ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}${
              anims.some(a => a.name === s.anim) ? '' : `<option selected>${esc(s.anim)}</option>`
            }</select>
          <input type="number" min="0" step="1" data-sk="times" value="${esc(s.times)}" title="0 = 無限循環，按「下一段」才往下">
          <input type="number" min="0" step="0.05" data-sk="mix" value="${esc(s.mix)}" placeholder="預設" title="切進這段的 mix 秒數，空白 = 預設 mix">
          <span><button class="ic btn small" data-sact="up">▲</button><button class="ic btn small" data-sact="del">✕</button></span>
        </div>`
          )
          .join('')}
      </div>
      <p class="note">次數 0 = 無限循環，按「⏭ 下一段」才接下一支（模擬等 server 回應再播 End）。跟隨這組的圖層會一起照順序播。</p>
    </div></details>`;

    // 骨骼 / 掛點
    const bones = l.data.bones.map(b => b.name);
    h += `<details class="sec" open><summary>骨骼 / 掛點</summary><div class="body">
      <div class="row"><label><input type="checkbox" data-k="debug">顯示骨骼</label>
        <label><input type="checkbox" data-g="showBoneNames">骨骼名稱</label></div>
      <div class="row"><span class="k">骨頭</span><select class="grow" id="boneSel"><option value="">（選骨頭，或在畫面上點）</option>${bones
        .map(b => `<option ${b === S.selectedBone ? 'selected' : ''}>${esc(b)}</option>`)
        .join('')}</select></div>
      <div class="note" id="boneInfo"></div>
      <div class="row"><button class="btn small primary" data-act="attach" ${S.selectedBone ? '' : 'disabled'}>＋ 在這根骨頭掛數字</button>
        <button class="btn small" data-act="pin" ${S.selectedBone ? '' : 'disabled'} title="把這根骨頭固定到指定座標（模擬程式在執行期擺骨頭，例如飛行軌跡動畫的起點 / 終點骨頭）">📌 定位這根骨頭</button></div>
      ${
        (l.pins || []).length
          ? `<div class="pins">${l.pins
              .map(
                (p, i) => `<div class="row pin" data-pi="${i}"><label title="啟用"><input type="checkbox" data-pk="on" ${p.on ? 'checked' : ''}>📌</label>
          <select data-pk="bone" class="grow">${bones.map(b => `<option ${b === p.bone ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <label>X<input type="number" data-pk="x" value="${Math.round(p.x)}"></label><label>Y<input type="number" data-pk="y" value="${Math.round(p.y)}"></label>
          <button class="ic btn small" data-pact="del" title="移除">✕</button></div>`
              )
              .join('')}
        <p class="note">座標是這組 Spine 節點的本地座標（＝遊戲裡 <code>convertToNodeSpaceAR(目標世界座標)</code> 的結果），每幀蓋掉動畫的位置。粉紅色準心可以直接在畫面上拖。</p></div>`
          : ''
      }
      <div id="attList">${S.attachments
        .filter(a => a.layerId === l.id)
        .map(a => attachmentHtml(a, bones))
        .join('')}</div>
    </div></details>`;
  }

  // 自動對位
  const refs = S.layers.filter(x => x.type === 'image' && x !== l);
  if (S.alignRefId != null && !getLayer(S.alignRefId)) S.alignRefAuto = true;
  if (refs.length && (S.alignRefAuto || (S.alignRefId !== l.id && !refs.some(x => x.id === S.alignRefId)))) S.alignRefId = refs.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b)).id; // 預設最大張的圖
  const nSel = selectedLayers().filter(x => x.id !== S.alignRefId).length;
  h += `<details class="sec" ${S.alignUsed ? 'open' : ''}><summary>自動對位（比對 Layout 圖）</summary><div class="body">
    ${
      refs.length
        ? `<div class="row"><span class="k">參考圖</span><select class="grow" data-al="alignRefId">${refs
            .map(x => `<option value="${x.id}" ${x.id === S.alignRefId ? 'selected' : ''}>${esc(x.name)}（${x.w}×${x.h}）</option>`)
            .join('')}</select></div>
    <div class="row"><label title="從目前位置往四周找幾 px（越大越慢）"><span class="k">搜尋範圍 ±</span><input type="number" min="4" step="10" data-al="alignRange" value="${S.alignRange}" style="width:64px">px</label>
      <label title="在 0.85～1.15 倍之間一起找縮放（較慢）"><input type="checkbox" data-al="alignScale" ${S.alignScale ? 'checked' : ''}>也找縮放</label></div>
    <div class="row"><button class="btn small primary" data-act="alignOne" ${S.alignRefId === l.id ? 'disabled' : ''}>🎯 對位這個圖層</button>
      ${nSel > 1 ? `<button class="btn small" data-act="alignSel">對位選取的 ${nSel} 個</button>` : ''}
      <button class="btn small" data-act="alignUndo" ${S.alignUndo.length ? '' : 'disabled'}>↶ 還原</button></div>
    <p class="note">用元件<b>目前這一格</b>的畫面去 Layout 圖上找最像的位置（先停在跟 Layout 一樣的那一格）。Layout 圖要擺成 1 px = 1 單位（縮放 1、跟設計框對齊）；先大致拖到附近再按，比較快也比較不會認錯。對完可切「疊圖」檢查。</p>`
        : '<p class="note">先匯入 Layout 圖（PNG，會變成圖片圖層），擺到跟設計框對齊的位置，再回來按對位。</p>'
    }
  </div></details>`;

  // 淡入淡出
  const spinesAll = S.layers.filter(x => x.type === 'spine');
  h += `<details class="sec" ${l.fadeOn ? 'open' : ''}><summary>淡入 / 淡出${l.fadeOn ? ' ●' : ''}</summary><div class="body">
    <div class="row"><label><input type="checkbox" data-k="fadeOn">啟用</label><span class="note">＝ Cocos <code>UIOpacity</code> ＋ <code>tween</code>，掛數字一起淡</span></div>
    <div class="row"><span class="k">計時</span><select class="grow" data-k="fadeClockName"><option value="">全域（「全部從頭」/ R 歸零）</option>${spinesAll
      .map(x => `<option value="${esc(x.name)}">「${esc(x.name)}」目前動畫的時間</option>`)
      .join('')}</select></div>
    <div class="row"><span class="k">淡入</span>${numField('延遲', 'fadeInDelay', 0.05)}${numField('時長', 'fadeInDur', 0.05, '0 = 不淡入，直接顯示')}</div>
    <div class="row">${numField('起始透明', 'fadeFrom', 0.05, '淡入前的透明度（0 = 全透明）')}</div>
    <div class="row"><label><input type="checkbox" data-k="fadeOutOn"><span class="k">淡出</span></label>${numField('開始於', 'fadeOutAt', 0.05, '秒，同一個計時')}${numField('時長', 'fadeOutDur', 0.05)}</div>
    <div class="row"><span class="k">緩動</span><select data-k="fadeEase">${Object.keys(EASES)
      .map(k => `<option>${k}</option>`)
      .join('')}</select><span class="note">同 cc.tween easing 名</span></div>
    <div class="row"><button class="btn small" data-act="fadeReplay" title="R：全部從頭（全域計時歸零、Spine 重播）">⟲ 全部從頭試播</button><span class="note" id="fadeInfo"></span></div>
  </div></details>`;

  // 渲染
  h += `<details class="sec"><summary>渲染（顏色對不上先看這）</summary><div class="body">
    <div class="row"><label><input type="checkbox" data-k="pma">PMA 混色</label><span class="note">＝ Cocos <code>${isSpine ? 'sp.Skeleton.premultipliedAlpha' : 'Sprite 混合模式 ONE'}</code></span></div>
    <div class="row"><label><input type="checkbox" data-k="texPma">貼圖預乘</label><span class="note">＝ PNG 匯入設定 <code>premultiplyAlpha</code></span></div>
    <p class="note">兩個要一致才正常：都關（Cocos 3.8 預設）或都開。只開一個會出現黑邊 / 發亮，跟遊戲內不一致時拿來重現。</p>
  </div></details>`;

  el.innerHTML = h;
  // 填值
  el.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k;
    const v = k === 'followId' ? l.followId ?? '' : l[k];
    if (inp.type === 'checkbox') inp.checked = !!v;
    else inp.value = v ?? '';
  });
  el.querySelectorAll('[data-g]').forEach(inp => (inp.checked = !!S[inp.dataset.g]));
  refreshAnimHighlight();
  renderSeqHighlight();
}

function attachmentHtml(a, bones) {
  return `<div class="att" data-uid="${a.uid}">
    <div class="row"><label><input type="checkbox" data-ak="visible" ${a.visible ? 'checked' : ''}>顯示</label>
      <select data-ak="bone" class="grow">${bones.map(b => `<option ${b === a.bone ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <button class="ic btn small" data-aact="del" title="移除">✕</button></div>
    <div class="row"><span class="k">文字</span><input type="text" data-ak="text" value="${esc(a.text)}" class="grow"></div>
    <div class="row"><span class="k">字型</span><select data-ak="font" class="grow">${S.fonts
      .map(f => `<option ${f === a.font ? 'selected' : ''}>${esc(f)}</option>`)
      .join('')}</select><label><input type="checkbox" data-ak="bold" ${a.bold ? 'checked' : ''}>粗</label></div>
    <div class="row"><label>字級<input type="number" data-ak="size" value="${esc(a.size)}" step="1"></label>
      <label>倍率<input type="number" data-ak="scale" value="${esc(a.scale)}" step="0.05"></label>
      ${isBmFont(a.font) ? `<label title="同 Cocos Label 的 Spacing X">字距<input type="number" data-ak="spacingX" value="${esc(a.spacingX ?? 0)}" step="1"></label>` : ''}</div>
    ${isBmFont(a.font) && !bmFonts.has(a.font) ? '<div class="warn">這個點陣字還沒匯入（重新整理後要再拖一次 .fnt + .png）</div>' : ''}
    ${isBmFont(a.font) && bmFonts.has(a.font) ? `<div class="note">點陣字原始字級 ${bmFonts.get(a.font).size}；粗體、描邊不作用，顏色是乘色（同 Cocos）</div>` : ''}
    <div class="row"><label>顏色<input type="color" data-ak="color" value="${esc(a.color)}"></label>
      <label>描邊<input type="number" data-ak="stroke" value="${esc(a.stroke)}" step="1" min="0"></label>
      <input type="color" data-ak="strokeColor" value="${esc(a.strokeColor)}"></div>
    <div class="row"><label>偏移X<input type="number" data-ak="dx" value="${esc(a.dx)}"></label><label>偏移Y<input type="number" data-ak="dy" value="${esc(a.dy)}"></label></div>
    <div class="row"><label><input type="checkbox" data-ak="followRot" ${a.followRot ? 'checked' : ''}>跟旋轉</label>
      <label><input type="checkbox" data-ak="followScale" ${a.followScale ? 'checked' : ''}>跟骨頭縮放</label>
      <label>透明<input type="number" data-ak="opacity" value="${esc(a.opacity)}" step="0.1" min="0" max="1"></label></div>
  </div>`;
}

function refreshAnimHighlight() {
  const l = selLayer();
  const list = document.getElementById('animList');
  if (!l || l.type !== 'spine' || !list) return;
  const cur = l.st.getCurrent(0)?.animation?.name;
  list.querySelectorAll('button').forEach(b => b.classList.toggle('cur', b.dataset.anim === cur));
}
function renderSeqHighlight() {
  const l = selLayer();
  const list = document.getElementById('seqList');
  if (!l || !list) return;
  list.querySelectorAll('.step[data-i]').forEach(r => r.classList.toggle('cur', !!l.seqRun && +r.dataset.i === l.seqRun.i));
}

let lastAnimName = null;
function updateLiveProps() {
  const l = selLayer();
  const fi = document.getElementById('fadeInfo');
  if (fi && l) fi.textContent = l.fadeOn ? `t = ${fadeClock(l).toFixed(2)} 秒　透明度 ${layerAlpha(l).toFixed(2)}` : '';
  if (!l || l.type !== 'spine') return;
  const cur = l.st.getCurrent(0)?.animation?.name || null;
  if (cur !== lastAnimName) {
    lastAnimName = cur;
    refreshAnimHighlight();
  }
  const fm = document.getElementById('followMissing');
  if (fm) fm.textContent = l.followMissing ? `對方在播 ${l.followMissing}，這組沒有同名動畫 → 播空動畫` : '';
  const info = document.getElementById('boneInfo');
  if (info) {
    const bone = S.selectedBone ? l.sk.findBone(S.selectedBone) : null;
    if (bone) {
      const p = layerXform(l);
      const path = [];
      for (let b = bone; b; b = b.parent) path.unshift(b.data.name);
      info.innerHTML = `路徑 <code>${esc(path.join('/'))}</code><br>世界 (${fmt(bone.worldX, 1)}, ${fmt(bone.worldY, 1)})　相對圖層 (${fmt(
        bone.worldX - p.x,
        1
      )}, ${fmt(bone.worldY - p.y, 1)})<br>旋轉 ${fmt(bone.getWorldRotationX(), 1)}°　縮放 ${fmt(bone.getWorldScaleX(), 3)} / ${fmt(bone.getWorldScaleY(), 3)}`;
    } else info.textContent = '';
  }
}

const props = $('#props');
props.addEventListener('input', onPropInput);
props.addEventListener('change', onPropInput);
function onPropInput(e) {
  const l = selLayer();
  if (!l) return;
  const t = e.target;
  // 圖層屬性
  if (t.dataset.k) {
    const k = t.dataset.k;
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.type === 'number' || t.type === 'range') {
      if (v === '' && e.type === 'input') return;
      v = +v;
    }
    if (k === 'followId') {
      if (e.type !== 'change') return;
      const id = v ? +v : null;
      if (id && followCreatesLoop(l, id)) {
        toast('不能互相跟隨', true);
        t.value = l.followId ?? '';
        return;
      }
      l.followId = id;
      l._srcEntry = null;
      if (!id) {
        const p = layerXform(l);
        Object.assign(l, {x: p.x, y: p.y});
        if (l.anim) playAnim(l, l.anim);
      } else seqStop(l);
      renderLayers();
      renderProps();
    } else if (k === 'texPma') {
      l.texPma = v;
      if (l.type === 'spine') for (const pg of l.pages) reuploadTexture(pg.texture, v, pg.minFilter, pg.magFilter, pg.uWrap, pg.vWrap);
      else reuploadTexture(l.tex, v);
    } else if (k === 'skin') {
      l.skin = v;
      l.sk.setSkinByName(v);
      l.sk.setSlotsToSetupPose();
    } else if (k === 'defaultMix') {
      l.defaultMix = v;
      rebuildMix(l);
    } else if (k === 'loop') {
      l.loop = v;
      const cur = l.st.getCurrent(0);
      if (cur && !l.seqRun) cur.loop = v;
    } else if (k === 'role') {
      l.role = v;
      renderLayers();
    } else if (k === 'fadeOn') {
      l.fadeOn = v;
      renderProps(); // 標題的 ● 跟著更新
    } else {
      l[k] = v;
    }
    persistSoon(l);
    return;
  }
  if (t.dataset.al) {
    const ak = t.dataset.al;
    S[ak] = ak === 'alignScale' ? t.checked : ak === 'alignRefId' ? +t.value : Math.max(4, +t.value || 200);
    if (ak === 'alignRefId') S.alignRefAuto = false;
    if (ak === 'alignRefId' && e.type === 'change') renderProps();
    return;
  }
  if (t.dataset.g) {
    S[t.dataset.g] = t.checked;
    saveGlobal();
    return;
  }
  if (t.id === 'boneSel') {
    S.selectedBone = t.value || null;
    renderProps();
    return;
  }
  // 播放順序
  const stepEl = t.closest('.step[data-i]');
  if (stepEl && t.dataset.sk) {
    const s = l.seq[+stepEl.dataset.i];
    if (!s) return;
    s[t.dataset.sk] = t.dataset.sk === 'anim' ? t.value : t.value === '' ? '' : +t.value;
    persistSoon(l);
    return;
  }
  // 動畫配對 mix
  const mixEl = t.closest('.mix[data-mi]');
  if (mixEl && t.dataset.mk && l.type === 'spine') {
    const m = l.mixes[+mixEl.dataset.mi];
    if (!m) return;
    if (t.type === 'number') {
      if (t.value === '' && e.type === 'input') return;
      m.dur = Math.max(0, +t.value || 0);
    } else m[t.dataset.mk] = t.value;
    rebuildMix(l);
    persistSoon(l);
    return;
  }
  // 多軌
  const trkEl = t.closest('.trk');
  if (trkEl && t.dataset.tk && l.type === 'spine') {
    const tr = l.tracks[+trkEl.dataset.ti];
    if (!tr) return;
    const tk = t.dataset.tk;
    if (t.type === 'number' && t.value === '' && e.type === 'input') return;
    if (t.type === 'number' && tk === 'track' && e.type !== 'change') return;
    const oldTrack = tr.track;
    const raw = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value;
    Object.assign(tr, sanitizeTrack({...tr, [tk]: raw}));
    const othersOn = idx => l.tracks.some(o => o !== tr && o.on && o.track === idx);
    if (tk === 'alpha' || tk === 'speed' || tk === 'add' || tk === 'loop') updateTrackLive(l, tr);
    else if (tk === 'delay') {
      if (tr.on) applyTrack(l, tr);
    } else if (e.type === 'change') {
      if (tk === 'track' && oldTrack !== tr.track && !othersOn(oldTrack)) clearExtraTrack(l, oldTrack);
      if (tr.on) applyTrack(l, tr);
      else if (!othersOn(tr.track)) clearExtraTrack(l, tr.track, tr.mix);
      renderProps();
    }
    persistSoon(l);
    return;
  }
  // 定位骨頭
  const pinEl = t.closest('.pin');
  if (pinEl && t.dataset.pk) {
    const p = l.pins[+pinEl.dataset.pi];
    if (!p) return;
    const pk = t.dataset.pk;
    const oldBone = p.bone;
    p[pk] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? 0 : +t.value) : t.value;
    // 關掉或換骨頭：原骨頭回 setup（沒 key 的骨頭不會自己回去）
    if ((pk === 'on' && !p.on) || (pk === 'bone' && oldBone !== p.bone)) l.sk.findBone(oldBone)?.setToSetupPose();
    persistSoon(l);
    return;
  }
  // 掛點
  const attEl = t.closest('.att');
  if (attEl && t.dataset.ak) {
    const a = S.attachments.find(x => x.uid === attEl.dataset.uid);
    if (!a) return;
    const ak = t.dataset.ak;
    a[ak] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? 0 : +t.value) : t.value;
    if (ak === 'font' && e.type === 'change') {
      // 換成點陣字時字級帶入原始字級（= 1 倍），面板也要換成點陣字的欄位
      if (bmFonts.has(a.font)) a.size = bmFonts.get(a.font).size;
      renderProps();
    }
    persistSoon(l);
  }
}

function followCreatesLoop(l, targetId) {
  let cur = getLayer(targetId);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    if (cur === l) return true;
    seen.add(cur.id);
    cur = cur.followId ? getLayer(cur.followId) : null;
  }
  return false;
}

props.addEventListener('click', e => {
  const l = selLayer();
  if (!l) return;
  const t = e.target;
  const animBtn = t.closest('[data-anim]');
  if (animBtn) {
    if (l.followId) {
      toast('跟隨中，動畫由跟隨對象決定', true);
      return;
    }
    const name = animBtn.dataset.anim;
    if (l.rec) recordClick(l, name);
    else {
      seqStop(l);
      playAnim(l, name);
    }
    persistSoon(l);
    if (l.rec) renderProps();
    else refreshAnimHighlight();
    return;
  }
  const act = t.dataset.act;
  if (act) {
    switch (act) {
      case 'alignOne':
      case 'alignSel': {
        const list = act === 'alignOne' ? [l] : selectedLayers();
        toast('對位中…');
        setTimeout(() => runAlign(list), 30); // 讓提示先畫出來
        return;
      }
      case 'alignUndo':
        undoAlign();
        return;
      case 'mixAdd': {
        const names = l.data.animations.map(a => a.name);
        const from = l.st.getCurrent(0)?.animation?.name || names[0] || '';
        const to = names.find(n => n !== from) || from;
        l.mixes.push({from, to, dur: Math.max(0.2, +l.defaultMix || 0)});
        rebuildMix(l);
        persistSoon(l);
        break;
      }
      case 'trackAdd': {
        const used = new Set(l.tracks.map(x => x.track));
        let n = 1;
        while (used.has(n) && n < MAX_TRACK) n++;
        const cur0 = l.st.getCurrent(0)?.animation?.name;
        const anim = l.data.animations.find(a => a.name !== cur0)?.name || cur0 || '';
        const tr = sanitizeTrack({track: n, anim});
        l.tracks.push(tr);
        applyTrack(l, tr);
        persistSoon(l);
        break;
      }
      case 'trackReplay':
        applyTracks(l);
        return;
      case 'fadeReplay':
        restartAll();
        if (S.paused) {
          S.paused = false;
          updatePlayBtn();
        }
        return;
      case 'freezeNow': {
        const e2 = l.st.getCurrent(0);
        if (e2) l.freezeTime = +e2.getAnimationTime().toFixed(3);
        l.freeze = true;
        break;
      }
      case 'rec':
        if (l.followId) {
          toast('跟隨中的圖層不能錄製，請在跟隨對象上錄', true);
          return;
        }
        if (l.rec) stopRecording(l);
        else startRecording(l);
        break;
      case 'seqPlay':
        if (l.followId) {
          toast('跟隨中的圖層不能自己播順序，請在跟隨對象上播', true);
          return;
        }
        seqPlay(l);
        break;
      case 'seqNext':
        if (l.seqRun) seqNext(l);
        break;
      case 'seqStop':
        seqStop(l);
        break;
      case 'seqAdd':
        l.seq.push({anim: l.st.getCurrent(0)?.animation?.name || l.data.animations[0]?.name || '', times: 1, mix: ''});
        break;
      case 'seqClear':
        seqStop(l);
        l.seq = [];
        break;
      case 'seqCopy': {
        const text = l.seq.map(s => s.anim + (+s.times === 1 ? '' : '*' + s.times) + (s.mix !== '' ? '@' + s.mix : '')).join(', ');
        navigator.clipboard?.writeText(text).then(() => toast('已複製：' + text), () => prompt('複製這段：', text));
        return;
      }
      case 'seqPaste': {
        const text = prompt('貼上順序，例如：Start, Loop*0, End（*次數，0 = 無限；@mix 秒數）', '');
        if (text == null) return;
        l.seq = parseSeqText(text);
        break;
      }
      case 'pin': {
        if (!S.selectedBone) return;
        const b = l.sk.findBone(S.selectedBone);
        if (!b) return;
        if (l.pins.some(p => p.bone === S.selectedBone)) {
          toast('這根骨頭已經定位了');
          return;
        }
        // 從骨頭現在的位置開始，避免一按就跳走
        const [x, y] = worldToSkel(l, b.worldX, b.worldY);
        l.pins.push({bone: S.selectedBone, x: Math.round(x), y: Math.round(y), on: true});
        break;
      }
      case 'attach': {
        if (!S.selectedBone) return;
        S.attachments.push({
          uid: Math.random().toString(36).slice(2, 10),
          layerId: l.id, bone: S.selectedBone, text: '888', font: S.fonts[0], bold: true,
          size: 48, scale: 1, color: '#ffffff', stroke: 6, strokeColor: '#000000',
          dx: 0, dy: 0, followRot: true, followScale: true, opacity: 1, visible: true,
        });
        saveAttachments();
        break;
      }
      default:
        return;
    }
    persistSoon(l);
    renderProps();
    return;
  }
  const sact = t.dataset.sact;
  if (sact) {
    const i = +t.closest('.step').dataset.i;
    if (sact === 'del') l.seq.splice(i, 1);
    if (sact === 'up' && i > 0) [l.seq[i - 1], l.seq[i]] = [l.seq[i], l.seq[i - 1]];
    persistSoon(l);
    renderProps();
    return;
  }
  if (t.dataset.pact === 'del') {
    const [removed] = l.pins.splice(+t.closest('.pin').dataset.pi, 1);
    if (removed) l.sk.findBone(removed.bone)?.setToSetupPose();
    persistSoon(l);
    renderProps();
    return;
  }
  if (t.dataset.mact) {
    const i = +t.closest('.mix').dataset.mi;
    const m = l.mixes[i];
    if (!m) return;
    if (t.dataset.mact === 'del') {
      l.mixes.splice(i, 1);
      rebuildMix(l);
      persistSoon(l);
      renderProps();
      return;
    }
    // ▶ 試播：from 播一次 → 接 to（用 addAnimation，mix 由 AnimationStateData 決定）
    if (l.followId) return toast('跟隨中，動畫由跟隨對象決定', true);
    if (!l.data.findAnimation(m.from) || !l.data.findAnimation(m.to)) return toast('這組沒有這個動畫', true);
    seqStop(l);
    l.st.setAnimation(0, m.from, false).mixDuration = 0;
    l.st.addAnimation(0, m.to, true, 0);
    l.anim = m.to;
    if (S.paused) {
      S.paused = false;
      updatePlayBtn();
    }
    return;
  }
  if (t.dataset.tact === 'del') {
    const [removed] = l.tracks.splice(+t.closest('.trk').dataset.ti, 1);
    if (removed && !l.tracks.some(o => o.on && o.track === removed.track)) clearExtraTrack(l, removed.track, removed.mix);
    persistSoon(l);
    renderProps();
    return;
  }
  if (t.dataset.aact === 'del') {
    const uid = t.closest('.att').dataset.uid;
    S.attachments = S.attachments.filter(a => a.uid !== uid);
    saveAttachments();
    renderProps();
  }
});

function parseSeqText(text) {
  text = text.trim();
  if (text.startsWith('[')) {
    try {
      return JSON.parse(text).map(s => ({anim: String(s.anim), times: +s.times || 0, mix: s.mix ?? ''}));
    } catch (e) {
      toast('JSON 格式錯誤', true);
      return [];
    }
  }
  return text
    .split(/[,，\n>→]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const m = s.match(/^(.+?)(?:\*(\d+))?(?:@([\d.]+))?$/);
      return {anim: m[1].trim(), times: m[2] != null ? +m[2] : 1, mix: m[3] != null ? +m[3] : ''};
    });
}

// ---------- 時間軸 ----------
const tlRange = $('#tlRange');
let scrubbing = false;
function updateTimeline() {
  const l = selLayer();
  const e = l && l.type === 'spine' ? l.st.getCurrent(0) : null;
  if (!e || !e.animation || e.animation.name === EMPTY) {
    $('#tlName').textContent = l ? l.name : '—';
    tlRange.disabled = true;
    $('#tlTime').textContent = '— / —';
    return;
  }
  tlRange.disabled = false;
  const dur = e.animationEnd - e.animationStart;
  const t = e.getAnimationTime() - e.animationStart;
  let label = `${l.name}：${e.animation.name}`;
  if (l.seqRun) label += `（順序 ${l.seqRun.i + 1}/${l.seq.length}${+l.seq[l.seqRun.i]?.times ? `，第 ${l.seqRun.count + 1}/${l.seq[l.seqRun.i].times} 次` : '，∞'}）`;
  if (l.followId) label += '（跟隨）';
  $('#tlName').textContent = label;
  $('#tlName').title = label;
  tlRange.max = Math.max(dur, 0.0001);
  if (!scrubbing) tlRange.value = t;
  $('#tlTime').textContent = `${t.toFixed(3)} / ${dur.toFixed(3)} s　${Math.round(t * FPS)}/${Math.round(dur * FPS)} 格`;
}
tlRange.addEventListener('input', () => {
  const l = selLayer();
  if (!l || l.type !== 'spine') return;
  const target = l.followId ? getLayer(l.followId) : l;
  const e = target?.st.getCurrent(0);
  if (!e) return;
  scrubbing = true;
  S.paused = true;
  updatePlayBtn();
  const dur = e.animationEnd - e.animationStart;
  const loops = e.loop && dur > 0 ? Math.floor(e.trackTime / dur) : 0;
  const before = e.trackTime;
  e.trackTime = loops * dur + +tlRange.value;
  const delta = (e.trackTime - before) / (e.timeScale || 1);
  for (const x of S.layers) if (x.type === 'spine' && !x.freeze && (x === target || x.followId === target.id)) shiftExtraTracks(x, delta);
  if (target.freeze) target.freezeTime = +tlRange.value;
});
tlRange.addEventListener('change', () => (scrubbing = false));

function updateStatus() {
  const c = S.cursor;
  let txt = `縮放 ${Math.round(S.cam.scale * 100)}%　${fps.toFixed(0)} fps`;
  if (c) {
    txt = `游標 (${c[0].toFixed(0)}, ${c[1].toFixed(0)})　` + txt;
    const l = selLayer();
    if (l) {
      const p = layerXform(l);
      txt = `相對 ${l.name} (${(c[0] - p.x).toFixed(0)}, ${(c[1] - p.y).toFixed(0)})　` + txt;
    }
  }
  $('#status').textContent = txt;
}

// ---------- 工具列 ----------
function updatePlayBtn() {
  $('#btnPlay').textContent = S.paused ? '▶ 播放' : '⏸ 暫停';
}
$('#btnPlay').onclick = () => {
  S.paused = !S.paused;
  updatePlayBtn();
};
$('#btnRestart').onclick = restartAll;
$('#btnStepBack').onclick = () => stepFrames(-1);
$('#btnStepFwd').onclick = () => stepFrames(1);
$('#selSpeed').onchange = e => (S.speed = +e.target.value);
$('#btnCenter').onclick = () => Object.assign(S.cam, {x: 0, y: 0, scale: 1});
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();

function setCompare(v) {
  S.compare = v;
  S.blinkT = 0;
  document.querySelectorAll('#segCompare button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#fldOverlay').style.display = v === 'overlay' ? '' : 'none';
  $('#fldBlink').style.display = v === 'blink' ? '' : 'none';
  const badge = $('#compareBadge');
  badge.className = 'badge' + (v === 'static' ? ' static' : v === 'dynamic' ? ' dynamic' : v === 'overlay' ? ' overlay' : '');
  badge.textContent = v === 'static' ? '靜態' : v === 'dynamic' ? '動態' : v === 'overlay' ? '疊圖：靜態半透明在上' : '';
  if (S.layers.length && !S.layers.some(l => l.role !== 'normal') && v !== 'both') toast('還沒有圖層設成「靜態 / 動態」角色，在圖層屬性 → 基本 → 角色設定');
  saveGlobal();
}
$('#segCompare').addEventListener('click', e => {
  if (e.target.dataset.v) setCompare(e.target.dataset.v);
});
$('#rngOverlay').oninput = e => {
  S.overlayOpacity = +e.target.value;
  saveGlobal();
};
$('#numBlink').oninput = e => {
  S.blinkInterval = +e.target.value || 0.5;
  saveGlobal();
};
$('#clrBg').oninput = e => {
  S.bg = e.target.value;
  saveGlobal();
};
$('#chkGrid').onchange = e => {
  S.grid = e.target.checked;
  saveGlobal();
};
$('#selFrame').onchange = e => {
  S.frame = e.target.value;
  saveGlobal();
};

$('#inFiles').onchange = e => {
  importFiles([...e.target.files].map(f => ({file: f, path: f.webkitRelativePath || f.name})));
  e.target.value = '';
};
$('#inDir').onchange = e => {
  importFiles([...e.target.files].map(f => ({file: f, path: f.webkitRelativePath || f.name})), {hidden: true});
  e.target.value = '';
};

// ---------- 工作區 ----------
function workspaceObj() {
  return {
    spineViewerWorkspace: 1,
    global: pick(S, ['compare', 'overlayOpacity', 'blinkInterval', 'bg', 'grid', 'frame', 'showBoneNames']),
    order: S.layers.map(l => l.name),
    layers: S.layers.map(l => ({name: l.name, type: l.type, ...pick(l, PERSIST_KEYS), followName: l.followId ? getLayer(l.followId)?.name : null})),
    attachments: S.attachments.map(a => {
      const c = {...a, layerName: getLayer(a.layerId)?.name};
      delete c.layerId;
      return c;
    }),
  };
}
$('#btnSaveWs').onclick = () => {
  const blob = new Blob([JSON.stringify(workspaceObj(), null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'spine-viewer-workspace.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#inWs').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    applyWorkspace(JSON.parse(await f.text()));
  } catch (err) {
    toast('工作區 JSON 讀取失敗：' + err.message, true);
  }
};
function applyWorkspace(ws) {
  if (!ws || !ws.spineViewerWorkspace) {
    toast('不是工作區 JSON', true);
    return;
  }
  Object.assign(S, pick(ws.global || {}, ['compare', 'overlayOpacity', 'blinkInterval', 'bg', 'grid', 'frame', 'showBoneNames']));
  // 先寫進 localStorage：之後才匯入的同名圖層也會套用
  for (const ls of ws.layers || []) {
    const saved = pick(ls, PERSIST_KEYS);
    store.set(LS_LAYER + ls.name, saved);
    const l = S.layers.find(x => x.name === ls.name);
    if (l) {
      applySaved(l, saved);
      l.followId = null;
      if (l.type === 'spine') {
        if (l.skin && l.data.findSkin(l.skin)) l.sk.setSkinByName(l.skin);
        rebuildMix(l);
        if (l.anim) playAnim(l, l.anim);
      }
    }
  }
  if (Array.isArray(ws.order)) {
    store.set(LS_ORDER, ws.order);
    S.layers.sort((a, b) => {
      const ia = ws.order.indexOf(a.name);
      const ib = ws.order.indexOf(b.name);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
  }
  if (Array.isArray(ws.attachments)) {
    store.set(LS_ATT, ws.attachments);
    S.attachments = [];
    for (const a of ws.attachments) {
      const l = S.layers.find(x => x.name === a.layerName);
      if (l) {
        const c = {...a, layerId: l.id};
        delete c.layerName;
        S.attachments.push(c);
      }
    }
  }
  resolveFollows();
  syncToolbar();
  renderLayers();
  renderProps();
  toast('已套用工作區（之後匯入的同名 Spine 也會套用）');
}

function syncToolbar() {
  $('#rngOverlay').value = S.overlayOpacity;
  $('#numBlink').value = S.blinkInterval;
  $('#clrBg').value = S.bg;
  $('#chkGrid').checked = S.grid;
  $('#selFrame').value = S.frame;
  setCompare(S.compare);
}

// ---------- 拖放 ----------
const stage = $('#stage');
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  e.preventDefault();
  dragDepth++;
  $('#dropMask').classList.add('show');
});
window.addEventListener('dragleave', e => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropMask').classList.remove('show');
  }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropMask').classList.remove('show');
  try {
    const {list, hasDir} = await filesFromDataTransfer(e.dataTransfer);
    if (list.length) await importFiles(list, {hidden: hasDir});
  } catch (err) {
    toast('匯入失敗：' + err.message, true);
  }
});

// ---------- 滑鼠 ----------
let drag = null;
function startLayerDrag(list, wx, wy, e) {
  // 跟隨中的圖層若它跟的對象也在拖，只拖對象就好（不然位移會加兩次）
  const ids = new Set(list.map(l => l.id));
  list = list.filter(l => !(l.followId && l.followPos && ids.has(l.followId)));
  drag = {mode: 'layer', items: list.map(l => ({l, o: dragPos(l)})), sx: wx, sy: wy, px: e.offsetX, py: e.offsetY, moved: false};
}
overlay.addEventListener('pointerdown', e => {
  overlay.setPointerCapture(e.pointerId);
  const [wx, wy] = s2w(e.offsetX, e.offsetY);
  const pan = () => (drag = {mode: 'pan', px: e.offsetX, py: e.offsetY, cx: S.cam.x, cy: S.cam.y});
  // 中鍵 / Alt＋拖曳 = 一定是平移鏡頭（空白鍵已經是播放 / 暫停）
  if (e.button === 1 || e.altKey) {
    e.preventDefault();
    pan();
  } else if (e.shiftKey && selLayer()) {
    // Shift＋拖曳：不管點在哪都拖選取的圖層
    startLayerDrag(selectedLayers(), wx, wy, e);
  } else if (pickPin(e.offsetX, e.offsetY)) {
    // 拖定位點（優先於點骨頭、拖圖層）
    const {l, i} = pickPin(e.offsetX, e.offsetY);
    if (S.selectedId !== l.id) {
      selectOnly(l.id);
      renderLayers();
      renderProps();
    }
    const p = l.pins[i];
    drag = {mode: 'pin', l, p, i, sx: wx, sy: wy, ox: +p.x || 0, oy: +p.y || 0};
  } else {
    // 點骨頭
    const hit = pickBone(e.offsetX, e.offsetY);
    if (hit) {
      selectOnly(hit.layer.id);
      S.selectedBone = hit.bone;
      renderLayers();
      renderProps();
      return;
    }
    const l = pickLayer(wx, wy);
    if (l) {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl＋點：加選 / 取消，不拖
        if (S.multi.has(l.id)) {
          S.multi.delete(l.id);
          if (S.selectedId === l.id) S.selectedId = [...S.multi][0] ?? null;
        } else {
          S.multi.add(l.id);
          S.selectedId = l.id;
        }
        renderLayers();
        renderProps();
        return;
      }
      if (!S.multi.has(l.id)) {
        selectOnly(l.id);
        renderLayers();
        renderProps();
      } else if (S.selectedId !== l.id) {
        S.selectedId = l.id;
        renderLayers();
        renderProps();
      }
      startLayerDrag(selectedLayers(), wx, wy, e);
    } else pan();
  }
  overlay.classList.add('dragging');
});
overlay.addEventListener('pointermove', e => {
  S.cursor = s2w(e.offsetX, e.offsetY);
  if (!drag) {
    overlay.style.cursor = e.altKey ? '' : pickPin(e.offsetX, e.offsetY) ? 'crosshair' : pickLayer(...S.cursor) ? 'move' : '';
    return;
  }
  if (drag.mode === 'pin') {
    const [wx, wy] = S.cursor;
    const sx = (drag.l.sk.scaleX || 1);
    const sy = (drag.l.sk.scaleY || 1);
    drag.p.x = Math.round(drag.ox + (wx - drag.sx) / sx);
    drag.p.y = Math.round(drag.oy + (wy - drag.sy) / sy);
    const row = props.querySelector(`.pin[data-pi="${drag.i}"]`);
    if (row && drag.l === selLayer()) {
      row.querySelector('[data-pk="x"]').value = drag.p.x;
      row.querySelector('[data-pk="y"]').value = drag.p.y;
    }
    return;
  }
  if (drag.mode === 'pan') {
    S.cam.x = drag.cx - (e.offsetX - drag.px) / S.cam.scale;
    S.cam.y = drag.cy + (e.offsetY - drag.py) / S.cam.scale;
  } else {
    // 移動超過 3px 才算拖曳，單純點一下只選取
    if (!drag.moved && Math.hypot(e.offsetX - drag.px, e.offsetY - drag.py) < 3) return;
    drag.moved = true;
    const [wx, wy] = S.cursor;
    for (const {l, o} of drag.items) {
      const nx = Math.round(o[0] + wx - drag.sx);
      const ny = Math.round(o[1] + wy - drag.sy);
      if (l.followId && l.followPos) {
        l.followOffX = nx;
        l.followOffY = ny;
      } else {
        l.x = nx;
        l.y = ny;
      }
      if (l.id === S.selectedId) syncPropInputs(l);
    }
  }
});
overlay.addEventListener('pointerup', () => {
  if (drag && drag.mode === 'layer' && drag.moved) for (const {l} of drag.items) persistSoon(l);
  if (drag && drag.mode === 'pin') persistSoon(drag.l);
  drag = null;
  overlay.classList.remove('dragging');
});
overlay.addEventListener('pointerleave', () => (S.cursor = null));
overlay.addEventListener(
  'wheel',
  e => {
    e.preventDefault();
    const [wx, wy] = s2w(e.offsetX, e.offsetY);
    const f = Math.exp(-e.deltaY * 0.0015);
    S.cam.scale = Math.min(20, Math.max(0.05, S.cam.scale * f));
    S.cam.x = wx - (e.offsetX * dpr() - canvas.width / 2) / (S.cam.scale * dpr());
    S.cam.y = wy + (e.offsetY * dpr() - canvas.height / 2) / (S.cam.scale * dpr());
  },
  {passive: false}
);

function pickBone(px, py) {
  const d = dpr();
  let best = null;
  let bestDist = 10 * d;
  // 先找選取的圖層，再找其他顯示骨骼的
  const cands = S.layers.filter(l => l.type === 'spine' && l.debug && l.visible);
  const sl = selLayer();
  cands.sort((a, b) => (b === sl) - (a === sl));
  for (const l of cands) {
    for (const bone of l.sk.bones) {
      const [x, y] = w2s(bone.worldX, bone.worldY);
      const dist = Math.hypot(x - px * d, y - py * d);
      if (dist < bestDist) {
        bestDist = dist;
        best = {layer: l, bone: bone.data.name};
      }
    }
    if (best) return best;
  }
  return best;
}

function syncPropInputs(l) {
  if (l !== selLayer()) return;
  props.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k;
    if (['x', 'y', 'followOffX', 'followOffY'].includes(k) && document.activeElement !== inp) inp.value = l[k];
  });
}

// ---------- 鍵盤 ----------
window.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, select, textarea') && e.target.type !== 'checkbox') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const l = selLayer();
  switch (e.key) {
    case ' ':
      e.preventDefault();
      S.paused = !S.paused;
      updatePlayBtn();
      break;
    case 'r':
    case 'R':
      restartAll();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      stepFrames(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      stepFrames(1);
      break;
    case 's':
    case 'S':
      setCompare(S.compare === 'static' ? 'dynamic' : 'static');
      break;
    case 'n':
    case 'N': {
      const target = l && l.followId ? getLayer(l.followId) : l;
      if (target && target.seqRun) seqNext(target);
      else for (const x of S.layers) if (x.seqRun) seqNext(x);
      break;
    }
    case 'b':
    case 'B':
      if (l && l.type === 'spine') {
        l.debug = !l.debug;
        persistSoon(l);
        renderProps();
      }
      break;
    case 'Delete':
      removeSelected();
      break;
    default:
  }
});

// ---------- 面板寬度 ----------
const LS_PANELS = 'spineViewer.panels';
const PANEL_DEFAULT = {left: 240, right: 340};
const PANEL_MIN = 150;
const STAGE_MIN = 200;
function applyPanelWidths(w) {
  const main = $('.main');
  main.style.setProperty('--left-w', w.left + 'px');
  main.style.setProperty('--right-w', w.right + 'px');
}
const panelW = {...PANEL_DEFAULT, ...store.get(LS_PANELS, {})};
applyPanelWidths(panelW);
document.querySelectorAll('.splitter').forEach(sp => {
  const side = sp.dataset.side;
  sp.addEventListener('pointerdown', e => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('active');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const start = panelW[side];
    const total = $('.main').clientWidth;
    const move = ev => {
      const dx = ev.clientX - startX;
      const other = side === 'left' ? panelW.right : panelW.left;
      const max = Math.max(PANEL_MIN, total - other - STAGE_MIN - 10);
      panelW[side] = Math.round(Math.min(max, Math.max(PANEL_MIN, start + (side === 'left' ? dx : -dx))));
      applyPanelWidths(panelW);
    };
    const up = () => {
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      sp.removeEventListener('pointercancel', up);
      sp.classList.remove('active');
      document.body.classList.remove('resizing');
      store.set(LS_PANELS, panelW);
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
    sp.addEventListener('pointercancel', up);
  });
  sp.addEventListener('dblclick', () => {
    panelW[side] = PANEL_DEFAULT[side];
    applyPanelWidths(panelW);
    store.set(LS_PANELS, panelW);
  });
});

// ---------- 啟動 ----------
syncToolbar();
renderLayers();
renderProps();
requestAnimationFrame(frame);

// 給除錯用
window.spineViewer = {S, importFiles, applyWorkspace};
