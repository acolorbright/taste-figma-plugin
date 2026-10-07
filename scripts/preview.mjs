// Development-only harness. Bound to loopback, never included in the plugin package.
import http from "node:http";
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const ui = await readFile(new URL("dist/ui.html", root), "utf8");
let key = "";
try {
  key = (await readFile(new URL(ui.includes("https://taste-figma-search.fly.dev") ? ".taste-fly-access-key" : ".taste-access-key", root), "utf8")).trim();
} catch {}
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const harness = `<!doctype html><title>Taste plugin preview</title><style>body{font:14px system-ui;background:#e8e8e3;margin:40px;display:flex;gap:32px}iframe{flex-shrink:0;width:660px;height:680px;border:0;border-radius:14px;box-shadow:0 12px 60px #0002}aside{max-width:280px}button{padding:10px;margin:6px 0;display:block}p{line-height:1.6}</style><iframe title="Taste plugin" src="/ui"></iframe><aside><h1>Taste for Figma</h1><p>Development preview with a simulated Figma selection. Search uses the real private service. Insertion is simulated here.</p><button id="text">Select two text layers</button><button id="empty">Clear Figma selection</button><p id="log"></p></aside><script>
const frame=document.querySelector('iframe');const send=m=>frame.contentWindow.postMessage({pluginMessage:m},'*');
const selected=()=>send({type:'selection',selection:{kind:'text',count:2,label:'2 text layers'}});
document.querySelector('#text').onclick=selected;document.querySelector('#empty').onclick=()=>send({type:'selection',selection:{kind:'invalid',count:0,label:'Select an image or one or more text layers in Figma.'}});
window.onmessage=e=>{if(e.source!==frame.contentWindow)return;const m=e.data.pluginMessage;if(!m)return;if(m.type==='ready')selected();if(m.type==='load-connection')send({type:'connection',key:''});if(m.type==='query')send({type:'query',requestId:m.requestId,query:{kind:'text',texts:['Bold editorial typography','Black and white graphic design']}});if(m.type==='insert'){document.querySelector('#log').textContent='Received '+m.images.length+' images with '+m.images.reduce((s,i)=>s+i.bytes.length,0)+' bytes for insertion.';send({type:'inserted',count:m.images.length});}};
</script>`;
http
  .createServer(async (req, res) => {
    if (!["127.0.0.1:8766", "localhost:8766"].includes(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/ui")
      res.end(
        (await readFile(new URL("dist/ui.html", root), "utf8")).replace(
          'id="token"',
          'id="token" value="' + escape(key) + '"',
        ),
      );
    else if (req.url === "/") res.end(harness);
    else res.writeHead(404).end();
  })
  .listen(8766, "127.0.0.1", () =>
    console.log(
      "Preview: http://127.0.0.1:8766 (local key prefilled; do not expose this harness)",
    ),
  );
