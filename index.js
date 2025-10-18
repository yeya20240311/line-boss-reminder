import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import cron from "node-cron";
import dayjs from "dayjs";

dotenv.config();

const app = express();

// ===== LINE BOT 設定 =====
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(lineConfig);

// ===== 資料暫存 =====
let bossData = {}; // { 王名: { time: 'HH:mm', respawn: 'HH:mm' } }
let notificationsEnabled = true;

// ===== 測試連線 =====
app.get("/", (req, res) => res.send("LINE Boss Bot is running"));

// ===== LINE Webhook =====
app.post(
  "/webhook",
  express.json(), // 用 express.json() 解析 JSON body
  middleware(lineConfig),
  async (req, res) => {
    try {
      const events = req.body.events;
      await Promise.all(events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      console.error("❌ Webhook error:", err);
      res.status(200).end();
    }
  }
);

// ===== 處理指令 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 🔔 開啟 / 關閉通知
  if (text === "/開啟通知") {
    notificationsEnabled = true;
    await reply(replyToken, "🔔 已開啟所有通知");
    return;
  }
  if (text === "/關閉通知") {
    notificationsEnabled = false;
    await reply(replyToken, "🔕 已關閉所有通知");
    return;
  }

  // 🕒 /重生 王名 時間
  if (text.startsWith("/重生")) {
    const parts = text.split(" ");
    if (parts.length < 3)
      return await reply(
        replyToken,
        "⚠️ 指令格式錯誤：/重生 王名 時間(小時.分鐘)"
      );

    const name = parts[1];
    const hours = parseFloat(parts[2]);
    if (isNaN(hours)) return await reply(replyToken, "⚠️ 時間格式錯誤");

    const now = dayjs();
    const respawn = now.add(hours * 60, "minute");
    bossData[name] = {
      time: now.format("HH:mm"),
      respawn: respawn.format("HH:mm"),
    };

    await reply(
      replyToken,
      `🕒 已設定 ${name} 將於 ${respawn.format("HH:mm")} 重生`
    );
    return;
  }

  // 📋 /BOSS 或 /王
  if (text === "/BOSS" || text === "/王") {
    if (Object.keys(bossData).length === 0)
      return await reply(replyToken, "目前沒有紀錄的王。");

    const sorted = Object.entries(bossData).sort(
      (a, b) => dayjs(b[1].respawn, "HH:mm").diff(dayjs(a[1].respawn, "HH:mm"))
    );

    const msg = sorted
      .map(
        ([n, d]) =>
          `${n}：剩餘 ${Math.max(
            dayjs(d.respawn, "HH:mm").diff(dayjs(), "minute"),
            0
          )} 分 → ${d.respawn}`
      )
      .join("\n");

    await reply(replyToken, msg);
    return;
  }
}

// ===== 回覆訊息函式 =====
async function reply(token, message) {
  try {
    await client.replyMessage(token, { type: "text", text: message });
  } catch (err) {
    console.error(
      "❌ 回覆訊息失敗：",
      err.originalError?.response?.data || err.message
    );
  }
}

// ===== 自動通知（每分鐘檢查） =====
cron.schedule("* * * * *", async () => {
  if (!notificationsEnabled) return;

  const now = dayjs();
  for (const [name, data] of Object.entries(bossData)) {
    const respawn = dayjs(data.respawn, "HH:mm");
    const diff = respawn.diff(now, "minute");

    if (diff === 10) {
      await client.pushMessage(process.env.GROUP_ID, {
        type: "text",
        text: `⚠️ ${name} 將於 ${data.respawn} 重生！（剩餘 10 分鐘）`,
      });
    }
  }
});

// ===== 啟動服務 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 LINE Boss Bot running"));
