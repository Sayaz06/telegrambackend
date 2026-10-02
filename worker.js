/**
 * MyGram Worker — Backend untuk MyGram App
 * Project: stress-auti-action (Firebase sama, collection berbeza)
 *
 * Collection prefix: mygram_ (bukan tg_worker)
 * Firestore paths:
 *   users/{UID}/mygram_session/creds       → { apiId, apiHash, phone }
 *   users/{UID}/mygram_session/main        → { session }
 *   users/{UID}/mygram_worker/status       → status worker
 *   users/{UID}/mygram_worker/dialogs      → senarai chat
 *   users/{UID}/mygram_worker/login        → login handshake
 *   users/{UID}/mygram_worker/typing       → typing live
 *   users/{UID}/mygram_worker/cmd          → arahan dari frontend
 *   users/{UID}/mygram_messages/{chatId}/msgs/{msgId} → mesej
 *   users/{UID}/mygram_outbox/{docId}      → outbox teks
 *   users/{UID}/mygram_media_outbox/{docId} → outbox media
 */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { ConnectionTCPFull } = require("telegram/network/connection/TCPFull");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Tetapan ────────────────────────────────────────────────────
const TYPING_MS = 3000;
const TYPING_LIVE_STALE_MS = 12000;
const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Config ──────────────────────────────────────────────────────
const SERVICE_ACCOUNT = process.env.SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.SERVICE_ACCOUNT_JSON)
  : require("./serviceAccount.json");
const UID = "jcATY6Xc0GdvgA1kGbNLEvoygDy1";
const DB_PREFIX = `users/${UID}/mygram_worker`;

// ── Firebase Admin ───────────────────────────────────────────────
admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) });
const db = admin.firestore();

// ── State ────────────────────────────────────────────────────────
let tgClient = null;
let allDialogs = [];
let outboxUnsubscribe = null;
let mediaOutboxUnsubscribe = null;

// ── Log helper ───────────────────────────────────────────────────
function log(msg, type = "info") {
  const now = new Date().toLocaleTimeString("ms-MY");
  const prefix = type === "err" ? "❌" : type === "ok" ? "✅" : "ℹ️";
  console.log(`[${now}] ${prefix} ${msg}`);
}

// ── Baca creds dari Firestore ────────────────────────────────────
async function loadCreds() {
  const snap = await db.doc(`users/${UID}/mygram_session/creds`).get();
  if (!snap.exists) throw new Error("Creds tidak jumpa. Sila setup dalam MyGram dulu.");
  return snap.data(); // { apiId, apiHash, phone }
}

// ── Session ──────────────────────────────────────────────────────
async function loadSession() {
  const snap = await db.doc(`users/${UID}/mygram_session/main`).get();
  return snap.exists ? (snap.data().session || "") : "";
}

