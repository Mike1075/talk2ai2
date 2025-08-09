import { VAD } from '@ricky0123/vad-web';

// DOM refs
const talkButton = document.getElementById('talkButton');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript');
const aiResponseDiv = document.getElementById('aiResponse');
const messagesEl = document.getElementById('messages');

// State
let state = 'IDLE'; // IDLE, LISTENING, THINKING, SPEAKING
let audioContext;
let currentAISpeechSource = null;
let sentenceQueue = [];
let isPlaying = false;
let textBuffer = '';
let vad;
let vadIgnoreUntilMs = 0; // 在此时间点之前忽略 VAD 的 onSpeechStart（避免被自播回声误触发）

function isVadRunning() {
  if (!vad) return false;
  if (typeof vad.isRunning === 'function') {
    try { return !!vad.isRunning(); } catch { return false; }
  }
  return !!vad.isRunning;
}

// Browser STT
const SpeechRecognition = (() => {
  // 一些 macOS + iPhone 连续互通可能导致权限路由到 iPhone 麦克风，强制使用本机浏览器实现
  // 仍旧落回标准对象
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
})();
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
if (recognition) {
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  recognition.onresult = (event) => {
    const userInput = event.results[0][0].transcript;
    if (transcriptDiv) {
      transcriptDiv.textContent = `用户说: ${userInput}`;
    }
    appendUserMessage(userInput);
    state = 'THINKING';
    statusDiv.textContent = '状态: 思考中...';
  // 用户说完后，立即清空未完成播放的队列，避免上一轮残句影响
  sentenceQueue = [];
  isPlaying = false;
  if (currentAISpeechSource) {
    try { currentAISpeechSource.stop?.(); currentAISpeechSource.pause?.(); } catch {}
    currentAISpeechSource = null;
  }
    callDifyStreamingAPI(userInput);
  };
  recognition.onerror = (e) => {
    console.error('STT Error:', e);
  };
}

async function initializeVAD() {
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  vad = await VAD.create({
    onSpeechStart: () => {
      if (performance.now() < vadIgnoreUntilMs) {
        // 忽略短暂的自播回声触发
        return;
      }
      // 只在用户说话时触发中断：当处于 SPEAKING 且输入明显高于背景时
      if (state === 'SPEAKING') {
        handleInterrupt();
      }
      state = 'LISTENING';
      statusDiv.textContent = '状态: 聆听中...';
      if (recognition) {
        try { recognition.start(); } catch {}
      }
    },
    onSpeechEnd: () => {
      if (state === 'LISTENING' && recognition) {
        try { recognition.stop(); } catch {}
      }
    },
  });
}

async function ensureVADRunning() {
  try {
    if (!vad) await initializeVAD();
    if (!isVadRunning()) await vad.start();
    statusDiv.textContent = '就绪：正在监听';
  } catch (e) {
    console.warn('VAD ensure running failed:', e);
  }
}

function handleInterrupt() {
  if (currentAISpeechSource) {
    // 兼容 WebAudio BufferSource 与 <audio> 标签两种播放源
    try {
      if (typeof currentAISpeechSource.stop === 'function') {
        currentAISpeechSource.stop();
        if (typeof currentAISpeechSource.disconnect === 'function') currentAISpeechSource.disconnect();
      } else if (typeof currentAISpeechSource.pause === 'function') {
        currentAISpeechSource.pause();
        currentAISpeechSource.src = '';
      }
    } catch {}
    currentAISpeechSource = null;
  }
  sentenceQueue = [];
  // 保持 isPlaying 状态，让新一轮 Dify 到来时仍能继续队列逻辑
  isPlaying = false;
}

