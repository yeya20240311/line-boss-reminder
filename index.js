import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import cron from "node-cron";

dotenv.config();

// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// JSON 檔案
const bossFile = path.resolve("./boss.json");
let bossData = {};

// 載入 JSON
if (fs.existsSync(bossFile)) {
  bossData = JSON.parse(fs.readFileSync(bossFile));
  console.log("✅ JSON 已載入並確保可用");
} else {
  fs.writeFileSync(bossFile, JSON.stringify({}));
  console.log("✅ JSON 已建立");
}

// 儲存 JSON
function saveBossData() {
  fs.writeFileSync(bossFile, JSON.stringify(bossData, null, 2));
}

// ===== Express =====
const app = express();

// 用 raw 保留原始 body 給 LINE SDK 驗證
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

// ===== 指令處理 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
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
/BOSS
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

  // /設定 王名 時間
  if (args[0] === "/設定" && args.length === 3) {
    const [_, name, hours] = args;
    bossData[name] = {
      interval: parseFloat(hours),
      lastDeath: null,
    };
    saveBossData();
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
    const mins = Math.round((parseFloat(remain) - hours) * 60);
    bossData[name].lastDeath = dayjs().add(hours, "hour").add(mins, "minute").toISOString();
    saveBossData();
    const respTime = dayjs(bossData[name].lastDeath).format("HH:mm");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🕒 已登記 ${name} 將於 ${respTime} 重生`,
    });
    return;
  }

  // /刪除 王名
  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    delete bossData[name];
    saveBossData();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🗑 已刪除 ${name}`,
    });
    return;
  }

  // /BOSS
  if (text === "/BOSS") {
    const list = Object.keys(bossData)
      .map((name) => {
        if (!bossData[name].lastDeath) return `${name} 尚未登記死亡`;
        const remain = dayjs(bossData[name].lastDeath).diff(dayjs(), "minute");
        const h = Math.floor(remain / 60);
        const m = remain % 60;
        const respTime = dayjs(bossData[name].lastDeath).format("HH:mm");
        return `🕓 ${name} 剩餘 ${h}小時${m}分（預定 ${respTime}）`;
      })
      .join("\n");
    await client.replyMessage(event.replyToken, { type: "text", text: list || "尚無資料" });
    return;
  }
}

// ===== 每分鐘檢查重生前10分鐘 =====
cron.schedule("* * * * *", async () => {
  const now = dayjs();
  for (const name in bossData) {
    const boss = bossData[name];
    if (!boss.lastDeath || !boss.interval) continue;

    const diff = dayjs(boss.lastDeath).diff(now, "minute");
    // 差10分鐘，推播一次
    if (diff <= 10 && diff > 9) {
      const respTime = dayjs(boss.lastDeath).format("HH:mm");
      try {
        await client.pushMessage(process.env.USER_ID, {
          type: "text",
          text: `@ALL ⚔️ ${name} 即將在 10 分鐘後重生！（預定 ${respTime}）`,
        });
      } catch (err) {
        console.error(err);
      }
    }
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 LINE Boss Bot running on port 10000");
});
