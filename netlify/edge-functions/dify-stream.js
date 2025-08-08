// Netlify Edge Function - stream proxy for Dify SSE

export default async (request, context) => {
  const DIFY_BASE_URL = context.env?.DIFY_BASE_URL || 'https://pro.aifunbox.com/v1';
  const DIFY_API_KEY = context.env?.DIFY_API_KEY;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query } = await request.json();
    if (!query) {
      return new Response(JSON.stringify({ error: '缺少 query 字段' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    if (!DIFY_API_KEY) {
      return new Response(JSON.stringify({ error: '未配置 DIFY_API_KEY' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    const upstream = await fetch(`${DIFY_BASE_URL}/chat-messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, user: 'web-user', response_mode: 'streaming' })
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return new Response(JSON.stringify({ error: '上游响应失败', detail: text }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    return new Response(upstream.body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders } });
  } catch (err) {
    return new Response(JSON.stringify({ error: '代理错误', detail: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};


