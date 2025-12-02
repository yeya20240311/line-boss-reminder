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
  ["https://www.googleapis.com/auth/spreadsheets.readonly"] // 只讀取
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
      range: `${SHEET_NAME}!A2:G`,
    });
    const rows = res.data.values || [];
    bossData = {};
    rows.forEach((r) => {
      const [name, interval, nextRespawn, notified, notifyDate, missedCount, category] = r;
      bossData[name] = {
        interval: parseFloat(interval) || 0,
        nextRespawn: nextRespawn || null,
        notified: notified === "TRUE",
        notifyDate: notifyDate || "ALL",
        missedCount: parseInt(missedCount) || 0,
        category: category || "",
      };
    });
    // console.log(`✅ 已從 Google Sheets 載入資料 (${rows.length} 筆)`);
  } catch (err) {
    console.error("❌ 無法連接 Google Sheets", err);
  }
}

// ===== Express 只提供健康檢查 =====
const app = express();
app.get("/", (req, res) => res.send("LINE Boss Reminder BOT B is running."));

// ===== 前 10 分鐘通知函數 =====
async function sendNotifications() {
  const now = dayjs().tz(TW_ZONE);
  for (const [name, b] of Object.entries(bossData)) {
    if (!b.nextRespawn || !b.interval) continue;
    const resp = dayjs(b.nextRespawn).tz(TW_ZONE);
    const diffMin = resp.diff(now, "minute");

    // 檢查是否在前 10 分鐘內
    if (diffMin > 0 && diffMin <= 10) {
      if (b.notified) continue; // 已通知過的跳過
      const notifyText = `🕐 預告 ${name} 將於 ${resp.format("HH:mm")} 重生（剩餘 ${diffMin} 分鐘）`;
      
      // 這裡指定發送給群組或個人 ID
      // 如果你要固定群組，改成你群組 ID
      const targetId = process.env.LINE_NOTIFY_ID; // 群組或個人 ID
      if (targetId) {
        await client.pushMessage(targetId, { type: "text", text: notifyText });
        // 標記已通知
        b.notified = true;
        console.log(`✅ 已通知 ${name}: ${notifyText}`);
      }
    } else if (diffMin <= 0) {
      // 過期後重置通知狀態
      b.notified = false;
    }
  }
}

// ===== 定時每分鐘抓資料並通知 =====
cron.schedule("* * * * *", async () => {
  await loadBossData();
  await sendNotifications();
});

// ===== 啟動 =====
const PORT = process.env.PORT || 10001;
app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Reminder BOT B 已啟動，Port: ${PORT}`);
});

