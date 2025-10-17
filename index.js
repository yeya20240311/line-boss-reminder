import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import moment from "moment-timezone";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const TZ = process.env.TIMEZONE || "Asia/Taipei";
const PORT = process.env.PORT || 3000;
const app = express();

// ================== LINE Webhook ==================
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json(results);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(500).end();
  }
});

// ================== SQLite 初始化 ==================
let db;
(async () => {
  db = await open({
    filename: "./bot.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS boss_status (
      boss TEXT PRIMARY KEY,
      respawn_hours INTEGER,
      death_time_iso TEXT,
      next_spawn_iso TEXT
    )
  `);

  console.log("✅ SQLite 已連線並確保表格存在");
})();

// ================== LINE Bot 初始化 ==================
const client = new Client(config);

// ================== 處理 LINE 訊息 ==================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const msg = event.message.text.trim();
  const replyToken = event.replyToken;

  // /幫助
  if (msg === "/幫助") {
    const helpMsg =
      "📘 指令說明：\n" +
      "/幫助：顯示此說明\n" +
      "/設定 王名 間隔(小時)：設定重生間隔\n" +
      "/死亡 王名 時間(HH:mm)：紀錄死亡時間\n" +
      "/BOSS：查詢所有王狀態（依最快重生排序）";
    return reply(replyToken, helpMsg);
  }

  // /設定 王名 間隔
  if (msg.startsWith("/設定")) {
    const parts = msg.split(" ");
    if (parts.length !== 3) return reply(replyToken, "❌ 格式錯誤，範例：/設定 紅龍 8");
    const [_, boss, hours] = parts;
    const respawn = parseInt(hours);
    if (isNaN(respawn)) return reply(replyToken, "❌ 間隔必須是數字（單位：小時）");

    await db.run(
      `INSERT OR REPLACE INTO boss_status (boss, respawn_hours, death_time_iso, next_spawn_iso)
       VALUES (?, ?, NULL, NULL)`,
      [boss, respawn]
    );
    return reply(replyToken, `✅ 已設定 ${boss} 重生間隔為 ${respawn} 小時`);
  }

  // /死亡 王名 時間
  if (msg.startsWith("/死亡")) {
    const parts = msg.split(" ");
    if (parts.length !== 3) return reply(replyToken, "❌ 格式錯誤，範例：/死亡 紅龍 13:20");
    const [_, boss, timeStr] = parts;
    const bossData = await db.get("SELECT * FROM boss_status WHERE boss = ?", [boss]);
    if (!bossData) return reply(replyToken, `❌ 尚未設定 ${boss}，請先用 /設定`);

    const death = moment.tz(timeStr, "HH:mm", TZ);
    const nextSpawn = death.clone().add(bossData.respawn_hours, "hours");

    await db.run(
      `UPDATE boss_status SET death_time_iso=?, next_spawn_iso=? WHERE boss=?`,
      [death.toISOString(), nextSpawn.toISOString(), boss]
    );
    return reply(
      replyToken,
      `💀 ${boss} 死亡時間已紀錄：${death.format("HH:mm")}\n預計重生時間：${nextSpawn.format(
        "MM/DD HH:mm"
      )}`
    );
  }

  // /BOSS 查詢所有王
  if (msg === "/BOSS") {
    const rows = await db.all("SELECT * FROM boss_status");
    if (rows.length === 0) return reply(replyToken, "📭 尚未設定任何王");

    const now = moment().tz(TZ);
    const bosses = rows
      .map((r) => ({
        name: r.boss,
        nextSpawn: r.next_spawn_iso ? moment(r.next_spawn_iso).tz(TZ) : null,
        respawn: r.respawn_hours,
      }))
      .sort((a, b) => {
        if (!a.nextSpawn) return 1;
        if (!b.nextSpawn) return -1;
        return a.nextSpawn - b.nextSpawn;
      });

    const text =
      "📅 世界王狀態一覽：\n" +
      bosses
        .map((b) => {
          if (!b.nextSpawn) return `${b.name}：尚未登記死亡時間`;
          const diff = b.nextSpawn.diff(now, "minutes");
          const remain = diff <= 0 ? "✅ 已重生" : `⏳ ${Math.floor(diff / 60)}時${diff % 60}分`;
          return `${b.name}：${b.nextSpawn.format("MM/DD HH:mm")}（${remain}）`;
        })
        .join("\n");

    return reply(replyToken, text);
  }

  // 其他訊息
  return reply(replyToken, "❔ 請輸入 /幫助 來查看可用指令");
}

// ================== LINE 回覆簡化 ==================
function reply(token, text) {
  return client.replyMessage(token, { type: "text", text });
}

// ================== 自動清理過期資料（每天） ==================
cron.schedule("0 0 * * *", async () => {
  await db.run("DELETE FROM boss_status WHERE respawn_hours IS NULL");
  console.log("🧹 自動清理無效資料完成");
});

// ================== 啟動伺服器 ==================
app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
});