async function callDifyStreamingAPI(query) {
  // 新一轮响应开始，插入一条空的 AI 消息，占位后续流式内容
  appendAIMessage('');
  textBuffer = '';

  const response = await fetch('/.netlify/functions/dify-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, inputs: {}, user: 'web-user' })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('Dify 代理失败:', response.status, errText);
    aiResponseDiv.textContent = 'AI说: [请求失败] ' + errText;
    state = 'IDLE';
    statusDiv.textContent = '状态: 空闲';
    return;
  }

  const ctype = response.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    const text = await response.text().catch(() => '');
    console.warn('非 SSE 响应:', ctype, text);
    aiResponseDiv.textContent = 'AI说: [非流式响应] ' + text;
    state = 'IDLE';
    statusDiv.textContent = '状态: 空闲';
    return;
  }

  if (!response.body) {
    aiResponseDiv.textContent += '\n[错误] 无法建立流式连接';
    state = 'IDLE';
    await ensureVADRunning();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  state = 'SPEAKING';
  statusDiv.textContent = '状态: AI正在说话...';
  vadIgnoreUntilMs = performance.now() + 1200; // 刚进入说话阶段，先忽略约 1.2s 的回声

  const sentenceEndings = /[.!?。！？]/;

  const handleText = (text) => {
    if (!text) return;
    appendToLastAIMessage(text);
    textBuffer += text;
    // 若此前被中断，且这是新一轮 AI 输出，确保播放循环被恢复
    if (!isPlaying && state === 'SPEAKING' && sentenceQueue.length === 0) {
      // 不做任何事，等待句子切分触发 playSentenceQueue()
    }
    if (sentenceEndings.test(textBuffer)) {
      const pieces = textBuffer.split(/(?<=[.!?。！？])/);
      textBuffer = '';
      for (const piece of pieces) {
        if (!piece) continue;
        if (sentenceEndings.test(piece.slice(-1))) {
          sentenceQueue.push(piece.trim());
        } else {
          textBuffer += piece;
        }
      }
      if (!isPlaying) playSentenceQueue();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });

    // 解析 SSE：逐行处理 `data: {json}`
    const lines = chunk.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          // 常见字段尝试顺序：answer -> data.answer -> text
          const text = json.answer ?? json.data?.answer ?? json.text ?? '';
          handleText(text);
        } catch {
          // 不是 JSON，就按原样输出
          handleText(payload);
        }
      } else {
        // 可能是心跳/空行或其他
        continue;
      }
    }
  }

  if (textBuffer.trim()) {
    sentenceQueue.push(textBuffer.trim());
    textBuffer = '';
    if (!isPlaying) playSentenceQueue();
  } else {
    // 没有任何可播放句子，直接恢复监听
    state = 'IDLE';
    await ensureVADRunning();
  }
}

async function playSentenceQueue() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (sentenceQueue.length === 0) {
    isPlaying = false;
    state = 'IDLE';
    await ensureVADRunning();
    return;
  }
  isPlaying = true;
  const sentence = sentenceQueue.shift();
  await ensureAudioUnlocked();
  if (!sentence || !sentence.trim()) {
    return playSentenceQueue();
  }
  const cleanSentence = sanitizeForTTS(sentence);
  if (!cleanSentence) {
    return playSentenceQueue();
  }

  try {
    // 调用后端 Azure TTS 合成句子
    const ttsResp = await fetch('/.netlify/functions/azure-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleanSentence, voice: window.__PreferredVoice || undefined })
    });
    if (!ttsResp.ok) {
      const text = await ttsResp.text().catch(() => '');
      aiResponseDiv.textContent += `\n[TTS错误] ${text}`;
      isPlaying = false;
      state = 'IDLE';
      await ensureVADRunning();
      return;
    }

    const ctype = ttsResp.headers.get('content-type') || '';
    const arrayBuffer = await ttsResp.arrayBuffer();
    if (ctype.includes('audio')) {
      try {
        const buffer = await audioContext.decodeAudioData(arrayBuffer);
        if (state !== 'SPEAKING') return; // 被打断
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start(0);
        currentAISpeechSource = source;
        vadIgnoreUntilMs = performance.now() + 1200; // 每次开始新句播放，忽略短暂回声
    source.onended = async () => {
      currentAISpeechSource = null;
      // 若队列已空，自动恢复监听
      if (sentenceQueue.length === 0) {
        state = 'IDLE';
        await ensureVADRunning();
      }
      playSentenceQueue();
    };
      } catch (e) {
        // 解码失败，降级使用 <audio> 播放
        const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAISpeechSource = audio;
        audio.onended = async () => {
          URL.revokeObjectURL(url);
          currentAISpeechSource = null;
          if (sentenceQueue.length === 0) {
            state = 'IDLE';
            await ensureVADRunning();
          }
          playSentenceQueue();
        };
        try { await audio.play(); } catch (err) {
          aiResponseDiv.textContent += `\n[TTS播放失败] ${String(err)}`;
          isPlaying = false;
        }
      }
    } else {
      // 返回了非音频（通常是错误 JSON）
      const text = new TextDecoder().decode(arrayBuffer);
      aiResponseDiv.textContent += `\n[TTS错误-非音频] ${text}`;
      isPlaying = false;
      state = 'IDLE';
      await ensureVADRunning();
    }
  } catch (err) {
    console.error(err);
    isPlaying = false;
    state = 'IDLE';
    await ensureVADRunning();
  }
}

