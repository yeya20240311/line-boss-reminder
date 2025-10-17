import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import fs from "fs";
import cron from "node-cron";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const PORT = process.env.PORT || 10000;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const USER_ID = process.env.USER_ID; // 你的 LINE 使用者ID或群組ID

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !USER_ID) {
  console.error("請先設定環境變數 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN 與 USER_ID");
  process.exit(1);
}

// LINE client
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

// JSON 檔路徑
const BOSS_FILE = "./boss.json";

// 初始化 boss.json
let bosses = {};
if (fs.existsSync(BOSS_FILE)) {
  bosses = JSON.parse(fs.readFileSync(BOSS_FILE));
} else {
  fs.writeFileSync(BOSS_FILE, JSON.stringify({}));
}

// 保存 JSON
function saveBosses() {
  fs.writeFileSync(BOSS_FILE, JSON.stringify(bosses, null, 2));
}

// 計算剩餘時間
function getRemainingTime(nextSpawn) {
  const diffMs = dayjs(nextSpawn).diff(dayjs());
  if (diffMs <= 0) return "已重生";
  const h = Math.floor(diffMs / 1000 / 3600);
  const m = Math.floor((diffMs / 1000 % 3600) / 60);
  return `${h}小時${m}分`;
}

// Express
const app = express();
app.use(express.json());
app.post("/webhook", middleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;
      const userMessage = event.message.text.trim();
      const replyToken = event.replyToken;

      if (userMessage === "/幫助") {
        await client.replyMessage(replyToken, {
          type: "text",
          text: `
/幫助：顯示說明
/設定 王名 間隔(小時)：設定重生間隔
/重生 王名 剩餘時間：紀錄剩餘重生時間
/刪除 王名：刪除王
/BOSS：查詢所有王的狀態與最快重生
/我的ID：顯示你的使用者ID
          `.trim(),
        });
      } else if (userMessage.startsWith("/設定 ")) {
        const match = userMessage.match(/^\/設定\s+(.+)\s+(\d+)$/);
        if (match) {
          const name = match[1];
          const interval = parseInt(match[2]);
          if (!bosses[name]) bosses[name] = {};
          bosses[name].interval = interval;
          saveBosses();
          await client.replyMessage(replyToken, { type: "text", text: `✅ 已設定 ${name} 重生間隔 ${interval} 小時` });
        }
      } else if (userMessage.startsWith("/重生 ")) {
        const match = userMessage.match(/^\/重生\s+(.+)\s+(\d+\.?\d*)$/);
        if (match) {
          const name = match[1];
          const remainHours = parseFloat(match[2]);
          if (!bosses[name]) {
            await client.replyMessage(replyToken, { type: "text", text: `❌ ${name} 尚未設定重生間隔` });
            continue;
          }
          const nextSpawn = dayjs().add(remainHours, "hour").toISOString();
          bosses[name].next_spawn = nextSpawn;
          saveBosses();
          await client.replyMessage(replyToken, {
            type: "text",
            text: `🕒 已登記 ${name} 將於 ${dayjs(nextSpawn).tz("Asia/Taipei").format("HH:mm")} 重生`,
          });
        }
      } else if (userMessage.startsWith("/刪除 ")) {
        const name = userMessage.replace("/刪除 ", "").trim();
        if (bosses[name]) {
          delete bosses[name];
          saveBosses();
          await client.replyMessage(replyToken, { type: "text", text: `🗑 已刪除 ${name}` });
        } else {
          await client.replyMessage(replyToken, { type: "text", text: `❌ 找不到 ${name}` });
        }
      } else if (userMessage === "/BOSS") {
        const list = Object.entries(bosses)
          .map(([name, data]) => {
            if (!data.next_spawn) return `🕓 ${name} 尚未登記`;
            return `🕓 ${name} 剩餘 ${getRemainingTime(data.next_spawn)} (預定 ${dayjs(data.next_spawn).tz("Asia/Taipei").format("HH:mm")})`;
          })
          .sort((a, b) => {
            const nextA = bosses[a.split(" ")[1]]?.next_spawn;
            const nextB = bosses[b.split(" ")[1]]?.next_spawn;
            return nextA && nextB ? dayjs(nextA).diff(dayjs(nextB)) : 0;
          })
          .join("\n");
        await client.replyMessage(replyToken, { type: "text", text: list || "尚未有王的紀錄" });
      } else if (userMessage === "/我的ID") {
        await client.replyMessage(replyToken, { type: "text", text: `你的ID：${event.source.userId}` });
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Cron 每分鐘檢查提醒
cron.schedule("* * * * *", async () => {
  const now = dayjs();
  for (const [name, data] of Object.entries(bosses)) {
    if (!data.next_spawn || data.alert_sent) continue;
    const diffMin = dayjs(data.next_spawn).diff(now, "minute");
    if (diffMin === 10) {
      try {
        await client.pushMessage(USER_ID, {
          type: "text",
          text: `@ALL ⚔️ ${name} 即將在 10 分鐘後重生！（預定 ${dayjs(data.next_spawn).tz("Asia/Taipei").format("HH:mm")}）`,
        });
        data.alert_sent = true; // 確保只推播一次
        saveBosses();
      } catch (err) {
        console.error("cron db read error", err);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
  console.log("✅ boss.json 已載入並確保可用");
});
