import { parseExif as parseExifMetadata } from './media-metadata.js'

const app = document.getElementById('app')
const MAX_UPLOAD = 48 * 1024 * 1024
const FULL_VIEW = 20 * 1024 * 1024
const state = { token: localStorage.getItem('pc_token') || '', user: null, page: 'home', photoMode: 'timeline', trashMode: 'files', photos: [], files: [], albums: [], places: [], queue: [], online: navigator.onLine, viewer: null }
let schedulerRunning = false
let schedulerTimer = null
const activeUploads = new Map()
const activeHashes = new Set()
const cardPreviewUrls = new Map()

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])) }
function fmtDate(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN') }
function fmtSize(bytes) { if (!Number.isFinite(bytes)) return '—'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024**2) return `${(bytes/1024).toFixed(1)} KB`; return `${(bytes/1024**2).toFixed(1)} MB` }
function isMobile() { return matchMedia('(max-width: 760px)').matches }
function weakConnection() { const c = navigator.connection; return Boolean(c?.saveData || ['slow-2g','2g'].includes(c?.effectiveType) || (c?.downlink && c.downlink < 1.5)) }

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (state.token) headers.set('authorization', `Bearer ${state.token}`)
  const response = await fetch(path, { ...options, headers })
  if (response.status === 401 && path !== '/auth/login') { logout(false); throw new Error('登录已失效') }
  const type = response.headers.get('content-type') || ''
  const payload = type.includes('application/json') ? await response.json() : response
  if (!response.ok) {
    const error = new Error(payload?.error?.code || payload?.error || `HTTP_${response.status}`)
    error.status = response.status
    error.retryAfter = Number(response.headers.get('retry-after') || 0)
    throw error
  }
  return payload
}

function loginView(error = '') {
  app.innerHTML = `<main class="login-shell"><form id="login" class="login-card"><h1>Personal Cloud</h1><p>文件与照片使用同一 SaaS 账号。</p><label>用户名<input name="username" autocomplete="username" required minlength="3"></label><label>密码<input name="password" type="password" autocomplete="current-password" required minlength="12"></label>${error ? `<p class="error">${esc(error)}</p>` : ''}<button class="primary" type="submit">登录</button></form></main>`
  document.getElementById('login').onsubmit = async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      const result = await api('/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ username:data.get('username'), password:data.get('password') }) })
      state.token = result.token; state.user = result.user; localStorage.setItem('pc_token', state.token); await boot()
    } catch (error) { loginView(error.message) }
  }
}

function logout(callApi = true) {
  if (callApi && state.token) void api('/auth/logout', { method:'POST' }).catch(()=>{})
  state.token = ''; state.user = null; localStorage.removeItem('pc_token'); loginView()
}

function releaseCardPreviews() { for (const url of cardPreviewUrls.values()) URL.revokeObjectURL(url); cardPreviewUrls.clear() }

function shell(content) {
  releaseCardPreviews()
  const nav = [['home','首页'],['files','文件'],['photos','照片'],['trash','回收站'],['settings','设置']]
  app.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand">Personal Cloud</div><nav class="nav">${nav.map(([id,label])=>`<button data-page="${id}" class="${state.page===id?'active':''}">${label}</button>`).join('')}</nav></aside><main class="main"><header class="topbar"><strong>${nav.find(([id])=>id===state.page)?.[1]||'Personal Cloud'}</strong><div><span class="muted">${esc(state.user?.username || '')}</span> <button id="logout" class="secondary">退出</button></div></header><section class="content">${content}</section></main></div>`
  document.querySelectorAll('[data-page]').forEach((button)=>button.onclick=()=>{ state.page=button.dataset.page; void renderPage() })
  document.getElementById('logout').onclick=()=>logout()
}

async function boot() {
  if (!state.token) return loginView()
  try {
    const settings = await api('/settings')
    state.user = state.user || { username: settings.username || '' }
  } catch (error) { if (!state.token) return; state.user = state.user || { username:'已登录' } }
  await loadQueue(); void wakeScheduler('boot'); await renderPage()
}

async function renderPage() {
  try {
    if (state.page === 'home') return renderHome()
    if (state.page === 'files') return renderFiles()
    if (state.page === 'photos') return renderPhotos()
    if (state.page === 'trash') return renderTrash()
    if (state.page === 'settings') return renderSettings()
  } catch (error) { shell(`<p class="error">${esc(error.message)}</p>`) }
}

