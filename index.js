import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import cron from "node-cron";
import { google } from "googleapis";

dotenv.config();
dayjs.extend(utc);
dayjs.extend(timezone);

const TW_ZONE = process.env.TIMEZONE || "Asia/Taipei";
// ===== PID 檢查 =====
console.log("🚀 LINE Boss Bot 啟動中，Process PID:", process.pid);


// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// ===== Google Sheets 設定 =====
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

if (!SHEET_ID || !GOOGLE_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("請設定 GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY 等環境變數");
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });
const SHEET_NAME = "Boss";

// ===== Bot 資料 =====
let bossData = {};
let notifyAll = true;

// ===== 從 Google Sheets 載入資料 =====
async function loadBossData() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:F`,
    });
    const rows = res.data.values || [];
    bossData = {};
    rows.forEach((r) => {
      const [name, interval, nextRespawn, notified, notifyDate, missedCount] = r;
      bossData[name] = {
        interval: parseFloat(interval) || 0,
        nextRespawn: nextRespawn || null,
        notified: notified === "TRUE",
        notifyDate: notifyDate || "ALL",
        missedCount: parseInt(missedCount) || 0,
      };
    });
    console.log(`✅ 已從 Google Sheets 載入資料 (${rows.length} 筆)`);
  } catch (err) {
    console.error("❌ 無法連接 Google Sheets", err);
  }
}

// ===== 將資料寫回 Google Sheets =====
async function saveBossDataToSheet() {
  try {
    const rows = Object.entries(bossData).map(([name, b]) => [
      name,
      b.interval,
      b.nextRespawn || "",
      b.notified ? "TRUE" : "FALSE",
      b.notifyDate || "ALL",
      b.missedCount || 0,
    ]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:F`,
      valueInputOption: "RAW",
      resource: { values: rows },
    });
    console.log("✅ 已更新 Google Sheet");
  } catch (err) {
    console.error("❌ 更新 Google Sheet 失敗", err);
  }
}

// ===== Express =====
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })); // 保存 raw body 給 middleware
app.post("/webhook", express.raw({ type: "application/json" }), middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.send("LINE Boss Reminder Bot is running."));

// ===== 指令處理 =====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const args = text.split(/\s+/);

// /幫助
if (text === "/幫助") {
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `📌 可用指令：
/設定 王名 間隔(小時.分)  → 設定王的重生間隔
/重生 王名 剩餘時間(小時.分)  → 設定王的下次重生時間
/刪除 王名  → 刪除王資料
/通知 類別(冰/奇) 參數(0/9/1.2...)  → 設定通知日期
/資訊  → 查看所有王的間隔與通知設定
/王  → 查看所有王的剩餘時間與重生時間
/開啟通知  → 開啟所有前10分鐘提醒
/關閉通知  → 關閉所有前10分鐘提醒
/我的ID  → 顯示群組/聊天室/個人 ID`
  });
  return;
}

  // /我的ID
