// Netlify Edge Function - Azure TTS proxy

export default async (request, context) => {
  const AZURE_SPEECH_KEY = (typeof Deno !== 'undefined' ? Deno.env.get('AZURE_SPEECH_KEY') : undefined) || context.env?.AZURE_SPEECH_KEY;
  const AZURE_SPEECH_REGION = (typeof Deno !== 'undefined' ? Deno.env.get('AZURE_SPEECH_REGION') : undefined) || context.env?.AZURE_SPEECH_REGION || 'westus3';
  const VOICE = (typeof Deno !== 'undefined' ? Deno.env.get('AZURE_SPEECH_VOICE') : undefined) || context.env?.AZURE_SPEECH_VOICE || 'zh-CN-Xiaochen:DragonHDFlashLatestNeural';

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
    const { text, voice } = await request.json();
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 text 字段' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    const ttsUrl = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const synthesize = async (voiceName) => {
      const ssml = `<?xml version="1.0" encoding="utf-8"?>\n<speak version="1.0" xml:lang="zh-CN">\n  <voice name="${voiceName}">\n    ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n  </voice>\n</speak>`;
      const resp = await fetch(ttsUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
          'Ocp-Apim-Subscription-Region': AZURE_SPEECH_REGION,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'Accept': 'audio/mpeg'
        },
        body: ssml
      });
      return resp;
    };

    // 优先使用前端传入 voice，其次环境变量 VOICE
    const primaryVoice = voice || VOICE;
    let upstream = await synthesize(primaryVoice);
    if (!upstream.ok || !upstream.body) {
      const primaryText = await upstream.text().catch(() => '');
      // 回退到通用可用的声音
      const fallbackVoice = 'zh-CN-XiaoxiaoNeural';
      const fallbackResp = await synthesize(fallbackVoice);
      if (!fallbackResp.ok || !fallbackResp.body) {
        const fallbackText = await fallbackResp.text().catch(() => '');
        return new Response(
          JSON.stringify({ error: 'Azure TTS 请求失败', detail: primaryText || fallbackText, region: AZURE_SPEECH_REGION, tried: [primaryVoice, fallbackVoice] }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      upstream = fallbackResp;
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


