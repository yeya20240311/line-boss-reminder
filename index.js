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
const MARKET_RANGE = "Boss!J2:K";
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

// ===== 四轉材料計算設定 =====
const FINAL_BOOK = {
  教皇認可: 15,
  實習匠人的證明盾: 15,
  傭兵隊長推薦書: 40,
  墨水晶: 500,
  金幣: 50_000_000,
};

const CRAFT = {
  教皇認可: {
    maxFail: 5,
    cost: {
      詛咒精華: 5,
      優級轉職信物: 8,
      轉職信物: 10,
      墨水晶: 20,
      金幣: 1_000_000,
    },
  },
  實習匠人的證明盾: {
    maxFail: 10,
    cost: {
      古代匠人的合金: 5,
      冰凍之淚: 5,
      金屬殘片: 3,
      墨水晶: 30,
      金幣: 450_000,
    },
  },
  傭兵隊長推薦書: {
    maxFail: 15,
    cost: {
      古代莎草紙: 10,
      轉職信物: 20,
      金屬殘片: 3,
      墨水晶: 10,
      金幣: 200_000,
    },
  },
};

function remainTry(maxFail, currentFail) {
  return Math.max(maxFail + 1 - currentFail, 1);
}

// ===== Bot 資料 =====
let bossData = {};
let notifyAll = true;

// ===== 分類資料 =====
let categoryData = {};

// ===== 從 Google Sheets 載入資料 =====
async function loadBossData() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:G`, // ✅ 改成 A2:G
    });
    const rows = res.data.values || [];
    bossData = {};
    rows.forEach((r) => {
      const [name, interval, nextRespawn, notified, notifyDate, missedCount, category] = r;
      bossData[name] = {
        interval: parseFloat(interval) || 0,
        nextRespawn: nextRespawn || null,
        notified: notified === "TRUE",
        notifyDate: notifyDate || "ALL",
        missedCount: parseInt(missedCount) || 0,
        category: category || "", // ✅ 加入分類欄
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
      b.category || "", // ✅ 加入分類
    ]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:G`, // ✅ 改成 A2:G
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
app.post("/webhook", middleware(config), async (req, res) => {
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

  // 📌 新增這三行
  const text = event.message.text.trim();
  const normalized = text.replace(/　/g, " "); // 全形空白換半形
  const parts = normalized.split(" ");

  console.log(`🕐 心跳 / 指令觸發: ${dayjs().tz(TW_ZONE).format("YYYY/MM/DD HH:mm:ss")}`);
const args = text.split(/\s+/);


  
// /幫助
if (text === "/幫助") {
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `📖 指令說明：
━━━━━━━━━━━
🧩 基本功能：
/設定 王名 間隔(小時.分)
　→ 設定王的重生間隔
/重生 王名 剩餘時間(小時.分)
　→ 登記王的下次重生時間
/刪除 王名
　→ 刪除該王資料
/王
　→ 查看所有王的剩餘時間與預計重生時間
━━━━━━━━━━━
📅 通知相關：
/通知 類別(如 冰/奇) 參數(0/9/1.2...)
　→ 設定該分類的通知日期
　　0＝關閉通知
　　9＝每天通知
　　1.2.3＝星期一二三通知
/開啟通知
　→ 全域開啟前10分鐘提醒
/關閉通知
　→ 全域關閉前10分鐘提醒
━━━━━━━━━━━
🗂 分類管理：
/分類 類別 王名
　→ 將王加入指定分類
/分類刪除 類別 王名
　→ 從分類中移除王
━━━━━━━━━━━
ℹ️ 其他：
/資訊
　→ 查看所有王的設定與通知日
/我的ID
　→ 顯示目前的群組、聊天室或個人 ID`
  });
  return;
}