if (text === "/我的ID") {
  let idText = "";

  if (event.source.type === "group") {
    const groupId = event.source.groupId;
    idText = `這是群組 ID：${groupId}`;
  } else if (event.source.type === "room") {
    const roomId = event.source.roomId;
    idText = `這是多人聊天 ID：${roomId}`;
  } else {
    const userId = event.source.userId || "無法取得";
    idText = `這是你的個人 ID：${userId}`;
  }

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: idText,
  });
  return;
}
  // /設定 王名 間隔
  if (args[0] === "/設定" && args.length === 3) {
    const [_, name, intervalStr] = args;
    const raw = parseFloat(intervalStr);
    const h = Math.floor(raw);
    const m = Math.round((raw - h) * 100);
    bossData[name] = bossData[name] || {};
    bossData[name].interval = h + m / 60;
    bossData[name].nextRespawn = bossData[name].nextRespawn || null;
    bossData[name].notified = bossData[name].notified || false;
    bossData[name].notifyDate = bossData[name].notifyDate || "ALL";
    bossData[name].missedCount = bossData[name].missedCount || 0;
    await saveBossDataToSheet();
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已設定 ${name} 重生間隔 ${h}小時${m}分`,
    });
    return;
  }

  // /重生 王名 剩餘時間
  if (args[0] === "/重生" && args.length === 3) {
    const [_, name, remainStr] = args;
    if (!bossData[name] || !bossData[name].interval) {
      await client.replyMessage(event.replyToken, { type: "text", text: `請先用 /設定 ${name} 間隔(小時.分)` });
      return;
    }
    const raw = parseFloat(remainStr);
    const h = Math.floor(raw);
    const m = Math.round((raw - h) * 100);
    bossData[name].nextRespawn = dayjs().tz(TW_ZONE).add(h, "hour").add(m, "minute").toISOString();
    bossData[name].notified = false;
    bossData[name].missedCount = 0;
    await saveBossDataToSheet();
    const respTime = dayjs(bossData[name].nextRespawn).tz(TW_ZONE).format("HH:mm");
    await client.replyMessage(event.replyToken, { type: "text", text: `🕒 已設定 ${name} 將於 ${respTime} 重生` });
    return;
  }

  // /刪除 王名
  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    if (bossData[name]) {
      delete bossData[name];
      await saveBossDataToSheet();
      await client.replyMessage(event.replyToken, { type: "text", text: `🗑 已刪除 ${name}` });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: `${name} 不存在` });
    }
    return;
  }

// /通知 類別 參數
if (args[0] === "/通知" && args.length === 3) {
  const [_, category, notifyStr] = args;

  // 定義分類
  const ICE_BOSSES = ["冰1", "冰2北", "冰2南"];
  const OTHERS = [
    "激3", "奇3北", "奇1北", "激2", "奇3南",
    "奇2西", "奇2東", "奇1南"
  ];

  let targets = [];
  if (category === "冰") {
    targets = ICE_BOSSES;
  } else if (category === "奇") {
    targets = OTHERS;
  } else {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `❌ 未知的分類：${category}\n可用類別：冰、奇`
    });
    return;
  }

  // 通知設定轉換
  let notifyDate = "ALL";
  if (notifyStr === "0") {
    notifyDate = "NONE";
  } else if (notifyStr === "9") {
    notifyDate = "ALL";
  } else {
    const dayMap = {
      "1": "MON",
      "2": "TUE",
      "3": "WED",
      "4": "THU",
      "5": "FRI",
      "6": "SAT",
      "7": "SUN",
    };
    const days = notifyStr
      .split(".")
      .map(d => dayMap[d])
      .filter(Boolean);
    notifyDate = days.length > 0 ? days.join(",") : "ALL";
  }

  // 套用到各王
  let updated = [];
  for (const name of targets) {
    if (!bossData[name]) continue;
    bossData[name].notifyDate = notifyDate;
    updated.push(name);
  }

  await saveBossDataToSheet();

  const weekdayNames = {
    MON: "一", TUE: "二", WED: "三",
    THU: "四", FRI: "五", SAT: "六", SUN: "日"
  };
  let readable = notifyDate === "ALL"
    ? "每天"
    : notifyDate === "NONE"
      ? "已關閉"
      : notifyDate.split(",").map(d => `星期${weekdayNames[d]}`).join("、");

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已更新 ${category} 類通知\n📅 通知日：${readable}\n🧊 影響王：${updated.join("、")}`
  });
  return;
}

// /資訊 顯示
if (text === "/資訊") {
  const list = Object.keys(bossData)
    .map(name => {
      const b = bossData[name];
      const interval = b.interval ? `${Math.floor(b.interval)}小時${Math.round((b.interval % 1) * 60)}分` : "未設定";
      let notify = "每天";
      if (b.notifyDate === "NONE") notify = "已關閉";
      else if (b.notifyDate !== "ALL") {
        const map = { MON:"一",TUE:"二",WED:"三",THU:"四",FRI:"五",SAT:"六",SUN:"日" };
        notify = b.notifyDate.split(",").map(d => `星期${map[d]}`).join("、");
      }
      return `🔹 ${name}\n　間隔：${interval}\n　通知：${notify}`;
    })
    .join("\n\n");

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: list || "目前尚無任何王的資訊"
  });
  return;
}

  
if (text === "/王") {
  const now = dayjs().tz(TW_ZONE);

  const list = Object.keys(bossData)
    .map(name => {
      const b = bossData[name];
      if (!b.nextRespawn || !b.interval) return `❌ ${name} 尚未設定重生時間`;

      let resp = dayjs(b.nextRespawn).tz(TW_ZONE);
      let diffMin = resp.diff(now, "minute");

      const h = Math.floor(diffMin / 60);
      const m = diffMin % 60;
      const respTime = resp.format("HH:mm");

      // 根據 missedCount 決定圖示和文字
      const icon = (b.missedCount || 0) > 0 ? "⚠️" : "⚔️";
      const cycleText = (b.missedCount || 0) > 0 ? `過${b.missedCount}` : "";

      return `${icon} ${name} 剩餘 ${h}小時${m}分（預計 ${respTime}）${cycleText ? " " + cycleText : ""}`;
    })
    .sort((a, b) => {
      const aMatch = a.match(/剩餘 (\d+)小時(\d+)分/);
      const bMatch = b.match(/剩餘 (\d+)小時(\d+)分/);
      const aMin = aMatch ? parseInt(aMatch[1]) * 60 + parseInt(aMatch[2]) : 9999;
      const bMin = bMatch ? parseInt(bMatch[1]) * 60 + parseInt(bMatch[2]) : 9999;
      return aMin - bMin;
    })
    .join("\n");

  await client.replyMessage(event.replyToken, { type: "text", text: list || "尚無任何王的資料" });
  return;
}




  // /開啟通知
  if (text === "/開啟通知") { notifyAll = true; await client.replyMessage(event.replyToken,{ type:"text", text:"✅ 已開啟所有前10分鐘通知"}); return; }

  // /關閉通知
  if (text === "/關閉通知") { notifyAll = false; await client.replyMessage(event.replyToken,{ type:"text", text:"❌ 已關閉所有前10分鐘通知"}); return; }
}

