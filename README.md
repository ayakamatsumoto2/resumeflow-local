# 榫卯简历 · ResumeFLOW 本地版（resumeflow-local）

纯本地运行的简历工具：简历编辑、多份简历管理、经历库、AI 助手、JD 匹配分析、PDF 导出、数据备份。
不需要登录，不需要服务器，所有数据只保存在你自己的电脑上；AI 功能使用你自己填写的 DeepSeek（或其他兼容 OpenAI 接口）的 API Key。

> 本项目基于 **CMFHF** 的开源项目 [ResumeFLOW](https://github.com/CMFHF-404/ResumeFLOW) 修改，
> 按原项目的 **GNU AGPL-3.0-or-later** 许可发布（见 [LICENSE](LICENSE)）。
> 原项目说明保留在 [README.upstream.md](README.upstream.md)。
> 修改者：万象更新技术实验室。

## 使用

```bash
npm install
npm run dev      # 开发预览
npm run build    # 生成 dist/，可直接用任意静态服务器打开
```

Windows 桌面版：到 Releases 下载 `sunmao-resume.exe` 直接运行（需要 WebView2，Win10/11 一般自带）；
也可以自己构建：先 `npm run build`，再在 `desktop/` 里 `npm ci && npx tauri build --no-bundle`。

首次使用：点左上角头像 →「本地设置」→ 填写 API Key（默认 DeepSeek：`https://api.deepseek.com`，模型 `deepseek-chat`，深度思考 `deepseek-reasoner`）→「保存并测试连接」。

## 与原版的区别（修改声明）

依据 AGPL-3.0 第 5 条，以下列出本版本相对原项目（基于上游提交 `8e2e8f6`）的修改，详细记录见 [CHANGELOG.local.md](CHANGELOG.local.md)：

| 方面 | 原版 | 本地版 |
|---|---|---|
| 登录 | Logto 账号登录 | 无需登录，本机单用户（`local/logtoShim.tsx`） |
| 数据存储 | 后端 PostgreSQL | 浏览器 / WebView 的 IndexedDB（`local/store.ts`） |
| 后端 | Python FastAPI | 无。前端的 `/api` 请求由 `local/install.ts` 在本机拦截处理，逻辑移植自原 `backend/app` |
| AI | 服务端调用模型，按额度计费 | 前端直连用户自己配置的模型服务（`local/ai/llm.ts`）；提示词由 `tools/generate-local-prompts.py` 从原后端自动导出 |
| 简历导入 | 服务端解析 PDF / Word / 图片 | 本机提取 PDF / Word / 文本的文字后交给模型；暂不支持图片 |
| PDF 导出 | 服务端 Playwright + Chromium | 系统打印对话框「另存为 PDF」（`local/printExport.ts`） |
| 支付 / 额度 / 反馈 / 统计 / Agent API | 有 | 移除 |
| 数据备份 | — | 新增 JSON 备份导出 / 导入（本地设置） |
| 界面 | 原配色、名称「原子简历」 | 名称改为「榫卯简历」；换成万象之匣配色（`local/bansho-theme.css`）；简历预览与 PDF 保持原样 |
| 字体 | 附带 Arial、思源黑体字体文件 | 不再附带，使用系统字体 |
| 桌面版 | — | `desktop/`（Tauri 2）打包成 `sunmao-resume.exe`；可读取万象之匣的全局 AI 设置（`%APPDATA%\lab.banshou.hako\settings.json`） |

暂未移植：「六维深度评估」（原版依赖服务端多轮校验流程）。

`backend/` 目录保留原版后端代码，仅作为提示词来源与参考，本地版运行时不使用。

## 隐私

除了你主动触发的 AI 功能会把相关内容发送到你填写的模型服务之外，本程序不向任何服务器发送数据。

## 许可

GNU Affero General Public License v3.0 or later。
原作品版权归 CMFHF 所有；本地版的修改部分同样以 AGPL-3.0-or-later 发布。
如果你分发本程序（包括随其他软件一起分发），须同时提供对应的完整源代码。