async function saveSession(str) {
  await db.doc(`users/${UID}/mygram_session/main`).set({
    session: str,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Status worker ─────────────────────────────────────────────────
async function setStatus(state, extra = {}) {
  await db.doc(`${DB_PREFIX}/status`).set({
    state,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  });
}

// ── Sync dialogs ke Firestore ─────────────────────────────────────
async function syncDialogs() {
  try {
    allDialogs = await tgClient.getDialogs({ limit: 100 });
    const list = allDialogs.filter((d) => d.entity).map((d) => {
      const e = d.entity;
      const cid = e.id ? e.id.toString() : "";
      const name = e.firstName
        ? (e.firstName + (e.lastName ? " " + e.lastName : ""))
        : e.title || "Unknown";
      const isGrp = !!(e.megagroup || e.broadcast || e.gigagroup);
      const isChannel = !!e.broadcast;
      const lastMsg = d.message && d.message.message ? d.message.message : "";
      const unread = d.unreadCount || 0;
      const lastMsgAt = d.message && d.message.date
        ? new Date(d.message.date * 1000).toISOString() : null;
      const lastMsgIsOut = d.message ? !!d.message.out : false;
      const hasMedia = d.message ? !!d.message.media : false;
      return { cid, name, isGrp, isChannel, lastMsg, unread, lastMsgAt, lastMsgIsOut, hasMedia };
    });

    await db.doc(`${DB_PREFIX}/dialogs`).set({
      list,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    log(`Synced ${list.length} dialogs`, "ok");
  } catch (e) {
    log("Gagal sync dialogs: " + e.message, "err");
  }
}

// ── Dapatkan info mesej dibalas ───────────────────────────────────
async function dapatkanInfoBalasan(msg, chatId, chatName, peta) {
  const rid = msg.replyTo && msg.replyTo.replyToMsgId;
  if (!rid) return null;
  let r = peta ? peta.get(rid) : null;
  if (!r) {
    try {
      const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === chatId);
      if (dlg) {
        const arr = await tgClient.getMessages(dlg.entity, { ids: [rid] });
        r = arr && arr[0];
      }
    } catch (e) {
      log(`Gagal ambil mesej dibalas: ${e.message}`, "err");
    }
  }
  if (!r) return { id: String(rid), text: "", name: "" };
  let name = "Anda";
  if (!r.out) {
    name = chatName;
    try {
      const s = await r.getSender();
      if (s) name = s.firstName ? s.firstName + (s.lastName ? " " + s.lastName : "") : (s.title || chatName);
    } catch (e) {}
  }
  const text = r.message ? r.message.slice(0, 150) : (r.media ? "[Media]" : "");
  return { id: String(rid), text, name };
}

// ── Simpan mesej ke Firestore ─────────────────────────────────────
async function saveMessage(msg, chatId, chatName, peta) {
  if (!msg || (!msg.message && !msg.media)) return;
  try {
    const msgId = msg.id ? msg.id.toString() : Date.now().toString();
    const text = msg.message || "";
    const isOut = !!msg.out;
    const date = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
    const hasMedia = !!msg.media;
    const replyTo = await dapatkanInfoBalasan(msg, chatId, chatName, peta);

    // Tentukan jenis media
    let mediaType = null;
    let mediaThumb = null;
    if (msg.media) {
      if (msg.media.photo) mediaType = "photo";
      else if (msg.media.document) {
        const doc = msg.media.document;
        const mime = doc.mimeType || "";
        if (mime.startsWith("video/")) mediaType = "video";
        else if (mime.startsWith("audio/")) mediaType = "audio";
        else if (mime === "application/x-tgsticker") mediaType = "sticker";
        else mediaType = "document";
      }
      else if (msg.media.geo) mediaType = "location";
      else if (msg.media.poll) mediaType = "poll";
      else mediaType = "other";
    }

    // Reactions (kalau ada)
    let reactions = [];
    if (msg.reactions && msg.reactions.results) {
      reactions = msg.reactions.results.map(r => ({
        emoji: r.reaction && r.reaction.emoticon ? r.reaction.emoticon : "?",
        count: r.count || 0,
        chosen: !!r.chosenOrder,
      }));
    }

    // Sender name (untuk group)
    let senderName = isOut ? "Anda" : chatName;
    let senderId = null;
    try {
      if (!isOut && msg.fromId) {
        senderId = msg.fromId.userId ? msg.fromId.userId.toString() : null;
      }
    } catch (e) {}

    await db.doc(`users/${UID}/mygram_messages/${chatId}/msgs/${msgId}`).set({
      msgId,
      chatId,
      chatName,
      text,
      isOut,
      date,
      hasMedia,
      mediaType,
      replyTo,
      reactions,
      senderName,
      senderId,
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    log("Gagal simpan mesej: " + e.message, "err");
  }
}

// ── Kemaskini dialog list selepas mesej baru ──────────────────────
async function updateDialogList(cid, chatName, lastMsg, isOut, hasMedia) {
  try {
    const msgDate = new Date().toISOString();
    const snap = await db.doc(`${DB_PREFIX}/dialogs`).get();
    if (!snap.exists) return;
    const currentList = snap.data().list || [];
    const updatedList = currentList.map((d) => {
      if (d.cid === cid) {
        return {
          ...d,
          lastMsg,
          lastMsgAt: msgDate,
          lastMsgIsOut: isOut,
          hasMedia,
          unread: isOut ? 0 : (d.unread || 0) + 1,
        };
      }
      return d;
    });
    await db.doc(`${DB_PREFIX}/dialogs`).update({
      list: updatedList,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  } catch (e) {
    log("Gagal update dialog list: " + e.message, "err");
  }
}

// ── Sync mesej terbaru semua chat ─────────────────────────────────
async function syncAllMessages() {
  try {
    if (!allDialogs.length) { log("Tiada dialog untuk sync."); return; }
    for (const dlg of allDialogs) {
      if (!dlg.entity) continue;
      const chatId = dlg.entity.id ? dlg.entity.id.toString() : null;
      if (!chatId) continue;
      const chatName = dlg.entity.firstName
        ? dlg.entity.firstName + (dlg.entity.lastName ? " " + dlg.entity.lastName : "")
        : dlg.entity.title || chatId;
      try {
        const msgs = await tgClient.getMessages(dlg.entity, { limit: 50 });
        const peta = new Map(msgs.map((m) => [m.id, m]));
        for (const msg of msgs) await saveMessage(msg, chatId, chatName, peta);
        log(`Synced ${msgs.length} mesej untuk "${chatName}"`, "ok");
      } catch (e) {
        log(`Gagal sync "${chatName}": ${e.message}`, "err");
      }
      await tidur(300);
    }
  } catch (e) {
    log("syncAllMessages error: " + e.message, "err");
  }
}

// ── Download media dan simpan base64 ke Firestore ─────────────────
async function downloadAndSaveMedia(msg, chatId, msgId) {
  try {
    const buffer = await tgClient.downloadMedia(msg, { workers: 1 });
    if (!buffer) return;
    const b64 = buffer.toString("base64");
    let mime = "application/octet-stream";
    if (msg.media && msg.media.photo) mime = "image/jpeg";
    else if (msg.media && msg.media.document) mime = msg.media.document.mimeType || mime;
    await db.doc(`users/${UID}/mygram_messages/${chatId}/msgs/${msgId}`).update({
      mediaData: `data:${mime};base64,${b64}`,
      mediaDownloaded: true,
    });
    log(`Media downloaded untuk msg ${msgId}`, "ok");
  } catch (e) {
    log(`Gagal download media: ${e.message}`, "err");
  }
}

// ── Outbox teks monitor ───────────────────────────────────────────
function startOutboxMonitor() {
  if (outboxUnsubscribe) outboxUnsubscribe();
  outboxUnsubscribe = db
    .collection(`users/${UID}/mygram_outbox`)
    .where("status", "==", "pending")
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        const data = change.doc.data();
        const docRef = change.doc.ref;
        if (!data.chatId || !data.text) {
          await docRef.update({ status: "failed", error: "chatId atau text kosong" });
          continue;
        }
        try {
          await docRef.update({ status: "sending" });
          const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === data.chatId);
          if (!dlg) throw new Error(`Peer tidak jumpa: ${data.chatId}`);
          const chatName = dlg.entity.firstName
            ? dlg.entity.firstName + (dlg.entity.lastName ? " " + dlg.entity.lastName : "")
            : dlg.entity.title || data.chatId;

          hentiTypingLive(false);

          // Bluetick → Menaip → Hantar
          await tgClient.markAsRead(dlg.entity).catch(() => {});
          await tunjukMenaip(dlg.entity, TYPING_MS, chatName);

          const opsyen = { message: data.text };
          if (data.replyToId) opsyen.replyTo = Number(data.replyToId);

          const result = await tgClient.sendMessage(dlg.entity, opsyen);
          await saveMessage(result, data.chatId, chatName);
          await updateDialogList(data.chatId, chatName, data.text, true, false);
          await docRef.update({ status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp() });
          log(`Hantar: "${data.text.substring(0, 40)}" → ${chatName}`, "ok");
        } catch (e) {
          await docRef.update({ status: "failed", error: e.message });
          log(`Outbox gagal: ${e.message}`, "err");
        }
      }
    });
  log("Outbox monitor aktif.", "ok");
}

// ── Outbox media monitor ──────────────────────────────────────────
function startMediaOutboxMonitor() {
  if (mediaOutboxUnsubscribe) mediaOutboxUnsubscribe();
  mediaOutboxUnsubscribe = db
    .collection(`users/${UID}/mygram_media_outbox`)
    .where("status", "==", "pending")
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        const data = change.doc.data();
        const docRef = change.doc.ref;
        if (!data.chatId || !data.dataUrl) {
          await docRef.update({ status: "failed", error: "chatId atau dataUrl kosong" });
          continue;
        }
        try {
          await docRef.update({ status: "sending" });
          const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === data.chatId);
          if (!dlg) throw new Error(`Peer tidak jumpa: ${data.chatId}`);
          const chatName = dlg.entity.firstName
            ? dlg.entity.firstName + (dlg.entity.lastName ? " " + dlg.entity.lastName : "")
            : dlg.entity.title || data.chatId;

          // Convert base64 → buffer → temp file
          const base64Data = data.dataUrl.replace(/^data:[^;]+;base64,/, "");
          const buffer = Buffer.from(base64Data, "base64");
          const ext = data.fileName ? path.extname(data.fileName) : ".bin";
          const tmpFile = path.join(os.tmpdir(), `mygram_${Date.now()}${ext}`);
          fs.writeFileSync(tmpFile, buffer);

          const opsyen = {
            file: tmpFile,
            caption: data.caption || "",
          };
          if (data.replyToId) opsyen.replyTo = Number(data.replyToId);

          const result = await tgClient.sendFile(dlg.entity, opsyen);
          fs.unlinkSync(tmpFile);

          await saveMessage(result, data.chatId, chatName);
          await updateDialogList(data.chatId, chatName, data.caption || `[${data.mediaType || "media"}]`, true, true);
          await docRef.update({ status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp() });
          log(`Media hantar → ${chatName}`, "ok");
        } catch (e) {
          await docRef.update({ status: "failed", error: e.message });
          log(`Media outbox gagal: ${e.message}`, "err");
        }
      }
    });
  log("Media outbox monitor aktif.", "ok");
}

