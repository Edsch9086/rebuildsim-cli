// Headless REBUILD engine harness: real wasm, stub WebGL, DOM events, memory capture.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nativeFetch = globalThis.fetch;
const BIN_MAGIC = Buffer.from('RSB1');
const { parseRoom06 } = require('./room06.cjs');
const { computeHub } = require('./hub.cjs');
const { phaseFor, substageFor, substageRemaining, classifyMatch } = require('./matchstate.cjs');

const W = 1280, H = 720;
const store = new Map();
const log = (...a) => console.error(...a);

class Events {
  constructor(name) { this.name = name; this.map = new Map(); }
  addEventListener(type, fn, opts) { if (!this.map.has(type)) this.map.set(type, []); this.map.get(type).push({ fn, opts }); }
  removeEventListener(type, fn) { const a = this.map.get(type); if (a) this.map.set(type, a.filter(x => x.fn !== fn)); }
  dispatchEvent(ev) {
    ev.target ??= this; ev.currentTarget = this; ev.eventPhase = 2;
    const a = this.map.get(ev.type) || [];
    for (const { fn } of [...a]) { try { fn.call(this, ev); } catch (e) { console.error('event handler', ev.type, e); } }
    const on = this['on' + ev.type]; if (typeof on === 'function') { try { on.call(this, ev); } catch (e) { console.error('on' + ev.type, e); } }
    return !ev.defaultPrevented;
  }
}

function ev(type, props = {}) {
  return { type, bubbles: true, cancelable: true, defaultPrevented: false, isTrusted: true,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...props };
}

const constants = {
  VERSION: 0x1F02, SHADING_LANGUAGE_VERSION: 0x8B8C, VENDOR: 0x1F00, RENDERER: 0x1F01,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_VERTEX_ATTRIBS: 0x8869, MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD, MAX_VARYING_VECTORS: 0x8DFC,
  MAX_RENDERBUFFER_SIZE: 0x84E8, MAX_VIEWPORT_DIMS: 0x0D3A, MAX_SAMPLES: 0x8D57,
  MAX_COLOR_ATTACHMENTS: 0x8CDF, MAX_DRAW_BUFFERS: 0x8824, MAX_UNIFORM_BUFFER_BINDINGS: 0x8A2F,
  MAX_UNIFORM_BLOCK_SIZE: 0x8A30, MAX_ELEMENT_INDEX: 0x8D6B, MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88FF, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF,
  VIEWPORT: 0x0BA2, SCISSOR_BOX: 0x0C10, COLOR_CLEAR_VALUE: 0x0C22, ALIASED_LINE_WIDTH_RANGE: 0x846E,
  ALIASED_POINT_SIZE_RANGE: 0x846D, FRAMEBUFFER_COMPLETE: 0x8CD5, NO_ERROR: 0,
  TEXTURE0: 0x84C0, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
  VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
  ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89, UNIFORM_TYPE: 0x8A37, UNIFORM_SIZE: 0x8A38,
  UNIFORM_NAME_LENGTH: 0x8A39, UNIFORM_BLOCK_INDEX: 0x8A3A, UNIFORM_OFFSET: 0x8A3B,
  UNIFORM_ARRAY_STRIDE: 0x8A3C, UNIFORM_MATRIX_STRIDE: 0x8A3D, UNIFORM_IS_ROW_MAJOR: 0x8A3E,
  ATTRIB_TYPE: 0x8A21, ATTRIB_SIZE: 0x8A22, ATTRIB_NAME_LENGTH: 0x8A23, ATTRIB_LOCATION: 0x8A24,
  CURRENT_PROGRAM: 0x8B8D, DEPTH_BITS: 0x0D56, STENCIL_BITS: 0x0D57, SAMPLES: 0x80A9,
  FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8CD0, FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8CD1,
  FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8CD2, FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: 0x8CD3,
  FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: 0x8211, FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: 0x8210,
  FRAMEBUFFER_ATTACHMENT_RED_SIZE: 0x8212, FRAMEBUFFER_ATTACHMENT_GREEN_SIZE: 0x8213,
  FRAMEBUFFER_ATTACHMENT_BLUE_SIZE: 0x8214, FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE: 0x8215,
  FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE: 0x8216, FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE: 0x8217,
  RENDERBUFFER_WIDTH: 0x8D42, RENDERBUFFER_HEIGHT: 0x8D43, RENDERBUFFER_INTERNAL_FORMAT: 0x8D44,
  RENDERBUFFER_RED_SIZE: 0x8D50, RENDERBUFFER_GREEN_SIZE: 0x8D51, RENDERBUFFER_BLUE_SIZE: 0x8D52,
  RENDERBUFFER_ALPHA_SIZE: 0x8D53, RENDERBUFFER_DEPTH_SIZE: 0x8D54, RENDERBUFFER_STENCIL_SIZE: 0x8D55,
  RENDERBUFFER_SAMPLES: 0x8CAB, BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765,
  TEXTURE_WIDTH: 0x1000, TEXTURE_HEIGHT: 0x1001, TEXTURE_INTERNAL_FORMAT: 0x1003,
  TEXTURE_BINDING_2D: 0x8069, TEXTURE_BINDING_CUBE_MAP: 0x8514, UNPACK_ALIGNMENT: 0x0CF5,
  PACK_ALIGNMENT: 0x0D05, GPU_DISJOINT_EXT: 0x8FBB, TIMESTAMP_EXT: 0x8E28,
};

function makeGL() {
  const methods = {
    getParameter(p) {
      switch (p) {
        case 0x1F02: return 'WebGL 2.0 (headless-stub)';
        case 0x8B8C: return 'WebGL GLSL ES 3.00 (headless-stub)';
        case 0x1F00: case 0x1F01: return 'Headless';
        case 0x0D33: case 0x84E8: case 0x851C: return 16384;
        case 0x8869: return 16;
        case 0x8872: case 0x8B4C: return 16;
        case 0x8B4D: return 32;
        case 0x8DFB: case 0x8DFD: return 1024;
        case 0x8DFC: return 30;
        case 0x8D57: return 4;
        case 0x8CDF: case 0x8824: return 8;
        case 0x8A2F: return 24; case 0x8A30: return 65536; case 0x8D6B: return 4294967295;
        case 0x8073: case 0x88FF: return 2048; case 0x84FF: return 16;
        case 0x0BA2: case 0x0C10: return new Int32Array([0, 0, W, H]);
        case 0x0C22: return new Float32Array([0, 0, 0, 0]);
        case 0x846E: case 0x846D: return new Float32Array([1, 1]);
        case 0x0D3A: return new Int32Array([16384, 16384]);
        case 0x0D56: return 24; case 0x0D57: return 8; case 0x80A9: return 4;
        case 0x8B8D: return null; case 0x0CF5: case 0x0D05: return 4;
        default: return 0;
      }
    },
    getExtension() { return null; },
    getSupportedExtensions() { return []; },
    getContextAttributes() { return { alpha: false, antialias: true, depth: true, stencil: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false, desynchronized: false }; },
    isContextLost() { return false; },
    getShaderParameter() { return true; },
    getProgramParameter(p) { return (p === 0x8B86 || p === 0x8B89) ? 0 : true; },
    getShaderInfoLog() { return ''; }, getProgramInfoLog() { return ''; },
    getShaderPrecisionFormat() { return { rangeMin: 127, rangeMax: 127, precision: 23 }; },
    getActiveUniform() { return { name: 'u', size: 1, type: 0x1406 }; },
    getActiveAttrib() { return { name: 'a', size: 1, type: 0x1406 }; },
    getUniformLocation() { return 0; }, getAttribLocation() { return 0; },
    getUniformBlockIndex() { return 0; }, getActiveUniformBlockParameter() { return 0; },
    getActiveUniformBlockName() { return ''; }, getActiveUniforms() { return []; },
    getError() { return 0; }, checkFramebufferStatus() { return 0x8CD5; },
    getRenderbufferParameter() { return 0; }, getFramebufferAttachmentParameter() { return 0; },
    getTexParameter() { return 0; }, getBufferParameter() { return 0; }, getVertexAttrib() { return 0; },
    getSamplerParameter() { return 0; }, getQueryParameter() { return 0; },
    getSyncParameter() { return 0x911A; }, clientWaitSync() { return 0x911A; }, fenceSync() { return {}; },
    getInternalformatParameter() { return new Int32Array([4]); }, getTransformFeedbackVarying() { return null; },
    createShader() { return {}; }, createProgram() { return {}; }, createBuffer() { return {}; },
    createTexture() { return {}; }, createFramebuffer() { return {}; }, createRenderbuffer() { return {}; },
    createVertexArray() { return {}; }, createQuery() { return {}; }, createSampler() { return {}; },
    createTransformFeedback() { return {}; },
    readPixels() {}, texImage2D() {}, texSubImage2D() {}, texStorage2D() {}, texStorage3D() {},
    getUniformIndices() { return [0]; },
  };
  const target = { canvas: null, drawingBufferWidth: W, drawingBufferHeight: H, isFakeGL: true };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (p in methods) return methods[p];
      if (typeof p === 'string' && /^[A-Z0-9_]+$/.test(p)) {
        if (p in constants) return constants[p];
        const v = 0x10000 + (p.length * 17 + [...p].reduce((a, c) => a + c.charCodeAt(0), 0) % 0x1000);
        constants[p] = v; return v;
      }
      return () => undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function makeCanvas() {
  const c = new Events('canvas');
  const gl = makeGL();
  Object.assign(c, {
    width: W, height: H, clientWidth: W, clientHeight: H, id: 'canvas',
    style: { setProperty() {}, removeProperty() {}, cursor: '' },
    getContext(kind) { return kind === 'webgl2' ? gl : null; },
    focus() {}, blur() {}, setPointerCapture() {}, releasePointerCapture() {}, requestPointerLock() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: W, height: H, right: W, bottom: H }; },
    toDataURL() { return 'data:image/png;base64,'; },
  });
  c.gl = gl;
  return c;
}

