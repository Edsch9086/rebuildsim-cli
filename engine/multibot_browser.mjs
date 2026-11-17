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
    window.__tracks=[];
    const track=window.rbTrack;
    window.rbTrack=(n,p)=>{ try{ window.__tracks.push(String(n)); }catch{} return track?track(n,p):undefined; };
    window.__rbPad={id:'Xbox 360 Controller (XInput STANDARD GAMEPAD)',index:0,connected:true,
      mapping:'standard',axes:[0,0,0,0,0,0],
      buttons:Array.from({length:16},()=>({pressed:false,value:0,touched:false})),timestamp:0};
    try{
      Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.__rbPad,null,null,null]});
    }catch{}
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
  // Joining auto-readies the seat. Wait for the room UI to settle, but do not
  // click READY again: that toggles the seat back to NOT READY.
  await p.waitForTimeout(1500);
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
  const start=pose('BlueD');
  let after=start;
  await blue.page.bringToFront();
  // Background tabs throttle rendering/RAF. Give the blue client time to
  // process the match transition before sending input.
  for(let i=0;i<25;i++){
    const inMatch=await blue.page.evaluate(()=>window.__tracks.includes('match_start')).catch(()=>false);
    if(inMatch) break;
    await wait(200);
  }
  for(let attempt=0;attempt<3;attempt++){
    await blue.page.bringToFront();
    await wait(800);
    // The join flow can leave focus in a hidden text box.
    await blue.page.evaluate(()=>{ document.activeElement?.blur?.(); });
    if(attempt===0){
      await blue.page.mouse.click(640,400);
      await blue.page.keyboard.down('w'); await wait(2500); await blue.page.keyboard.up('w');
    } else if(attempt===1){
      // Same virtual gamepad path the headless engine uses. y=1 -> axis 1 = -1.
      await blue.page.evaluate(()=>{
        const e=new Event('gamepadconnected'); e.gamepad=window.__rbPad;
        window.dispatchEvent(e);
        window.__rbPad.axes[1]=-1;
        window.__rbPad.timestamp=performance.now();
      });
      await wait(2500);
      await blue.page.evaluate(()=>{ window.__rbPad.axes[1]=0; window.__rbPad.timestamp=performance.now(); });
    } else {
      // Trusted-ish events on the canvas (window-targeted events break the
      // game's Node.contains checks).
      await blue.page.evaluate(()=>{
        const c=document.querySelector('canvas');
        if(!c) return;
        c.setAttribute('tabindex','0'); c.focus?.();
        const ev=(t)=>c.dispatchEvent(new KeyboardEvent(t,{key:'w',code:'KeyW',keyCode:87,which:87,bubbles:true}));
        ev('keydown'); setTimeout(()=>ev('keyup'),2000);
      });
      await wait(2500);
    }
    await wait(500);
    after=pose('BlueD');
    if((delta(start,after)?.dx||0)<-0.5) break;
  }
  return after;
}
const afterBlue=await driveBlue();
const blueTracks=await blue.page.evaluate(()=>window.__tracks.filter(n=>/match|room_join/.test(n))).catch(()=>[]);
console.log('BLUE TRACKS',JSON.stringify(blueTracks));
console.log('AFTER red',JSON.stringify(afterRed),'blue',JSON.stringify(afterBlue));
console.log('DELTA red',JSON.stringify(delta(beforeRed,afterRed)),'blue',JSON.stringify(delta(beforeBlue,afterBlue)));
const verdict = {
  seats4: seats&&seats.length===4,
  fourthBlue: seats&&seats[3]&&seats[3].alliance==='blue',
  allUnique: seats?new Set(seats.map(s=>s.name)).size===4:false,
  hostMe: lastState&&lastState.me&&lastState.me.name==='RedHost',
  robots4: lastState&&lastState.robots.length===4,
  redForward: delta(beforeRed,afterRed)&&delta(beforeRed,afterRed).dx>0.5,
  // Host is red and sees BlueD in the red/global frame: a real blue client
  // pressing W must move toward the red side (negative x).
  blueForward: delta(beforeBlue,afterBlue)&&delta(beforeBlue,afterBlue).dx<-0.5,
  frameAlliance: lastState&&lastState.frame==='alliance',
};
console.log('VERDICT',JSON.stringify(verdict));
const failed = Object.entries(verdict).filter(([,v]) => v !== true);
if (failed.length) console.error('FAILED', JSON.stringify(failed));
const exitCode = failed.length ? 1 : 0;
await blue.page.screenshot({path:path.join(OUT, 'b4e_blue_after.png')});
await host.stdin.write('{"type":"quit"}\n'); host.kill();
for(const b of bots) await b.ctx.close();
await browser.close();
process.exit(exitCode);