// ── Delete mesej ──────────────────────────────────────────────────
function startDeleteMonitor() {
  db.collection(`users/${UID}/mygram_delete_queue`)
    .where("status", "==", "pending")
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        const data = change.doc.data();
        const docRef = change.doc.ref;
        try {
          await docRef.update({ status: "processing" });
          const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === data.chatId);
          if (!dlg) throw new Error(`Peer tidak jumpa: ${data.chatId}`);

          const msgIds = Array.isArray(data.msgIds) ? data.msgIds.map(Number) : [Number(data.msgId)];
          const forEveryone = !!data.forEveryone;

          await tgClient.deleteMessages(dlg.entity, msgIds, { revoke: forEveryone });

          // Padam dari Firestore juga
          for (const mid of msgIds) {
            await db.doc(`users/${UID}/mygram_messages/${data.chatId}/msgs/${mid}`).delete().catch(() => {});
          }

          await docRef.update({ status: "done" });
          log(`Padam ${msgIds.length} mesej (forEveryone=${forEveryone})`, "ok");
        } catch (e) {
          await docRef.update({ status: "failed", error: e.message });
          log(`Delete gagal: ${e.message}`, "err");
        }
      }
    });
  log("Delete monitor aktif.", "ok");
}

// ── Reaction monitor ──────────────────────────────────────────────
function startReactionMonitor() {
  db.collection(`users/${UID}/mygram_reactions`)
    .where("status", "==", "pending")
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        const data = change.doc.data();
        const docRef = change.doc.ref;
        try {
          await docRef.update({ status: "processing" });
          const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === data.chatId);
          if (!dlg) throw new Error(`Peer tidak jumpa: ${data.chatId}`);

          await tgClient.invoke(new Api.messages.SendReaction({
            peer: dlg.entity,
            msgId: Number(data.msgId),
            reaction: data.emoji ? [new Api.ReactionEmoji({ emoticon: data.emoji })] : [],
          }));

          await docRef.update({ status: "done" });
          log(`Reaction ${data.emoji} → msg ${data.msgId}`, "ok");
        } catch (e) {
          await docRef.update({ status: "failed", error: e.message });
          log(`Reaction gagal: ${e.message}`, "err");
        }
      }
    });
  log("Reaction monitor aktif.", "ok");
}

