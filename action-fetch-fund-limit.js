#!/usr/bin/env node
/* ============================================================
   GitHub Actions 版 · 抓取两只基金的当日限购额度
     1) 博时标普500ETF联接E (018738) → fund-limit.json 顶层（兼容旧结构）
     2) 南方纳斯达克100指数发起(QDII)I (021000) → nasdaq 子对象
   → 写 Gist → API 权威回读校验

   数据源：
     - 天天基金主站 HTML 抓「交易状态」→ state（暂停/限大额/开放）
     - 天天基金移动端 MAXSG 接口 → 额度数字（有则显示数字，无则显示状态词）
   token 从环境变量 GIST_TOKEN（仓库 Secret）读取。
   ============================================================ */
const GIST_ID = "96bbc2e049cd6b2b31bf1f6bc3d2f43c";
const GIST_FILE = "fund-limit.json";

const FUNDS = [
  { code: "018738", name: "博时标普500ETF联接E", key: null },          // 顶层
  { code: "021000", name: "南方纳斯达克100指数发起I", key: "nasdaq" }, // 子对象
];

// 从主站 HTML 解析交易状态（与旧逻辑一致）
function parseStatus(html) {
  if (typeof html !== "string" || html.indexOf("交易状态") < 0) throw new Error("页面内容异常");
  const seg = html.match(/交易状态：([\s\S]{0,500}?)<\/div>/);
  const block = seg ? seg[1] : "";
  if (!block) throw new Error("未找到交易状态区块");
  const out = { state: "未知", value: "--", unit: "", amount: null };
  const lim = block.match(/单日累计购买上限\s*([\d,.]+)\s*元/);
  if (lim) {
    const n = parseFloat(lim[1].replace(/,/g, ""));
    if (isFinite(n) && n > 0) {
      out.state = "限大额"; out.amount = n;
      out.value = String(parseFloat(n.toFixed(2))); out.unit = "元";
      return out;
    }
  }
  if (/暂停申购|暂停销售/.test(block)) { out.state = "暂停"; out.value = "暂停"; return out; }
  if (/开放申购|正常申购/.test(block)) { out.state = "开放"; out.value = "不限"; return out; }
  if (/限大额|限制大额/.test(block)) { out.state = "限大额"; out.value = "限额"; return out; }
  return out;
}

// 从移动端接口取额度数字 MAXSG（可能是 "--"）
async function fetchMaxSg(code) {
  const url = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?FCODE=" +
    code + "&deviceid=1&plat=Android&product=EFund&version=6.5.5";
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j && j.Datas;
    if (!d || typeof d !== "object") return null;
    const v = String(d.MAXSG == null ? "" : d.MAXSG).trim();
    if (!v || v === "--") return null;
    const n = parseFloat(v.replace(/,/g, ""));
    return isFinite(n) && n > 0 ? n : null;
  } catch (e) { return null; }
}

async function fetchFund(f) {
  console.log("fetch:", f.code, f.name);
  const resp = await fetch("https://fund.eastmoney.com/" + f.code + ".html", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status + " (" + f.code + ")");
  const html = await resp.text();
  const parsed = parseStatus(html);
  if (parsed.state === "未知") throw new Error("解析结果未知，拒绝写入 (" + f.code + ")");

  // 额度数字：优先主站 HTML 的「单日累计购买上限」，其次移动端 MAXSG。
  let amount = parsed.amount;
  if (amount === null) amount = await fetchMaxSg(f.code);
  if (amount !== null) {
    parsed.state = "限大额";
    parsed.value = String(parseFloat(amount.toFixed(2)));
    parsed.unit = "元";
    parsed.amount = amount;
  }
  console.log("parsed:", f.code, JSON.stringify(parsed));
  return parsed;
}

function fmtDate(now) {
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return bj.getUTCFullYear() + "-" + String(bj.getUTCMonth() + 1).padStart(2, "0") + "-" + String(bj.getUTCDate()).padStart(2, "0");
}

function ghApi(method, urlPath, body, token) {
  const opts = {
    method,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "jswidget-fund-limit-actions", "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch("https://api.github.com" + urlPath, opts).then(async r => {
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    if (!r.ok) throw new Error("GitHub API " + method + " " + r.status + " " + text.slice(0, 200));
    return json;
  });
}

async function main() {
  const token = process.env.GIST_TOKEN;
  if (!token) throw new Error("缺少 GIST_TOKEN 环境变量");

  const p0 = await fetchFund(FUNDS[0]);
  const p1 = await fetchFund(FUNDS[1]);
  const ts = Date.now();
  const date = fmtDate(new Date(ts));

  // 顶层 = 标普（保持旧结构字段，兼容旧版小组件）；nasdaq 子对象 = 南方纳指I
  const record = {
    code: FUNDS[0].code, name: FUNDS[0].name,
    state: p0.state, value: p0.value, unit: p0.unit, amount: p0.amount,
    date: date, ts: ts, source: "fund.eastmoney.com",
    nasdaq: {
      code: FUNDS[1].code, name: FUNDS[1].name,
      state: p1.state, value: p1.value, unit: p1.unit, amount: p1.amount,
    },
  };
  const content = JSON.stringify(record);
  console.log("record:", content);

  const updated = await ghApi("PATCH", "/gists/" + GIST_ID, { files: { [GIST_FILE]: { content } } }, token);
  if (!updated.files[GIST_FILE]) throw new Error("更新后未见 " + GIST_FILE);
  console.log("已推送 Gist:", GIST_FILE);

  // API 权威回读校验（PATCH 后极短延迟，重试最多 3 次）
  let ok = false;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000));
    const auth = await ghApi("GET", "/gists/" + GIST_ID, null, token);
    const remote = JSON.parse(auth.files[GIST_FILE].content);
    if (remote.ts === record.ts) { ok = true; break; }
  }
  if (!ok) throw new Error("API 回读校验不一致！");
  console.log("API 回读校验一致, ts=", record.ts);
  console.log("READ URL: https://gist.githubusercontent.com/suiplgh/" + GIST_ID + "/raw/" + GIST_FILE);
  console.log("DONE");
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
