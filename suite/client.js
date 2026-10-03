(() => {
  'use strict';
  const CHANNEL='tqt-suite-ui-v1';
  const tool=document.currentScript.dataset.tool;
  const requests=new Map(), callbacks=new Map(), fileCache=new WeakMap();
  const storageListeners=new Set(),runtimeListeners=new Set();
  const request=(payload,kind='request')=>new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{requests.delete(id);reject(Object.assign(new Error('Chưa nhận kết quả từ extension. Kiểm tra tác vụ trước khi thử lại.'),{code:'SUITE_TIMEOUT'}));},65*60*1000);
    requests.set(id,{resolve,reject,timer});
    window.parent.postMessage({channel:CHANNEL,kind,id,tool,payload},location.origin);
  });
  function postNavigation(view) {window.parent.postMessage({channel:CHANNEL,kind:'navigate',tool,view},location.origin);}
  function errorFrom(value) {return Object.assign(new Error(value?.message || 'Extension báo lỗi.'),value);}
  window.addEventListener('message',event=>{
    if (event.source!==window.parent || event.origin!==location.origin || event.data?.channel!==CHANNEL) return;
    const m=event.data;
    if (m.kind==='response') {
      const entry=requests.get(m.id);if (!entry)return;requests.delete(m.id);clearTimeout(entry.timer);
      if (m.error) entry.reject(errorFrom(m.error));else entry.resolve(m.data);
    } else if (m.kind==='event') {
      const e=m.event;
      if (e.kind==='callback') {const cb=callbacks.get(e.callbackId);if (cb)cb(...e.args);}
      else if(e.kind==='storage' && e.tool===tool) {for(const cb of storageListeners)cb(e.changes,e.area);}
      else if(e.kind==='runtime' && e.tool===tool) {for(const cb of runtimeListeners)cb(e.message,{});}
    } else if (m.kind==='menu') {
      if (tool==='pages') document.querySelector('[data-panel="'+m.view+'"]')?.click();
      if (tool==='autocomment') {
        const map={composer:'[data-workspace-target="composer"]',templates:'[data-workspace-target="templates"]',queue:'[data-workspace-target="queue"]',records:'[data-workspace-target="records"]',api:'#openApiSettingsBtn',prompts:'#openAiPromptsBtn',settings:'#openWebSettingsBtn',backup:'[data-open-backup]'};
        document.querySelector(map[m.view]||'#openHomeBtn')?.click();
      }
      if (tool==='groups') {
        const map={groups:'.groups-panel',compose:'.campaign-panel',progress:'#progressText',logs:'#logList'};
        document.querySelector(map[m.view]||'.groups-panel')?.scrollIntoView({behavior:'smooth',block:'start'});
      }
    }
  });
  async function encodeFile(file) {
    let cached=fileCache.get(file);if(cached)return cached;
    const promise=(async()=>{
      const meta={name:file.name||'upload.bin',size:file.size,type:file.type,lastModified:file.lastModified};
      const begin=await request({kind:'fileBegin',meta});
      try {
        for(let offset=0;offset<file.size;offset+=begin.chunkBytes) {
          const bytes=new Uint8Array(await file.slice(offset,offset+begin.chunkBytes).arrayBuffer());
          let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));
          await request({kind:'fileChunk',id:begin.id,offset,data:btoa(text)});
        }
        await request({kind:'fileFinish',id:begin.id});
        return {__tqtFile:begin.id};
      } catch(error){request({kind:'fileDelete',id:begin.id}).catch(()=>{});throw error;}
    })();
    fileCache.set(file,promise);
    promise.catch(()=>fileCache.delete(file));return promise;
  }
  async function encode(value,cleanup,signals) {
    if (value instanceof Blob) return encodeFile(value);
    if (value instanceof AbortSignal) {signals.push(value);return {__tqtSignal:true};}
    if (typeof value==='function') {const id=crypto.randomUUID();callbacks.set(id,value);cleanup.push(id);return {__tqtCallback:id};}
    if (!value || typeof value!=='object') return value;
    if(Array.isArray(value))return Promise.all(value.map(v=>encode(v,cleanup,signals)));
    const output={};for(const [key,v] of Object.entries(value))output[key]=await encode(v,cleanup,signals);return output;
  }
  async function api(module,method,args,extra={}) {
    const callId=crypto.randomUUID(),cleanup=[],signals=[];
    const encoded=await encode(args,cleanup,signals);
    const cancel=()=>request({callId},'cancel').catch(()=>{});
    try {
      if(signals.some(s=>s.aborted))throw new DOMException('Đã hủy thao tác.','AbortError');
      for(const s of signals)s.addEventListener('abort',cancel,{once:true});
      const data=await request({kind:'api',module,method,args:encoded,callId,...extra});
      if(data?.__tqtError)throw errorFrom(data.__tqtError);return data;
    }finally{for(const id of cleanup)callbacks.delete(id);for(const s of signals)s.removeEventListener('abort',cancel);}
  }
  function eventSet(set) {return {addListener:cb=>set.add(cb),removeListener:cb=>set.delete(cb),hasListener:cb=>set.has(cb)};}
  const chromeFacade={runtime:{lastError:null,getURL:path=>new URL(path,location.href).href,onMessage:eventSet(runtimeListeners)},storage:{onChanged:eventSet(storageListeners)}};
  function operation(op,args,callback) {
    const promise=request({kind:'chrome',tool,op,args});
    if(callback)promise.then(value=>callback(value),error=>{chromeFacade.runtime.lastError={message:error.message};callback();chromeFacade.runtime.lastError=null;});
    return promise;
  }
  for(const ns of ['tabs','scripting','sidePanel'])chromeFacade[ns]={};
  for(const name of ['query','getCurrent','create','sendMessage','remove'])chromeFacade.tabs[name]=(...args)=>{
    const cb=typeof args.at(-1)==='function'?args.pop():null;return operation('tabs.'+name,args,cb);
  };
  for(const [ns,name] of [['scripting','executeScript'],['sidePanel','close']])chromeFacade[ns][name]=(...args)=>{
    const cb=typeof args.at(-1)==='function'?args.pop():null;return operation(ns+'.'+name,args,cb);
  };
  chromeFacade.storage.local={};
  for(const name of ['get','set','remove'])chromeFacade.storage.local[name]=(...args)=>{
    const cb=typeof args.at(-1)==='function'?args.pop():null;return operation('storage.local.'+name,args,cb);
  };
  chromeFacade.runtime.sendMessage=(message,callback)=>{
    const promise=request({kind:'tool',tool,message});
    if(callback)promise.then(value=>callback(value),error=>{chromeFacade.runtime.lastError={message:error.message};callback();chromeFacade.runtime.lastError=null;});
    return promise;
  };
  window.chrome=chromeFacade;
  window.TqtSuiteClient={api,request,navigate:postNavigation};
  window.addEventListener('pagehide',()=>{
    for(const entry of requests.values()){clearTimeout(entry.timer);entry.reject(new Error('Trang công cụ đã đóng.'));}
    requests.clear();callbacks.clear();
  });
})();
