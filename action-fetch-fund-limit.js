#!/usr/bin/env node
/* ============================================================
   GitHub Actions 版 · 抓取博时标普500ETF联接E(018738)当日限购额度
   → 写 Gist 的 fund-limit.json → API 权威回读校验

   与本地 tools/fetch-fund-limit.js 解析逻辑完全一致。
   区别：token 从环境变量 GIST_TOKEN（仓库 Secret）读取，不依赖本地凭据文件。
   ============================================================ */
const FUND_CODE = "018738";
const FUND_URL = "https://fund.eastmoney.com/" + FUND_CODE + ".html";
const GIST_ID = "96bbc2e049cd6b2b31bf1f6bc3d2f43c";
const GIST_FILE = "fund-limit.json";

// 解析交易状态（与本地版逐字一致）
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

function buildRecord(parsed) {
  const now = new Date();
  // 转成北京时间日期（UTC+8）
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const date = bj.getUTCFullYear() + "-" + String(bj.getUTCMonth() + 1).padStart(2, "0") + "-" + String(bj.getUTCDate()).padStart(2, "0");
  return {
    code: FUND_CODE, name: "博时标普500ETF联接E",
    state: parsed.state, value: parsed.value, unit: parsed.unit, amount: parsed.amount,
    date: date, ts: now.getTime(), source: "fund.eastmoney.com"
  };
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

  console.log("fetch:", FUND_URL);
  const resp = await fetch(FUND_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const html = await resp.text();
  const parsed = parseStatus(html);
  const record = buildRecord(parsed);
  console.log("parsed:", JSON.stringify(record));
  if (parsed.state === "未知") throw new Error("解析结果未知，拒绝写入");

  const content = JSON.stringify(record);
  const updated = await ghApi("PATCH", "/gists/" + GIST_ID, { files: { [GIST_FILE]: { content } } }, token);
  if (!updated.files[GIST_FILE]) throw new Error("更新后未见 " + GIST_FILE);
  console.log("已推送 Gist:", GIST_FILE);

  // API 权威回读校验
  const auth = await ghApi("GET", "/gists/" + GIST_ID, null, token);
  const remote = JSON.parse(auth.files[GIST_FILE].content);
  if (remote.ts !== record.ts) throw new Error("API 回读校验不一致！");
  console.log("API 回读校验一致, ts=", record.ts);
  console.log("READ URL: https://gist.githubusercontent.com/suiplgh/" + GIST_ID + "/raw/" + GIST_FILE);
  console.log("DONE");
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
