// Netlify Edge Function - Azure TTS proxy

export default async (request, context) => {
  const AZURE_SPEECH_KEY = context.env?.AZURE_SPEECH_KEY;
  const AZURE_SPEECH_REGION = context.env?.AZURE_SPEECH_REGION || 'westus3';
  const VOICE = context.env?.AZURE_SPEECH_VOICE || 'zh-CN-Xiaochen:DragonHDFlashLatestNeural';

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }
  try {
    if (!AZURE_SPEECH_KEY) {
      return new Response(JSON.stringify({ error: '未配置 AZURE_SPEECH_KEY' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    const { text } = await request.json();
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 text 字段' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    const ssml = `<?xml version="1.0" encoding="utf-8"?>\n<speak version="1.0" xml:lang="zh-CN">\n  <voice name="${VOICE}">\n    ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n  </voice>\n</speak>`;

    const ttsUrl = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const upstream = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
      },
      body: ssml
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return new Response(JSON.stringify({ error: 'Azure TTS 请求失败', detail }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    return new Response(upstream.body, { headers: { 'Content-Type': 'audio/mpeg', ...corsHeaders } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'TTS 代理异常', detail: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};


