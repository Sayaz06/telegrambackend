# MyGram — Telegram Clone Peribadi

## Fail-fail

| Fail | Peranan |
|------|---------|
| `worker.js` | Backend Railway — MTProto bridge |
| `login.js` | Jalankan sekali untuk login pertama |
| `index.html` | Frontend GitHub Pages — UI lengkap |
| `manifest.json` | PWA manifest |
| `serviceAccount.json` | ⚠️ SENSITIF — jangan upload ke GitHub |

## Setup

### 1. Firestore — Tambah Creds

Buat dokumen manual dalam Firebase Console:

```
Path: users/jcATY6Xc0GdvgA1kGbNLEvoygDy1/mygram_session/creds
Fields:
  apiId: "32838983"
  apiHash: "d7e4da3535bddc54357c30e454272003"
  phone: "+60XXXXXXXX"
```

### 2. Firebase Config dalam index.html

Ganti bahagian `FIREBASE_CONFIG` dalam `index.html`:
- `apiKey` — dari Firebase Console → Project Settings
- `messagingSenderId`
- `appId`

### 3. Deploy Worker ke Railway

```bash
# Tambah serviceAccount.json ke folder ini
npm install
node login.js        # login sekali
```

Railway: tambah `serviceAccount.json` sebagai environment variable atau secret file.

### 4. Deploy Frontend ke GitHub Pages

Upload `index.html` + `manifest.json` ke repo GitHub Pages.

## Collections Firestore

| Collection | Kegunaan |
|-----------|---------|
| `mygram_session/creds` | API credentials |
| `mygram_session/main` | Session string |
| `mygram_worker/status` | Status worker |
| `mygram_worker/dialogs` | Senarai chat |
| `mygram_worker/login` | Handshake login |
| `mygram_worker/typing` | Typing indicator |
| `mygram_worker/cmd` | Arahan ke worker |
| `mygram_messages/{chatId}/msgs` | Mesej |
| `mygram_outbox` | Outbox teks |
| `mygram_media_outbox` | Outbox media/fail |
| `mygram_delete_queue` | Queue padam mesej |
| `mygram_reactions` | Queue reaksi |

## Ciri-ciri

- ✅ Chat teks
- ✅ Hantar gambar, video, audio, dokumen
- ✅ Voice note
- ✅ Reply/Quote mesej
- ✅ Reaksi (❤️ 👍 😂 dan lain-lain)
- ✅ Hantar semula (Forward)
- ✅ Padam untuk saya / Padam untuk semua
- ✅ Typing indicator
- ✅ Blue tick (baca)
- ✅ Status online/offline
- ✅ Group chat
- ✅ Emoji picker
- ✅ Sticker display
- ✅ Tema gelap/cerah
- ✅ PWA (boleh install ke homescreen)
- ❌ Global search (sengaja dilumpuhkan)
- ❌ Hashtag search (sengaja dilumpuhkan)
