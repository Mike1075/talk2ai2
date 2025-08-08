# Talk2AI 语音助手（Dify + VAD + Azure TTS）

基于 Vite 的前端 + Netlify Edge Functions 后端代理，实现：

- 浏览器内置 STT（SpeechRecognition）
- VAD 语音活动检测，支持说话打断 AI 播放
- Dify 流式输出（SSE）解析、句子级合成
- Azure TTS 高质量中文发音

## 本地开发

1. 安装依赖：

```bash
npm i
```

2. 设置环境变量（在 Netlify 控制台设置，或使用 Netlify CLI 的 `netlify env:set`）：

- DIFY_API_KEY（来自 Dify 应用）
- DIFY_BASE_URL（可选，默认 `https://pro.aifunbox.com/v1`）
- AZURE_SPEECH_KEY
- AZURE_SPEECH_REGION（默认 `westus3`）
- AZURE_SPEECH_VOICE（默认 `zh-CN-Xiaochen:DragonHDFlashLatestNeural`）

3. 本地运行：

```bash
npm run dev
```

（若需调试 Functions，建议安装 Netlify CLI 使用 `netlify dev`）

4. 构建：

```bash
npm run build
```

## 部署到 Netlify

- 将 GitHub 仓库连接到 Netlify。
- 在 Netlify 的 Site settings -> Environment variables 设置上述环境变量。
- 构建命令 `npm run build`，发布目录 `dist`。
- Functions 与 Edge Functions 路径已在 `netlify.toml` 中配置。

## 目录结构

- `index.html`：页面结构
- `src/app.js`：前端核心逻辑（VAD + STT + Dify SSE + 句子级 TTS 播放）
- `netlify/edge-functions`：Dify 与 Azure TTS Edge 代理
- `netlify.toml`：Netlify 配置

## 注意

- 浏览器 STT 需要 HTTPS 或 localhost，并受限于浏览器兼容性（推荐 Chrome）。
- 所有密钥仅保存在服务端（Netlify 环境变量），前端不直接暴露。
