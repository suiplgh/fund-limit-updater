#!/usr/bin/env node
/* ============================================================
   GitHub Actions 版 · 抓 6 个代理标的实时行情 → 按 8 份权重算组合盘中估值 → 写 Gist portfolio.json

   组合（8 份权重）：
     红利低波100A 021550 → 场内 515100 红利低波100ETF景顺   1 份（跟踪中证红利低波动100指数）
     红利质量A    016440 → 场内 159758 红利质量ETF华夏       1 份（该联接基金的目标ETF，跟踪931468）
     自由现金流A  023917 → 场内 159201 自由现金流ETF华夏     1 份（该联接基金的目标ETF，跟踪980092）
     标普500E     018738 → .INX 标普500指数                  2 份（美股休市时=隔夜收盘死数）
     纳指100I     021000 → .NDX 纳斯达克100指数              2 份（美股休市时=隔夜收盘死数）
     黄金A        008701 → 场内 518850 黄金ETF华夏           1 份（该联接基金的目标ETF）

   口径 LIVE（v2.11，用户定稿）：盘中估算 —— A股4只用交易时段实时价、美股2只休市时取隔夜收盘，
   按份数加权。这是"估算"不是官方净值，允许盘中变来变去。
   ⚠️ 旧口径 B（6只基金共同净值日加权）已废弃，见 bak-v211-before-live。

   数据源：腾讯行情 qt.gtimg.cn（海外 runner 实测可连，1 秒返回；东财 push2 海外超时不可用）。
   一次批量请求 6 个代码，解析「现价 / 昨收」自算涨跌幅（比字段位更稳）。
   token 从环境变量 GIST_TOKEN（仓库 Secret）读取。
   ============================================================ */
const GIST_ID = "96bbc2e049cd6b2b31bf1f6bc3d2f43c";
const GIST_FILE = "portfolio.json";
const QUOTE_URL = "https://qt.gtimg.cn/q=sh515100,sz159758,sz159201,usINX,usNDX,sh518850";

// key=腾讯代码, fund=对应基金代码, shares=份数
const LEGS = [
  { key: "sh515100", fund: "021550", name: "红利低波100", shares: 1 },
  { key: "sz159758", fund: "016440", name: "红利质量",   shares: 1 },
  { key: "sz159201", fund: "023917", name: "自由现金流", shares: 1 },
  { key: "usINX",    fund: "018738", name: "标普500",    shares: 2 },
  { key: "usNDX",    fund: "021000", name: "纳指100",    shares: 2 },
  { key: "sh518850", fund: "008701", name: "黄金",       shares: 1 },
];
const TOTAL_SHARES = LEGS.reduce((s, x) => s + x.shares, 0); // 8

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// 抓一次批量行情，返回 { key: {price, prev, pct, time} }
async function fetchQuotes() {
  let text = null;
  for (let attempt = 0; attempt < 3 && !text; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await fetch(QUOTE_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) continue;
      const t = await r.text();
      // 正常返回形如 v_sh515100="1~红利低波100ETF景顺~515100~1.475~1.485~..."; 每行一个
      if (t && t.indexOf("v_sh515100") >= 0) text = t;
    } catch (e) { /* 重试 */ }
  }
  if (!text) throw new Error("腾讯行情抓取失败（重试 3 次）");

  const out = {};
  // 每个标的用正则抠出引号内字段，按 ~ 切分
  for (const leg of LEGS) {
    const m = text.match(new RegExp('v_' + leg.key + '="([^"]*)"'));
    if (!m) throw new Error(leg.key + " 行情缺失");
    const f = m[1].split("~");
    // 腾讯字段：f[3]=现价 f[4]=昨收 f[30]=时间 f[32]=涨跌%(自算校验用)
    const price = num(f[3]);
    const prev = num(f[4]);
    if (price === null || prev === null || !(prev > 0)) throw new Error(leg.key + " 价格无效");
    const pct = Number((((price - prev) / prev) * 100).toFixed(2));
    out[leg.key] = { price, prev, pct, time: f[30] || "" };
  }
  return out;
}

function ghApi(method, urlPath, body, token) {
  const opts = {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "jswidget-portfolio",
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch("https://api.github.com" + urlPath, opts).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!r.ok) throw new Error("GitHub API " + method + " " + r.status + " " + text.slice(0, 200));
    return json;
  });
}

async function main() {
  const token = process.env.GIST_TOKEN;
  if (!token) throw new Error("缺少 GIST_TOKEN 环境变量");

  const quotes = await fetchQuotes();

  let sum = 0;
  const detail = [];
  for (const leg of LEGS) {
    const q = quotes[leg.key];
    sum += q.pct * leg.shares;
    detail.push({ fund: leg.fund, proxy: leg.key, s: leg.shares, pct: q.pct, time: q.time });
  }
  const pct = Number((sum / TOTAL_SHARES).toFixed(2));
  const ts = Date.now(); // 数据生成时刻 = 保鲜锚点
  // date 给组件做结构校验用（组件不显示日期）；取 A股行情日期，形如 20261123141942 → 2026-11-23
  const t0 = quotes["sh515100"].time || "";
  const date = /^\d{14}$/.test(t0) ? (t0.slice(0,4)+"-"+t0.slice(4,6)+"-"+t0.slice(6,8)) : new Date(ts).toISOString().slice(0,10);

  const record = { pct, date, ts, mode: "LIVE", detail };
  const content = JSON.stringify(record);
  console.log("行情时刻:", t0, "组合盘中估值:", pct + "%");
  detail.forEach((d) => console.log("  ", d.fund, "←", d.proxy, d.pct + "%", "×" + d.s, "@", d.time));

  const updated = await ghApi("PATCH", "/gists/" + GIST_ID, {
    files: { [GIST_FILE]: { content } },
  }, token);
  if (!updated.files[GIST_FILE]) throw new Error("更新后未见 " + GIST_FILE);
  console.log("已推送 Gist:", GIST_FILE);

  // API 回读校验
  let ok = false;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    const auth = await ghApi("GET", "/gists/" + GIST_ID, null, token);
    const remote = JSON.parse(auth.files[GIST_FILE].content);
    if (remote.ts === record.ts) { ok = true; break; }
  }
  if (!ok) throw new Error("API 回读校验不一致！");
  console.log("API 回读校验一致, ts=", record.ts);
  console.log("DONE");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
