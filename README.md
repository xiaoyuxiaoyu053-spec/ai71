# Linely Web 2.6.0

The Linely app as a web app: iMessage-style AI chat with glass UI, bounce animations, 信息 list, 动态 feed (AI likes / comments / posts), 增加AI, groups, red packets & transfers, tapback reactions, sounds, light/dark chat, backup ZIP (compatible with the Android app).

* **** – plain Node.js (>= 18) server + static files. No build step.
* **No accounts, no database.** All chats, AI characters, API keys and images live in the visitor's own browser (IndexedDB).
* `POST /api/ai` is a tiny stateless relay to DeepSeek / Claude / 豆包 / ChatGPT so the browser does not hit CORS errors. The upstream URL comes from a fixed allow-list on the server (never from the client); keys are forwarded for that one request and never stored or logged. Per-IP rate limit (default 90/min, env `RATE_LIMIT_PER_MIN`) and 16 MB body limit.

## Deploy on Render (about 3 minutes)
1. Put this folder in a Git repository (GitHub / GitLab) and push it.
2. Render dashboard → **New + → Blueprint** → select the repo. `render.yaml` is picked up automatically (free web service, health check `/healthz`).
   *Or* **New + → Web Service** with: Runtime `Node`, Build Command `npm install --no-audit --no-fund`, Start Command `node server.js`, Health Check Path `/healthz`.
3. Open the `https://<name>.onrender.com` URL. On a phone use **Add to Home Screen** to install it as an app (it ships a web-app manifest).

Notes
* Render's free plan sleeps after ~15 min idle; the first request afterwards takes a few seconds. Any paid plan stays awake (the AI "auto post" timer only runs while the page is open anyway).
* HTTPS is provided by Render, which is required for microphone/speech recognition and for installing the PWA.
* Environment variables (all optional): `PORT` (Render sets it), `RATE_LIMIT_PER_MIN`.

## Run locally
```
node server.js        # http://localhost:3000   (PORT=8080 node server.js to change)
```

## Using it
1. **增加AI → 创建 AI**: name, persona, provider, model, API key (kept only in this browser).
2. Chat. Long-press (or right-click) a bubble for tapback / copy / quote / delete. Tap a bubble to show its time, model and token count. `+` opens image / GIF / 红包 / 转账.
3. **我的 → 数据与备份** to export/restore a ZIP. Android backups (`data.json` + `media/`) can be imported here and the other way round.
4. **我的 → 连接方式**: relay through this server (default, recommended) or call the provider directly from the browser (works only where the provider allows CORS).

## Differences from the Android app (browser limits)
* The **AI Smart Assistant** (AccessibilityService phone control) cannot exist in a web page – it is Android-only.
* Voice chat uses the browser's Web Speech API (Chrome / Edge / Safari); it is not available in every browser (e.g. Firefox). The 病娇 (Yandere) easter egg and shake sensor are not ported.
* Data is per browser. Clearing site data deletes it – export backups regularly.
* Because the default mode relays through your server, whoever operates the server could technically see requests in transit. This code does not store or log them; if you do not want that, use "浏览器直连" or self-host.

## Files
```
server.js              static server + /api/ai relay + /healthz
render.yaml            Render Blueprint
public/index.html      app shell, manifest, icons, sounds
public/css/app.css     glass / iMessage styling
public/js/*.js         lib (AI, ZIP, IndexedDB, sounds) · state · logic · core · home · chat · forms · settings
```

## Linely 2.6.0 新增能力

- 管理后台：访问 `/admin.html`。部署时必须设置 `LINELY_ADMIN_PASSWORD`，否则管理员登录会被禁用。
- 免费 API：管理员在后台设置服务商、模型和 API Key；密钥保存在服务端 `data/admin-config.json`，不会下发给访客，也不会进入浏览器 ZIP 备份。也可用 `LINELY_FREE_API_KEY`、`LINELY_FREE_API_PROVIDER`、`LINELY_FREE_API_MODEL` 提供初始配置。
- 公告：管理员后台发布后，用户打开网页时会显示公告条。
- 统计：服务端统计页面加载、API 请求和服务商返回的 Token 用量，聚合数据保存在 `data/metrics.json`。不保存访客 IP、聊天内容或用户自带 API Key。
- DeepSeek：在「我的 → 数据与备份」导入 DeepSeek 完整导出 ZIP；以追加方式导入会话，保留原始消息片段、思考内容、工具记录和时间戳，按源会话 ID 去重。
- 人设 TXT：编辑 AI 人设时可直接导入 `.txt`。
- 长期记忆：聊天历史完整保存在本机；上下文会优先携带已生成的阶段总结及最近消息。模型仍受服务商上下文窗口限制，不能承诺单次请求无限上下文。

### 部署环境变量

