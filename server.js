'use strict';
/** Linely server: static app, AI proxy, protected admin API, aggregate analytics. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
/** LINELY_* env vars; the old DEEPLINE_* names still work so existing deployments keep running */
const env = (n) => process.env['LINELY_' + n] ?? process.env['DEEPLINE_' + n];
const DATA_DIR = env('DATA_DIR') || path.join(__dirname, 'data');
const MAX_BODY = 16 * 1024 * 1024;
const RATE_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 90;
const ADMIN_PASSWORD = env('ADMIN_PASSWORD') || '';
const PROVIDERS = {
  'DeepSeek': 'https://api.deepseek.com/chat/completions',
  'Claude': 'https://api.anthropic.com/v1/messages',
  '豆包': 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  'ChatGPT / OpenAI': 'https://api.openai.com/v1/chat/completions',
};
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.wav':'audio/wav','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8' };
const COMPRESSIBLE = new Set(['.html','.js','.css','.json','.webmanifest','.svg','.txt']);
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = require('./db');
const captcha = require('./captcha');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scryptAsync = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? reject(e) : resolve(k))));
const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;
const mapUser = (r) => r && ({ id: r.id, username: r.username, banned: !!r.banned, createdAt: r.created_at, freeUnlockedAt: r.free_unlocked_at || 0, freeExpires: r.free_expires || 0 });
const DEFAULT_FREE = () => ({ enabled: !!env('FREE_API_KEY'), provider: env('FREE_API_PROVIDER') || 'DeepSeek', model: env('FREE_API_MODEL') || 'deepseek-chat', apiKey: env('FREE_API_KEY') || '', baseUrl: env('FREE_API_BASE_URL') || '' });
let config = { freeApi: DEFAULT_FREE() };
const emptyDay = () => ({ visits: 0, apiRequests: 0, freeApiRequests: 0, userApiRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
let metrics = { ...emptyDay(), byDay: {} };
const dirtyDays = new Set();
const sessions = new Map();      // admin sessions (cookie → expiry), kept in memory for 12 h
const userSessions = new Map();  // sha256(user token) → { id, expires }   (persisted in the sessions table)
const userCache = new Map();     // user id → user for logged-in users (kept in sync with the users table)

/** open the database, import any old JSON files once, and load config / metrics / active sessions */
async function bootstrap() {
  await db.init({ dataDir: DATA_DIR });
  const f = await one('SELECT value FROM settings WHERE key=$1', ['freeApi']);
  if (f) { try { config.freeApi = { ...DEFAULT_FREE(), ...JSON.parse(f.value) }; } catch { /* keep defaults */ } }
  for (const r of (await db.query('SELECT * FROM metrics_day')).rows) {
    const d = { visits: r.visits, apiRequests: r.api_requests, freeApiRequests: r.free_api_requests, userApiRequests: r.user_api_requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, totalTokens: r.total_tokens };
    metrics.byDay[r.day] = d; for (const k of Object.keys(d)) metrics[k] += d[k];
  }
  const now = Date.now();
  await db.query('DELETE FROM sessions WHERE expires_at<=$1', [now]);
  const rows = (await db.query('SELECT s.token_hash AS token_hash, s.expires_at AS expires_at, u.id AS id, u.username AS username, u.banned AS banned, u.created_at AS created_at, u.free_unlocked_at AS free_unlocked_at, u.free_expires AS free_expires FROM sessions s JOIN users u ON u.id=s.user_id', [])).rows;
  for (const r of rows) { userSessions.set(r.token_hash, { id: r.id, expires: r.expires_at }); userCache.set(r.id, mapUser(r)); }
}

// ───────────── meme search (AI sends Chinese meme images) ─────────────
const dnsP = require('dns').promises, net = require('net');
const MEME_ON = env('MEME_SEARCH') !== '0';
const MEME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const memeCache = new Map();
function isPrivateIp(ip){
  if(net.isIPv4(ip)){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===0||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||p[0]>=224;}
  const x=String(ip).toLowerCase(); if(x==='::1'||x==='::')return true; if(x.startsWith('::ffff:'))return isPrivateIp(x.slice(7)); return /^(fc|fd|fe[89ab])/.test(x);
}
async function safeUrl(u){
  let url; try{url=new URL(u);}catch{return null;}
  if(!/^https?:$/.test(url.protocol)||url.username||url.password)return null;
  if(url.port&&!['80','443'].includes(url.port))return null;
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addrs=net.isIP(host)?[{address:host}]:await dnsP.lookup(host,{all:true}).catch(()=>[]);
  if(!addrs.length||addrs.some(a=>isPrivateIp(a.address)))return null;
  return url;
}
/** GET with a size cap, timeout and manual redirects that are re-checked against private addresses. */
async function fetchLimited(u,{max=3*1024*1024,accept='image/*',timeout=8000,headers={}}={}){
  let url=await safeUrl(u);
  for(let i=0;i<4&&url;i++){
    const ac=new AbortController(), t=setTimeout(()=>ac.abort(),timeout);
    try{
      const r=await fetch(url,{redirect:'manual',signal:ac.signal,headers:{'User-Agent':MEME_UA,'Accept':accept,...headers}});
      if(r.status>=300&&r.status<400&&r.headers.get('location')){url=await safeUrl(new URL(r.headers.get('location'),url).href);continue;}
      if(!r.ok)return null;
      if(Number(r.headers.get('content-length')||0)>max)return null;
      const chunks=[];let size=0;
      for await(const c of r.body){size+=c.length;if(size>max){ac.abort();return null;}chunks.push(c);}
      return {type:(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase(),buf:Buffer.concat(chunks)};
    }catch{return null;}finally{clearTimeout(t);}
  }
  return null;
}
const unent=s=>s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
async function bingImages(q,gif){
  const u='https://cn.bing.com/images/async?q='+encodeURIComponent(q)+'&first=0&count=35&mmasync=1'+(gif?'&qft='+encodeURIComponent('+filterui:photo-animatedgif'):'');
  const r=await fetchLimited(u,{accept:'text/html',max:2*1024*1024,headers:{'Accept-Language':'zh-CN,zh;q=0.9','Cookie':'SRCHHPGUSR=ADLT=STRICT'}});
  if(!r)return [];
  const html=r.buf.toString('utf8'),out=[];
  for(const m of html.matchAll(/\sm="([^"]+)"/g)){
    try{const j=JSON.parse(unent(m[1]));if(j.murl&&/^https?:\/\//.test(j.murl)&&!/\.svg(\?|$)/i.test(j.murl))out.push({url:j.murl,thumb:j.turl||j.murl,title:String(j.t||'').replace(/<[^>]+>/g,'').slice(0,80)});}catch{}
  }
  return out;
}
async function sogouImages(q){
  const r=await fetchLimited('https://pic.sogou.com/napi/pc/searchList?mode=1&start=0&xml_len=40&query='+encodeURIComponent(q),{accept:'application/json',max:1024*1024,headers:{'Referer':'https://pic.sogou.com/'}});
  if(!r)return [];
  try{const j=JSON.parse(r.buf.toString('utf8'));return ((j.data&&j.data.items)||[]).map(it=>({url:it.picUrl||it.ori_pic_url||it.thumbUrl||'',thumb:it.thumbUrl||it.picUrl||'',title:String(it.title||'').replace(/<[^>]+>/g,'').slice(0,80)})).filter(x=>/^https?:\/\//.test(x.url));}catch{return [];}
}

// ───────────── neural text-to-speech (the free "Read Aloud" voices used by Microsoft Edge) ─────────────
// Natural-sounding Chinese/English/Japanese/Korean voices. Generated on the server so the browser only plays an mp3.
// Set LINELY_TTS=0 to turn it off; the app then falls back to the device's own voices.
const TTS_ON = env('TTS') !== '0';
const TTS_WSS = env('TTS_WSS_URL') || 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4', TTS_CHROME = '130.0.2849.68';
const TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', lang: 'zh-CN', gender: 'female', desc: '温暖亲切，最自然', styles: true },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', lang: 'zh-CN', gender: 'female', desc: '活泼可爱的少女', styles: true },
  { id: 'zh-CN-YunxiNeural', name: '云希', lang: 'zh-CN', gender: 'male', desc: '阳光少年感', styles: true },
  { id: 'zh-CN-YunjianNeural', name: '云健', lang: 'zh-CN', gender: 'male', desc: '沉稳有磁性', styles: true },
  { id: 'zh-CN-YunyangNeural', name: '云扬', lang: 'zh-CN', gender: 'male', desc: '专业播音腔', styles: true },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', lang: 'zh-CN', gender: 'male', desc: '可爱的小男孩', styles: false },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', lang: 'zh-CN', gender: 'female', desc: '东北话', styles: false },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', lang: 'zh-CN', gender: 'female', desc: '陕西话', styles: false },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', lang: 'zh-TW', gender: 'female', desc: '台湾女声', styles: false },
  { id: 'zh-TW-YunJheNeural', name: '雲哲', lang: 'zh-TW', gender: 'male', desc: '台湾男声', styles: false },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳', lang: 'zh-HK', gender: 'female', desc: '粤语女声', styles: false },
  { id: 'zh-HK-WanLungNeural', name: '雲龍', lang: 'zh-HK', gender: 'male', desc: '粤语男声', styles: false },
  { id: 'ja-JP-NanamiNeural', name: '七海', lang: 'ja-JP', gender: 'female', desc: '日语女声', styles: false },
  { id: 'ja-JP-KeitaNeural', name: '圭太', lang: 'ja-JP', gender: 'male', desc: '日语男声', styles: false },
  { id: 'en-US-AriaNeural', name: 'Aria', lang: 'en-US', gender: 'female', desc: 'English · warm', styles: true },
  { id: 'en-US-JennyNeural', name: 'Jenny', lang: 'en-US', gender: 'female', desc: 'English · friendly', styles: true },
  { id: 'en-US-GuyNeural', name: 'Guy', lang: 'en-US', gender: 'male', desc: 'English · calm', styles: true },
  { id: 'ko-KR-SunHiNeural', name: '선히', lang: 'ko-KR', gender: 'female', desc: '한국어 여성', styles: false },
  { id: 'ko-KR-InJoonNeural', name: '인준', lang: 'ko-KR', gender: 'male', desc: '한국어 남성', styles: false },
];
const TTS_STYLES = new Set(['gentle', 'cheerful', 'affectionate', 'calm', 'newscast', 'sad', 'angry', 'friendly', 'chat']);
const ttsCache = new Map();
function ttsGec(){ let t=Math.floor(Date.now()/1000)+11644473600; t-=t%300; return crypto.createHash('sha256').update((BigInt(t)*10000000n).toString()+TTS_TOKEN).digest('hex').toUpperCase(); }
const xmlEsc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const ttsStamp=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]+' '+p(d.getUTCDate())+' '+d.getUTCFullYear()+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds())+' GMT+0000 (Coordinated Universal Time)';};
const sgn=n=>(n>=0?'+':'')+n;
function ttsSsml(o){
  const lang=o.voice.split('-').slice(0,2).join('-');
  const pros=`<prosody pitch='${sgn(o.pitch)}Hz' rate='${sgn(o.rate)}%' volume='${sgn(o.volume)}%'>${xmlEsc(o.text)}</prosody>`;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='${lang}'><voice name='${o.voice}'>${o.style?`<mstts:express-as style='${o.style}'>${pros}</mstts:express-as>`:pros}</voice></speak>`;
}
function ttsOnce(o){
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID().replace(/-/g,'');
    const url=`${TTS_WSS}?TrustedClientToken=${TTS_TOKEN}&ConnectionId=${id}&Sec-MS-GEC=${ttsGec()}&Sec-MS-GEC-Version=1-${TTS_CHROME}`;
    let ws; try{ws=new WebSocket(url,{headers:{'Pragma':'no-cache','Cache-Control':'no-cache','Origin':'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0','Accept-Language':'en-US,en;q=0.9'}});}catch(e){return reject(e);}
    ws.binaryType='arraybuffer'; const chunks=[]; let done=false;
    const finish=err=>{if(done)return;done=true;clearTimeout(timer);try{ws.close();}catch{}err?reject(err):(chunks.length?resolve(Buffer.concat(chunks)):reject(new Error('no audio')));};
    const timer=setTimeout(()=>finish(new Error('timeout')),15000);
    ws.onopen=()=>{
      ws.send(`X-Timestamp:${ttsStamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      ws.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ttsStamp()}Z\r\nPath:ssml\r\n\r\n${ttsSsml(o)}`);
    };
    ws.onmessage=ev=>{
      if(typeof ev.data==='string'){if(ev.data.includes('Path:turn.end'))finish();return;}
      const buf=Buffer.from(ev.data); if(buf.length<2)return; const hl=buf.readUInt16BE(0);
      if(buf.subarray(2,2+hl).toString('utf8').includes('Path:audio'))chunks.push(buf.subarray(2+hl));
    };
    ws.onerror=()=>finish(new Error('ws error')); ws.onclose=()=>finish(chunks.length?undefined:new Error('closed'));
  });
}
async function ttsSynth(o){
  const key=crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex'), hit=ttsCache.get(key); if(hit)return hit;
  let audio;
  try{audio=await ttsOnce(o);}catch(e){ if(o.style){try{audio=await ttsOnce({...o,style:''});}catch{throw e;}} else {try{audio=await ttsOnce(o);}catch{throw e;}} }
  ttsCache.set(key,audio); if(ttsCache.size>150)ttsCache.delete(ttsCache.keys().next().value);
  return audio;
}
const clampInt=(v,lo,hi,d)=>{v=Math.round(Number(v));return Number.isFinite(v)?Math.min(hi,Math.max(lo,v)):d;};
function galleryImage(v){ return typeof v==='string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length<200000; }

function requireUser(req,res){ if(!userSession(req)){sendJson(res,401,{error:'请先登录',loginRequired:true});return false;} return true; }
function setUserCookie(res,token){res.setHeader('Set-Cookie',`dl_user=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.NODE_ENV==='production'?'; Secure':''}`);}
const hits = new Map();
function dayKey(){ return new Date().toISOString().slice(0,10); }
function userSession(req){const raw=cookies(req).dl_user;if(!raw)return null;const key=sha(raw),rec=userSessions.get(key);if(!rec)return null;if(Date.now()>rec.expires){userSessions.delete(key);db.query('DELETE FROM sessions WHERE token_hash=$1',[key]).catch(()=>{});return null;}const u=userCache.get(rec.id);return u&&!u.banned?u:null;}
async function startSession(res,u){const token=crypto.randomBytes(32).toString('hex'),key=sha(token),exp=Date.now()+30*86400000;await db.query('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)',[key,u.id,exp,Date.now()]);userSessions.set(key,{id:u.id,expires:exp});userCache.set(u.id,u);setUserCookie(res,token);}
function dropUserSessions(id){for(const [k,v] of userSessions)if(v.id===id)userSessions.delete(k);db.query('DELETE FROM sessions WHERE user_id=$1',[id]).catch(()=>{});}
const isFree=u=>!!u&&u.freeUnlockedAt>0&&(u.freeExpires===0||u.freeExpires>Date.now());
const entitlements=u=>{const on=isFree(u);return {freeApi:{unlocked:on,expiresAt:on?u.freeExpires:0,permanent:on&&u.freeExpires===0}};};
let metricsTimer=null;
function persistMetrics(){if(metricsTimer)return;metricsTimer=setTimeout(flushMetrics,2000);}
async function flushMetrics(){metricsTimer=null;const days=[...dirtyDays];dirtyDays.clear();for(const day of days){const d=metrics.byDay[day];if(!d)continue;try{await db.query('INSERT INTO metrics_day(day,visits,api_requests,free_api_requests,user_api_requests,input_tokens,output_tokens,total_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(day) DO UPDATE SET visits=excluded.visits,api_requests=excluded.api_requests,free_api_requests=excluded.free_api_requests,user_api_requests=excluded.user_api_requests,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,total_tokens=excluded.total_tokens',[day,d.visits,d.apiRequests,d.freeApiRequests,d.userApiRequests,d.inputTokens,d.outputTokens,d.totalTokens]);}catch(e){console.error('metrics save failed',e.message);dirtyDays.add(day);}}}
function bump(key,n=1){metrics[key]=(metrics[key]||0)+n;const d=dayKey();metrics.byDay[d]||=emptyDay();metrics.byDay[d][key]=(metrics.byDay[d][key]||0)+n;dirtyDays.add(d);persistMetrics();}
function securityHeaders(res){ res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',["default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline'","img-src 'self' data: blob:","media-src 'self' data: blob:","font-src 'self' data:","connect-src 'self' https://api.deepseek.com https://api.anthropic.com https://ark.cn-beijing.volces.com https://api.openai.com","frame-src 'none'","frame-ancestors 'none'","base-uri 'none'","form-action 'self'"].join('; '));res.setHeader('Permissions-Policy','microphone=(self), camera=(self)'); }
function sendJson(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function readBody(req){return new Promise((resolve,reject)=>{let size=0,failed=false;const chunks=[];req.on('data',c=>{if(failed)return;size+=c.length;if(size>MAX_BODY){failed=true;chunks.length=0;reject(Object.assign(new Error('请求体过大'),{status:413}));return;}chunks.push(c);});req.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks).toString('utf8'));});req.on('error',e=>{if(!failed)reject(e);});});}
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();}
function limited(ip,limit=RATE_PER_MIN){const now=Date.now(),a=(hits.get(ip)||[]).filter(t=>now-t<60000);a.push(now);hits.set(ip,a);return a.length>limit;}
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));}
function adminSession(req){const token=cookies(req).dl_admin;if(!token||!sessions.has(token))return false;const expires=sessions.get(token);if(Date.now()>expires){sessions.delete(token);return false;}return true;}
function requireAdmin(req,res){if(!adminSession(req)){sendJson(res,401,{error:'请先登录管理员账号'});return false;}return true;}
function publicConfig(u){const e=entitlements(u).freeApi;return {enabled:!!(config.freeApi.enabled&&config.freeApi.apiKey),provider:config.freeApi.provider,model:config.freeApi.model,unlocked:e.unlocked,expiresAt:e.expiresAt,permanent:e.permanent};}
function adminConfig(){return {freeApi:{enabled:!!config.freeApi.enabled,provider:config.freeApi.provider,model:config.freeApi.model,baseUrl:config.freeApi.baseUrl||'',hasKey:!!config.freeApi.apiKey,keyHint:config.freeApi.apiKey?'已配置（不会显示密钥）':'未配置'},db:db.type};}
async function saveConfig(){await db.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',['freeApi',JSON.stringify(config.freeApi)]);}
const limitHits=new Map();
function limitedKey(key,limit,windowMs){const now=Date.now(),a=(limitHits.get(key)||[]).filter(t=>now-t<windowMs);a.push(now);limitHits.set(key,a);if(limitHits.size>5000){for(const [k,v] of limitHits)if(!v.length||now-v[v.length-1]>windowMs*2)limitHits.delete(k);}return a.length>limit;}
async function jsonBody(req,res){try{return JSON.parse(await readBody(req));}catch(e){sendJson(res,e.status||400,{error:e.status===413?'请求体过大':'请求格式错误'});return null;}}
async function handleAi(req,res){
 if(limited(clientIp(req)))return sendJson(res,429,{error:{message:'请求太频繁，请稍后再试。'}});
 let p;try{p=JSON.parse(await readBody(req));}catch(e){return sendJson(res,e.status||400,{error:{message:e.status===413?'请求体过大':'请求格式错误'}});}
 const useFree=!!p.useFreeApi; let provider=p.provider, body=p.body, headers={};
 if(useFree){if(!isFree(userSession(req)))return sendJson(res,403,{error:{message:'免费 API 尚未解锁：请在「我的」里输入激活码兑换',locked:true}});if(!config.freeApi.enabled||!config.freeApi.apiKey)return sendJson(res,503,{error:{message:'管理员尚未配置可用的免费 API'}});provider=config.freeApi.provider;body={...body,model:config.freeApi.model};if(provider==='第三方中转站 / OpenAI兼容')p.baseUrl=config.freeApi.baseUrl;headers=provider==='Claude'?{'x-api-key':config.freeApi.apiKey,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+config.freeApi.apiKey};}
 else {for(const [k,v] of Object.entries(p.headers||{})){if(['authorization','x-api-key','anthropic-version'].includes(k.toLowerCase())&&typeof v==='string')headers[k.toLowerCase()]=v;}}
 let url=PROVIDERS[provider]; const custom=provider==='第三方中转站 / OpenAI兼容'; if(custom){ try{const u=new URL(String(p.baseUrl||''));if(u.protocol!=='https:'||!u.hostname||u.username||u.password||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(u.hostname))throw new Error();url=u.toString().replace(/\/$/,'');if(!url.endsWith('/chat/completions'))url+='/chat/completions';}catch{return sendJson(res,400,{error:{message:'中转站地址必须是有效的 HTTPS OpenAI 兼容接口地址'}});} } if(!url)return sendJson(res,400,{error:{message:'不支持的 AI 服务商'}});if(!body||typeof body!=='object')return sendJson(res,400,{error:{message:'缺少请求内容'}});
 if(!useFree&&!headers.authorization&&!headers['x-api-key'])return sendJson(res,400,{error:{message:'缺少 API Key'}});
 const outHeaders={'Content-Type':'application/json',...headers};
 try{const upstream=await fetch(url,{method:'POST',headers:outHeaders,body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const raw=await upstream.text();let json={};try{json=JSON.parse(raw);}catch{}
  bump('apiRequests');bump(useFree?'freeApiRequests':'userApiRequests');
  const usage=json.usage||{},input=Number(usage.input_tokens??usage.prompt_tokens??0)||0,output=Number(usage.output_tokens??usage.completion_tokens??0)||0,total=Number(usage.total_tokens??(input+output))||0;
  bump('inputTokens',input);bump('outputTokens',output);bump('totalTokens',total);persistMetrics();
  res.writeHead(upstream.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(raw);
 }catch(e){bump('apiRequests');bump(useFree?'freeApiRequests':'userApiRequests');persistMetrics();sendJson(res,502,{error:{message:'服务器无法连接 AI 服务商：'+(e&&e.name==='TimeoutError'?'超时':(e&&e.message)||'未知错误')}});}
}
const USERNAME_RE=/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,24}$/;
const publicUser=u=>({id:u.id,username:u.username,...entitlements(u)});
const isUniqueErr=e=>/unique|duplicate|constraint/i.test(String(e&&e.message));
async function authApi(req,res,pathname){
 const ip=clientIp(req);
 if(pathname==='/api/auth/me'&&req.method==='GET'){const u=userSession(req);return sendJson(res,200,{authenticated:!!u,user:u?publicUser(u):null});}
 if(pathname==='/api/auth/captcha'&&req.method==='GET'){if(limitedKey('cap:'+ip,40,60000))return sendJson(res,429,{error:'刷新太频繁，请稍后再试'});return sendJson(res,200,await captcha.create(db));}
 if(pathname==='/api/auth/register'&&req.method==='POST'){
  if(limitedKey('reg:'+ip,8,3600000))return sendJson(res,429,{error:'注册太频繁，请一小时后再试',captcha:true});
  const b=await jsonBody(req,res);if(!b)return;
  if(b.website)return sendJson(res,400,{error:'请求被拒绝'});
  if(!(await captcha.verify(db,b.captchaId,b.captcha)))return sendJson(res,400,{error:'验证码错误或已过期，请重新输入',captcha:true});
  const username=String(b.username||'').trim(),password=String(b.password||'');
  if(!USERNAME_RE.test(username))return sendJson(res,400,{error:'用户名需为 3-24 位字母、数字、下划线或中文',captcha:true});
  if(password.length<8||password.length>128)return sendJson(res,400,{error:'密码长度必须为 8-128 位',captcha:true});
  if(/^(.)\1+$/.test(password)||password.toLowerCase()===username.toLowerCase())return sendJson(res,400,{error:'密码太简单，请换一个',captcha:true});
  const salt=crypto.randomBytes(16).toString('hex'),hash=(await scryptAsync(password,salt)).toString('hex'),id=crypto.randomUUID(),now=Date.now();
  try{await db.query('INSERT INTO users(id,username,username_lc,salt,hash,created_at,last_login) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,username,username.toLowerCase(),salt,hash,now,now]);}
  catch(e){if(isUniqueErr(e))return sendJson(res,409,{error:'用户名已存在',captcha:true});console.error('register failed',e.message);return sendJson(res,500,{error:'注册失败，请稍后再试',captcha:true});}
  const u=mapUser(await one('SELECT * FROM users WHERE id=$1',[id]));await startSession(res,u);return sendJson(res,201,{ok:true,user:publicUser(u)});
 }
 if(pathname==='/api/auth/login'&&req.method==='POST'){
  if(limitedKey('login:'+ip,20,60000))return sendJson(res,429,{error:'登录尝试过多，请稍后再试',captcha:true});
  const b=await jsonBody(req,res);if(!b)return;
  if(b.website)return sendJson(res,400,{error:'请求被拒绝'});
  if(!(await captcha.verify(db,b.captchaId,b.captcha)))return sendJson(res,400,{error:'验证码错误或已过期，请重新输入',captcha:true});
  const row=await one('SELECT * FROM users WHERE username_lc=$1',[String(b.username||'').trim().toLowerCase()]);
  const bad=()=>sendJson(res,401,{error:'用户名或密码错误',captcha:true});
  if(!row){await scryptAsync('placeholder-pw','placeholder-salt-0123');return bad();}
  if(row.banned)return sendJson(res,403,{error:'账号已被管理员封禁',captcha:true});
  if(row.locked_until>Date.now())return sendJson(res,429,{error:`密码错误次数过多，请 ${Math.ceil((row.locked_until-Date.now())/60000)} 分钟后再试`,captcha:true});
  const hash=await scryptAsync(String(b.password||''),row.salt),expected=Buffer.from(row.hash,'hex');
  if(hash.length!==expected.length||!crypto.timingSafeEqual(hash,expected)){
   const n=row.fail_count+1;
   if(n>=5){await db.query('UPDATE users SET fail_count=0,locked_until=$1 WHERE id=$2',[Date.now()+15*60000,row.id]);return sendJson(res,429,{error:'密码错误次数过多，账号已锁定 15 分钟',captcha:true});}
   await db.query('UPDATE users SET fail_count=$1 WHERE id=$2',[n,row.id]);return bad();
  }
  await db.query('UPDATE users SET fail_count=0,locked_until=0,last_login=$1 WHERE id=$2',[Date.now(),row.id]);
  const u=mapUser(row);await startSession(res,u);return sendJson(res,200,{ok:true,user:publicUser(u)});
 }
 if(pathname==='/api/auth/logout'&&req.method==='POST'){const raw=cookies(req).dl_user;if(raw){const k=sha(raw);userSessions.delete(k);db.query('DELETE FROM sessions WHERE token_hash=$1',[k]).catch(()=>{});}res.setHeader('Set-Cookie','dl_user=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return sendJson(res,200,{ok:true});}
 return sendJson(res,404,{error:'Not found'});
}

// ───────────── signed-in user: free-API unlock (redeem codes) + announcements ─────────────
function normCode(raw){const s=String(raw||'').toUpperCase().replace(/[^A-Z0-9]/g,'');return s.length===16?`${s.slice(0,4)}-${s.slice(4,8)}-${s.slice(8,12)}-${s.slice(12)}`:'';}
const annRow=r=>({id:r.id,title:r.title,body:r.body,level:r.level,pinned:!!r.pinned,published:!!r.published,createdAt:r.created_at,updatedAt:r.updated_at,expiresAt:r.expires_at});
async function meApi(req,res,pathname,u){
 if(pathname==='/api/me/entitlements'&&req.method==='GET')return sendJson(res,200,entitlements(u));
 if(pathname==='/api/redeem'&&req.method==='POST'){
  if(limitedKey('redeem:'+u.id,10,1800000))return sendJson(res,429,{error:'尝试次数过多，请 30 分钟后再试'});
  const b=await jsonBody(req,res);if(!b)return;
  const code=normCode(b.code);if(!code)return sendJson(res,400,{error:'激活码格式不正确（应为 16 位，如 ABCD-EFGH-JKMN-PQRS）'});
  const now=Date.now(),r=await db.query('UPDATE redeem_codes SET used_by=$1,used_at=$2 WHERE code=$3 AND used_by IS NULL RETURNING days',[u.id,now,code]);
  if(!r.rows.length){const ex=await one('SELECT used_by FROM redeem_codes WHERE code=$1',[code]);return sendJson(res,400,{error:ex?'这个激活码已经被使用过了':'激活码无效，请检查后重试'});}
  const days=Number(r.rows[0].days)||0,active=isFree(u);
  const exp=days<=0||(active&&u.freeExpires===0)?0:Math.max(now,active?u.freeExpires:0)+days*86400000;
  await db.query('UPDATE users SET free_unlocked_at=$1,free_expires=$2 WHERE id=$3',[now,exp,u.id]);
  u.freeUnlockedAt=now;u.freeExpires=exp;
  return sendJson(res,200,{ok:true,days,...entitlements(u)});
 }
 if(pathname==='/api/announcements'&&req.method==='GET'){
  const rows=(await db.query('SELECT a.id,a.title,a.body,a.level,a.pinned,a.published,a.created_at,a.updated_at,a.expires_at,CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END AS is_read FROM announcements a LEFT JOIN announcement_reads r ON r.ann_id=a.id AND r.user_id=$1 WHERE a.published=1 AND (a.expires_at=0 OR a.expires_at>$2) ORDER BY a.pinned DESC,a.created_at DESC LIMIT 50',[u.id,Date.now()])).rows;
  const items=rows.map(r=>({...annRow(r),read:!!r.is_read}));return sendJson(res,200,{items,unread:items.filter(x=>!x.read).length});
 }
 if(pathname==='/api/announcements/read'&&req.method==='POST'){
  const b=await jsonBody(req,res);if(!b)return;const now=Date.now();
  if(b.all)await db.query('INSERT INTO announcement_reads(user_id,ann_id,read_at) SELECT $1,id,CAST($2 AS BIGINT) FROM announcements WHERE published=1 ON CONFLICT DO NOTHING',[u.id,now]);
  else for(const id of (Array.isArray(b.ids)?b.ids:[]).slice(0,100)){try{await db.query('INSERT INTO announcement_reads(user_id,ann_id,read_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[u.id,String(id),now]);}catch{}}
  return sendJson(res,200,{ok:true});
 }
 return null;
}
const CODE_ALPHA='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode(){let s='';for(let i=0;i<16;i++)s+=CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];return `${s.slice(0,4)}-${s.slice(4,8)}-${s.slice(8,12)}-${s.slice(12)}`;}
const LEVELS=['info','success','warning','urgent'];
async function adminApi(req,res,pathname){
 if(pathname==='/api/admin/login'&&req.method==='POST'){if(!ADMIN_PASSWORD)return sendJson(res,503,{error:'服务器未设置 LINELY_ADMIN_PASSWORD'});if(limited(clientIp(req),12))return sendJson(res,429,{error:'登录尝试过多，请稍后再试'});let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const a=Buffer.from(String(b.password||'')),z=Buffer.from(ADMIN_PASSWORD);if(a.length!==z.length||!crypto.timingSafeEqual(a,z))return sendJson(res,401,{error:'管理员密码错误'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+12*60*60*1000);res.setHeader('Set-Cookie',`dl_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`);return sendJson(res,200,{ok:true});}
 if(pathname==='/api/admin/logout'&&req.method==='POST'){const t=cookies(req).dl_admin;sessions.delete(t);res.setHeader('Set-Cookie','dl_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return sendJson(res,200,{ok:true});}
 if(pathname==='/api/admin/me'&&req.method==='GET')return sendJson(res,200,{authenticated:!!adminSession(req),configured:!!ADMIN_PASSWORD});
 if(!requireAdmin(req,res))return;

 // users
 if(pathname==='/api/admin/users'&&req.method==='GET'){const rows=(await db.query('SELECT id,username,banned,created_at,last_login,free_unlocked_at,free_expires FROM users ORDER BY created_at DESC LIMIT 2000')).rows;return sendJson(res,200,{users:rows.map(r=>({id:r.id,username:r.username,banned:!!r.banned,createdAt:r.created_at,lastLogin:r.last_login,free:mapUser(r)&&isFree(mapUser(r)),freeExpires:r.free_expires}))});}
 if(pathname.startsWith('/api/admin/users/')&&req.method==='POST'){
  const id=pathname.split('/').pop(),row=await one('SELECT * FROM users WHERE id=$1',[id]);if(!row)return sendJson(res,404,{error:'用户不存在'});
  const b=await jsonBody(req,res);if(!b)return;const cached=userCache.get(id);
  if(typeof b.banned==='boolean'){await db.query('UPDATE users SET banned=$1 WHERE id=$2',[b.banned?1:0,id]);if(b.banned)dropUserSessions(id);if(cached)cached.banned=b.banned;}
  if(b.free==='grant'){const days=clampInt(b.days,0,3650,0),now=Date.now(),exp=days>0?now+days*86400000:0;await db.query('UPDATE users SET free_unlocked_at=$1,free_expires=$2 WHERE id=$3',[now,exp,id]);if(cached){cached.freeUnlockedAt=now;cached.freeExpires=exp;}}
  if(b.free==='revoke'){await db.query('UPDATE users SET free_unlocked_at=0,free_expires=0 WHERE id=$1',[id]);if(cached){cached.freeUnlockedAt=0;cached.freeExpires=0;}}
  return sendJson(res,200,{ok:true});
 }

 // redeem codes (generated in batches)
 if(pathname==='/api/admin/codes/generate'&&req.method==='POST'){
  const b=await jsonBody(req,res);if(!b)return;
  const count=clampInt(b.count,1,500,1),days=clampInt(b.days,0,3650,0),now=Date.now(),batchId=crypto.randomUUID();
  const name=String(b.name||'').trim().slice(0,40)||('批次 '+new Date(now+8*3600000).toISOString().slice(0,16).replace('T',' '));
  const made=[];
  for(let attempt=0;attempt<4&&made.length<count;attempt++){
   const want=count-made.length,cand=new Set();while(cand.size<want)cand.add(genCode());
   const list=[...cand],ph=[],vals=[];list.forEach((c,i)=>{const k=i*5;ph.push(`($${k+1},$${k+2},$${k+3},$${k+4},$${k+5})`);vals.push(c,batchId,name,days,now);});
   await db.query(`INSERT INTO redeem_codes(code,batch_id,batch_name,days,created_at) VALUES ${ph.join(',')} ON CONFLICT DO NOTHING`,vals);
   const have=new Set((await db.query('SELECT code FROM redeem_codes WHERE batch_id=$1',[batchId])).rows.map(r=>r.code));made.length=0;made.push(...have);
  }
  return sendJson(res,201,{ok:true,batch:{id:batchId,name,days,total:made.length,used:0,createdAt:now},codes:made.sort()});
 }
 if(pathname==='/api/admin/codes'&&req.method==='GET'){
  const sp=new URL(req.url,'http://localhost').searchParams,batch=sp.get('batch')||'';
  const batches=(await db.query('SELECT batch_id,MAX(batch_name) AS batch_name,MAX(days) AS days,MIN(created_at) AS created_at,COUNT(*) AS total,SUM(CASE WHEN used_by IS NOT NULL THEN 1 ELSE 0 END) AS used FROM redeem_codes GROUP BY batch_id ORDER BY MIN(created_at) DESC LIMIT 100')).rows.map(r=>({id:r.batch_id,name:r.batch_name,days:Number(r.days),createdAt:Number(r.created_at),total:Number(r.total),used:Number(r.used)||0}));
  let codes=[];if(batch)codes=(await db.query('SELECT c.code,c.days,c.created_at,c.used_at,u.username AS used_name FROM redeem_codes c LEFT JOIN users u ON u.id=c.used_by WHERE c.batch_id=$1 ORDER BY c.created_at,c.code LIMIT 1000',[batch])).rows.map(r=>({code:r.code,days:r.days,createdAt:r.created_at,usedAt:r.used_at,usedBy:r.used_name||(r.used_at?'(已删除的用户)':'')}));
  return sendJson(res,200,{batches,codes});
 }
 if(pathname==='/api/admin/codes/delete'&&req.method==='POST'){const b=await jsonBody(req,res);if(!b)return;const r=await db.query('DELETE FROM redeem_codes WHERE batch_id=$1 AND used_by IS NULL',[String(b.batch||'')]);return sendJson(res,200,{ok:true,deleted:r.rowCount});}

 // announcements
 if(pathname==='/api/admin/announcements'&&req.method==='GET'){const rows=(await db.query('SELECT a.id,a.title,a.body,a.level,a.pinned,a.published,a.created_at,a.updated_at,a.expires_at,(SELECT COUNT(*) FROM announcement_reads r WHERE r.ann_id=a.id) AS reads FROM announcements a ORDER BY a.pinned DESC,a.created_at DESC LIMIT 200')).rows;return sendJson(res,200,{items:rows.map(r=>({...annRow(r),reads:Number(r.reads)||0}))});}
 if(pathname==='/api/admin/announcements'&&req.method==='POST'){
  const b=await jsonBody(req,res);if(!b)return;const title=String(b.title||'').trim().slice(0,100),body=String(b.body||'').trim().slice(0,4000);
  if(!title)return sendJson(res,400,{error:'请填写公告标题'});
  const level=LEVELS.includes(b.level)?b.level:'info',pinned=b.pinned?1:0,published=b.published===false?0:1,expires=Math.max(0,Number(b.expiresAt)||0),now=Date.now();
  if(b.id){const r=await db.query('UPDATE announcements SET title=$1,body=$2,level=$3,pinned=$4,published=$5,expires_at=$6,updated_at=$7 WHERE id=$8',[title,body,level,pinned,published,expires,now,String(b.id)]);if(!r.rowCount)return sendJson(res,404,{error:'公告不存在'});return sendJson(res,200,{ok:true,id:b.id});}
  const id=crypto.randomUUID();await db.query('INSERT INTO announcements(id,title,body,level,pinned,published,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)',[id,title,body,level,pinned,published,now,expires]);return sendJson(res,201,{ok:true,id});
 }
 const adm=pathname.match(/^\/api\/admin\/announcements\/([\w-]{8,64})\/delete$/);
 if(adm&&req.method==='POST'){await db.query('DELETE FROM announcements WHERE id=$1',[adm[1]]);return sendJson(res,200,{ok:true});}

 // gallery moderation
 if(pathname==='/api/admin/gallery'&&req.method==='GET'){
  const chars=(await db.query('SELECT id,name,author,created_at FROM gallery_characters ORDER BY created_at DESC LIMIT 600')).rows,avs=(await db.query('SELECT id,character_id,author,image FROM gallery_avatars ORDER BY created_at ASC')).rows;
  const by=new Map();for(const a of avs){(by.get(a.character_id)||by.set(a.character_id,[]).get(a.character_id)).push({id:a.id,author:a.author,image:a.image});}
  return sendJson(res,200,{characters:chars.map(c=>({id:c.id,name:c.name,author:c.author,createdAt:c.created_at,avatars:by.get(c.id)||[]}))});
 }
 const adc=pathname.match(/^\/api\/admin\/gallery\/([\w-]{8,64})\/delete$/);
 if(adc&&req.method==='POST'){await db.query('DELETE FROM gallery_characters WHERE id=$1',[adc[1]]);return sendJson(res,200,{ok:true});}
 const ada=pathname.match(/^\/api\/admin\/gallery\/([\w-]{8,64})\/avatars\/([\w-]{8,64})\/delete$/);
 if(ada&&req.method==='POST'){await db.query('DELETE FROM gallery_avatars WHERE id=$1 AND character_id=$2',[ada[2],ada[1]]);return sendJson(res,200,{ok:true});}

 if(pathname==='/api/admin/metrics'&&req.method==='GET'){const n=Number((await one('SELECT COUNT(*) AS n FROM users')).n)||0;return sendJson(res,200,{...metrics,users:n,db:db.type});}
 if(pathname==='/api/admin/config'&&req.method==='GET')return sendJson(res,200,adminConfig());
 if(pathname==='/api/admin/config'&&req.method==='POST'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const f=b.freeApi||{};if(f.provider&&!PROVIDERS[f.provider]&&f.provider!=='第三方中转站 / OpenAI兼容')return sendJson(res,400,{error:'不支持的服务商'});if(f.provider==='第三方中转站 / OpenAI兼容'){try{const u=new URL(String(f.baseUrl||''));if(u.protocol!=='https:'||!u.hostname||u.username||u.password||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(u.hostname))throw new Error();}catch{return sendJson(res,400,{error:'第三方 API 必须填写有效的 HTTPS OpenAI 兼容 Base URL'});}}config.freeApi.enabled=!!f.enabled;if(f.provider)config.freeApi.provider=f.provider;if(typeof f.baseUrl==='string')config.freeApi.baseUrl=f.baseUrl.trim().slice(0,500);if(typeof f.model==='string'&&f.model.trim())config.freeApi.model=f.model.trim().slice(0,160);if(typeof f.apiKey==='string'&&f.apiKey.trim())config.freeApi.apiKey=f.apiKey.trim();if(f.clearKey===true)config.freeApi.apiKey='';await saveConfig();return sendJson(res,200,adminConfig());}
 return sendJson(res,404,{error:'Not found'});
}
function serveStatic(req,res,pathname){let rel;try{rel=decodeURIComponent(pathname);}catch{return res.writeHead(400).end('Bad request');}if(rel.endsWith('/'))rel+='index.html';const file=path.normalize(path.join(PUBLIC_DIR,rel));if(!file.startsWith(PUBLIC_DIR+path.sep)&&file!==PUBLIC_DIR)return res.writeHead(403).end('Forbidden');fs.stat(file,(err,st)=>{if(err||!st.isFile()){if(!path.extname(rel))return serveStatic(req,res,'/index.html');res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found');}const ext=path.extname(file).toLowerCase(),headers={'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':ext==='.html'||ext==='.js'||ext==='.css'?'no-cache':'public, max-age=604800'};if(rel==='/index.html'&&req.method==='GET'){bump('visits');persistMetrics();}const gz=COMPRESSIBLE.has(ext)&&/\bgzip\b/.test(req.headers['accept-encoding']||'');if(gz){headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';res.writeHead(200,headers);fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);}else{headers['Content-Length']=st.size;res.writeHead(200,headers);fs.createReadStream(file).pipe(res);}});}
const themeRow=r=>({id:r.id,name:r.name,description:r.description,author:r.author,accent:r.accent,bubbleColor:r.bubble_color,myBubbleColor:r.my_bubble_color,myTextColor:r.my_text_color,aiTextColor:r.ai_text_color,bubbleStyle:r.bubble_style,bubbleRadius:r.bubble_radius,background:r.background,createdAt:r.created_at});
const hexOr=(v,d)=>/^#[0-9a-f]{6}$/i.test(v)?v:d;
const server=http.createServer(async(req,res)=>{try{
 securityHeaders(res);const {pathname}=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&pathname==='/healthz')return sendJson(res,200,{ok:true,db:db.type});
 if(pathname.startsWith('/api/auth/'))return await authApi(req,res,pathname);
 if(pathname==='/auth.html'||pathname==='/auth.css'||pathname==='/auth.js')return serveStatic(req,res,pathname);
 if(pathname.startsWith('/api/admin/'))return await adminApi(req,res,pathname);
 if(!pathname.startsWith('/api/')&&pathname!=='/favicon.ico'&&!userSession(req)&&!['/auth.html','/admin.html','/admin.js','/admin.css'].includes(pathname)){res.writeHead(302,{Location:'/auth.html'});return res.end();}
 if(pathname.startsWith('/api/')&&!pathname.startsWith('/api/admin/')&&!requireUser(req,res))return;
 const me=userSession(req);
 if(pathname==='/api/redeem'||pathname.startsWith('/api/me/')||pathname.startsWith('/api/announcements')){const r=await meApi(req,res,pathname,me);if(r!==null)return;}
 if(req.method==='GET'&&pathname==='/api/free-config')return sendJson(res,200,publicConfig(me));
 if(req.method==='POST'&&pathname==='/api/ai')return handleAi(req,res);
 if(req.method==='GET'&&pathname==='/api/themes')return sendJson(res,200,(await db.query('SELECT * FROM themes ORDER BY created_at DESC LIMIT 300')).rows.map(themeRow));
 if(req.method==='POST'&&pathname==='/api/themes'){const b=await jsonBody(req,res);if(!b)return;if(!String(b.name||'').trim())return sendJson(res,400,{error:'主题名称不能为空'});
  const id=crypto.randomUUID();
  await db.query('INSERT INTO themes(id,name,description,author,accent,bubble_color,my_bubble_color,my_text_color,ai_text_color,bubble_style,bubble_radius,background,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
   [id,String(b.name).slice(0,50),String(b.description||'').slice(0,200),me.username,hexOr(b.accent,'#0A84FF'),hexOr(b.bubbleColor,'#FFFFFF'),hexOr(b.myBubbleColor,'#0A84FF'),hexOr(b.myTextColor,'#243047'),hexOr(b.aiTextColor,'#263247'),['classic','bunny','kitty','cloud','sticker'].includes(b.bubbleStyle)?b.bubbleStyle:'classic',Math.min(30,Math.max(8,Math.round(Number(b.bubbleRadius))||18)),typeof b.background==='string'&&b.background.startsWith('data:image/')&&b.background.length<500000?b.background:'',Date.now()]);
  await db.query('DELETE FROM themes WHERE id NOT IN (SELECT id FROM themes ORDER BY created_at DESC LIMIT 300)');return sendJson(res,201,{ok:true,id});}
 if(pathname==='/api/tts/voices'&&req.method==='GET'){if(!requireUser(req,res))return;return sendJson(res,200,{enabled:TTS_ON,voices:TTS_ON?TTS_VOICES.map(({id,name,lang,gender,desc,styles})=>({id,name,lang,gender,desc,styles})):[]});}
 if(pathname==='/api/tts'&&req.method==='POST'){
  if(!requireUser(req,res))return; if(!TTS_ON)return sendJson(res,404,{error:'云端语音已关闭'});
  let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}
  const text=String(b.text||'').trim().slice(0,600), v=TTS_VOICES.find(x=>x.id===b.voice);
  if(!text)return sendJson(res,400,{error:'没有要朗读的文字'}); if(!v)return sendJson(res,400,{error:'不支持这个声音'});
  const o={text,voice:v.id,rate:clampInt(b.rate,-50,50,0),pitch:clampInt(b.pitch,-40,40,0),volume:clampInt(b.volume,-50,0,0),style:v.styles&&TTS_STYLES.has(b.style)?b.style:''};
  try{const audio=await ttsSynth(o);res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'private, max-age=600','X-Content-Type-Options':'nosniff'});return res.end(audio);}
  catch(e){return sendJson(res,502,{error:'云端语音暂时不可用'});}
 }
 if(pathname==='/api/meme/search'&&req.method==='GET'){
  if(!requireUser(req,res))return;
  if(!MEME_ON)return sendJson(res,200,{enabled:false,items:[]});
  const sp=new URL(req.url,'http://localhost').searchParams; let q=String(sp.get('q')||'').trim().slice(0,40);
  if(!q)return sendJson(res,400,{error:'请输入搜索词'});
  const gif=sp.get('gif')==='1'; if(!/表情|梗图|斗图|meme/i.test(q))q+=' 表情包';
  const key=q+'|'+gif, hit=memeCache.get(key);
  if(hit&&Date.now()-hit.t<600000)return sendJson(res,200,{enabled:true,items:hit.items});
  let items=[]; try{items=await bingImages(q,gif);}catch{}
  if(items.length<6){try{items=items.concat(await sogouImages(q));}catch{}}
  const seen=new Set(); items=items.filter(i=>!seen.has(i.url)&&seen.add(i.url)).slice(0,24);
  if(items.length){memeCache.set(key,{t:Date.now(),items});if(memeCache.size>200)memeCache.delete(memeCache.keys().next().value);}
  return sendJson(res,200,{enabled:true,items});
 }
 if(pathname==='/api/meme/img'&&req.method==='GET'){
  if(!requireUser(req,res))return;
  if(!MEME_ON)return sendJson(res,404,{error:'表情包搜索已关闭'});
  const u=new URL(req.url,'http://localhost').searchParams.get('u')||'';
  const r=await fetchLimited(u,{max:3*1024*1024});
  if(!r||!/^image\/(jpeg|png|gif|webp)$/.test(r.type))return sendJson(res,404,{error:'图片无法获取'});
  res.writeHead(200,{'Content-Type':r.type,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});return res.end(r.buf);
 }
 if(pathname==='/api/gallery'&&req.method==='GET'){
  const chars=(await db.query('SELECT id,name,bio,persona,author,author_id,created_at FROM gallery_characters ORDER BY created_at DESC LIMIT 600')).rows;
  const counts=new Map((await db.query('SELECT character_id,COUNT(*) AS n FROM gallery_avatars GROUP BY character_id')).rows.map(r=>[r.character_id,Number(r.n)]));
  const first=(await db.query('SELECT id,character_id,author,image FROM (SELECT id,character_id,author,image,created_at,ROW_NUMBER() OVER (PARTITION BY character_id ORDER BY created_at ASC) AS rn FROM gallery_avatars) t WHERE rn<=6 ORDER BY created_at ASC')).rows;
  const by=new Map();for(const a of first){(by.get(a.character_id)||by.set(a.character_id,[]).get(a.character_id)).push({id:a.id,author:a.author,image:a.image});}
  return sendJson(res,200,chars.map(c=>({id:c.id,name:c.name,bio:c.bio,author:c.author,mine:c.author_id===me.id,hasPersona:!!c.persona,createdAt:c.created_at,avatarCount:counts.get(c.id)||0,avatars:by.get(c.id)||[]})));
 }
 const gm=pathname.match(/^\/api\/gallery\/([\w-]{8,64})$/);
 if(gm&&req.method==='GET'){const c=await one('SELECT * FROM gallery_characters WHERE id=$1',[gm[1]]);if(!c)return sendJson(res,404,{error:'角色不存在'});const avs=(await db.query('SELECT id,author,author_id,image,note,created_at FROM gallery_avatars WHERE character_id=$1 ORDER BY created_at ASC',[c.id])).rows;
  return sendJson(res,200,{id:c.id,name:c.name,bio:c.bio,persona:c.persona,author:c.author,mine:c.author_id===me.id,createdAt:c.created_at,avatars:avs.map(a=>({id:a.id,author:a.author,mine:a.author_id===me.id,image:a.image,note:a.note,createdAt:a.created_at}))});}
 if(pathname==='/api/gallery'&&req.method==='POST'){const b=await jsonBody(req,res);if(!b)return;const name=String(b.name||'').trim();if(!name)return sendJson(res,400,{error:'角色名称不能为空'});if(!galleryImage(b.avatar))return sendJson(res,400,{error:'请提供头像图片（需小于约 150KB）'});
  const n=Number((await one('SELECT COUNT(*) AS n FROM gallery_characters WHERE author_id=$1',[me.id])).n);if(n>=30)return sendJson(res,400,{error:'你发布的角色已达上限（30 个）'});
  const id=crypto.randomUUID(),now=Date.now();
  await db.query('INSERT INTO gallery_characters(id,name,bio,persona,author,author_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,name.slice(0,60),String(b.bio||'').slice(0,240),b.sharePersona?String(b.persona||'').slice(0,12000):'',me.username,me.id,now]);
  await db.query('INSERT INTO gallery_avatars(id,character_id,author,author_id,image,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),id,me.username,me.id,b.avatar,'原作者头像',now]);
  await db.query('DELETE FROM gallery_characters WHERE id NOT IN (SELECT id FROM gallery_characters ORDER BY created_at DESC LIMIT 600)');return sendJson(res,201,{ok:true,id});}
 const ga=pathname.match(/^\/api\/gallery\/([\w-]{8,64})\/avatars$/);
 if(ga&&req.method==='POST'){const b=await jsonBody(req,res);if(!b)return;const c=await one('SELECT id FROM gallery_characters WHERE id=$1',[ga[1]]);if(!c)return sendJson(res,404,{error:'角色不存在'});if(!galleryImage(b.image))return sendJson(res,400,{error:'请提供头像图片（需小于约 150KB）'});
  if(Number((await one('SELECT COUNT(*) AS n FROM gallery_avatars WHERE character_id=$1',[c.id])).n)>=60)return sendJson(res,400,{error:'这个角色的头像已满'});
  if(Number((await one('SELECT COUNT(*) AS n FROM gallery_avatars WHERE character_id=$1 AND author_id=$2',[c.id,me.id])).n)>=5)return sendJson(res,400,{error:'每人最多为同一角色投稿 5 张头像'});
  const id=crypto.randomUUID();await db.query('INSERT INTO gallery_avatars(id,character_id,author,author_id,image,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,c.id,me.username,me.id,b.image,String(b.note||'').slice(0,80),Date.now()]);return sendJson(res,201,{ok:true,id});}
 const gd=pathname.match(/^\/api\/gallery\/([\w-]{8,64})\/delete$/);
 if(gd&&req.method==='POST'){const c=await one('SELECT author_id FROM gallery_characters WHERE id=$1',[gd[1]]);if(!c)return sendJson(res,404,{error:'角色不存在'});if(c.author_id!==me.id)return sendJson(res,403,{error:'只能删除自己发布的角色'});await db.query('DELETE FROM gallery_characters WHERE id=$1',[gd[1]]);return sendJson(res,200,{ok:true});}
 const gad=pathname.match(/^\/api\/gallery\/([\w-]{8,64})\/avatars\/([\w-]{8,64})\/delete$/);
 if(gad&&req.method==='POST'){const a=await one('SELECT a.author_id AS author_id,c.author_id AS owner_id FROM gallery_avatars a JOIN gallery_characters c ON c.id=a.character_id WHERE a.id=$1 AND a.character_id=$2',[gad[2],gad[1]]);if(!a)return sendJson(res,404,{error:'头像不存在'});if(a.author_id!==me.id&&a.owner_id!==me.id)return sendJson(res,403,{error:'没有权限删除'});await db.query('DELETE FROM gallery_avatars WHERE id=$1',[gad[2]]);return sendJson(res,200,{ok:true});}
 if(req.method==='GET'&&pathname==='/api/plaza')return sendJson(res,200,(await db.query('SELECT * FROM plaza ORDER BY created_at DESC LIMIT 500')).rows.map(r=>({id:r.id,name:r.name,bio:r.bio,persona:r.persona,avatar:r.avatar,provider:r.provider,model:r.model,likes:r.likes,dislikes:r.dislikes,hobbies:r.hobbies,gender:r.gender,relationship:r.relationship,createdAt:r.created_at})));
 if(req.method==='POST'&&pathname==='/api/plaza'){const b=await jsonBody(req,res);if(!b)return;if(!String(b.name||'').trim()||!String(b.persona||'').trim())return sendJson(res,400,{error:'人设名称和内容不能为空'});const id=crypto.randomUUID();
  await db.query('INSERT INTO plaza(id,name,bio,persona,avatar,provider,model,likes,dislikes,hobbies,gender,relationship,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[id,String(b.name).slice(0,60),String(b.bio||'').slice(0,240),String(b.persona).slice(0,12000),typeof b.avatar==='string'&&b.avatar.startsWith('data:image/')&&b.avatar.length<700000?b.avatar:'',String(b.provider||'DeepSeek').slice(0,80),String(b.model||'').slice(0,120),String(b.likes||'').slice(0,500),String(b.dislikes||'').slice(0,500),String(b.hobbies||'').slice(0,500),String(b.gender||'其他').slice(0,20),String(b.relationship||'朋友').slice(0,30),Date.now()]);
  await db.query('DELETE FROM plaza WHERE id NOT IN (SELECT id FROM plaza ORDER BY created_at DESC LIMIT 500)');return sendJson(res,201,{ok:true,id});}
 if(req.method==='GET'||req.method==='HEAD')return serveStatic(req,res,pathname);
 res.writeHead(405);res.end('Method Not Allowed');
}catch(e){console.error('request failed:',req.method,req.url,e&&e.message);if(!res.headersSent)sendJson(res,500,{error:'服务器出错了，请稍后再试'});else res.end();}});
bootstrap().then(()=>{if(db.type==='SQLite'&&process.env.RENDER)console.warn('[db] WARNING: using SQLite on Render — data is lost on redeploy unless a persistent disk is attached. Set DATABASE_URL to the Render PostgreSQL connection string.');server.listen(PORT,'0.0.0.0',()=>console.log(`Linely web listening on :${PORT} (database: ${db.type})`));}).catch((e)=>{console.error('Failed to start:',e&&e.code==='MODULE_NOT_FOUND'?'missing dependency — run `npm install` (the pg driver is needed when DATABASE_URL is set)':e);process.exit(1);});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{try{await flushMetrics();}catch{}process.exit(0);});