async function renderHome() {
  const [files, photos, status] = await Promise.all([api('/files/list'), api('/photos?limit=12'), api('/storage/status')])
  const fileItems = files.files || files.items || []
  const photoItems = photos.items || []
  const profiles = status.profiles || []
  shell(`<div class="page-head"><div><h2>个人云</h2><p class="muted">Files Engine 与 Photos Engine 共用账号，数据域与去重语义独立。</p></div></div><div class="settings-grid"><div class="settings-card"><strong>文件</strong><p>${fileItems.length} 个当前条目</p></div><div class="settings-card"><strong>照片</strong><p>${photoItems.length} 个最近条目</p></div>${profiles.map(p=>`<div class="settings-card"><strong>${p.purpose==='files'?'文件存储':'照片存储'}</strong><p><i class="status-dot ${p.reachable?'up':'down'}"></i>${p.reachable?'正常':p.configured?'不可达':'未连接'}</p></div>`).join('')}${status.legacyPhotoBridgeConfigured?'<div class="settings-card"><strong>历史照片兼容</strong><p><i class="status-dot up"></i>旧 Telegram 原件可通过内部只读桥访问</p></div>':''}</div>`)
}

async function renderFiles() {
  const data = await api('/files/list')
  state.files = data.files || data.items || []
  shell(`<div class="page-head"><div><h2>文件</h2><p class="muted">保留 logical file + version + hash + base_version 语义；相同 Hash 的不同路径不会合并。</p></div></div><div class="table-wrap"><table><thead><tr><th>路径</th><th>版本</th><th>状态</th><th>更新时间</th></tr></thead><tbody>${state.files.map(f=>`<tr><td>${esc(f.relative_path || f.relativePath || f.logical_name || f.logicalName)}</td><td>V${f.current_version ?? f.currentVersion ?? 0}</td><td>${esc(f.status)}</td><td>${fmtDate(f.updated_at || f.updatedAt)}</td></tr>`).join('') || '<tr><td colspan="4">暂无文件</td></tr>'}</tbody></table></div>`)
}

function photoCard(item) {
  const canOpen = item.status === 'ready' && (item.sizeBytes <= FULL_VIEW || item.previewAvailable)
  return `<article class="photo-card" data-photo="${item.id}"><div class="photo-thumb" data-photo-preview="${item.id}"><span>${item.mediaType==='video'?'视频':'照片'}${canOpen?' · 点击查看':item.sizeTier==='preview-only'?' · 原件仅 Telegram 可取':' · 暂不可查看'}</span></div><div class="photo-meta"><strong>${esc(item.originalName)}</strong><span>${fmtDate(item.takenAt)} · ${esc(item.takenAtSource)}</span></div><div class="card-actions"><button class="secondary" data-fav="${item.id}" data-value="${item.favorite?'0':'1'}">${item.favorite?'取消收藏':'收藏'}</button><button class="danger" data-trash="${item.id}">回收站</button></div></article>`
}

async function loadCardPreview(node) {
  const id = node.dataset.photoPreview
  if (!id || cardPreviewUrls.has(id)) return
  try {
    const response = await fetch(`/photos/${id}/preview`, { headers: { authorization: `Bearer ${state.token}` } })
    if (!response.ok) return
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    cardPreviewUrls.set(id, url)
    const item = state.photos.find((photo) => photo.id === id)
    node.innerHTML = `<img alt="${esc(item?.originalName || '照片预览')}" src="${url}">`
  } catch {}
}

function hydratePhotoPreviews() {
  const nodes = [...document.querySelectorAll('[data-photo-preview]')]
  if (!('IntersectionObserver' in window)) { nodes.forEach((node) => void loadCardPreview(node)); return }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); void loadCardPreview(entry.target) }
  }, { rootMargin: '240px' })
  nodes.forEach((node) => observer.observe(node))
}

