# Fly AI

> Sua ideia. Nossa inteligência.

Assistente de chat em português, com interface web e um servidor Node.js que conversa com modelos da [NVIDIA NIM](https://build.nvidia.com/). Não precisa instalar pacotes: só Node.js 18 ou mais novo.

## Publicar no Render (passo a passo)

O repositório já tem um `render.yaml`, então o Render configura quase tudo sozinho.

1. Crie uma conta em [render.com](https://render.com) e conecte ao seu GitHub.
2. No Render, clique em **New +** e depois em **Blueprint**.
3. Escolha este repositório. O Render lê o `render.yaml` e mostra o serviço `fly-ai`.
4. Ele vai pedir o valor de **`NVIDIA_API_KEY`**: cole a sua chave da NVIDIA (começa com `nvapi-`).
5. Clique em **Apply**. Quando terminar, o site fica em `https://fly-ai-xxxx.onrender.com`.

Pelo botão (troque `SEU-USUARIO/SEU-REPOSITORIO` pelo endereço do seu repositório):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/SEU-USUARIO/SEU-REPOSITORIO)

Depois de conectado, cada `git push` na branch principal atualiza o site automaticamente.

**Se o site abrir mas a IA não responder:** no painel do Render, vá em *Environment* e confira se `NVIDIA_API_KEY` está preenchida. Depois de salvar, o Render reinicia o serviço.

### Sobre o plano grátis

- O Render costuma pausar serviços gratuitos depois de um tempo sem acesso. O primeiro acesso depois da pausa demora mais para abrir.
- A chave da NVIDIA é **uma só**, a sua. Todos os visitantes dividem a cota dela, e os endpoints gratuitos têm limites. Confira os limites na sua conta NVIDIA.
- O servidor limita cada visitante a 20 mensagens por minuto (ajuste com `FLY_RATE_LIMIT_PER_MIN`).

## Rodar no seu computador

1. Copie `.env.example` para `.env` e preencha `NVIDIA_API_KEY=` com a sua chave.
2. Abra um terminal na pasta e rode `npm start`.
3. Abra `http://localhost:3000`.

Para conferir se a chave foi lida, abra `http://localhost:3000/api/status`: deve aparecer `"connected":true`.

## Variáveis de ambiente

| Variável | Para que serve | Padrão |
| --- | --- | --- |
| `NVIDIA_API_KEY` | Chave da NVIDIA (**obrigatória**, segredo) | — |
| `FLY_MODEL_FAST` | Modelo do modo Rápido | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| `FLY_MODEL_PRO` | Modelo do modo Pro | `nvidia/nemotron-3-ultra-550b-a55b` |
| `FLY_API_BASE_URL` | Endereço da API (aceita OpenRouter e outras compatíveis) | `https://integrate.api.nvidia.com/v1` |
| `FLY_SYSTEM_PROMPT` | Instruções e personalidade do Fly AI | assistente em português |
| `FLY_FIRST_BYTE_TIMEOUT_MS` | Espera máxima até o provedor mandar o **primeiro** dado (fila do plano grátis, modelo começando a pensar) | `180000` |
| `FLY_IDLE_TIMEOUT_MS` | Tempo sem receber dados do provedor **no meio** da resposta antes de desistir | `90000` |
| `FLY_TIMEOUT_MS` | Teto total de uma resposta | `300000` |
| `FLY_RATE_LIMIT_PER_MIN` | Mensagens por minuto por visitante | `20` |
| `TRUST_PROXY` | Usa o IP real do visitante atrás de proxy (já ligado no `render.yaml`) | desligado |
| `NVIDIA_API_KEY_FILE` | Lê a chave de um arquivo local em vez do `.env`. Se não for definida, o servidor procura em `NVIDIA_KEY_APi.env/NVIDIA_KEY_API.txt` | — |

Se aparecer "modelo não encontrado", confira o nome exato do modelo em [build.nvidia.com](https://build.nvidia.com/).

## Se aparecer um erro

O Fly AI diz qual foi o problema. Cada mensagem aponta para um lugar diferente:

| Mensagem | O que significa | O que fazer |
| --- | --- | --- |
| "A NVIDIA recusou a chave (erro 401/403)" | **Autenticação**: a chave está errada, vencida ou desativada. Não é lentidão. | Gere outra em [build.nvidia.com](https://build.nvidia.com/) e troque em `.env` (local) ou em *Environment* (Render). |
| "O limite do provedor foi atingido" (429) | A cota gratuita acabou por agora. | Espere um pouco ou use o modo Rápido. |
| "O provedor não começou a responder a tempo" | Fila cheia ou modelo ocupado antes da 1ª palavra. | Tente de novo, use o modo Rápido ou aumente `FLY_FIRST_BYTE_TIMEOUT_MS`. |
| "O provedor parou de enviar a resposta no meio" | A resposta travou depois de começar. | Tente de novo ou aumente `FLY_IDLE_TIMEOUT_MS`. |
| "A resposta passou do tempo máximo" | Resposta longa demais. | Pergunta mais curta, modo Rápido ou `FLY_TIMEOUT_MS` maior. |
| "Não foi possível conectar ao provedor" | Falha de rede do servidor. | Confira a internet/hospedagem. |

### Erro 401 no Render: como descobrir o motivo

1. Abra `https://SEU-SITE.onrender.com/api/status` e olhe o campo `keyFormat`:
   - `"ausente"`: o Render não recebeu a chave. Preencha `NVIDIA_API_KEY` em *Environment*.
   - `"suspeito"`: a chave **não começa com `nvapi-`**. Provavelmente é de outro serviço (como o OpenRouter) ou foi colada errada. Use uma chave da NVIDIA.
   - `"ok"`: o formato está certo. Se ainda dá 401, a chave expirou ou foi revogada: gere outra em [build.nvidia.com](https://build.nvidia.com/).
2. No painel do Render, em *Environment*, cole **só a chave** em `NVIDIA_API_KEY` (sem aspas e sem o nome da variável) e salve. O Render reinicia sozinho.
3. Em *Logs*, procure a linha `[Fly AI] Formato da chave:` (mostra só o formato e o tamanho, nunca a chave).

O servidor já remove espaços, quebras de linha, aspas, `Bearer ` e `NVIDIA_API_KEY=` que sobrarem ao colar a chave.

## Segurança

- **A chave nunca vai para o navegador.** Ela fica só no servidor (variável de ambiente do Render ou `.env` local).
- **Nunca publique o `.env` no GitHub.** O `.gitignore` já o exclui. Se uma chave vazar, gere outra no site da NVIDIA.
- O servidor limita mensagens por visitante, aplica tempo limite nas chamadas e envia ao modelo só as últimas 30 mensagens da conversa.
- Não envie dados pessoais ou confidenciais sem revisar as condições do endpoint gratuito.

## Recursos

- Conversas salvas no navegador (não sincronizam entre dispositivos), nova conversa e limpeza do histórico.
- Dois modos: Rápido e Pro.
- A resposta aparece **aos poucos**, enquanto o modelo escreve, e o botão vermelho **Parar** (ou a tecla Esc) cancela a geração e a chamada ao provedor. Trocar de conversa também cancela.
- Tema claro, escuro ou automático.
- Ditado por voz e leitura das respostas, quando o navegador permite.
- Ainda não tem: conta de usuário e análise ou geração de imagem.
