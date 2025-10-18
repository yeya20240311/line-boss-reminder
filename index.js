import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import dayjs from "dayjs";
import cron from "node-cron";
import { google } from "googleapis";

dotenv.config();

// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ===== Google Sheets =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SA = JSON.parse(process.env.GOOGLE_SA);

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_SA,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ===== 全域變數 =====
let bossData = {};
let notificationsEnabled = true;

// ===== Google Sheets 載入資料 =====
async function loadBossData() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "BOSS!A2:C",
    });
    const rows = res.data.values || [];
    bossData = {};
    for (const row of rows) {
      const [name, interval, lastDeath] = row;
      bossData[name] = { interval: parseFloat(interval), lastDeath };
    }
    console.log("✅ 已從 Google Sheets 載入資料");
  } catch (err) {
    console.error("❌ 無法載入資料：", err);
  }
}

// ===== 儲存資料到 Google Sheets =====
async function saveBossData() {
  try {
    const values = Object.entries(bossData).map(([name, data]) => [
      name,
      data.interval || "",
      data.lastDeath || "",
    ]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "BOSS!A2:C",
      valueInputOption: "RAW",
      requestBody: { values },
    });
  } catch (err) {
    console.error("❌ 無法儲存資料：", err);
  }
}

// ===== Express App =====
const app = express();

app.post(
  "/webhook",
  express.json({ type: "application/json" }),
  middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events;
      await Promise.all(events.map(handleEvent));
      res.sendStatus(200);
    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  }
);

app.get("/", (req, res) => res.send("LINE Boss Reminder Bot is running."));

// ===== 指令處理 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId =
    event.source.groupId || event.source.roomId || event.source.userId;
  const text = event.message.text.trim();
  const args = text.split(" ");

  // /幫助
  if (text === "/幫助") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `📜 指令說明：
/設定 王名 時間(小時)
/重生 王名 剩餘時間(小時.分)
/刪除 王名
/王
/我的ID
/開啟通知
/關閉通知`,
    });
    return;
  }

  // /我的ID
  if (text === "/我的ID") {
    const id =
      event.source.groupId || event.source.roomId || event.source.userId;
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `你的ID: ${id}`,
    });
    return;
  }

  // /設定 王名 時間
  if (args[0] === "/設定" && args.length === 3) {
    const [_, name, hours] = args;
    bossData[name] = { interval: parseFloat(hours), lastDeath: null };
    await saveBossData();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🕒 已設定 ${name} 重生間隔為 ${hours} 小時`,
    });
    return;
  }

  // /重生 王名 剩餘時間
  if (args[0] === "/重生" && args.length === 3) {
    const [_, name, remain] = args;
    if (!bossData[name]) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `${name} 尚未設定`,
      });
      return;
    }
    const hours = Math.floor(parseFloat(remain));
    const mins = Math.round((parseFloat(remain) - hours) * 100);
    const respawnTime = dayjs()
      .add(hours, "hour")
      .add(mins, "minute")
      .format("YYYY-MM-DD HH:mm");
    bossData[name].lastDeath = respawnTime;
    await saveBossData();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🕒 已設定 ${name} 將於 ${dayjs(respawnTime).format("HH:mm")} 重生`,
    });
    return;
  }

  // /刪除 王名
  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    delete bossData[name];
    await saveBossData();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🗑 已刪除 ${name}`,
    });
    return;
  }

  // /王 → 依時間排序（最近重生的排最前）
  if (text === "/王") {
    const list = Object.entries(bossData)
      .filter(([_, data]) => data.lastDeath)
      .sort(
        (a, b) =>
          dayjs(a[1].lastDeath).diff(dayjs()) -
          dayjs(b[1].lastDeath).diff(dayjs())
      )
      .map(([name, data]) => {
        const diff = dayjs(data.lastDeath).diff(dayjs(), "minute");
        const h = Math.floor(diff / 60);
        const m = diff % 60;
        const respTime = dayjs(data.lastDeath).format("HH:mm");
        return `🕓 ${name} 剩餘 ${h}小時${m}分（預定 ${respTime}）`;
      })
      .join("\n");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: list || "尚無資料",
    });
    return;
  }

  // /開啟通知
  if (text === "/開啟通知") {
    notificationsEnabled = true;
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "✅ 已開啟通知（重生前10分鐘將推播）",
    });
    return;
  }

  // /關閉通知
  if (text === "/關閉通知") {
    notificationsEnabled = false;
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "🚫 已關閉通知（不再推播提醒）",
    });
    return;
  }
}

// ===== 每分鐘檢查重生前10分鐘 =====
cron.schedule("* * * * *", async () => {
  if (!notificationsEnabled) return;

  const now = dayjs();
  for (const name in bossData) {
    const boss = bossData[name];
    if (!boss.lastDeath || !boss.interval) continue;

    const diff = dayjs(boss.lastDeath).diff(now, "minute");
    if (diff <= 10 && diff > 9) {
      const respTime = dayjs(boss.lastDeath).format("HH:mm");
      try {
        await client.pushMessage(process.env.USER_ID, {
          type: "text",
          text: `⚠️ ${name} 將於 ${respTime} 重生！（剩餘 10 分鐘）`,
        });
      } catch (err) {
        console.error("❌ 推播失敗：", err);
      }
    }
  }
});

// ===== 啟動伺服器 =====
app.listen(process.env.PORT || 10000, async () => {
  await loadBossData();
  console.log("🚀 LINE Boss Bot running");
});