// ===== 🔹 新增交易所功能 🔹 =====
if (args[0] === "/交易所") {

  // 1️⃣ 只輸入 /交易所 → 顯示清單
  if (args.length === 1) {
    const rows = await getMarketRows();
    const list = rows
      .filter(r => r[0] && r[1] !== undefined)
      .map(r => `${r[0]}：${r[1]} 💎`)
      .join("\n");

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `📦 交易所最低價\n━━━━━━━━━━━\n${list || "尚無資料"}`,
    });
    return;
  }

  // 2️⃣ /交易所 新增 材料
  if (args[1] === "新增" && args.length >= 3) {
    const name = args.slice(2).join(" ");
    const msg = await updateMarket(name);
    await client.replyMessage(event.replyToken, { type: "text", text: msg });
    return;
  }

  // 3️⃣ /交易所 材料 價格
  if (args.length >= 3) {
    const price = parseFloat(args.at(-1));
    if (isNaN(price)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ 價格格式錯誤",
      });
      return;
    }

    const name = args.slice(1, -1).join(" ");
    const msg = await updateMarket(name, price);
    await client.replyMessage(event.replyToken, { type: "text", text: msg });
    return;
  }
}
// ===== 🔹 新增交易所功能結束 🔹 =====

  if (["/4轉材料", "/四轉材料"].includes(text)) {
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `📘 四轉材料計算說明
━━━━━━━━━━━
請依下列順序輸入（用 . 分隔）：

1 教皇認可
2 教皇認可 目前失敗次數
3 實習匠人的證明盾
4 實習匠人的證明盾 失敗次數
5 傭兵隊長推薦書
6 傭兵隊長推薦書 失敗次數
7 詛咒精華
8 優級轉職信物
9 古代匠人的合金
10 冰凍之淚
11 轉職信物
12 金屬殘片
13 古代莎草紙
14 墨水晶
15 金幣

範例：
/4轉 7.1.12.5.10.2.3.14.0.187.599.2634.4.55.2391180`
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

// ===== /分類 類別 王名 =====
if (args[0] === "/分類" && args.length === 3) {
  const [_, category, name] = args;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:G`,
  });
  const rows = res.data.values || [];
  const index = rows.findIndex(r => r[0] === name);

  if (index === -1) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `❌ 找不到名稱為「${name}」的王。`,
    });
    return;
  }

  // 更新 bossData 與試算表
  bossData[name].category = category;
  rows[index][6] = category; // 第 G 欄（index 6）

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:G`,
    valueInputOption: "RAW",
    resource: { values: rows },
  });

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已將「${name}」分類為「${category}」`,
  });
  return;
}

// ===== /分類刪除 王名 =====
if (args[0] === "/分類刪除" && args.length === 2) {
  const [_, name] = args;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:G`,
  });
  const rows = res.data.values || [];
  const index = rows.findIndex(r => r[0] === name);

  if (index === -1) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `❌ 找不到名稱為「${name}」的王。`,
    });
    return;
  }

  // 更新 bossData 與試算表
  bossData[name].category = "";
  rows[index][6] = ""; // 清空 G 欄

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:G`,
    valueInputOption: "RAW",
    resource: { values: rows },
  });

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已移除「${name}」的分類`,
  });
  return;
}