async function renderPhotos() {
  const storageStatus = await api('/storage/status')
  const photoProfile = (storageStatus.profiles || []).find((profile) => profile.purpose === 'photos')
  const uploadReady = Boolean(photoProfile?.configured)
  const q = state.photoQuery || ''
  const params = new URLSearchParams({ limit:'120' })
  if (state.photoMode === 'favorites') params.set('favorite','true')
  if (q) params.set('q',q)
  if (state.photoPlaceId && state.photoMode === 'timeline') params.set('placeId', state.photoPlaceId)
  if (state.photoMode === 'timeline' || state.photoMode === 'favorites') state.photos = (await api(`/photos?${params}`)).items || []
  if (state.photoMode === 'albums') state.albums = (await api('/photos/albums')).items || []
  if (state.photoMode === 'places') state.places = (await api('/photos/places')).items || []
  const modes = [['timeline','时间线'],['albums','相册'],['favorites','收藏'],['places','地点']]
  let body = ''
  if (['timeline','favorites'].includes(state.photoMode)) body = `<div class="photo-grid">${state.photos.map(photoCard).join('') || '<p class="muted">暂无照片。</p>'}</div>`
  if (state.photoMode === 'albums') body = `<div class="album-list">${state.albums.map(a=>`<div class="simple-card"><strong>${esc(a.name)}</strong><p class="muted">${a.asset_count ?? 0} 项</p></div>`).join('') || '<p class="muted">暂无相册。</p>'}</div><form id="new-album" class="toolbar" style="margin-top:14px"><input name="name" placeholder="新相册名称" required maxlength="120"><button class="secondary">创建相册</button></form>`
  if (state.photoMode === 'places') body = `<div class="place-list">${state.places.map(p=>`<button class="simple-card" data-place="${p.id}"><strong>${esc(p.label)}</strong><p class="muted">${p.asset_count ?? 0} 项</p></button>`).join('') || '<p class="muted">暂无带 GPS 的照片。</p>'}</div>`
  shell(`<div class="page-head"><div><h2>照片</h2><p class="muted">时间线按 taken_at 排序，不使用 Telegram message date 覆盖拍摄时间。</p></div></div><div class="upload-panel">${uploadReady?'':`<div class="notice"><strong>历史照片已可查看。</strong><br>新增照片上传尚未连接照片专用 Telegram 存储；在直接存储配置完成前不会创建失败资产。</div>`}<div class="upload-pickers"><label class="primary">从系统相册选择照片<input id="photo-picker" type="file" multiple accept="image/*" ${uploadReady?'':'disabled'}></label><label class="secondary">单独选择视频<input id="video-picker" type="file" multiple accept="video/*" ${uploadReady?'':'disabled'}></label></div><p class="muted">≤20 MB 可完整查看；20–48 MB 可保存原件但网页读取受 Telegram Bot 限制；&gt;48 MB 拒绝。原件会先持久化到 OPFS，失败时回退 IndexedDB。</p><div id="queue-root">${queueMarkup()}</div></div><div class="tabs">${modes.map(([id,label])=>`<button data-mode="${id}" class="${state.photoMode===id?'active':''}">${label}</button>`).join('')}</div>${['timeline','favorites'].includes(state.photoMode)?`<div class="toolbar" style="margin-bottom:14px"><input id="photo-search" type="search" value="${esc(q)}" placeholder="搜索文件名或标签"><button id="search-btn" class="secondary">搜索</button></div>`:''}${body}${state.viewer?viewerMarkup(state.viewer):''}`)
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{state.photoMode=b.dataset.mode; if(state.photoMode!=='timeline') state.photoPlaceId=''; void renderPhotos()})
  const p = document.getElementById('photo-picker'); if (p) p.onchange=(e)=>{void importFiles([...e.target.files]); e.target.value=''}
  const v = document.getElementById('video-picker'); if (v) v.onchange=(e)=>{void importFiles([...e.target.files]); e.target.value=''}
  const search = document.getElementById('search-btn'); if (search) search.onclick=()=>{state.photoQuery=document.getElementById('photo-search').value; void renderPhotos()}
  bindPhotoActions()
  bindQueueActions()
  hydratePhotoPreviews()
  const albumForm = document.getElementById('new-album'); if (albumForm) albumForm.onsubmit=async(e)=>{e.preventDefault();const name=new FormData(albumForm).get('name');await api('/photos/albums',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});void renderPhotos()}
  document.querySelectorAll('[data-place]').forEach(b=>b.onclick=()=>{state.photoPlaceId=b.dataset.place;state.photoMode='timeline';void renderPhotos()})
  if (state.viewer) bindViewer()
}

function bindPhotoActions() {
  document.querySelectorAll('[data-fav]').forEach(b=>b.onclick=async(e)=>{e.stopPropagation();await api(`/photos/${b.dataset.fav}/favorite`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({favorite:b.dataset.value==='1'})});void renderPhotos()})
  document.querySelectorAll('[data-trash]').forEach(b=>b.onclick=async(e)=>{e.stopPropagation();await api(`/photos/${b.dataset.trash}/trash`,{method:'POST'});void renderPhotos()})
  document.querySelectorAll('[data-photo]').forEach(card=>card.onclick=(e)=>{if(e.target.closest('button'))return; const item=state.photos.find(p=>p.id===card.dataset.photo); if(item){state.viewer=item;void renderPhotos()}})
}

function viewerMarkup(item) { const canOriginal=item.sizeBytes<=FULL_VIEW; const canPreview=Boolean(item.previewAvailable); const message=canOriginal?'正在安全读取原件…':canPreview?'原件超过网页读取上限，正在读取 Telegram 预览…':'原件已保存到 Telegram；当前 Bot 下载能力不支持网页直接读取该大小。'; return `<div class="viewer" id="viewer"><div class="viewer-card"><div class="viewer-media" id="viewer-media"><p style="color:white">${message}</p></div><div class="viewer-info"><div class="page-head"><div><strong>${esc(item.originalName)}</strong><p class="muted">拍摄：${fmtDate(item.takenAt)} · 来源 ${esc(item.takenAtSource)} · 上传 ${fmtDate(item.uploadedAt)}</p></div><button id="close-viewer" class="secondary">关闭</button></div></div></div></div>` }
async function loadViewerMedia(item){const canOriginal=item.sizeBytes<=FULL_VIEW;if(!canOriginal&&!item.previewAvailable)return;const root=document.getElementById('viewer-media');if(!root)return;try{const path=canOriginal?`/photos/${item.id}/media`:`/photos/${item.id}/preview`;const response=await fetch(path,{headers:{authorization:`Bearer ${state.token}`}});if(!response.ok)throw new Error(`HTTP_${response.status}`);const blob=await response.blob();const url=URL.createObjectURL(blob);state.viewerObjectUrl=url;root.innerHTML=canOriginal&&item.mediaType==='video'?`<video controls autoplay playsinline src="${url}"></video>`:`<img alt="${esc(item.originalName)}" src="${url}">`}catch(error){root.innerHTML=`<p style="color:white">无法读取${canOriginal?'原件':'预览'}：${esc(error.message)}</p>`}}
function releaseViewerUrl(){if(state.viewerObjectUrl){URL.revokeObjectURL(state.viewerObjectUrl);state.viewerObjectUrl=''}}
function bindViewer(){void loadViewerMedia(state.viewer);document.getElementById('close-viewer').onclick=()=>{releaseViewerUrl();state.viewer=null;void renderPhotos()};document.getElementById('viewer').onclick=(e)=>{if(e.target.id==='viewer'){releaseViewerUrl();state.viewer=null;void renderPhotos()}}}

