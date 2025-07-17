const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ✅ Ruta para el health check de Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Inicializa Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Variables de entorno
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Función para enviar mensajes de WhatsApp
async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Error enviando mensaje de WhatsApp:', error.response?.data || error.message);
  }
}

// Webhook para verificación (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFICADO');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook principal (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const messageData = change?.value?.messages?.[0];

    if (messageData) {
      const from = messageData.from;
      const userMessage = messageData.text?.body || '';
      let userRef = db.collection('usuarios').doc(from);
      let userDoc = await userRef.get();
      let estado = userDoc.exists ? userDoc.data().estado : 'INICIO';
      let botResponse = '';

      switch (estado) {
        case 'INICIO':
          botResponse = '¡Hola! ¿En qué puedo ayudarte hoy?';
          estado = 'MAIN_MENU';
          break;

        case 'MAIN_MENU':
          try {
            const aiResponse = await axios.post(
              'https://openrouter.ai/api/v1/chat/completions',
              {
                model: 'moonshotai/kimi-k2:free',
                messages: [{ role: 'user', content: userMessage }]
              },
              {
                headers: {
                  'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              }
            );

            botResponse = aiResponse.data.choices[0].message.content;
          } catch (error) {
            console.error('Error en la respuesta de IA:', error.response?.data || error.message);
            botResponse = 'Lo siento, no pude procesar tu solicitud. Intenta nuevamente.';
          }
          break;

        default:
          botResponse = 'No entendí tu mensaje. ¿Podrías reformularlo?';
          estado = 'MAIN_MENU';
          break;
      }

      await userRef.set({ estado }, { merge: true });
      await sendWhatsAppMessage(from, botResponse);
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Inicia el servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