// /通知 類別 參數
if (args[0] === "/通知" && args.length === 3) {
  const [_, category, notifyStr] = args;

  // 🔍 從 bossData 找出該分類的所有王
  const targets = Object.keys(bossData).filter(name => bossData[name].category === category);

  if (targets.length === 0) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `❌ 找不到類別：${category}\n請先用 /分類 ${category} 王名 建立分類`,
    });
    return;
  }

  // 以下照原本邏輯不變 ...


  // 通知設定轉換
  let notifyDate = "ALL";
  if (notifyStr === "0") {
    notifyDate = "NONE";
  } else if (notifyStr === "9") {
    notifyDate = "ALL";
  } else {
    const dayMap = { "1": "MON", "2": "TUE", "3": "WED", "4": "THU", "5": "FRI", "6": "SAT", "7": "SUN" };
    const days = notifyStr.split(".").map(d => dayMap[d]).filter(Boolean);
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

  const weekdayNames = { MON:"一", TUE:"二", WED:"三", THU:"四", FRI:"五", SAT:"六", SUN:"日" };
  const readable = notifyDate === "ALL"
    ? "每天"
    : notifyDate === "NONE"
      ? "已關閉"
      : notifyDate.split(",").map(d => `星期${weekdayNames[d]}`).join("、");

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 已更新 ${category} 類通知\n📅 通知日：${readable}\n🧊 影響王：${updated.join("、")}`,
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

  
// /王 顯示並自動偵測是否過期 + 自動累加錯過計數
if (text === "/王") {
  const now = dayjs().tz(TW_ZONE);
  let updated = false;

  const list = Object.keys(bossData)
    .map((name) => {
      const b = bossData[name];
      if (!b.nextRespawn || !b.interval)
        return `❌ ${name} 尚未設定重生時間`;

      let resp = dayjs(b.nextRespawn).tz(TW_ZONE);
      let missedCount = b.missedCount || 0;

      while (now.isAfter(resp)) {
        resp = resp.add(b.interval, "hour");
        missedCount++;
        updated = true;
      }

      const diffMin = resp.diff(now, "minute");
      const h = Math.floor(diffMin / 60);
      const m = diffMin % 60;
      const respTime = resp.format("HH:mm");

      b.nextRespawn = resp.toISOString();
      b.missedCount = missedCount;
      b.notified = false;

      const icon = missedCount > 0 ? "⚠️" : "⚔️";
      const cycleText = missedCount > 0 ? `過${missedCount}` : "";

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

  // 🔄 若有更新，存回 Google Sheets
  if (updated) await saveBossDataToSheet();

  // 📩 回覆列表
  await client.replyMessage(event.replyToken, { type: "text", text: list || "尚無任何王的資料" });
  return;
}

// /開啟通知 /關閉通知
if (text === "/開啟通知" || text === "/關閉通知") {
  const newValue = text === "/開啟通知" ? "開啟通知" : "關閉通知";
  notifyAll = text === "/開啟通知";

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!H2`,
      valueInputOption: "RAW",
      resource: { values: [[newValue]] },
    });

    const replyText = notifyAll
      ? "✅ 已全域開啟前10分鐘通知"
      : "❌ 已全域關閉前10分鐘通知";

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: replyText,
    });

    console.log(`📌 已更新總通知開關為：${newValue}`);
  } catch (err) {
    console.error("❌ 更新總通知開關失敗", err);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 更新總通知開關失敗，請稍後再試",
    });
  }
  return;
}

// ===== 交易所功能 =====
async function getMarketRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: MARKET_RANGE,
  });
  return res.data.values || [];
}

