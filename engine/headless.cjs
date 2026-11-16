// Headless REBUILD engine harness: real wasm, stub WebGL, DOM events, memory capture.
const fs = require('node:fs');
const path = require('node:path');
const nativeFetch = globalThis.fetch;
const { parseRoom06 } = require('./room06.cjs');

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

const ASSET_DIR = process.env.RB_ASSET_DIR || path.join(__dirname, 'cache');
const BUILD_FILE = path.join(ASSET_DIR, 'build.json');

function getArg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
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
  expectBuild: getArg('expect-build', ''),
  noBuildCheck: process.argv.includes('--no-build-check'),
};
globalThis.__RB_DEBUG = OPT.debug;
if (!fs.existsSync(path.join(ASSET_DIR, 'index.js')) || !fs.existsSync(path.join(ASSET_DIR, 'index.wasm'))) {
  console.error(`missing game assets in ${ASSET_DIR}; run: node prepare.mjs`);
  process.exit(2);
}
log('engine options', JSON.stringify(OPT));
if (OPT.spawn) log('note: --spawn is not implemented yet; using the default seat');
if (OPT.fuel) log('fuel rule request', OPT.fuel);

if (OPT.server) {
  const [host, port] = OPT.server.split(':');
  globalThis.location.host = OPT.server;
  globalThis.location.hostname = host;
  globalThis.location.port = port || '';
  globalThis.location.protocol = 'http:';
  globalThis.location.origin = 'http://' + OPT.server;
  globalThis.location.href = 'http://' + OPT.server + '/';
  log('using server', OPT.server);
}

const wslog = [];
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
function applyRoom06(buf) {
  const parsed = parseRoom06(buf);
  roomSeats = parsed.seats;
  if (roomSeats.length) {
    // The player records are the real occupants; drop printable-run noise.
    roomNames = new Set(roomSeats.map(s => s.name));
    if (OPT.username) roomNames.add(OPT.username);
  }
  // The team byte (0 red, 1 blue) is authoritative when present; the seat
  // order fallback (first 3 red, next 3 blue) covers older builds.
  for (const seat of roomSeats) {
    allianceByName.set(seat.name, seat.alliance);
    allianceSourceByName.set(seat.name, 'room');
  }
  const key = roomSeats.map(s => `${s.seat}:${s.name}:${s.alliance}`).join('|');
  if (key !== seatsKey) {
    seatsKey = key;
    emit({ type: 'seats', code: roomCode, seats: roomSeats });
  }
  return roomSeats;
}

function parse41(buf) {
  last41 = buf;
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
  }
}

function phaseFor(t) {
  if (t == null) return 'countdown';
  if (t > 143.0) return 'auto';
  if (t > 0.0) return 'teleop';
  return 'end';
}

// Match structure verified against the HUD in a full match:
//   auto        163.0 -> 143.0 (20 s)
//   field reset 143.0 -> 140.0 (3 s)
//   transition  140.0 -> 130.0 (10 s)
//   shift 1..4  130.0 -> 30.0 (four 25 s shifts)
//   endgame      30.0 -> 0.0 (30 s)
function substageFor(t) {
  if (t == null) return 'prematch';
  if (t > 143.0) return 'auto';
  if (t > 140.0) return 'field_reset';
  if (t > 130.0) return 'transition';
  if (t > 105.0) return 'shift1';
  if (t > 80.0) return 'shift2';
  if (t > 55.0) return 'shift3';
  if (t > 30.0) return 'shift4';
  if (t > 0.0) return 'endgame';
  return 'end';
}

function substageRemaining(t, stage) {
  if (t == null) return null;
  const end = { auto: 143, field_reset: 140, transition: 130, shift1: 105,
    shift2: 80, shift3: 55, shift4: 30, endgame: 0 }[stage];
  return end == null ? null : Math.max(0, t - end);
}

