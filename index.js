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

// --- FUNCIÓN PARA ENVIAR MENSAJES DE WHATSAPP ---
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

// --- VARIABLES DE ENTORNO ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// --- RUTA PARA EL CHEQUEO DE SALUD ---
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// --- RUTA DE VERIFICACIÓN DEL WEBHOOK ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFICADO ✅');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- RUTA PRINCIPAL PARA RECIBIR MENSAJES ---
app.post('/webhook', async (req, res) => {
  // Ignoramos los webhooks de estado, solo procesamos mensajes de usuarios.
  if (!req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    return res.sendStatus(200);
  }
  
  const body = req.body;
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
  let botResponseLog = 'Respuesta por defecto.'; // Variable para guardar en el log

  try {
      if (userMessage === 'resetear') {
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, 'Estado reseteado. ✅');
          botResponseLog = 'Estado reseteado.';
      } else {
        switch (currentStatus) {
            case 'IDLE':
                const mainMenu = {
                    type: "button",
                    body: { text: `¡Hola! Soy tu asistente virtual. ¿Cómo puedo ayudarte hoy?` },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "start_order", title: "🛒 Realizar Pedido" } },
                            { type: "reply", reply: { id: "contact_agent", title: "🗣️ Hablar con asesor" } }
                        ]
                    }
                };
                await sendWhatsAppMessage(from, '', 'interactive', mainMenu);
                await setUserState(from, 'AWAITING_MAIN_MENU_CHOICE', {});
                botResponseLog = 'Menú principal enviado.';
                break;

            case 'AWAITING_MAIN_MENU_CHOICE':
                if (userMessage === 'start_order') {
                    // **CAMBIO 1: ENVIAR MENSAJE DE INSTRUCCIÓN**
                    const instructions = "Por favor, ingresa tu pedido. Puedes incluir varios productos, con sus cantidades y unidades.\n\n*(Por ej: 5 cajas de cerveza pilsen y 3 paquetes de gaseosa)*";
                    await sendWhatsAppMessage(from, instructions);
                    await setUserState(from, 'AWAITING_ORDER_TEXT', { orderItems: [] }); // Nuevo estado y carrito vacío
                    botResponseLog = 'Instrucciones de pedido enviadas.';
                } else if (userMessage === 'contact_agent') {
                    await sendWhatsAppMessage(from, 'Entendido. Un asesor se pondrá en contacto contigo en breve.');
                    await setUserState(from, 'IDLE', {});
                    botResponseLog = 'Solicitó hablar con asesor.';
                } else {
                    await sendWhatsAppMessage(from, 'Por favor, selecciona una opción válida de los botones.');
                    botResponseLog = 'Opción de menú inválida.';
                }
                break;

            // **CAMBIO 2: NUEVO ESTADO PARA PROCESAR EL TEXTO DEL PEDIDO**
            // (Por ahora, es una simulación simple. La IA la conectaremos en el siguiente paso)
            case 'AWAITING_ORDER_TEXT':
                // Simulación: Suponemos que el texto es un solo producto para simplificar
                const productText = message.text.body; // Usamos el texto original
                currentData.product = productText;
                currentData.quantity = 1; // Cantidad por defecto
                
                const confirmationMessage = `He entendido:\n\n- 1 unidad de "${productText}"\n\n¿Es correcto? (sí/no)`;
                await sendWhatsAppMessage(from, confirmationMessage);
                await setUserState(from, 'AWAITING_CONFIRMATION', currentData);
                botResponseLog = `Pedido simulado para confirmar: ${productText}`;
                break;

            case 'AWAITING_CONFIRMATION':
                if (userMessage === 'sí' || userMessage === 'si') {
                    // **CAMBIO 3: GENERAR NÚMERO DE PEDIDO Y MOSTRARLO**
                    const orderNumber = `PEDIDO-${Date.now()}`;
                    const finalMessage = `¡Pedido confirmado! ✅\n\nTu número de orden es: *${orderNumber}*\n\nGracias por tu compra.`;
                    
                    await db.collection('orders').add({ ...currentData, orderNumber, phoneNumber: from, status: 'CONFIRMED', orderDate: admin.firestore.FieldValue.serverTimestamp() });
                    await sendWhatsAppMessage(from, finalMessage);
                    await setUserState(from, 'IDLE', {});
                    botResponseLog = `Pedido confirmado con ID: ${orderNumber}`;
                } else {
                    await sendWhatsAppMessage(from, 'Pedido cancelado. Si deseas, puedes iniciar de nuevo enviando "hola".');
                    await setUserState(from, 'IDLE', {});
                    botResponseLog = 'Pedido cancelado por el usuario.';
                }
                break;

            default:
                await sendWhatsAppMessage(from, 'Lo siento, hubo un error. Por favor, empieza de nuevo enviando "hola".');
                await setUserState(from, 'IDLE', {});
                botResponseLog = 'Error, estado desconocido reseteado a IDLE.';
                break;
        }
      }

      // Guardar la conversación en Firestore
      await db.collection('conversations').add({
        phoneNumber: from, userMessage, botResponse: botResponseLog, status: currentStatus, timestamp, messageId
      });
      console.log('💾 Conversación guardada en Firestore.');

  } catch (error) {
      console.error('❌ ERROR en la lógica del bot:', error);
      await sendWhatsAppMessage(from, 'Lo siento, ocurrió un error inesperado. Intenta de nuevo.');
      await setUserState(from, 'IDLE', {});
  }
  
  res.sendStatus(200);
});

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
