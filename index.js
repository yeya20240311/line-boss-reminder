import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import cron from "node-cron";
import { google } from "googleapis";

dotenv.config();
dayjs.extend(utc);
dayjs.extend(timezone);

const TW_ZONE = process.env.TIMEZONE || "Asia/Taipei";

// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ===== Google Sheets 設定 =====
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

if (!SHEET_ID || !GOOGLE_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("請設定 GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY 等環境變數");
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });
const SHEET_NAME = "Boss";

// ===== Bot 資料 =====
let bossData = {};
let notifyAll = true;

// ===== 從 Google Sheets 載入資料 =====
async function loadBossData() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:F`,
    });
    const rows = res.data.values || [];
    bossData = {};
    rows.forEach((r) => {
      const [name, interval, nextRespawn, notified, notifyDate, missedCount] = r;
      bossData[name] = {
        interval: parseFloat(interval) || 0,
        nextRespawn: nextRespawn || null,
        notified: notified === "TRUE",
        notifyDate: notifyDate || "ALL",
        missedCount: parseInt(missedCount) || 0,
      };
    });
    console.log(`✅ 已從 Google Sheets 載入資料 (${rows.length} 筆)`);
  } catch (err) {
    console.error("❌ 無法連接 Google Sheets", err);
  }
}

// ===== 將資料寫回 Google Sheets =====
async function saveBossDataToSheet() {
  try {
    const rows = Object.entries(bossData).map(([name, b]) => [
      name,
      b.interval,
      b.nextRespawn || "",
      b.notified ? "TRUE" : "FALSE",
      b.notifyDate || "ALL",
      b.missedCount || 0,
    ]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:F`,
      valueInputOption: "RAW",
      resource: { values: rows },
    });
    console.log("✅ 已更新 Google Sheet");
  } catch (err) {
    console.error("❌ 更新 Google Sheet 失敗", err);
  }
}

// ===== Express =====
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })); // 保存 raw body 給 middleware
app.post("/webhook", express.raw({ type: "application/json" }), middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.send("LINE Boss Reminder Bot is running."));