function makeEl(tag = 'div') {
  if (tag === 'canvas') return makeCanvas();
  const e = new Events(tag);
  Object.assign(e, {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [], value: '', textContent: '',
    appendChild(x) { this.children.push(x); return x; }, removeChild() {}, remove() {},
    focus() {}, blur() {}, click() {}, setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  return e;
}

const canvas = makeCanvas();
globalThis.canvas = canvas;

const win = new Events('window');
Object.assign(win, {
  innerWidth: W, innerHeight: H, devicePixelRatio: 1, scrollX: 0, scrollY: 0, screenX: 0, screenY: 0,
  screen: { width: W, height: H, availWidth: W, availHeight: H, orientation: { type: 'landscape-primary', angle: 0 } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  localHistory: null,
});
globalThis.addEventListener = win.addEventListener.bind(win);
globalThis.removeEventListener = win.removeEventListener.bind(win);
globalThis.dispatchEvent = win.dispatchEvent.bind(win);
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = Object.assign(new Events('document'), {
  currentScript: { src: 'https://rebuildsim.com/index.js' },
  documentElement: makeEl(), body: makeEl('body'), head: makeEl('head'),
  title: '', hidden: false, visibilityState: 'visible', fullscreenElement: null, fullscreenEnabled: false,
  pointerLockElement: null, activeElement: null,
  createElement: makeEl, getElementById(id) { return id === 'canvas' ? canvas : (id === 'loading' ? makeEl('loading') : null); },
  querySelector() { return null; }, exitFullscreen() { return Promise.resolve(); }, exitPointerLock() {}, hasFocus() { return true; },
});
globalThis.navigator = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessNode/1.0', platform: 'Linux', language: 'en-US', languages: ['en-US'],
  maxTouchPoints: 0, webdriver: false, hardwareConcurrency: 8, getGamepads: () => [],
  userAgentData: { brands: [] }, mediaDevices: undefined, clipboard: undefined, serviceWorker: undefined,
  share: undefined, canShare: () => false, vibrate: () => true, keyboard: undefined,
  userActivation: { isActive: true, hasBeenActive: true },
};
// Virtual standard gamepad. The Emscripten GLFW layer polls
// navigator.getGamepads() every frame and forwards axes/buttons into wasm.
const pad = {
  id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
  index: 0, connected: true, mapping: 'standard',
  axes: [0, 0, 0, 0, 0, 0],
  buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0, touched: false })),
  timestamp: 0,
};
globalThis.navigator.getGamepads = () => [pad, null, null, null];
globalThis.__pad = pad;

globalThis.location = {
  href: 'https://rebuildsim.com/', origin: 'https://rebuildsim.com', protocol: 'https:',
  host: 'rebuildsim.com', hostname: 'rebuildsim.com', port: '', pathname: '/', search: '', hash: '',
  assign() {}, replace() {}, reload() {},
};
globalThis.localStorage = { _m: store, getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.innerWidth = W; globalThis.innerHeight = H; globalThis.devicePixelRatio = 1;
globalThis.scrollX = 0; globalThis.scrollY = 0; globalThis.screenX = 0; globalThis.screenY = 0;
globalThis.matchMedia = win.matchMedia;
globalThis.requestAnimationFrame = win.requestAnimationFrame;
globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
globalThis.history = { replaceState() {}, pushState() {}, state: null };
globalThis.Image = class { constructor() { this.width = 0; this.height = 0; } };
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.AudioContext = undefined; globalThis.webkitAudioContext = undefined;
globalThis.VideoEncoder = undefined; globalThis.VideoFrame = undefined; globalThis.AudioEncoder = undefined;
globalThis.Notification = undefined;
globalThis.rbTrack = (n, p) => { if (!String(n).startsWith('settings_snapshot')) log('TRACK', n, typeof p === 'string' ? p.slice(0,200) : JSON.stringify(p||{}).slice(0,200)); }; globalThis.rbUserProperty = () => {}; globalThis.rbLoaded = () => {};
globalThis.rbFieldsTaken = () => {}; globalThis.placeTextBoxes = (v) => log('PLACE BOXES', v); globalThis.placeFields = (v) => log('PLACE FIELDS', v);
globalThis.rbFieldValue = () => {}; globalThis.placeLinks = () => {}; globalThis.rbTypedInto = () => false;
globalThis.rbActions = {};
globalThis.fetch = async (url) => String(url).includes('/rbq/') ? new Response('', { status: 204 }) : new Response(new Uint8Array(), { status: 200 });
globalThis.WebGLRenderingContext = class { static [Symbol.hasInstance]() { return false; } };
globalThis.WebGL2RenderingContext = class { static [Symbol.hasInstance](x) { return !!(x && x.isFakeGL); } };

// ---------------------------------------------------------------------------
// Engine: args, WebSocket tap, wasm boot, UI flow, state extraction, stdin API
// ---------------------------------------------------------------------------

const assetArg = process.argv.indexOf('--asset-dir');
const ASSET_DIR = (assetArg >= 0 ? process.argv[assetArg + 1] : '')
  || process.env.RB_ASSET_DIR || path.join(__dirname, 'cache');
const BUILD_FILE = path.join(ASSET_DIR, 'build.json');

function getArg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return def;
  return v;
}
const OPT = {
  code: getArg('code', ''),
  username: getArg('username', 'Bot'),
  create: process.argv.includes('--create'),
  start: process.argv.includes('--start'),
  spawn: getArg('spawn', ''),
  emitHz: Math.max(1, Math.min(60, Number(getArg('emit-hz', '10')) || 10)),
  debug: process.argv.includes('--debug'),
  gamepad: process.argv.includes('--gamepad'),
  server: getArg('server', ''),
  fuel: getArg('fuel', ''),
  binary: process.argv.includes('--binary'),
  fieldFrame: process.argv.includes('--field-frame'),
  frameAlliance: getArg('frame-alliance', ''),
  hubOrder: getArg('hub-order', ''),
  expectBuild: getArg('expect-build', ''),
  noBuildCheck: process.argv.includes('--no-build-check'),
};
globalThis.__RB_DEBUG = OPT.debug;
if (!fs.existsSync(path.join(ASSET_DIR, 'index.js')) || !fs.existsSync(path.join(ASSET_DIR, 'index.wasm'))) {
  console.error(`missing game assets in ${ASSET_DIR}; run: node prepare.mjs`);
  process.exit(2);
}
OPT.code = String(OPT.code || '').trim().toUpperCase();
log('engine options', JSON.stringify(OPT));
function optionError(error, msg) {
  console.error(msg);
  try { emit({ type: 'error', error, detail: msg }); } catch {}
  setTimeout(() => process.exit(2), 100);
}
const valueFlags = ['--code', '--username', '--spawn', '--server', '--fuel',
  '--frame-alliance', '--hub-order', '--expect-build', '--emit-hz', '--asset-dir'];
for (const flag of valueFlags) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && (i + 1 >= process.argv.length || process.argv[i + 1].startsWith('--'))) {
    optionError('missing_value', `${flag} needs a value`);
  }
}
if (OPT.code && !/^[A-Z0-9]{5}$/.test(OPT.code)) {
  optionError('invalid_code', 'invalid --code: use a 5-character room code');
}
if (OPT.hubOrder) {
  if (/^r(ed)?$/i.test(OPT.hubOrder)) OPT.hubOrder = 'red';
  else if (/^b(lue)?$/i.test(OPT.hubOrder)) OPT.hubOrder = 'blue';
  else optionError('invalid_hub_order', 'invalid --hub-order: use red or blue');
}
if (OPT.frameAlliance) {
  if (/^r(ed)?$/i.test(OPT.frameAlliance)) OPT.frameAlliance = 'red';
  else if (/^b(lue)?$/i.test(OPT.frameAlliance)) OPT.frameAlliance = 'blue';
  else optionError('invalid_frame_alliance', 'invalid --frame-alliance: use red or blue');
}
if (!OPT.username || OPT.username !== OPT.username.trim()
    || Buffer.byteLength(OPT.username, 'utf8') > 10
    || !/^[\x20-\x7e]+$/.test(OPT.username)) {
  console.error('invalid --username: use 1-10 printable ASCII characters without leading/trailing spaces');
  try { emit({ type: 'error', error: 'invalid_username' }); } catch {}
  setTimeout(() => process.exit(2), 100);
}
if (OPT.spawn) log('note: --spawn is not implemented yet; using the default seat');
if (OPT.fuel) {
  const fuelValue = String(OPT.fuel).replace('%', '');
  if (!['25', '50', '75', '100', '125', '150'].includes(fuelValue)) {
    console.error('invalid --fuel: use 25, 50, 75, 100, 125, or 150');
    try { emit({ type: 'error', error: 'invalid_fuel' }); } catch {}
    setTimeout(() => process.exit(2), 100);
  }
  log('fuel rule request', OPT.fuel);
}

if (OPT.server) {
  let host = '';
  let port = '';
  const bracketed = OPT.server.match(/^\[([^\]]+)\]:(\d+)$/);
  const plain = OPT.server.match(/^([^:]+):(\d+)$/);
  if (bracketed) {
    host = bracketed[1]; port = bracketed[2];
  } else if (plain) {
    host = plain[1]; port = plain[2];
  } else {
    optionError('invalid_server', 'invalid --server: use HOST:PORT (IPv6 as [addr]:port)');
  }
  const portNum = Number(port);
  if (!host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    optionError('invalid_server', 'invalid --server port');
  }
  globalThis.location.host = OPT.server;
  globalThis.location.hostname = host;
  globalThis.location.port = port || '';
  globalThis.location.protocol = 'http:';
  globalThis.location.origin = 'http://' + OPT.server;
  globalThis.location.href = 'http://' + OPT.server + '/';
  log('using server', OPT.server);
}

const wslog = [];
const wslogEnabled = OPT.debug || process.argv.includes('--wslog') || process.env.RB_WSLOG === '1';
let wsSeq = 0, wsOpen = 0, wsClosed = 0, lastRoomWsId = null;
let role = null, lastRoomKey = '', matchEndScheduled = false;
let readyClicked = false, startClicked = false, fuelApplied = false, uiBusy = false;
let startClicks = 0, resultsClickScheduled = false, resultsPending = false;
let lastReadyClickAt = 0;
let matchWasActive = false;
let roomResetTimer = null, seatDemoteTimer = null, seatMissingSince = 0, last41At = 0;
let matchStartedAt = 0, lastOurSeatAt = 0;
let roomNames = new Set([OPT.username]);
let lastMatchTime = null;
let matchStarted = false;
let roomCode = OPT.code;
let host = false;
let seated = false;
let last41 = null;
let lastRoom06 = null;
let roomSeats = [];
let scores = { red: 0, blue: 0 };
let autoScores = { red: 0, blue: 0 };
let protocolVersion = null;
let lastCountdown = null;
let clockStarted = false;
let matchEndTimer = null;
let ourAllianceCache = null;