- `LINELY_ADMIN_PASSWORD`：必填的管理员登录密码。
- `LINELY_DATA_DIR`：可选，服务端配置和统计的持久化目录。生产环境应挂载持久化磁盘到该目录。
- `LINELY_FREE_API_KEY`：可选，免费 API 初始密钥。
- `LINELY_FREE_API_PROVIDER`：可选，默认 `DeepSeek`。
- `LINELY_FREE_API_MODEL`：可选，默认 `deepseek-chat`。

管理员密码和 API Key 不要写入公开仓库、前端文件或 ZIP 包。无持久化磁盘的平台在重启/重新部署后可能丢失后台保存的配置和统计数据。

统计口径补充：用户若启用「浏览器直连」模式，AI 请求不会经过本站服务器，因此这类请求无法被服务器准确计入 API 次数和 Token；使用默认的「经服务器转发」模式时统计完整。网站访问量按页面 HTML 请求次数计数，不是去重后的独立访客。Token 以服务商实际返回的 usage 字段为准。


## 3.0.0 账号与音乐
- 网站入口要求注册或登录；账号使用 Node.js scrypt 哈希保存于数据目录 users.json。
- 管理员可在后台查看用户并封禁/解封。请设置 LINELY_ADMIN_PASSWORD。
- 登录页：/auth.html；官方音乐嵌入页：/music.html。音乐由网易云官方外链播放器提供，歌曲可用性遵循平台规则。
- 持久化磁盘必须挂载到 LINELY_DATA_DIR（Render 推荐 /var/data）。


## 3.0.0 增量完善（保留版本号）
- 音乐页现在从本地 Linely 角色列表选择角色，并通过既有 AI API 调用发送对话。
- 音乐页支持选择本地背景图片，以及可选的定时 AI 主动消息（每 3 分钟，需页面保持打开且已加载歌曲）。
- 新增主题广场页面：创建主题、设置强调色和双方气泡颜色、上传背景图、发布和应用主题。
- 主页面顶部新增主题广场入口。主题数据保存在服务端数据目录；个人应用的主题保存在浏览器本地。

说明：网易云官方嵌入播放器受网易云页面能力限制，网页不能保证读取歌曲时长/播放进度，也不能从外部控制官方播放器的播放、暂停或 seek；这些控件不能通过非官方接口绕过。多人实时同步播放暂未实现。


## 3.0.0 界面更新：一起听 / 主题 / 后台
- **底部栏**：现在是 信息 · 动态 · 增加AI · 一起听 · 主题 · 我的。顶部原来的 ♫ / ✦ 按钮已移除；`/music.html`、`/themes.html` 会自动跳转到 `/#music`、`/#themes`。
- **一起听**：采用与聊天页相同的界面（头像头部、气泡、输入栏）。网易云官方播放器常驻在页面外层，切换底部栏标签时音乐不会中断。支持歌曲 / 专辑 / 歌单链接（含 `#/song?id=` 形式）。音乐聊天记录单独保存在角色的 `musicMessages` 中，不会混进普通聊天。可单独设置背景图。
- **主题**：新增「气泡样式」——经典、小兔子（长耳朵 + 毛茸茸小尾巴）、小猫咪、云朵、贴纸。可调强调色、双方气泡/文字颜色、气泡圆角、氛围背景、背景图；实时预览使用真实聊天气泡。应用后全站（聊天、群聊、一起听）同步生效。发布到主题广场时会一并保存样式、圆角和文字颜色。
- **管理后台**：全新玻璃风界面——概览（指标卡 + 14 天趋势图）、免费 API、公告、用户（搜索、封禁二次确认）。接口与之前完全相同。


## 3.0.0 第二批更新：MP3 / 气泡工坊 / 玻璃按钮 / 文档导入 / 角色图鉴
- **一起听 = 本地 MP3 播放器**：上传 MP3（M4A / WAV 也行，单个 ≤ 20 MB），自定义歌名、歌手和图标（封面），支持歌单、上一首/下一首、进度条、顺序/随机/单曲循环，播放时封面会旋转。音乐保存在浏览器本地（会进入备份 ZIP），切换底部栏标签时不会中断。AI 聊天会知道正在听哪首歌。
- **主题 = 气泡工坊**：预设样式之外可以「新建气泡」——调圆角、边框、阴影、纹理、小尾巴；**添加表情**、**上传图片**、**手绘**装饰，在预览里直接拖动位置，还能调大小、旋转、出现位置（每段第一个/最后一个/每个气泡）和「放在气泡后面」。自己的气泡保存在「我的气泡」，应用后聊天、群聊、一起听同步生效。
- **全部按钮改为 Apple 玻璃拟态**：半透明磨砂、顶部高光、描边与柔和阴影；主按钮为着色玻璃。App、登录页和管理后台一致。
- **文档导入角色**（增加AI → 文档导入）：支持 TXT / MD / JSON（含常见角色卡）/ DOCX。由 AI（站点免费 API，或借用已有角色的 API）整理成名字、简介、人设、喜好等，也可选「本地规则」不用 AI。结果会先在编辑页预填，确认后再保存。
- **角色图鉴**（增加AI → 角色图鉴）：发布自己的角色（可选分享人设），并为别人的角色**投稿头像**；每个角色会收集到不同用户做的头像，可一键设为自己角色的头像、放大、保存。后台新增「角色图鉴」页用于审核删除。数据保存在 `LINELY_DATA_DIR/gallery.json`。