function handleServerFrame(buf) {
  if (!buf || !buf.length) return;
  const type = buf[0];
  if (type === 0x06) {
    // room state: room code at 1..5, then seat records in seat order.
    roomCode = buf.subarray(1, 6).toString('latin1');
    lastRoom06 = Buffer.from(buf);
    addPrintableNames(buf);
    applyRoom06(buf);
    if (globalThis.__RB_DEBUG) log('ROOM06', buf.toString('hex'));
    log('room state', roomCode, 'names', [...roomNames].slice(0, 12), 'len', buf.length);
  } else if (type === 0x41) {
    parse41(buf);
  } else if (type === 0x21) {
    // S->C protocol hello: 21 00 01 00 00 (version at byte 2)
    if (buf.length >= 3 && buf[2] !== 1) {
      log('protocol version mismatch: server', buf[2], 'engine expects 1');
      emit({ type: 'error', error: 'protocol_mismatch', server: buf[2], expected: 1 });
      process.exit(4);
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
    this.binaryType = 'arraybuffer';
    this.addEventListener('message', (e) => {
      let buf = null;
      if (e.data instanceof ArrayBuffer) buf = Buffer.from(e.data);
      else if (ArrayBuffer.isView(e.data)) buf = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      else if (typeof e.data === 'string') buf = Buffer.from(e.data, 'latin1');
      if (buf) {
        wslog.push({ dir: 'recv', len: buf.length, hex: buf.toString('hex'), t: Date.now() });
        if (wslog.length > 20000) wslog.splice(0, 10000);
        handleServerFrame(buf);
      }
    });
    this.addEventListener('open', () => { if (globalThis.__RB_DEBUG) log('WS open', url); });
    this.addEventListener('close', (e) => log('WS close', e.code, e.reason));
    this.addEventListener('error', () => { if (globalThis.__RB_DEBUG) log('WS error'); });
    const s = this.send.bind(this);
    this.send = (data) => {
      let buf = null;
      if (typeof data === 'string') buf = Buffer.from(data, 'latin1');
      else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
      else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (buf) {
        wslog.push({ dir: 'send', len: buf.length, hex: buf.toString('hex'), t: Date.now() });
        if (wslog.length > 20000) wslog.splice(0, 10000);
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

process.on('uncaughtException', (e) => console.error('UNCAUGHT', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED', e));

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
let fuelPacketCount = 0;
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

function locateFuelFromPacket() {
  if (!mem || !fuelPacketCount) return 0;
  const a = u8();
  const hay = Buffer.from(a.buffer, a.byteOffset, Math.min(a.byteLength, 0x800000));
  const probes = [...fuelPacket.values()].filter(r => r.id < fuelPacketCount).slice(0, 10);
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
      let ok = 0, total = 0;
      for (const q of probes) {
        const off = base + q.id * 7;
        if (off + 7 > a.length) continue;
        const flag = a[off];
        if (flag !== 0 && flag !== 1) continue;
        const mx = a[off + 1] | (a[off + 2] << 8);
        const my = a[off + 3] | (a[off + 4] << 8);
        if (Math.abs(mx - q.x) <= 3 && Math.abs(my - q.y) <= 3) ok++;
        total++;
      }
      if (total >= 4 && ok >= Math.max(3, Math.floor(total * 0.7))) {
        fuelAddr = base;
        log('fuel array at', '0x' + base.toString(16), 'count', fuelPacketCount);
        return base;
      }
    }
  }
  return 0;
}

function scanFuelRun() {
  if (!mem) return 0;
  const count = fuelPacketCount;
  if (!count || count > 2048) return 0;
  const a = u8();
  const lim = Math.min(a.length, 0x800000) - count * 7;
  for (let i = 0x10000; i < lim; i++) {
    let ok = true;
    for (let j = 0; j < Math.min(count, 64); j++) {
      const off = i + j * 7;
      const f = a[off];
      if (f !== 0 && f !== 1) { ok = false; break; }
      const z = a[off + 5] | (a[off + 6] << 8);
      if (z < 32700 || z > 33200) { ok = false; break; }
    }
    if (!ok) continue;
    for (let j = 64; j < count; j++) {
      const off = i + j * 7;
      const f = a[off];
      if (f !== 0 && f !== 1) { ok = false; break; }
      const z = a[off + 5] | (a[off + 6] << 8);
      if (z < 32700 || z > 33200) { ok = false; break; }
    }
    if (ok) { fuelAddr = i; log('fuel array (scan) at', '0x' + i.toString(16), 'count', count); return i; }
  }
  return 0;
}

function findFuelArray() {
  if (!mem) return 0;
  if (fuelAddr) return fuelAddr;
  if (fuelPacket.size) {
    const b = locateFuelFromPacket();
    if (b) return b;
  }
  return scanFuelRun();
}

function readFuel() {
  if (!fuelAddr || !mem || !fuelPacketCount) return [];
  const a = u8();
  const count = fuelPacketCount;
  if (fuelAddr + count * 7 > a.length) { fuelAddr = 0; return []; }
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = fuelAddr + i * 7;
    const present = a[off] === 1;
    const x = ((a[off + 1] | (a[off + 2] << 8)) - 0x8000) / 4096;
    const y = ((a[off + 3] | (a[off + 4] << 8)) - 0x8000) / 4096;
    const z = ((a[off + 5] | (a[off + 6] << 8)) - 0x8000) / 4096 + 0.045;
    const p = fuelPacket.get(i);
    const item = { id: i, x: +x.toFixed(4), y: +y.toFixed(4), z: +z.toFixed(4), present };
    if (p) {
      item.vx = +(((p.vx - 0x8000) / 4096)).toFixed(3);
      item.vy = +(((p.vy - 0x8000) / 4096)).toFixed(3);
      item.vz = +(((p.vz - 0x8000) / 4096)).toFixed(3);
      item.count = p.count;
      item.flags = p.flags;
    }
    out.push(item);
  }
  return out;
}

const poseCache = new Map();
function findPose(name) {
  if (!mem || !name) return null;
  const a = u8();
  const cached = poseCache.get(name);
  if (cached != null && cached > 0 && cached + 0x60 < a.length && a[cached - 1] === 1) {
    const x = f32(cached + 0x1b), y = f32(cached + 0x1f), z = f32(cached + 0x23);
    const heading = f32(cached + 0x3f), valid = f32(cached + 0x57);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(heading) && inField(x, y) && Math.abs(heading) <= 20 && valid === 1) {
      return { x, y, z, heading, addr: cached, source: (cached >= 0x500000 && cached < 0x530000) ? 'predicted' : 'acked' };
    }
    poseCache.delete(name);
  }
  const buf = Buffer.from(a.buffer, a.byteOffset, Math.min(a.byteLength, 0x800000));
  const needle = Buffer.from(name, 'utf8');
  let pos = 0;
  const candidates = [];
  while (true) {
    const occ = buf.indexOf(needle, pos);
    if (occ < 0) break;
    pos = occ + 1;
    if (occ < 1 || occ + 0x60 >= a.length) continue;
    if (a[occ - 1] !== 1) continue;
    const x = f32(occ + 0x1b);
    const y = f32(occ + 0x1f);
    const z = f32(occ + 0x23);
    const heading = f32(occ + 0x3f);
    const valid = f32(occ + 0x57);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(heading)) continue;
    if (!inField(x, y)) continue;
    if (Math.abs(heading) > 20) continue;
    if (valid !== 1) continue;
    candidates.push({ x, y, z, heading, addr: occ });
  }
  if (!candidates.length) return null;
  // The render/model heap region carries a higher-rate predicted copy.
  const predicted = candidates.filter(c => c.addr >= 0x500000 && c.addr < 0x530000);
  const chosen = predicted.length
    ? predicted.sort((a, b) => b.addr - a.addr)[0]
    : candidates.sort((a, b) => a.addr - b.addr)[0];
  poseCache.set(name, chosen.addr);
  return { ...chosen, source: predicted.length ? 'predicted' : 'acked' };
}

const lastPose = new Map();
const allianceByName = new Map();
const allianceSourceByName = new Map();
function readRobots() {
  const out = [];
  for (const name of roomNames) {
    let p = findPose(name);
    const now = Date.now() / 1000;
    const prev = lastPose.get(name);
    if (!p) {
      if (!prev || now - prev.t > 2) continue;
      // keep the last known pose for a frame instead of dropping a robot
      const alliance = allianceByName.get(name) || (prev.x < 0 ? 'red' : 'blue');
      out.push({
        name, is_me: name === OPT.username, alliance,
        alliance_source: allianceSourceByName.get(name) || 'spawn', stale: true,
        x: +prev.x.toFixed(4), y: +prev.y.toFixed(4), z: +prev.z.toFixed(4),
        heading: +prev.heading.toFixed(4), vx: 0, vy: 0, vz: 0, yawRate: 0,
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
    lastPose.set(name, { t: now, x: p.x, y: p.y, z: p.z, heading: p.heading });
    let alliance = allianceByName.get(name);
    if (!alliance) {
      // Fallback only: spawn side. Prefer the 0x06 seat order when available.
      alliance = p.x < 0 ? 'red' : 'blue';
      allianceByName.set(name, alliance);
      allianceSourceByName.set(name, 'spawn');
    }
    out.push({
      name, is_me: name === OPT.username, alliance,
      alliance_source: allianceSourceByName.get(name) || 'spawn',
      pose_source: p.source || 'unknown',
      x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4),
      heading: +p.heading.toFixed(4), vx: +vx.toFixed(3), vy: +vy.toFixed(3),
      vz: +vz.toFixed(3), yawRate: +yawRate.toFixed(3),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// UI flow
// ---------------------------------------------------------------------------

const BIN_MAGIC = Buffer.from('RSB1');
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
    const q = (v) => Math.max(0, Math.min(0xffff, Math.round(v * 4096) + 0x8000));
    payload[off] = f.present ? 1 : 0;
    payload.writeUInt16LE(q(f.x), off + 1);
    payload.writeUInt16LE(q(f.y), off + 3);
    payload.writeUInt16LE(q(f.z - 0.045), off + 5);
  }
  writeFrame(2, frameSeq, payload);
}

let buildHash = null;
try { buildHash = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8')).build; } catch {}
if (!buildHash) {
  log('warning: no build hash in', BUILD_FILE, '(run node prepare.mjs to pin the build)');
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
  nativeFetch(origin, { redirect: 'follow' })
    .then((r) => r.text())
    .then((html) => {
      const m = html.match(/BUILD\s*=\s*["']([0-9a-f]+)["']/);
      if (!m) { log('build check: could not find BUILD on', origin, '(continuing)'); return; }
      const live = m[1];
      if (buildHash && live !== buildHash) {
        log('build drift: assets are', buildHash, 'but server is', live, '- run node prepare.mjs');
        emit({ type: 'error', error: 'build_drift', cached: buildHash, server: live });
        setTimeout(() => process.exit(3), 100);
        return;
      }
      emit({ type: 'build', build: buildHash || live, server_build: live, ok: true });
      log('build check ok', live);
    })
    .catch((e) => log('build check skipped:', String(e)));
}
emit({ type: 'ready', build: buildHash, binary: OPT.binary });


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
function click(x, y) { mouse('mousemove', x, y, 0, 0); setTimeout(() => mouse('mousedown', x, y, 0, 1), 50); setTimeout(() => mouse('mouseup', x, y, 0, 0), 100); }
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
  if ('intake' in cmd) setKey('shift', !!cmd.intake);
  if ('outtake' in cmd) setKey('k', !!cmd.outtake);
  if ('shoot' in cmd) setKey('space', !!cmd.shoot);
}

function tapBox(index, x, y, text) {
  try {
    Module.ccall('rb_tap_text_box', null, ['number', 'number', 'number'], [index, x, y]);
    if (text != null) Module.ccall('rb_type_text', null, ['string'], [String(text)]);
  } catch (e) { log('text box error', String(e)); }
}

const flow = { booted: false, menu: false, name: false, rooms: false, joined: false, match: false };
function onTrack(name, params) {
  let p = params;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
  p = p || {};
  if (OPT.debug && name !== 'settings_snapshot') log('TRACK', name, JSON.stringify(p).slice(0, 300));
  if (name === 'page_view') {
    const path = p.page_path || '';
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
    } else if (path === '/room' && !flow.joined) {
      flow.joined = true;
      emit({ type: 'room', code: roomCode, host, seated });
    } else if (path === '/multi/match' && !flow.match) {
      flow.match = true;
      matchStarted = true;
      emit({ type: 'match', phase: 'countdown', time: lastMatchTime });
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
      } else {
        globalThis.__ctl.click(280, 198);
      }
    }, 300);
  }
  if (name === 'room_join' && !flow.joined) {
    flow.joined = true;
    host = p.is_host === 'yes';
    seated = p.role === 'driver';
    roomCode = roomCode || OPT.code;
    log('joined room', roomCode, 'host', host, 'role', p.role);
    emit({ type: 'room', code: roomCode, host, seated, role: p.role, seats: roomSeats });
    const readyAndStart = () => {
      if (host && OPT.start) {
        setTimeout(() => globalThis.__ctl.click(646, 688), 900);
        setTimeout(() => globalThis.__ctl.click(1150, 688), 1800);
      } else if (seated) {
        setTimeout(() => globalThis.__ctl.click(646, 688), 1000);
      }
    };
    if (host && OPT.fuel) {
      // Room settings > Rules > Fuel count. 720p coordinates.
      const raw = String(OPT.fuel).replace('%', '').toLowerCase();
      let clicks = 0, dir = 1;
      if (raw === 'max' || raw === 'full') { log('--fuel max is not supported; use an explicit percentage'); clicks = 0; }
      else {
        const pct = Number(raw);
        if (!Number.isFinite(pct) || pct <= 0) clicks = 0;
        else if (pct < 100) { clicks = Math.round((100 - pct) / 25); dir = -1; }
        else if (pct > 100) { clicks = Math.round((pct - 100) / 25); dir = 1; }
      }
      setTimeout(() => globalThis.__ctl.click(752, 118), 500);   // room settings
      setTimeout(() => globalThis.__ctl.click(794, 118), 1000);  // rules tab
      for (let i = 0; i < clicks; i++) {
        setTimeout(() => globalThis.__ctl.click(dir < 0 ? 686 : 931, 632), 1500 + i * 250);
      }
      setTimeout(() => globalThis.__ctl.click(454, 688), 1500 + clicks * 250 + 500); // done
      setTimeout(readyAndStart, 1500 + clicks * 250 + 1000);
      log('setting fuel rule', OPT.fuel, 'clicks', clicks, dir < 0 ? 'left' : 'right');
    } else {
      readyAndStart();
    }
  }
  if (name === 'match_start' && !flow.match) {
    flow.match = true;
    matchStarted = true;
    poseCache.clear();
    // Seat order does not change during a match; re-apply it if the room
    // packet arrived before the match. Do not clear it (that would drop the
    // only authoritative alliance source back to the spawn heuristic).
    if (lastRoom06) applyRoom06(lastRoom06);
    fuelAddr = 0;
    lastMatchTime = null;
    last41 = null;
    scores = { red: 0, blue: 0 };
    autoScores = { red: 0, blue: 0 };
    emit({ type: 'match', phase: phaseFor(lastMatchTime), substage: substageFor(lastMatchTime), time: lastMatchTime, seats: roomSeats });
  }
}

globalThis.rbTrack = onTrack;
globalThis.rbUserProperty = () => {};
globalThis.rbLoaded = () => {};

const rbGame = require(path.join(ASSET_DIR, 'index.js'));
rbGame(Module).then(() => log('rbGame resolved')).catch((e) => console.error('rbGame rejected', e));

// make the virtual gamepad visible to raylib/GLFW after boot
setTimeout(() => {
  try {
    const e = ev('gamepadconnected', { gamepad: pad });
    globalThis.window.dispatchEvent(e);
    log('gamepadconnected dispatched');
  } catch (e) { log('gamepad event error', String(e)); }
}, 4200);

// title screen: press any button after the runtime has had a moment
setTimeout(() => {
  if (flow.booted) return;
  flow.booted = true;
  log('dismiss title');
  globalThis.__ctl.tapKey(' ', 'Space', 32);
}, 3500);
// fallback: if the title is slow, press again
setTimeout(() => { if (!flow.menu) { log('retry title'); globalThis.__ctl.tapKey(' ', 'Space', 32); } }, 7000);

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
  if (!fuelAddr) {
    const now = Date.now();
    if (now - lastFuelScan > 2000) { lastFuelScan = now; findFuelArray(); }
  }
  const robots = readRobots();
  const fuel = readFuel();
  const phase = phaseFor(lastMatchTime);
  const substage = substageFor(lastMatchTime);
  const me = robots.find(r => r.is_me) || null;
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
    me, robots, fuel, fuel_count: fuelPacketCount,
  };
  if (OPT.binary) { state.fuel_bin = true; state.fuel = []; }
  emit(state);
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
  else if (cmd.type === 'ready') globalThis.__ctl.click(646, 688);
  else if (cmd.type === 'start') globalThis.__ctl.click(1150, 688);
  else if (cmd.type === 'leave') globalThis.__ctl.click(144, 688);
  else if (cmd.type === 'quit') process.exit(0);
  else if (cmd.type === 'ping') emit({ type: 'pong', t: Date.now() / 1000 });
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
log('ENGINE READY');
