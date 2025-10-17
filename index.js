import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import moment from "moment-timezone";
import cron from "node-cron";

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const TZ = process.env.TIMEZONE || "Asia/Taipei";
const app = express();
const port = process.env.PORT || 3000;
const client = new Client(config);

// --- 初始化資料庫 ---
let db;
(async () => {
  db = await open({
    filename: "./bot.db",
    driver: sqlite3.Database,
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS boss_status (
      boss TEXT PRIMARY KEY,
      interval_hours INTEGER,
      last_death_iso TEXT,
      next_spawn_iso TEXT,
      last_alert_sent_notify_iso TEXT
    );
  `);
  console.log("✅ SQLite 已連線並確保表格存在");
})();

// --- LINE Webhook ---
app.post("/webhook", middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook Error:", err);
      res.status(500).end();
    });
});

// --- 處理事件 ---
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const msg = event.message.text.trim();
  const replyToken = event.replyToken;

  // 指令處理
  if (msg === "/幫助") {
    return replyText(
      replyToken,
      `📘 指令列表：
/設定 王名 間隔(小時) → 設定重生間隔
/死亡 王名 時間(HH:mm) → 記錄死亡時間
/BOSS → 查詢所有王狀態
（系統會於重生前 10 分鐘自動提醒）`
    );
  }

  if (msg.startsWith("/設定")) {
    const [, boss, hours] = msg.split(" ");
    if (!boss || !hours || isNaN(hours)) {
      return replyText(replyToken, "❌ 格式錯誤，例：/設定 紅龍 8");
    }
    await db.run(
      `INSERT INTO boss_status (boss, interval_hours)
       VALUES (?, ?) 
       ON CONFLICT(boss) DO UPDATE SET interval_hours=?`,
      [boss, hours, hours]
    );
    return replyText(replyToken, `✅ 已設定 ${boss} 重生間隔 ${hours} 小時`);
  }

  if (msg.startsWith("/死亡")) {
    const [, boss, time] = msg.split(" ");
    if (!boss || !time || !/^\d{1,2}:\d{2}$/.test(time)) {
      return replyText(replyToken, "❌ 格式錯誤，例：/死亡 紅龍 13:20");
    }

    const info = await db.get("SELECT interval_hours FROM boss_status WHERE boss=?", [boss]);
    if (!info) return replyText(replyToken, `⚠️ 尚未設定 ${boss} 的重生間隔`);

    const lastDeath = moment.tz(time, "HH:mm", TZ);
    const nextSpawn = lastDeath.clone().add(info.interval_hours, "hours");

    await db.run(
      `UPDATE boss_status 
       SET last_death_iso=?, next_spawn_iso=?, last_alert_sent_notify_iso=NULL
       WHERE boss=?`,
      [lastDeath.toISOString(), nextSpawn.toISOString(), boss]
    );

    return replyText(
      replyToken,
      `💀 已記錄 ${boss} 死亡 ${lastDeath.format("HH:mm")}\n⏰ 預計重生 ${nextSpawn.format("HH:mm")}`
    );
  }

  if (msg === "/BOSS") {
    const bosses = await db.all(
      "SELECT boss, next_spawn_iso, interval_hours FROM boss_status WHERE next_spawn_iso IS NOT NULL ORDER BY next_spawn_iso ASC"
    );
    if (!bosses.length) return replyText(replyToken, "目前沒有任何已登錄的王。");

    let msgText = "👑 BOSS 狀態如下：\n";
    const now = moment.tz(TZ);
    for (const b of bosses) {
      const next = moment(b.next_spawn_iso);
      const diff = next.diff(now, "minutes");
      const status = diff <= 0 ? "🟢 可重生" : `⏰ ${diff} 分鐘後`;
      msgText += `\n${b.boss} → ${next.format("HH:mm")}（${status}）`;
    }
    return replyText(replyToken, msgText);
  }
}

// --- LINE 回覆 ---
function replyText(token, text) {
  return client.replyMessage(token, { type: "text", text });
}

// --- 自動提醒：重生前10分鐘 ---
cron.schedule("* * * * *", async () => {
  try {
    const now = moment.tz(TZ);
    const bosses = await db.all("SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL");

    for (const b of bosses) {
      const nextSpawn = moment(b.next_spawn_iso);
      const diff = nextSpawn.diff(now, "minutes");

      // 提前10分鐘提醒（且只提醒一次）
      if (diff <= 10 && diff > 0) {
        const lastNotify = b.last_alert_sent_notify_iso ? moment(b.last_alert_sent_notify_iso) : null;
        if (!lastNotify || now.diff(lastNotify, "minutes") > 30) {
          const message = {
            type: "text",
            text: `⚔️ ${b.boss} 即將在 ${diff} 分鐘後重生！（預定 ${nextSpawn.format("HH:mm")}）`,
          };
          // ⚠️ 替換成你要通知的群組或使用者 ID
          await client.pushMessage("<YOUR_USER_OR_GROUP_ID>", message);

          await db.run(
            "UPDATE boss_status SET last_alert_sent_notify_iso=? WHERE boss=?",
            [now.toISOString(), b.boss]
          );
          console.log(`📢 已提醒 ${b.boss} 重生前 10 分鐘`);
        }
      }
    }
  } catch (err) {
    console.error("cron db read error", err);
  }
});

app.listen(port, () => console.log(`🚀 LINE Boss Bot running on port ${port}`));
