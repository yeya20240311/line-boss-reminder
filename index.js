import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import cron from "node-cron";
import dayjs from "dayjs";
import { google } from "googleapis";

dotenv.config();

const app = express();

// ===== 環境變數檢查 =====
console.log("CHANNEL_ACCESS_TOKEN length:", process.env.CHANNEL_ACCESS_TOKEN?.length || 0);
console.log("CHANNEL_SECRET length:", process.env.CHANNEL_SECRET?.length || 0);
console.log("GROUP_ID length:", process.env.GROUP_ID?.length || 0);
console.log("SPREADSHEET_ID length:", process.env.SPREADSHEET_ID?.length || 0);

// ===== LINE BOT 設定 =====
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(lineConfig);

// ===== Google Sheets 設定 =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SA = JSON.parse(process.env.GOOGLE_SA);
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.JWT(
  GOOGLE_SA.client_email,
  null,
  GOOGLE_SA.private_key,
  SCOPES
);
const sheets = google.sheets({ version: "v4", auth });

// ===== 資料暫存 =====
let bossData = {};
let notificationsEnabled = true;

// ===== 載入 Google Sheets 資料 =====
async function loadBossData() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "BOSS!A2:C",
    });
    const rows = res.data.values || [];
    bossData = {};
    rows.forEach(([name, time, respawn]) => {
      if (name) {
        bossData[name] = {
          time: time || "",
          respawn: respawn ? dayjs(respawn).toISOString() : null,
        };
      }
    });
    console.log("✅ 已從 Google Sheets 載入資料");
  } catch (err) {
    console.error("❌ 無法載入資料：", err.message);
  }
}

// ===== 儲存資料到 Google Sheets =====
async function saveBossData() {
  try {
    const rows = Object.entries(bossData).map(([name, data]) => [
      name,
      data.time,
      data.respawn,
    ]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "BOSS!A2:C",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
    console.log("✅ 已儲存至 Google Sheets");
  } catch (err) {
    console.error("❌ 無法儲存資料：", err.message);
  }
}

// ===== 初始化時載入資料 =====
await loadBossData();

// ===== 測試連線 =====
app.get("/", (req, res) => res.send("LINE Boss Bot is running"));

// ===== LINE Webhook =====
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  middleware(lineConfig),
  async (req, res) => {
    try {
      const events = JSON.parse(req.body.toString()).events;
      await Promise.all(events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      console.error("❌ Webhook error:", err);
      res.status(200).end();
    }
  }
);

// ===== 處理指令 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 🔔 開啟 / 關閉通知
  if (text === "/開啟通知") {
    notificationsEnabled = true;
    await reply(replyToken, "🔔 已開啟所有通知");
    return;
  }
  if (text === "/關閉通知") {
    notificationsEnabled = false;
    await reply(replyToken, "🔕 已關閉所有通知");
    return;
  }

  // 🕒 /重生 王名 時間
  if (text.startsWith("/重生")) {
    const parts = text.split(" ");
    if (parts.length < 3)
      return await reply(replyToken, "⚠️ 指令格式錯誤：/重生 王名 時間(小時)");

    const name = parts[1];
    const hours = parseFloat(parts[2]);
    if (isNaN(hours)) return await reply(replyToken, "⚠️ 時間格式錯誤");

    const now = dayjs();
    const respawn = now.add(hours, "hour"); // ✅ 小數小時自動換算分鐘

    bossData[name] = {
      time: now.format("HH:mm"),
      respawn: respawn.toISOString(),
    };

    await saveBossData();
    await reply(replyToken, `🕒 已設定 ${name} 將於 ${respawn.format("HH:mm")} 重生`);
    return;
  }

  // 📋 /王 指令
  if (text === "/BOSS" || text === "/王") {
    if (Object.keys(bossData).length === 0)
      return await reply(replyToken, "目前沒有紀錄的王。");

    const sorted = Object.entries(bossData).sort(
      (a, b) => dayjs(b[1].respawn).diff(dayjs(a[1].respawn))
    );

    const msg = sorted
      .map(
        ([n, d]) =>
          `${n}：剩餘 ${Math.max(dayjs(d.respawn).diff(dayjs(), "minute"), 0)} 分 → ${dayjs(
            d.respawn
          ).format("HH:mm")}`
      )
      .join("\n");

    await reply(replyToken, msg);
    return;
  }
}

// ===== 回覆訊息函式 =====
async function reply(token, message) {
  try {
    await client.replyMessage(token, { type: "text", text: message });
  } catch (err) {
    console.error("❌ 回覆訊息失敗：", err.originalError?.response?.data || err.message);
  }
}

// ===== 自動通知（每分鐘檢查） =====
cron.schedule("* * * * *", async () => {
  if (!notificationsEnabled) return;

  const now = dayjs();
  for (const [name, data] of Object.entries(bossData)) {
    if (!data.respawn) continue;

    const respawn = dayjs(data.respawn);
    const diff = respawn.diff(now, "minute");

    if (diff === 10) {
      await client.pushMessage(process.env.GROUP_ID, {
        type: "text",
        text: `⚠️ ${name} 將於 ${respawn.format("HH:mm")} 重生！（剩餘 10 分鐘）`,
      });
    }
  }
});

// ===== 啟動服務 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LINE Boss Bot running on port ${PORT}`));
