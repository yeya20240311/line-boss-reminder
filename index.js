import fs from "fs";
import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import cron from "node-cron";
import { google } from "googleapis";

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);
app.use(middleware(config));

/* ------------------------- Google Sheets 初始化 ------------------------- */
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

/* ------------------------- 資料初始化 ------------------------- */
let data = { bosses: {}, users: {} };

// 讀取 Google Sheets
async function loadData() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "BossData!A2:E",
    });

    const rows = res.data.values || [];
    data.bosses = {};
    for (const row of rows) {
      const [name, interval, respawn, notified] = row;
      data.bosses[name] = {
        interval: parseFloat(interval),
        respawn: respawn ? new Date(respawn) : null,
        notified: notified === "TRUE",
      };
    }

    const userRes = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Users!A2:B",
    });
    const userRows = userRes.data.values || [];
    data.users = {};
    for (const [uid, enabled] of userRows) {
      data.users[uid] = enabled === "TRUE";
    }

    console.log("✅ 已從 Google Sheets 載入資料");
  } catch (err) {
    console.error("❌ 載入資料失敗:", err);
  }
}

// 儲存到 Google Sheets
async function saveData() {
  try {
    const bossValues = Object.entries(data.bosses).map(([name, b]) => [
      name,
      b.interval || "",
      b.respawn ? b.respawn.toISOString() : "",
      b.notified ? "TRUE" : "FALSE",
    ]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "BossData!A2",
      valueInputOption: "RAW",
      requestBody: { values: bossValues },
    });

    const userValues = Object.entries(data.users).map(([uid, enabled]) => [
      uid,
      enabled ? "TRUE" : "FALSE",
    ]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Users!A2",
      valueInputOption: "RAW",
      requestBody: { values: userValues },
    });
  } catch (err) {
    console.error("❌ 儲存資料失敗:", err);
  }
}

/* ------------------------- 工具函式 ------------------------- */
function hoursToMs(hours) {
  const [h, m = 0] = hours.toString().split(".").map(Number);
  return (h * 60 + m) * 60 * 1000;
}

function formatTime(date) {
  return date.toLocaleString("zh-TW", { hour12: false });
}

function getRemainingMinutes(endTime) {
  return Math.max(0, Math.floor((endTime - new Date()) / 60000));
}

/* ------------------------- LINE 指令處理 ------------------------- */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const userId = event.source.userId;

  if (!text.startsWith("/")) return;

  const reply = (msg) => client.replyMessage(event.replyToken, { type: "text", text: msg });

  /* ===== /設定 ===== */
  if (text.startsWith("/設定")) {
    const parts = text.split(" ");
    if (parts.length < 3) return reply("格式錯誤，請用：/設定 王名 間隔(小時.分)");
    const name = parts[1];
    const intervalHours = parseFloat(parts[2]);
    if (isNaN(intervalHours)) return reply("間隔格式錯誤，請用小時或小時.分");

    data.bosses[name] = data.bosses[name] || {};
    data.bosses[name].interval = intervalHours;
    await saveData();

    return reply(`✅ 已設定 ${name} 重生間隔 ${intervalHours} 小時`);
  }

  /* ===== /重生 ===== */
  if (text.startsWith("/重生")) {
    const parts = text.split(" ");
    if (parts.length < 3) return reply("格式錯誤，請用：/重生 王名 剩餘時間(小時.分)");
    const name = parts[1];
    const remain = parseFloat(parts[2]);
    if (isNaN(remain)) return reply("時間格式錯誤，請用小時.分");

    if (!data.bosses[name] || !data.bosses[name].interval)
      return reply(`請先使用 /設定 ${name} 間隔(小時.分)`);

    const now = new Date();
    const ms = hoursToMs(remain);
    const respawn = new Date(now.getTime() + ms);
    data.bosses[name].respawn = respawn;
    data.bosses[name].notified = false;
    await saveData();

    return reply(`🕒 已登記 ${name} 剩餘 ${remain} 小時，預計 ${formatTime(respawn)} 重生`);
  }

  /* ===== /刪除 ===== */
  if (text.startsWith("/刪除")) {
    const parts = text.split(" ");
    if (parts.length < 2) return reply("請輸入：/刪除 王名");
    const name = parts[1];
    if (!data.bosses[name]) return reply(`查無 ${name}`);
    delete data.bosses[name];
    await saveData();
    return reply(`🗑️ 已刪除 ${name}`);
  }

  /* ===== /王 ===== */
  if (text === "/王") {
    if (Object.keys(data.bosses).length === 0) return reply("目前沒有王的資料");

    let msg = "👑 王列表：\n";
    for (const [name, b] of Object.entries(data.bosses)) {
      if (!b.respawn) {
        msg += `\n${name}：尚未登記重生時間`;
      } else {
        const mins = getRemainingMinutes(new Date(b.respawn));
        msg += `\n${name}：剩 ${Math.floor(mins / 60)}小${mins % 60}分\n→ ${formatTime(new Date(b.respawn))}`;
      }
    }
    return reply(msg);
  }

  /* ===== 通知設定 ===== */
  if (text === "/開啟通知") {
    data.users[userId] = true;
    await saveData();
    return reply("🔔 已開啟提醒通知");
  }

  if (text === "/關閉通知") {
    data.users[userId] = false;
    await saveData();
    return reply("🔕 已關閉提醒通知");
  }

  if (text === "/我的ID") {
    return reply(`你的ID是：${userId}`);
  }

  return reply("無效指令。可用指令：/設定 /重生 /刪除 /王 /開啟通知 /關閉通知 /我的ID");
}

/* ------------------------- 自動推播 ------------------------- */
cron.schedule("* * * * *", async () => {
  const now = new Date();
  for (const [name, boss] of Object.entries(data.bosses)) {
    if (!boss.respawn || boss.notified) continue;

    const mins = getRemainingMinutes(new Date(boss.respawn));
    if (mins <= 10 && mins > 0) {
      boss.notified = true;
      await saveData();

      const message = `⚠️ ${name} 將於 ${mins} 分鐘後重生！`;

      for (const [uid, enabled] of Object.entries(data.users)) {
        if (enabled) {
          try {
            await client.pushMessage(uid, { type: "text", text: message });
          } catch (err) {
            console.error("推播失敗", uid, err);
          }
        }
      }
    }
  }
});

/* ------------------------- 啟動 ------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 LINE Boss Reminder Bot 已啟動，Port: ${PORT}`);
  await loadData();
});