async function updateMarket(name, price = null) {
  const rows = await getMarketRows();

  // 找材料是否存在
  const idx = rows.findIndex(r => r[0] === name);

  // 更新價格
  if (idx !== -1 && price !== null) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!K${idx + 2}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[price]] },
    });
    return `✅ 已更新 ${name} 價格為 ${price}`;
  }

  // 新增（插在金幣下面）
  if (idx === -1) {
    const goldIdx = rows.findIndex(r => r[0] === "金幣");
    const insertRow = goldIdx !== -1 ? goldIdx + 3 : rows.length + 2;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!J${insertRow}:K${insertRow}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[name, price ?? 0]] },
    });

    return `✅ 已新增交易所商品：${name}`;
  }

  return `⚠️ 操作失敗`;
}

  
if (parts[0] === "/4轉" || parts[0] === "/四轉") {
  const raw = parts[1];
  if (!raw) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 請輸入 /4轉 數字.數字.數字（共 15 個）",
    });
    return;
  }

  const nums = raw.split(".").map(n => parseInt(n, 10) || 0);
  if (nums.length !== 15) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 請確認已輸入 15 個數字",
    });
    return;
  }

  const [
    have教皇, fail教皇,
    have盾, fail盾,
    have推薦, fail推薦,
    have詛咒,
    have優級,
    have合金,
    have冰淚,
    have信物,
    have殘片,
    have莎草,
    have墨水,
    have金幣
  ] = nums;

  // ===== 最終需求 =====
  const FINAL_BOOK = {
    教皇認可: 15,
    實習匠人的證明盾: 15,
    傭兵隊長推薦書: 40,
    墨水晶: 500,
    金幣: 50_000_000,
  };

  // ===== 製作表（最慘第 N 次必成功）=====
  const CRAFT = {
    教皇認可: {
      worstTry: 6,
      cost: {
        詛咒精華: 5,
        優級轉職信物: 8,
        轉職信物: 10,
        墨水晶: 20,
        金幣: 1_000_000,
      },
    },
    實習匠人的證明盾: {
      worstTry: 11,
      cost: {
        古代匠人的合金: 5,
        冰凍之淚: 5,
        金屬殘片: 3,
        墨水晶: 30,
        金幣: 450_000,
      },
    },
    傭兵隊長推薦書: {
      worstTry: 16,
      cost: {
        古代莎草紙: 10,
        轉職信物: 20,
        金屬殘片: 3,
        墨水晶: 10,
        金幣: 200_000,
      },
    },
  };

  // ===== 尚需成功數 =====
  const needBook = {
    教皇認可: Math.max(FINAL_BOOK.教皇認可 - have教皇, 0),
    實習匠人的證明盾: Math.max(FINAL_BOOK.實習匠人的證明盾 - have盾, 0),
    傭兵隊長推薦書: Math.max(FINAL_BOOK.傭兵隊長推薦書 - have推薦, 0),
  };

  const worst = {};
  const best = {};
  const mats = [
    "詛咒精華","優級轉職信物","古代匠人的合金","冰凍之淚",
    "轉職信物","金屬殘片","古代莎草紙","墨水晶","金幣"
  ];
  mats.forEach(m => {
    worst[m] = 0;
    best[m] = 0;
  });

  // ===== 核心計算（最非 / 最歐）=====
  const failMap = {
    教皇認可: fail教皇,
    實習匠人的證明盾: fail盾,
    傭兵隊長推薦書: fail推薦,
  };

  for (const book in needBook) {
    const need = needBook[book];
    if (need <= 0) continue;

    const cfg = CRAFT[book];
    const failCount = failMap[book] || 0;

// 最非嘗試次數（失敗次數只影響一次）
const worstTryCount =
  need === 0
    ? 0
    : (need * cfg.worstTry) - failCount;

// 防呆：不可能為負
const safeWorstTry = Math.max(worstTryCount, 0);

for (const mat in cfg.cost) {
  const per = cfg.cost[mat];

  // 最歐：每顆一次成功
  best[mat] += per * need;

 // 最非：材料計算（只有詛咒精華有失敗退回）
if (mat === "詛咒精華") {
  const successCount = need; // 成功次數
  const failTimes = Math.max(safeWorstTry - successCount, 0); // 失敗次數

  // 成功：完整消耗
  // 失敗：退 1 顆 → 淨消耗 (per - 1)
  worst[mat] += (successCount * per) + (failTimes * (per - 1));
} else {
  // 其他材料：失敗不退，照原本算
  worst[mat] += per * safeWorstTry;
}

  }
}
  // ===== 四轉書本體固定成本 =====
  worst.墨水晶 += FINAL_BOOK.墨水晶;
  best.墨水晶 += FINAL_BOOK.墨水晶;
  worst.金幣 += FINAL_BOOK.金幣;
  best.金幣 += FINAL_BOOK.金幣;

  // ===== 扣掉現有材料 =====
  const have = {
    詛咒精華: have詛咒,
    優級轉職信物: have優級,
    古代匠人的合金: have合金,
    冰凍之淚: have冰淚,
    轉職信物: have信物,
    金屬殘片: have殘片,
    古代莎草紙: have莎草,
    墨水晶: have墨水,
    金幣: have金幣,
  };

  for (const k in have) {
    worst[k] = Math.max(worst[k] - have[k], 0);
    best[k] = Math.max(best[k] - have[k], 0);
  }

  const fmt = n => n.toLocaleString();

  const reply = `📘 四轉材料缺口

🟧 教皇認可：${fmt(needBook.教皇認可)}
🟪 實習匠人的證明盾：${fmt(needBook.實習匠人的證明盾)}
🟪 傭兵隊長推薦書：${fmt(needBook.傭兵隊長推薦書)}
--------------
【最非】 / 【最歐】
🟪 詛咒精華：${fmt(worst.詛咒精華)} / ${fmt(best.詛咒精華)}
🟪 優級轉職信物：${fmt(worst.優級轉職信物)} / ${fmt(best.優級轉職信物)}
🟪 古代匠人的合金：${fmt(worst.古代匠人的合金)} / ${fmt(best.古代匠人的合金)}
🟪 冰凍之淚：${fmt(worst.冰凍之淚)} / ${fmt(best.冰凍之淚)}
⬛ 轉職信物：${fmt(worst.轉職信物)} / ${fmt(best.轉職信物)}
⬛ 金屬殘片：${fmt(worst.金屬殘片)} / ${fmt(best.金屬殘片)}
🟦 古代莎草紙：${fmt(worst.古代莎草紙)} / ${fmt(best.古代莎草紙)}
🟨 墨水晶：${fmt(worst.墨水晶)} / ${fmt(best.墨水晶)}
🟨 金幣：${fmt(worst.金幣)} / ${fmt(best.金幣)}`;

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: reply,
  });
  return;
}

