// Netlify Edge Function - List available Azure TTS voices in current region

export default async (request, context) => {
  const AZURE_SPEECH_KEY = (typeof Deno !== 'undefined' ? Deno.env.get('AZURE_SPEECH_KEY') : undefined) || context.env?.AZURE_SPEECH_KEY;
  const AZURE_SPEECH_REGION = (typeof Deno !== 'undefined' ? Deno.env.get('AZURE_SPEECH_REGION') : undefined) || context.env?.AZURE_SPEECH_REGION || 'westus3';

  const url = new URL(request.url);
  const locale = url.searchParams.get('locale');
  const contains = url.searchParams.get('contains');

  if (!AZURE_SPEECH_KEY) {
    return new Response(JSON.stringify({ error: '未配置 AZURE_SPEECH_KEY' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const listUrl = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
    const resp = await fetch(listUrl, {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Ocp-Apim-Subscription-Region': AZURE_SPEECH_REGION,
        'Accept': 'application/json'
      }
    });
    const data = await resp.json();
    let voices = Array.isArray(data) ? data : [];
    if (locale) voices = voices.filter(v => v.Locale?.toLowerCase() === locale.toLowerCase());
    if (contains) voices = voices.filter(v => `${v.ShortName}`.toLowerCase().includes(contains.toLowerCase()));
    return new Response(JSON.stringify({ region: AZURE_SPEECH_REGION, count: voices.length, voices }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: '获取语音列表失败', detail: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};