// ===== PID 檢查 =====
console.log("🕐 定時器啟動於 PID:", process.pid);

// ===== 每 10 分鐘檢查通知並自動累加 missedCount =====
let lastSentTime = 0; // UNIX timestamp（毫秒）

cron.schedule("*/10 * * * *", async () => {
  const now = dayjs().tz(TW_ZONE);
  const targetId = process.env.GROUP_ID;
  if (!targetId) return;

  // 防止短時間重複發送
  if (Date.now() - lastSentTime < 60 * 1000) {
    console.log("⏳ 距離上次發送不足 1 分鐘，跳過本次通知");
    return;
  }

  let updated = false;  // 是否需要寫回 Google Sheets
  let notifyList = [];  // 本次要通知的王

  for (const [name, b] of Object.entries(bossData)) {
    if (!b.nextRespawn || !b.interval) continue;

    const resp = dayjs(b.nextRespawn).tz(TW_ZONE);
    const diffMin = resp.diff(now, "minute");
    const intervalMin = b.interval * 60;

    // ===== 自動累加 missedCount（王時間到期就 +1） =====
    if (diffMin <= 0) {
      const cyclesPassed = Math.floor(Math.abs(diffMin) / intervalMin) + 1; // 超過幾輪
      b.nextRespawn = resp.add(cyclesPassed * b.interval, "hour").toISOString();
      b.missedCount = (b.missedCount || 0) + cyclesPassed;
      b.notified = false;
      updated = true;
      console.log(`⚠️ ${name} 已過 ${cyclesPassed} 輪，missedCount += ${cyclesPassed}`);
    }

    // ===== 前 10 分鐘通知 =====
    if (diffMin > 0 && diffMin <= 10 && !b.notified && notifyAll) {
      const today = now.format("ddd").toUpperCase(); // e.g., "MON"
      const notifyDays = b.notifyDate.split(",");
      if (b.notifyDate === "ALL" || notifyDays.includes(today)) {
        notifyList.push({ name, diff: diffMin });
      }
    }
  }

  // 發送通知
  if (notifyList.length > 0) {
    const messageText = notifyList
      .map(b => `⏰ ${b.name} 即將在 ${b.diff} 分鐘後重生`)
      .join("\n");

    const maxRetries = 3;
    let sent = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await client.pushMessage(targetId, { type: "text", text: messageText });
        console.log("✅ 通知發送成功");
        sent = true;
        lastSentTime = Date.now(); // 更新最後發送時間
        break;
      } catch (err) {
        console.error(`⚠️ 通知發送失敗 (第 ${attempt} 次):`, err.statusCode, err.statusMessage);
        if (attempt < maxRetries) await new Promise(res => setTimeout(res, 3000));
      }
    }

    // 標記已通知
    if (sent) {
      notifyList.forEach(b => {
        if (bossData[b.name]) bossData[b.name].notified = true;
      });
      updated = true;
    }
  }

  // 如果有更新，寫回 Google Sheets
  if (updated) await saveBossDataToSheet();
  
  // 💓 心跳訊息，只印出時間
  console.log("🕐 定時器仍在運作中", now.format("YYYY/MM/DD HH:mm:ss"));
});


// ===== 啟動 =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  await loadBossData();
  console.log(`🚀 LINE Boss Reminder Bot 已啟動，Port: ${PORT}`);
});
