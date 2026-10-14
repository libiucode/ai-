const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");
const http = require("node:http");
const PORT = Number(process.argv[2] || "9223");
function getTargets(){return new Promise((res,rej)=>{http.get(`http://127.0.0.1:${PORT}/json`,r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})}).on("error",rej)})}
(async()=>{
  const ts = await getTargets();
  const page = ts.find(t=>t.type==="page"&&t.url.startsWith("file://"));
  if(!page){console.log("NO_PAGE",ts.map(t=>t.type));process.exit(1)}
  const ws = new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false});
  let id=0;const pend=new Map();
  const send=(m,p)=>new Promise((rs,rj)=>{const i=++id;pend.set(i,{rs,rj});ws.send(JSON.stringify({id:i,method:m,params:p||{}}))});
  ws.on("message",raw=>{const m=JSON.parse(String(raw));if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rj(new Error(JSON.stringify(m.error))):p.rs(m.result)}});
  await new Promise(r=>ws.on("open",r));
  await send("Runtime.enable");
  const r = await send("Runtime.evaluate",{expression:`(()=>{
    const t = document.body.innerText;
    // 抓「实时字幕」区块的文本
    const lines = t.split("\\n");
    const idx = lines.findIndex(l=>l.includes("实时字幕"));
    const sub = idx>=0 ? lines.slice(idx, idx+40).join("\\n") : "(not found)";
    const fin = (t.match(/稳态片段数\\s*(\\d+)/)||[])[1];
    const dur = (t.match(/监听时长\\s*(\\d{2}:\\d{2})/)||[])[1];
    const asr = (t.match(/ASR[\\s\\S]{0,20}?([^\\n]+)/)||[])[1];
    return { finalsShown: fin, duration: dur, asrChip: asr, subtitleBlock: sub };
  })()`, returnByValue:true});
  console.log(JSON.stringify(r.result.value,null,2));
  ws.close();
})().catch(e=>{console.error("FATAL",e.message);process.exit(1)});