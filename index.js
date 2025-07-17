const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// ✅ Ruta para el health check de Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// --- CONFIGURACIÓN FIREBASE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- CONFIGURACIÓN GENERAL ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 8080;

// --- SIMULACIÓN SAP ---
const simulatedSapConfig = {
  DocumentType: 'TA',
  SalesOrganization: '1000',
  DistributionChannel: '10',
  Division: '00',
  OrderType: 'OR'
};

async function simulateGetCustomerDetails(phone) {
  return {
    SoldToParty: '123456',
    name: 'Cliente Demo',
    SalesOrganization: '1000'
  };
}

// --- FUNCIONES DE ESTADO ---
async function getUserState(phone) {
  const doc = await db.collection('states').doc(phone).get();
  return doc.exists ? doc.data() : { status: 'IDLE', data: {} };
}

async function setUserState(phone, status, data) {
  await db.collection('states').doc(phone).set({ status, data });
}

// --- ENVIAR MENSAJE DE WHATSAPP ---
async function sendWhatsAppMessage(to, body, type = 'text', extraPayload = null) {
  const messageData = {
    messaging_product: 'whatsapp',
    to,
    type
  };
  if (type === 'text') {
    messageData.text = { body };
  } else if (type === 'interactive' && extraPayload) {
    messageData.interactive = extraPayload;
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    messageData,
    {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// --- VERIFICACIÓN DEL WEBHOOK (GET) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- RECEPCIÓN DE MENSAJES (POST) ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (
    body.object === 'whatsapp_business_account' &&
    body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  ) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const messageId = message.id;
    const messageType = message.type;
    const timestamp = new Date(parseInt(message.timestamp) * 1000);

    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
        { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
      );
    } catch (e) {
      console.error('Error al marcar como leído:', e.message);
    }

    let userMessage = '';
    if (messageType === 'text') {
      userMessage = message.text.body.toLowerCase().trim();
    } else if (messageType === 'interactive') {
      if (message.interactive.type === 'button_reply') {
        userMessage = message.interactive.button_reply.id;
      } else if (message.interactive.type === 'list_reply') {
        userMessage = message.interactive.list_reply.id;
      }
    } else {
      await sendWhatsAppMessage(from, 'Por ahora solo acepto texto o botones.');
      return res.sendStatus(200);
    }

    let botResponse = '';
    let { status, data } = await getUserState(from);

    try {
      if (userMessage.includes('cancelar')) {
        botResponse = 'Operación cancelada. ¿En qué más puedo ayudarte?';
        await setUserState(from, 'IDLE', {});
        await sendWhatsAppMessage(from, botResponse);
        return res.sendStatus(200);
      }

      switch (status) {
        case 'IDLE':
          const customer = await simulateGetCustomerDetails(from);
          if (!customer) {
            await sendWhatsAppMessage(from, 'No estás registrado como cliente.');
            return res.sendStatus(200);
          }

          data.customer = customer;

          const mainMenu = {
            type: "button",
            header: { type: "text", text: "¡Hola! ¿Cómo puedo ayudarte hoy?" },
            body: { type: "text", text: "Selecciona una opción:" },
            action: {
              buttons: [
                { type: "reply", title: "🛒 Realizar Pedido", id: "MENU_REALIZAR_PEDIDO" },
                { type: "reply", title: "💳 Consultar Crédito", id: "MENU_CONSULTAR_CREDITO" },
                { type: "reply", title: "📦 Estado de Pedido", id: "MENU_ESTADO_PEDIDO" }
              ]
            }
          };
          await sendWhatsAppMessage(from, '', 'interactive', mainMenu);
          await setUserState(from, 'MAIN_MENU', data);
          break;

        case 'MAIN_MENU':
          if (userMessage === 'MENU_REALIZAR_PEDIDO') {
            botResponse = '¿Qué producto deseas pedir?';
            data.currentOrder = {
              items: [],
              header: {
                ...simulatedSapConfig,
                SoldToParty: data.customer.SoldToParty,
                SalesOrganization: data.customer.SalesOrganization,
                SalesOrderDate: new Date().toISOString().split('T')[0]
              }
            };
            await setUserState(from, 'AWAITING_PRODUCT', data);
            await sendWhatsAppMessage(from, botResponse);
          } else if (userMessage === 'MENU_CONSULTAR_CREDITO') {
            botResponse = `Tu línea de crédito disponible es: $15,000 USD. (Simulado para ${data.customer.name})`;
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, botResponse);
          } else if (userMessage === 'MENU_ESTADO_PEDIDO') {
            botResponse = 'Por favor ingresa el número de pedido (simulado).';
            await setUserState(from, 'AWAITING_ORDER_STATUS_ID', data);
            await sendWhatsAppMessage(from, botResponse);
          } else {
            try {
              const aiPayload = {
                model: 'moonshotai/kimi-k2:free',
                messages: [{ role: 'user', content: userMessage }]
              };

              const aiConfig = {
                headers: {
                  'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              };

              const openRouterResponse = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                aiPayload,
                aiConfig
              );

              botResponse = openRouterResponse.data.choices[0].message.content;
              await sendWhatsAppMessage(from, botResponse);
            } catch (aiError) {
              console.error('Error IA:', aiError.message);
              botResponse = 'Lo siento, no pude procesar tu solicitud en este momento.';
              await sendWhatsAppMessage(from, botResponse);
            }
          }
          break;

        default:
          await sendWhatsAppMessage(from, 'Tu solicitud está fuera del flujo actual.');
          await setUserState(from, 'IDLE', {});
      }

      // Guardar conversación en Firestore
      await db.collection('conversations').add({
        phoneNumber: from,
        userMessage,
        botResponse,
        timestamp,
        messageId
      });

    } catch (err) {
      console.error('Error general:', err.message);
      await sendWhatsAppMessage(from, 'Ha ocurrido un error. Intenta más tarde.');
      await setUserState(from, 'IDLE', {});
    }
  }

  res.sendStatus(200);
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
