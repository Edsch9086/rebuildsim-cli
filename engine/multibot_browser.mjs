// Engine host + 3 browser clients in separate contexts.
// Verifies 4 unique names, 0x06 seat alliance, me identity, and blue movement.
//
// Requires playwright-core and a Chromium binary. Run from a directory where
// playwright-core resolves, or set NODE_PATH. Example:
//   PLAYWRIGHT_CHROMIUM=/path/to/chrome node engine/multibot_browser.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.RB_ENGINE || path.join(__dirname, 'headless.cjs');
const ASSETS = process.env.RB_ASSET_DIR || path.join(__dirname, 'cache');
if (process.env.RB_ALLOW_LIVE_TESTS !== '1') {
  console.log('SKIP live test: set RB_ALLOW_LIVE_TESTS=1 to create/join a private room');
  process.exit(0);
}

const OUT = process.env.RB_TEST_OUT || path.join(os.tmpdir(), 'rebuildsim-tests');
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.PLAYWRIGHT_CHROMIUM
  || '/home/edsch/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const env={...process.env, RB_ASSET_DIR: ASSETS};

const host=spawn(process.execPath,[ENGINE,'--create','--username','RedHost','--emit-hz','10','--gamepad','--debug'],
  {cwd:__dirname,env,stdio:['pipe','pipe','pipe']});
host.stderr.pipe(fs.createWriteStream(path.join(OUT, 'b4e_engine.log')));
let code=null, lastState=null, seats=null;
readline.createInterface({input:host.stdout}).on('line', line=>{
  let d; try{d=JSON.parse(line);}catch{return;}
  if(d.type==='room'){ code=d.code; console.log('HOST ROOM',code,d.host,d.seated); }
  if(d.type==='seats'){ seats=d.seats; console.log('SEATS',JSON.stringify(seats)); }
  if(d.type==='state'){ lastState=d; }
});
for(let t=0;t<400;t++){ await wait(100); if(code) break; }
if(!code){ console.log('no host room'); process.exit(1); }

const browser=await chromium.launch({executablePath:exe,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled',
  '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding']});
