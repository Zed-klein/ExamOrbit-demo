/* ══════════════════════════════════════════════════════════════
   配额守卫 · quota.js
   ──────────────────────────────────────────────────────────────
   已核实的百度配额（个人开发者，来源：开发者权益页）：
     地图渲染 / 覆盖物 .......... 不计次（官方 FAQ 明示）
     地理编码 ................... 5,000/日
     逆地理编码 ................. 5,000/日（走 JS API；服务端仅 300）
     定位 ....................... 5,000/日
     步行/骑行/驾车路线规划 ..... 5,000/日
     地点检索 ................... 100/日  ⚠️ 超了当天禁用、不可恢复

   本模块做四件事：
     1. 本地计数（localStorage，跨刷新累计，次日归零）
     2. 阈值熔断：到达 hard 上限直接拒绝，不发请求
     3. 结果缓存：同样参数第二次调用不发请求
     4. 串行队列：全局限速 3 QPS，严禁并发（官方并发上限）
   ══════════════════════════════════════════════════════════════ */
(function(global){
  'use strict';

  const NS = 'kdr_q_';
  const LIMITS = (global.KDR_AK && global.KDR_AK.limits) || {
    placeSearch:100, geocoding:5000, geolocation:5000, routing:5000
  };

  /* 熔断阈值：到 90% 就拒绝，留出余量避免被"当天禁用" */
  const SOFT = 0.90;

  function today(){ return new Date().toISOString().slice(0,10); }

  function load(){
    try{
      const raw = JSON.parse(localStorage.getItem(NS+'state') || 'null');
      if (raw && raw.day === today()) return raw;
    }catch(e){}
    return { day: today(), counts: {}, cache: {} };
  }
  function save(st){
    try{ localStorage.setItem(NS+'state', JSON.stringify(st)); }catch(e){}
  }

  let state = load();

  /* 计数类别 → 配额表键。逆地理编码与地理编码共用 5,000 额度 */
  const CAP_OF = {
    geocoding:'geocoding', regeocode:'geocoding', regeocoding:'geocoding',
    geolocation:'geolocation', locate:'geolocation',
    routing:'routing', route:'routing',
    placeSearch:'placeSearch', search:'placeSearch',
  };
  function capOf(kind){
    const key = CAP_OF[kind] || kind;
    return LIMITS[key] || 0;
  }

  /* ── 计数查询 ── */
  function used(kind){
    const cap = capOf(kind);
    if (cap === 'geocoding'){
      return (state.counts.geocoding || 0) +
             (state.counts.regeocode || 0) +
             (state.counts.regeocoding || 0);
    }
    return state.counts[kind] || 0;
  }
  function remaining(kind){ return Math.max(0, capOf(kind) - used(kind)); }
  function allowed(kind){
    const cap = capOf(kind);
    if (!cap) return true;                       // 未登记的类别视为不计次
    return used(kind) < Math.floor(cap * SOFT);
  }
  function report(){
    const out = [];
    for (const k of ['placeSearch','geocoding','geolocation','routing']){
      const cap = capOf(k);
      if (!cap) continue;
      out.push({ kind:k, used:used(k), cap, remaining:remaining(k),
                 shared:false });
    }
    return out;
  }

  /* ── 缓存键 ── */
  function key(kind, args){
    return kind + '|' + JSON.stringify(args).replace(/\s+/g,'');
  }

  /* ── 串行队列：全局 3 QPS 限速 ── */
  const MIN_GAP = 350;                            // ms，3 QPS 留安全余量
  let chain = Promise.resolve();
  let lastAt = 0;

  function enqueue(fn){
    const run = chain.then(async ()=>{
      const wait = MIN_GAP - (Date.now() - lastAt);
      if (wait > 0) await new Promise(r=>setTimeout(r, wait));
      lastAt = Date.now();
      return fn();
    });
    chain = run.catch(()=>{});                    // 单次失败不阻断队列
    return run;
  }

  /* ── 主入口：所有计次调用都必须走这里 ──
     kind    : 'geocoding' | 'geolocation' | 'routing' | 'placeSearch' ...
     args    : 参与缓存键的参数数组
     fn      : 返回 Promise 的真实调用
     opts.cache: 是否启用缓存（默认 true）—— 定位不应缓存，每次都是新位置
  */
  async function call(kind, args, fn, opts){
    opts = opts || {};
    const useCache = opts.cache !== false;

    if (!allowed(kind)){
      const e = new Error('QUOTA_GUARD');
      e.kind = kind; e.used = used(kind); e.cap = capOf(kind);
      throw e;
    }

    const k = key(kind, args);
    if (useCache && state.cache[k]){
      return { data: state.cache[k], cached: true };
    }

    /* ⚠️ 先计数再发请求。
       原因：请求一旦发出，**服务端就已经计入额度了**，哪怕它返回失败
       （实测：地理编码返回空结果时，本地计数没涨，但控制台额度涨了）。
       失败不退还，宁可想多算也不能漏算 —— 地点检索超限当天不可恢复。 */
    state = load();
    state.counts[kind] = (state.counts[kind] || 0) + 1;
    save(state);
    emit();

    const data = await enqueue(fn);

    /* 只缓存「有内容」的结果。
       否则一次失败（空数组 / null）会被永久缓存，重试永远拿到空 ——
       实测踩过：服务点检索第一个考点成功后其余失败，空结果进了缓存，
       导致重跑时直接命中缓存、连请求都不发。 */
    const worth = opts.cacheIf ? !!opts.cacheIf(data)
                               : !(data == null || (Array.isArray(data) && data.length === 0));
    if (useCache && worth){
      state = load();
      state.cache[k] = data;
      const keys = Object.keys(state.cache);
      if (keys.length > 400) delete state.cache[keys[0]];
      save(state);
    }
    return { data, cached: false };
  }

  /* ── 变更通知，供 UI 刷新配额条 ── */
  const listeners = [];
  function emit(){ listeners.forEach(f=>{ try{ f(report()); }catch(e){} }); }
  function onChange(f){ listeners.push(f); }

  function reset(){
    state = { day: today(), counts:{}, cache:{} };
    save(state); emit();
  }

  /* 只清缓存、保留计数。
     用途：抽取逻辑改了之后需要重跑，但历史消耗必须如实保留。*/
  function clearCache(){
    state = load();
    state.cache = {};
    save(state);
  }

  global.KDRQuota = {
    LIMITS, call, report, used, remaining, allowed, onChange, reset, clearCache,
    isFree: ()=>false,
  };
})(window);