function addPrintableNames(buf) {
  let run = '';
  const flush = () => {
    if (run.length >= 2 && run.length <= 24 && /^[\x20-\x7e]+$/.test(run)) {
      const s = run.trim();
      if (!s) return;
      if (s === roomCode || s.startsWith(roomCode)) return;
      if (s.includes('#')) return;
      if (!/[A-Za-z]/.test(s)) return;
      if (/^[0-9-]+$/.test(s)) return;
      if (/^["']/.test(s)) return;
      if (!/^(open|red|blue|auto|human|referee|private|public)$/i.test(s)) roomNames.add(s);
    }
    run = '';
  };
  for (const b of buf) {
    if (b >= 0x20 && b < 0x7f) run += String.fromCharCode(b);
    else flush();
  }
  flush();
}

let seatsKey = '';
let identityFatal = false;
function failIdentity(reason, detail) {
  if (identityFatal) return;
  identityFatal = true;
  log('identity failure:', reason, detail || '');
  emit({ type: 'error', error: reason, detail: detail || '' });
  setTimeout(() => process.exit(8), 100);
}
let joinFatal = false, spectatorFatal = false, spectatorExitTimer = null;
function failSpectator(detail) {
  if (spectatorFatal || identityFatal || joinFatal) return;
  spectatorFatal = true;
  log('joined without a driver seat; exiting', detail || '');
  emit({ type: 'error', error: 'spectator', detail: detail || '' });
  spectatorExitTimer = setTimeout(() => process.exit(7), 200);
}
function failJoin(reason, detail) {
  if (identityFatal || joinFatal) return;
  joinFatal = true;
  log('join failure:', reason, detail || '');
  emit({ type: 'error', error: reason, detail: detail || '' });
  setTimeout(() => process.exit(2), 100);
}
function emitRoom() {
  const key = `${roomCode}|${host}|${seated}|${role}|${!!flow.match}|${roomSeats.map(s => `${s.seat}:${s.name}:${s.robot_id}:${s.team_flag}:${s.alliance}:${s.ready}`).join(',')}`;
  if (key === lastRoomKey) return;
  lastRoomKey = key;
  emit({ type: 'room', code: roomCode, host, seated, role,
    match_active: !!flow.match, seats: roomSeats });
}

function resetMatchState() {
  matchStarted = false;
  flow.match = false;
  clockStarted = false;
  matchEndScheduled = false;
  if (matchEndTimer) { clearTimeout(matchEndTimer); matchEndTimer = null; }
  readyClicked = false;
  startClicked = false;
  startClicks = 0;
  resultsClickScheduled = false;
  resultsPending = false;
  lastReadyClickAt = 0;
  seatsKey = '';
  matchWasActive = false;
  matchStartedAt = 0;
  for (const s of roomSeats) s.ready = null;
  lastRoomKey = '';
  if (roomResetTimer) { clearTimeout(roomResetTimer); roomResetTimer = null; }
  if (seatDemoteTimer) { clearTimeout(seatDemoteTimer); seatDemoteTimer = null; }
  seatMissingSince = 0;
  lastOurSeatAt = seated ? Date.now() : 0;
  last41At = 0;
  fuelVerifyFails = 0;
  poseCache.clear();
  poseMissUntil.clear();
  lastPose.clear();
  fuelAddr = 0;
  lastFuelScan = 0;
  lastFuelVerify = 0;
  lastFuelLocate = 0;
  fuelSource = null;
  fuelVerified = false;
  fuelPacket.clear();
  fuelPacketCount = 0;
  allianceByName.clear();
  allianceSourceByName.clear();
  ourAllianceCache = null;
  roomSeats = [];
  roomNames = new Set();
  lastRoom06 = null;
  cancelUiTimers();
  releaseInputs();
  lastMatchTime = null;
  lastCountdown = null;
  last41 = null;
  scores = { red: 0, blue: 0 };
  autoScores = { red: 0, blue: 0 };
  lastScoreKey = '';
}

function noteSeatPresence(ours) {
  if (ours) {
    seatMissingSince = 0;
    lastOurSeatAt = Date.now();
    if (seatDemoteTimer) { clearTimeout(seatDemoteTimer); seatDemoteTimer = null; }
    if (spectatorExitTimer) {
      clearTimeout(spectatorExitTimer);
      spectatorExitTimer = null;
      spectatorFatal = false;
      seated = true;
      role = 'driver';
      log('seat returned before spectator exit; recovering');
      emitRoom();
    }
    return;
  }
  if (!seated) return;
  if (seatMissingSince) return;
  const delay = matchStarted ? 5000 : 2500;
  seatMissingSince = Date.now();
  seatDemoteTimer = setTimeout(() => {
    seatDemoteTimer = null;
    if (!seatMissingSince) return;
    if (seated && Date.now() - seatMissingSince >= delay) {
      seated = false;
      role = 'spectator';
      log(`seat not present for ${delay / 1000}s; demoting to spectator`);
      emitRoom();
      failSpectator(`seat missing for ${delay / 1000}s`);
    }
  }, delay + 200);
}

function clearRoomIdentity() {
  fuelApplied = false;
  roomSeats = [];
  roomNames = new Set();
  allianceByName.clear();
  allianceSourceByName.clear();
  ourAllianceCache = null;
  seatsKey = '';
  lastRoomKey = '';
}

function applyRoom06(buf) {
  const parsed = parseRoom06(buf);
  if (!parsed.seats.length) {
    // A parse miss is not evidence that the seat is gone. Keep the last good
    // list but debounce the missing-seat path so repeated empty packets can
    // demote/exit instead of leaving a zombie.
    log('room state parse produced no seats; keeping last good seat list');
    if (flow.joined && seated && lastOurSeatAt
        && Date.now() - lastOurSeatAt > 15000) {
      log('no seat in any room packet for 15s; starting demotion');
      noteSeatPresence(false);
    }
    return false;
  }
  if (roomSeats.length) {
    const oursNow = parsed.seats.some(s => s.name === OPT.username);
    const oursBefore = roomSeats.some(s => s.name === OPT.username);
    if (oursBefore && !oursNow) {
      // Two consecutive omissions are required before starting the demotion
      // timer; one partial packet must not kill a live match.
      log('room packet omits our seat; keeping last good seat list');
      noteSeatPresence(false);
      return false;
    }
    noteSeatPresence(true);
    if (matchStarted) {
      const byName = new Map(parsed.seats.map(s => [s.name, s]));
      for (const old of roomSeats) {
        const cur = byName.get(old.name);
        if (!cur || cur.team_flag !== old.team_flag) {
          log('room roster changed during a match; keeping last good seat list');
          return false;
        }
      }
      if (parsed.seats.length < roomSeats.length) {
        log('room state lost seats during a match; keeping last good seat list');
        return false;
      }
    }
  }
  roomSeats = parsed.seats;
  if (roomSeats.some(s => s.name === OPT.username)) noteSeatPresence(true);
  if (roomSeats.length) {
    const names = roomSeats.map(s => s.name);
    // Name-keyed identity is only ambiguous when OUR name is duplicated. Two
    // unrelated humans with the same name must not kill every bot in the room.
    if (names.filter(n => n === OPT.username).length > 1) {
      failIdentity('duplicate_names', names.join(','));
      return roomSeats;
    }
    // The player records are the real occupants; drop printable-run noise.
    roomNames = new Set(names);
    if (OPT.username) roomNames.add(OPT.username);
    const seatNames = new Set(names);
    for (const n of [...allianceByName.keys()]) {
      if (!seatNames.has(n)) {
        allianceByName.delete(n);
        allianceSourceByName.delete(n);
      }
    }
  }
  // The team byte (0 red, 1 blue) is authoritative when present; the seat
  // order fallback (first 3 red, next 3 blue) covers older builds.
  for (const seat of roomSeats) {
    allianceByName.set(seat.name, seat.alliance);
    allianceSourceByName.set(seat.name, 'room');
    if (seat.name === OPT.username) ourAllianceCache = seat.alliance;
  }
  const key = roomSeats.map(s => `${s.seat}:${s.name}:${s.robot_id}:${s.team_flag}:${s.alliance}:${s.ready}`).join('|');
  if (key !== seatsKey) {
    seatsKey = key;
    emit({ type: 'seats', code: roomCode, seats: roomSeats });
  }
  if (flow.joined) {
    const ours = roomSeats.some(s => s.name === OPT.username);
    if (matchStarted && seated && !ours) {
      log('seat missing during match; debouncing');
      noteSeatPresence(false);
      return false;
    }
    if (!ours) {
      noteSeatPresence(false);
      return false;
    }
    if (!seated || role !== 'driver') {
      seated = true;
      role = 'driver';
      emitRoom();
    }
    const ourSeat = roomSeats.find(s => s.name === OPT.username);
    if (ourSeat && ourSeat.ready === true) readyClicked = true;
    readyIfNeeded();
    if (host && OPT.start && !startClicked && !matchStarted && !uiBusy
        && roomSeats.length && roomSeats.every(s => s.ready === true)) {
      startClicked = true;
      uiLater(() => clickStartWhenReady(0), 1000);
    }
  }
  return true;
}

function parse41(buf) {
  last41 = buf;
  last41At = Date.now();
  if (buf.length >= 10) {
    const dv0 = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    lastCountdown = dv0.getFloat32(6, true);
  }
  if (buf.length >= 18) {
    // Decoded from a scoreboard capture: u16 red/blue totals at +14/+16.
    scores = { red: buf.readUInt16LE(14), blue: buf.readUInt16LE(16) };
  }
  if (buf.length >= 30) {
    // Auto-only breakdown at +18/+28; freezes when auto ends.
    autoScores = { red: buf.readUInt16LE(18), blue: buf.readUInt16LE(28) };
  }
  if (buf.length >= 14) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    lastMatchTime = dv.getFloat32(10, true);
    if (!Number.isFinite(lastMatchTime)) lastMatchTime = null;
    if (lastMatchTime > 0) clockStarted = true;
  }
}

function onMatchStart() {
  const ended = flow.match && clockStarted && lastMatchTime != null && lastMatchTime <= 0.05;
  const stale = flow.match && (last41At
    ? Date.now() - last41At > 1500
    : matchStartedAt && Date.now() - matchStartedAt > 3000);
  // Match start is idempotent per match: /multi/match and match_start both fire,
  // and a second call during the countdown must not wipe the first clock/fuel
  // packets. A new match after an ended/abandoned one (no /room screen) is allowed.
  if (flow.match && !ended && !stale) return;
  resetMatchState();
  flow.match = true;
  matchStarted = true;
  matchWasActive = true;
  matchStartedAt = Date.now();
  startClicks = 0;
  resultsPending = false;
  readyClicked = true;
  startClicked = true;
  // Seat order does not change during a match; re-apply it after the reset
  // cleared the identity maps.
  if (lastRoom06) applyRoom06(lastRoom06);
  emit({ type: 'match', phase: 'countdown', substage: 'prematch',
    time: null, seats: roomSeats });
  if (flow.joined) emitRoom();
}

function handleServerFrame(buf, wsId) {
  if (!buf || !buf.length) return;
  const type = buf[0];
  if ((type === 0x41 || type === 0x42) && lastRoomWsId && wsId && wsId !== lastRoomWsId) {
    log('ignoring match/fuel frame from a non-room socket', wsId);
    return;
  }
  if (type === 0x06) {
    // The room-list socket can carry room-state-looking frames too; only the
    // second (room) connection is authoritative.
    if (wsId === 1) {
      log('ignoring 0x06 from the room-list socket');
      return;
    }
    if (lastRoomWsId && wsId && wsId !== lastRoomWsId) {
      log('ignoring 0x06 from a stale socket', wsId);
      return;
    }
    // room state: room code at 1..5, then seat records in seat order.
    const nextCode = buf.subarray(1, 6).toString('latin1').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(nextCode)) {
      log('ignoring room packet with malformed code');
      return;
    }
    if (!lastRoomWsId && wsId && wsId !== 1) lastRoomWsId = wsId;
    if (roomCode && nextCode !== roomCode) {
      log('room code changed', roomCode, '->', nextCode);
      clearRoomIdentity();
      lastRoom06 = null;
      resetMatchState();
    }
    roomCode = nextCode || roomCode;
    if (OPT.code && roomCode && roomCode.toUpperCase() !== OPT.code.toUpperCase()) {
      failJoin('room_code_mismatch', `joined ${roomCode}, expected ${OPT.code}`);
      return;
    }
    addPrintableNames(buf);
    const accepted = applyRoom06(buf);
    if (accepted) {
      // Only an accepted packet becomes the last-good seat source or tags the
      // room socket; a stale/partial packet must not steal either.
      lastRoom06 = Buffer.from(buf);
      if (!lastRoomWsId && wsId) lastRoomWsId = wsId;
    }
    if (globalThis.__RB_DEBUG) log('ROOM06', buf.toString('hex'));
    log('room state', roomCode, 'names', [...roomNames].slice(0, 12), 'len', buf.length);
    if (flow.joined && !identityFatal) emitRoom();
  } else if (type === 0x41) {
    parse41(buf);
  } else if (type === 0x21) {
    // S->C protocol hello: 21 00 01 00 00 (version at byte 2)
    if (buf.length >= 3 && buf[2] !== 1) {
      log('protocol version mismatch: server', buf[2], 'engine expects 1');
      emit({ type: 'error', error: 'protocol_mismatch', server: buf[2], expected: 1 });
      setTimeout(() => process.exit(4), 100);
    }
    const v = buf.length >= 3 ? buf[2] : null;
    if (v !== protocolVersion) {
      protocolVersion = v;
      emit({ type: 'protocol', version: protocolVersion });
    }
  } else if (type === 0x42) {
    parseFuelPacket(buf);
  }
}

