import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import dayjs from "dayjs";
import cron from "node-cron";
import { google } from "googleapis";
import fs from "fs";

dotenv.config();

// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ===== Google Sheets 設定 =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 將環境變數 GOOGLE_SA 寫成暫時檔案
fs.writeFileSync("/tmp/service_account.json", process.env.GOOGLE_SA);

const credentials = JSON.parse(fs.readFileSync("/tmp/service_account.json"));
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

// ===== Express =====
const app = express();
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  middleware(config),
  async (req, res) => {
    try {
      const events = JSON.parse(req.body.toString()).events;
      await Promise.all(events.map(handleEvent));
      res.sendStatus(200);
    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  }
);

app.get("/", (req, res) => res.send("LINE Boss Reminder Bot is running."));

// ===== Boss 資料操作 =====
let bossData = {};
let notifyEnabled = true; // 全部通知開關

async function loadBossData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "A2:D1000",
  });
  const rows = res.data.values || [];
  const data = {};
  for (const row of rows) {
    const [name, interval, nextRespawn, notified] = row;
    if (!name) continue;
    data[name] = {
      interval: parseFloat(interval),
      nextRespawn,
      notified: notified === "true",
    };
  }
  bossData = data;
}

async function saveBossData() {
  const values = Object.entries(bossData).map(([name, b]) => [
    name,
    b.interval,
    b.nextRespawn,
    b.notified ? "true" : "false",
  ]);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: "A2:D1000",
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

// ===== 指令處理 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId || event.source.groupId;
  const text = event.message.text.trim();
  const args = text.split(" ");

  // /幫助
  if (text === "/幫助") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `可用指令：
/設定 王名 時間(小時)
/重生 王名 剩餘時間(小時.分)
/刪除 王名
/王
/開啟通知
/關閉通知
/我的ID`,
    });
    return;
  }

  // /我的ID
  if (text === "/我的ID") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `你的ID: ${userId}`,
    });
    return;
  }

  // /開啟通知
  if (text === "/開啟通知") {
    notifyEnabled = true;
    await client.replyMessage(event.replyToken, { type: "text", text: "✅ 已開啟全部通知" });
    return;
  }

  // /關閉通知
  if (text === "/關閉通知") {
    notifyEnabled = false;
    await client.replyMessage(event.replyToken, { type: "text", text: "✅ 已關閉全部通知" });
    return;
  }

  // /設定 王名 時間
  if (args[0] === "/設定" && args.length === 3) {
    const [_, name, hours] = args;
    bossData[name] = {
      interval: parseFloat(hours),
      nextRespawn: null,
      notified: false,
    };
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
      await client.replyMessage(event.replyToken, { type: "text", text: `${name} 尚未設定` });
      return;
    }
    const totalMins = Math.round(parseFloat(remain) * 60);
    const nextRespawn = dayjs().add(totalMins, "minute").add(8, "hour"); // +8小時台灣
    bossData[name].nextRespawn = nextRespawn.toISOString();
    bossData[name].notified = false;
    await saveBossData();
    const respTime = nextRespawn.format("HH:mm");
    await client.replyMessage(event.replyToken, { type: "text", text: `🕒 已設定 ${name} 將於 ${respTime} 重生` });
    return;
  }

  // /刪除 王名
  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    delete bossData[name];
    await saveBossData();
    await client.replyMessage(event.replyToken, { type: "text", text: `🗑 已刪除 ${name}` });
    return;
  }

  // /王
  if (text === "/王") {
    const list = Object.entries(bossData)
      .filter(([_, b]) => b.nextRespawn)
      .sort((a, b) => dayjs(a[1].nextRespawn) - dayjs(b[1].nextRespawn))
      .map(([name, b]) => {
        const remainMins = dayjs(b.nextRespawn).diff(dayjs(), "minute");
        const h = Math.floor(remainMins / 60);
        const m = remainMins % 60;
        const respTime = dayjs(b.nextRespawn).format("HH:mm");
        return `🕓 ${name} 剩餘 ${h}小時${m}分（預定 ${respTime}）`;
      })
      .reverse() // 從最近的開始排列
      .join("\n");
    await client.replyMessage(event.replyToken, { type: "text", text: list || "尚無資料" });
    return;
  }
}

// ===== 每分鐘檢查重生前10分鐘 =====
cron.schedule("* * * * *", async () => {
  await loadBossData();
  const now = dayjs();
  for (const name in bossData) {
    const boss = bossData[name];
    if (!boss.nextRespawn || !boss.interval) continue;

    const diff = dayjs(boss.nextRespawn).diff(now, "minute");
    if (diff <= 10 && diff >= 0 && notifyEnabled && !boss.notified) {
      const respTime = dayjs(boss.nextRespawn).format("HH:mm");
      try {
        await client.pushMessage(process.env.USER_ID, {
          type: "text",
          text: `⚠️ ${name} 將於 ${respTime} 重生！（剩餘 ${diff} 分鐘）`,
        });
        boss.notified = true;
        await saveBossData();
      } catch (err) {
        console.error(err);
      }
    }
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 LINE Boss Bot running");
});
