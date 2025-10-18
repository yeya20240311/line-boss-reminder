import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import cron from "node-cron";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { google } from "googleapis";

dotenv.config();
dayjs.extend(utc);
dayjs.extend(timezone);

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
    rows.forEach(([name, interval, lastDeath]) => {
      bossData[name] = {
        interval: parseFloat(interval),
        lastDeath: lastDeath || null,
      };
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
      data.interval,
      data.lastDeath || "",
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

// ===== 初始化 =====
await loadBossData();

const app = express();

// ===== 測試連線 =====
app.get("/", (req, res) => res.send("LINE Boss Bot is running"));

// ===== LINE Webhook =====
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  middleware(lineConfig),
  async (req, res) => {
    try {
      const events = req.body.events; // 不需要 JSON.parse
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

  // 🕒 /設定 王名 間隔(小時)
  if (text.startsWith("/設定")) {
    const parts = text.split(" ");
    if (parts.length !== 3) {
      await reply(replyToken, "⚠️ 指令格式錯誤：/設定 王名 間隔(小時)");
      return;
    }
    const name = parts[1];
    const interval = parseFloat(parts[2]);
    if (isNaN(interval)) {
      await reply(replyToken, "⚠️ 時間格式錯誤");
      return;
    }
    bossData[name] = bossData[name] || {};
    bossData[name].interval = interval;
    await saveBossData();
    await reply(replyToken, `🕒 已設定 ${name} 重生間隔為 ${interval} 小時`);
    return;
  }

  // 🕒 /重生 王名 剩餘時間
  if (text.startsWith("/重生")) {
    const parts = text.split(" ");
    if (parts.length !== 3) {
      await reply(replyToken, "⚠️ 指令格式錯誤：/重生 王名 剩餘時間(小時.分鐘)");
      return;
    }
    const name = parts[1];
    const remain = parseFloat(parts[2]);
    if (isNaN(remain) || !bossData[name]) {
      await reply(replyToken, "⚠️ 王名不存在或時間格式錯誤");
      return;
    }
    const hours = Math.floor(remain);
    const mins = Math.round((remain - hours) * 60);
    const now = dayjs().tz("Asia/Taipei");
    bossData[name].lastDeath = now.add(hours, "hour").add(mins, "minute").toISOString();
    await saveBossData();
    const respTime = dayjs(bossData[name].lastDeath).tz("Asia/Taipei").format("HH:mm");
    await reply(replyToken, `🕒 已設定 ${name} 將於 ${respTime} 重生`);
    return;
  }

  // 🗑 /刪除 王名
  if (text.startsWith("/刪除")) {
    const parts = text.split(" ");
    if (parts.length !== 2) return;
    const name = parts[1];
    delete bossData[name];
    await saveBossData();
    await reply(replyToken, `🗑 已刪除 ${name}`);
    return;
  }

  // 📋 /王 查詢
  if (text === "/BOSS" || text === "/王") {
    const list = Object.keys(bossData)
      .filter((name) => bossData[name].lastDeath)
      .sort((a, b) => {
        return dayjs(bossData[b].lastDeath).diff(dayjs(bossData[a].lastDeath));
      })
      .map((name) => {
        const remain = dayjs(bossData[name].lastDeath).add(bossData[name].interval, "hour").diff(dayjs(), "minute");
        const respTime = dayjs(bossData[name].lastDeath).add(bossData[name].interval, "hour").tz("Asia/Taipei").format("HH:mm");
        const h = Math.floor(remain / 60);
        const m = remain % 60;
        return `${name}：剩餘 ${h}小時${m}分（預定 ${respTime}）`;
      })
      .join("\n");

    await reply(replyToken, list || "尚無資料");
    return;
  }

  // /我的ID
  if (text === "/我的ID") {
    const userId = event.source.groupId || event.source.userId;
    await reply(replyToken, `你的ID: ${userId}`);
    return;
  }

  // /幫助
  if (text === "/幫助") {
    await reply(
      replyToken,
      `可用指令：
/設定 王名 間隔(小時)
/重生 王名 剩餘時間(小時.分鐘)
/刪除 王名
/王
/我的ID
/開啟通知
/關閉通知`
    );
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
  const now = dayjs().tz("Asia/Taipei");
  for (const [name, data] of Object.entries(bossData)) {
    if (!data.lastDeath || !data.interval) continue;
    const respawn = dayjs(data.lastDeath).add(data.interval, "hour");
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
app.listen(PORT, () => console.log("🚀 LINE Boss Bot running"));