async function renderTrash() {
  const fileTrash = state.trashMode==='files' ? await api('/files/trash') : null
  const photoTrash = state.trashMode==='photos' ? await api('/photos/trash') : null
  let body=''
  if(state.trashMode==='files'){const items=fileTrash?.files||fileTrash?.items||[];body=`<div class="table-wrap"><table><thead><tr><th>文件</th><th>版本</th><th>删除时间</th></tr></thead><tbody>${items.map(f=>`<tr><td>${esc(f.relative_path||f.logical_name||f.logicalName)}</td><td>V${f.current_version??f.currentVersion??0}</td><td>${fmtDate(f.trashed_at||f.trashedAt)}</td></tr>`).join('')||'<tr><td colspan="3">文件回收站为空</td></tr>'}</tbody></table></div>`}
  else {const items=photoTrash?.items||[];body=`<div class="photo-grid">${items.map(i=>`${photoCard(i)}<button class="secondary" data-restore-photo="${i.id}">恢复</button>`).join('')||'<p>照片回收站为空</p>'}</div>`}
  shell(`<div class="page-head"><div><h2>回收站</h2><p class="muted">统一入口，底层仍分别执行 file trash 与 photo trash。</p></div></div><div class="tabs"><button data-trash-mode="files" class="${state.trashMode==='files'?'active':''}">文件</button><button data-trash-mode="photos" class="${state.trashMode==='photos'?'active':''}">照片</button></div>${body}`)
  document.querySelectorAll('[data-trash-mode]').forEach(b=>b.onclick=()=>{state.trashMode=b.dataset.trashMode;void renderTrash()})
  document.querySelectorAll('[data-restore-photo]').forEach(b=>b.onclick=async()=>{await api(`/photos/${b.dataset.restorePhoto}/restore`,{method:'POST'});void renderTrash()})
}

async function renderSettings() {
  const status = await api('/storage/status'); const profiles=status.profiles||[]
  shell(`<div class="page-head"><div><h2>设置</h2><p class="muted">普通界面只显示抽象存储状态，不显示 Bot Token、Chat ID 或 Telegram message id。</p></div></div><div class="settings-grid">${profiles.map(p=>`<div class="settings-card"><strong>${p.purpose==='files'?'文件存储':'照片存储'}</strong><p><i class="status-dot ${p.reachable?'up':'down'}"></i>${p.reachable?'正常':p.configured?'已配置但不可达':'未连接'}</p>${p.profile==='photos-private'&&p.configured&&!p.reachable?'<button id="pair-photos" class="secondary">重新连接照片 Telegram</button>':p.profile==='photos-private'&&!p.configured?'<p class="muted">新增上传需要管理员先配置照片专用存储凭据。</p>':''}</div>`).join('')}${status.legacyPhotoBridgeConfigured?'<div class="settings-card"><strong>历史照片兼容桥</strong><p><i class="status-dot up"></i>已启用，只读访问旧 Telegram 原件</p></div>':''}</div><div id="pair-result" style="margin-top:12px"></div>`)
  const pair=document.getElementById('pair-photos');if(pair)pair.onclick=async()=>{const result=await api('/storage/photos/pair/start',{method:'POST'});document.getElementById('pair-result').innerHTML=`<div class="notice"><p>请在照片专用 Telegram Bot 中完成 Start。</p><p><a target="_blank" rel="noreferrer" href="${esc(result.deepLink)}">打开 Telegram</a></p><button id="confirm-pair" class="primary">我已完成，确认连接</button></div>`;document.getElementById('confirm-pair').onclick=async()=>{await api('/storage/photos/pair/confirm',{method:'POST'});void renderSettings()}}
}

