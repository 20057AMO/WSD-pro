# خطة WSD-Pro — MVP أولاً

**المبادئ الأساسية المحددة:**
- 🆓 **Agents مجانية فقط** — Ollama (local models، لا APIs مدفوعة)
- 🏠 **Local IP فقط** — لا DNS، لا domain (مثل CasaOS)
- 🐳 **Docker** — عزل كامل لكل مشروع
- 💻 **Web IDE** — code-server (VS Code في المتصفح)
- 📦 **CasaOS** — مرجع لطريقة التثبيت وتجربة المستخدم

---

## ما تم بناؤه ✅

| الميزة | الحالة |
|-------|--------|
| Auth (JWT + bcrypt + rate limit + secret ديناميكي) | ✅ |
| Projects CRUD (Docker) | ✅ |
| File API كامل | ✅ |
| Local Ollama Agent (ReAct → Streaming) | ✅ |
| Terminal real-time (WS + dockerode TTY + xterm) | ✅ |
| Chat streaming (WS + JSONL + replay) | ✅ |
| Web IDE واحد مشترك (code-server :8100) | ✅ |
| Port scanner (منافذ حية للمعاينة) | ✅ |
| Git service (status/log/diff/commit) | ✅ |
| Caddy (local IP + Tailscale + self-signed TLS) | ✅ |
| Installer CasaOS-style (install.sh + steps + قوالب) | ✅ |
| Tailscale (كشف IP تلقائي + blocks جاهزة) | ✅ |

---

## 🎯 MVP — المرحلة 1: الأساس الحقيقي

> **الهدف:** محادثة حقيقية real-time مع الـ agent + ذاكرة دائمة + terminal

### [NEW] `backend/src/services/chat-store.ts`
- ملفات JSONL لكل محادثة: `backend/data/chats/{slug}/{chatId}/events.jsonl`
- كل حدث: `{ seq, type, content, timestamp }`
- الأنواع: `user_message` | `agent_chunk` | `agent_done` | `agent_error`

### [NEW] `backend/src/ws/ws-chat.ts`
- WebSocket `/ws/chat/{slug}/{chatId}`
- يستقبل `{ type: "prompt", text }` → يُشغّل Ollama → يبث chunks فوراً
- حفظ كل حدث في JSONL + replay لمتصفح يعيد الاتصال
- قاعدة: run واحد فقط per chat

### [NEW] `backend/src/ws/ws-terminal.ts`
- WebSocket `/ws/terminal/{slug}`
- `node-pty` → `docker exec -it wsd-{slug} /bin/bash`
- دعم resize: `{ type: "resize", cols, rows }`

### [MODIFY] [backend/src/services/agents-manager.ts](file:///D:/Work/WSD-Pro/backend/src/services/agents-manager.ts)
- تحويل [runAgent](file:///D:/Work/WSD-Pro/backend/src/services/agents-manager.ts#195-224) → EventEmitter streaming بدلاً من fire-and-forget
- إرسال كل chunk عبر WS فوراً

### [NEW] `backend/src/services/project-store.ts`
- حفظ metadata في `backend/data/projects/{slug}/meta.json`
- لا اعتماد على Docker labels وحدها

---

## 🎯 MVP — المرحلة 2: أدوات المطور

> **الهدف:** Git + Port scanner + Web IDE داخل المتصفح

### [NEW] `backend/src/services/git-service.ts`
- `GET /api/projects/:slug/git/status`
- `GET /api/projects/:slug/git/log`
- `GET /api/projects/:slug/git/diff`
- `POST /api/projects/:slug/git/commit`

### [NEW] `backend/src/services/port-scanner.ts`
- كل 5 ثوانٍ: `docker exec wsd-{slug} ss -tlnp`
- يكشف الـ ports المفتوحة → يبثّها عبر WS للـ Frontend
- `GET /api/projects/:slug/ports`

### [NEW] `backend/src/services/ide-service.ts`
- تثبيت وإدارة **code-server** داخل كل container
- الوصول عبر: `http://192.168.0.110:PORT/` (port مخصص لكل مشروع)
- بدون subdomain — كل مشروع يحصل على port مختلف مثلاً **8100, 8101, 8102...**
- `POST /api/projects/:slug/ide/start` → يُشغّل code-server داخل الـ container
- `GET /api/projects/:slug/ide/status`

### [NEW] `Dockerfile.workspace`
- صورة Docker مخصصة بدلاً من `ubuntu:24.04` الفارغة
- يتضمن: `git`, `curl`, `wget`, `node 22`, `python3`, `code-server`
- يُبنى مرة واحدة وتستخدمه كل المشاريع

### [MODIFY] [Caddyfile](file:///D:/Work/WSD-Pro/Caddyfile)
- إضافة reverse proxy للـ ports الديناميكية (code-server per project)
- `https://192.168.0.110` — لوحة التحكم الرئيسية
- `https://192.168.0.110:PORT` — code-server لكل مشروع

---

## 🎯 MVP — المرحلة 3: التثبيت (CasaOS-style)

> **الهدف:** تثبيت بأمر واحد مثل CasaOS دون أي إعداد DNS

```bash
curl -fsSL https://raw.githubusercontent.com/20057AMO/WSD-pro/main/install.sh | sudo bash
```

### [NEW] [install.sh](file:///D:/Work/RemoteProject/remote.futrx-main/infra/install.sh)
```
خطوات التثبيت (مثل CasaOS):
  1. التحقق من المتطلبات (Docker, curl)
  2. اكتشاف local IP تلقائياً (hostname -I)
  3. تثبيت Node.js 22
  4. بناء Docker workspace image
  5. إنشاء systemd service
  6. تكوين Caddy على الـ local IP
  7. عرض رابط الوصول: http://192.168.x.x:3000
```

### [NEW] `infra/steps/` (مثل Remote)
- `01-deps.sh` — Docker, Node, Caddy
- `02-build.sh` — بناء frontend + backend
- [03-caddy.sh](file:///D:/Work/RemoteProject/remote.futrx-main/infra/steps/03-caddy.sh) — إعداد Caddy بـ local IP
- `04-service.sh` — systemd

---

## 🆓 Agents المجانية المدعومة

| الـ Agent | النموذج | المتطلب |
|----------|---------|---------|
| **Local Ollama** | `qwen2.5-coder:3b/7b` | Ollama محلي |
| **Local Ollama** | `llama3.2`, `gemma3` | Ollama محلي |
| **Ollama Cloud** | `gpt-oss:120b` | API key مجاني |
| **OpenRouter** | `deepseek-r1` (مجاني) | API key مجاني |

> ❌ لا Claude، لا Codex المدفوع، لا Kimi — هذه مخصصة لـ Remote

---

## 🔮 Post-MVP (بعد اكتمال الـ MVP)

| الميزة | الوصف |
|-------|------|
| Multi-user | دعم فريق عمل بدعوات |
| Project secrets | حقن env vars بطريقة آمنة |
| Scheduled tasks | مهام مجدولة (cron) |
| File upload | رفع ملفات بـ resumable TUS |
| Agent browser | Chromium + noVNC مشترك |
| Mobile UI | تجربة Mobile-first |
| Frontend → Preact | إعادة بناء UI بـ Preact + Vite |

---

## الجدول الزمني

```
الأسبوع 1-2  →  المرحلة 1 (WS chat + Terminal)
الأسبوع 3-4  →  المرحلة 2 (Git + Port scanner + IDE)
الأسبوع 5    →  المرحلة 3 (Installer + Polish)
────────────────────────────────────────
               ✅ MVP مكتمل
الأسبوع 6+   →  Post-MVP features
```
