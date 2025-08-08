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
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
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
    body: JSON.stringify({ query })
  });

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

talkButton.addEventListener('click', async () => {
  if (state === 'IDLE' || !vad?.isRunning) {
    if (!vad) await initializeVAD();
    await vad.start();
    talkButton.textContent = '结束对话';
    statusDiv.textContent = '状态: 空闲 (正在监听)';
  } else {
    try { await vad.pause(); } catch {}
    handleInterrupt();
    state = 'IDLE';
    talkButton.textContent = '开始对话';
    statusDiv.textContent = '状态: 已停止';
  }
});


