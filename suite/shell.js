(() => {
  'use strict';
  const UI='tqt-suite-ui-v1',BRIDGE='tqt-autovip-bridge-v1';
  const $=id=>document.getElementById(id);
  const routes={
    auto:{tool:'autocomment',title:'Auto bình luận',src:'tools/autocomment/index.html',menu:[['home','Tổng quan'],['composer','Soạn bình luận'],['templates','Kho mẫu'],['queue','Hàng đợi'],['records','Kết quả'],['prompts','Prompt AI'],['api','Cài đặt API'],['settings','Cài đặt chạy'],['backup','Dữ liệu / Sao lưu']]},
    groups:{tool:'groups',title:'Đăng nhóm',src:'tools/groups/src/dashboard/index.html',menu:[['groups','Chọn nhóm'],['compose','Soạn bài'],['progress','Tiến trình'],['logs','Nhật ký']]},
    pages:{tool:'pages',title:'Page',src:'tools/pages/src/dashboard/index.html',menu:[['auth','Kết nối Page'],['settings','Nội dung'],['ai','Prompt AI'],['results','Tiến trình'],['activity','Hoạt động'],['statistics','Thống kê']]},
    'facebook-scan':{tool:'downloader',title:'Quét Facebook Reels',src:'tools/downloader/facebook/popup.html'},
    'facebook-results':{tool:'downloader',title:'Kho Facebook Reels',src:'tools/downloader/facebook/index.html'},
    'tiktok-scan':{tool:'downloader',title:'Quét TikTok',src:'tools/downloader/tiktok/sidepanel/sidepanel.html'},
    'tiktok-results':{tool:'downloader',title:'Kho video TikTok',src:'tools/downloader/tiktok/dashboard/index.html'}
  };
  const downloadMenu=[['facebook-scan','Quét Facebook'],['facebook-results','Kho Facebook Reels'],['tiktok-scan','Quét TikTok'],['tiktok-results','Kho video TikTok']];
  const frames=new Map(),callbackOwners=new Map();
  let current='home',licensed=false,currentLicense=null,checking;
  function notice(message) {$('suiteNotice').textContent=message;$('suiteNotice').hidden=!message;}
  function setHash(route){if(location.hash!== '#'+route)history.replaceState(null,'','#'+route);}
  function renderMenu(route){
    const def=routes[route];const list=$('toolMenu');list.replaceChildren();
    const menu=def?.tool==='downloader'?downloadMenu:def?.menu;
    list.hidden=!menu;
    for(const [id,label] of menu||[]) {
      const button=document.createElement('button');button.type='button';button.textContent=label;
      if(def.tool==='downloader' && route===id)button.classList.add('active');
      button.addEventListener('click',()=>{
        if(def.tool==='downloader')navigate(id);
        else{frames.get(route)?.contentWindow.postMessage({channel:UI,kind:'menu',view:id},location.origin);list.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b===button));}
        $('sidebar').classList.remove('open');
      });
      list.append(button);
    }
  }
  async function navigate(route) {
    if(route==='downloads')route='facebook-scan';
    if(!routes[route] && !['home','keys','guide'].includes(route))route='home';
    if(routes[route]) {
      const status=await window.TqtWebLicense.verify();
      if(!status.authorized){notice(status.message);await checkLicense();route='keys';}
      else if(!window.fbBridgeApi.getBridgeStatus().extensionVersion.startsWith('5.')){notice('Cập nhật extension CODE by TQT 5.0.0 để mở đủ bốn công cụ.');route='home';}
    }
    current=route;setHash(route);
    for(const name of ['home','keys','guide','tool'])$(name+'View').hidden=name!==(routes[route]?'tool':route);
    document.querySelectorAll('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route===route||b.dataset.route==='downloads'&&routes[route]?.tool==='downloader'));
    $('breadcrumbLabel').textContent=routes[route]?.title || {home:'Trang chủ',keys:'Quản lý KEY',guide:'Hướng dẫn sử dụng'}[route];
    renderMenu(route);
    for(const [id,frame]of frames)frame.hidden=id!==route;
    if(routes[route]) {
      $('toolTitle').textContent=routes[route].title;
      if(!frames.has(route)) {
        const iframe=document.createElement('iframe');iframe.className='tool-frame';iframe.title=routes[route].title;iframe.src=routes[route].src;
        iframe.allow='clipboard-read; clipboard-write';iframe.dataset.route=route;
        iframe.addEventListener('load',()=>{iframe.dataset.loaded='true';});
        frames.set(route,iframe);$('toolFrames').append(iframe);
      }
    }
    $('sidebar').classList.remove('open');
  }
  function renderConnection(){
    const state=window.fbBridgeApi.getBridgeStatus();
    $('connectionDot').classList.toggle('connected',state.connected&&licensed);
    $('connectionTitle').textContent=state.connected?(licensed?'Đã kết nối · KEY được duyệt':'Đã kết nối · Chờ quyền KEY'):'Chưa kết nối';
    $('connectionDescription').textContent=state.connected?(licensed?'Bốn công cụ đã sẵn sàng trên trình duyệt này.':currentLicense?.message||'Đang kiểm tra quyền KEY…'):'Kết nối extension để sử dụng các công cụ.';
    $('connectButton').textContent=state.connected?'Kiểm tra kết nối':'Kết nối extension';
    $('extensionStatus').textContent=state.connected?'Extension '+state.extensionVersion:'Extension · Chưa kết nối';
    $('licenseGate').hidden=licensed;
    $('memberKey').value=currentLicense?.machineKey || $('tqtMachineKeyInput').value;
    $('memberKeyStatus').textContent=currentLicense?.message || state.message;
    $('memberKeyExpiry').textContent=currentLicense?.expiresAt ? new Date(currentLicense.expiresAt).toLocaleString('vi-VN') : licensed?'Không giới hạn':'Chưa cấp quyền';
  }
  function renderLicense(data){
    currentLicense=data;licensed=data.authorized===true && window.fbBridgeApi.bridgeAvailable();
    document.documentElement.dataset.tqtLicenseAuthorized=String(licensed);
    if(data.machineKey)$('tqtMachineKeyInput').value=data.machineKey;
    $('tqtLicenseStatus').textContent=data.message||'Đang kiểm tra KEY…';
    $('tqtLicenseStatus').dataset.state=licensed?'ok':data.code?.includes('PENDING')?'waiting':'error';
    renderConnection();
    if(!licensed&&routes[current]){
      for(const frame of frames.values())frame.setAttribute('inert','');
      navigate('keys');
    }else if(licensed)for(const frame of frames.values())frame.removeAttribute('inert');
  }
  async function checkLicense(forceRefresh=false){
    if(checking)return checking;
    $('retryTqtLicenseBtn').disabled=true;
    checking=window.TqtWebLicense.verify({forceRefresh}).then(renderLicense).finally(()=>{checking=null;$('retryTqtLicenseBtn').disabled=false;});
    return checking;
  }
  const recognized=source=>[...frames].find(([,frame])=>frame.contentWindow===source);
  window.addEventListener('message',async event=>{
    if(event.origin!==location.origin)return;
    const entry=recognized(event.source);if(!entry)return;
    const [route,frame]=entry,m=event.data,tool=routes[route].tool;
    if(m?.channel===BRIDGE && m.direction==='web-to-extension' && m.protocolVersion===3){
      if(m.kind==='hello'){frame.contentWindow.postMessage({channel:BRIDGE,direction:'extension-to-web',kind:'status',protocolVersion:3,...window.fbBridgeApi.getBridgeStatus()},location.origin);return;}
      if(m.kind==='request'){
        let response;
        try{response=await window.fbBridgeApi.sendRawBridge(m.action,m.payload,{timeoutMs:65*60*1000});}
        catch(error){response={ok:false,code:error.code,error:error.message};}
        frame.contentWindow.postMessage({channel:BRIDGE,direction:'extension-to-web',kind:'response',protocolVersion:3,requestId:m.requestId,response},location.origin);
      }return;
    }
    if(m?.channel!==UI || m.tool!==tool)return;
    if(m.kind==='navigate'){navigate(m.view);return;}
    if(!['request','cancel'].includes(m.kind)||!/^[a-f0-9-]{36}$/.test(m.id||''))return;
    try{
      if(m.payload.kind==='api'){
        const allowed={groups:['groupsApi'],pages:['pagesApi','pagesAuth','pagesAi']}[tool]||[];
        if(!allowed.includes(m.payload.module))throw new Error('Lõi không thuộc công cụ này.');
        callbackOwners.set(m.payload.callId,frame);
      }
      const response=await window.fbBridgeApi.sendRawBridge(m.kind==='cancel'?'SUITE_CANCEL':'SUITE_RPC',{...m.payload,tool},{timeoutMs:65*60*1000});
      frame.contentWindow.postMessage({channel:UI,kind:'response',id:m.id,data:response.data},location.origin);
    }catch(error){frame.contentWindow.postMessage({channel:UI,kind:'response',id:m.id,error:{message:error.message,code:error.code}},location.origin);}
    finally{if(m.payload?.callId&&m.kind==='request')callbackOwners.delete(m.payload.callId);}
  });
  window.addEventListener('tqt:suite-event',event=>{
    const e=event.detail;
    if(e.kind==='navigate'){navigate(e.view);return;}
    if(e.kind==='callback'){callbackOwners.get(e.callId)?.contentWindow.postMessage({channel:UI,kind:'event',event:e},location.origin);return;}
    for(const frame of frames.values())frame.contentWindow.postMessage({channel:UI,kind:'event',event:e},location.origin);
  });
  window.addEventListener('autovip:bridge-status',event=>{
    renderConnection();checkLicense();
    for(const frame of frames.values())frame.contentWindow.postMessage({channel:BRIDGE,direction:'extension-to-web',kind:'status',protocolVersion:3,...event.detail},location.origin);
  });
  window.addEventListener('tqt:license-status',event=>renderLicense(event.detail));
  document.querySelectorAll('[data-route]').forEach(b=>b.addEventListener('click',()=>{notice('');navigate(b.dataset.route);}));
  $('mobileMenu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  $('connectButton').addEventListener('click',()=>{window.fbBridgeApi.reconnect();checkLicense(true);});
  $('retryTqtLicenseBtn').addEventListener('click',()=>checkLicense(true));
  $('memberKeyRefresh').addEventListener('click',()=>checkLicense(true));
  for(const [button,input]of [['copyTqtMachineKeyBtn','tqtMachineKeyInput'],['memberKeyCopy','memberKey']])$(button).addEventListener('click',async()=>{
    if(!/^TQT-[A-F0-9]{27}$/.test($(input).value))return;
    try{await navigator.clipboard.writeText($(input).value);$(button).textContent='Đã copy';}
    catch{$(input).focus();$(input).select();document.execCommand('copy');}
  });
  $('toolsShortcut').addEventListener('click',()=>{navigate('home');$('toolCatalog').scrollIntoView({behavior:'smooth'});});
  $('guideShortcut').addEventListener('click',()=>navigate('guide'));
  $('openSettings').addEventListener('click',async()=>{
    await navigate('auto');if(current!=='auto')return;
    const frame=frames.get('auto');
    const open=()=>frame.contentWindow.postMessage({channel:UI,kind:'menu',view:'api'},location.origin);
    if(frame.dataset.loaded==='true')open();else frame.addEventListener('load',open,{once:true});
  });
  window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
  setInterval(()=>{if(!document.hidden)checkLicense();},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkLicense();});
  navigate(location.hash.slice(1)||'home');checkLicense();
})();
