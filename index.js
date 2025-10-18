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

// ===== 檔案儲存 =====
const bossFile = path.resolve("./boss.json");
let bossData = {};

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
app.use(express.json()); // 必須在 middleware 前

// Webhook
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.send("LINE Boss Reminder Bot is running."));

// ===== 處理指令 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const args = text.split(/\s+/);
  const sourceId = event.source.groupId || event.source.roomId || event.source.userId;

  // /幫助
  if (text === "/幫助") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `可用指令：
/設定 王名 間隔(小時)
/重生 王名 剩餘時間(小時.分)
/刪除 王名
/BOSS
/我的ID`,
    });
    return;
  }

  // /我的ID
  if (text === "/我的ID") {
    const id = sourceId || "無法取得";
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `你的 ID：${id}`,
    });
    return;
  }

  // /設定 王名 間隔
  if (args[0] === "/設定" && args.length === 3) {
    const [_, name, hours] = args;
    bossData[name] = bossData[name] || {};
    bossData[name].interval = parseFloat(hours);
    bossData[name].targetId = sourceId;
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

    const h = Math.floor(parseFloat(remain));
    const m = Math.round((parseFloat(remain) - h) * 60);
    bossData[name].nextRespawn = dayjs().add(h, "hour").add(m, "minute").toISOString();
    bossData[name].targetId = sourceId;
    bossData[name].notified = false;
    saveBossData();

    const respTime = dayjs(bossData[name].nextRespawn).format("HH:mm");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `🕒 已設定 ${name} 將於 ${respTime} 重生`,
    });
    return;
  }

  // /刪除
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

  // /BOSS
  if (text === "/BOSS") {
    const now = dayjs();
    const list = Object.keys(bossData)
      .map((name) => {
        const b = bossData[name];
        if (!b.nextRespawn) return `❌ ${name} 尚未設定重生時間`;
        const diff = dayjs(b.nextRespawn).diff(now, "minute");
        const h = Math.floor(diff / 60);
        const m = diff % 60;
        const respTime = dayjs(b.nextRespawn).format("HH:mm");
        return `⚔️ ${name} 剩餘 ${h}小時${m}分（預計 ${respTime}）`;
      })
      .join("\n");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: list || "尚無任何王的資料",
    });
    return;
  }
}

// ===== 定時檢查重生前10分鐘提醒 =====
cron.schedule("* * * * *", async () => {
  const now = dayjs();
  for (const [name, boss] of Object.entries(bossData)) {
    if (!boss.nextRespawn || !boss.interval || !boss.targetId) continue;

    const diff = dayjs(boss.nextRespawn).diff(now, "minute");

    // 剩餘 10 分鐘 通知一次
    if (diff <= 10 && diff > 9 && !boss.notified) {
      const respTime = dayjs(boss.nextRespawn).format("HH:mm");
      try {
        await client.pushMessage(boss.targetId, {
          type: "text",
          text: `⚠️ ${name} 將於 ${respTime} 重生！（剩餘 10 分鐘）`,
        });
        boss.notified = true;
        saveBossData();
        console.log(`已推播提醒：${name}`);
      } catch (err) {
        console.error("推播失敗", err);
      }
    }

    // 若時間已過，重置為下一輪
    if (diff <= 0) {
      const nextTime = dayjs(boss.nextRespawn).add(boss.interval, "hour").toISOString();
      boss.nextRespawn = nextTime;
      boss.notified = false;
      saveBossData();
      console.log(`${name} 重生時間已更新為 ${nextTime}`);
    }
  }
});

// ===== 啟動伺服器 =====
app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 LINE Boss Reminder Bot 已啟動");
});
