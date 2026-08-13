# دليل التثبيت الكامل — WSD-Pro (طريقة Clone)

> **WSD-Pro مخصص للـ Linux فقط** (Ubuntu 22.04/24.04 أو Debian 12).
> طريقة التثبيت: استنساخ الريبو ثم تشغيل المثبّت من داخل النسخة — لا حاجة لأي إعداد DNS أو Domain.

---

## 1. المتطلبات قبل البدء

| المتطلب | الحد الأدنى | الموصى به |
|---------|-------------|-----------|
| النظام | Ubuntu 22.04+ / Debian 12 | Ubuntu 24.04 LTS |
| الرام | 8 GB | 16 GB (لتشغيل الموديلات المحلية بسلاسة) |
| التخزين | 20 GB حر | 50 GB+ (موديلات Ollama تستهلك مساحة) |
| صلاحيات | حساب root أو sudo | — |
| الإنترنت | نعم (لتثبيت الحزم وبناء الصور) | — |

**اختياري:**
- **Tailscale** — إن أردت الوصول من أي مكان ومن الشبكات الخارجية
- **Ollama** — يُثبَّت تلقائياً مع خيار `--with-ollama`

---

## 2. الخطوات التفصيلية

### الخطوة 1: تحديث النظام (اختياري لكن مستحسن)

```bash
sudo apt update && sudo apt upgrade -y
```

### الخطوة 2: تثبيت git

```bash
sudo apt install -y git
```

### الخطوة 3: استنساخ المشروع (Clone)

```bash
git clone https://github.com/20057AMO/WSD-pro.git
cd WSD-pro
```

> 💡 يمكنك الاستنساخ في أي مجلد تريده، مثال:
> `sudo mkdir -p /opt/wsd-pro && sudo chown $USER:$USER /opt/wsd-pro && git clone ... /opt/wsd-pro`
> التطبيق يُثبَّت **فوراً من النسخة** ولا يُنسخ لمكان آخر؛ أي تحديث لاحق يتم عبر `git pull` في نفس المجلد.

### الخطوة 4: تشغيل المثبّت

**تثبيت أساسي (بدون موديلات محلية):**

```bash
sudo bash infra/install.sh
```

**تثبيت كامل + Ollama (موديلات الذكاء الاصطناعي المجانية):**

```bash
sudo bash infra/install.sh --with-ollama
```

> ⏱️ يستغرق **10–15 دقيقة** في أول مرة (تنزيل Docker/Node/Caddy + بناء صورة الـ IDE مع code-server + سحب الموديل إن طلبت Ollama).

---

## 3. ماذا يفعل المثبّت بالتفصيل؟

| الخطوة | الملف | ما يحدث |
|--------|-------|---------|
| 1/5 | `01-deps.sh` | تثبيت الحزم الأساسية، **Docker** (إن لم يكن موجوداً)، **Node.js 22**، إنشاء مستخدم النظام `wsd-pro` وإضافته لمجموعة docker، إنشاء مجلدات البيانات |
| 2/5 | `02-build.sh` | `npm install` + بناء الـ backend بـ TypeScript **داخل نسختك**، ثم بناء صورة **`wsd/workspace:latest`** (Node 22 + Python + git + code-server) من `Dockerfile.workspace` |
| 3/5 | `03-caddy.sh` | تثبيت **Caddy** وتوليد ملف `/etc/caddy/Caddyfile` من القالب بإعداد **شهادات ذاتية** (local_certs) — للوحة `:3000` وللـ IDE `:8100`، مع blocks تلقائية لـ **Tailscale** إن كان مفعلاً |
| 4/5 | `04-service.sh` | توليد بيانات الدخول السرية (JWT + كلمة المرور + كلمة IDE) في **`/var/lib/wsd-pro/env.conf`**، وإنشاء خدمة **systemd** `wsd-pro-backend` وبدء تشغيلها |
| 5/5 | `05-ollama.sh` | **اختياري**: تثبيت Ollama + سحب نموذج `qwen2.5-coder:3b` (مجاني وكامل محلياً) |

