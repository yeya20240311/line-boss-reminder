import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import cron from "node-cron";

dayjs.extend(utc);
dayjs.extend(timezone);

const PORT = process.env.PORT || 3000;
const USER_ID = process.env.USER_ID; // 你的 LINE user 或群組 ID
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

if (!USER_ID || !CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.error(
    "請先設定環境變數 LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_SECRET 與 USER_ID"
  );
  process.exit(1);
}

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

const app = express();
app.use(express.json());
app.use(middleware({ channelSecret: CHANNEL_SECRET }));

// JSON 存檔位置
const DATA_PATH = path.resolve("./bosses.json");

// 初始王設定
let bosses = {
  "冰2北": { next_spawn: null, interval_hours: 18, alertSent: false },
  "激3右上": { next_spawn: null, interval_hours: 12, alertSent: false },
  "冰1": { next_spawn: null, interval_hours: 12, alertSent: false },
  "冰2南": { next_spawn: null, interval_hours: 12, alertSent: false },
  "奇3北": { next_spawn: null, interval_hours: 12, alertSent: false },
  "奇1北": { next_spawn: null, interval_hours: 12, alertSent: false },
  "激2右": { next_spawn: null, interval_hours: 12, alertSent: false },
  "奇3南": { next_spawn: null, interval_hours: 24, alertSent: false },
  "奇2西": { next_spawn: null, interval_hours: 24, alertSent: false },
  "奇2東": { next_spawn: null, interval_hours: 24, alertSent: false },
  "奇1南": { next_spawn: null, interval_hours: 24, alertSent: false },
};

// 讀取 JSON 檔案
if (fs.existsSync(DATA_PATH)) {
  try {
    const data = fs.readFileSync(DATA_PATH, "utf-8");
    bosses = JSON.parse(data);
    console.log("已載入 bosses.json");
  } catch (err) {
    console.error("JSON 載入失敗，使用預設初始資料");
  }
}

// 儲存 JSON
function saveBosses() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(bosses, null, 2), "utf-8");
}

// 計算剩餘時間
function getRemainingTime(nextSpawn) {
  const now = dayjs();
  const target = dayjs(nextSpawn);
  const diff = target.diff(now, "minute");
  if (diff <= 0) return "0小時0分";
  const hours = Math.floor(diff / 60);
  const minutes = diff % 60;
  return `${hours}小時${minutes}分`;
}

// LINE webhook
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userMessage = event.message.text.trim();
      const replyToken = event.replyToken;

      if (userMessage === "/幫助") {
        await client.replyMessage(replyToken, {
          type: "text",
          text:
            "/幫助：顯示說明\n" +
            "/設定 王名 間隔(小時)：設定重生間隔\n" +
            "/重生 王名 剩餘時間(小時.分)：記錄剩餘時間\n" +
            "/刪除 王名：刪除王資訊\n" +
            "/BOSS：查詢所有王狀態與剩餘時間\n" +
            "/我的ID：查看你的 LINE ID",
        });
      } else if (userMessage.startsWith("/我的ID")) {
        await client.replyMessage(replyToken, {
          type: "text",
          text: `你的 LINE ID: ${event.source.userId}`,
        });
      } else if (userMessage.startsWith("/BOSS")) {
        let msg = "";
        for (const [name, info] of Object.entries(bosses)) {
          if (!info.next_spawn) {
            msg += `🕓 ${name} 未設定重生時間\n`;
          } else {
            const remain = getRemainingTime(info.next_spawn);
            const spawnTime = dayjs(info.next_spawn).format("HH:mm");
            msg += `🕓 ${name} 剩餘 ${remain}（預定 ${spawnTime}）\n`;
          }
        }
        await client.replyMessage(replyToken, { type: "text", text: msg });
      } else if (userMessage.startsWith("/重生")) {
        // 格式: /重生 王名 16.59
        const parts = userMessage.split(" ");
        if (parts.length === 3) {
          const bossName = parts[1];
          const remainStr = parts[2];
          if (!bosses[bossName]) {
            await client.replyMessage(replyToken, {
              type: "text",
              text: `${bossName} 不存在`,
            });
            return;
          }
          const [hours, minutes] = remainStr.split(".").map(Number);
          const nextSpawn = dayjs().add(hours, "hour").add(minutes, "minute");
          bosses[bossName].next_spawn = nextSpawn.toISOString();
          bosses[bossName].alertSent = false;
          saveBosses();
          await client.replyMessage(replyToken, {
            type: "text",
            text: `🕒 已登記 ${bossName} 將於 ${nextSpawn.format(
              "HH:mm"
            )} 重生`,
          });
        }
      } else if (userMessage.startsWith("/刪除")) {
        const parts = userMessage.split(" ");
        if (parts.length === 2) {
          const bossName = parts[1];
          if (!bosses[bossName]) {
            await client.replyMessage(replyToken, {
              type: "text",
              text: `${bossName} 不存在`,
            });
            return;
          }
          bosses[bossName].next_spawn = null;
          bosses[bossName].alertSent = false;
          saveBosses();
          await client.replyMessage(replyToken, {
            type: "text",
            text: `🗑️ 已刪除 ${bossName} 重生時間`,
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// 前10分鐘推播提醒
cron.schedule("*/1 * * * *", async () => {
  const now = dayjs();
  for (const [name, info] of Object.entries(bosses)) {
    if (!info.next_spawn || info.alertSent) continue;
    const target = dayjs(info.next_spawn);
    const diffMin = target.diff(now, "minute");
    if (diffMin <= 10 && diffMin > 9) {
      try {
        await client.pushMessage(USER_ID, {
          type: "text",
          text: `@ALL ⚔️ ${name} 即將在 10 分鐘後重生！（預定 ${target.format(
            "HH:mm"
          )}）`,
        });
        bosses[name].alertSent = true;
        saveBosses();
        console.log(`已推播 ${name} 前10分鐘提醒`);
      } catch (err) {
        console.error("推播失敗", err);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
  console.log(`✅ 已確保 bosses.json 存在`);
});