// ===== 指令處理 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const args = text.split(/\s+/);

  // /幫助
  if (text === "/幫助") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `可用指令：
/設定 王名 間隔(小時.分)
/重生 王名 剩餘時間(小時.分)
/刪除 王
/王
/開啟通知
/關閉通知
/我的ID`,
    });
    return;
  }

  // /我的ID
  if (text === "/我的ID") {
    const id = event.source.userId || "無法取得";
    await client.replyMessage(event.replyToken, { type: "text", text: `你的 ID：${id}` });
    return;
  }

  // /設定 王名 間隔
  if (args[0] === "/設定" && args.length === 3) {
    const [_, name, intervalStr] = args;
    const raw = parseFloat(intervalStr);
    const h = Math.floor(raw);
    const m = Math.round((raw - h) * 100);
    bossData[name] = bossData[name] || {};
    bossData[name].interval = h + m / 60;
    bossData[name].nextRespawn = bossData[name].nextRespawn || null;
    bossData[name].notified = bossData[name].notified || false;
    bossData[name].notifyDate = bossData[name].notifyDate || "ALL";
    bossData[name].missedCount = bossData[name].missedCount || 0;
    await saveBossDataToSheet();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已設定 ${name} 重生間隔 ${h}小時${m}分`,
    });
    return;
  }

  // /重生 王名 剩餘時間
  if (args[0] === "/重生" && args.length === 3) {
    const [_, name, remainStr] = args;
    if (!bossData[name] || !bossData[name].interval) {
      await client.replyMessage(event.replyToken, { type: "text", text: `請先用 /設定 ${name} 間隔(小時.分)` });
      return;
    }
    const raw = parseFloat(remainStr);
    const h = Math.floor(raw);
    const m = Math.round((raw - h) * 100);
    bossData[name].nextRespawn = dayjs().tz(TW_ZONE).add(h, "hour").add(m, "minute").toISOString();
    bossData[name].notified = false;
    bossData[name].missedCount = 0;
    await saveBossDataToSheet();
    const respTime = dayjs(bossData[name].nextRespawn).tz(TW_ZONE).format("HH:mm");
    await client.replyMessage(event.replyToken, { type: "text", text: `🕒 已設定 ${name} 將於 ${respTime} 重生` });
    return;
  }

  // /刪除 王名
  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    if (bossData[name]) {
      delete bossData[name];
      await saveBossDataToSheet();
      await client.replyMessage(event.replyToken, { type: "text", text: `🗑 已刪除 ${name}` });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: `${name} 不存在` });
    }
    return;
  }

// /王 顯示
if (text === "/王") {
  const now = dayjs().tz(TW_ZONE);
  const list = Object.keys(bossData)
    .map(name => {
      const b = bossData[name];
      if (!b.nextRespawn) return `❌ ${name} 尚未設定重生時間`;
      const diff = dayjs(b.nextRespawn).tz(TW_ZONE).diff(now, "minute");
      const h = Math.floor(Math.abs(diff)/60);
      const m = Math.abs(diff) % 60;
      const respTime = dayjs(b.nextRespawn).tz(TW_ZONE).format("HH:mm");
      const icon = (diff <= 0 || (b.missedCount && b.missedCount > 0)) ? "⚠️" : "⚔️";
      const missedText = (b.missedCount && b.missedCount > 0) ? ` 過${b.missedCount}` : "";
      return `${icon} ${name} 剩餘 ${h}小時${m}分（預計 ${respTime}）${missedText}`;
    })
   .sort((a,b)=>{
  const aMatch = a.match(/剩餘 (\d+)小時(\d+)分/);
  const bMatch = b.match(/剩餘 (\d+)小時(\d+)分/);

  const aMin = aMatch ? parseInt(aMatch[1]) * 60 + parseInt(aMatch[2]) : 9999;
  const bMin = bMatch ? parseInt(bMatch[1]) * 60 + parseInt(bMatch[2]) : 9999;

  return aMin - bMin;
})
    .join("\n");

  await client.replyMessage(event.replyToken, { type: "text", text: list || "尚無任何王的資料" });
  return;
}






  // /開啟通知
  if (text === "/開啟通知") { notifyAll = true; await client.replyMessage(event.replyToken,{ type:"text", text:"✅ 已開啟所有前10分鐘通知"}); return; }

  // /關閉通知
  if (text === "/關閉通知") { notifyAll = false; await client.replyMessage(event.replyToken,{ type:"text", text:"❌ 已關閉所有前10分鐘通知"}); return; }
}

// ===== 每分鐘檢查重生前10分鐘提醒 & 自動累計錯過次數 =====
cron.schedule("* * * * *", async ()=>{
  const now = dayjs().tz(TW_ZONE);
  const targetId = process.env.USER_ID;
  if(!targetId) return;

  let updated = false;

  for(const [name, b] of Object.entries(bossData)){
    if(!b.nextRespawn) continue;
    const resp = dayjs(b.nextRespawn).tz(TW_ZONE);
    const diff = resp.diff(now,"minute");

    // 過期只累計錯過，不通知
    if(diff <= 0 && !b.missedCountHandled){
      b.missedCount = (b.missedCount || 0) + 1;
      b.nextRespawn = resp.add(b.interval,"hour").toISOString();
      b.notified = false;
      b.missedCountHandled = true; // 確保同一個過期事件只累計一次
      updated = true;
      // ⚠️ 已過期的通知不推播，僅更新 /王 顯示
    }

    // 前10分鐘通知
    if(diff > 0 && diff <= 10 && !b.notified){

  // 1️⃣ 取得今天星期
  const today = now.format("ddd").toUpperCase(); // "MON","TUE",...

  // 2️⃣ 拆分通知日期設定
  const notifyDays = b.notifyDate.split(","); // ["SAT","MON"]

  // 3️⃣ 判斷今天是否要通知
  if(b.notifyDate !== "ALL" && !notifyDays.includes(today)) return;

  // 4️⃣ 發送通知
  b.notified = true;
  await client.pushMessage(targetId,{
    type:"text",
    text:`⏰ ${name} 即將在 ${diff} 分鐘後重生`
  });
}


    // 如果重生時間已更新，重置 missedCountHandled
    if(diff > 0){
      b.missedCountHandled = false;
    }
  }

  if(updated) await saveBossDataToSheet();
});

// 🕐 每分鐘印出一條心跳訊息（確認伺服器在跑）
setInterval(() => {
  console.log("🕐 定時器仍在運作中", new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }));
}, 60000);

// ===== 啟動 =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, async ()=>{
  await loadBossData();
  console.log(`🚀 LINE Boss Reminder Bot 已啟動，Port: ${PORT}`);
});
