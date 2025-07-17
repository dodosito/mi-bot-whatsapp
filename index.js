const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// --- CONFIGURACIÓN DE FIREBASE/FIRESTORE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- FUNCIONES PARA GESTIONAR EL ESTADO DEL USUARIO EN FIRESTORE ---
async function getUserState(phoneNumber) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    const doc = await userStateRef.get();
    if (doc.exists) {
        return doc.data();
    } else {
        return { status: 'IDLE', data: {} };
    }
}

async function setUserState(phoneNumber, status, data = {}) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    await userStateRef.set({ status, data, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
}


// --- FUNCIÓN MEJORADA PARA ENVIAR MENSAJES DE WHATSAPP ---
async function sendWhatsAppMessage(to, messageBody, messageType = 'text', interactivePayload = null) {
    const payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: messageType,
    };

    if (messageType === 'text') {
        payload.text = { body: messageBody };
    } else if (messageType === 'interactive' && interactivePayload) {
        payload.interactive = interactivePayload;
    }

    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log(`✅ Mensaje tipo '${messageType}' enviado a ${to}.`);
    } catch (error) {
        console.error('❌ ERROR al enviar mensaje a WhatsApp:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    }
}


// --- TUS SECRETOS (VARIABLES DE ENTORNO) ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;


// --- RUTA PARA EL CHEQUEO DE SALUD DE RAILWAY ---
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// --- RUTA PARA LA VERIFICACIÓN DE META (Webhook GET) ---
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
  } else {
    res.sendStatus(400);
  }
});

