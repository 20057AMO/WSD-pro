# دليل التثبيت — WSD-Pro v2

تطبيق `docker compose` بسيط، بدون دومين وبدون SSL. كل المطلوب: محرك Docker مع إضافة Compose.

## المتطلبات

- Docker Engine 24+ (مع `compose` plugin) على لينكس (يُفضّل Ubuntu 22.04/24.04)
- مفتاح Ollama Cloud مجاني من https://ollama.com/settings/keys (للدردشة فقط)
- مفتاح OpenCode Zen مجاني من https://opencode.ai/auth (دخول GitHub، **بدون بطاقة ائتمان**) — لنماذج Zen المجانية (Big Pickle)

## خطوات التثبيت

### 1) انسخ المشروع

```bash
git clone <repo-url> wsd-pro
cd wsd-pro
```

### 2) أنشئ ملف البيئة

```bash
cp .env.example .env
nano .env
```

| المتغير | الوصف |
| --- | --- |
| `OLLAMA_API_KEY` | **إلزامي** — للدردشة (qwen3:30b على Ollama Cloud) |
| `OPENCODE_API_KEY` | **إلزامي** — مفتاح Zen المجاني (نموذج Big Pickle) من https://opencode.ai/auth |
| `WSD_CHAT_MODEL` | اسم النموذج (افتراضي `qwen3:30b`) |
| `WSD_IDE_PASSWORD` | كلمة مرور المحرر الثابتة (افتراضي `admin123`) |
| `WSD_IDE_PORT` | منفذ المحرر الخارجي (افتراضي `8100`) |
| `WSD_OPENCODE_PORT` | منفذ واجهة opencode (افتراضي `4096`) |

### 3) ابنِ وشغّل

```bash
docker compose build
docker compose up -d
```

سيبني `app` (اللوحة + المحرر + opencode web) و`workspace` (صورة المشاريع).

### 4) افتح اللوحة

- اللوحة: `http://<IP>:3000`
- محرر IDE: `http://<IP>:8100` — افتحه من زر **Web IDE** في اللوحة لعرض كلمة المرور (افتراضي `admin123`)
- opencode: زر **opencode** في الشريط الجانبي أو `http://<IP>:4096`

## طريقة الاستخدام

1. **إنشاء مشروع**: أدخل الاسم (والمنافذ اختياريًا مثل `8080,8081`). يُنشأ مجلد `workspaces/<slug>` وحاوية باسم `wsd-<slug>` على منفذه الخاص.
2. **البناء بـ opencode**: زر **opencode** في الشريط الجانبي يفتح واجهة opencode الرسمية (النافذة الافتراضية) على `http://<IP>:4096` — الجلسات تعمل من `/workspaces`، والنموذج الافتراضي **Big Pickle** (Zen مجاني). زر **Open in new tab** يفتحها خارج اللوحة.
3. **الرفع**: تبويب **Upload** — ارفع ملفات إلى `/workspaces/<slug>` (ملفات فقط، بدون أرشفة).
4. **التصميم**: صفحة **Chat & Design** — دردشة مع `qwen3:30b` لتخطيط الفكرة والبنية.
5. **المحرر**: زر **Web IDE** في القائمة الجانبية يعرض عنوان المحرر وكلمة المرور (زر **Direct** يفتحه في متصفحك مباشرة). أدخل كلمة المرور (افتراضي `admin123`).

## ملاحظات

- حاويات المشاريع لا تُشغّل خدمات تلقائيًا؛ `sleep infinity` فقط. لتشغيل خادم داخل المشروع، نفّذ ذلك عبر opencode أو المحرر (المنفذ المحدد عند الإنشاء يجب أن يكون مُعرّضًا).
- البيانات المحفوظة: `./workspaces` (ملفات المشاريع) وvolume `wsd-data` (كلمة مرور المحرر وجلسات opencode وسجل الدردشة).
- رفع/إيقاف/حذف المشروع تحافظ على ملفات الـworkspace.
- لا يوجد متصفح داخل الحاوية (تمت إزالته لتوفير الرام). معاينات المشاريع تُفتح كروابط مباشرة في متصفحك.

## استكشاف الأخطاء

| المشكلة | الحل |
| --- | --- |
| `OLLAMA_API_KEY: set OLLAMA_API_KEY in .env` | أضف المفتاح إلى `.env` وأعد `docker compose up -d` |
| `OPENCODE_API_KEY: set OPENCODE_API_KEY in .env` | أنشئ مفتاح Zen مجاني من https://opencode.ai/auth وأضفه إلى `.env` |
| إنشاء المشروع يفشل | تأكد أن مقبس `/var/run/docker.sock` مسموح للحاوية `app` |
| المحرر لا يفتح | تأكد أن منفذ `8100` غير محجوب، وأن `app` شغّال (`docker compose ps`) |
| opencode لا يعمل | افحص `docker compose logs app` لسجل `/tmp/opencode-web.log` |
| الدردشة تخطئ | تحقق من صحة المفتاح وصحة النموذج `WSD_CHAT_MODEL` |

## إيقاف

```bash
docker compose down
```

لحذف بيانات الدردشة وكلمة المرور أيضًا: `docker compose down -v`