// ===== /4轉鑽 指令 =====
if (parts[0] === "/4轉鑽" || parts[0] === "/四轉鑽") {
  const raw = parts[1];
  if (!raw) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 請輸入 /4轉鑽 數字.數字.數字（共 15 個）",
    });
    return;
  }

  const nums = raw.split(".").map(n => parseInt(n, 10) || 0);
  if (nums.length !== 15) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 請確認已輸入 15 個數字",
    });
    return;
  }

  const [
    have教皇, fail教皇,
    have盾, fail盾,
    have推薦, fail推薦,
    have詛咒,
    have優級,
    have合金,
    have冰淚,
    have信物,
    have殘片,
    have莎草,
    have墨水,
    have金幣
  ] = nums;

  const FINAL_BOOK = {
    教皇認可: 15,
    實習匠人的證明盾: 15,
    傭兵隊長推薦書: 40,
    墨水晶: 500,
    金幣: 50_000_000,
  };

  const CRAFT = {
    教皇認可: { worstTry: 6, cost: { 詛咒精華: 5, 優級轉職信物: 8, 轉職信物: 10, 墨水晶: 20, 金幣: 1_000_000 } },
    實習匠人的證明盾: { worstTry: 11, cost: { 古代匠人的合金: 5, 冰凍之淚: 5, 金屬殘片: 3, 墨水晶: 30, 金幣: 450_000 } },
    傭兵隊長推薦書: { worstTry: 16, cost: { 古代莎草紙: 10, 轉職信物: 20, 金屬殘片: 3, 墨水晶: 10, 金幣: 200_000 } },
  };

  const needBook = {
    教皇認可: Math.max(FINAL_BOOK.教皇認可 - have教皇, 0),
    實習匠人的證明盾: Math.max(FINAL_BOOK.實習匠人的證明盾 - have盾, 0),
    傭兵隊長推薦書: Math.max(FINAL_BOOK.傭兵隊長推薦書 - have推薦, 0),
  };

  const mats = [
    "詛咒精華","優級轉職信物","古代匠人的合金","冰凍之淚",
    "轉職信物","金屬殘片","古代莎草紙","墨水晶","金幣"
  ];

  const worst = {};
  const best = {};
  mats.forEach(m => { worst[m] = 0; best[m] = 0; });

  const failMap = { 教皇認可: fail教皇, 實習匠人的證明盾: fail盾, 傭兵隊長推薦書: fail推薦 };

  for (const book in needBook) {
    const need = needBook[book];
    if (need <= 0) continue;
    const cfg = CRAFT[book];
    const failCount = failMap[book] || 0;

    const worstTryCount = (need * cfg.worstTry) - failCount;
    const safeWorstTry = Math.max(worstTryCount, 0);

    for (const mat in cfg.cost) {
      const per = cfg.cost[mat];
      best[mat] += per * need;
      if (mat === "詛咒精華") {
        const successCount = need;
        const failTimes = Math.max(safeWorstTry - successCount, 0);
        worst[mat] += (successCount * per) + (failTimes * (per - 1));
      } else {
        worst[mat] += per * safeWorstTry;
      }
    }
  }

  worst.墨水晶 += FINAL_BOOK.墨水晶;
  best.墨水晶 += FINAL_BOOK.墨水晶;
  worst.金幣 += FINAL_BOOK.金幣;
  best.金幣 += FINAL_BOOK.金幣;

  const have = {
    詛咒精華: have詛咒, 優級轉職信物: have優級, 古代匠人的合金: have合金,
    冰凍之淚: have冰淚, 轉職信物: have信物, 金屬殘片: have殘片,
    古代莎草紙: have莎草, 墨水晶: have墨水, 金幣: have金幣
  };
  for (const k in have) { worst[k] = Math.max(worst[k] - have[k], 0); best[k] = Math.max(best[k] - have[k], 0); }

  // ===== 轉 EXL 鑽石並四捨五入 =====
  async function diamond(mat, amount) {
    const price = await getExlPrice(mat);
    return Math.round((amount || 0) * price);
  }

  const dWorst = {};
  const dBest = {};
  for (const m of mats) {
    dWorst[m] = await diamond(m, worst[m]);
    dBest[m]  = await diamond(m, best[m]);
  }

  const totalWorst = mats.reduce((sum, m) => sum + dWorst[m], 0);
  const totalBest  = mats.reduce((sum, m) => sum + dBest[m], 0);

  const fmt = n => n.toLocaleString();