// 过滤表情符号与不可读字符，避免被 TTS 读出来
function sanitizeForTTS(text) {
  if (!text) return '';
  // 移除常见 Emoji、区域旗帜、肤色修饰符、变体选择符、ZWJ 组合符
  const emojiRegex = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0E}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;
  let out = text.replace(emojiRegex, '');
  // 去掉多余 Markdown 修饰符，避免读出符号
  out = out.replace(/[\*`_#>\[\]]+/g, ' ');
  // 折叠空白
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

async function ensureAudioUnlocked() {
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch {}
  }
}

async function requestMicPermission() {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    // 立即停止以释放设备，VAD 内部会再次获取
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) {
    console.error('麦克风权限被拒绝或不可用:', e);
    return false;
  }
}

// --- 聊天渲染 + 本地存储 ---
function scrollToBottom() {
  if (!messagesEl) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function saveHistory() {
  if (!messagesEl) return;
  const data = Array.from(messagesEl.querySelectorAll('.msg')).map(div => ({
    role: div.classList.contains('user') ? 'user' : 'ai',
    content: div.textContent || ''
  }));
  try { localStorage.setItem('talk2ai_history', JSON.stringify(data)); } catch {}
}

function loadHistory() {
  if (!messagesEl) return;
  const raw = localStorage.getItem('talk2ai_history');
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    messagesEl.innerHTML = '';
    for (const m of data) {
      const div = document.createElement('div');
      div.className = `msg ${m.role === 'user' ? 'user' : 'ai'}`;
      div.textContent = m.content || '';
      messagesEl.appendChild(div);
    }
    scrollToBottom();
  } catch {}
}

function appendUserMessage(text) {
  if (!messagesEl || !text) return;
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  messagesEl.appendChild(div);
  saveHistory();
  scrollToBottom();
}

function appendAIMessage(initialText) {
  if (!messagesEl) return;
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.textContent = initialText || '';
  messagesEl.appendChild(div);
  saveHistory();
  scrollToBottom();
}

function appendToLastAIMessage(text) {
  if (!messagesEl) return;
  let last = messagesEl.querySelector('.msg.ai:last-of-type');
  if (!last) {
    appendAIMessage('');
    last = messagesEl.querySelector('.msg.ai:last-of-type');
  }
  last.textContent += text;
  saveHistory();
  scrollToBottom();
}

function updateLastAIMessage(text) {
  if (!messagesEl) return;
  const last = messagesEl.querySelector('.msg.ai:last-of-type');
  if (last) {
    last.textContent = text;
    saveHistory();
  }
}

// 页面加载时恢复历史
loadHistory();

talkButton.addEventListener('click', async () => {
  if (state === 'IDLE' || !isVadRunning()) {
    // 浏览器能力检测
    if (!navigator.mediaDevices?.getUserMedia) {
      statusDiv.textContent = '状态: 当前浏览器不支持麦克风接口，请使用最新 Chrome';
      return;
    }
    if (!recognition) {
      statusDiv.textContent = '状态: 当前浏览器不支持语音识别（SpeechRecognition），请使用最新 Chrome';
      // 仍可尝试初始化 VAD 以验证权限
    }

    await ensureAudioUnlocked();
    const permitted = await requestMicPermission();
    if (!permitted) {
      statusDiv.textContent = '状态: 未授予麦克风权限';
      return;
    }

    try {
      if (!vad) await initializeVAD();
      await vad.start();
      talkButton.textContent = '⏹️';
      statusDiv.textContent = '就绪：正在监听';
    } catch (err) {
      console.error('VAD 初始化/启动失败:', err);
      // Fallback：不依赖 VAD，直接开始 STT 流程，保证可用
      if (recognition) {
        state = 'LISTENING';
        statusDiv.textContent = '聆听中...(简化模式)';
        try { recognition.start(); } catch {}
        talkButton.textContent = '⏹️';
      } else {
        statusDiv.textContent = '状态: 启动录音失败，建议使用最新 Chrome 浏览器';
      }
    }
  } else {
    try { await vad.pause(); } catch {}
    handleInterrupt();
    state = 'IDLE';
    talkButton.textContent = '🎙️';
    statusDiv.textContent = '状态: 已停止';
  }
});