const NativeWS = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWS {
  constructor(url, protocols) {
    super(url, protocols);
    const id = ++wsSeq;
    this.__rbId = id;
    this.binaryType = 'arraybuffer';
    this.addEventListener('message', (e) => {
      let buf = null;
      if (e.data instanceof ArrayBuffer) buf = Buffer.from(e.data);
      else if (ArrayBuffer.isView(e.data)) buf = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      else if (typeof e.data === 'string') buf = Buffer.from(e.data, 'latin1');
      if (buf) {
        if (wslogEnabled) {
          wslog.push({ dir: 'recv', len: buf.length, hex: buf.toString('hex'), t: Date.now() });
          if (wslog.length > 20000) wslog.splice(0, 10000);
        }
        handleServerFrame(buf, id);
      }
    });
    this.__rbOpened = false;
    this.addEventListener('open', () => {
      this.__rbOpened = true;
      wsOpen++;
      if (globalThis.__RB_DEBUG) log('WS open', id, url);
      emit({ type: 'ws', state: 'open', id, url });
    });
    this.addEventListener('close', (e) => {
      if (this.__rbOpened) {
        wsOpen = Math.max(0, wsOpen - 1);
        wsClosed++;
      }
      const room = id === lastRoomWsId;
      log('WS close', id, e.code, e.reason, room ? '(room)' : '');
      emit({ type: 'ws', state: 'close', id, code: e.code, reason: e.reason, url, room });
      if (id === lastRoomWsId) lastRoomWsId = null;
    });
    this.addEventListener('error', () => {
      if (globalThis.__RB_DEBUG) log('WS error', id);
      emit({ type: 'ws', state: 'error', id, url });
    });
    const s = this.send.bind(this);
    this.send = (data) => {
      let buf = null;
      if (typeof data === 'string') buf = Buffer.from(data, 'latin1');
      else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
      else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (buf) {
        if (wslogEnabled) {
          wslog.push({ dir: 'send', len: buf.length, hex: buf.toString('hex'), t: Date.now() });
          if (wslog.length > 20000) wslog.splice(0, 10000);
        }
        if (globalThis.__RB_DEBUG && buf[0] === 0x40) {
          const h = buf.toString('hex');
          if (h !== globalThis.__lastInputHex) { globalThis.__lastInputHex = h; log('INPUT', h); }
        }
      }
      return s(data);
    };
  }
};
globalThis.__wslog = wslog;

const Module = {
  canvas,
  locateFile: (f) => path.join(ASSET_DIR, f),
  wasmBinary: fs.readFileSync(path.join(ASSET_DIR, 'index.wasm')),
  print: (s) => log('[out]', s),
  printErr: (s) => console.error('[err]', s),
  onRuntimeInitialized: () => { globalThis.__ready = true; log('RUNTIME INIT'); },
  setStatus: (s) => { if (s) log('[status]', s); },
  noExitRuntime: true,
};
globalThis.Module = Module;

let mem = null;
const origInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function (bin, imports) {
  const r = await origInstantiate.call(this, bin, imports);
  const inst = r.instance || r;
  globalThis.__wasm = inst;
  mem = Object.values(inst.exports).find((v) => v instanceof WebAssembly.Memory) || inst.exports.memory;
  log('wasm memory', mem && mem.buffer.byteLength);
  return r;
};

let rafCount = 0;
const origRAF = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (cb) => { rafCount++; return origRAF(cb); };

process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT', e);
  try { emit({ type: 'error', error: 'uncaught', detail: String(e) }); } catch {}
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED', e);
  try { emit({ type: 'error', error: 'unhandled_rejection', detail: String(e) }); } catch {}
  setTimeout(() => process.exit(1), 100);
});

// ---------------------------------------------------------------------------
// wasm memory helpers
// ---------------------------------------------------------------------------

function u8() { return new Uint8Array(mem.buffer); }
function dv() { return new DataView(mem.buffer); }
function f32(off) { return dv().getFloat32(off, true); }
function u16(off) { return dv().getUint16(off, true); }
function u32(off) { return dv().getUint32(off, true); }
function inField(x, y) { return x > -12 && x < 12 && y > -8 && y < 8; }

let fuelAddr = 0;
let lastFuelScan = 0;
let lastFuelVerify = 0;
let fuelPacketCount = 0;
let fuelSource = null;
let fuelVerified = false;
let fuelVerifyFails = 0;
const FUEL_Z_OFFSET = Math.round(0.045 * 4096);
let lastFuelLocate = 0;
const fuelPacket = new Map();
let initialFuelPacket = null;

function parseFuelPacket(buf) {
  if (buf.length < 9) return;
  const total = buf.readUInt16LE(5);
  const n = buf.readUInt16LE(7);
  if (total !== fuelPacketCount) {
    fuelPacketCount = total;
    fuelAddr = 0;
    fuelSource = null;
    fuelVerified = false;
    fuelVerifyFails = 0;
    fuelPacket.clear();
  }
  let added = 0;
  for (let i = 0; i < n; i++) {
    const off = 9 + i * 24;
    if (off + 24 > buf.length) break;
    const id = buf.readUInt16LE(off);
    if (id >= total && total > 0) continue;
    fuelPacket.set(id, {
      id,
      count: buf.readUInt16LE(off + 2),
      flags: buf.readUInt32LE(off + 8),
      seen: Date.now(),
      x: buf.readUInt16LE(off + 12),
      y: buf.readUInt16LE(off + 14),
      z: buf.readUInt16LE(off + 16),
      vx: buf.readUInt16LE(off + 18),
      vy: buf.readUInt16LE(off + 20),
      vz: buf.readUInt16LE(off + 22),
    });
    added++;
  }
  if (!initialFuelPacket && added) initialFuelPacket = [...fuelPacket.values()].map(r => ({ ...r }));
  if (!fuelAddr && fuelPacket.size) {
    const now = Date.now();
    if (now - lastFuelLocate > 250) { lastFuelLocate = now; locateFuelFromPacket(); }
  }
}

function locateFuelFromPacketInner() {
  if (!mem || !fuelPacketCount) return 0;
  const a = u8();
  const hay = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const candidates = [...fuelPacket.values()].filter(r => r.id < fuelPacketCount);
  const present = candidates.filter(r => r.count > 0);
  const probes = (present.length ? present : candidates)
    .sort((a, b) => b.seen - a.seen)
    .slice(0, 10);
  if (!probes.length) return 0;
  const pat = Buffer.alloc(4);
  for (const probe of probes) {
    pat.writeUInt16LE(probe.x, 0);
    pat.writeUInt16LE(probe.y, 2);
    let pos = 0, hits = 0;
    while (hits++ < 40) {
      const hit = hay.indexOf(pat, pos);
      if (hit < 0) break;
      pos = hit + 1;
      const base = hit - 1 - probe.id * 7;
      if (base < 0) continue;
      let ok = 0, total = 0, presentMatches = 0;
      for (const q of probes) {
        const res = fuelProbeResult(a, base + q.id * 7, q, 3);
        if (res === 'invalid') continue;
        total++;
        if (res === 'absent') { ok++; continue; }
        if (res === 'present') { ok++; presentMatches++; }
      }
      if (total >= Math.min(4, probes.length) && ok >= Math.ceil(total * 0.7)
          && (presentMatches >= 1 || present.length === 0)) {
        fuelAddr = base;
        fuelSource = 'packet';
        fuelVerified = true;
        log('fuel array at', '0x' + base.toString(16), 'count', fuelPacketCount);
        return base;
      }
    }
  }
  return 0;
}

