/* ══════════════════════════════════════════════════════════════
   百度地图 AK 配置（唯一真源）
   ──────────────────────────────────────────────────────────────
   ⚠️ 必须用「浏览器端」类型的 AK ⚠️⚠️
      控制台创建应用时二选一：
        · 浏览器端 → 填 Referer 白名单  → 本作品可用 ✅
        · 服务端   → 填 IP 白名单      → 浏览器会被拒 ❌
      用错会报「APP被您禁用啦」，且控制台里不会出现 Referer 白名单输入框。

   ⚠️ Referer 白名单格式：不写端口；多个用英文半角逗号分隔
       本地调试 / 双击打开 → 直接填 *（file:// 不发 Referer）
       正式提交前         → 收紧为你的域名
   ══════════════════════════════════════════════════════════════ */
(function(){
  /* ── 多把 AK ──
     实测：JSAPI 的 AK 在页面加载时绑定，**运行中无法热切换**。
     所以这里做成「可切换」：换 AK 需要重载页面。
     用途：地点检索 100 次/日 用完后，可切到备用 AK 继续检索。
     ⚠️ 官方明确「同账号下 AK 之间配额共用」——
        若两把 AK 属于同一账号，切换不会增加额度；属不同账号才会。 */
  const KEYS = [
    { id:'main',     label:'主 AK',   ak:'lpemAkHfTagbrwqsgXehxF136M0z9qNt' },
    { id:'backup',   label:'备用 AK', ak:'6BieYcWf89bgjJuSu2xoSBjossc9P0yr' },
  ];

  /* ★ 用户自定义 AK 优先级最高（在设置面板里填的那种） */
  let custom = '';
  try{ custom = localStorage.getItem('kdr_ak_custom') || ''; }catch(e){}

  /* 否则用内置的第 idx 把（存 localStorage，跨刷新保持） */
  let idx = 0;
  try{
    const saved = localStorage.getItem('kdr_ak_idx');
    if (saved !== null){ const n = parseInt(saved,10); if (n>=0 && n<KEYS.length) idx = n; }
  }catch(e){}

  const active = custom || KEYS[idx].ak;

  window.KDR_AK = {
    keys: KEYS,
    get index(){ return idx; },
    get custom(){ return custom; },
    get usingCustom(){ return !!custom; },
    browser: active,
    /* 设置面板用 */
    setCustom: function(ak){
      ak = String(ak||'').trim();
      try{
        if (ak) localStorage.setItem('kdr_ak_custom', ak);
        else localStorage.removeItem('kdr_ak_custom');
      }catch(e){}
      custom = ak;
    },
    clearCustom: function(){
      try{ localStorage.removeItem('kdr_ak_custom'); }catch(e){}
      custom = '';
    },
    /* AK 有效性自检：直接问百度 JSAPI 自己的鉴权接口 */
    verify: function(ak, cb){
      const key = String(ak||'').trim() || active;
      const cbName = '__kdrAkVerify';
      const s = document.createElement('script');
      const timer = setTimeout(()=>{ cleanup(); cb({ error:-999, msg:'超时无响应' }); }, 12000);
      function cleanup(){ clearTimeout(timer); try{ delete window[cbName]; }catch(e){ window[cbName]=undefined; }
                          if (s.parentNode) s.parentNode.removeChild(s); }
      window[cbName] = function(r){
        cleanup();
        const code = r && typeof r.error !== 'undefined' ? r.error : -998;
        cb({ error:code, msg:(r && r.error_msg) || '' });
      };
      s.onerror = ()=>{ cleanup(); cb({ error:-997, msg:'脚本加载失败' }); };
      s.src = 'https://api.map.baidu.com/?qt=verify&v=3.0&type=webgl&ak='
            + encodeURIComponent(key) + '&time=' + Date.now() + '&callback=' + cbName;
      document.head.appendChild(s);
    },
    /* 备用 AK 是否可用（存在且不是同一把） */
    hasBackup: () => KEYS.length > 1,
    switchTo: function(i){
      if (i < 0 || i >= KEYS.length) return false;
      try{ localStorage.setItem('kdr_ak_idx', String(i)); }catch(e){}
      return true;
    },
    /* 服务端 AK（构建期用；本项目运行期不需要） */
    server: '',
    /* 额度硬上限：本地熔断用 */
    limits: {
      placeSearch: 100,   // ⚠️ 每日 100，超了当天禁用不可恢复
      geocoding:   5000,
      regeocode:   5000,
      geolocation: 5000,
      routing:     5000,
    },
  };
})();
