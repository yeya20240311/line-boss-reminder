// index.js
import express from "express";
import line from "@line/bot-sdk";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";

// ================================
// 🔧 LINE 設定
// ================================
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// ================================
// 🗂️ SQLite 初始化
// ================================
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
      last_alert_sent_iso TEXT
    )
  `);

  console.log("✅ SQLite 已連線並確保表格存在");
})();

// ================================
// 🚀 Express 啟動
// ================================
const app = express();
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  for (const event of req.body.events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    console.log("📩 收到訊息：", event.message.text);
    console.log("👤 來自使用者 ID：", event.source.userId);

    const text = event.message.text.trim();
    const reply = await handleCommand(text);
    await client.replyMessage(event.replyToken, { type: "text", text: reply });
  }
});

app.listen(10000, () => {
  console.log("🚀 LINE Boss Bot running on port 10000");
});

// ================================
// ⚙️ 指令處理
// ================================
async function handleCommand(text) {
  if (text === "/幫助") {
    return `
🧭 指令說明：

/幫助 - 顯示此說明
/設定 王名 間隔(小時) - 設定王重生間隔
/死亡 王名 時間(hh:mm) - 登記死亡時間
/BOSS - 查詢所有王狀態（依最快重生排序）
`;
  }

  if (text.startsWith("/設定")) {
    const [, boss, hours] = text.split(" ");
    if (!boss || isNaN(hours)) return "❌ 格式錯誤，請用：/設定 王名 間隔(小時)";
    await db.run(
      "INSERT INTO boss_status (boss, interval_hours) VALUES (?, ?) ON CONFLICT(boss) DO UPDATE SET interval_hours = excluded.interval_hours",
      [boss, hours]
    );
    return `✅ 已設定 ${boss} 的重生間隔為 ${hours} 小時`;
  }

  if (text.startsWith("/死亡")) {
    const [, boss, time] = text.split(" ");
    if (!boss || !time) return "❌ 格式錯誤，請用：/死亡 王名 時間(hh:mm)";

    const match = time.match(/^([0-9]{1,2}):([0-9]{2})$/);
    if (!match) return "❌ 時間格式錯誤，請使用 hh:mm 例如 14:30";

    const now = new Date();
    const deathTime = new Date(now);
    deathTime.setHours(parseInt(match[1]), parseInt(match[2]), 0, 0);

    const bossData = await db.get("SELECT interval_hours FROM boss_status WHERE boss = ?", [boss]);
    if (!bossData) return "⚠️ 請先用 /設定 設定該王的間隔";

    const nextSpawn = new Date(deathTime.getTime() + bossData.interval_hours * 60 * 60 * 1000);

    await db.run(
      "UPDATE boss_status SET last_death_iso = ?, next_spawn_iso = ?, last_alert_sent_iso = NULL WHERE boss = ?",
      [deathTime.toISOString(), nextSpawn.toISOString(), boss]
    );

    return `☠️ ${boss} 死亡時間：${time}\n⏰ 預計重生時間：${nextSpawn.toLocaleString("zh-TW", { hour12: false })}`;
  }

  if (text === "/BOSS") {
    const rows = await db.all("SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL");
    if (rows.length === 0) return "目前沒有王的資料。";

    const now = new Date();
    const sorted = rows.sort((a, b) => new Date(a.next_spawn_iso) - new Date(b.next_spawn_iso));

    let reply = "🕒 BOSS 狀態：\n\n";
    for (const r of sorted) {
      const next = new Date(r.next_spawn_iso);
      const diff = (next - now) / 1000 / 60;
      const timeStr = next.toLocaleString("zh-TW", { hour12: false });
      reply += `${r.boss}：${diff > 0 ? `還有 ${diff.toFixed(0)} 分鐘重生` : `已重生`}（${timeStr}）\n`;
    }
    return reply;
  }

  return "❓ 無效指令，請輸入 /幫助 查看可用指令";
}

// ================================
// 🕒 每分鐘檢查自動提醒
// ================================
cron.schedule("* * * * *", async () => {
  if (!db) return;
  const now = new Date();
  const bosses = await db.all("SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL");

  for (const b of bosses) {
    const nextSpawn = new Date(b.next_spawn_iso);
    const minsLeft = (nextSpawn - now) / 1000 / 60;

    if (minsLeft <= 10 && minsLeft > 0) {
      const lastAlert = b.last_alert_sent_iso ? new Date(b.last_alert_sent_iso) : null;
      const alreadyAlerted =
        lastAlert && (now - lastAlert) / 1000 / 60 < 60; // 避免重複提醒一小時內

      if (!alreadyAlerted) {
        await db.run("UPDATE boss_status SET last_alert_sent_iso = ? WHERE boss = ?", [
          now.toISOString(),
          b.boss,
        ]);

        console.log(`⚠️ ${b.boss} 即將重生（${minsLeft.toFixed(0)} 分鐘後）`);

        // ⚠️ 若你要發通知給特定使用者，請改成該 userId
        const notifyUserId = "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        await client.pushMessage(notifyUserId, {
          type: "text",
          text: `⚠️ ${b.boss} 即將在 ${minsLeft.toFixed(0)} 分鐘後重生！`,
        });
      }
    }
  }
});
