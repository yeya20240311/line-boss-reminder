import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import cron from "node-cron";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dotenv.config();
dayjs.extend(utc);
dayjs.extend(timezone);

const TW_ZONE = "Asia/Taipei";

// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ===== JSON 儲存 =====
const bossFile = path.resolve("./boss.json");
let bossData = {};
let notifyAll = true;

if (fs.existsSync(bossFile)) {
  bossData = JSON.parse(fs.readFileSync(bossFile));
  console.log("✅ JSON 已載入");
} else {
  fs.writeFileSync(bossFile, JSON.stringify({}, null, 2));
  console.log("✅ 已建立 boss.json");
}

function saveBossData() {
  fs.writeFileSync(bossFile, JSON.stringify(bossData, null, 2));
}

// ===== Express =====
const app = express();

// 先解析 JSON，再套 middleware
app.post("/webhook", express.json(), middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    if (!events) return res.sendStatus(200);
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
/設定 王名 間隔(小時)
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
    const id = event.source.userId || event.source.groupId || "無法取得";
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `你的 ID：${id}`,
    });
    return;
  }

  // /設定 王名 間隔
  if (args[0] === "/設定" && args.length === 3) {
    const [_, name, hours] = args;
    const num = parseFloat(hours);
    if (isNaN(num) || num <= 0) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ 間隔格式錯誤，請輸入正確小時數",
      });
      return;
    }
    bossData[name] = bossData[name] || {};
    bossData[name].interval = num;
    saveBossData();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已設定 ${name} 重生間隔 ${hours} 小時`,
    });
    return;
  }

  // /重生 王名 剩餘時間
  if (args[0] === "/重生" && args.length === 3) {
    const [_, name, remain] = args;
    if (!bossData[name] || !bossData[name].interval) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `請先用 /設定 ${name} 間隔(小時)`,
      });
      return;
    }

    // 解析 小時.分鐘
    const parts = remain.split(".");
    const h = parseInt(parts[0]);
    const m = parts[1] ? parseInt(parts[1].padEnd(2, "0")) : 0;

    if (isNaN(h) || isNaN(m)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ 剩餘時間格式錯誤，請輸入 小時.分，例如 1.30 或 0.45",
      });
      return;
    }

    bossData[name].nextRespawn = dayjs().tz(TW_ZONE).add(h, "hour").add(m, "minute").toISOString();
    bossData[name].notified = false;
    saveBossData();

    const respTime = dayjs(bossData[name].nextRespawn).tz(TW_ZONE).format("HH:mm");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🕒 已設定 ${name} 將於 ${respTime} 重生`,
    });
    return;
  }

  // /刪除 王名
  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    if (bossData[name]) {
      delete bossData[name];
      saveBossData();
      await client.replyMessage(event.replyToken, { type: "text", text: `🗑 已刪除 ${name}` });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: `${name} 不存在` });
    }
    return;
  }

  // /王
  if (text === "/王") {
    const now = dayjs().tz(TW_ZONE);
    const list = Object.keys(bossData)
      .map((name) => {
        const b = bossData[name];
        if (!b.nextRespawn) return { name, diff: Infinity, text: `❌ ${name} 尚未設定重生時間` };
        const diff = dayjs(b.nextRespawn).tz(TW_ZONE).diff(now, "minute");
        if (isNaN(diff)) return { name, diff: Infinity, text: `❌ ${name} 重生時間格式錯誤` };
        const h = Math.floor(diff / 60);
        const m = diff % 60;
        const respTime = dayjs(b.nextRespawn).tz(TW_ZONE).format("HH:mm");
        return { name, diff, text: `⚔️ ${name} 剩餘 ${h}小時${m}分（預計 ${respTime}）` };
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

  // /開啟通知
  if (text === "/開啟通知") {
    notifyAll = true;
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "✅ 已開啟所有前10分鐘通知",
    });
    return;
  }

  // /關閉通知
  if (text === "/關閉通知") {
    notifyAll = false;
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 已關閉所有前10分鐘通知",
    });
    return;
  }
}

// ===== 每分鐘檢查重生前10分鐘提醒 =====
cron.schedule("* * * * *", async () => {
  const now = dayjs().tz(TW_ZONE);
  const hour = now.hour();
  const targetId = process.env.USER_ID;

  if (!targetId) {
    console.error("❌ USER_ID 尚未設定");
    return;
  }

  for (const [name, boss] of Object.entries(bossData)) {
    if (!boss.nextRespawn || !boss.interval) continue;
    const diff = dayjs(boss.nextRespawn).tz(TW_ZONE).diff(now, "minute");
    if (isNaN(diff)) continue;

    if (diff <= 10 && diff > 9 && !boss.notified && notifyAll) {
      const respTime = dayjs(boss.nextRespawn).tz(TW_ZONE).format("HH:mm");
      try {
        await client.pushMessage(targetId, {
          type: "text",
          text: `${hour >= 9 && hour < 24 ? "@ALL " : ""}⚠️ ${name} 將於 ${respTime} 重生！（剩餘 10 分鐘）`,
        });
        boss.notified = true;
        saveBossData();
        console.log(`已推播提醒：${name}`);
      } catch (err) {
        console.error("推播失敗", err);
      }
    }

    if (diff <= 0) {
      const nextTime = dayjs(boss.nextRespawn).tz(TW_ZONE).add(boss.interval, "hour").toISOString();
      boss.nextRespawn = nextTime;
      boss.notified = false;
      saveBossData();
      console.log(`${name} 重生時間已更新為 ${nextTime}`);
    }
  }
});

// ===== 啟動伺服器 =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 LINE Boss Reminder Bot 已啟動，Port: ${PORT}`));
