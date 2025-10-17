import express from "express";
import line from "@line/bot-sdk";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const TIMEZONE_OFFSET = 8 * 60 * 60 * 1000; // 台灣時區

// === LINE 設定 ===
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret || !process.env.USER_ID) {
  console.error("❌ 請先設定環境變數 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN 與 USER_ID");
  process.exit(1);
}

const client = new line.Client(config);

// === SQLite 初始化 ===
const db = new sqlite3.Database("./boss.db", (err) => {
  if (err) console.error("❌ 資料庫連線錯誤：", err);
  else console.log("✅ SQLite 已連線並確保表格存在");
});
db.run(`CREATE TABLE IF NOT EXISTS bosses (
  name TEXT PRIMARY KEY,
  respawn_time INTEGER,
  notified INTEGER DEFAULT 0
)`);

// === 時間格式 ===
function formatTime(ts) {
  const d = new Date(ts + TIMEZONE_OFFSET);
  const month = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  const hours = d.getUTCHours().toString().padStart(2, "0");
  const minutes = d.getUTCMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

function formatRemaining(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}小時${minutes}分`;
}

// === Webhook ===
// ⚠️ 千萬不要用 express.json()，要用 line.middleware()
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

app.get("/", (req, res) => res.send("LINE Boss Bot 正常運作中 🚀"));

// === 指令處理 ===
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const msg = event.message.text.trim();

  // 幫助
  if (msg === "/幫助") {
    return reply(event, `🧾 指令列表：
/幫助：顯示說明
/設定 王名 間隔(小時)：設定重生間隔
/重生 王名 剩餘時間(小時.分鐘)：紀錄重生倒數
/刪除 王名：刪除王資料
/BOSS：查詢所有王的狀態`);
  }

  // 顯示所有王
  if (msg === "/BOSS") {
    db.all("SELECT * FROM bosses ORDER BY respawn_time ASC", (err, rows) => {
      if (err || rows.length === 0) return reply(event, "目前沒有登記任何王。");
      const now = Date.now();
      const list = rows.map((r) => {
        const remain = r.respawn_time - now;
        if (remain <= 0) return `⚔️ ${r.name} 已重生！`;
        return `🕓 ${r.name} 剩餘 ${formatRemaining(remain)}`;
      });
      reply(event, list.join("\n"));
    });
    return;
  }

  // 設定固定間隔
  if (msg.startsWith("/設定 ")) {
    const parts = msg.split(" ");
    if (parts.length !== 3) return reply(event, "格式錯誤，用法：/設定 王名 間隔(小時)");
    const [_, name, hours] = parts;
    const interval = parseFloat(hours);
    if (isNaN(interval)) return reply(event, "請輸入正確數字小時。");
    const respawn = Date.now() + interval * 60 * 60 * 1000;
    db.run("REPLACE INTO bosses(name, respawn_time, notified) VALUES(?, ?, 0)", [name, respawn]);
    reply(event, `✅ 已設定 ${name} 重生間隔 ${interval} 小時（預計 ${formatTime(respawn)} 重生）`);
    return;
  }

  // 重生剩餘時間
  if (msg.startsWith("/重生 ")) {
    const parts = msg.split(" ");
    if (parts.length !== 3) return reply(event, "格式錯誤，用法：/重生 王名 剩餘時間(小時.分鐘)");
    const [_, name, timeStr] = parts;
    const [h, m] = timeStr.split(".").map((x) => parseInt(x, 10));
    const respawn = Date.now() + (h * 60 + (m || 0)) * 60 * 1000;
    db.run("REPLACE INTO bosses(name, respawn_time, notified) VALUES(?, ?, 0)", [name, respawn]);
    reply(event, `🕒 已登記 ${name} 將於 ${formatTime(respawn)} 重生`);
    return;
  }

  // 刪除
  if (msg.startsWith("/刪除 ")) {
    const name = msg.replace("/刪除 ", "").trim();
    db.run("DELETE FROM bosses WHERE name = ?", [name], function (err) {
      if (err || this.changes === 0) return reply(event, `❌ 沒有找到 ${name}`);
      reply(event, `🗑️ 已刪除 ${name}`);
    });
    return;
  }

  // 查ID
  if (msg === "/我的ID") {
    const id =
      event.source.type === "user"
        ? event.source.userId
        : event.source.type === "group"
        ? event.source.groupId
        : event.source.roomId;
    return reply(event, `🆔 你的 ID：${id}`);
  }
}

// === 回覆訊息 ===
function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: "text", text });
}

// === 10 分鐘前推播提醒 ===
setInterval(() => {
  const now = Date.now();
  db.all("SELECT * FROM bosses", async (err, rows) => {
    if (err || !rows) return;
    for (const r of rows) {
      const diff = r.respawn_time - now;
      if (diff > 0 && diff <= 10 * 60 * 1000 && !r.notified) {
        const msg = `@ALL ⚔️ ${r.name} 即將在 10 分鐘後重生！（預定 ${formatTime(r.respawn_time)}）`;
        await client.pushMessage(process.env.USER_ID, { type: "text", text: msg });
        db.run("UPDATE bosses SET notified = 1 WHERE name = ?", [r.name]);
      } else if (diff <= 0) {
        db.run("UPDATE bosses SET notified = 0 WHERE name = ?", [r.name]);
      }
    }
  });
}, 60 * 1000);

// === 啟動伺服器 ===
app.listen(PORT, () => console.log(`🚀 LINE Boss Bot running on port ${PORT}`));
