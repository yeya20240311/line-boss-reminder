import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import cron from "node-cron";
import { GoogleSpreadsheet } from "google-spreadsheet";

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
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID);
let sheet;

// ===== 資料 =====
let bossData = {};
let notifyAll = true;

// ===== Express =====
const app = express();

// ===== Webhook 處理 =====
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(
      events.map(async (event) => {
        try {
          await handleEvent(event);
        } catch (e) {
          console.error("handleEvent error:", e);
        }
      })
    );
    return res.sendStatus(200); // 確保 LINE 收到 200
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200); // 即使發生錯誤，也回 200
  }
});

app.get("/", (req, res) => res.send("LINE Boss Reminder Bot is running."));

// ===== 載入資料 =====
async function loadBossData() {
  const rows = await sheet.getRows();
  bossData = {};
  rows.forEach((row) => {
    bossData[row.王名] = {
      interval: parseFloat(row.間隔小時),
      nextRespawn: row.下次重生時間,
      notified: row.是否已通知 === "TRUE",
      notifyDate: row.通知日期設定 || "ALL",
      missedCount: parseInt(row.錯過計數) || 0,
    };
  });
  console.log(`✅ 已從 Google Sheets 載入資料 (${rows.length} 筆)`);
}

// ===== 儲存資料 =====
async function saveBossData() {
  const rows = await sheet.getRows();
  for (const row of rows) {
    const data = bossData[row.王名];
    if (data) {
      row.間隔小時 = data.interval;
      row.下次重生時間 = data.nextRespawn;
      row.是否已通知 = data.notified ? "TRUE" : "FALSE";
      row.通知日期設定 = data.notifyDate || "ALL";
      row.錯過計數 = data.missedCount || 0;
      await row.save();
    }
  }
  console.log("✅ 已更新 Google Sheet");
}

// ===== LINE 指令處理 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const args = text.split(/\s+/);

  if (text === "/幫助") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `可用指令：
/設定 王名 間隔(小時.分)
/重生 王名 剩餘時間(小時.分)
/刪除 王名
/王
/開啟通知
/關閉通知
/我的ID`,
    });
    return;
  }

  if (text === "/我的ID") {
    const id = event.source.userId || "無法取得";
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `你的 ID：${id}`,
    });
    return;
  }

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
    await saveBossData();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已設定 ${name} 重生間隔 ${h}小時${m}分`,
    });
    return;
  }

  if (args[0] === "/重生" && args.length === 3) {
    const [_, name, remainStr] = args;
    if (!bossData[name]) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `請先用 /設定 ${name} 間隔(小時.分)`,
      });
      return;
    }
    const raw = parseFloat(remainStr);
    const h = Math.floor(raw);
    const m = Math.round((raw - h) * 100);
    bossData[name].nextRespawn = dayjs()
      .tz(TW_ZONE)
      .add(h, "hour")
      .add(m, "minute")
      .toISOString();
    bossData[name].notified = false;
    await saveBossData();
    const respTime = dayjs(bossData[name].nextRespawn).tz(TW_ZONE).format("HH:mm");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🕒 已設定 ${name} 將於 ${respTime} 重生`,
    });
    return;
  }

  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    if (bossData[name]) {
      delete bossData[name];
      await saveBossData();
      await client.replyMessage(event.replyToken, { type: "text", text: `🗑 已刪除 ${name}` });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: `${name} 不存在` });
    }
    return;
  }

  if (text === "/王") {
    const now = dayjs().tz(TW_ZONE);
    const list = Object.keys(bossData)
      .map((name) => {
        const b = bossData[name];
        if (!b.nextRespawn || !b.interval)
          return { name, diff: Infinity, text: `❌ ${name} 尚未設定重生時間` };

        const diff = dayjs(b.nextRespawn).tz(TW_ZONE).diff(now, "minute");
        const h = Math.floor(Math.abs(diff) / 60);
        const m = Math.abs(diff) % 60;

        let missedCount = b.missedCount || 0;
        if (diff < 0 && b.interval) {
          missedCount = Math.ceil(Math.abs(diff) / (b.interval * 60));
        }

        let textLine = `⚠️ ${name} 剩餘 ${h}小時${m}分（預計 ${dayjs(b.nextRespawn)
          .tz(TW_ZONE)
          .format("HH:mm")}）`;
        if (missedCount > 0) {
          textLine += ` 過${missedCount}`;
        }

        return { name, diff, text: textLine };
      })
      .sort((a, b) => a.diff - b.diff)
      .map((item) => item.text)
      .join("\n");

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: list || "尚無任何王的資料",
    });
    return;
  }

  if (text === "/開啟通知") {
    notifyAll = true;
    await client.replyMessage(event.replyToken, { type: "text", text: "✅ 已開啟所有前10分鐘通知" });
    return;
  }

  if (text === "/關閉通知") {
    notifyAll = false;
    await client.replyMessage(event.replyToken, { type: "text", text: "❌ 已關閉所有前10分鐘通知" });
    return;
  }
}

// ===== 每分鐘檢查重生前10分鐘通知 =====
cron.schedule("* * * * *", async () => {
  const now = dayjs().tz(TW_ZONE);
  const dayName = now.format("ddd").toUpperCase().slice(0, 3); // MON, TUE...
  const targetId = process.env.USER_ID;
  if (!targetId) return;

  for (const [name, b] of Object.entries(bossData)) {
    if (!b.nextRespawn || !b.interval) continue;
    if (b.notifyDate !== "ALL") {
      const allowedDays = b.notifyDate.split(",");
      if (!allowedDays.includes(dayName)) continue;
    }
    const diff = dayjs(b.nextRespawn).tz(TW_ZONE).diff(now, "minute");

    if (diff <= 10 && diff > 9 && !b.notified && notifyAll) {
      const respTime = dayjs(b.nextRespawn).tz(TW_ZONE).format("HH:mm");
      try {
        await client.pushMessage(targetId, {
          type: "text",
          text: `⚠️ ${name} 將於 ${respTime} 重生！（剩餘 10 分鐘）`,
        });
        b.notified = true;
        await saveBossData();
        console.log(`已推播提醒：${name}`);
      } catch (err) {
        console.error("推播失敗", err);
      }
    }

    if (diff <= 0) {
      b.missedCount = (b.missedCount || 0) + 1;
      const nextTime = dayjs(b.nextRespawn).tz(TW_ZONE).add(b.interval, "hour").toISOString();
      b.nextRespawn = nextTime;
      b.notified = false;
      await saveBossData();
      console.log(`${name} 重生時間已更新為 ${nextTime}，錯過次數：${b.missedCount}`);
    }
  }
});

// ===== 初始化並啟動伺服器 =====
async function init() {
  try {
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    });
    await doc.loadInfo();
    sheet = doc.sheetsByTitle["Boss"];
    await sheet.loadHeaderRow();
    await loadBossData();
  } catch (e) {
    console.error("Google Sheets 初始化失敗:", e);
  }

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`🚀 LINE Boss Reminder Bot 已啟動，Port: ${PORT}`));
}

init();