// ── Typing live ───────────────────────────────────────────────────
let typingLive = { chatId: null, lastBeat: 0 };
let typingLiveTimer = null;

async function hantarAksiTaip(chatId, batal) {
  const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === chatId);
  if (!dlg) return;
  try {
    await tgClient.invoke(new Api.messages.SetTyping({
      peer: dlg.entity,
      action: batal ? new Api.SendMessageCancelAction() : new Api.SendMessageTypingAction(),
    }));
  } catch (e) {}
}

function hentiTypingLive(hantarBatal) {
  if (typingLiveTimer) { clearInterval(typingLiveTimer); typingLiveTimer = null; }
  const cid = typingLive.chatId;
  typingLive = { chatId: null, lastBeat: 0 };
  if (hantarBatal && cid) hantarAksiTaip(cid, true);
}

function mulaTypingLive(chatId) {
  if (typingLive.chatId && typingLive.chatId !== chatId) hentiTypingLive(true);
  const baru = !typingLive.chatId;
  typingLive = { chatId, lastBeat: Date.now() };
  if (!baru && typingLiveTimer) return;
  hantarAksiTaip(chatId, false);
  typingLiveTimer = setInterval(() => {
    if (!typingLive.chatId) return;
    if (Date.now() - typingLive.lastBeat > TYPING_LIVE_STALE_MS) {
      hentiTypingLive(true);
      return;
    }
    hantarAksiTaip(typingLive.chatId, false);
  }, 4000);
}

