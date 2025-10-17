import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import cron from "node-cron";

// ---- 設定環境變數 ----
const PORT = process.env.PORT || 3000;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const USER_ID = process.env.USER_ID; // LINE 個人或群組 ID

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !USER_ID) {
  console.error("請先設定環境變數 LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_SECRET 與 USER_ID");
  process.exit(1);
}

// ---- 初始化 LINE client ----
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

// ---- 初始化 Express ----
const app = express();
app.use(bodyParser.json());

// ---- JSON 檔案路徑 ----
const DATA_FILE = path.resolve("./boss_data.json");

// ---- 讀取或初始化 JSON ----
let bossData = {};
if (fs.existsSync(DATA_FILE)) {
  try {
    bossData = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (err) {
    console.error("JSON 讀取錯誤，初始化新資料", err);
    bossData = {};
  }
} else {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bossData, null, 2));
}

// ---- 儲存 JSON 函數 ----
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bossData, null, 2));
}

// ---- 計算剩餘時間 ----
function getRemainingTime(boss) {
  if (!boss.next_spawn) return null;
  const now = dayjs();
  const next = dayjs(boss.next_spawn);
  const diff = next.diff(now, "minute");
  if (diff <= 0) return "已重生";
  const hours = Math.floor(diff / 60);
  const minutes = diff % 60;
  return `${hours}小時${minutes}分`;
}

// ---- 自動推播前10分鐘 ----
cron.schedule("* * * * *", async () => {
  const now = dayjs();
  for (const [name, boss] of Object.entries(bossData)) {
    if (!boss.next_spawn || boss.alerted) continue;
    const next = dayjs(boss.next_spawn);
    const diff = next.diff(now, "minute");
    if (diff <= 10 && diff > 9) {
      try {
        await client.pushMessage(USER_ID, {
          type: "text",
          text: `@ALL ⚔️ ${name} 即將在 10 分鐘後重生！（預定 ${next.format("HH:mm")}）`,
        });
        boss.alerted = true;
        saveData();
      } catch (err) {
        console.error("推播失敗", err);
      }
    }
  }
});

// ---- LINE Webhook ----
app.post("/webhook", middleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;
      const text = event.message.text.trim();
      let reply = "";

      // /幫助
      if (text === "/幫助") {
        reply = `/幫助：顯示說明
/設定 王名 時間：設定重生間隔（小時）
/重生 王名 剩餘時間：設定剩餘多久重生（小時.分鐘）
/刪除 王名：刪除王的紀錄
/BOSS：查詢所有王的狀態`;
      }
      // /設定
      else if (text.startsWith("/設定")) {
        const parts = text.split(" ");
        if (parts.length >= 3) {
          const name = parts[1];
          const hours = parseFloat(parts[2]);
          if (!isNaN(hours)) {
            bossData[name] = bossData[name] || {};
            bossData[name].interval = hours;
            saveData();
            reply = `✅ 已設定 ${name} 重生間隔 ${hours} 小時`;
          } else reply = "時間格式錯誤";
        } else reply = "指令格式：/設定 王名 時間";
      }
      // /重生
      else if (text.startsWith("/重生")) {
        const parts = text.split(" ");
        if (parts.length >= 3) {
          const name = parts[1];
          const remaining = parseFloat(parts[2]);
          if (!isNaN(remaining)) {
            const hours = Math.floor(remaining);
            const minutes = Math.round((remaining - hours) * 60);
            const next = dayjs().add(hours, "hour").add(minutes, "minute");
            bossData[name] = bossData[name] || {};
            bossData[name].next_spawn = next.toISOString();
            bossData[name].alerted = false; // 重新計算是否推播
            saveData();
            reply = `🕒 已登記 ${name} 將於 ${next.format("HH:mm")} 重生`;
          } else reply = "剩餘時間格式錯誤";
        } else reply = "指令格式：/重生 王名 剩餘時間";
      }
      // /刪除
      else if (text.startsWith("/刪除")) {
        const parts = text.split(" ");
        if (parts.length >= 2) {
          const name = parts[1];
          delete bossData[name];
          saveData();
          reply = `🗑 已刪除 ${name} 的紀錄`;
        } else reply = "指令格式：/刪除 王名";
      }
      // /BOSS
      else if (text === "/BOSS") {
        if (Object.keys(bossData).length === 0) reply = "目前沒有紀錄";
        else {
          const list = Object.entries(bossData)
            .map(([name, boss]) => {
              const remaining = getRemainingTime(boss);
              const nextTime = boss.next_spawn ? dayjs(boss.next_spawn).format("YYYY-MM-DD HH:mm") : "-";
              return `🕓 ${name} 剩餘 ${remaining} (預定 ${nextTime})`;
            })
            .sort((a, b) => {
              const diffA = bossData[a.split(" ")[1]]?.next_spawn ? dayjs(bossData[a.split(" ")[1]].next_spawn).diff(dayjs()) : 0;
              const diffB = bossData[b.split(" ")[1]]?.next_spawn ? dayjs(bossData[b.split(" ")[1]].next_spawn).diff(dayjs()) : 0;
              return diffA - diffB;
            });
          reply = list.join("\n");
        }
      }

      if (reply) {
        await client.replyMessage(event.replyToken, { type: "text", text: reply });
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ---- 啟動伺服器 ----
app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
  console.log("✅ JSON 已連線並確保表格存在");
});