// ---- Durable mobile upload queue ----
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open('personal-cloud-offline',1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('jobs'))db.createObjectStore('jobs',{keyPath:'id'});if(!db.objectStoreNames.contains('payloads'))db.createObjectStore('payloads',{keyPath:'id'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function idbGet(store,key){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store);const req=tx.objectStore(store).get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function idbPut(store,value){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}
async function idbDelete(store,key){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}
async function idbAll(store){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store);const req=tx.objectStore(store).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}

function appleMobile(){const ua=navigator.userAgent||'';return /iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)}
async function persistOriginal(id,file){
  if(!appleMobile()&&navigator.storage?.getDirectory){try{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle('personal-cloud-uploads',{create:true});const handle=await dir.getFileHandle(`${id}.upload`,{create:true});const writable=await handle.createWritable();await writable.write(file);await writable.close();return {kind:'opfs',path:`${id}.upload`}}catch{}}
  await idbPut('payloads',{id,blob:file});return {kind:'idb'}
}
async function getOriginal(job){if(job.payloadKind==='opfs'){try{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle('personal-cloud-uploads');return await (await dir.getFileHandle(job.opfsPath)).getFile()}catch{}}const row=await idbGet('payloads',job.id);return row?.blob||null}
async function releaseOriginal(job){if(job.payloadKind==='opfs'){try{const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle('personal-cloud-uploads');await dir.removeEntry(job.opfsPath)}catch{}}await idbDelete('payloads',job.id).catch(()=>{})}
async function saveJob(job){job.updatedAt=new Date().toISOString();await idbPut('jobs',job);await loadQueue();refreshQueue()}
async function loadQueue(){state.queue=(await idbAll('jobs')).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));return state.queue}

