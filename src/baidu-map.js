/* ══════════════════════════════════════════════════════════════
   百度地图适配层 · baidu-map.js
   ──────────────────────────────────────────────────────────────
   已实测确认的三件事：
     1. AK 类型 = 浏览器端。服务端/CLI 直连 Web API 返回
        status 210「APP IP校验失败」——这是正确行为。
     2. type=webgl 分支暴露的全局是 BMapGL，不是 BMap。
     3. 官方的 api?...&callback= 加载器内部用 document.write；
        异步注入时 Chrome 会忽略它，导致 BMapGL 永不出现。
        → 因此直接加载 getscript（本模块的做法）。

   配额：本模块所有绘制（底图/标记/折线/圆/标签）均不计次。
        唯一计次的是 locate()，且经过 KDRQuota 守卫。
   ══════════════════════════════════════════════════════════════ */
(function(global){
  'use strict';

  const AK = (global.KDR_AK && global.KDR_AK.browser) || '';
  const LOAD_TIMEOUT = 15000;
  const MIN_ZOOM = 5;
  const NATIVE_STYLE_MAX_ZOOM = 10;

  let map = null;          // BMapGL.Map 实例
  let ready = false;
  let layers = {};         // 复用的覆盖物
  let onSelect = null;     // 酒店点击回调
  let onCenterDrag = null; // 考点图标拖动回调
  let onPoiClick = null;   // 服务点点击回调
  let onCandClick = null;  // 候选点点击回调

  /* ── 坐标转换（WGS84 → BD09）──────────────────────────────
     BMapGL 使用 BD09。若手头是 GPS/OSM 的 WGS84 坐标，
     必须先转换，否则会有几百米偏移——在"步行 6 分钟"的
     尺度上这是致命的。（PRD 已标注：坐标须用拾取器复核）
  */
  const X_PI = Math.PI * 3000 / 180;
  const PI = Math.PI, A = 6378245, EE = 0.00669342162296594323;

  function outOfChina(lng, lat){
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function tLat(x, y){
    let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
    r += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI)) * 2/3;
    r += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30)) * 2/3;
    return r;
  }
  function tLng(x, y){
    let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
    r += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI)) * 2/3;
    r += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI)) * 2/3;
    return r;
  }
  function wgs84ToGcj02(lng, lat){
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = tLat(lng-105, lat-35), dLng = tLng(lng-105, lat-35);
    const rad = lat / 180 * PI;
    let magic = Math.sin(rad); magic = 1 - EE*magic*magic;
    const sq = Math.sqrt(magic);
    dLat = (dLat * 180) / ((A * (1-EE)) / (magic*sq) * PI);
    dLng = (dLng * 180) / (A / sq * Math.cos(rad) * PI);
    return [lng + dLng, lat + dLat];
  }
  function gcj02ToBd09(lng, lat){
    const z = Math.sqrt(lng*lng + lat*lat) + 0.00002 * Math.sin(lat * X_PI);
    const th = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
    return [z*Math.cos(th) + 0.0065, z*Math.sin(th) + 0.006];
  }
  function wgs84ToBd09(lng, lat){
    const g = wgs84ToGcj02(lng, lat);
    return gcj02ToBd09(g[0], g[1]);
  }
  /* 反变换：BD09 → GCJ02 → WGS84。
     GCJ02→WGS84 没有闭式解，用「正变换迭代逼近」——
     每次把残差补回去，两轮就能收敛到 1e-9 度（约 0.1mm），
     远超天气查询需要的精度。 */
  function bd09ToGcj02(lng, lat){
    const x = lng - 0.0065, y = lat - 0.006;
    const z = Math.sqrt(x*x + y*y) - 0.00002 * Math.sin(y * X_PI);
    const th = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
    return [z*Math.cos(th), z*Math.sin(th)];
  }
  function gcj02ToWgs84(lng, lat){
    if (outOfChina(lng, lat)) return [lng, lat];
    let wl = lng, wa = lat;
    for (let i=0;i<2;i++){
      const f = wgs84ToGcj02(wl, wa);
      wl += lng - f[0];
      wa += lat - f[1];
    }
    return [wl, wa];
  }
  function bd09ToWgs84(lng, lat){
    const g = bd09ToGcj02(lng, lat);
    return gcj02ToWgs84(g[0], g[1]);
  }

  /* ── 自绘标记图标 ──
     百度默认 marker 用的是 http://webmap0.bdimg.com/... 的 PNG，
     在 http 页面上会被 CORS 拦掉（图标显示不出来）。
     改用 data-URI 的 SVG，零外部依赖。 */
  function pinIcon(color, glyph, size){
    const w = (size||30), h = Math.round(w*1.3);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'
      + '<path d="M'+w/2+' '+(h-1)+'C'+w/2+' '+(h-1)+' '+(w-2)+' '+(h*0.55)+' '+(w-2)+' '+(w/2)
      + 'A'+(w/2-2)+' '+(w/2-2)+' 0 1 1 2 '+(w/2)
      + 'C2 '+(h*0.55)+' '+w/2+' '+(h-1)+' '+w/2+' '+(h-1)+'z" '
      + 'fill="'+color+'" stroke="#0B1220" stroke-width="2"/>'
      + '<text x="'+w/2+'" y="'+(w*0.68)+'" font-size="'+(w*0.5)+'" text-anchor="middle">'+glyph+'</text>'
      + '</svg>';
    return new global.BMapGL.Icon('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg),
      new global.BMapGL.Size(w,h), { anchor:new global.BMapGL.Size(w/2, h) });
  }

  /* ── 深色地图样式 ──────────────────────────────────────────
     实测结论（用「颜色探针」逐个验证过，别照抄网上的示例）：

       ✅ 生效：background / land / water / green / building
                all + geometry.fill、all + labels
       ❌ 无效：highway / arterial / local / road / national /
                provincial / city / county / roadnet / street /
                expressway / poi / poilabel / districtlabel / roadlabel

     也就是说：**道路颜色改不了**（官方文档虽然列了 highway /
     arterial，但实测不生效，且颜色必须写在 geometry.fill 上）。
     所以这里只染底图，道路保留默认渲染 —— 深底 + 默认路网
     反而更易读，也让暖橙路线有足够对比。

     另一个关键点：只有 `all + labels` 能控标注；
     poilabel / roadlabel 单独关不掉。这里保持标注开启，
     因为路名（如「广州环城高速」）对导航场景是有用信息。
     ────────────────────────────────────────────────────── */
  const DARK_STYLE = [
    { featureType:'background', elementType:'geometry',      stylers:{ color:'#0B1220' } },
    { featureType:'land',       elementType:'geometry.fill', stylers:{ color:'#0F1826' } },
    /* BMapGL 的 water 样式在部分缩放级别不会独立覆盖海域。
       因此低缩放时由 applyStyle() 切回百度原生样式，保证海岸线与海岛可辨；
       城区级再使用作品自己的主题样式。 */
    { featureType:'water',      elementType:'geometry.fill', stylers:{ color:'#0B3A66' } },
    { featureType:'green',      elementType:'geometry.fill', stylers:{ color:'#0E1C1A' } },
    { featureType:'building',   elementType:'geometry.fill', stylers:{ color:'#141F30' } },
    /* 注：不要用 all+geometry.fill 去压道路 —— 那会把路面涂成和底色一样，
       路网彻底消失（实测过，地图会变成一片黑，反而像加载失败）。 */
  ];


  /* 白天模式样式 —— 只覆盖实测生效的那些字段 */
  const LIGHT_STYLE = [
    { featureType:'background', elementType:'geometry',      stylers:{ color:'#EEF2F7' } },
    { featureType:'land',       elementType:'geometry.fill', stylers:{ color:'#F7F9FC' } },
    { featureType:'water',      elementType:'geometry.fill', stylers:{ color:'#AFD4EC' } },
    { featureType:'green',      elementType:'geometry.fill', stylers:{ color:'#E4EFE1' } },
    { featureType:'building',   elementType:'geometry.fill', stylers:{ color:'#E9EDF3' } },
  ];

  let theme = 'dark';
  function styleFor(t){ return t === 'light' ? LIGHT_STYLE : DARK_STYLE; }
  /* ⚠️ setMapStyleV2 是**异步**的：每调一次都会作废瓦片缓存重新拉。
     之前一个主题切换会连调 3~4 次（setTheme 里 1+1.2s+3s，init 里 1+2.5s），
     互相打断，实测出现过「样式只生效一半、海面还是旧色」的情况。
     现在统一走 applyStyle()，并用一个指纹防重复下发。 */
  let appliedKey = null;
  function applyStyle(force){
    if (!ready) return;
    const lowZoom = map.getZoom() <= NATIVE_STYLE_MAX_ZOOM;
    const key = theme + '|' + mapMode + '|' + (lowZoom ? 'native' : 'custom');
    if (!force && appliedKey === key) return;
    const styleJson = mapMode === 'satellite' || lowZoom ? [] : styleFor(theme);
    try {
      map.setMapStyleV2({ styleJson });
      appliedKey = key;
    } catch(e){ appliedKey = null; }
  }
  /* ★ 上色必须是**确定性的**。
     实测：在 init 里上一次、tilesloaded 再补一次、2.5s 又补一次 ——
     三次 setMapStyleV2 互相打断（它每次都会作废瓦片缓存重新拉），
     同一个页面刷新几次会得到不同的结果：有时海面上了水色，有时没有。
     现在改成：等「地图连续两次 tilesloaded 之间没有新请求」再上色一次，
     之后不再重复下发（除非主题 / 底图类型变了）。 */
  let styleTimer = null;
  function scheduleStyle(delay){
    if (styleTimer) clearTimeout(styleTimer);
    styleTimer = setTimeout(()=>{ styleTimer = null; applyStyle(false); }, delay);
  }
  /* ── 底图类型：标准 / 卫星混合 ──
     BMAP_HYBRID_MAP = 卫星影像 + 路网标注，比纯卫星图可读性好得多。
     卫星图上不叠加自定义样式（卫星影像没有可着色的矢量层）。 */
  let mapMode = 'normal';
  /* 实测（常量值就是字符串）：
       BMAP_NORMAL_MAP    = 'B_NORMAL_MAP'    矢量标准图
       BMAP_SATELLITE_MAP = 'B_SATELLITE_MAP' 卫星影像 ← 要的是这个
       BMAP_HYBRID_MAP    = 'B_STREET_MAP'    其实是"街道图"，不是卫星
     而且**必须先清掉自定义样式**，否则底图被矢量样式锁住，
     切了类型也看不出变化。顺序不能反。 */
  function setMapMode(m){
    mapMode = (m === 'satellite') ? 'satellite' : 'normal';
    if (!ready) return;
    if (mapMode === 'satellite'){
      try { map.setMapStyleV2({ styleJson: [] }); } catch(e){}
      setTimeout(()=>{ try { map.setMapType(BMAP_SATELLITE_MAP); } catch(e){} }, 350);
    } else {
      try { map.setMapType(BMAP_NORMAL_MAP); } catch(e){}
      appliedKey = null;                     // 底图类型变了，样式要重新下发
      scheduleStyle(500);
    }
  }
  function getMapMode(){ return mapMode; }

  /* 地图选点模式：把点击坐标回调出去 */
  let pickHandler = null;
  let pickEnabled = false;
  let pickGuard = null;                 // 应用层注入：当前是否允许选点
  function setPickMode(on){
    pickEnabled = !!on;
    if (!ready) return;
    if (!map._kdrPickBound){
      map._kdrPickBound = true;
      map.addEventListener('click', e=>{
        /* ★ 三重守卫：必须「已开启选点模式」且「在考点选择页」才响应。
           否则用户在别的页签想拖动/缩放地图，一点就被重新定位 ——
           这正是「点地图就跳回周边设施」的根因。 */
        if (!pickHandler || !pickEnabled) return;
        if (pickGuard && !pickGuard()) return;
        const p = e.latlng || e.point;
        if (p && typeof p.lng === 'number'){
          pickEnabled = false;                 // 选完自动关闭，杜绝误触
          pickHandler([p.lng, p.lat]);
        }
      });
    }
    if (on){ map.setDefaultCursor('crosshair'); }
    else { map.setDefaultCursor(''); }
  }
  function onMapPick(f){ pickHandler = f; }

  function setTheme(t){
    theme = (t === 'light') ? 'light' : 'dark';
    appliedKey = null;
    applyStyle(false);
    /* 换主题会重新请求自定义样式瓦片，稍后再检查一次即可。 */
    scheduleStyle(1200);
  }

  /* ── 加载 getscript（绕过 document.write 加载器）── */
  function loadScript(){
    return new Promise((resolve, reject)=>{
      if (global.BMapGL) return resolve();
      if (!AK) return reject(new Error('NO_AK'));

      /* ★ 官方加载器（api?type=webgl&v=1.0&ak=…）会先设这两个全局变量再引脚本：
           window.BMAP_PROTOCOL       —— 决定瓦片走 http 还是 https
           window.BMapGL_loadScriptTime —— 加载时间戳（缓存/埋点用）
         我们直接引 getscript 时漏了这两个。协议没设的话，BMapGL 会按页面协议猜，
         在 https 页面或 file:// 下可能去请求 http 瓦片而被浏览器拦掉
         → 表现就是「地图白板 / 瓦片不出来」。补上，和官方完全对齐。 */
      global.BMAP_PROTOCOL = 'https';
      if (!global.BMapGL_loadScriptTime) global.BMapGL_loadScriptTime = Date.now();

      if (!document.getElementById('bmapgl-css')){
        const l = document.createElement('link');
        l.id = 'bmapgl-css'; l.rel = 'stylesheet';
        l.href = 'https://api.map.baidu.com/res/webgl/10/bmap.css';
        document.head.appendChild(l);
      }

      const s = document.createElement('script');
      s.type = 'text/javascript';
      s.src = 'https://api.map.baidu.com/getscript?type=webgl&v=1.0&ak=' +
              encodeURIComponent(AK) + '&services=&t=' + Date.now();
      let settled = false;
      const done = (ok, err)=>{
        if (settled) return; settled = true;
        ok ? resolve() : reject(err || new Error('MAP_LOAD_FAIL'));
      };
      s.onload  = ()=> global.BMapGL ? done(true) : done(false, new Error('MAP_NO_GLOBAL'));
      s.onerror = ()=> done(false, new Error('MAP_SCRIPT_ERROR'));
      setTimeout(()=> done(false, new Error('MAP_TIMEOUT')), LOAD_TIMEOUT);
      document.head.appendChild(s);
    });
  }

  /* ── 初始化 ── */
  async function init(container, center){
    await loadScript();
    const G = global.BMapGL;
    map = new G.Map(container, { enableMapClick:false });
    map.centerAndZoom(new G.Point(center[0], center[1]), 16);
    map.enableScrollWheelZoom(true);
    map.disableDoubleClickZoom(true);
    /* ⚠️ 时序坑：在 init 里立刻调 setMapStyleV2 会**静默失效** ——
       此时瓦片尚未加载完。必须等首帧瓦片就绪后再上色。
       只下发这一次（外加一个弱网兜底），重复下发会互相打断。 */
    /* 每次瓦片加载完就重置计时器；静下来 1.2s 后才真正上色。
       这样无论快网慢网，上色时瓦片一定已经就绪，不会被打断。 */
    map.addEventListener('tilesloaded', ()=>scheduleStyle(1200));
    map.addEventListener('zoomend', ()=>scheduleStyle(240));
    scheduleStyle(4000);                     // 兜底：万一 tilesloaded 一直不来
    /* 允许看到省域和近海范围。低缩放级别切回百度原生样式，
       避免自定义深色样式把海陆背景压成同一块颜色。 */
    try { map.setMinZoom(MIN_ZOOM); } catch(e){}
    map.addControl(new G.NavigationControl({ anchor:BMAP_ANCHOR_TOP_RIGHT, type:BMAP_NAVIGATION_CONTROL_SMALL }));
    ready = true;
    return true;
  }

  /* ── 清层 ──
     注意：BMapGL.removeOverlay 只接受单个覆盖物。某些层是数组
     （路线、住宿端点、POI 标签），必须逐个移除，否则反复交互
     会不断堆积覆盖物（真实的性能泄漏）。
  */
  function removeOne(o){
    if (!o) return;
    try { Array.isArray(o) ? o.forEach(x=>x && map.removeOverlay(x)) : map.removeOverlay(o); }
    catch(e){ /* 已移除的忽略 */ }
  }
  function clearLayer(name){
    if (layers[name]) { removeOne(layers[name]); layers[name] = null; }
  }
  function clearAll(){
    if (!ready) return;
    Object.keys(layers).forEach(clearLayer);
    layers = {};
  }

  /* ── 绘制主入口 ──
     model = {
       site:{name, center:[lng,lat]},
       spot:{name, point:[lng,lat], warn},
       hotels:[{name, point:[lng,lat], walk, selected, path:[[lng,lat],...]}],
       pois:[{ic, name, point:[lng,lat]}]
     }
     ⚠️ 传入坐标必须是 BD09。若来源是 WGS84，先用 KDRMap.wgs84ToBd09()
  */
  function render(model){
    if (!ready) return false;
    const G = global.BMapGL;
    clearAll();

    const c = model.site && model.site.center;
    /* 空考点状态：只清掉旧覆盖物，不添加案例标记，也不重置 IP 城市视角。 */
    if (!c){ return true; }

    /* ══ ① 校区边界：虚线边框 + 浅色透明底（像高德搜学校那样框出整个校区）══ */
    if (model.boundary && model.boundary.length >= 3){
      const bpoly = new G.Polygon([model.boundary.map(p=>new G.Point(p[0], p[1]))], {
        strokeColor:'#7FE3FF', strokeWeight:2, strokeStyle:'dashed', strokeOpacity:.9,
        fillColor:'#7FE3FF', fillOpacity:.10, enableMassClear:false
      });
      map.addOverlay(bpoly);
      layers.boundary = bpoly;
      /* 校区名牌 */
      const byC = model.boundary.reduce((a,p)=>[a[0]+p[0]/model.boundary.length, a[1]+p[1]/model.boundary.length],[0,0]);
      let top = model.boundary[0];
      model.boundary.forEach(p=>{ if (p[1] > top[1]) top = p; });
      const bl = new G.Label('🏫 ' + (model.site.name || ''), {
        position:new G.Point(top[0], top[1]), offset:new G.Size(-40, -30) });
      bl.setStyle({ color:'#7FE3FF', background:'rgba(11,18,32,.82)',
                    border:'1px solid rgba(127,227,255,.5)', padding:'3px 9px',
                    borderRadius:'8px', fontSize:'12px', fontWeight:'600' });
      map.addOverlay(bl);
      layers.boundaryLbl = bl;
    }

    /* ══ ② 等时圈：以考点为中心，16 方向真实路网采样连成多边形 ══
       步行 / 骑行 / 驾车 各自一个；公共交通按 5km 等距圈。 */
    layers.rings = [];
    const ISO = [
      { key:'walking', name:'步行 15min',  color:'#FF8A3D' },
      { key:'riding',  name:'骑行 15min',  color:'#4ADE80' },
      { key:'driving', name:'驾车 15min',  color:'#A78BFA' },
      { key:'driving7', name:'驾车 7km',   color:'#A78BFA' },
    ];
    (model.iso || []).forEach(it=>{
      const conf = ISO.find(x=>x.key===it.key) || { color:'#2EC5FF', name:it.key };
      if (!it.poly || it.poly.length < 3) return;
      const poly = new G.Polygon([it.poly.map(p=>new G.Point(p[0], p[1]))], {
        strokeColor: conf.color, strokeWeight: it.active ? 2.5 : 1.5,
        strokeStyle:'dashed', strokeOpacity: it.active ? .95 : .45,
        fillColor: conf.color, fillOpacity: it.active ? .10 : .035,
        enableMassClear:false
      });
      map.addOverlay(poly);
      layers.rings.push(poly);
      /* 圈名放在**多边形最北顶点之外**，不遮地图 */
      let top = it.poly[0];
      it.poly.forEach(p=>{ if (p[1] > top[1]) top = p; });
      const lb = new G.Label(conf.name, {
        position:new G.Point(top[0], top[1]),
        offset:new G.Size(-24, it.active ? -30 : -20) });
      lb.setStyle({ color: conf.color,
                    background:'rgba(11,18,32,.72)',
                    border:'1px solid '+conf.color+'66',
                    padding:'2px 8px', borderRadius:'10px',
                    fontSize: it.active ? '12px' : '11px',
                    opacity: it.active ? 1 : .55 });
      map.addOverlay(lb);
      (layers.ringLbls = layers.ringLbls || []).push(lb);
    });
    /* 公共交通：5km 等距圈 */
    if (model.transitRadius){
      const tc = new G.Circle(new G.Point(c[0], c[1]), model.transitRadius, {
        strokeColor:'#2EC5FF', strokeWeight: model.transitActive ? 2.5 : 1.5,
        strokeStyle:'dashed', strokeOpacity: model.transitActive ? .9 : .4,
        fillColor:'#2EC5FF', fillOpacity: model.transitActive ? .07 : .02,
        enableMassClear:false });
      map.addOverlay(tc);
      layers.rings.push(tc);
      const tl = new G.Label('公交 5km', { position:new G.Point(c[0], c[1] + model.transitRadius/111320),
                                           offset:new G.Size(-22, -6) });
      tl.setStyle({ color:'#2EC5FF', background:'rgba(11,18,32,.72)',
                    border:'1px solid rgba(46,197,255,.45)', padding:'2px 8px',
                    borderRadius:'10px', fontSize:'11px', opacity: model.transitActive ? 1 : .5 });
      map.addOverlay(tl);
      layers.ringLbls = (layers.ringLbls || []).concat([tl]);
    }

    /* ══ 起点（居住点）标记：绿色，与考点的红色区分 ══ */
    if (model.origin){
      const om = new G.Marker(new G.Point(model.origin[0], model.origin[1]), {
        enableMassClear:false, icon: pinIcon('#4ADE80', '🏨', 30) });
      map.addOverlay(om);
      layers.originMk = om;
      const ol = new G.Label('🏨 ' + (model.originName || '我的居住点'),
        { position:new G.Point(model.origin[0], model.origin[1]), offset:new G.Size(16, -14) });
      ol.setStyle({ color:'#4ADE80', background:'#FFFFFF', border:'1px solid rgba(0,0,0,.14)',
                    padding:'3px 8px', borderRadius:'7px', fontSize:'11.5px', fontWeight:'600' });
      map.addOverlay(ol);
      layers.originLbl = ol;
    }

    /* ══ 起终点之间的真实路线（已去掉管道多边形）══ */
    if (model.corridorPath && model.corridorPath.length > 1){
      const cl = new G.Polyline(model.corridorPath.map(p=>new G.Point(p[0], p[1])), {
        strokeColor: model.corridorColor || '#FF8A3D', strokeWeight: 5,
        strokeOpacity:.95, enableMassClear:false });
      map.addOverlay(cl);
      layers.corridorLine = cl;
    }

    /* ══ 公共交通：一条线路一种颜色，首末步行接驳用虚线 ══ */
    (model.transitSegs || []).forEach(sg=>{
      if (!sg.path || sg.path.length < 2) return;
      const pl = new G.Polyline(sg.path.map(p=>new G.Point(p[0], p[1])), {
        strokeColor: sg.color || '#2EC5FF',
        strokeWeight: sg.walk ? 3 : 5,
        strokeStyle: sg.walk ? 'dashed' : 'solid',
        strokeOpacity: sg.walk ? .8 : .95, enableMassClear:false });
      map.addOverlay(pl);
      (layers.transitLines = layers.transitLines || []).push(pl);
      if (sg.walk) return;
      /* 上车 / 下车站点标记 —— 用户要看到「从哪站上、到哪站下」 */
      [['上', sg.onPt, sg.from], ['下', sg.offPt, sg.to]].forEach(([tag, pt, nm])=>{
        if (!pt || !nm) return;
        const lb = new G.Label(tag + ' ' + nm, {
          position:new G.Point(pt[0], pt[1]), offset:new G.Size(8, -8) });
        lb.setStyle({ color:'#0B1220', background: sg.color || '#2EC5FF',
                      border:'1px solid #0B1220', padding:'2px 7px',
                      borderRadius:'9px', fontSize:'11px', fontWeight:'700' });
        map.addOverlay(lb);
        (layers.transitLines = layers.transitLines || []).push(lb);
      });
    });

    /* ══ AI 临时规划层：不修改正式路线，只叠加在当前地图上 ══ */
    if (model.aiPlan){
      const ai = model.aiPlan;
      layers.aiPlan = [];
      (ai.segments || []).forEach(seg=>{
        if (!seg.path || seg.path.length < 2) return;
        const line = new G.Polyline(seg.path.map(p=>new G.Point(p[0], p[1])), {
          strokeColor: seg.color || '#FBBF24',
          strokeWeight: seg.walk ? 3 : 5,
          strokeStyle: seg.dashed ? 'dashed' : 'solid',
          strokeOpacity: .95,
          enableMassClear:false
        });
        map.addOverlay(line);
        layers.aiPlan.push(line);
      });
      (ai.stops || []).forEach((stop, i)=>{
        if (!stop || !stop.pt) return;
        const pt = new G.Point(stop.pt[0], stop.pt[1]);
        const marker = new G.Marker(pt, {
          enableMassClear:false,
          icon: pinIcon('#FBBF24', String(stop.order || i + 1), 30)
        });
        map.addOverlay(marker);
        layers.aiPlan.push(marker);
        const label = new G.Label((stop.order || i + 1) + '. ' + (stop.name || '途径点'), {
          position:pt, offset:new G.Size(16, -12)
        });
        label.setStyle({
          color:'#0B1220', background:'#FBBF24', border:'1px solid #0B1220',
          padding:'3px 8px', borderRadius:'8px', fontSize:'11px', fontWeight:'700'
        });
        map.addOverlay(label);
        layers.aiPlan.push(label);
      });
    }

    /* ══ 点「就近便利度」某一行 → 把地图放大到那个服务点 ══ */
    if (model.rpFocus && model.rpFocus.pt){
      const fp = new G.Point(model.rpFocus.pt[0], model.rpFocus.pt[1]);
      const fm = new G.Marker(fp, { enableMassClear:false, icon: pinIcon('#8FD3FF', '📌', 32) });
      map.addOverlay(fm);
      layers.focusMk = fm;
      const fl = new G.Label(model.rpFocus.name || '', { position:fp, offset:new G.Size(14, -12) });
      fl.setStyle({ color:'#0B1220', background:'#8FD3FF', border:'1px solid #0B1220',
                    padding:'3px 9px', borderRadius:'8px', fontSize:'12px', fontWeight:'700' });
      map.addOverlay(fl);
      layers.focusLbl = fl;
      try{ map.centerAndZoom(fp, 18); }catch(e){}
      return true;                       // ★ 聚焦模式下不再 setViewport，否则会被拉回全景
    }

    /* ══ ③ 考点中心标记（可拖动定位）══ */
    if (model.center){
      const cm = new G.Marker(new G.Point(model.center[0], model.center[1]), {
        enableDragging: !!model.draggable, enableMassClear:false,
        icon: pinIcon('#FF5C7A', '📍', 34), raiseOnDrag:true });
      map.addOverlay(cm);
      layers.centerMk = cm;
      if (model.draggable && onCenterDrag){
        const fire = ()=>{ const p = cm.getPosition(); onCenterDrag([p.lng, p.lat]); };
        cm.addEventListener('dragend', fire);
      }
    }

    /* 考场楼栋标记（暖橙） */
    const sp = model.spot;
    if (sp && sp.point && sp.name){          // 纯地图模式下 spot 为空，不画标记
      const pt = new G.Point(sp.point[0], sp.point[1]);
      layers.spot = new G.Marker(pt);
      map.addOverlay(layers.spot);
      const lbl = new G.Label(sp.name, { position:pt, offset:new G.Size(16,-10) });
      lbl.setStyle({ color:'#FFB37A', background:'rgba(11,18,32,.85)', border:'1px solid rgba(255,138,61,.4)',
                     padding:'3px 7px', borderRadius:'5px', fontSize:'12px' });
      layers.spotLbl = lbl;
      map.addOverlay(lbl);
    }

    /* 每家住宿一条路线。
       · 只画 show=true 的（列表里可见的 + 选中的），避免几十条线糊成一团
       · 颜色与左侧列表里的名称颜色一一对应 */
    const paths = [];
    (model.hotels||[]).forEach(h=>{
      if (!h.path || h.path.length < 2) return;
      if (h.show === false) return;
      const pts = h.path.map(p=>new G.Point(p[0], p[1]));
      const col = h.color || '#FF8A3D';
      const line = new G.Polyline(pts, {
        strokeColor: col,
        strokeWeight: h.selected ? 6 : 3,
        strokeOpacity: h.selected ? 1 : .5,
        enableMassClear:false
      });
      map.addOverlay(line);
      paths.push({ h, line, pts });
    });
    layers.routes = paths;
    layers.routeLines = paths.map(p=>p.line);

    /* 选中路线：记录引用，湿段由 paintRain 单独绘制 */
    const sel = paths.find(p=>p.h.selected) || paths[0];
    if (sel){
      layers.selPath = sel;
      if (onSelect) sel.h._line = sel.line;
    }

    /* 住宿端点：只画可见的 */
    (model.hotels||[]).forEach(h=>{
      if (!h.point || h.show === false) return;
      const m = new G.Marker(new G.Point(h.point[0], h.point[1]), {
        enableMassClear:false, icon: pinIcon(h.color || '#FF8A3D', '🏨', 26) });
      map.addOverlay(m);
      m.addEventListener('click', ()=>{
        showNameCard(h.point, '🏨 ' + h.name);
        if (onSelect) onSelect(h.idx);
      });
      (layers.hotelMarkers = layers.hotelMarkers || []).push(m);
    });

    /* 应试服务点：构建期检索到的真实 POI（打印店/文具店/药店/派出所/医院/停车场） */
    (model.pois||[]).forEach(p=>{
      if (!p.point) return;
      const l = new G.Label(p.ic, {
        position:new G.Point(p.point[0], p.point[1]),
        offset:new G.Size(-9, -9),
      });
      l.setStyle({ background:'rgba(120,200,255,.22)', border:'1px solid #78C8FF',
                   borderRadius:'50%', padding:'2px 3px', fontSize:'11px',
                   cursor:'pointer' });
      map.addOverlay(l);
      l.addEventListener('click', ()=>{
        const lb = new G.Label(p.name, { position:new G.Point(p.point[0], p.point[1]),
                                         offset:new G.Size(12, -6) });
        lb.setStyle({ color:'#8FD3FF', background:'rgba(11,18,32,.9)',
                      border:'1px solid rgba(120,200,255,.45)', padding:'3px 7px',
                      borderRadius:'5px', fontSize:'11.5px' });
        map.addOverlay(lb);
        setTimeout(()=>{ try{ map.removeOverlay(lb); }catch(e){} }, 2600);
      });
      (layers.poiLabels = layers.poiLabels || []).push(l);
    });

    /* 视口：新考点（无边界）只聚焦中心，避免被远处点位拉远 */
    if (model.focusZoom){
      try{ map.centerAndZoom(new G.Point(c[0], c[1]), model.focusZoom); }catch(e){}
      return true;
    }
    /* AI 临时路线按路径边界定视口；常规页面仍按考点和住宿定视口。 */
    try {
      const all = model.aiPlan
        ? [model.aiPlan.origin.pt, model.aiPlan.dest.pt,
           ...(model.aiPlan.stops || []).map(s=>s.pt),
           ...(model.aiPlan.segments || []).flatMap(s=>{
             const path = s.path || [];
             if (path.length < 2) return [];
             const left = path.reduce((a,p)=>p[0] < a[0] ? p : a, path[0]);
             const right = path.reduce((a,p)=>p[0] > a[0] ? p : a, path[0]);
             const bottom = path.reduce((a,p)=>p[1] < a[1] ? p : a, path[0]);
             const top = path.reduce((a,p)=>p[1] > a[1] ? p : a, path[0]);
             return [left, right, bottom, top];
           })].map(p=>new G.Point(p[0], p[1]))
        : [new G.Point(c[0], c[1])].concat(
          (model.hotels||[]).filter(h=>h.point).map(h=>new G.Point(h.point[0], h.point[1]))
        );
      if (all.length > 1) map.setViewport(all, { margins:[70,70,70,70] });
      else map.centerAndZoom(new G.Point(c[0], c[1]), 16);
    } catch(e){
      map.centerAndZoom(new G.Point(c[0], c[1]), 16);
    }
    return true;
  }

  /* ── 淋雨染色：湿段锚定考点端，向出发点蔓延 ──
     与原型算法一致，只是作用于真实折线几何：
     按累计距离切分，靠近考点那一段先湿。
  */
  function paintRain(wetRatio){
    if (!ready || !layers.selPath) return;
    const sel = layers.selPath;
    const G = global.BMapGL;
    const pts = sel.pts;
    const r = Math.max(0, Math.min(1, wetRatio));

    if (r <= 0.001){
      if (layers.wet){ map.removeOverlay(layers.wet); layers.wet = null; }
      return;
    }

    /* 累计距离 */
    const seg = [];
    let total = 0;
    for (let i=1;i<pts.length;i++){
      const d = map.getDistance(pts[i-1], pts[i]);
      seg.push(d); total += d;
    }
    if (total <= 0) return;

    /* 从考点端往回取 r 比例的长度（考点 = 最后一个点） */
    const want = total * r;
    const keep = [pts[pts.length-1]];
    let acc = 0;
    for (let i=pts.length-1;i>0;i--){
      const d = seg[i-1];
      if (acc + d <= want){ keep.unshift(pts[i-1]); acc += d; }
      else {
        /* 在最后一段内插值切分 */
        const t = (want - acc) / d;
        const a = pts[i], b = pts[i-1];
        keep.unshift(new G.Point(a.lng + (b.lng-a.lng)*t, a.lat + (b.lat-a.lat)*t));
        break;
      }
    }
    if (keep.length < 2) return;

    if (layers.wet) map.removeOverlay(layers.wet);
    layers.wet = new G.Polyline(keep, {
      strokeColor:'#2EC5FF', strokeWeight:6, strokeOpacity:.92, enableMassClear:false
    });
    map.addOverlay(layers.wet);
  }

  function focus(point, zoom){
    if (!ready) return;
    map.centerAndZoom(new global.BMapGL.Point(point[0], point[1]), zoom || 17);
  }

  /* 只取城市视角，不写入考点状态，也不走 Geolocation 配额。 */
  function locateByIp(){
    if (!ready || !global.BMapGL.LocalCity) return Promise.resolve(null);
    return new Promise(resolve=>{
      try{
        new global.BMapGL.LocalCity().get(result=>{
          const p = result && result.center;
          if (!p || typeof p.lng !== 'number') return resolve(null);
          const point = [+p.lng, +p.lat];
          try{ map.centerAndZoom(new global.BMapGL.Point(point[0], point[1]), 11); }catch(e){}
          resolve({ point, name: result.name || '' });
        });
      }catch(e){ resolve(null); }
    });
  }

  /* ── 定位（计次！走配额守卫）──
     注意：Geolocation 失败时百度会自动回落 IP 定位，可能消耗 2 次。
     定位结果不缓存（每次位置都可能不同）。
  */
  async function locate(){
    if (!ready) throw new Error('MAP_NOT_READY');
    const G = global.BMapGL;

    const raw = await global.KDRQuota.call('geolocation', ['locate'], ()=>new Promise((resolve, reject)=>{
      const g = new G.Geolocation();
      let settled = false;
      g.getCurrentPosition(function(r){
        if (settled) return; settled = true;
        if (this.getStatus() === BMAP_STATUS_SUCCESS) resolve([r.point.lng, r.point.lat, r.accuracy]);
        else reject(Object.assign(new Error('GEO_FAIL'), { status:this.getStatus() }));
      }, { enableHighAccuracy:true });
      setTimeout(()=>{ if(!settled){ settled=true; reject(new Error('GEO_TIMEOUT')); } }, 12000);
    }), { cache:false });

    return raw.data;
  }

  /* ── 按需绘制单条路线（默认不画，用户点胶囊才画）── */
  function clearRoutes(){
    if (!ready) return;
    (layers.userRoutes || []).forEach(o=>{ try{ map.removeOverlay(o); }catch(e){} });
    layers.userRoutes = [];
  }
  function drawRoute(pts, color, dashed){
    if (!ready || !pts || pts.length < 2) return;
    clearRoutes();
    const line = new global.BMapGL.Polyline(
      pts.map(p=>new global.BMapGL.Point(p[0], p[1])),
      { strokeColor: color || '#FF8A3D', strokeWeight: 5, strokeOpacity: .95,
        strokeStyle: dashed ? 'dashed' : 'solid', enableMassClear:false });
    map.addOverlay(line);
    layers.userRoutes = [line];
    if (layers.selPath) layers.selPath.pts = pts.map(p=>new global.BMapGL.Point(p[0], p[1]));
  }

  /* ── 图标处的小名称卡 ── */
  let cardEl = null;
  function showNameCard(point, text){
    if (!ready || !point) return;
    if (!cardEl){
      cardEl = document.createElement('div');
      cardEl.className = 'namecard';
      document.querySelector('#bmap').appendChild(cardEl);
    }
    const px = map.pointToPixel(new global.BMapGL.Point(point[0], point[1]));
    cardEl.textContent = text;
    cardEl.style.left = px.x + 'px';
    cardEl.style.top  = px.y + 'px';
    cardEl.style.display = 'block';
    clearTimeout(cardEl._t);
    cardEl._t = setTimeout(()=>{ cardEl.style.display='none'; }, 3200);
  }
  function hideNameCard(){ if (cardEl) cardEl.style.display='none'; }

  /* ══════════════════════════════════════════════════════════════
     供「新考点动态构建」使用的三个能力
     ══════════════════════════════════════════════════════════════ */
  const R_EARTH = 111320;

  /* ① 通用路线规划（返回真实路径） */
  function route(kind, from, to){
    const args = [kind,
      (from || []).map(v=>+Number(v).toFixed(6)),
      (to || []).map(v=>+Number(v).toFixed(6))];
    const run = () => new Promise(res=>{
      if (!ready) return res(null);
      const G = global.BMapGL;
      let w, done = false;
      const fin = v => { if (!done){ done = true; res(v); } };
      const opts = { renderOptions:{ map:null, autoViewport:false } };
      try{
        if (kind === 'walking')      w = new G.WalkingRoute(map, opts);
        else if (kind === 'riding')  w = new G.RidingRoute(map, opts);
        else if (kind === 'transit') w = new G.TransitRoute(map, opts);
        else                         w = new G.DrivingRoute(map, opts);
      }catch(e){ return fin(null); }
      w.setSearchCompleteCallback(()=>{
        try{
          const pl = w.getResults();
          if (!pl || pl.getNumPlans() === 0) return fin(null);
          const plan = pl.getPlan(0), r0 = plan.getRoute(0);
          /* 逐段指引：BMapGL 是 getNumSteps()/getStep(i)（不是 getSteps()）。
             不同版本 / 服务区域可能暴露不同的文字字段，统一尽量读取；
             没有文字时由上层按路线几何推算转向，但不会伪造道路名称。 */
          const steps = [];
          try{
            const n = (typeof r0.getNumSteps === 'function') ? r0.getNumSteps() : 0;
            for (let i = 0; i < n; i++){
              const st = r0.getStep(i);
              if (!st) continue;
              const read = name=>{
                try{
                  if (typeof st[name] === 'function') return st[name]();
                  return st[name];
                }catch(e){ return ''; }
              };
              const clean = value=>String(value || '').replace(/<[^>]+>/g, '').trim();
              const desc = clean(
                read('getDescription') || read('getInstruction') ||
                read('getInstructions') || read('description') ||
                read('instruction')
              );
              const road = clean(
                read('getStreetName') || read('getRoadName') ||
                read('getRoad') || read('streetName') ||
                read('roadName') || read('road') || read('title')
              );
              let pt = null;
              try{
                const p = (typeof st.getPosition === 'function') ? st.getPosition()
                        : (typeof st.getPos === 'function' ? st.getPos() : null);
                if (p) pt = [+p.lng.toFixed(6), +p.lat.toFixed(6)];
              }catch(e){}
              steps.push({
                desc,
                road,
                dist: read('getDistance') || '',
                pt,
              });
            }
          }catch(e){}
          fin({
            path: r0.getPath().map(pt=>[+pt.lng.toFixed(6), +pt.lat.toFixed(6)]),
            distance: plan.getDistance(), duration: plan.getDuration(),
            steps,
          });
        }catch(e){ fin(null); }
      });
      try{ w.search(new G.Point(from[0],from[1]), new G.Point(to[0],to[1])); }
      catch(e){ fin(null); }
      setTimeout(()=>fin(null), 8000);   // 兜底超时；调用方会重试一次
    });
    if (global.KDRQuota){
      return global.KDRQuota.call('routing', args, run, {
        cacheIf: d => !!(d && d.path && d.path.length > 1)
      }).then(r=>r.data).catch(()=>null);
    }
    return run();
  }

  /* ── 公共交通规划 ──────────────────────────────────────────
     ⚠️ 三个坑，都是实测踩出来的：
       1. TransitRoute 必须传**真实的 map 实例**，传 null 时回调永远不触发
          （拿不到城市上下文）。所以这个函数只能写在 baidu-map.js 里。
       2. BMapGL 的线路对象方法名和 BMap v3 文档**不一样**：
          线路名 = getTitle()（不是 getLineName）
          上/下车站 = getGetOnStop()/getGetOffStop()，坐标在 stop.point 上（不是 .position）
          几何 = getPath() → [{lng,lat}]
       3. plan.getBusName() 会**在 SDK 内部抛异常**（reading 'substring'），别调它。

     返回 { distance, duration, walkDistance, lines:[{name,from,to,via,dist,onPt,offPt,path}] } */
  function transit(from, to){
    const args = ['transit',
      (from || []).map(v=>+Number(v).toFixed(6)),
      (to || []).map(v=>+Number(v).toFixed(6))];
    const run = () => new Promise(res=>{
      if (!ready) return res(null);
      const G = global.BMapGL;
      if (typeof G.TransitRoute !== 'function') return res(null);
      let w = null, done = false;
      const fin = v => { if (!done){ done = true; res(v); } };
      try{ w = new G.TransitRoute(map, { renderOptions:{ map:null, autoViewport:false } }); }
      catch(e){ return fin(null); }
      const stopOf = (fn, ln)=>{
        try{
          const st = typeof ln[fn] === 'function' ? ln[fn]() : null;
          if (!st) return { name:'', pt:null };
          const p = st.point || st.position || null;
          return { name: st.title || st.name || '', pt: p ? [p.lng, p.lat] : null };
        }catch(e){ return { name:'', pt:null }; }
      };
      w.setSearchCompleteCallback(()=>{
        try{
          const pl = w.getResults();
          if (!pl || pl.getNumPlans() === 0) return fin(null);
          const plan = pl.getPlan(0);
          const num = (typeof plan.getNumLines === 'function') ? plan.getNumLines() : 0;
          const lines = [];
          for (let i = 0; i < num; i++){
            const ln = plan.getLine(i);
            if (!ln) continue;
            const on = stopOf('getGetOnStop', ln), off = stopOf('getGetOffStop', ln);
            let path = [];
            try{
              const p = (typeof ln.getPath === 'function') ? ln.getPath()
                      : (typeof ln.getPathIn === 'function' ? ln.getPathIn() : null);
              if (p && p.length) path = p.map(q=>[+q.lng.toFixed(6), +q.lat.toFixed(6)]);
            }catch(e){}
            lines.push({
              name: (typeof ln.getTitle === 'function' ? ln.getTitle() : '') || '',
              from: on.name, to: off.name, onPt: on.pt, offPt: off.pt,
              via : (typeof ln.getNumViaStops === 'function') ? ln.getNumViaStops() : null,
              dist: (typeof ln.getDistance === 'function') ? ln.getDistance() : null,
              path,
            });
          }
          const safe = fn => { try{ return typeof plan[fn]==='function' ? plan[fn]() : null; }catch(e){ return null; } };
          fin({
            distance: safe('getDistance'),
            duration: safe('getDuration'),
            walkDistance: safe('getWalkDistance'),
            description: safe('getDescription'),
            lines,
          });
        }catch(e){ fin(null); }
      });
      try{ w.search(new G.Point(from[0], from[1]), new G.Point(to[0], to[1])); }
      catch(e){ fin(null); }
      setTimeout(()=>fin(null), 9000);
    });
    if (global.KDRQuota){
      return global.KDRQuota.call('routing', args, run, {
        cacheIf: d => !!(d && d.lines && d.lines.length)
      }).then(r=>r.data).catch(()=>null);
    }
    return run();
  }

  /* ② 沿路径累计距离取点（等时圈落点） */
  function pointAtDistance(path, budget){
    if (!path || path.length < 2) return null;
    let acc = 0;
    for (let i=1;i<path.length;i++){
      const dx = (path[i][0]-path[i-1][0]) * R_EARTH * Math.cos(path[i][1]*Math.PI/180);
      const dy = (path[i][1]-path[i-1][1]) * R_EARTH;
      const seg = Math.hypot(dx, dy);
      if (acc + seg >= budget){
        const t = (budget - acc) / (seg || 1);
        return [ +(path[i-1][0] + (path[i][0]-path[i-1][0])*t).toFixed(6),
                 +(path[i-1][1] + (path[i][1]-path[i-1][1])*t).toFixed(6) ];
      }
      acc += seg;
    }
    return path[path.length-1];
  }

  /* ③ 周边关键词检索
     ⚠️ 实测：连续 new LocalSearch 只有第一个能用，必须复用单一实例 */
  let _ls = null, _lsResolve = null;
  function lsInstance(){
    if (_ls) return _ls;
    const G = global.BMapGL;
    _ls = new G.LocalSearch(map, {
      pageCapacity: 15,
      onSearchComplete(rs){
        const cb = _lsResolve; _lsResolve = null;
        if (!cb) return;
        const out = [];
        try{
          if (_ls.getStatus() === BMAP_STATUS_SUCCESS && rs){
            const n = rs.getCurrentNumPois();
            for (let i=0;i<n;i++){
              const q = rs.getPoi(i);
              if (!q || !q.point) continue;
              out.push({ name:q.title, addr:q.address||'',
                         bd09:[+q.point.lng.toFixed(6), +q.point.lat.toFixed(6)] });
            }
          }
        }catch(e){}
        cb(out);
      }
    });
    return _ls;
  }
  function searchNearby(keyword, center, radius, count){
    return new Promise(res=>{
      if (!ready) return res([]);
      const ls = lsInstance();
      let settled = false;
      const done = v => { if (settled) return; settled = true;
                          if (_lsResolve === done) _lsResolve = null; res(v); };
      _lsResolve = done;
      /* ★ 关键：searchNearby **受地图当前视口影响**。
         地图若停在别的城市（例如 IP 定位到的城市），检索会返回空。
         所以：先把地图移到检索中心 → 等瓦片切换 → 再检索；
         仍为空则自动重试一次（跨省跳转时首次常来不及）。 */
      const P = new global.BMapGL.Point(center[0], center[1]);
      try{ map.centerAndZoom(P, 13); }catch(e){}
      const fire = ()=>{
        try{ ls.searchNearby(keyword, P, radius || 5000); }
        catch(e){ done([]); }
      };
      setTimeout(fire, 1800);
      /* 空结果重试 */
      const origDone = done;
      let tries = 0;
      const guarded = v => {
        if (v && v.length){ origDone(v); return; }
        if (++tries < 2){
          /* ⚠️ onSearchComplete 在回调前已把 _lsResolve 置空，
             重试前必须重新挂上，否则第二次的结果没人接。 */
          _lsResolve = guarded;
          try{ map.panTo(P); }catch(e){}
          setTimeout(fire, 1600);
          return;
        }
        origDone(v);
      };
      _lsResolve = guarded;
      setTimeout(()=>origDone([]), 24000);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     ④ 逆地理编码取周边 POI
     ──────────────────────────────────────────────────────────────
     用途：地点检索（100/日）额度耗尽时，改用它来拿周边设施。
     逆地理编码有 5,000/日，而且返回里带 surroundingPois。
     做法：在目标区域撒网格点，逐点逆地理编码，汇总去重。
     ══════════════════════════════════════════════════════════════ */
  function reversePois(pt, radiusM){
    return new Promise(res=>{
      if (!ready) return res([]);
      const G = global.BMapGL;
      const g = new G.Geocoder();
      let done = false;
      const fin = v => { if (!done){ done = true; res(v); } };
      try{
        g.getLocation(new G.Point(pt[0], pt[1]), r=>{
          const out = [];
          try{
            const sp = (r && r.surroundingPois) || [];
            sp.forEach(q=>{
              if (!q || !q.point) return;
              out.push({ name:q.title||'', addr:q.address||'',
                         bd09:[+q.point.lng.toFixed(6), +q.point.lat.toFixed(6)],
                         tag:(q.tags||'') });
            });
          }catch(e){}
          fin(out);
        }, { poiRadius: radiusM || 1000, numPois: 20 });
      }catch(e){ fin([]); }
      setTimeout(()=>fin([]), 12000);
    });
  }

  /* 单点逆地理编码：给地图选点补齐省 / 市 / 区县 / 乡镇 / 具体地址。
     地图点击返回的已经是 BD09，直接交给 BMapGL.Geocoder，不再转换坐标。 */
  function reverseGeocodeRaw(pt){
    return new Promise(res=>{
      if (!ready || !pt || typeof pt[0] !== 'number' || typeof pt[1] !== 'number')
        return res(null);
      const G = global.BMapGL;
      const g = new G.Geocoder();
      let done = false;
      const fin = v => { if (!done){ done = true; res(v); } };
      try{
        g.getLocation(new G.Point(pt[0], pt[1]), r=>{
          try{
            const ac = (r && r.addressComponents) || {};
            const address = (r && (r.address || r.addressInfo)) || '';
            const nearby = (r && r.surroundingPois && r.surroundingPois[0]) || null;
            const poi = (nearby && (nearby.title || nearby.name)) || (r && r.business) || '';
            fin({
              address,
              province: ac.province || '',
              city: ac.city || '',
              district: ac.district || '',
              town: ac.town || ac.township || ac.townshipName || '',
              street: ac.street || '',
              streetNumber: ac.streetNumber || '',
              poi: poi || '',
              point: [pt[0], pt[1]],
            });
          }catch(e){ fin(null); }
        });
      }catch(e){ fin(null); }
      setTimeout(()=>fin(null), 12000);
    });
  }
  function reverseGeocode(pt){
    const args = ['point', +Number(pt[0]).toFixed(6), +Number(pt[1]).toFixed(6)];
    const run = ()=>reverseGeocodeRaw(pt);
    if (global.KDRQuota){
      return global.KDRQuota.call('regeocode', args, run, {
        cacheIf: d => !!(d && (d.address || d.city || d.district))
      }).then(r=>r.data).catch(()=>null);
    }
    return run();
  }

  /* 驾车分段的 JSAPI 结果经常只有几何点和距离，没有道路名。
     只在用户打开正式路线页时由上层按需调用，避免为每家住宿预先消耗逆地理编码额度。 */
  async function enrichDrivingRoute(route){
    if (!route || !Array.isArray(route.steps) || !route.steps.length)
      return route || null;
    if (route._roadEnriched) return route;

    const steps = await Promise.all(route.steps.map(async step=>{
      if (!step || step.road || !step.pt) return step;
      const geo = await reverseGeocode(step.pt).catch(()=>null);
      const road = geo && String(geo.street || '').trim();
      return road ? Object.assign({}, step, { road }) : step;
    }));
    return Object.assign({}, route, { steps, _roadEnriched:true });
  }

  /* 网格撒点批量取 POI */
  async function reverseGrid(center, spanM, step){
    const byKey = {};
    const cols = Math.max(2, Math.round(spanM*2/step));
    const jobs = [];
    for (let i=0;i<cols;i++){
      for (let j=0;j<cols;j++){
        const dx = -spanM + i*(2*spanM/(cols-1));
        const dy = -spanM + j*(2*spanM/(cols-1));
        jobs.push([ center[0] + dx/(R_EARTH*Math.cos(center[1]*Math.PI/180)),
                    center[1] + dy/R_EARTH ]);
      }
    }
    for (const pt of jobs){
      /* ⚠️ 必须走配额守卫 —— 否则逆地理编码的消耗不会被计数 */
      let list = [];
      try{
        if (global.KDRQuota){
          const r = await global.KDRQuota.call('regeocode',
            ['grid', pt[0].toFixed(4), pt[1].toFixed(4)],
            ()=>reversePois(pt, step));
          list = r.data || [];
        } else {
          list = await reversePois(pt, step);
        }
      }catch(e){
        if (e.message === 'QUOTA_GUARD') break;   // 熔断就停手
      }
      list.forEach(p=>{
        const k = p.name + '|' + p.bd09.join(',');
        if (!byKey[k]) byKey[k] = p;
      });
    }
    return Object.values(byKey);
  }

  /* ── 在候选点上打编号标记，并把视口框到所有候选 ── */
  function showCandidates(list){
    if (!ready || !list || !list.length) return;
    clearCandidates();
    const G = global.BMapGL;
    const marks = [], pts = [];
    list.forEach((c, i)=>{
      const pt = new G.Point(c.pt[0], c.pt[1]);
      pts.push(pt);
      const mk = new G.Label(String(i+1), { position:pt, offset:new G.Size(-9, -9) });
      mk.setStyle({ background:'#FF8A3D', color:'#160C04', border:'2px solid #0B1220',
                    borderRadius:'50%', padding:'2px 7px', fontSize:'11px',
                    fontWeight:'700', cursor:'pointer' });
      mk.addEventListener('click', ()=>{ if (onCandClick) onCandClick(i); });
      map.addOverlay(mk);
      marks.push(mk);
      const nm = new G.Label(c.name, { position:pt, offset:new G.Size(12, -8) });
      nm.setStyle({ color:'#FFD9B0', background:'rgba(11,18,32,.85)',
                    border:'1px solid rgba(255,138,61,.4)', padding:'2px 7px',
                    borderRadius:'5px', fontSize:'11px' });
      map.addOverlay(nm);
      marks.push(nm);
    });
    layers.cands = marks;
    try{ map.setViewport(pts, { margins:[60,60,60,60] }); }catch(e){}
  }
  function clearCandidates(){
    (layers.cands || []).forEach(o=>{ try{ map.removeOverlay(o); }catch(e){} });
    layers.cands = [];
  }

  global.KDRMap = {
    init, render, paintRain, focus, locate, locateByIp, wgs84ToBd09, setTheme, setMapMode, getMapMode,
    isReady: ()=>ready,
    getMap: ()=>map,
    onSelectHotel: (f)=>{ onSelect = f; },
    onCenterDrag: (f)=>{ onCenterDrag = f; },
    onPoiClick: (f)=>{ onPoiClick = f; },
    clearRoutes, drawRoute, setPickMode, onMapPick, showNameCard, hideNameCard,
    route, transit, pointAtDistance, searchNearby, enrichDrivingRoute,
    bd09ToWgs84, gcj02ToWgs84, bd09ToGcj02, reversePois, reverseGeocode, reverseGrid,
    showCandidates, clearCandidates,
    onCandClick: (f)=>{ onCandClick = f; },
    setPickGuard: (f)=>{ pickGuard = f; },
    canPick: ()=> pickGuard ? !!pickGuard() : true,
  };
})(window);
