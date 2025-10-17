import express from "express";
import line from "@line/bot-sdk";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import axios from "axios";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const USER_ID = process.env.USER_ID; // 你的LINE個人或群組ID
const GIST_ID = "d0100c2c88b974497380b1958de596b3"; // 你的Gist ID
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!config.channelAccessToken || !config.channelSecret || !USER_ID || !GITHUB_TOKEN) {
  console.error("請先設定環境變數 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN、USER_ID、GITHUB_TOKEN");
  process.exit(1);
}

const client = new line.Client(config);
const app = express();

// --- SQLite 初始化（暫存用）
let db;
(async () => {
  db = await open({
    filename: "./bot.db",
    driver: sqlite3.Database,
  });
  await db.exec(`CREATE TABLE IF NOT EXISTS bosses (
    name TEXT PRIMARY KEY,
    respawn_hours REAL,
    respawn_time INTEGER
  )`);
  console.log("✅ SQLite 已連線並確保表格存在");

  // 啟動時讀取 Gist 備份資料
  await loadFromGist();
})();

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        await handleCommand(event);
      }
    }
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

async function handleCommand(event) {
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // === 指令區 ===
  if (text === "/幫助") {
    const msg = `
📘 指令列表：
/幫助 — 顯示說明
/設定 王名 間隔(小時) — 設定重生間隔
/重生 王名 剩餘時間（例如 3.06 表示3小時6分後重生）
/刪除 王名 — 刪除王資料
/BOSS — 顯示所有王的狀態（剩餘時間）
/我的ID — 顯示你的使用者或群組ID
`;
    return reply(replyToken, msg);
  }

  // 取得 LINE 使用者或群組 ID
  if (text === "/我的ID") {
    return reply(replyToken, `你的ID是：${event.source.groupId || event.source.userId}`);
  }

  // === 設定重生間隔 ===
  if (text.startsWith("/設定")) {
    const [, name, hours] = text.split(" ");
    if (!name || !hours) return reply(replyToken, "❌ 格式錯誤，請輸入：/設定 王名 間隔(小時)");
    await db.run(
      "INSERT OR REPLACE INTO bosses (name, respawn_hours, respawn_time) VALUES (?, ?, ?)",
      [name, parseFloat(hours), 0]
    );
    await saveToGist();
    return reply(replyToken, `✅ 已設定 ${name} 的重生間隔為 ${hours} 小時`);
  }

  // === 登記剩餘時間（重生倒數）===
  if (text.startsWith("/重生")) {
    const [, name, remainStr] = text.split(" ");
    if (!name || !remainStr) return reply(replyToken, "❌ 格式錯誤，請輸入：/重生 王名 剩餘時間（例如 3.06）");

    const [h, m] = remainStr.split(".").map((x) => parseInt(x) || 0);
    const totalMs = (h * 60 + m) * 60 * 1000;
    const respawnTime = Date.now() + totalMs;
    await db.run(
      "INSERT OR REPLACE INTO bosses (name, respawn_hours, respawn_time) VALUES (?, COALESCE((SELECT respawn_hours FROM bosses WHERE name=?), 0), ?)",
      [name, name, respawnTime]
    );
    await saveToGist();
    return reply(replyToken, `🕒 已登記 ${name} 將於 ${formatTime(respawnTime)} 重生`);
  }

  // === 刪除王 ===
  if (text.startsWith("/刪除")) {
    const [, name] = text.split(" ");
    if (!name) return reply(replyToken, "❌ 格式錯誤，請輸入：/刪除 王名");
    await db.run("DELETE FROM bosses WHERE name = ?", [name]);
    await saveToGist();
    return reply(replyToken, `🗑 已刪除 ${name}`);
  }

  // === 查詢王狀態 ===
  if (text === "/BOSS") {
    const bosses = await db.all("SELECT * FROM bosses ORDER BY respawn_time ASC");
    if (!bosses.length) return reply(replyToken, "目前沒有登記任何王。");

    const now = Date.now();
    const list = bosses.map((b) => {
      const remainMs = b.respawn_time - now;
      if (remainMs <= 0) return `✅ ${b.name} 已重生！`;
      const remain = msToTime(remainMs);
      return `🕓 ${b.name} 剩餘 ${remain}`;
    });

    return reply(replyToken, list.join("\n"));
  }
}

// === 推播提醒 ===
cron.schedule("*/1 * * * *", async () => {
  const bosses = await db.all("SELECT * FROM bosses WHERE respawn_time > 0");
  const now = Date.now();

  for (const b of bosses) {
    const diffMin = Math.floor((b.respawn_time - now) / 60000);
    if (diffMin === 10) {
      await client.pushMessage(USER_ID, {
        type: "text",
        text: `@ALL ⚔️ ${b.name} 即將在 10 分鐘後重生！（預定 ${formatTime(b.respawn_time)}）`,
      });
    }
  }
});

// === Gist 同步函式 ===
async function saveToGist() {
  const bosses = await db.all("SELECT * FROM bosses");
  const data = JSON.stringify(bosses, null, 2);
  await axios.patch(
    `https://api.github.com/gists/${GIST_ID}`,
    { files: { "boss_data.json": { content: data } } },
    { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
  );
  console.log("💾 已儲存至 Gist");
}

async function loadFromGist() {
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
    });
    const content = JSON.parse(res.data.files["boss_data.json"].content);
    if (Array.isArray(content)) {
      for (const b of content) {
        await db.run(
          "INSERT OR REPLACE INTO bosses (name, respawn_hours, respawn_time) VALUES (?, ?, ?)",
          [b.name, b.respawn_hours, b.respawn_time]
        );
      }
      console.log("☁️ 已從 Gist 匯入資料");
    }
  } catch (err) {
    console.warn("⚠️ Gist 匯入失敗或空白", err.message);
  }
}

// === 工具 ===
function reply(token, text) {
  return client.replyMessage(token, { type: "text", text });
}
function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}
function msToTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}小時${m}分`;
}

// === 啟動伺服器 ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LINE Boss Bot running on port ${PORT}`));