**كشف الشبكة تلقائياً:**
- **الـ IP المحلي** يُكتشف عبر `ip route` / `hostname -I`
- **IP الـ Tailscale** (نطاق `100.x.x.x`) يُكتشف تلقائياً إن كان الـ tailscale يعمل
- انضم إلى Tailscale لاحقاً؟ **أعد تشغيل المثبّت** — هو Idempotent (آمن إعادة التشغيل) وسيولّد روابط الـ Tailscale من جديد.

---

## 4. بعد التثبيت — الوصول النهائي

عند انتهاء المثبّت سترى ملخصاً مثل هذا:

```
═══════════════════════════════════════════
   ✅ WSD-Pro installed successfully!

   Dashboard:  https://192.168.0.110            user: admin
   Password:   X9kQ2mRs4t                       ← تم إنشاؤه تلقائياً
   Web IDE:    https://192.168.0.110:8100   password: j7vP3nLw8a
   Tailscale:  https://100.101.102.103  /  https://100.101.102.103:8100
═══════════════════════════════════════════
```

| الرابط | الوصف |
|--------|-------|
| `https://<IP>` | **لوحة التحكم** — المشاريع، الطرفية الحية، المحادثة مع الوكيل، الملفات، git، المنافذ |
| `https://<IP>:8100` | **Web IDE** — VS Code واحد يفتح منه كل المشاريع (من مجلد `/workspaces`) |
| `http://<IP>:<port>` | **معاينات مباشرة** — المنافذ التي يفتحها مشروعك تظهر تلقائياً في اللوحة |

> 🔐 الشهادة ذاتية التوقيع — المتصفح سيحذّر أول مرة؛ قبّلها وستعمل بشكل طبيعي.

---

## 5. إدارة بيانات الدخول

جميع الأسرار في ملف واحد:

```bash
sudo nano /var/lib/wsd-pro/env.conf   # عدّل كلمات المرور / المنفذ
sudo systemctl restart wsd-pro-backend
```

---

## 6. التحديث (Update)

```bash
cd /path/to/WSD-pro          # مجلد النسخة لديك
sudo bash infra/update.sh    # git pull + build + restart
```

المثبّت نفسه لا ينسخ التطبيق لأي مكان — لذلك `git pull` كافٍ دائماً.

---

## 7. إلغاء التثبيت (Uninstall)

```bash
sudo bash /path/to/WSD-pro/infra/uninstall.sh
```

يحذف: الحاويات (المشاريع + الـ IDE)، البيانات (`/var/lib/wsd-pro`)، وخدمة النظام. **يبقي**: Caddy و Ollama والنسخة نفسها (تحذفها يدوياً).

---

## 8. الوصول عبر Tailscale (من أي مكان)

```bash
# على الخادم:
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo tailscale up          # اتبع رابط التفويض
sudo bash infra/install.sh # أعد تشغيل المثبّت لإنشاء روابط الـ tailnet

# على جهازك (لابتوب/هاتف):
curl -fsSL https://tailscale.com/install.sh | sudo sh   # أو التطبيق الرسمي
sudo tailscale up

# الآن افتح:
https://100.x.y.z          # لوحة التحكم من أي مكان
https://100.x.y.z:8100     # الـ IDE
```

---

## 9. استكشاف الأخطاء

| المشكلة | الحل |
|---------|------|
| `curl: (7) connection refused` بعد التثبيت | `sudo systemctl status wsd-pro-backend` — غالباً المنفذ محجوز أو الخدمة لم تبدأ |
| الـ IDE لا يعمل على `:8100` | تأكد من بناء الصورة: `docker images wsd/workspace` — أو `cd /path/to/WSD-pro && sudo bash infra/install.sh` |
| المتصفح يرفض الشهادة الذاتية | قبّل الاستثناء في المتصفح (تفاصيل → متابعة) |
| الموديل المحلي بطيء | المثبّت يسحب `qwen2.5-coder:3b` — جرّب أصغر: `ollama pull qwen2.5-coder:1.5b` |
| تغيّر الـ IP بعد إعادة التشغيل | أعد تشغيل المثبّت (يدرك الشبكة من جديد) أو ثبّت الـ IP في الراوتر |