// --- RUTA PRINCIPAL PARA RECIBIR MENSAJES DE WHATSAPP ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  // Solo procesamos si es un mensaje de usuario, ignoramos los webhooks de estado.
  if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    return res.sendStatus(200);
  }
  
  console.log('📥 WEBHOOK DE MENSAJE RECIBIDO:', JSON.stringify(body, null, 2));
    
  const message = body.entry[0].changes[0].value.messages[0];
  const from = message.from;
  const messageType = message.type;
  const messageId = message.id;
  const timestamp = new Date(parseInt(message.timestamp) * 1000);

  let userMessage;
  if (messageType === 'text') {
      userMessage = message.text.body.toLowerCase().trim();
  } else if (messageType === 'interactive' && message.interactive?.type === 'button_reply') {
      userMessage = message.interactive.button_reply.id;
  } else {
      await sendWhatsAppMessage(from, 'Lo siento, solo puedo procesar mensajes de texto o botones.');
      return res.sendStatus(200);
  }
  
  console.log(`💬 Mensaje de ${from} (${messageType}): ${userMessage}`);

  const currentUserState = await getUserState(from);
  let currentStatus = currentUserState.status;
  let currentData = currentUserState.data || {};
  let botResponse = 'Respuesta por defecto.';

  try {
      // --- NUEVO COMANDO DE RESETEO ---
      if (userMessage === 'resetear') {
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, 'Estado reseteado. ✅');
          console.log(`🛠️ Estado reseteado para ${from}`);
          // Guardamos la conversación antes de salir
          await db.collection('conversations').add({ phoneNumber: from, userMessage, botResponse: 'Estado reseteado.', status: 'RESET', timestamp, messageId });
          return res.sendStatus(200);
      }

      if (userMessage === 'cancelar') {
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, 'Operación cancelada. ¿Necesitas algo más?');
          await db.collection('conversations').add({ phoneNumber: from, userMessage, botResponse: 'Operación cancelada.', status: currentStatus, timestamp, messageId });
          return res.sendStatus(200);
      }

      switch (currentStatus) {
          case 'IDLE':
              const mainMenu = {
                  type: "button",
                  header: { type: "text", text: "¡Hola! 👋" },
                  body: { text: `Bienvenido. Soy tu asistente virtual. ¿Cómo puedo ayudarte hoy?` },
                  footer: { text: "Selecciona una opción" },
                  action: {
                      buttons: [
                          { type: "reply", reply: { id: "start_order", title: "🛒 Realizar Pedido" } },
                          { type: "reply", reply: { id: "contact_agent", title: "🗣️ Hablar con asesor" } }
                      ]
                  }
              };
              await sendWhatsAppMessage(from, '', 'interactive', mainMenu);
              await setUserState(from, 'AWAITING_MAIN_MENU_CHOICE', {});
              botResponse = 'Menú principal enviado.';
              break;

          case 'AWAITING_MAIN_MENU_CHOICE':
              if (userMessage === 'start_order') {
                  botResponse = '¡Claro! ¿Qué producto te gustaría pedir?';
                  await sendWhatsAppMessage(from, botResponse);
                  await setUserState(from, 'AWAITING_PRODUCT', {});
              } else if (userMessage === 'contact_agent') {
                  botResponse = 'Entendido. Un asesor se pondrá en contacto contigo en breve.';
                  await sendWhatsAppMessage(from, botResponse);
                  await setUserState(from, 'IDLE', {});
              } else {
                  botResponse = 'Por favor, selecciona una opción válida de los botones.';
                  await sendWhatsAppMessage(from, botResponse);
              }
              break;

          // ... (el resto de los casos no cambian)
          case 'AWAITING_PRODUCT':
              currentData.product = message.text.body; // Guardar con mayúsculas/minúsculas originales
              botResponse = `Ok, "${currentData.product}". ¿Qué cantidad necesitas?`;
              await sendWhatsAppMessage(from, botResponse);
              await setUserState(from, 'AWAITING_QUANTITY', currentData);
              break;

          case 'AWAITING_QUANTITY':
              const quantity = parseInt(userMessage);
              if (!isNaN(quantity) && quantity > 0) {
                  currentData.quantity = quantity;
                  botResponse = `Perfecto. ¿Confirmas tu pedido de ${currentData.quantity} de "${currentData.product}"? (sí/no)`;
                  await sendWhatsAppMessage(from, botResponse);
                  await setUserState(from, 'AWAITING_CONFIRMATION', currentData);
              } else {
                  botResponse = 'Por favor, ingresa una cantidad numérica válida.';
                  await sendWhatsAppMessage(from, botResponse);
              }
              break;

          case 'AWAITING_CONFIRMATION':
              if (userMessage === 'sí' || userMessage === 'si') {
                  botResponse = `¡Pedido confirmado! Tu orden de ${currentData.quantity} de "${currentData.product}" ha sido registrada.`;
                  await db.collection('orders').add({ ...currentData, phoneNumber: from, status: 'CONFIRMED', orderDate: admin.firestore.FieldValue.serverTimestamp() });
                  await sendWhatsAppMessage(from, botResponse);
                  await setUserState(from, 'IDLE', {});
              } else {
                  botResponse = 'Pedido cancelado. Si deseas, puedes iniciar de nuevo.';
                  await sendWhatsAppMessage(from, botResponse);
                  await setUserState(from, 'IDLE', {});
              }
              break;

          default:
              botResponse = 'Lo siento, hubo un error y me perdí. Empecemos de nuevo.';
              await sendWhatsAppMessage(from, botResponse);
              await setUserState(from, 'IDLE', {});
              break;
      }

      await db.collection('conversations').add({
        phoneNumber: from, userMessage, botResponse, status: currentStatus, timestamp, messageId
      });
      console.log('💾 Conversación guardada en Firestore.');

  } catch (error) {
      console.error('❌ ERROR en la lógica del bot:', error);
      try {
          await sendWhatsAppMessage(from, 'Lo siento, ocurrió un error inesperado. Intenta de nuevo.');
      } catch (sendError) {
          console.error('❌ ERROR al enviar mensaje de error al usuario:', sendError);
      }
      await setUserState(from, 'IDLE', {});
  }
  
  res.sendStatus(200);
});

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