function locateFuelFromPacket() {
  const t0 = Date.now();
  const base = locateFuelFromPacketInner();
  const spent = Date.now() - t0;
  if (spent > 100 && last41At) last41At += spent;
  return base;
}

function validFuelRecord(a, off) {
  if (off + 7 > a.length) return false;
  const f = a[off];
  if (f !== 0 && f !== 1) return false;
  if (f === 0) return true; // consumed/absent records may be zeroed
  const z = a[off + 5] | (a[off + 6] << 8);
  return z >= 30000 && z <= 40000;
}

function fuelProbeResult(a, off, p, tol) {
  if (!validFuelRecord(a, off)) return 'invalid';
  if (a[off] === 0) return p.count === 0 ? 'absent' : 'mismatch';
  const mx = a[off + 1] | (a[off + 2] << 8);
  const my = a[off + 3] | (a[off + 4] << 8);
  const mz = a[off + 5] | (a[off + 6] << 8);
  if (Math.abs(mx - p.x) <= tol && Math.abs(my - p.y) <= tol
      && Math.abs((mz + FUEL_Z_OFFSET) - p.z) <= tol + 1) return 'present';
  return 'mismatch';
}

function verifyFuelBase() {
  if (!fuelAddr || !fuelPacket.size || !mem) return false;
  const a = u8();
  const all = [...fuelPacket.values()];
  const present = all.filter(r => r.count > 0);
  const probes = (present.length ? present : all)
    .sort((a, b) => b.seen - a.seen)
    .slice(0, 5);
  let checked = 0, ok = 0, presentChecked = 0, presentOk = 0;
  for (const p of probes) {
    const res = fuelProbeResult(a, fuelAddr + p.id * 7, p, 3);
    if (res === 'invalid') return false;
    checked++;
    if (res === 'absent') { ok++; continue; }
    presentChecked++;
    if (res === 'present') { ok++; presentOk++; }
  }
  const need = Math.min(3, probes.length);
  if (checked < need) return false;
  if (presentChecked > 0) return presentOk >= Math.max(1, Math.ceil(presentChecked * 0.6));
  return present.length === 0;
}

function scanFuelRun() {
  if (!mem) return 0;
  const count = fuelPacketCount;
  if (!count) return 0;
  const a = u8();
  if (count < 3) {
    // Tiny matches have no long run to anchor on, so match every packet
    // record (x/y/z and present) exactly. This is stronger than the
    // single-hit packet locator.
    const probes = [...fuelPacket.values()].filter(r => r.id < count);
    if (probes.length < count) return 0;
    const lim = a.length - count * 7;
    for (let i = 0x10000; i <= lim; i++) {
      let ok = true, presentMatches = 0;
      for (const p of probes) {
        const res = fuelProbeResult(a, i + p.id * 7, p, 3);
        if (res === 'invalid' || res === 'mismatch') { ok = false; break; }
        if (res === 'present') presentMatches++;
      }
      if (ok && (presentMatches >= 1 || probes.every(p => p.count === 0))) {
        fuelAddr = i;
        fuelSource = 'scan';
        fuelVerified = true;
        log('fuel array (tiny scan) at', '0x' + i.toString(16), 'count', count);
        return i;
      }
    }
    return 0;
  }
  const probe = Math.min(count, 64);
  const lim = a.length - probe * 7;
  const spread = count > probe
    ? [...new Set([count - 1, Math.floor(count / 2), Math.floor(count / 3), Math.floor(count * 2 / 3), 8, 16, 32, 63])]
      .filter(j => j >= probe && j < count)
    : [];
  for (let i = 0x10000; i <= lim; i++) {
    let ok = true;
    for (let j = 0; j < probe; j++) {
      if (!validFuelRecord(a, i + j * 7)) { ok = false; break; }
    }
    if (!ok) continue;
    for (const j of spread) {
      if (!validFuelRecord(a, i + j * 7)) { ok = false; break; }
    }
    if (ok) {
      // Correlate with recent packet records so an older copy elsewhere in
      // the heap is not accepted as the live fuel array.
      const allProbes = [...fuelPacket.values()].filter(r => r.id < count);
      const presentProbes = allProbes.filter(r => r.count > 0);
      const probes = (presentProbes.length ? presentProbes : allProbes).slice(-5);
      let matched = 0, presentMatches = 0;
      for (const p of probes) {
        const res = fuelProbeResult(a, i + p.id * 7, p, 6);
        if (res === 'absent') matched++;
        else if (res === 'present') { matched++; presentMatches++; }
      }
      if (probes.length && matched < Math.ceil(probes.length * 0.6)) continue;
      if (presentProbes.length && presentMatches === 0) continue;
      fuelAddr = i;
      fuelSource = 'scan';
      fuelVerified = probes.length > 0;
      log('fuel array (scan) at', '0x' + i.toString(16), 'count', count);
      return i;
    }
  }
  return 0;
}

function findFuelArray() {
  if (!mem) return 0;
  if (fuelAddr) {
    if (verifyFuelBase()) return fuelAddr;
    log('fuel base moved; relocating');
    fuelAddr = 0;
    fuelSource = null;
  }
  if (fuelPacket.size) {
    const b = locateFuelFromPacket();
    if (b) return b;
  }
  const scanStart = Date.now();
  const scanned = scanFuelRun();
  const spent = Date.now() - scanStart;
  // Compensate only the time actually spent in the synchronous scan; do not
  // mask a genuine loss of 0x41.
  if (spent > 100 && last41At) last41At += spent;
  return scanned;
}

function readFuel() {
  refreshFrame();
  if (!fuelAddr || !mem || !fuelPacketCount) return [];
  const a = u8();
  const count = fuelPacketCount;
  if (fuelAddr + count * 7 > a.length) {
    fuelAddr = 0;
    fuelSource = null;
    fuelVerified = false;
    return [];
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = fuelAddr + i * 7;
    const present = a[off] === 1;
    const x = ((a[off + 1] | (a[off + 2] << 8)) - 0x8000) / 4096;
    const y = ((a[off + 3] | (a[off + 4] << 8)) - 0x8000) / 4096;
    const z = ((a[off + 5] | (a[off + 6] << 8)) - 0x8000) / 4096 + 0.045;
    const p = fuelPacket.get(i);
    const fp = allianceVec(x, y);
    const item = { id: i, x: +fp.x.toFixed(4), y: +fp.y.toFixed(4), z: +z.toFixed(4), present };
    if (p) {
      const fv = allianceVec((p.vx - 0x8000) / 4096, (p.vy - 0x8000) / 4096);
      item.vx = +fv.x.toFixed(3);
      item.vy = +fv.y.toFixed(3);
      item.vz = +(((p.vz - 0x8000) / 4096)).toFixed(3);
      item.count = p.count;
      item.flags = p.flags;
    }
    out.push(item);
  }
  return out;
}

const poseCache = new Map();
const poseMissUntil = new Map();
function findPose(name) {
  if (!mem || !name) return null;
  const nowMs = Date.now();
  if ((poseMissUntil.get(name) || 0) > nowMs) return null;
  const a = u8();
  const cached = poseCache.get(name);
  if (cached != null && cached > 0 && cached + 0x60 < a.length && a[cached - 1] === 1) {
    const nameBuf = Buffer.from(name, 'utf8');
    const nameLen = nameBuf.length;
    const cachedName = Buffer.from(a.buffer, a.byteOffset + cached, nameLen);
    if (!cachedName.equals(nameBuf) || a[cached + nameLen] !== 0) {
      poseCache.delete(name);
    } else {
    const x = f32(cached + 0x1b), y = f32(cached + 0x1f), z = f32(cached + 0x23);
    const heading = f32(cached + 0x3f), valid = f32(cached + 0x57);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        && Number.isFinite(heading) && Math.abs(z) < 5
        && inField(x, y) && Math.abs(heading) <= 20 && valid === 1) {
      poseMissUntil.delete(name);
      return { x, y, z, heading, addr: cached, source: (cached >= 0x500000 && cached < 0x530000) ? 'predicted' : 'acked' };
    }
    }
    poseCache.delete(name);
  }
  const buf = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const needle = Buffer.from(name, 'utf8');
  const nameLen = needle.length;
  let pos = 0;
  const candidates = [];
  while (true) {
    const occ = buf.indexOf(needle, pos);
    if (occ < 0) break;
    pos = occ + 1;
    if (occ < 1 || occ + 0x60 >= a.length) continue;
    if (a[occ - 1] !== 1) continue;
    if (occ + nameLen >= a.length || a[occ + nameLen] !== 0) continue;
    const x = f32(occ + 0x1b);
    const y = f32(occ + 0x1f);
    const z = f32(occ + 0x23);
    const heading = f32(occ + 0x3f);
    const valid = f32(occ + 0x57);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
        || !Number.isFinite(heading) || Math.abs(z) >= 5) continue;
    if (!inField(x, y)) continue;
    if (Math.abs(heading) > 20) continue;
    if (valid !== 1) continue;
    candidates.push({ x, y, z, heading, addr: occ });
  }
  if (!candidates.length) {
    poseMissUntil.set(name, Date.now() + 1000);
    return null;
  }
  // The render/model heap region carries a higher-rate predicted copy.
  const predicted = candidates.filter(c => c.addr >= 0x500000 && c.addr < 0x530000);
  const chosen = predicted.length
    ? predicted.sort((a, b) => b.addr - a.addr)[0]
    : candidates.sort((a, b) => a.addr - b.addr)[0];
  poseCache.set(name, chosen.addr);
  poseMissUntil.delete(name);
  return { ...chosen, source: predicted.length ? 'predicted' : 'acked' };
}

const lastPose = new Map();
const allianceByName = new Map();
const allianceSourceByName = new Map();

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function activeAlliance() {
  if (OPT.frameAlliance === 'r' || OPT.frameAlliance === 'R') OPT.frameAlliance = 'red';
  if (OPT.frameAlliance === 'b' || OPT.frameAlliance === 'B') OPT.frameAlliance = 'blue';
  if (OPT.frameAlliance === 'red' || OPT.frameAlliance === 'blue') return OPT.frameAlliance;
  if (ourAllianceCache) return ourAllianceCache;
  const p = findPose(OPT.username);
  if (p && Math.abs(p.x) > 0.05) {
    ourAllianceCache = p.x < 0 ? 'red' : 'blue';
    allianceByName.set(OPT.username, ourAllianceCache);
    allianceSourceByName.set(OPT.username, 'spawn');
  }
  return ourAllianceCache;
}