async function importFiles(files){
  if(!files.length)return;try{await navigator.storage?.persist?.()}catch{}
  const batchId=crypto.randomUUID();const windowSize=isMobile()?8:24
  for(let start=0;start<files.length;start+=windowSize){for(const file of files.slice(start,start+windowSize)){
    if(file.size>MAX_UPLOAD){alert(`${file.name} 超过 48 MB，已拒绝。`);continue}
    const id=crypto.randomUUID();const payload=await persistOriginal(id,file);const job={id,batchId,fileName:file.name,mimeType:file.type||'application/octet-stream',sizeBytes:file.size,mediaType:file.type.startsWith('video/')?'video':'photo',status:navigator.onLine?'waiting':'paused',controlState:'active',stage:'registered',progress:0,attempts:0,payloadKind:payload.kind,opfsPath:payload.path,lastModified:file.lastModified||0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await idbPut('jobs',job)
  }await loadQueue();refreshQueue();void wakeScheduler('import');await new Promise(r=>setTimeout(r,0))}
}

function queueMarkup(){const jobs=state.queue.filter(j=>j.status!=='done'||Date.now()-Date.parse(j.updatedAt)<86400000);if(!jobs.length)return '<p class="muted">暂无上传任务。</p>';return `<div class="queue">${jobs.map(j=>`<div class="queue-item"><div class="queue-row"><div><strong>${esc(j.fileName)}</strong><div class="muted">${esc(j.error||stageLabel(j))}</div></div><div>${j.progress||0}%</div></div><div class="progress"><i style="width:${j.progress||0}%"></i></div><div class="toolbar">${j.controlState==='paused'||j.status==='failed'?`<button class="secondary" data-resume-job="${j.id}">继续</button>`:j.status!=='done'?`<button class="secondary" data-pause-job="${j.id}">暂停</button>`:''}${j.status!=='done'?`<button class="danger" data-cancel-job="${j.id}">取消</button>`:''}</div></div>`).join('')}</div>`}
function stageLabel(j){return ({registered:'等待准备',preparing:'读取 EXIF / SHA-256',reserving:'精确去重',original:'保存 Telegram 原件',completed:j.deduplicated?'已精确去重':'已完成'})[j.stage]||j.status}
function refreshQueue(){const root=document.getElementById('queue-root');if(root){root.innerHTML=queueMarkup();bindQueueActions()}}
function bindQueueActions(){document.querySelectorAll('[data-pause-job]').forEach(b=>b.onclick=async()=>{const j=await idbGet('jobs',b.dataset.pauseJob);if(j){j.controlState='paused';j.status='paused';j.error='已暂停，原件仍保存在本机。';activeUploads.get(j.id)?.abort();await saveJob(j)}});document.querySelectorAll('[data-resume-job]').forEach(b=>b.onclick=async()=>{const j=await idbGet('jobs',b.dataset.resumeJob);if(j){j.controlState='active';j.status='retrying';j.nextAttemptAt=null;j.error='';await saveJob(j);void wakeScheduler('resume')}});document.querySelectorAll('[data-cancel-job]').forEach(b=>b.onclick=async()=>{const j=await idbGet('jobs',b.dataset.cancelJob);if(j){activeUploads.get(j.id)?.abort();j.controlState='canceled';j.status='failed';j.error='已取消，本机临时原件已释放。';await releaseOriginal(j);await saveJob(j)}})}

function toHex(bytes){return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function sha256(file){return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())))}
function exifDateToIso(value){if(!value)return null;const m=String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);if(!m)return null;const d=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);return Number.isNaN(d.getTime())?null:d.toISOString()}
async function parseExif(file){
  const name=(file.name||'').toLowerCase(),type=(file.type||'').toLowerCase()
  try{if(type.includes('heic')||type.includes('heif')||type.includes('avif')||/\.(heic|heif|avif)$/.test(name))return await parseHeifExif(file)}catch{}
  try{if(/jpe?g/.test(type)||/\.jpe?g$/.test(name))return await parseJpegExif(file)}catch{}
  return {}
}
async function parseJpegExif(file){
  const buf=await file.slice(0,Math.min(file.size,2*1024*1024)).arrayBuffer();const v=new DataView(buf);if(v.byteLength<4||v.getUint16(0)!==0xffd8)return{};let off=2
  while(off+4<v.byteLength){if(v.getUint8(off)!==0xff){off++;continue}const marker=v.getUint8(off+1);if(marker===0xda||marker===0xd9)break;const len=v.getUint16(off+2);if(len<2)break;if(marker===0xe1&&off+2+len<=v.byteLength){if(off+10<=v.byteLength&&String.fromCharCode(...new Uint8Array(buf,off+4,4))==='Exif')return parseTiff(v,off+10)}off+=2+len}
  return {}
}
function isoBox(v,offset){
  if(offset<0||offset+8>v.byteLength)return null
  let length=v.getUint32(offset,false),header=8;const type=String.fromCharCode(v.getUint8(offset+4),v.getUint8(offset+5),v.getUint8(offset+6),v.getUint8(offset+7))
  if(length===1){if(offset+16>v.byteLength)return null;const high=v.getUint32(offset+8,false),low=v.getUint32(offset+12,false);if(high>0x1fffff)return null;length=high*2**32+low;header=16}
  if(length===0)length=v.byteLength-offset
  if(length<header||offset+length>v.byteLength)return null
  return{type,offset,start:offset+header,end:offset+length,length,header}
}
function findIsoBox(v,start,end,type){let p=start;while(p+8<=end&&p+8<=v.byteLength){const box=isoBox(v,p);if(!box||box.end>end)return null;if(box.type===type)return box;p=box.end}return null}
function readSized(v,offset,size){if(size===0)return 0;if(size<0||size>8||offset+size>v.byteLength)return null;let value=0;for(let i=0;i<size;i++)value=value*256+v.getUint8(offset+i);return Number.isSafeInteger(value)?value:null}
function findHeifExifItemId(v,iinf){
  let p=iinf.start;if(p+6>iinf.end)return null;const version=v.getUint8(p);p+=4;const count=version===0?v.getUint16(p,false):v.getUint32(p,false);p+=version===0?2:4
  for(let i=0;i<count&&p+8<=iinf.end;i++){const infe=isoBox(v,p);if(!infe||infe.end>iinf.end)break;if(infe.type==='infe'&&infe.start+8<=infe.end){const infeVersion=v.getUint8(infe.start);let q=infe.start+4;let id;if(infeVersion>=3){if(q+4>infe.end)return null;id=v.getUint32(q,false);q+=4}else{if(q+2>infe.end)return null;id=v.getUint16(q,false);q+=2}q+=2;if(infeVersion>=2&&q+4<=infe.end){const itemType=String.fromCharCode(v.getUint8(q),v.getUint8(q+1),v.getUint8(q+2),v.getUint8(q+3));if(itemType==='Exif')return id}}p=infe.end}
  return null
}
function findHeifExtent(v,iloc,itemId){
  let p=iloc.start;if(p+8>iloc.end)return null;const version=v.getUint8(p);p+=4;const a=v.getUint8(p++),b=v.getUint8(p++),offsetSize=a>>4,lengthSize=a&15,baseOffsetSize=b>>4,indexSize=(version===1||version===2)?b&15:0
  const itemCount=version<2?v.getUint16(p,false):v.getUint32(p,false);p+=version<2?2:4
  for(let i=0;i<itemCount;i++){
    if(p>=iloc.end)return null;const id=version<2?v.getUint16(p,false):v.getUint32(p,false);p+=version<2?2:4
    if(version===1||version===2){if(p+2>iloc.end)return null;p+=2}
    if(p+2>iloc.end)return null;p+=2
    const baseOffset=readSized(v,p,baseOffsetSize);if(baseOffset===null)return null;p+=baseOffsetSize
    if(p+2>iloc.end)return null;const extentCount=v.getUint16(p,false);p+=2
    for(let j=0;j<extentCount;j++){
      if(indexSize){if(readSized(v,p,indexSize)===null)return null;p+=indexSize}
      const extentOffset=readSized(v,p,offsetSize);if(extentOffset===null)return null;p+=offsetSize
      const extentLength=readSized(v,p,lengthSize);if(extentLength===null)return null;p+=lengthSize
      if(id===itemId&&extentLength>0)return{offset:baseOffset+extentOffset,length:extentLength}
    }
  }
  return null
}
async function parseHeifExif(file){
  let headSize=Math.min(file.size,4*1024*1024),buf=await file.slice(0,headSize).arrayBuffer(),v=new DataView(buf),meta=null,p=0
  while(p+8<=v.byteLength){const box=isoBox(v,p);if(!box)break;if(box.type==='meta'){meta=box;break}p=box.end}
  if(!meta&&headSize<file.size){headSize=Math.min(file.size,8*1024*1024);buf=await file.slice(0,headSize).arrayBuffer();v=new DataView(buf);p=0;while(p+8<=v.byteLength){const box=isoBox(v,p);if(!box)break;if(box.type==='meta'){meta=box;break}p=box.end}}
  if(!meta||meta.start+4>=meta.end)return{}
  const childStart=meta.start+4,iinf=findIsoBox(v,childStart,meta.end,'iinf'),iloc=findIsoBox(v,childStart,meta.end,'iloc');if(!iinf||!iloc)return{}
  const itemId=findHeifExifItemId(v,iinf);if(itemId===null)return{};const extent=findHeifExtent(v,iloc,itemId);if(!extent||extent.offset<0||extent.length<=8||extent.offset+extent.length>file.size)return{}
  const exifBuffer=await file.slice(extent.offset,extent.offset+extent.length).arrayBuffer();const exifView=new DataView(exifBuffer);if(exifView.byteLength<8)return{}
  const tiffBase=4+exifView.getUint32(0,false);if(tiffBase+8>exifView.byteLength)return{};return parseTiff(exifView,tiffBase)
}
function parseTiff(v,base){try{if(base<0||base+8>v.byteLength)return{};const marker=v.getUint16(base,false);if(marker!==0x4949&&marker!==0x4d4d)return{};const le=marker===0x4949;const u16=o=>v.getUint16(o,le),u32=o=>v.getUint32(o,le);const ifd0=base+u32(base+4);if(ifd0<base||ifd0+2>v.byteLength)return{};let exifPtr=0,gpsPtr=0;const scan=(pos,cb)=>{if(pos<base||pos+2>v.byteLength)return;const n=u16(pos);for(let i=0;i<n;i++){const e=pos+2+i*12;if(e+12>v.byteLength)break;cb(u16(e),u16(e+2),u32(e+4),e+8)}};scan(ifd0,(tag,type,count,data)=>{void type;void count;if(tag===0x8769)exifPtr=base+u32(data);if(tag===0x8825)gpsPtr=base+u32(data)});const out={};const readAscii=(type,count,data)=>{if(type!==2)return'';const start=count<=4?data:base+u32(data);if(start<0||start>=v.byteLength)return'';let s='';for(let i=0;i<count&&start+i<v.byteLength;i++){const c=v.getUint8(start+i);if(!c)break;s+=String.fromCharCode(c)}return s};if(exifPtr)scan(exifPtr,(tag,type,count,data)=>{if(tag===0x9003)out.dateTimeOriginal=exifDateToIso(readAscii(type,count,data));if(tag===0x9004)out.createDate=exifDateToIso(readAscii(type,count,data))});if(gpsPtr){let latRef='',lonRef='',lat=null,lon=null;const rational=(ptr)=>{if(ptr<0||ptr+8>v.byteLength)return NaN;const den=u32(ptr+4);return den?u32(ptr)/den:NaN};const triple=(data)=>{const p=base+u32(data);const a=rational(p),b=rational(p+8),c=rational(p+16);return[a,b,c].every(Number.isFinite)?a+b/60+c/3600:null};scan(gpsPtr,(tag,type,count,data)=>{if(tag===1)latRef=readAscii(type,count,data);if(tag===2)lat=triple(data);if(tag===3)lonRef=readAscii(type,count,data);if(tag===4)lon=triple(data)});if(lat!=null)out.latitude=latRef==='S'?-lat:lat;if(lon!=null)out.longitude=lonRef==='W'?-lon:lon}return out}catch{return{}}}
async function imageSize(file){if(!file.type.startsWith('image/'))return{};try{const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});const r={width:bitmap.width,height:bitmap.height};bitmap.close();return r}catch{return{}}}
async function videoMeta(file){if(!file.type.startsWith('video/'))return{};return new Promise(resolve=>{const video=document.createElement('video');const url=URL.createObjectURL(file);video.preload='metadata';video.onloadedmetadata=()=>{const r={width:video.videoWidth||undefined,height:video.videoHeight||undefined,durationMs:Number.isFinite(video.duration)?Math.round(video.duration*1000):undefined};URL.revokeObjectURL(url);resolve(r)};video.onerror=()=>{URL.revokeObjectURL(url);resolve({})};video.src=url})}

