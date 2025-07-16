const express = require('express');
const axios = require('axios');

const app = express();

// ✅ Usa el puerto que asigna Railway, o 3000 si corres local
const PORT = process.env.PORT || 3000;

// 🔑 Variables de entorno
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const DESTINO = process.env.DESTINO;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

app.use(express.json());

// 👉 Verificación del webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFICADO ✅');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 👉 Recepción de mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
  console.log('📥 WEBHOOK RECIBIDO');
  const body = req.body;

  if (body.object) {
    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const text = message.text.body;
      const from = message.from;

      console.log(`💬 Mensaje de ${from}: ${text}`);

      try {
        // 🔄 Consulta a OpenRouter
        const respuesta = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'moonshotai/kimi-k2:free',
            messages: [
              {
                role: 'system',
                content: 'Eres un bot amable que responde de forma sencilla.'
              },
              {
                role: 'user',
                content: text
              }
            ]
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );

        const respuestaBot = respuesta.data.choices[0].message.content;
        console.log('🤖 Respuesta del bot:', respuestaBot);

        // 🔄 Envía la respuesta a WhatsApp
        await axios.post(
          `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: { body: respuestaBot }
          },
          {
            headers: {
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log('✅ Mensaje enviado a WhatsApp');
      } catch (error) {
        console.error('❌ ERROR enviando mensaje:', error.response?.data || error.message);
      }

      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } else {
    res.sendStatus(404);
  }
});

// ✅ Servidor escuchando
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
