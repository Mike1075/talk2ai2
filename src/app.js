import { VAD } from '@ricky0123/vad-web';

// DOM refs
const talkButton = document.getElementById('talkButton');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript');
const aiResponseDiv = document.getElementById('aiResponse');

// State
let state = 'IDLE'; // IDLE, LISTENING, THINKING, SPEAKING
let audioContext;
let currentAISpeechSource = null;
let sentenceQueue = [];
let isPlaying = false;
let textBuffer = '';
let vad;

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
    transcriptDiv.textContent = `用户说: ${userInput}`;
    state = 'THINKING';
    statusDiv.textContent = '状态: 思考中...';
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

function handleInterrupt() {
  if (currentAISpeechSource) {
    try { currentAISpeechSource.stop(); } catch {}
    currentAISpeechSource.disconnect();
    currentAISpeechSource = null;
  }
  sentenceQueue = [];
  isPlaying = false;
}

async function callDifyStreamingAPI(query) {
  aiResponseDiv.textContent = 'AI说: ';
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
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  state = 'SPEAKING';
  statusDiv.textContent = '状态: AI正在说话...';

  const sentenceEndings = /[.!?。！？]/;

  const handleText = (text) => {
    if (!text) return;
    aiResponseDiv.textContent += text;
    textBuffer += text;
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
  }
}

async function playSentenceQueue() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (sentenceQueue.length === 0) {
    isPlaying = false;
    if (state === 'SPEAKING') {
      state = 'IDLE';
      statusDiv.textContent = '状态: 空闲';
    }
    return;
  }
  isPlaying = true;
  const sentence = sentenceQueue.shift();

  try {
    // 调用后端 Azure TTS 合成句子
    const ttsResp = await fetch('/.netlify/functions/azure-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sentence })
    });
    if (!ttsResp.ok) throw new Error('TTS 请求失败');
    const arrayBuffer = await ttsResp.arrayBuffer();
    const buffer = await audioContext.decodeAudioData(arrayBuffer);
    if (state !== 'SPEAKING') return; // 被打断
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
    currentAISpeechSource = source;
    source.onended = () => {
      currentAISpeechSource = null;
      playSentenceQueue();
    };
  } catch (err) {
    console.error(err);
    isPlaying = false;
  }
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 立即停止以释放设备，VAD 内部会再次获取
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) {
    console.error('麦克风权限被拒绝或不可用:', e);
    return false;
  }
}

talkButton.addEventListener('click', async () => {
  if (state === 'IDLE' || !vad?.isRunning) {
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
      talkButton.textContent = '结束对话';
      statusDiv.textContent = '状态: 空闲 (正在监听)';
    } catch (err) {
      console.error('VAD 初始化/启动失败:', err);
      // Fallback：不依赖 VAD，直接开始 STT 流程，保证可用
      if (recognition) {
        state = 'LISTENING';
        statusDiv.textContent = '状态: 聆听中...(简化模式)';
        try { recognition.start(); } catch {}
        talkButton.textContent = '结束对话';
      } else {
        statusDiv.textContent = '状态: 启动录音失败，建议使用最新 Chrome 浏览器';
      }
    }
  } else {
    try { await vad.pause(); } catch {}
    handleInterrupt();
    state = 'IDLE';
    talkButton.textContent = '开始对话';
    statusDiv.textContent = '状态: 已停止';
  }
});