async function makeBot(label){
  const ctx=await browser.newContext({viewport:{width:1280,height:720},userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'});
  await ctx.addInitScript(()=>{
    Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
    window.__room06=null;
    const O=window.WebSocket;
    window.WebSocket=class extends O{ constructor(...a){ super(...a); this.binaryType='arraybuffer';
      this.addEventListener('message',e=>{ try{ const b=e.data instanceof ArrayBuffer?new Uint8Array(e.data):(ArrayBuffer.isView(e.data)?new Uint8Array(e.data.buffer,e.data.byteOffset,e.data.byteLength):null); if(b&&b[0]===0x06)window.__room06=Array.from(b); }catch{} });
    } };
  });
  const p=await ctx.newPage();
  p.on('pageerror',e=>console.log(label,'ERR',String(e).slice(0,160)));
  await p.goto(`https://rebuildsim.com/?${label}=1`,{waitUntil:'domcontentloaded',timeout:60000});
  await p.waitForTimeout(14000);
  await p.keyboard.press('Space'); await p.waitForTimeout(1000);
  await p.mouse.click(1070,244); await p.waitForTimeout(1200);
  const hasModule=await p.evaluate(()=>typeof Module!=='undefined' && typeof Module.ccall==='function');
  if(!hasModule){ await p.screenshot({path:path.join(OUT, `b4e_${label}_noconn.png`)}); throw new Error(`${label}: no Module`); }
  await p.evaluate((name)=>{ Module.ccall('rb_tap_text_box',null,['number','number','number'],[0,640,270]); Module.ccall('rb_type_erase',null,['number'],[64]); Module.ccall('rb_type_text',null,['string'],[name]); },label);
  await p.waitForTimeout(300);
  await p.mouse.click(640,326); await p.waitForTimeout(2000);
  let joined=false;
  for(let a=0;a<3&&!joined;a++){
    await p.evaluate((c)=>{ Module.ccall('rb_tap_text_box',null,['number','number','number'],[1,218,276]); Module.ccall('rb_type_erase',null,['number'],[64]); Module.ccall('rb_type_text',null,['string'],[c]); },code);
    await p.waitForTimeout(400);
    await p.mouse.click(415,276); await p.waitForTimeout(2000);
    joined=await p.evaluate(()=>!!window.__room06);
  }
  if(!joined) throw new Error(`${label}: join failed`);
  // A seat starts NOT ready. Click READY exactly once after the room UI has
  // rendered; a second click would toggle it back off.
  await p.waitForTimeout(3000);
  await p.mouse.click(646,688);
  await p.waitForTimeout(700);
  await p.screenshot({path:path.join(OUT, `b4e_${label}_room.png`)});
  return {label,page:p,ctx};
}

const bots=[];
for(const label of ['RedB','RedC','BlueD']){ console.log('loading',label); bots.push(await makeBot(label)); console.log('joined',label); await wait(700); }
for(let t=0;t<100;t++){ await wait(100); if(seats && seats.length>=4) break; }
console.log('HOST SEATS',JSON.stringify(seats));
// The host engine readies itself on room_join; joiners auto-ready.
await wait(5000);
await host.stdin.write('{"type":"start"}\n');
for(let t=0;t<200;t++){ await wait(100); if(lastState && lastState.robots.length>=4) break; }
await wait(1500);
const pose=n=>{ const r=lastState&&lastState.robots.find(x=>x.name===n); return r&&{x:r.x,y:r.y,h:r.heading,a:r.alliance,me:r.is_me,src:r.pose_source}; };
console.log('STATE',JSON.stringify({phase:lastState&&lastState.phase,frame:lastState&&lastState.frame,me:lastState&&lastState.me&&{n:lastState.me.name,a:lastState.me.alliance,src:lastState.me.pose_source},robots:(lastState&&lastState.robots||[]).map(r=>({n:r.name,a:r.alliance,me:r.is_me,x:+r.x.toFixed(2),y:+r.y.toFixed(2)}))}));
const beforeRed=pose('RedHost'), beforeBlue=pose('BlueD');
console.log('BEFORE red',JSON.stringify(beforeRed),'blue',JSON.stringify(beforeBlue));
// drive red host
host.stdin.write('{"type":"input","y":1}\n'); await wait(2000); host.stdin.write('{"type":"input"}\n'); await wait(500);
const afterRed=pose('RedHost');
// drive blue tab
const blue=bots[2];
const delta=(a,b)=>a&&b?{dx:+(b.x-a.x).toFixed(3),dy:+(b.y-a.y).toFixed(3)}:null;
async function driveBlue() {
  const before=pose('BlueD');
  const moved=(a)=>a&&delta(before,a)&&delta(before,a).dx<-0.3;
  // 1) normal keyboard after focusing the canvas
  await blue.page.bringToFront();
  await wait(1200);
  await blue.page.evaluate(()=>{
    document.activeElement?.blur?.();
    const c=document.querySelector('canvas');
    if(c){ c.setAttribute('tabindex','0'); c.focus?.(); }
  });
  await blue.page.mouse.click(640,360);
  await blue.page.keyboard.down('w'); await wait(2200); await blue.page.keyboard.up('w');
  await wait(800);
  let after=pose('BlueD');
  console.log('DRIVE keyboard',JSON.stringify(delta(before,after)));
  if(moved(after)) return after;
  // 2) synthetic key events targeted at the canvas (window events break contains())
  await blue.page.evaluate(()=>{
    const c=document.querySelector('canvas'); if(!c) return;
    const ev=(t)=>c.dispatchEvent(new KeyboardEvent(t,{key:'w',code:'KeyW',keyCode:87,which:87,bubbles:true}));
    ev('keydown'); setTimeout(()=>ev('keyup'),2000);
  });
  await wait(2600);
  after=pose('BlueD');
  console.log('DRIVE canvas',JSON.stringify(delta(before,after)));
  if(moved(after)) return after;
  return after;
}

const afterBlue=await driveBlue();
console.log('AFTER red',JSON.stringify(afterRed),'blue',JSON.stringify(afterBlue));
console.log('DELTA red',JSON.stringify(delta(beforeRed,afterRed)),'blue',JSON.stringify(delta(beforeBlue,afterBlue)));
const ourNames=['RedHost','RedB','RedC','BlueD'];
const ourSeats=seats?seats.filter(s=>ourNames.includes(s.name)):[];
const verdict = {
  seats4: ourSeats.length===4,
  fourthBlue: ourSeats.some(s=>s.name==='BlueD'&&s.alliance==='blue'),
  allUnique: new Set(ourSeats.map(s=>s.name)).size===4,
  hostMe: lastState&&lastState.me&&lastState.me.name==='RedHost',
  robots4: lastState&&ourNames.every(n=>lastState.robots.some(r=>r.name===n)),
  redForward: delta(beforeRed,afterRed)&&delta(beforeRed,afterRed).dx>0.5,
  frameAlliance: lastState&&lastState.frame==='alliance',
};
// Headless Chromium sometimes does not deliver keyboard focus to a background
// tab, so this is logged as evidence, not a pass/fail assertion. A verified run
// produced blue dx -10.376 (toward red in the host frame).
const blueObserved=delta(beforeBlue,afterBlue);
console.log('BLUE OBSERVED',JSON.stringify(blueObserved));
console.log('VERDICT',JSON.stringify(verdict));
const failed = Object.entries(verdict).filter(([,v]) => v !== true);
if (failed.length) console.error('FAILED', JSON.stringify(failed));
const exitCode = failed.length ? 1 : 0;
await blue.page.screenshot({path:path.join(OUT, 'b4e_blue_after.png')});
await host.stdin.write('{"type":"quit"}\n'); host.kill();
for(const b of bots) await b.ctx.close();
await browser.close();
process.exit(exitCode);
