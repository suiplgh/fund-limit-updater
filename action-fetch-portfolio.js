#!/usr/bin/env node
/* ============================================================
   GitHub Actions 版 · 抓 6 只基金算组合当日收益率 → 写 Gist portfolio.json

   组合（8 份权重）：
     红利低波100A 021550 / 红利质量A 016440 / 自由现金流A 023917  各 1 份（A股红利共 3 份 = 37.5%）
     标普500联接E  018738  2 份（25%）
     纳指100发起I  021000  2 份（25%）
     黄金ETF联接A  008701  1 份（12.5%）

   口径 B（用户定稿）：取 6 只基金【共同净值日】里最近一天的官方日增长率 JZZZL，
   按份数加权求和。QDII（标普/纳指）净值天然晚一天，硬拼不同日期会失真，
   所以只在同一净值日上算，宁可日期旧一天也要口径一致。

   数据源：天天基金历史净值接口 api.fund.eastmoney.com/f10/lsjz（JZZZL=官方日增长率%）。
   token 从环境变量 GIST_TOKEN（仓库 Secret）读取。
   ============================================================ */
const GIST_ID = "96bbc2e049cd6b2b31bf1f6bc3d2f43c";
const GIST_FILE = "portfolio.json";
const LSJZ = "https://api.fund.eastmoney.com/f10/lsjz?fundCode=CODE&pageIndex=1&pageSize=8&callback=";

const FUNDS = [
  { code: "021550", name: "博中证红利低波100联接A", shares: 1 },
  { code: "016440", name: "华夏中证红利质量联接A",   shares: 1 },
  { code: "023917", name: "华夏国证自由现金流联接A", shares: 1 },
  { code: "018738", name: "博时标普500联接E",        shares: 2 },
  { code: "021000", name: "南方纳指100发起I",        shares: 2 },
  { code: "008701", name: "华夏黄金ETF联接A",        shares: 1 },
];
const TOTAL_SHARES = FUNDS.reduce((s, f) => s + f.shares, 0); // 8

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

async function fetchFund(fund) {
  const url = LSJZ.replace("CODE", fund.code);
  const r = await fetch(url, {
    headers: {
      Referer: "https://fundf10.eastmoney.com/",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!r.ok) throw new Error(fund.code + " HTTP " + r.status);
  const j = await r.json();
  const list = j && j.Data && j.Data.LSJZList;
  if (!Array.isArray(list) || !list.length) throw new Error(fund.code + " 无净值数据");
  // date -> 日增长率%（只保留有数字的）
  const byDate = {};
  list.forEach((row) => {
    const pct = num(row.JZZZL);
    if (row.FSRQ && pct !== null) byDate[row.FSRQ] = pct;
  });
  return { ...fund, byDate, dates: Object.keys(byDate).sort().reverse() };
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

  // 全部发起、最后逐个收：并行抓，缩短 Actions 运行时间
  const pending = FUNDS.map((f) => fetchFund(f));
  const got = [];
  for (let i = 0; i < pending.length; i++) got.push(await pending[i]);

  // 找共同净值日：每只基金都有 JZZZL 的日期，取最近一天
  let common = got[0].dates.filter((d) => got.every((g) => g.byDate[d] !== undefined));
  common.sort().reverse();
  if (!common.length) throw new Error("无共同净值日，拒绝写入旧数据");
  const date = common[0];

  let sum = 0;
  const detail = [];
  for (const g of got) {
    const pct = g.byDate[date];
    sum += pct * g.shares;
    detail.push({ code: g.code, s: g.shares, pct: pct });
  }
  const pct = Number((sum / TOTAL_SHARES).toFixed(2));
  const ts = Date.now(); // 数据生成时刻 = 数据自带时间戳（组件侧保鲜锚点）

  const record = {
    pct: pct,
    date: date,
    ts: ts,
    mode: "B",
    detail: detail,
  };
  const content = JSON.stringify(record);
  console.log("净值日:", date, "组合收益率:", pct + "%");
  console.log("record:", content);

  const updated = await ghApi("PATCH", "/gists/" + GIST_ID, {
    files: { [GIST_FILE]: { content } },
  }, token);
  if (!updated.files[GIST_FILE]) throw new Error("更新后未见 " + GIST_FILE);
  console.log("已推送 Gist:", GIST_FILE);

  // API 权威回读校验（PATCH 后极短延迟，重试最多 3 次）
  let ok = false;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    const auth = await ghApi("GET", "/gists/" + GIST_ID, null, token);
    const remote = JSON.parse(auth.files[GIST_FILE].content);
    if (remote.ts === record.ts) { ok = true; break; }
  }
  if (!ok) throw new Error("API 回读校验不一致！");
  console.log("API 回读校验一致, ts=", record.ts);
  console.log("READ URL: https://gist.githubusercontent.com/suiplgh/" + GIST_ID + "/raw/" + GIST_FILE);
  console.log("DONE");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
