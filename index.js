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
    console.log(`🕐 心跳 / 指令觸發: ${dayjs().tz(TW_ZONE).format("YYYY/MM/DD HH:mm:ss")}`);
  const text = event.message.text.trim();
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

  if (text === "/4轉材料") {
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

if (args[0] === "/4轉") {
  const raw = args[1];
  if (!raw) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 格式錯誤，請先輸入 /4轉材料 查看說明",
    });
    return;
  }

  const nums = raw.split(".").map(n => parseInt(n, 10) || 0);
  if (nums.length !== 15) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 數量不足，請確認是否輸入 15 個數字",
    });
    return;
  }

  let [
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

  // 計算剩餘要做的書本
  const need教皇 = Math.max(FINAL_BOOK.教皇認可 - have教皇, 0);
  const need盾 = Math.max(FINAL_BOOK.實習匠人的證明盾 - have盾, 0);
  const need推薦 = Math.max(FINAL_BOOK.傭兵隊長推薦書 - have推薦, 0);

  // 初始化總需求
  const need = {
    教皇認可: need教皇,
    實習匠人的證明盾: need盾,
    傭兵隊長推薦書: need推薦,
    詛咒精華: 0,
    優級轉職信物: 0,
    古代匠人的合金: 0,
    冰凍之淚: 0,
    轉職信物: 0,
    金屬殘片: 0,
    古代莎草紙: 0,
    墨水晶: FINAL_BOOK.墨水晶,
    金幣: FINAL_BOOK.金幣,
  };

  // 現有材料
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

  // ===== 計算剩餘製作次數 =====
  function remainTry(maxFail, currentFail) {
    return Math.max(maxFail + 1 - currentFail, 1);
  }

  // ===== 計算每個書本材料需求 =====
  function calcMaterial(bookName, needNum, failCount) {
    if (!CRAFT[bookName]) return {};
    const remainingTimes = remainTry(CRAFT[bookName].maxFail, failCount);
    const result = {};
    for (const mat in CRAFT[bookName].cost) {
      const perBook = CRAFT[bookName].cost[mat];
      // 總需求 = 剩餘書本數量 * 剩餘製作次數 * 每本消耗 - 已有材料
      const total = needNum * remainingTimes * perBook - (have[mat] || 0);
      result[mat] = Math.max(total, 0);
    }
    return result;
  }

  // ===== 計算各書的材料 =====
  const calc教皇 = calcMaterial("教皇認可", need教皇, fail教皇);
  const calc盾 = calcMaterial("實習匠人的證明盾", need盾, fail盾);
  const calc推薦 = calcMaterial("傭兵隊長推薦書", need推薦, fail推薦);

  // 累加到總需求（保持順序：教皇 → 盾 → 推薦）
  for (const mat in calc教皇) need[mat] = (need[mat] || 0) + calc教皇[mat];
  for (const mat in calc盾) need[mat] = (need[mat] || 0) + calc盾[mat];
  for (const mat in calc推薦) need[mat] = (need[mat] || 0) + calc推薦[mat];

  // ===== 產生顯示文字 =====
  const lines = [];
  const formatSet = new Set(["金幣", "墨水晶"]);

  for (const k in need) {
    const missing = Math.max(need[k], 0);
    const value = formatSet.has(k) ? missing.toLocaleString() : missing;
    lines.push(`${k}：${value}`);
  }

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `📘 四轉材料缺口（最慘情況）\n\n${lines.join("\n")}`,
  });
  return;
}



}
// ===== 啟動 =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  await loadBossData();
  console.log(`🚀 LINE Boss Reminder Bot 已啟動，Port: ${PORT}`);
});