function startTypingLiveMonitor() {
  db.doc(`${DB_PREFIX}/typing`).onSnapshot((snap) => {
    if (!snap.exists) return;
    const d = snap.data();
    const tsMs = d.ts && d.ts.toMillis ? d.ts.toMillis() : 0;
    const segar = tsMs && Date.now() - tsMs < TYPING_LIVE_STALE_MS;
    if (d.aktif && d.chatId && segar) {
      typingLive.lastBeat = Date.now();
      mulaTypingLive(String(d.chatId));
    } else if (typingLive.chatId) {
      hentiTypingLive(true);
    }
  }, (e) => log("Typing monitor error: " + e.message, "err"));
  log("Typing live monitor aktif.", "ok");
}

async function tunjukMenaip(entity, ms, chatName) {
  const hantarTyping = () => tgClient.invoke(new Api.messages.SetTyping({
    peer: entity,
    action: new Api.SendMessageTypingAction(),
  }));
  const tamat = Date.now() + ms;
  try {
    while (Date.now() < tamat) {
      await hantarTyping();
      await tidur(Math.min(4000, Math.max(0, tamat - Date.now())));
    }
  } catch (e) {
    await tidur(Math.max(0, tamat - Date.now()));
  }
}

// ── Login melalui MyGram Frontend ─────────────────────────────────
const loginRef = () => db.doc(`${DB_PREFIX}/login`);

function tungguLogin(syarat) {
  return new Promise((resolve) => {
    const unsub = loginRef().onSnapshot((snap) => {
      const d = snap.exists ? snap.data() : {};
      const hasil = syarat(d);
      if (hasil !== undefined && hasil !== null && hasil !== false) { unsub(); resolve(hasil); }
    }, (e) => log("Login listener error: " + e.message, "err"));
  });
}

