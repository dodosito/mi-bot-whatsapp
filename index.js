// ... encabezado
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

// --- DATOS SIMULADOS DE SAP ...
// [Todo el bloque de configuración, simulateGetCustomerDetails, etc. permanece igual]

// --- TUS SECRETOS (VARIABLES DE ENTORNO) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;

// ... Rutas: /health, /webhook GET

// --- FUNCIÓN PARA ENVIAR MENSAJES DE WHATSAPP (Centralizada) ---
// (sin cambios)

// --- RUTA PARA RECIBIR MENSAJES DE WHATSAPP (Webhook POST) ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('📥 WEBHOOK RECIBIDO:', JSON.stringify(body, null, 2));

  if (body.object === 'whatsapp_business_account' &&
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]) {
    
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const messageId = message.id;
    const messageType = message.type;
    const timestamp = new Date(parseInt(message.timestamp) * 1000);

    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
        { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
        { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      console.log(`Mensaje ${messageId} marcado como leído.`);
    } catch (readError) {
      console.error('Error al marcar mensaje como leído:', readError.response ? JSON.stringify(readError.response.data, null, 2) : readError.message);
    }

    let userMessage = '';
    if (messageType === 'text') {
      userMessage = message.text.body.toLowerCase().trim();
    } else if (messageType === 'interactive' && message.interactive) {
      if (message.interactive.type === 'button_reply') {
        userMessage = message.interactive.button_reply.id;
      } else if (message.interactive.type === 'list_reply') {
        userMessage = message.interactive.list_reply.id;
      }
      console.log(`💬 Mensaje interactivo de ${from}: ${userMessage}`);
    } else {
      await sendWhatsAppMessage(from, 'Lo siento, por ahora solo puedo procesar mensajes de texto y selecciones de menú.');
      res.sendStatus(200);
      return;
    }

    console.log(`💬 Mensaje de ${from}: ${userMessage}`);

    let botResponse = 'Lo siento, no pude obtener una respuesta en este momento.';
    let currentUserState = await getUserState(from);
    let currentStatus = currentUserState.status;
    let currentData = currentUserState.data || {};

    try {
      if (userMessage.includes('cancelar')) {
        botResponse = 'Operación cancelada. ¿Hay algo más en lo que pueda ayudarte?';
        await setUserState(from, 'IDLE', {});
        await sendWhatsAppMessage(from, botResponse);
        res.sendStatus(200);
        return;
      }

      switch (currentStatus) {
        case 'IDLE':
          const customerDetails = await simulateGetCustomerDetails(from);
          if (!customerDetails) {
            botResponse = 'Hola, no te encuentro registrado en nuestro sistema de clientes. Para realizar un pedido, por favor contacta a nuestro equipo de ventas o regístrate en nuestro portal.';
            await sendWhatsAppMessage(from, botResponse);
            res.sendStatus(200);
            return;
          }
          currentData.customer = customerDetails;

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
          await setUserState(from, 'MAIN_MENU', currentData);
          break;

        case 'MAIN_MENU':
          if (userMessage === 'MENU_REALIZAR_PEDIDO') {
            botResponse = '¡Excelente! ¿Qué producto te gustaría añadir a tu pedido?';
            currentData.currentOrder = { items: [], header: {} };
            currentData.currentOrder.header = {
              ...simulatedSapConfig,
              SoldToParty: currentData.customer.SoldToParty,
              SalesOrganization: currentData.customer.SalesOrganization,
              SalesOrderDate: new Date().toISOString().split('T')[0]
            };
            await setUserState(from, 'AWAITING_PRODUCT', currentData);
            await sendWhatsAppMessage(from, botResponse);
          } else if (userMessage === 'MENU_CONSULTAR_CREDITO') {
            botResponse = `Tu línea de crédito disponible es: $15,000 USD. (Simulado para ${currentData.customer.name})`;
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, botResponse);
          } else if (userMessage === 'MENU_ESTADO_PEDIDO') {
            botResponse = `Para consultar el estado de tu pedido, por favor, dime el número de pedido. (Simulado)`;
            await setUserState(from, 'AWAITING_ORDER_STATUS_ID', currentData);
            await sendWhatsAppMessage(from, botResponse);
          } else {
            // ✅ BLOQUE DE IA CORREGIDO Y SEGURO
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
              console.error('❌ Error al obtener respuesta de IA en MAIN_MENU:', aiError.response ? JSON.stringify(aiError.response.data, null, 2) : aiError.message);
              botResponse = 'Lo siento, no pude procesar tu solicitud en este momento.';
              await sendWhatsAppMessage(from, botResponse);
            }
          }
          break;

        // ... el resto de los `case` (AWAITING_PRODUCT, AWAITING_QUANTITY, etc.) permanece igual
        // ... no los repito aquí para ahorrar espacio, pero puedes mantenerlos como ya los tienes
      }

    } catch (error) {
      console.error('❌ ERROR en la lógica del flujo:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
      await sendWhatsAppMessage(from, 'Lo siento, hubo un error inesperado en el bot. Por favor, intenta de nuevo.');
      await setUserState(from, 'IDLE', {});
    }

    // --- Guardar conversación en Firestore ---
    try {
      await db.collection('conversations').add({
        phoneNumber: from,
        userMessage: userMessage,
        botResponse: botResponse,
        timestamp: timestamp,
        messageId: messageId
      });
      console.log('💾 Conversación guardada en Firestore.');
    } catch (dbError) {
      console.error('❌ ERROR al guardar en Firestore:', dbError.message);
    }

  } else {
    console.log('El webhook recibido no contiene un mensaje de WhatsApp válido o no es de una cuenta de negocio.');
  }
  res.sendStatus(200);
});

// --- Mantener encendido ---
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
