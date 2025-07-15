const express = require('express');
const axios = require('axios');

const app = express();
const PORT = 3000;

const OPENROUTER_API_KEY = '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';
const WHATSAPP_TOKEN = 'EAAYjllIwwY8BPAzbhtVpAt38WZAaAyyF1ZBZBT6HcQvySZAaWJWeAO8MragaqFM2ZCj8GockmG626OqLmgbOcW0wbJdLxiZBUt0yMDE9enTF19P9hfKZAGtZCmMfPD2z77DutBAV3wzQGdemj8ZADoqNgw4hAuOp43SDkqyXTI5xmKNQ5i89GGCI5Juu4Tm4g6ObJjxRK2z0CzwI0Nopm8VqdBAAjOtZBWKqQVr6nYzCVsbsRMMYyOdL41E5YEvyIZD';
const PHONE_NUMBER_ID = '744565088732711';

const VERIFY_TOKEN = 'miverificacion123';

app.use(express.json());

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

app.post('/webhook', async (req, res) => {
  console.log('📥 WEBHOOK RECIBIDO');
  const body = req.body;

  if (body.object) {
    if (body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages &&
        body.entry[0].changes[0].value.messages[0]) {
      
      const message = body.entry[0].changes[0].value.messages[0];
      const text = message.text.body;
      const from = message.from;

      console.log(`💬 Mensaje de ${from}: ${text}`);

      try {
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
        console.error('❌ ERROR enviando mensaje:', error);
      }

      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