async function loginMelaluiFrontend(apiId, apiHash, phone) {
  await setStatus("need_login");
  let ralatTerakhir = "";
  while (true) {
    await loginRef().set({
      tahap: "perlu_login", mula: false, kod: null, password: null, hint: null,
      mesej: ralatTerakhir, mintaRelogin: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    log("Menunggu arahan login dari MyGram...", "info");
    await tungguLogin((d) => d.mula === true);
    log("Frontend minta login. Menghantar kod...", "info");

    if (tgClient) await tgClient.disconnect().catch(() => {});
    tgClient = new TelegramClient(new StringSession(""), parseInt(apiId), apiHash, {
      connectionRetries: 5,
      retryDelay: 3000,
      connection: ConnectionTCPFull,
    });

    let ralatKod = "";
    try {
      await tgClient.start({
        phoneNumber: async () => phone,
        phoneCode: async () => {
          await loginRef().set({ tahap: "tunggu_kod", kod: null, mesej: ralatKod }, { merge: true });
          log("Menunggu OTP dari frontend...", "info");
          const kod = await tungguLogin((d) => (d.tahap === "tunggu_kod" && d.kod ? String(d.kod) : null));
          ralatKod = "";
          await loginRef().set({ kod: null, mesej: "" }, { merge: true });
          return kod;
        },
        password: async (hint) => {
          await loginRef().set({ tahap: "tunggu_password", password: null, hint: hint || null, mesej: ralatKod }, { merge: true });
          log("Menunggu kata laluan 2FA...", "info");
          const pw = await tungguLogin((d) => (d.tahap === "tunggu_password" && d.password ? String(d.password) : null));
          ralatKod = "";
          await loginRef().set({ password: null, mesej: "" }, { merge: true });
          return pw;
        },
        onError: async (err) => {
          ralatKod = err.message.includes("PHONE_CODE_INVALID") ? "Kod salah. Cuba lagi."
            : err.message.includes("PASSWORD_HASH_INVALID") ? "Kata laluan 2FA salah. Cuba lagi."
            : err.message;
          log("Ralat login: " + err.message, "err");
          return /FLOOD|PHONE_NUMBER|PHONE_CODE_EXPIRED|API_ID/.test(err.message);
        },
      });

      const me = await tgClient.getMe();
      const akaun = "@" + (me.username || me.firstName || "unknown");
      await saveSession(tgClient.session.save());
      await loginRef().set({
        tahap: "berjaya", mula: false, kod: null, password: null, hint: null, mesej: "", akaun,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      log(`Login berjaya sebagai ${akaun}`, "ok");
      return;
    } catch (e) {
      ralatTerakhir = e.message.includes("PHONE_CODE_EXPIRED") ? "Kod dah tamat tempoh. Tekan Mula Login semula."
        : e.message.includes("FLOOD") ? "Terlalu banyak cubaan. Tunggu sebentar."
        : "Login gagal: " + e.message;
      log(ralatTerakhir, "err");
    }
  }
}

// ── MAIN ──────────────────────────────────────────────────────────
async function main() {
  log("MyGram Worker bermula...");
  await setStatus("starting");

  const creds = await loadCreds();
  const { apiId, apiHash, phone } = creds;
  if (!apiId || !apiHash || !phone) {
    log("Creds tidak lengkap.", "err");
    process.exit(1);
  }
  log(`Creds: phone=${phone}, apiId=${apiId}`);

  const savedSession = await loadSession();
  const session = new StringSession(savedSession || "");

  const { Logger } = require("telegram/extensions");
  Logger.setLevel("none");

  tgClient = new TelegramClient(session, parseInt(apiId), apiHash, {
    connectionRetries: 5,
    retryDelay: 3000,
    connection: ConnectionTCPFull,
  });

  log("Menyambung ke Telegram...");
  await setStatus("connecting");

  let perluLogin = !savedSession;
  if (savedSession) {
    try {
      await tgClient.connect();
      const ok = await tgClient.checkAuthorization();
      if (ok) {
        log("Reconnect berjaya.", "ok");
      } else {
        log("Session tamat — perlu login semula.", "err");
        perluLogin = true;
      }
    } catch (e) {
      if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(e.message)) {
        log("Session tidak sah — perlu login semula.", "err");
        perluLogin = true;
      } else {
        log("Gagal connect: " + e.message, "err");
        await setStatus("connect_error", { error: e.message });
        process.exit(1);
      }
    }
  } else {
    log("Tiada session — perlu login.", "err");
  }

  if (perluLogin) await loginMelaluiFrontend(apiId, apiHash, phone);

  await saveSession(tgClient.session.save());

  const me = await tgClient.getMe();
  const myName = me.firstName + (me.lastName ? " " + me.lastName : "");
  const myUsername = me.username ? "@" + me.username : "";
  const myId = me.id ? me.id.toString() : "";
  log(`Login sebagai ${myName} ${myUsername}`, "ok");
  await setStatus("connected", { username: myUsername || myName, displayName: myName, userId: myId });

  // Daftar instance
  const INSTANCE_ID = [
    process.env.RAILWAY_SERVICE_NAME || os.hostname(),
    (process.env.RAILWAY_DEPLOYMENT_ID || "local").slice(0, 8),
    process.env.RAILWAY_REPLICA_ID ? process.env.RAILWAY_REPLICA_ID.slice(0, 8) : process.pid,
  ].join("-");
  const instCol = db.collection(`users/${UID}/mygram_worker_instances`);
  const daftarInstance = () => instCol.doc(INSTANCE_ID).set({
    host: os.hostname(), pid: process.pid,
    lastBeat: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true }).catch(() => {});
  await daftarInstance();
  setInterval(daftarInstance, 30 * 1000);

  // Sync dialogs awal
  await syncDialogs();

  // Monitor mesej baru
  tgClient.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const cid = msg.chatId ? msg.chatId.toString() : null;
    if (!cid) return;

    const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === cid);
    const chatName = dlg
      ? (dlg.entity.firstName
          ? dlg.entity.firstName + (dlg.entity.lastName ? " " + dlg.entity.lastName : "")
          : dlg.entity.title || cid)
      : cid;

    await saveMessage(msg, cid, chatName);
    await updateDialogList(cid, chatName, msg.message || `[${msg.media ? "media" : "mesej"}]`, !!msg.out, !!msg.media);

    // Download media kecil secara automatik (gambar & sticker)
    if (msg.media && (msg.media.photo || (msg.media.document && msg.media.document.size < 5 * 1024 * 1024))) {
      const msgId = msg.id ? msg.id.toString() : "";
      downloadAndSaveMedia(msg, cid, msgId).catch(() => {});
    }

    log(`Mesej baru dari "${chatName}": ${(msg.message || "[media]").substring(0, 40)}`, "ok");
  }, new NewMessage({}));

  log("Monitor mesej baru aktif.", "ok");

  // Start semua monitor
  startOutboxMonitor();
  startMediaOutboxMonitor();
  startDeleteMonitor();
  startReactionMonitor();
  startTypingLiveMonitor();

  // Paksa login semula
  loginRef().onSnapshot(async (snap) => {
    const d = snap.exists ? snap.data() : {};
    if (!d.mintaRelogin) return;
    log("Frontend minta login semula — restart...", "err");
    await loginRef().set({ mintaRelogin: false, tahap: "perlu_login", mula: false, kod: null, password: null, mesej: "" }, { merge: true }).catch(() => {});
    await saveSession("").catch(() => {});
    await setStatus("need_login").catch(() => {});
    if (tgClient) await tgClient.disconnect().catch(() => {});
    process.exit(1);
  }, (e) => log("Relogin listener error: " + e.message, "err"));

  // Arahan dari frontend
  db.doc(`${DB_PREFIX}/cmd`).onSnapshot(async (snap) => {
    if (!snap.exists) return;
    const data = snap.data();
    if (!data.action) return;
    await db.doc(`${DB_PREFIX}/cmd`).delete();

    if (data.action === "sync_all") {
      log("Sync semula semua mesej...");
      await syncAllMessages();
      log("Sync selesai.", "ok");
    } else if (data.action === "sync_dialogs") {
      await syncDialogs();
    } else if (data.action === "load_messages" && data.chatId) {
      // Load mesej untuk satu chat
      const dlg = allDialogs.find((d) => d.entity && d.entity.id && d.entity.id.toString() === data.chatId);
      if (dlg) {
        const chatName = dlg.entity.firstName
          ? dlg.entity.firstName + (dlg.entity.lastName ? " " + dlg.entity.lastName : "")
          : dlg.entity.title || data.chatId;
        const msgs = await tgClient.getMessages(dlg.entity, { limit: data.limit || 50, offsetId: data.offsetId || 0 });
        const peta = new Map(msgs.map((m) => [m.id, m]));
        for (const msg of msgs) await saveMessage(msg, data.chatId, chatName, peta);
        // Download media
        for (const msg of msgs) {
          if (msg.media && (msg.media.photo || (msg.media.document && msg.media.document.size < 5 * 1024 * 1024))) {
            await downloadAndSaveMedia(msg, data.chatId, msg.id.toString()).catch(() => {});
          }
        }
        log(`Load ${msgs.length} mesej untuk ${chatName}`, "ok");
      }
    }
  });

  // Auto sync dialogs setiap 5 minit
  setInterval(async () => {
    log("Auto-sync dialogs...");
    await syncDialogs();
  }, 5 * 60 * 1000);

  log("MyGram Worker berjalan penuh.", "ok");
  await setStatus("running", { username: myUsername || myName, displayName: myName });
}

// ── Handle crash ──────────────────────────────────────────────────
process.on("unhandledRejection", (err) => {
  log("Unhandled error: " + (err.message || err), "err");
});

process.on("SIGINT", async () => {
  log("Worker dihenti...");
  if (outboxUnsubscribe) outboxUnsubscribe();
  if (mediaOutboxUnsubscribe) mediaOutboxUnsubscribe();
  if (tgClient) await tgClient.disconnect().catch(() => {});
  await setStatus("stopped");
  process.exit(0);
});

main().catch(async (err) => {
  log("Fatal: " + err.message, "err");
  await setStatus("error", { error: err.message }).catch(() => {});
  process.exit(1);
});
