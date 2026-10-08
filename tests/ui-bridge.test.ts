import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const compiled = await build({
  entryPoints: ["src/ui.ts"],
  bundle: true,
  write: false,
  target: "es2020",
  define: { __API_URL__: JSON.stringify("http://localhost:8765") },
});

function panel(fetchResponse?: (url: string, init: any) => Promise<any>, cryptoProvider: any = webcrypto) {
  const elements = new Map<string, any>();
  const outgoing: any[] = [];
  const connections: any[] = [];
  const requests: any[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const makeElement = (): any => ({
    textContent: "", value: "", hidden: false, disabled: false, dataset: {},
    children: [], style: {},
    setAttribute() {},
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    click() { if (!this.disabled) this.onclick?.(); },
  });
  const checkboxes = () => (elements.get("grid")?.children || []).map((card: any) => card.children[0]);
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, makeElement());
    return elements.get(id);
  };
  const window: any = {};
  const parent = { postMessage: (message: any) => ((message.pluginMessage.type.endsWith("-connection") || message.pluginMessage.type === "save-installation") ? connections : outgoing).push(message) };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    window,
    parent,
    document: { getElementById: element, querySelectorAll: checkboxes, createElement: makeElement },
    console,
    crypto: cryptoProvider,
    DOMException,
    Blob,
    FormData,
    Uint8Array,
    AbortSignal,
    AbortController,
    URL,
    setTimeout: (fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, init: any) => {
      requests.push({url, init});
      if (fetchResponse) return fetchResponse(url, init);
      return {ok: true, json: async () => url.endsWith("/health") ? {count:2204} : {results:[]}};
    },
  });
  return {
    window,
    parent,
    element,
    outgoing,
    connections,
    requests,
    checkboxes,
    tick: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((fn) => fn());
    },
  };
}

test("Figma-relayed selection messages work without parent window identity", async () => {
  const p = panel();
  assert.equal(p.outgoing[0].pluginMessage.type, "ready");
  p.element("token").value = "test-access-key";
  await p.element("connect").onclick();
  for (const source of [null, {}, p.parent]) {
    p.window.onmessage({
      source,
      data: {
        pluginMessage: {
          type: "selection",
          selection: { kind: "image", label: "Selected photo", count: 1 },
        },
      },
    });
    assert.equal(p.element("empty").hidden, true);
  }
  p.window.onmessage({
    source: null,
    data: {
      pluginMessage: {
        type: "selection",
        selection: { kind: "text", label: "2 text layers", count: 2 },
      },
    },
  });
  assert.equal(p.element("empty").hidden, true);
  p.window.onmessage({
    source: null,
    data: {
      pluginMessage: {
        type: "selection",
        selection: {
          kind: "invalid",
          label: "Select an image or text layers.",
          count: 0,
        },
      },
    },
  });
  p.tick();
  assert.equal(p.outgoing.length, 1);
  assert.equal(p.element("empty").hidden, false);
  assert.match(p.element("empty").textContent, /Select an image/);
});

test("unrelated iframe messages are ignored", () => {
  const p = panel();
  for (const data of [
    null,
    undefined,
    "other event",
    {},
    { pluginMessage: null },
  ]) {
    assert.doesNotThrow(() => p.window.onmessage({ source: null, data }));
  }
});

function select(p: ReturnType<typeof panel>, kind: string, label = "Photo") {
  p.window.onmessage({
    data: {
      pluginMessage: {
        type: "selection",
        selection: { kind, label, count: 1 },
      },
    },
  });
}
test("image selection auto-searches after connecting and debounces rapid changes", async () => {
  const p = panel();
  select(p, "image");
  p.tick();
  assert.equal(p.outgoing.length, 1);
  p.element("token").value = "test-key";
  await p.element("connect").onclick();
  select(p, "image", "Second photo");
  select(p, "image", "Third photo");
  p.tick();
  assert.equal(p.outgoing.length, 2);
  assert.equal(p.outgoing[1].pluginMessage.type, "query");
  assert.equal(p.element("empty").hidden, true);
});
test("text selections auto-search and invalid selections cancel pending searches", async () => {
  const p = panel();
  p.element("token").value = "test-key";
  await p.element("connect").onclick();
  select(p, "image");
  select(p, "invalid");
  p.tick();
  assert.equal(p.outgoing.length, 1);
  select(p, "text", "2 text layers");
  p.tick();
  assert.equal(p.outgoing.length, 2);
  assert.equal(p.outgoing[1].pluginMessage.type, "query");
});
test("a newer image selection queues until an active query finishes", async () => {
  const p = panel();
  p.element("token").value = "test-key";
  await p.element("connect").onclick();
  select(p, "image");
  p.tick();
  select(p, "image", "Next photo");
  p.tick();
  assert.equal(p.outgoing.length, 2);
  p.window.onmessage({
    data: {
      pluginMessage: { type: "error", requestId: 1, message: "Export failed" },
    },
  });
  p.tick();
  assert.equal(p.outgoing.length, 3);
  assert.equal(p.outgoing[2].pluginMessage.requestId, 2);
});