// Blue robots drive in a 180-degree-rotated control frame. By default the
// engine reports every position/heading/velocity in that same alliance frame,
// so identical bot logic works on both sides. --field-frame returns raw global
// coordinates instead.
function readIntake(addr) {
  if (!addr || !mem) return null;
  const a = u8();
  if (addr + 0x56 >= a.length) return null;
  return (a[addr + 0x56] & 0x40) !== 0;
}

function readHopper(addr) {
  if (!addr || !mem) return null;
  const a = u8();
  if (addr + 0x4e >= a.length) return null;
  const n = a[addr + 0x4b] | (a[addr + 0x4c] << 8) | (a[addr + 0x4d] << 16) | (a[addr + 0x4e] << 24);
  return n >= 0 && n <= 255 ? n : null;
}

let frameBlue = false;
function refreshFrame() {
  const alliance = activeAlliance();
  frameBlue = !OPT.fieldFrame && alliance === 'blue';
  return frameBlue;
}

function inAllianceFrame() {
  return frameBlue;
}

function allianceVec(x, y) {
  return inAllianceFrame() ? { x: -x, y: -y } : { x, y };
}

function allianceHeading(h) {
  return inAllianceFrame() ? normalizeAngle(h + Math.PI) : h;
}

function readRobots() {
  refreshFrame();
  const out = [];
  for (const name of roomNames) {
    let p = findPose(name);
    const now = Date.now() / 1000;
    const prev = lastPose.get(name);
    if (!p) {
      if (!prev || now - prev.t > 2) continue;
      // keep the last known pose for a frame instead of dropping a robot
      const alliance = allianceByName.get(name) || (prev.x < 0 ? 'red' : 'blue');
      const sp = allianceVec(prev.x, prev.y);
      out.push({
        name, is_me: name === OPT.username, alliance,
        alliance_source: allianceSourceByName.get(name) || 'spawn', stale: true,
        pose_source: 'stale',
        x: +sp.x.toFixed(4), y: +sp.y.toFixed(4), z: +prev.z.toFixed(4),
        heading: +allianceHeading(prev.heading).toFixed(4),
        vx: 0, vy: 0, vz: 0, yawRate: 0,
        hopper_fuel: prev.hopper_fuel ?? null,
        intake_active: prev.intake_active ?? null,
      });
      continue;
    }
    let vx = 0, vy = 0, vz = 0, yawRate = 0;
    if (prev && now > prev.t + 0.01) {
      const dt = now - prev.t;
      vx = (p.x - prev.x) / dt;
      vy = (p.y - prev.y) / dt;
      vz = (p.z - prev.z) / dt;
      let dh = p.heading - prev.heading;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      yawRate = dh / dt;
    }
    const hopperFuel = readHopper(p.addr);
    const intakeActive = readIntake(p.addr);
    lastPose.set(name, { t: now, x: p.x, y: p.y, z: p.z, heading: p.heading,
      hopper_fuel: hopperFuel, intake_active: intakeActive });
    let alliance = allianceByName.get(name);
    if (!alliance) {
      // Fallback only: spawn side when no 0x06 seat record is available.
      alliance = p.x < 0 ? 'red' : 'blue';
      allianceByName.set(name, alliance);
      allianceSourceByName.set(name, 'spawn');
    }
    const op = allianceVec(p.x, p.y);
    const ov = allianceVec(vx, vy);
    out.push({
      name, is_me: name === OPT.username, alliance,
      alliance_source: allianceSourceByName.get(name) || 'spawn',
      pose_source: p.source || 'unknown',
      x: +op.x.toFixed(4), y: +op.y.toFixed(4), z: +p.z.toFixed(4),
      heading: +allianceHeading(p.heading).toFixed(4),
      vx: +ov.x.toFixed(3), vy: +ov.y.toFixed(3),
      vz: +vz.toFixed(3), yawRate: +yawRate.toFixed(3),
      hopper_fuel: hopperFuel,
      intake_active: intakeActive,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// UI flow
// ---------------------------------------------------------------------------

function writeFrame(kind, frameSeq, payload) {
  const h = Buffer.alloc(16);
  BIN_MAGIC.copy(h, 0);
  h[4] = 1;                 // framing version
  h[5] = kind;              // 1 = JSON, 2 = packed fuel
  h.writeUInt16LE(0, 6);
  h.writeUInt32LE(payload.length, 8);
  h.writeUInt32LE(frameSeq >>> 0, 12);
  process.stdout.write(Buffer.concat([h, payload]));
}
function emit(obj) {
  if (!OPT.binary) { process.stdout.write(JSON.stringify(obj) + '\n'); return; }
  writeFrame(1, Number(obj.seq) || 0, Buffer.from(JSON.stringify(obj)));
}
function emitFuelBinary(fuel, frameSeq) {
  const count = fuel.length;
  const payload = Buffer.alloc(8 + count * 7);
  payload.writeUInt16LE(count, 0);
  payload.writeUInt16LE(7, 2);
  payload.writeUInt32LE(0, 4);
  for (let i = 0; i < count; i++) {
    const f = fuel[i];
    const off = 8 + i * 7;
    const q = (v) => Number.isFinite(v)
      ? Math.max(0, Math.min(0xffff, Math.round(v * 4096) + 0x8000))
      : 0x8000;
    payload[off] = f.present ? 1 : 0;
    payload.writeUInt16LE(q(f.x), off + 1);
    payload.writeUInt16LE(q(f.y), off + 3);
    payload.writeUInt16LE(q(f.z - 0.045), off + 5);
  }
  writeFrame(2, frameSeq, payload);
}

let buildMeta = null;
try { buildMeta = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8')); } catch {}
const buildHash = buildMeta && buildMeta.build ? buildMeta.build : null;
if (!buildHash && !OPT.noBuildCheck) {
  log('build pin failed: no build hash in', BUILD_FILE, '(run node prepare.mjs or pass --no-build-check)');
  process.exit(3);
}
if (buildMeta && buildMeta.files) {
  for (const [file, expected] of Object.entries(buildMeta.files)) {
    try {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ASSET_DIR, file))).digest('hex');
      if (actual !== expected) {
        log('build pin failed: hash mismatch for', file, 'expected', expected, 'got', actual);
        emit({ type: 'error', error: 'asset_hash_mismatch', file });
        setTimeout(() => process.exit(3), 100);
      }
    } catch (e) {
      log('build pin failed: cannot hash', file, String(e));
      process.exit(3);
    }
  }
}
if (OPT.expectBuild) {
  if (!buildHash) {
    log('build pin failed: assets have no build.json; expected', OPT.expectBuild);
    process.exit(3);
  }
  if (buildHash !== OPT.expectBuild) {
    log('build pin failed: assets are', buildHash, 'but --expect-build is', OPT.expectBuild);
    process.exit(3);
  }
}
if (!OPT.noBuildCheck) {
  const origin = OPT.server ? `http://${OPT.server}/` : 'https://rebuildsim.com/';
  nativeFetch(origin, { redirect: 'follow', signal: AbortSignal.timeout(10000) })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then((html) => {
      const m = html.match(/BUILD\s*=\s*["']([0-9a-f]+)["']/);
      if (!m) {
        if (OPT.server) {
          log('build check: no BUILD on local server; continuing (--server)');
          emit({ type: 'build', build: buildHash, server_build: null, ok: true, skipped: true });
          bootGame();
          return;
        }
        throw new Error('BUILD hash not found');
      }
      const live = m[1];
      if (live !== buildHash) {
        log('build drift: assets are', buildHash, 'but server is', live, '- run node prepare.mjs');
        emit({ type: 'error', error: 'build_drift', cached: buildHash, server: live });
        setTimeout(() => process.exit(3), 100);
        return;
      }
      emit({ type: 'build', build: buildHash, server_build: live, ok: true });
      log('build check ok', live);
      bootGame();
    })
    .catch((e) => {
      log('build check failed:', String(e));
      if (OPT.server) {
        emit({ type: 'build', build: buildHash, server_build: null, ok: true, skipped: true });
        bootGame();
        return;
      }
      emit({ type: 'error', error: 'build_check_failed', detail: String(e) });
      setTimeout(() => process.exit(3), 100);
    });
}
setInterval(() => emit({ type: 'heartbeat', t: Date.now() / 1000, ws_open: wsOpen, ws_closed: wsClosed }), 1000);
if (OPT.noBuildCheck) setTimeout(() => bootGame(), 0);


function key(type, keyName, code, keyCode) {
  const e = ev(type, { key: keyName, code, keyCode, which: keyCode, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false });
  globalThis.window.dispatchEvent(e);
  return e;
}
function tapKey(keyName, code, keyCode) { key('keydown', keyName, code, keyCode); setTimeout(() => key('keyup', keyName, code, keyCode), 40); }
function mouse(type, x, y, button = 0, buttons = 1) {
  const e = ev(type, { clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, x, y, button, buttons, movementX: 0, movementY: 0 });
  canvas.dispatchEvent(e);
  globalThis.window.dispatchEvent(e);
}
function click(x, y) {
  const gen = uiGeneration;
  mouse('mousemove', x, y, 0, 0);
  setTimeout(() => { if (gen === uiGeneration) mouse('mousedown', x, y, 0, 1); }, 50);
  // Always release: a canceled click must not leave the game with a held button.
  setTimeout(() => mouse('mouseup', x, y, 0, 0), 100);
}
globalThis.__ctl = { key, tapKey, mouse, click, canvas, Module, getMem: () => mem, wslog };

function refreshPad() {
  try {
    const e = ev('gamepadconnected', { gamepad: pad });
    globalThis.window.dispatchEvent(e);
  } catch (e) { log('refreshPad error', String(e)); }
}


const KEY = {
  w: ['w', 'KeyW', 87], s: ['s', 'KeyS', 83], a: ['a', 'KeyA', 65], d: ['d', 'KeyD', 68],
  j: ['j', 'KeyJ', 74], l: ['l', 'KeyL', 76],
  shift: ['Shift', 'ShiftLeft', 16], k: ['k', 'KeyK', 75], space: [' ', 'Space', 32],
};
const keyState = {};
function setKey(name, on) {
  if (!!keyState[name] === !!on) return;
  keyState[name] = !!on;
  const [key, code, keyCode] = KEY[name];
  globalThis.__ctl.key(on ? 'keydown' : 'keyup', key, code, keyCode);
}
function applyInput(cmd) {
  const x = Number(cmd.x) || 0, y = Number(cmd.y) || 0, r = Number(cmd.rotate) || 0;
  if (OPT.gamepad) {
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    pad.axes[0] = clamp(x);
    pad.axes[1] = -clamp(y);
    pad.axes[2] = clamp(r);
    pad.axes[3] = 0;
    pad.axes[4] = cmd.intake ? 1 : 0;
    pad.axes[5] = cmd.shoot ? 1 : 0;
    const setBtn = (i, on) => { pad.buttons[i].pressed = !!on; pad.buttons[i].value = on ? 1 : 0; };
    setBtn(6, cmd.intake);   // LT
    setBtn(7, cmd.shoot);    // RT
    setBtn(4, cmd.outtake);  // LB
    pad.timestamp = performance.now();
    refreshPad();
    return;
  }
  setKey('w', y > 0.15); setKey('s', y < -0.15);
  setKey('d', x > 0.15); setKey('a', x < -0.15);
  setKey('l', r > 0.15); setKey('j', r < -0.15);
  setKey('shift', !!cmd.intake);
  setKey('k', !!cmd.outtake);
  setKey('space', !!cmd.shoot);
}

function releaseInputs() {
  try {
    for (const name of Object.keys(KEY)) setKey(name, false);
    for (const b of pad.buttons) { b.pressed = false; b.value = 0; b.touched = false; }
    pad.axes.fill(0);
    pad.timestamp = performance.now();
    refreshPad();
  } catch (e) { log('releaseInputs error', String(e)); }
}

function tapBox(index, x, y, text) {
  try {
    Module.ccall('rb_tap_text_box', null, ['number', 'number', 'number'], [index, x, y]);
    if (text != null) {
      Module.ccall('rb_type_erase', null, ['number'], [64]);
      Module.ccall('rb_type_text', null, ['string'], [String(text)]);
    }
  } catch (e) { log('text box error', String(e)); }
}

function readyIfNeeded(force = false) {
  if (matchStarted || uiBusy) return;
  const seat = roomSeats.find(s => s.name === OPT.username);
  if (!seat || seat.ready !== false) return;
  if (!force && Date.now() - lastReadyClickAt < 4000) return;
  lastReadyClickAt = Date.now();
  readyClicked = true;
  uiLater(() => {
    const cur = roomSeats.find(s => s.name === OPT.username);
    if (cur && cur.ready === false && !matchStarted && !uiBusy) {
      globalThis.__ctl.click(646, 688);
    } else if (uiBusy) {
      lastReadyClickAt = 0;
    }
  }, 300);
}

function clickStartWhenReady(attempt = 0, force = false) {
  if (!host) return;
  if (!force && !OPT.start) return;
  if (uiBusy) {
    uiLater(() => clickStartWhenReady(attempt, force), 500);
    return;
  }
  const allReady = roomSeats.length > 0 && roomSeats.every(s => s.ready === true);
  if (allReady) {
    globalThis.__ctl.click(1150, 688);
    startClicks++;
    if (startClicks < 3) {
      uiLater(() => {
        if (!flow.match) clickStartWhenReady(0, force);
      }, 5000);
    } else {
      uiLater(() => {
        if (!flow.match) {
          log('start click not observed after retries');
          emit({ type: 'error', error: 'not_all_ready', detail: 'start not observed' });
          startClicked = false;
          startClicks = 0;
        }
      }, 5000);
    }
    return;
  }
  if (attempt >= 24) {
    const notReady = roomSeats.filter(s => s.ready !== true).map(s => s.name);
    log('start blocked; seats not ready:', notReady.join(','));
    emit({ type: 'error', error: 'not_all_ready', detail: notReady.join(',') });
    startClicked = false;
    startClicks = 0;
    return;
  }
  uiLater(() => clickStartWhenReady(attempt + 1, force), 500);
}

const flow = { booted: false, menu: false, name: false, rooms: false, joined: false, match: false };
const uiTimers = new Set();
let uiGeneration = 0;
function uiLater(fn, ms) {
  const id = setTimeout(() => {
    uiTimers.delete(id);
    try { fn(); } catch (e) { log('ui timer error', String(e)); }
  }, ms);
  uiTimers.add(id);
  return id;
}
function cancelUiTimers() {
  for (const id of uiTimers) clearTimeout(id);
  uiTimers.clear();
  uiGeneration++;
  uiBusy = false;
}
function onTrack(name, params) {
  let p = params;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
  p = p || {};
  if (OPT.debug && name !== 'settings_snapshot') log('TRACK', name, JSON.stringify(p).slice(0, 300));
  if (name === 'page_view') {
    const path = p.page_path || '';
    if ((path === '/menu' || path === '/multiplayer') && flow.joined) {
      log('left the room screen; exiting');
      emit({ type: 'error', error: 'left_room' });
      setTimeout(() => process.exit(6), 100);
    }
    if (path === '/menu' && !flow.menu) {
      flow.menu = true;
      setTimeout(() => globalThis.__ctl.click(1070, 244), 400);
    } else if (path === '/multiplayer' && !flow.name) {
      flow.name = true;
      setTimeout(() => {
        tapBox(0, 640, 270, OPT.username);
        setTimeout(() => globalThis.__ctl.click(640, 326), 500);
      }, 400);
    } else if (path === '/multiplayer' && flow.name && !flow.rooms) {
      // name prompt completed, room list is visible
    } else if (path === '/room') {
          // A room screen normally means the previous match ended or was left.
      // If the clock is still advancing, this is a stale page_view: ignore it.
      // If 0x41 stops arriving (aborted match/leave), reset after a short grace.
      const starting = flow.match && !clockStarted && matchStartedAt
        && Date.now() - matchStartedAt < 10000;
      const matchLive = starting || (flow.match && clockStarted && lastMatchTime != null
        && lastMatchTime > 0.05 && last41At && Date.now() - last41At < 1500);
      if (!matchLive && (flow.match || matchWasActive)) {
        resetMatchState();
        emitRoom();
      } else if (matchLive && !roomResetTimer) {
        roomResetTimer = setTimeout(() => {
          roomResetTimer = null;
          const stillStarting = flow.match && !clockStarted && matchStartedAt
            && Date.now() - matchStartedAt < 10000;
          if (!stillStarting && flow.match
              && (!last41At || Date.now() - last41At >= 1500)) {
            log('room screen without clock updates; resetting stale match');
            resetMatchState();
            emitRoom();
          }
        }, 1800);
      }
      if (flow.joined && seated && !flow.match && !uiBusy) {
        if (host && OPT.start && !startClicked) {
          startClicked = true;
          uiLater(() => clickStartWhenReady(0), 1800);
        }
      }
      if (OPT.debug) log('room screen');
    } else if (path === '/multi/match') {
      onMatchStart();
    }
  }
  if (name === 'name_prompt' && !flow.name) {
    flow.name = true;
    setTimeout(() => {
      tapBox(0, 640, 270, OPT.username);
      setTimeout(() => globalThis.__ctl.click(640, 326), 500);
    }, 300);
  }
  if (name === 'room_list' && !flow.rooms) {
    flow.rooms = true;
    setTimeout(() => {
      if (OPT.code) {
        tapBox(1, 218, 274, OPT.code);
        setTimeout(() => globalThis.__ctl.click(410, 274), 400);
      } else if (OPT.create) {
        globalThis.__ctl.click(280, 198);
      } else {
        log('no --code or --create; refusing to open a public room');
        emit({ type: 'error', error: 'missing_join_mode' });
        setTimeout(() => process.exit(2), 100);
      }
    }, 300);
  }
  if (name === 'room_join') {
    const previousRole = role;
    flow.joined = true;
      host = p.is_host === 'yes' || p.is_host === true || p.is_host === 'true' || p.is_host === 1;
    seated = p.role === 'driver';
    role = p.role;
    roomCode = (roomCode || OPT.code).toUpperCase();
    if (OPT.code && roomCode && roomCode !== OPT.code) {
      failJoin('room_code_mismatch', `joined ${roomCode}, expected ${OPT.code}`);
      return;
    }
    log('joined room', roomCode, 'host', host, 'role', p.role);
    emitRoom();
    if (lastRoom06) applyRoom06(lastRoom06);
    if (!seated) {
      failSpectator(`room_join role=${p.role}`);
      return;
    }
    const readyAndStart = () => {
      // applyRoom06 clicks READY only when our 0x06 ready bit is 0.
      if (host && OPT.start && !startClicked) {
        startClicked = true;
        uiLater(() => clickStartWhenReady(0), 1500);
      }
    };
    if (host && OPT.fuel && !fuelApplied) {
      fuelApplied = true;
      // Room settings > Rules > Fuel count. 720p coordinates. uiBusy starts
      // when this dialog opens; readyIfNeeded(true) retries after fuel setup.
      const raw = String(OPT.fuel).replace('%', '').toLowerCase();
      let clicks = 0, dir = 1;
      if (raw === 'max' || raw === 'full') { log('--fuel max is not supported; use an explicit percentage'); clicks = 0; }
      else {
        const pct = Number(raw);
        if (!Number.isFinite(pct) || pct <= 0) clicks = 0;
        else if (pct < 100) { clicks = Math.round((100 - pct) / 25); dir = -1; }
        else if (pct > 100) { clicks = Math.round((pct - 100) / 25); dir = 1; }
      }
      uiLater(() => { uiBusy = true; globalThis.__ctl.click(752, 118); }, 500);   // room settings
      uiLater(() => globalThis.__ctl.click(794, 118), 1000);  // rules tab
      for (let i = 0; i < clicks; i++) {
        uiLater(() => globalThis.__ctl.click(dir < 0 ? 686 : 931, 632), 1500 + i * 250);
      }
      uiLater(() => globalThis.__ctl.click(454, 688), 1500 + clicks * 250 + 500); // done
      uiLater(() => { uiBusy = false; readyIfNeeded(true); readyAndStart(); }, 1500 + clicks * 250 + 1000);
      log('setting fuel rule', OPT.fuel, 'clicks', clicks, dir < 0 ? 'left' : 'right');
    } else {
      readyAndStart();
    }
  }
  if (name === 'match_start') {
    onMatchStart();
  }
}

globalThis.rbTrack = onTrack;
globalThis.rbUserProperty = () => {};
globalThis.rbLoaded = () => {};

let gameBooted = false;
function bootGame() {
  if (gameBooted) return;
  gameBooted = true;
  emit({ type: 'ready', build: buildHash, binary: OPT.binary });
  setTimeout(() => {
    const rbGame = require(path.join(ASSET_DIR, 'index.js'));
    rbGame(Module)
      .then(() => log('rbGame resolved'))
      .catch((e) => {
        console.error('rbGame rejected', e);
        try { emit({ type: 'error', error: 'game_boot_failed', detail: String(e) }); } catch {}
        setTimeout(() => process.exit(1), 100);
      });
  }, 0);
}

// make the virtual gamepad visible to raylib/GLFW after boot
setTimeout(() => {
  try {
    const e = ev('gamepadconnected', { gamepad: pad });
    globalThis.window.dispatchEvent(e);
    log('gamepadconnected dispatched');
  } catch (e) { log('gamepad event error', String(e)); }
}, 4200);

// Fail loudly if the wasm memory was never captured.
setTimeout(() => {
  if (!mem) {
    log('wasm memory was not captured; aborting');
    try { emit({ type: 'error', error: 'memory_unavailable' }); } catch {}
    setTimeout(() => process.exit(1), 100);
  }
}, 30000);

// title screen: press any button after the runtime has had a moment
setTimeout(() => {
  if (flow.booted) return;
  flow.booted = true;
  log('dismiss title');
  globalThis.__ctl.tapKey(' ', 'Space', 32);
}, 3500);
// retry the title until the menu is visible
let titleRetries = 0;
const titleTimer = setInterval(() => {
  if (flow.menu || titleRetries++ >= 12) { clearInterval(titleTimer); return; }
  log('retry title');
  globalThis.__ctl.tapKey(' ', 'Space', 32);
}, 2000);

// locate the fuel array once the match starts (and retry if the heap moves)
setInterval(() => {
  if (!matchStarted || !mem) return;
  if (!fuelAddr) {
    const now = Date.now();
    if (now - lastFuelScan > 2000) { lastFuelScan = now; findFuelArray(); }
  }
}, 2000);

// state emitter
let seq = 0;
let lastScoreKey = '';
setInterval(() => {
  if (!mem || !matchStarted) return;
  const fuelNow = Date.now();
  const clockStalled = flow.match && (
    (clockStarted && last41At && fuelNow - last41At > 3000)
    || (!clockStarted && matchStartedAt && fuelNow - matchStartedAt > 15000));
  if (clockStalled) {
    log('match clock stalled; stopping state emission');
    emit({ type: 'error', error: 'match_clock_stalled' });
    matchStarted = false;
    flow.match = false;
    if (flow.joined) emitRoom();
    return;
  }
  if (fuelAddr && fuelNow - lastFuelVerify > 2000) {
    lastFuelVerify = fuelNow;
    if (verifyFuelBase()) {
      fuelVerified = true;
      fuelVerifyFails = 0;
    } else {
      fuelVerified = false;
      fuelVerifyFails++;
      if (fuelVerifyFails >= 2) {
        log('fuel base moved; relocating');
        fuelAddr = 0;
        fuelSource = null;
        fuelVerifyFails = 0;
        lastFuelScan = 0;
        lastFuelVerify = 0;
      }
    }
  }
  if (!fuelAddr) {
    if (fuelNow - lastFuelScan > 2000) { lastFuelScan = fuelNow; findFuelArray(); }
  }
  const robots = readRobots();
  const fuel = readFuel();
  const match = classifyMatch(lastMatchTime, lastCountdown, clockStarted);
  const { phase, substage, countdown } = match;
  const me = robots.find(r => r.is_me) || null;
  const hubTime = match.ended ? 0 : (countdown ? null : lastMatchTime);
  const hub = computeHub(hubTime, autoScores.red, autoScores.blue, activeAlliance(), OPT.hubOrder);
  const s = seq++;
  const key = `${scores.red}:${scores.blue}`;
  if (key !== lastScoreKey) {
    lastScoreKey = key;
    emit({ type: 'score', seq: s, red: scores.red, blue: scores.blue,
      auto_red: autoScores.red, auto_blue: autoScores.blue });
  }
  if (OPT.binary) {
    emitFuelBinary(fuel, s);
  }
  const state = {
    type: 'state', seq: s, t: Date.now() / 1000,
    phase, substage,
    time: lastMatchTime,
    time_remaining: lastMatchTime,
    substage_remaining: substageRemaining(lastMatchTime, substage),
    red_score: scores.red, blue_score: scores.blue,
    auto_red_score: autoScores.red, auto_blue_score: autoScores.blue,
    scores: { red: scores.red, blue: scores.blue },
    protocol: protocolVersion,
    ws_open: wsOpen,
    ws_closed: wsClosed,
    frame: activeAlliance() ? (OPT.fieldFrame ? 'field' : 'alliance') : 'unknown',
    alliance: activeAlliance() || 'unknown',
    hub,
    hopper_fuel: me ? me.hopper_fuel : null,
    hopper_capacity: 55,
    intake_active: me ? me.intake_active : null,
    fuel_ok: fuelVerified && fuelPacketCount > 0 && fuel.length === fuelPacketCount,
    fuel_source: fuelSource,
    me, robots, fuel, fuel_count: fuelPacketCount,
  };
  if (OPT.binary) { state.fuel_bin = true; state.fuel = []; }
  emit(state);
  if (match.ended && flow.match) {
    // Keep emitting the final/end states, but room events and the CLI should
    // no longer consider this a live match.
    flow.match = false;
    log('match ended; room events now report match_active=false');
    if (flow.joined) emitRoom();
    if (!resultsClickScheduled) {
      resultsClickScheduled = true;
      resultsPending = true;
      // Results screen: BACK TO THE ROOM is centered at (365, 688).
      uiLater(() => {
        if (resultsPending) { log('results: back to room'); globalThis.__ctl.click(365, 688); }
      }, 3500);
      uiLater(() => {
        if (resultsPending) { log('results: retry back to room'); globalThis.__ctl.click(365, 688); }
      }, 7500);
      uiLater(() => {
        if (resultsPending) { log('results: final back to room'); globalThis.__ctl.click(365, 688); }
      }, 15000);
      uiLater(() => {
        if (resultsPending) {
          log('results screen did not return to the room; exiting');
          emit({ type: 'error', error: 'results_stuck' });
          setTimeout(() => process.exit(6), 100);
        }
      }, 20000);
    }
  }
}, Math.max(1, Math.floor(1000 / OPT.emitHz)));

let trace = null;
function finishTrace() {
  if (!trace) return;
  clearInterval(trace.timer);
  const meta = {
    regions: trace.regions, per: trace.per, hz: trace.hz,
    frames: trace.data.length, times: trace.times,
    me: readRobots().find(r => r.is_me) || null,
  };
  try {
    fs.writeFileSync(trace.path + '.bin', Buffer.concat(trace.data));
    fs.writeFileSync(trace.path + '.json', JSON.stringify(meta));
    log('trace written', trace.path, meta.frames, meta.per);
  } catch (e) { log('trace write error', String(e)); }
  trace = null;
}
function startTrace(cmd) {
  if (trace) return;
  const regions = (cmd.regions || []).map(([start, len]) => ({ start: Number(start), len: Number(len) }));
  if (!regions.length || !mem) return;
  const per = regions.reduce((a, r) => a + r.len, 0);
  trace = {
    regions, per,
    hz: Math.max(1, Math.min(120, Number(cmd.hz) || 60)),
    frames: Math.max(1, Math.min(1200, Number(cmd.frames) || 180)),
    path: cmd.path || '/tmp/opencode/trace',
    data: [], times: [], timer: null,
  };
  trace.timer = setInterval(() => {
    if (!trace || !mem) return;
    const parts = trace.regions.map(r => {
      const end = Math.min(r.start + r.len, mem.buffer.byteLength);
      if (r.start >= end) return Buffer.alloc(0);
      return Buffer.from(mem.buffer, r.start, end - r.start).slice();
    });
    trace.data.push(Buffer.concat(parts));
    trace.times.push(Date.now());
    if (trace.data.length >= trace.frames) finishTrace();
  }, Math.max(1, Math.round(1000 / trace.hz)));
  log('trace started', JSON.stringify(trace.regions), 'hz', trace.hz, 'frames', trace.frames, 'path', trace.path);
}

// stdin command API
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
if (process.argv.includes('--exit-on-stdin-close')) {
  rl.on('close', () => { log('stdin closed; exiting'); process.exit(0); });
}
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let cmd;
  try { cmd = JSON.parse(s); } catch { log('bad command', s); return; }
  if (cmd.type === 'input') applyInput(cmd);
  else if (cmd.type === 'pad') {
    if (Array.isArray(cmd.axes)) for (let i = 0; i < Math.min(pad.axes.length, cmd.axes.length); i++) pad.axes[i] = Number(cmd.axes[i]) || 0;
    if (Array.isArray(cmd.buttons)) for (let i = 0; i < Math.min(pad.buttons.length, cmd.buttons.length); i++) {
      const v = cmd.buttons[i];
      const on = typeof v === 'object' ? !!v.pressed : !!v;
      pad.buttons[i].pressed = on;
      pad.buttons[i].value = on ? (typeof v === 'object' ? Number(v.value ?? 1) : 1) : 0;
    }
    pad.timestamp = performance.now();
    refreshPad();
    log('PAD', JSON.stringify({ axes: pad.axes, buttons: pad.buttons.map(b => b.pressed ? 1 : 0) }));
  }
  else if (cmd.type === 'trace') startTrace(cmd);
  else if (cmd.type === 'dump06') { if (lastRoom06) fs.writeFileSync(cmd.path || '/tmp/opencode/room06.bin', lastRoom06); }
  else if (cmd.type === 'dumpws') { fs.writeFileSync(cmd.path || '/tmp/opencode/wsdump.json', JSON.stringify(wslog)); }
  else if (cmd.type === 'dumpmem') { if (mem) fs.writeFileSync(cmd.path || '/tmp/opencode/memdump.bin', Buffer.from(mem.buffer)); }
  else if (cmd.type === 'ready') {
    const ourSeat = roomSeats.find(s => s.name === OPT.username);
    if (ourSeat && ourSeat.ready === false) {
      readyClicked = true;
      lastReadyClickAt = Date.now();
      globalThis.__ctl.click(646, 688);
    }
  }
  else if (cmd.type === 'start') clickStartWhenReady(0, true);
  else if (cmd.type === 'leave') globalThis.__ctl.click(144, 688);
  else if (cmd.type === 'quit') process.exit(0);
  else if (cmd.type === 'ping') emit({ type: 'pong', t: Date.now() / 1000 });
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
log('ENGINE READY');
