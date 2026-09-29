/* ══════════════════════════════════════════════════════════════
   天气模块 · weather.js
   ──────────────────────────────────────────────────────────────
   数据源：Open-Meteo —— 免 Key、无配额、前端可直连。
     · 实时/预报  https://api.open-meteo.com/v1/forecast
     · 历史气候  https://archive-api.open-meteo.com/v1/archive

   三种模式（对应 PRD 的「天气三模式」）：
     current  当前实况（顶层状态栏用）
     forecast 考试日在 16 天内 → 真实逐小时预报
     climate  考试日超出 16 天 → 取过去 N 年同一天，算历史降水概率

   ⚠️ Open-Meteo 用 WGS84 坐标；快照里的 center.wgs84 正合适。
   ══════════════════════════════════════════════════════════════ */
(function(global){
  'use strict';

  const FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const ARCHIVE  = 'https://archive-api.open-meteo.com/v1/archive';
  const TZ = 'Asia/Shanghai';
  const CACHE_NS = 'kdr_wx_';

  /* WMO 天气代码 → 中文 + 图标 */
  const WMO = {
    0:['晴','☀️'], 1:['晴间多云','🌤'], 2:['少云','⛅'], 3:['阴','☁️'],
    45:['有雾','🌫'], 48:['雾凇','🌫'],
    51:['小毛毛雨','🌦'], 53:['毛毛雨','🌦'], 55:['大毛毛雨','🌦'],
    56:['冻毛毛雨','🌧'], 57:['冻毛毛雨','🌧'],
    61:['小雨','🌦'], 63:['中雨','🌧'], 65:['大雨','🌧'],
    66:['冻雨','🌧'], 67:['冻雨','🌧'],
    71:['小雪','🌨'], 73:['中雪','🌨'], 75:['大雪','❄️'], 77:['米雪','🌨'],
    80:['阵雨','🌦'], 81:['中阵雨','🌧'], 82:['强阵雨','⛈'],
    85:['阵雪','🌨'], 86:['强阵雪','🌨'],
    95:['雷阵雨','⛈'], 96:['雷阵雨伴冰雹','⛈'], 99:['强雷暴伴冰雹','⛈'],
  };
  const wmo = c => WMO[c] || ['未知','❓'];

  /* ── 小工具 ── */
  function pad(n){ return String(n).padStart(2,'0'); }
  function ymd(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  function today(){ return new Date(); }
  function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  function dayDiff(a,b){          // b - a，按自然日
    const A=new Date(a.getFullYear(),a.getMonth(),a.getDate());
    const B=new Date(b.getFullYear(),b.getMonth(),b.getDate());
    return Math.round((B-A)/86400000);
  }
  function cacheGet(k, ttlMs){
    try{
      const o = JSON.parse(localStorage.getItem(CACHE_NS+k)||'null');
      if (o && Date.now()-o.t < ttlMs) return o.v;
    }catch(e){}
    return null;
  }
  function cacheSet(k, v){
    try{ localStorage.setItem(CACHE_NS+k, JSON.stringify({t:Date.now(), v})); }catch(e){}
  }
  async function jget(url){
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }

  /* ══ 当前实况 ══ */
  async function current(lat, lng){
    const ck = 'cur_'+lat.toFixed(3)+'_'+lng.toFixed(3);
    const hit = cacheGet(ck, 10*60*1000);           // 10 分钟缓存
    if (hit) return hit;

    const u = FORECAST + '?latitude='+lat+'&longitude='+lng
      + '&current=temperature_2m,apparent_temperature,precipitation,weather_code,'
      + 'wind_speed_10m,relative_humidity_2m&timezone='+TZ;
    const d = await jget(u);
    const c = d.current || {};
    const [desc, icon] = wmo(c.weather_code);
    const out = {
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      precip: c.precipitation,
      wind: c.wind_speed_10m,
      humidity: c.relative_humidity_2m,
      code: c.weather_code,
      desc, icon,
      time: c.time,
    };
    cacheSet(ck, out);
    return out;
  }

  /* ══ 某一天的逐小时降水 ══
     返回 { mode, date, hours:[{h, precip, prob, temp}], stats }
     mode: 'forecast'（16 天内真实预报）| 'climate'（历史气候概率）
  */
  async function day(lat, lng, dateStr, opts){
    opts = opts || {};
    const years = opts.years || 5;
    const target = new Date(dateStr + 'T12:00:00');
    const diff = dayDiff(today(), target);

    if (diff >= 0 && diff <= 15){
      try { return await forecastDay(lat, lng, dateStr); }
      catch(e){ /* 预报失败则回落到气候 */ }
    }
    return await climateDay(lat, lng, target, years);
  }

  async function forecastDay(lat, lng, dateStr){
    const ck = 'fc_'+lat.toFixed(2)+'_'+lng.toFixed(2)+'_'+dateStr;
    const hit = cacheGet(ck, 30*60*1000);
    if (hit) return hit;

    const u = FORECAST + '?latitude='+lat+'&longitude='+lng
      + '&hourly=precipitation,precipitation_probability,temperature_2m,weather_code'
      + '&timezone='+TZ+'&start_date='+dateStr+'&end_date='+dateStr;
    const d = await jget(u);
    const H = d.hourly || {};
    const hours = (H.time||[]).map((t,i)=>({
      h: +t.slice(11,13),
      precip: H.precipitation ? (H.precipitation[i]||0) : 0,
      prob:   H.precipitation_probability ? (H.precipitation_probability[i]||0) : 0,
      temp:   H.temperature_2m ? H.temperature_2m[i] : null,
      code:   H.weather_code ? H.weather_code[i] : null,
    }));
    const out = { mode:'forecast', date:dateStr, hours, stats: stats(hours) };
    cacheSet(ck, out);
    return out;
  }

  async function climateDay(lat, lng, target, years){
    const md = pad(target.getMonth()+1) + '-' + pad(target.getDate());
    const ck = 'cl_'+lat.toFixed(2)+'_'+lng.toFixed(2)+'_'+md+'_'+years;
    const hit = cacheGet(ck, 30*24*60*60*1000);      // 气候数据 30 天缓存
    if (hit) return hit;

    /* 取过去 years 年同一天，逐年请求后按小时求平均 */
    const thisYear = today().getFullYear();
    const reqs = [];
    for (let i=1;i<=years;i++){
      const y = thisYear - i;
      const ds = y + '-' + md, de = y + '-' + md;
      reqs.push(
        jget(ARCHIVE + '?latitude='+lat+'&longitude='+lng
          + '&hourly=precipitation,temperature_2m&timezone='+TZ
          + '&start_date='+ds+'&end_date='+de)
          .then(d=>d.hourly||null).catch(()=>null)
      );
    }
    const all = (await Promise.all(reqs)).filter(Boolean);

    const acc = Array.from({length:24},()=>({p:0,t:0,n:0,rainy:0}));
    all.forEach(h=>{
      (h.time||[]).forEach((t,i)=>{
        const hr = +t.slice(11,13);
        const p = h.precipitation ? (h.precipitation[i]||0) : 0;
        acc[hr].p += p; acc[hr].n++;
        if (p >= 0.1) acc[hr].rainy++;
        if (h.temperature_2m && h.temperature_2m[i]!=null) acc[hr].t += h.temperature_2m[i];
      });
    });

    const hours = acc.map((a,i)=>({
      h:i,
      precip: a.n ? +(a.p/a.n).toFixed(2) : 0,
      prob:   a.n ? Math.round(a.rainy/a.n*100) : 0,
      temp:   a.n ? +(a.t/a.n).toFixed(1) : null,
      code: null,
    }));
    const out = { mode:'climate', date:ymd(target), years: all.length, hours, stats: stats(hours) };
    cacheSet(ck, out);
    return out;
  }

  /* ── 多天预报：一次请求拿一段日期（Open-Meteo 支持 start/end_date）──
     天气弹窗要「近三天」，逐天请求是 3 次；一次拿完只算 1 次。 */
  async function forecastRange(lat, lng, startDate, days){
    days = days || 3;
    const start = new Date(startDate + 'T12:00:00');
    const end   = ymd(addDays(start, days - 1));
    const ck = 'fr_' + lat.toFixed(2) + '_' + lng.toFixed(2) + '_' + startDate + '_' + days;
    const hit = cacheGet(ck, 30*60*1000);
    if (hit) return hit;

    const u = FORECAST + '?latitude=' + lat + '&longitude=' + lng
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max'
      + '&hourly=precipitation'
      + '&timezone=' + TZ + '&start_date=' + startDate + '&end_date=' + end;
    const d = await jget(u);
    const D = d.daily || {}, H = d.hourly || {};
    const out = (D.time || []).map((t, i) => {
      const hours = [];
      (H.time || []).forEach((tt, j) => {
        if (tt.slice(0, 10) !== t) return;
        hours.push({ h: +tt.slice(11, 13), precip: H.precipitation ? (H.precipitation[j] || 0) : 0 });
      });
      return {
        date: t,
        code: D.weather_code ? D.weather_code[i] : null,
        tmax: D.temperature_2m_max ? D.temperature_2m_max[i] : null,
        tmin: D.temperature_2m_min ? D.temperature_2m_min[i] : null,
        precip: D.precipitation_sum ? (D.precipitation_sum[i] || 0) : 0,
        prob: D.precipitation_probability_max ? D.precipitation_probability_max[i] : null,
        hours,
      };
    });
    cacheSet(ck, out);
    return out;
  }

  /* ── 历史当天：过去 N 年「同一天」实际记录的天气（逐年列出，不做平均）──
     气候平均只说明「大概率」，用户想看的是「往年这天到底下没下雨」。 */
  async function historySameDay(lat, lng, dateStr, years){
    years = years || 5;
    const t = new Date(dateStr + 'T12:00:00');
    const md = pad(t.getMonth()+1) + '-' + pad(t.getDate());
    const ck = 'hs_' + lat.toFixed(2) + '_' + lng.toFixed(2) + '_' + md + '_' + years;
    const hit = cacheGet(ck, 30*24*60*60*1000);
    if (hit) return hit;

    const thisYear = today().getFullYear();
    const reqs = [];
    for (let i = 1; i <= years; i++){
      const y = thisYear - i;
      const ds = y + '-' + md;
      reqs.push(
        jget(ARCHIVE + '?latitude=' + lat + '&longitude=' + lng
          + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum'
          + '&timezone=' + TZ + '&start_date=' + ds + '&end_date=' + ds)
          .then(d => {
            const D = d.daily || {};
            if (!D.time || !D.time.length) return null;
            return { year: y, date: D.time[0],
                     code: D.weather_code ? D.weather_code[0] : null,
                     tmax: D.temperature_2m_max ? D.temperature_2m_max[0] : null,
                     tmin: D.temperature_2m_min ? D.temperature_2m_min[0] : null,
                     precip: D.precipitation_sum ? (D.precipitation_sum[0] || 0) : 0 };
          })
          .catch(()=>null)
      );
    }
    const out = (await Promise.all(reqs)).filter(Boolean).sort((a,b)=>b.year - a.year);
    cacheSet(ck, out);
    return out;
  }

  function stats(hours){
    let mm = 0, peak = 0, peakH = null, wetH = 0;
    hours.forEach(x=>{
      mm += x.precip;
      if (x.precip > peak){ peak = x.precip; peakH = x.h; }
      if (x.precip >= 0.1) wetH++;
    });
    return {
      totalMM: +mm.toFixed(1),
      peakMM: +peak.toFixed(2),
      peakHour: peakH,
      wetHours: wetH,
      hasRain: wetH > 0,
      maxProb: hours.reduce((m,x)=>Math.max(m, x.prob||0), 0),
    };
  }

  /* 从逐小时序列取某个时刻的降水（线性插值）—— 淋雨推演用 */
  function precipAt(dayData, minutes){
    if (!dayData || !dayData.hours || !dayData.hours.length) return 0;
    const h = ((minutes/60) % 24 + 24) % 24;
    const i0 = Math.floor(h) % 24, i1 = (i0+1) % 24, t = h - Math.floor(h);
    const a = dayData.hours[i0] ? dayData.hours[i0].precip : 0;
    const b = dayData.hours[i1] ? dayData.hours[i1].precip : 0;
    return a + (b-a)*t;
  }

  global.KDRWeather = { current, day, forecastRange, historySameDay, precipAt, wmo, ymd, today, addDays, dayDiff };
})(window);