const reply = `💎 四轉材料所缺鑽石
--------------【最非】 / 【最歐】
🟪 詛咒精華：${Math.round(worst["詛咒精華"] * (await getExlPrice("詛咒精華")))} / ${Math.round(best["詛咒精華"] * (await getExlPrice("詛咒精華")))}
🟪 優級轉職信物：${Math.round(worst["優級轉職信物"] * (await getExlPrice("優級轉職信物")))} / ${Math.round(best["優級轉職信物"] * (await getExlPrice("優級轉職信物")))}
⬛ 轉職信物：${Math.round(worst["轉職信物"] * (await getExlPrice("轉職信物")))} / ${Math.round(best["轉職信物"] * (await getExlPrice("轉職信物")))}
🟦 古代莎草紙：${Math.round(worst["古代莎草紙"] * (await getExlPrice("古代莎草紙")))} / ${Math.round(best["古代莎草紙"] * (await getExlPrice("古代莎草紙")))}
🟨 墨水晶：${Math.round(worst["墨水晶"] * (await getExlPrice("墨水晶")))} / ${Math.round(best["墨水晶"] * (await getExlPrice("墨水晶")))}
🟨 金幣（換沙金袋）：${Math.round(
  Math.max(
    (
      (needBook.教皇認可 * CRAFT.教皇認可.cost.金幣 * 6) +
      (needBook.實習匠人的證明盾 * CRAFT.實習匠人的證明盾.cost.金幣 * 11) +
      (needBook.傭兵隊長推薦書 * CRAFT.傭兵隊長推薦書.cost.金幣 * 16) +
      FINAL_BOOK.金幣 -
      have金幣 -
      (fail教皇 * CRAFT.教皇認可.cost.金幣) -
      (fail盾 * CRAFT.實習匠人的證明盾.cost.金幣) -
      (fail推薦 * CRAFT.傭兵隊長推薦書.cost.金幣)
    ) / 70000 * (await getExlPrice("金幣")),
    0
  )
)} / ${Math.round(
  Math.max(
    (
      (needBook.教皇認可 * CRAFT.教皇認可.cost.金幣) +
      (needBook.實習匠人的證明盾 * CRAFT.實習匠人的證明盾.cost.金幣) +
      (needBook.傭兵隊長推薦書 * CRAFT.傭兵隊長推薦書.cost.金幣) +
      FINAL_BOOK.金幣 -
      have金幣
    ) / 70000 * (await getExlPrice("金幣")),
    0
  )
)}
--------------
💎 總鑽石：${Math.round(worstExl)} / ${Math.round(bestExl)}`;

  await client.replyMessage(event.replyToken, { type: "text", text: reply });
  return;
}

// ===== 取得 EXL 價格函數 =====
async function getExlPrice(item) {
  const rows = await getMarketRows(); // Boss!J2:K
  const row = rows.find(r => r[0] === item);
  return row && !isNaN(parseFloat(row[1])) ? parseFloat(row[1]) : 0;
}



}
// ===== 啟動 =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  await loadBossData();
  console.log(`🚀 LINE Boss Reminder Bot 已啟動，Port: ${PORT}`);
});