## 3.0.0 第三批更新：表情包 / 语音与视频通话 / AI 朗读
- **AI 联网搜中文表情包**：AI 想发梗图时会在回复里写 `[[MEME:关键词]]`，前端通过服务器的 `/api/meme/search`（必应图片为主、搜狗为备）搜索，再经 `/api/meme/img` 代理下载（浏览器的 CSP 不允许直接加载外站图片；代理会拒绝内网/本机/云元数据地址，限制 3 MB、只允许 jpeg/png/gif/webp）。图片保存到本地后作为图片消息发出，最多每条回复一个，并提示 AI「大约每 5 条才发一次」。设置环境变量 `LINELY_MEME_SEARCH=0` 可在服务端整体关闭。
- **收集用户发来的图片**：你发给 AI 的图片/GIF 会自动进入「表情库」（可在表情库里关闭），AI 之后可用 `[[MYMEME:编号]]` 把它们当表情包再发给你；长按任意图片消息可「收藏到表情库」；表情库里还能直接搜索网络表情包、重命名、删除。入口：聊天「+」面板 / 聊天右上角菜单 / 我的 → 语音与表情包。
- **语音通话与视频通话**：聊天页右上角电话 / 视频按钮。流程：呼叫铃声 → 接通 → 你说话（浏览器语音识别）→ AI 回复并**朗读出来** → 继续听。包含通话计时、静音、外放开关、文字输入（不支持语音识别或没有麦克风权限时可用）、点击头像可打断 AI、挂断后在聊天里留下通话记录和对话文字。视频通话会打开前置/后置摄像头小窗（可开关、翻转）；「让AI看我」开启后每次发言附一张摄像头截图（需要支持图片的模型，不支持会自动关闭）。
- **AI 朗读与语气可调**：使用浏览器自带语音，不需要额外 API。每个角色可单独选择声音，并有 温柔 / 活泼 / 沉稳 / 甜美 / 少年 / 慢读 / 播音 等语气预设，以及语速、音调、音量滑块和试听；长按消息可「朗读 / 停止朗读」；可开启「AI 新消息自动朗读」。通话与朗读语言可在 我的 → 语音与表情包 里切换（中文 / English / 日本語 / 한국어）。
- 注意：语音识别依赖浏览器（Chrome / Edge / Safari 支持，Firefox 不支持，此时用文字输入）；摄像头和麦克风需要 HTTPS（Render 默认满足）；可用的声音取决于设备，iPhone/安卓可在系统设置里安装更多中文语音。


## 3.0.0 · 改名为 Linely
- 产品名由 DeepLine 改为 **Linely**（页面标题、登录页、管理后台、PWA 名称、备份文件名 `Linely-backup.zip` 等）。旧版 DeepLine 备份 ZIP 仍可恢复。
- 环境变量改为 `LINELY_ADMIN_PASSWORD`、`LINELY_DATA_DIR`、`LINELY_FREE_API_KEY`、`LINELY_FREE_API_PROVIDER`、`LINELY_FREE_API_MODEL`、`LINELY_FREE_API_BASE_URL`、`LINELY_MEME_SEARCH`。**旧的 `DEEPLINE_*` 名称依然有效**（新名称优先），所以已部署的 Render 服务无需改动环境变量即可继续运行。
- 为了不让老用户丢失浏览器里已保存的聊天数据，浏览器内部数据库名仍保持 `deepline-web`，对用户不可见。
- `render.yaml` 里的服务名改为 `linely-web`：如果你用 Blueprint 重新同步，Render 会把它当作新服务；只想更新代码的话，直接把新代码推到原来的服务即可。