function retryDelay(attempt,retryAfter){if(retryAfter)return Math.max(1000,Math.min(retryAfter*1000,15*60*1000));const ceiling=Math.min(1000*(2**Math.max(0,attempt-1)),60000);return Math.max(500,Math.round(Math.random()*ceiling))}
async function prepareJob(job){const file=await getOriginal(job);if(!file)throw new Error('本机原件不可用，请重新选择。');job.stage='preparing';job.progress=8;await saveJob(job);const [hash,exif,dimensions,video]=await Promise.all([sha256(file),parseExifMetadata(file),imageSize(file),videoMeta(file)]);job.contentHash=hash;job.metadata={...dimensions,...video,...exif,dateTimeOriginal:exif.dateTimeOriginal,createDate:exif.createDate,fileLastModified:job.lastModified?new Date(job.lastModified).toISOString():undefined};job.stage='reserving';job.progress=20;await saveJob(job);return file}
async function processJob(job){if(activeUploads.has(job.id)||job.controlState!=='active')return;const controller=new AbortController();activeUploads.set(job.id,controller);try{let file=await getOriginal(job);if(!job.contentHash)file=await prepareJob(job);if(job.contentHash&&activeHashes.has(job.contentHash))return;activeHashes.add(job.contentHash);job.attempts=(job.attempts||0)+1;job.status='uploading';job.error='';job.stage='reserving';job.progress=Math.max(job.progress||0,24);await saveJob(job);const reserve=await api('/photos/reserve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({originalName:job.fileName,mimeType:job.mimeType,sizeBytes:job.sizeBytes,mediaType:job.mediaType,contentHash:job.contentHash,width:job.metadata?.width,height:job.metadata?.height,durationMs:job.metadata?.durationMs,dateTimeOriginal:job.metadata?.dateTimeOriginal,createDate:job.metadata?.createDate,fileLastModified:job.metadata?.fileLastModified,latitude:job.metadata?.latitude,longitude:job.metadata?.longitude}),signal:controller.signal});if(reserve.duplicate){job.status='done';job.stage='completed';job.progress=100;job.deduplicated=true;job.remoteAssetId=reserve.assetId;await releaseOriginal(job);await saveJob(job);return}job.remoteAssetId=reserve.assetId;job.uploadToken=reserve.uploadToken;job.stage='original';job.progress=45;await saveJob(job);file=file||await getOriginal(job);const response=await fetch(`/photos/${job.remoteAssetId}/content`,{method:'PUT',headers:{authorization:`Bearer ${state.token}`,'x-upload-token':job.uploadToken,'content-type':job.mimeType},body:file,signal:controller.signal});if(!response.ok){const payload=await response.json().catch(()=>({}));const e=new Error(payload.error||`HTTP_${response.status}`);e.status=response.status;e.retryAfter=Number(response.headers.get('retry-after')||0);throw e}job.status='done';job.stage='completed';job.progress=100;job.error='';job.uploadToken='';await releaseOriginal(job);await saveJob(job);if(state.page==='photos')void renderPhotos()}catch(error){if(job.controlState==='paused'||job.controlState==='canceled'||error.name==='AbortError')return;const transient=[0,429,502,503,504].includes(error.status)||!navigator.onLine;const delay=retryDelay(job.attempts||1,error.retryAfter);job.status=transient?'retrying':'failed';job.error=transient?`网络或 Telegram 暂不可用，稍后自动重试：${error.message}`:error.message;job.nextAttemptAt=transient?new Date(Date.now()+delay).toISOString():null;await saveJob(job)}finally{activeUploads.delete(job.id);if(job.contentHash)activeHashes.delete(job.contentHash);void wakeScheduler('finished')}}

async function runScheduler(){if(!navigator.onLine)return;await loadQueue();const now=Date.now();const eligible=state.queue.filter(j=>j.controlState==='active'&&!['done'].includes(j.status)&&(!j.nextAttemptAt||Date.parse(j.nextAttemptAt)<=now));const limit=weakConnection()?1:(isMobile()?2:3);let videoSlots=1;for(const job of eligible){if(activeUploads.size>=limit)break;if(job.mediaType==='video'){if(videoSlots<1)continue;videoSlots--}void processJob(job)}const next=state.queue.filter(j=>j.controlState==='active'&&j.nextAttemptAt&&j.status!=='done').map(j=>Date.parse(j.nextAttemptAt)).filter(t=>t>Date.now()).sort((a,b)=>a-b)[0];if(next){clearTimeout(schedulerTimer);schedulerTimer=setTimeout(()=>void wakeScheduler('retry'),Math.max(50,next-Date.now()))}}
async function wakeScheduler(){if(schedulerRunning)return;schedulerRunning=true;try{await runScheduler()}finally{schedulerRunning=false}}

window.addEventListener('online',()=>{state.online=true;void wakeScheduler('online');refreshQueue()});window.addEventListener('offline',()=>{state.online=false;refreshQueue()});setInterval(()=>void wakeScheduler('interval'),5000)
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))

void boot()