test("insertion completion refreshes selection and resumes automatic image search", async () => {
  const p = panel();
  p.element("token").value = "test-key";
  await p.element("connect").onclick();
  select(p, "text", "1 text layer");
  // Exercise the insertion lifecycle; image downloading is independent of it.
  await p.element("insert").onclick();
  select(p, "image", "Inserted image");
  p.tick();
  assert.equal(p.outgoing.filter(m => m.pluginMessage.type === "query").length, 0);
  p.window.onmessage({ data: { pluginMessage: { type: "inserted", count: 1 } } });
  assert.equal(p.outgoing.at(-1).pluginMessage.type, "ready");
  // The host answers ready with the current selection, regardless of whether
  // Figma's selectionchange event preceded or followed insertion completion.
  select(p, "image", "Inserted image");
  select(p, "image", "Inserted image");
  p.tick();
  assert.equal(p.outgoing.filter(m => m.pluginMessage.type === "query").length, 1);
  assert.equal(p.element("empty").hidden, true);
});


test("saved connection reconnects automatically and hides setup", async () => {
  const p = panel();
  assert.equal(p.connections[0].pluginMessage.type, "load-connection");
  p.window.onmessage({ data: { pluginMessage: { type: "connection", key: "saved-key" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.element("settings").hidden, true);
  assert.equal(p.connections.at(-1).pluginMessage.key, "saved-key");
  select(p, "image");
  p.tick();
  assert.equal(p.outgoing.at(-1).pluginMessage.type, "query");
});

test("missing saved connection shows first-use setup", () => {
  const p = panel();
  p.window.onmessage({ data: { pluginMessage: { type: "connection", key: "" } } });
  assert.equal(p.element("settings").hidden, false);
  assert.equal(p.element("empty").hidden, true);
});


test("reference query uses stored embedding endpoint without uploading bytes", async () => {
  const p = panel();
  p.element("token").value = "test-key";
  await p.element("connect").onclick();
  select(p, "image");
  p.tick();
  p.window.onmessage({data:{pluginMessage:{type:"query", requestId:1, query:{kind:"reference",id:"001"}}}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.requests.at(-1).url, "http://localhost:8765/search/reference");
  assert.deepEqual(JSON.parse(p.requests.at(-1).init.body), {id:"001",paginate:true});
});


test("loaded cards can be inserted while other previews are pending", async () => {
  const downloads = new Map<string, (value: any) => void>();
  const p = panel(async url => {
    if (url.endsWith("/health")) return {ok:true, json:async()=>({count:2})};
    if (url.endsWith("/search/text")) return {ok:true, json:async()=>({results:[
      {id:"a",name:"A",cluster:"",score:1}, {id:"b",name:"B",cluster:"",score:0.9},
    ]})};
    return new Promise(resolve => downloads.set(url, resolve));
  });
  p.element("token").value = "test-key";
  await p.element("connect").onclick();
  select(p, "text");
  p.tick();
  p.window.onmessage({data:{pluginMessage:{type:"query",requestId:1,query:{kind:"text",texts:["test"]}}}});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  const [first, second] = p.checkboxes();
  assert.equal(first.disabled, true);
  assert.equal(second.disabled, true);
  downloads.get("http://localhost:8765/images/a?size=320")!({ok:true,blob:async()=>new Blob(["image"])});
  await flush();
  const firstImage = p.element("grid").children[0].children[1].children[0];
  firstImage.onload();
  assert.equal(first.disabled, false);
  assert.equal(second.disabled, true);
  first.checked = true;
  first.onchange();
  assert.equal(p.element("insert").disabled, false);
  const inserting = p.element("insert").onclick();
  assert.equal(first.disabled, true);
  downloads.get("http://localhost:8765/images/b?size=320")!({ok:true,blob:async()=>new Blob(["image"])});
  await flush();
  p.element("grid").children[1].children[1].children[0].onload();
  assert.equal(p.element("insert").disabled, true, "thumbnail completion must not release insertion lock");
  assert.equal(second.disabled, true);
  downloads.get("http://localhost:8765/images/a?size=4096")!({ok:true,arrayBuffer:async()=>new Uint8Array([1]).buffer});
  await inserting;
  assert.equal(p.outgoing.at(-1).pluginMessage.type, "insert");
  assert.equal(p.outgoing.at(-1).pluginMessage.images[0].id, "a");
});

test("cold startup rotates explanations, retries temporary errors and cleans up", async () => {
  let finish!: (value: any) => void;
  let calls = 0;
  const p = panel(async () => {
    calls++;
    if (calls === 1) return {ok:false,status:503,json:async()=>({})};
    return new Promise(resolve => { finish = resolve; });
  });
  p.element("token").value = "test-key";
  const connecting = p.element("connect").onclick();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  p.tick();
  await flush();
  assert.equal(calls, 2);
  assert.equal(p.element("startup").hidden, false);
  const first = p.element("startup-message").textContent;
  p.tick();
  assert.notEqual(p.element("startup-message").textContent, first);
  finish({ok:true});
  await connecting;
  assert.equal(p.element("startup").hidden, true);
  assert.equal(p.element("settings").hidden, true);
  p.tick();
  assert.equal(p.element("startup").hidden, true, "animation timer must be cleared");
  assert.equal(calls, 2, "no background keepalive polling");
});

test("invalid access keys do not trigger startup retries", async () => {
  const p = panel(async () => ({ok:false,status:401}));
  p.element("token").value = "invalid";
  await p.element("connect").onclick();
  p.tick();
  assert.equal(p.requests.length, 1);
  assert.equal(p.element("startup").hidden, true);
  assert.equal(p.element("settings").hidden, false);
  assert.match(p.element("status").textContent, /Access key not accepted/);
});

test("anonymous usage counts opens once and insertion only after host confirmation", async () => {
  const p = panel();
  const installationId = '12345678-1234-4321-9876-123456789012';
  p.window.onmessage({data:{pluginMessage:{type:'connection',key:'saved-key',installationId}}});
  await new Promise(resolve=>setImmediate(resolve));
  const events=()=>p.requests.filter(r=>r.url.endsWith('/usage/events'));
  assert.equal(events().length,1);
  assert.equal(JSON.parse(events()[0].init.body).kind,'open');
  assert.equal(events()[0].init.headers['X-Taste-Installation'],installationId);
  await p.element('connect').onclick();
  assert.equal(events().length,1);
  p.window.onmessage({data:{pluginMessage:{type:'inserted',count:3}}});
  assert.equal(events().length,2);
  const inserted=JSON.parse(events()[1].init.body);
  assert.equal(inserted.kind,'insert');
  assert.equal(inserted.count,3);
  assert.deepEqual(Object.keys(inserted).sort(),['count','event_id','kind']);
});

test("usage network failure never prevents connection or exposes content", async () => {
  const p = panel(async url=>{
    if(url.endsWith('/usage/events'))throw new Error('offline');
    return {ok:true,json:async()=>({results:[]})};
  });
  p.window.onmessage({data:{pluginMessage:{type:'connection',key:'saved-key'}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.element('settings').hidden,true);
  const saved=p.connections.find(m=>m.pluginMessage.type==='save-installation');
  assert.match(saved.pluginMessage.id,/^[a-f0-9-]{36}$/);
  assert.equal(p.element('status').dataset.error,'false');
});


test("Figma sandbox without randomUUID can connect and search", async () => {
  const p = panel(undefined, {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)});
  assert.doesNotThrow(() => p.window.onmessage({data:{pluginMessage:{type:"connection",key:"saved-key"}}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.element("settings").hidden,true);
  const saved = p.connections.find(m=>m.pluginMessage.type==="save-installation");
  assert.match(saved.pluginMessage.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  select(p,"text"); p.tick();
  assert.equal(p.outgoing.at(-1).pluginMessage.type,"query");
  assert.doesNotThrow(() => p.window.onmessage({data:{pluginMessage:{type:"inserted",count:1}}}));
});

test("unavailable crypto only disables client counts, never plugin startup", async () => {
  for (const cryptoProvider of [null, {getRandomValues(){throw new Error("unavailable")}}]) {
    const p=panel(undefined,cryptoProvider);
    assert.doesNotThrow(() => p.window.onmessage({data:{pluginMessage:{type:"connection",key:""}}}));
    assert.equal(p.element("settings").hidden,false);
    p.element("token").value="test-key";
    await p.element("connect").onclick();
    assert.equal(p.element("settings").hidden,true);
    select(p,"image");p.tick();
    assert.equal(p.outgoing.at(-1).pluginMessage.type,"query");
    assert.equal(p.requests.filter(r=>r.url.endsWith("/usage/events")).length,0);
  }
});

test("more results append without re-encoding, keep selections, and ignore stale pages", async () => {
  let finishPage!: (value:any)=>void;
  let pages = 0;
  const p = panel(async url=>{
    if(url.endsWith('/health'))return {ok:true};
    if(url.endsWith('/search/text'))return {ok:true,json:async()=>({results:[{id:'a',name:'A',cluster:''}],next:{search_id:'query',offset:24}})};
    if(url.includes('/search/page')){
      pages++;
      if(pages===1)return {ok:true,json:async()=>({results:[{id:'b',name:'B',cluster:''}],next:{search_id:'query',offset:48}})};
      return new Promise(resolve=>{finishPage=resolve});
    }
    return {ok:true,blob:async()=>new Blob(['image'])};
  });
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  p.element('token').value='test-key';await p.element('connect').onclick();
  select(p,'text');p.tick();
  p.window.onmessage({data:{pluginMessage:{type:'query',requestId:1,query:{kind:'text',texts:['test']}}}});
  await flush();
  p.element('grid').children[0].children[1].children[0].onload();
  const first=p.checkboxes()[0]; first.checked=true;first.onchange();
  await p.element('more').onclick();await flush();
  assert.equal(p.checkboxes().length,2);
  assert.equal(first.checked,true);
  assert.equal(p.element('insert').disabled,false);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/search/text')).length,1);
  const loading=p.element('more').onclick();await flush();
  select(p,'image');
  finishPage({ok:true,json:async()=>({results:[{id:'stale',name:'stale'}],next:null})});
  await loading;
  assert.equal(p.checkboxes().length,0);
  assert.equal(p.element('more').hidden,true);
});

test("library view suppresses search and uploads a selection progressively", async () => {
  const p = panel(async (url, init) => ({ok: true, json: async () =>
    url.endsWith("/library/channels") ? {channels: []} : url.endsWith("/library/images") ? {added: true} : {count: 2}}));
  p.element("token").value = "test-access-key";
  await p.element("connect").onclick();
  p.element("library-tab").click();
  p.window.onmessage({data: {pluginMessage: {type: "selection", imageCount: 3, selection: {kind: "invalid", count: 3, label: "Multiple images"}}}});
  assert.equal(p.element("add-images").textContent, "Add 3 selected images to library");
  assert.equal(p.element("add-images").disabled, false);
  p.tick();
  assert.equal(p.outgoing.filter(m => m.pluginMessage.type === "query").length, 0);
  await p.element("add-images").onclick();
  assert.equal(p.outgoing.at(-1).pluginMessage.type, "upload-start");
  assert.equal(p.element("search-tab").disabled, true);
  p.window.onmessage({data: {pluginMessage: {type: "upload-started", total: 3}}});
  assert.equal(p.outgoing.at(-1).pluginMessage.type, "upload-next");
  p.window.onmessage({data: {pluginMessage: {type: "upload-image", index: 1, name: "Image", bytes: new Uint8Array([1])}}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.requests.filter(r => r.url.endsWith("/library/images")).length, 1);
  assert.equal(p.outgoing.at(-1).pluginMessage.type, "upload-next");
  p.window.onmessage({data: {pluginMessage: {type: "upload-image", index: 2, name: "Bad", error: "Could not export"}}});
  await new Promise(resolve => setImmediate(resolve));
  p.window.onmessage({data: {pluginMessage: {type: "upload-finished"}}});
  assert.match(p.element("upload-status").textContent, /1 added.*1 failed/);
  assert.equal(p.element("search-tab").disabled, false);
});

test("channel names link to Are.na and Sync now queues only that channel", async () => {
  let state = "synced";
  const p = panel(async (url, init) => {
    if (url.endsWith("/moods/sync")) state = "pending";
    return {ok: true, json: async () => url.endsWith("/library/channels") ? {channels: [{slug: "moods", title: "Moods", url: "https://www.are.na/sven/moods", state, last_synced: 100, added: 2}]} : {}};
  });
  p.element("token").value = "test-key";
  await p.element("connect").onclick();
  p.element("library-tab").click();
  await new Promise(resolve => setImmediate(resolve));
  let heading = p.element("channels").children[0].children[0];
  assert.equal(heading.children[0].href, "https://www.are.na/sven/moods");
  assert.equal(heading.children[0].target, "_blank");
  assert.equal(heading.children[1].textContent, "Sync now");
  await heading.children[1].onclick();
  assert.equal(p.requests.filter(r => r.url.endsWith('/moods/sync') && r.init.method === 'POST').length, 1);
  heading = p.element("channels").children[0].children[0];
  assert.equal(heading.children[1].textContent, "Queued…");
  assert.equal(heading.children[1].disabled, true);
});