## 更自然的语音（朗读 / 通话）
- 默认改用**云端自然音色**：服务器通过 Microsoft Edge「朗读」同款神经网络语音合成（晓晓、晓伊、云希、云健、云扬……，另有粤语 / 台湾腔 / 日语 / 英语 / 韩语），浏览器只播放 mp3，听感接近真人，不再是设备自带的机械音。默认按角色性别自动选声音（女 → 晓晓，男 → 云希），也可在「声音」里自选。
- 逐句合成并**提前预取下一句**，句与句之间连贯；语气预设（温柔 / 活泼 / 沉稳 / 甜美 / 少年 / 播音）在支持的声音上会使用对应的说话风格，并且音调、语速的变化幅度调得更克制，避免「变声器」感。
- 云端连不上时自动回退到设备语音，并且会在设备已安装的声音里**优先挑最好听的**（Online / Natural / Premium / Siri / Google 等）。「声音」里也可以手动切到「设备语音」。
- 环境变量 `LINELY_TTS=0` 可关闭云端语音。需要 Node 22+（`package.json` 与 `render.yaml` 已更新）。
- 说明：这是微软 Edge 的免费朗读服务（非官方公开 API），服务器需要能访问 `speech.platform.bing.com`；如果微软调整接口，云端会自动回退到设备语音，不会影响聊天与通话。


## 数据库（PostgreSQL / Render）
- **所有服务端数据都存进 SQL 数据库**：账号与登录会话、激活码、公告与已读状态、验证码、主题广场、人设广场、角色图鉴（含头像）、免费 API 配置、访问统计。不再使用 `users.json` 之类的文件。
- **在 Render 上**：用仓库里的 `render.yaml` 创建 Blueprint，会同时创建 Web 服务和名为 `linely-db` 的托管 PostgreSQL，并自动把连接串写入环境变量 `DATABASE_URL`。已有服务的话：Render 控制台新建 PostgreSQL → 复制 *Internal Database URL* → 填到 Web 服务的 `DATABASE_URL`。注意 Render 免费版 PostgreSQL 30 天后会过期，正式使用请选付费套餐（`render.yaml` 里默认 `basic-256mb`），或用 Neon / Supabase 等任意 PostgreSQL，把连接串填到 `DATABASE_URL` 即可。
- **没有设置 `DATABASE_URL` 时**自动使用 SQLite（文件在 `<LINELY_DATA_DIR>/linely.db`，用于本地开发/测试）。如果在 Render 上误用了 SQLite，启动日志和管理后台「概览」都会给出警告（Render 免费版磁盘每次部署都会清空）。
- **从旧版升级自动导入**：首次启动时，如果数据目录里还有旧的 `users.json`、`themes.json`、`gallery.json`、`persona-plaza.json`、`metrics.json`、`admin-config.json`，会一次性导入数据库（用户密码哈希原样保留，旧用户可继续用原密码登录；旧公告会变成一条置顶公告）。导入只做一次。
- 依赖：`pg`（`npm install` 会自动安装）；需要 Node 22+。`LINELY_DB_SSL=1/0` 可强制开启/关闭数据库 SSL（默认对 render.com / neon / supabase 的外部连接串自动开启）。

## 登录与注册验证
- 新的登录 / 注册界面（玻璃卡片、登录注册滑动切换、密码显隐与强度提示、深色模式）。
- **图片验证码**：登录和注册都要输入。验证码由服务器生成（5 个字符、扭曲加噪点），5 分钟有效，**一次性**（输错也会作废，必须换新图），答案保存在数据库。另有隐藏蜜罐字段拦截简单机器人。
- 防暴力破解：同一账号连续输错密码 5 次锁定 15 分钟；同一 IP 登录 20 次/分钟、注册 8 次/小时、刷新验证码 40 次/分钟的限流。密码用 scrypt 加盐哈希，登录会话 token 在数据库里只存 SHA-256 摘要。

## 免费 API 上锁 + 激活码
- 免费 API 不再对所有人开放：未解锁时，创建 AI 页面里的免费 API 按钮显示为 **🔒 锁图标**（点击弹出激活码输入框）。**服务端同样校验**，没有解锁的账号即使手动构造请求也会收到 403。
- **「我的」→「激活码 · 免费 API」**：输入激活码兑换，显示解锁状态和到期时间；多次兑换时长会累加，永久码优先。
- **管理后台 → 兑换码**：批量生成（一次最多 500 个，可设解锁时长：永久 / 1 / 7 / 30 / 90 / 365 天，可命名批次），一键复制 / 下载 TXT；批次列表显示使用进度，可查看每个码被谁在何时使用、导出 CSV、删除未使用的码（已使用的记录保留）。码格式 `XXXX-XXXX-XXXX-XXXX`，使用安全字符集（无 0/O/1/I/L），兑换时不区分大小写和分隔符，兑换尝试有频率限制。
- 管理后台 → 用户：可查看每个用户的免费 API 状态，手动开通 / 撤销。

## 公告（重做）
- 管理后台 → 公告：可发布多条公告，支持 **类型**（通知 / 好消息 / 提醒 / 重要）、**置顶**、草稿/撤回、**截止日期**，显示已读人数。
- 用户端：新公告会在顶部以玻璃卡片弹出；信息页右上角 **铃铛** 带未读数，点开是上滑的公告列表（按类型着色、可展开长文、链接可点击、全部已读）；「我的」页也有入口。已读状态按用户保存在数据库，换设备也同步。
