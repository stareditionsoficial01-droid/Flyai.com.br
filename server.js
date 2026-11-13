const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
// Carrega segredos locais do .env sem dependências. Variáveis de ambiente têm prioridade.
try {
  const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const apiBaseUrl = process.env.FLY_API_BASE_URL || 'https://integrate.api.nvidia.com/v1';
// A chave vem de NVIDIA_API_KEY (variável de ambiente ou .env) ou, se não houver, de um arquivo de texto local.
// O arquivo é procurado no caminho de NVIDIA_API_KEY_FILE e, se não der, nos nomes usados neste projeto.
const keyFileCandidates = [
  process.env.NVIDIA_API_KEY_FILE,
  path.join('NVIDIA_KEY_APi.env', 'NVIDIA_KEY_API.txt'),
  path.join('NVIDIA_KEY_APi.env', 'Novo Documento de Texto.txt')
].filter(Boolean);
let keyFileFound = '';
// Chaves coladas em painéis costumam vir com lixo: espaços, quebra de linha, aspas, "Bearer " ou "NVIDIA_API_KEY=".
function cleanKey(raw) {
  return String(raw ?? '')
    .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
    .replace(/^(?:NVIDIA_API_KEY|NVIDIA_KEY_API|FLY_API_KEY)=/i, '')
    .replace(/^bearer/i, '')
    .replace(/^(['"])(.*)\1$/, '$2');
}
function loadApiKey() {
  const directKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_KEY_API || process.env.FLY_API_KEY;
  if (directKey && cleanKey(directKey)) return cleanKey(directKey);
  for (const candidate of keyFileCandidates) {
    try {
      const fileContent = fs.readFileSync(path.resolve(root, candidate), 'utf8').trim();
      const assignment = fileContent.match(/^(?:NVIDIA_API_KEY|NVIDIA_KEY_API|FLY_API_KEY)\s*=\s*(.*?)\s*$/m);
      const key = cleanKey(assignment ? assignment[1] : fileContent);
      if (key) { keyFileFound = candidate; return key; }
    } catch {}
  }
  return '';
}
const apiKey = loadApiKey();
// 'ok' = parece chave da NVIDIA (nvapi-...); 'suspeito' = outro formato (ex.: chave do OpenRouter); 'ausente' = sem chave.
function keyFormat() {
  if (!apiKey) return 'ausente';
  let nvidia = true; try { nvidia = /(^|\.)nvidia\.com$/i.test(new URL(apiBaseUrl).hostname); } catch {}
  if (!nvidia) return 'nao-verificado';
  return apiKey.startsWith('nvapi-') ? 'ok' : 'suspeito';
}
const models = {
  fast: process.env.FLY_MODEL_FAST || 'nvidia/nemotron-3.5-lightning-30b-a3b',
  pro: process.env.FLY_MODEL_PRO || 'nvidia/nemotron-3-ultra-550b-a55b'
};
const systemPrompt = process.env.FLY_SYSTEM_PROMPT ||
  'Você é o Fly AI, um assistente simpático e direto. Responda sempre no idioma do usuário (por padrão, português do Brasil), de forma clara e útil. Não invente fatos; se não souber, diga.';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const publicFiles = ['index.html', 'styles.css', 'app.js'];
const maxBody = 2 * 1024 * 1024;
// Timeout por inatividade (sem receber dados do provedor) e teto total. Configuráveis no .env.
const idleTimeoutMs = Number(process.env.FLY_IDLE_TIMEOUT_MS) || 90_000;
const totalTimeoutMs = Number(process.env.FLY_TIMEOUT_MS) || 300_000;
// Espera máxima até o provedor mandar o PRIMEIRO dado (fila do plano grátis / modelo grande começando a pensar).
const firstByteTimeoutMs = Number(process.env.FLY_FIRST_BYTE_TIMEOUT_MS) || 180_000;

// Limite simples por IP para a chave do servidor não ser esgotada por abuso.
// Atrás de proxy/hospedagem, todos podem aparecer com o mesmo IP: ajuste se for publicar.
const rateLimit = { windowMs: 60_000, max: Number(process.env.FLY_RATE_LIMIT_PER_MIN) || 20, hits: new Map() };
// Em hospedagens com proxy (como o Render), o IP da conexão é o do proxy. Com TRUST_PROXY=true usamos
// o True-Client-IP, que o Render preenche com o IP real. Não confiamos no X-Forwarded-For (falsificável).
const trustProxy = process.env.TRUST_PROXY === 'true';
function clientIp(req) {
  const header = req.headers['true-client-ip'];
  if (trustProxy && typeof header === 'string' && header.trim()) return header.trim();
  return req.socket.remoteAddress || 'unknown';
}
function limited(ip) {
  const now = Date.now();
  const recent = (rateLimit.hits.get(ip) || []).filter(t => now - t < rateLimit.windowMs);
  recent.push(now);
  rateLimit.hits.set(ip, recent);
  return recent.length > rateLimit.max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of rateLimit.hits) if (!ts.some(t => now - t < rateLimit.windowMs)) rateLimit.hits.delete(ip);
}, 5 * 60_000).unref();

// Nunca deixa a chave aparecer em logs nem em mensagens devolvidas ao navegador.
function redact(text) {
  let out = String(text ?? '').replace(/nvapi-[A-Za-z0-9_-]+/g, '[chave]');
  if (apiKey && apiKey.length > 8) out = out.split(apiKey).join('[chave]');
  return out;
}

function json(res, status, value) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBody) { reject(Object.assign(new Error('too large'), { code: 413 })); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Normaliza o histórico: só user/assistant, começa por "user", sem papéis repetidos em sequência.
function cleanMessages(list) {
  const out = [];
  for (const m of list.slice(-30)) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = String((m && m.content) ?? '').slice(0, 12000).trim();
    if (!content) continue;
    if (out.length === 0 && role === 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else out.push({ role, content });
  }
  return out;
}

// Esconde o raciocínio interno (<think>…</think>) durante o streaming, mesmo com a tag dividida entre pedaços.
function makeThinkFilter() {
  let inThink = false, buf = '';
  const partial = (text, tag) => { for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) if (text.endsWith(tag.slice(0, k))) return k; return 0; };
  return {
    push(text) {
      buf += text; let out = '';
      for (;;) {
        if (inThink) {
          const end = buf.indexOf('</think>');
          if (end === -1) { buf = buf.slice(-7); return out; }
          buf = buf.slice(end + 8); inThink = false;
        } else {
          const start = buf.indexOf('<think>');
          if (start === -1) { const keep = partial(buf, '<think>'); out += buf.slice(0, buf.length - keep); buf = buf.slice(buf.length - keep); return out; }
          out += buf.slice(0, start); buf = buf.slice(start + 7); inThink = true;
        }
      }
    },
    flush() { const rest = inThink ? '' : buf; buf = ''; return rest; }
  };
}

async function handleChat(req, res) {
  if (limited(clientIp(req))) return json(res, 429, { error: 'Muitas mensagens em pouco tempo. Aguarde um minuto e tente de novo.' });
  let data;
  try { data = JSON.parse(await readBody(req)); }
  catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'Mensagem grande demais.' : 'Requisição inválida.' }); }

  const mode = data.mode === 'pro' ? 'pro' : 'fast';
  const model = models[mode];
  if (!apiKey) return json(res, 503, { error: 'A chave da NVIDIA ainda não foi configurada neste projeto. Adicione NVIDIA_API_KEY ao arquivo .env (no seu computador) ou em Environment (no Render) e reinicie o Fly AI.' });
  if (!Array.isArray(data.messages)) return json(res, 400, { error: 'Conversa inválida.' });
  const messages = cleanMessages(data.messages);
  if (messages.length === 0) return json(res, 400, { error: 'Conversa inválida.' });

  // Controle de cancelamento e tempos. O relógio reinicia a cada pedaço recebido do provedor:
  // antes do primeiro dado vale FLY_FIRST_BYTE_TIMEOUT_MS; depois, FLY_IDLE_TIMEOUT_MS; e há um teto total.
  const controller = new AbortController();
  let abortReason = null, gotData = false, started = false, heartbeat;
  const cancel = reason => { abortReason = reason; controller.abort(); };
  const totalTimer = setTimeout(() => cancel('timeout-total'), totalTimeoutMs);
  let idleTimer;
  const bumpIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => cancel(gotData ? 'timeout-idle' : 'timeout-first'), gotData ? idleTimeoutMs : firstByteTimeoutMs); };
  res.on('close', () => { if (!res.writableEnded) cancel('client'); }); // navegador fechou ou o usuário clicou em Parar
  bumpIdle();

  // Respostas de sucesso vão ao navegador como eventos (SSE). Erros antes do início seguem como JSON com status HTTP.
  const emitEvent = obj => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const begin = () => {
    if (started) return; started = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.(); res.socket?.setNoDelay?.(true);
    heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 15_000); // mantém proxies abertos
  };
  const fail = (status, code, message) => {
    if (!started) return json(res, status, { error: message, code });
    emitEvent({ type: 'error', code, error: message }); res.end();
  };

  try {
    const upstream = await fetch(apiBaseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, ...messages], stream: true }),
      signal: controller.signal
    });
    bumpIdle();
    if (!upstream.ok) {
      const result = await upstream.json().catch(() => ({}));
      const detail = redact(result.error?.message || result.detail || '');
      console.error(`[Fly AI] Provedor respondeu ${upstream.status} para o modelo ${model}: ${detail}`);
      if (upstream.status === 401 || upstream.status === 403) {
        const fmt = keyFormat();
        const hint = fmt === 'suspeito' ? ' A chave que o servidor recebeu não começa com "nvapi-": provavelmente é de outro serviço (como o OpenRouter) ou foi colada errada.'
          : fmt === 'ok' ? ' O formato da chave parece certo, então ela provavelmente expirou, foi revogada ou foi copiada incompleta: gere outra em build.nvidia.com.' : '';
        return fail(upstream.status, 'auth', `A NVIDIA recusou a chave (erro ${upstream.status}).${hint} Confira NVIDIA_API_KEY: no .env (no seu computador) ou em Environment (no Render).`);
      }
      if (upstream.status === 429) return fail(429, 'rate_limit', 'O limite do provedor foi atingido. Tente de novo em instantes.');
      if (upstream.status === 404) return fail(404, 'model', `O modelo "${model}" não foi encontrado no provedor. Confira FLY_MODEL_${mode.toUpperCase()}.`);
      return fail(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, 'provider', detail || 'O provedor de IA não conseguiu responder.');
    }

    begin(); // a partir daqui o navegador já recebe a resposta aos poucos
    const filter = makeThinkFilter();
    let emitted = false;
    const emitText = text => {
      if (!text) return;
      if (!emitted) { text = text.replace(/^\s+/, ''); if (!text) return; emitted = true; }
      emitEvent({ type: 'delta', text });
    };

    if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      const decoder = new TextDecoder();
      let buffer = '';
      const readLine = rawLine => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let event; try { event = JSON.parse(payload); } catch { return; }
        if (event.error) throw Object.assign(new Error(redact(event.error.message || 'resposta interrompida')), { fromProvider: true });
        const piece = event.choices?.[0]?.delta?.content; // reasoning_content é ignorado de propósito
        if (piece) emitText(filter.push(piece));
      };
      for await (const chunk of upstream.body) {
        gotData = true; bumpIdle();
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) { readLine(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
      }
      readLine(buffer);
    } else {
      // Provedor ignorou o streaming e mandou JSON normal.
      const result = await upstream.json().catch(() => ({}));
      const text = result.choices?.[0]?.message?.content;
      if (text) emitText(filter.push(String(text)));
    }
    emitText(filter.flush());

    if (!emitted) return fail(502, 'empty', 'O provedor respondeu sem conteúdo. Tente de novo.');
    emitEvent({ type: 'done', model }); res.end();
  } catch (e) {
    if (abortReason === 'client') { if (!res.writableEnded) res.end(); return; }
    console.error('[Fly AI] Falha ao chamar o provedor:', abortReason || redact(e.message));
    if (abortReason === 'timeout-first') return fail(504, 'timeout', 'O provedor não começou a responder a tempo (fila cheia ou modelo ocupado). Tente de novo ou use o modo Rápido.');
    if (abortReason === 'timeout-idle') return fail(504, 'timeout', 'O provedor parou de enviar a resposta no meio. Tente de novo.');
    if (abortReason === 'timeout-total') return fail(504, 'timeout', 'A resposta passou do tempo máximo permitido. Tente uma pergunta mais curta ou use o modo Rápido.');
    if (e.fromProvider) return fail(502, 'provider', 'O provedor interrompeu a resposta no meio. Tente de novo.');
    if (started) return fail(502, 'network', 'A conexão com o provedor caiu no meio da resposta. Tente de novo.');
    return fail(502, 'network', 'Não foi possível conectar ao provedor de IA. Confira a conexão e a configuração do servidor.');
  } finally {
    clearTimeout(totalTimer); clearTimeout(idleTimer); clearInterval(heartbeat);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");

    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
    catch { res.writeHead(400); return res.end('Requisição inválida'); }

    if (pathname === '/api/status' && req.method === 'GET') {
      return json(res, 200, { connected: Boolean(apiKey), keyFormat: keyFormat(), provider: 'NVIDIA NIM', modes: { fast: models.fast, pro: models.pro } });
    }
    if (pathname === '/api/chat') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Use POST.' }); }
      return await handleChat(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!publicFiles.includes(file)) { res.writeHead(404); return res.end('Não encontrado'); }
    fs.readFile(path.join(root, file), (err, content) => {
      if (err) { res.writeHead(404); return res.end('Não encontrado'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  } catch (e) {
    console.error('[Fly AI] Erro inesperado:', e);
    if (!res.headersSent) { res.writeHead(500); res.end('Erro interno'); } else res.end();
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Fly AI disponível em http://localhost:${process.env.PORT || 3000}`);
  if (apiKey) console.log(`[Fly AI] Formato da chave: ${keyFormat()} (${apiKey.length} caracteres)`);
  if (apiKey) console.log(keyFileFound ? `[Fly AI] Chave da NVIDIA carregada do arquivo: ${keyFileFound}` : '[Fly AI] Chave da NVIDIA carregada das variáveis de ambiente.');
  else console.warn(`[Fly AI] ATENÇÃO: nenhuma chave da NVIDIA encontrada. Defina NVIDIA_API_KEY ou coloque o arquivo da chave em um destes caminhos: ${keyFileCandidates.join(' | ')}`);
});
