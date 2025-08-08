// Netlify Edge Function - stream proxy for Dify SSE

export default async (request, context) => {
  const DIFY_BASE_URL = (typeof Deno !== 'undefined' ? Deno.env.get('DIFY_BASE_URL') : undefined) || context.env?.DIFY_BASE_URL || 'https://pro.aifunbox.com/v1';
  const DIFY_API_KEY = (typeof Deno !== 'undefined' ? Deno.env.get('DIFY_API_KEY') : undefined) || context.env?.DIFY_API_KEY;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body;
    try { body = await request.json(); } catch {}
    const query = body?.query;
    if (!query || typeof query !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 query 字段' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    if (!DIFY_API_KEY) {
      return new Response(JSON.stringify({ error: '未配置 DIFY_API_KEY' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // Dify streaming 需要 SSE；同时不同部署的路径可能为 /chat-messages 或 /workflows/run
    const url = `${DIFY_BASE_URL}/chat-messages`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, user: 'web-user', response_mode: 'streaming' })
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return new Response(JSON.stringify({ error: '上游响应失败', status: upstream.status, detail: text }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    if (!upstream.body) {
      return new Response(JSON.stringify({ error: '上游无响应体' }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
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


