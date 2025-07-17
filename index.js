const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// ✅ Ruta de health check para Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// --- CONFIGURACIÓN DE FIREBASE/FIRESTORE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- DATOS SIMULADOS DE SAP ---
const simulatedSapConfig = {
  SalesOrderType: "OR",
  DistributionChannel: "10",
  Division: "00",
  Plant: "1000",
  RequestedQuantityUnitDefault: "EA",
  RequestedDeliveryDaysFromNow: 3
};
const simulatedCustomers = [
  { phoneNumber: "51991690070", sapCustomerId: "1000001", SalesOrganization: "1000", name: "Rommel Cliente A" },
  { phoneNumber: "51991234567", sapCustomerId: "1000002", SalesOrganization: "2000", name: "Cliente B" },
];
const simulatedMaterials = [
  { friendlyName: "platanos", materialCode: "MAT001", unit: "KG", description: "Plátanos Cavendish" },
  { friendlyName: "manzanas", materialCode: "MAT002", unit: "EA", description: "Manzanas Rojas" },
  { friendlyName: "arroz", materialCode: "MAT003", unit: "KG", description: "Arroz Grano Largo" },
  { friendlyName: "leche", materialCode: "MAT004", unit: "LT", description: "Leche Entera 1L" },
];

// --- SIMULACIONES DE LLAMADAS A API DE SAP ---
async function simulateGetCustomerDetails(phoneNumber) {
  const customer = simulatedCustomers.find(c => c.phoneNumber === phoneNumber);
  if (customer) {
    return {
      SoldToParty: customer.sapCustomerId,
      SalesOrganization: customer.SalesOrganization,
      name: customer.name
    };
  }
  return null;
}
async function simulateSearchMaterial(description, aiAssisted = false) {
  const lower = description.toLowerCase();
  let found = simulatedMaterials.find(m => m.friendlyName === lower);
  if (found) return found;
  found = simulatedMaterials.find(m => lower.includes(m.friendlyName));
  if (found) return found;
  if (aiAssisted && process.env.OPENROUTER_API_KEY) {
    try {
      const materialNames = simulatedMaterials.map(m => m.friendlyName).join(', ');
      const prompt = `El usuario busca un producto. Dada la descripción "${description}", ¿cuál de los siguientes productos se parece más o es el mismo? Responde solo con el nombre del producto de la lista, o "NINGUNO" si no hay coincidencia clara. Lista: ${materialNames}.`;
      const resp = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: 'moonshotai/kimi-k2:free', messages: [{ role: 'user', content: prompt }] },
        {
          headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      const ai = resp.data.choices[0].message.content.toLowerCase().trim();
      if (ai !== 'ninguno') {
        const mat = simulatedMaterials.find(m => m.friendlyName === ai);
        if (mat) return mat;
      }
    } catch (e) {
      console.error('Error IA material:', e.message);
    }
  }
  return null;
}
async function simulateCreateSalesOrder(orderData) {
  console.log('Simulando envío a SAP:', JSON.stringify(orderData, null, 2));
  return { salesOrderNumber: `SAP_ORD_${Date.now()}`, status: 'CREATED' };
}

// --- ESTADOS DE USUARIO EN FIRESTORE ---
async function getUserState(phone) {
  const doc = await db.collection('user_states').doc(phone).get();
  return doc.exists ? doc.data() : { status: 'IDLE', data: {} };
}
async function setUserState(phone, status, data = {}) {
  await db.collection('user_states').doc(phone).set({ status, data, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
}

// --- FUNCIÓN PARA ENVIAR MENSAJES DE WHATSAPP ---
async function sendWhatsAppMessage(to, messageBody, messageType = 'text', interactive = null) {
  const payload = { messaging_product: 'whatsapp', to };
  if (messageType === 'text') {
    payload.type = 'text';
    payload.text = { body: messageBody };
  } else if (messageType === 'interactive' && interactive) {
    payload.type = 'interactive';
    payload.interactive = interactive;
  }
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`, payload, {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json'
      }
    });
    console.log('Mensaje enviado.');
  } catch (e) {
    console.error('Error al enviar mensaje:', e.response?.data || e.message);
  }
}

// --- WEBHOOK GET (verificación) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFICADO ✅');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- WEBHOOK POST (mensajes) ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account' &&
      body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const msgId = msg.id;
    const type = msg.type;
    const ts = new Date(parseInt(msg.timestamp) * 1000);

    // Marcando como leído
    try {
      await axios.post(`https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp', status: 'read', message_id: msgId
      }, {
        headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }
      });
      console.log(`Mensaje ${msgId} marcado como leído.`);
    } catch (err) {
      console.error('Error leer mensaje:', err.message);
    }

    let userMessage = '';
    if (type === 'text') userMessage = msg.text.body.toLowerCase().trim();
    else if (type === 'interactive') {
      if (msg.interactive.type === 'button_reply') userMessage = msg.interactive.button_reply.id;
      else if (msg.interactive.type === 'list_reply') userMessage = msg.interactive.list_reply.id;
    } else {
      await sendWhatsAppMessage(from, 'Solo proceso texto y botones.');
      return res.sendStatus(200);
    }

    console.log(`De ${from}: ${userMessage}`);
    let botResponse = 'Error inesperado.';
    const current = await getUserState(from);
    let currentStatus = current.status;
    let data = current.data || {};

    try {
      if (userMessage.includes('cancelar')) {
        botResponse = 'Operación cancelada. ¿En qué más puedo ayudarte?';
        await setUserState(from, 'IDLE', {});
        await sendWhatsAppMessage(from, botResponse);
        return res.sendStatus(200);
      }

      switch (currentStatus) {
        case 'IDLE':
          const cust = await simulateGetCustomerDetails(from);
          if (!cust) {
            await sendWhatsAppMessage(from, 'No estás en nuestro sistema.');
            return res.sendStatus(200);
          }
          data.customer = cust;
          const mainMenu = {
            type: "button", header: { type: "text", text: "¿Qué deseas hacer?" },
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
            botResponse = '¿Qué producto quieres añadir?';
            data.currentOrder = { items: [], header: {} };
            data.currentOrder.header = {
              ...simulatedSapConfig,
              SoldToParty: data.customer.SoldToParty,
              SalesOrganization: data.customer.SalesOrganization,
              SalesOrderDate: new Date().toISOString().split('T')[0]
            };
            await setUserState(from, 'AWAITING_PRODUCT', data);
            await sendWhatsAppMessage(from, botResponse);
          } else if (userMessage === 'MENU_CONSULTAR_CREDITO') {
            botResponse = `Crédito disponible: $15,000 USD. (${data.customer.name})`;
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, botResponse);
          } else if (userMessage === 'MENU_ESTADO_PEDIDO') {
            botResponse = '¿Cuál es el número del pedido?';
            await setUserState(from, 'AWAITING_ORDER_STATUS_ID', data);
            await sendWhatsAppMessage(from, botResponse);
          } else {
            try {
              const aiPayload = { model: 'moonshotai/kimi-k2:free', messages: [{ role: 'user', content: userMessage }] };
              const aiConfig = {
                headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
                timeout: 15000
              };
              const aiResp = await axios.post('https://openrouter.ai/api/v1/chat/completions', aiPayload, aiConfig);
              botResponse = aiResp.data.choices[0].message.content;
              await sendWhatsAppMessage(from, botResponse);
            } catch (e) {
              console.error('Error IA MAIN_MENU:', e.message);
              botResponse = 'No pude procesar tu solicitud.';
              await sendWhatsAppMessage(from, botResponse);
            }
          }
          break;

        case 'AWAITING_PRODUCT':
          const found = await simulateSearchMaterial(userMessage, true);
          if (found) {
            data.currentItem = { Material: found.materialCode, RequestedQuantityUnit: found.unit, description: found.description };
            botResponse = `¿Cuántas unidades de "${found.description}"?`;
            await setUserState(from, 'AWAITING_QUANTITY', data);
            await sendWhatsAppMessage(from, botResponse);
          } else {
            botResponse = `No encontré "${userMessage}", intenta de nuevo o escribe "cancelar".`;
            await sendWhatsAppMessage(from, botResponse);
          }
          break;

        case 'AWAITING_QUANTITY':
          const qty = parseInt(userMessage);
          if (!isNaN(qty) && qty > 0) {
            data.currentItem.RequestedQuantity = qty;
            data.currentOrder.items.push(data.currentItem);
            delete data.currentItem;
            const summary = data.currentOrder.items.map(i => `- ${i.RequestedQuantity} ${i.RequestedQuantityUnit} de "${i.description}"`).join('\n');
            const orderMenu = {
              type: "button",
              body: { type: "text", text: `Pedido:\n${summary}\n¿Qué deseas ahora?` },
              action: {
                buttons: [
                  { type: "reply", title: "➕ Añadir producto", id: "ORDER_ADD_MORE" },
                  { type: "reply", title: "✅ Finalizar pedido", id: "ORDER_FINISH" },
                  { type: "reply", title: "❌ Cancelar pedido", id: "ORDER_CANCEL" }
                ]
              }
            };
            await sendWhatsAppMessage(from, '', 'interactive', orderMenu);
            await setUserState(from, 'AWAITING_ORDER_ACTION', data);
          } else {
            await sendWhatsAppMessage(from, 'Ingresa una cantidad válida (número positivo).');
          }
          break;

        case 'AWAITING_ORDER_ACTION':
          if (userMessage === 'ORDER_ADD_MORE') {
            await setUserState(from, 'AWAITING_PRODUCT', data);
            await sendWhatsAppMessage(from, '¿Qué otro producto quieres añadir?');
          } else if (userMessage === 'ORDER_FINISH') {
            const summary = data.currentOrder.items.map(i => `- ${i.RequestedQuantity} ${i.RequestedQuantityUnit} de "${i.description}"`).join('\n');
            botResponse = `Resumen:\n${summary}\n¿Confirmas? (Sí/No)`;
            await setUserState(from, 'AWAITING_FINAL_CONFIRMATION', data);
            await sendWhatsAppMessage(from, botResponse);
          } else if (userMessage === 'ORDER_CANCEL') {
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, 'Pedido cancelado. ¿Algo más?');
          } else {
            await sendWhatsAppMessage(from, 'Selecciona una opción válida.');
          }
          break;

        case 'AWAITING_FINAL_CONFIRMATION':
          if (userMessage === 'sí' || userMessage === 'si') {
            const deliveryDate = new Date();
            deliveryDate.setDate(deliveryDate.getDate() + simulatedSapConfig.RequestedDeliveryDaysFromNow);
            data.currentOrder.header.RequestedDeliveryDate = deliveryDate.toISOString().split('T')[0];
            const sapResp = await simulateCreateSalesOrder({
              header: data.currentOrder.header,
              items: data.currentOrder.items.map(i => ({
                Material: i.Material,
                RequestedQuantity: i.RequestedQuantity,
                RequestedQuantityUnit: i.RequestedQuantityUnit,
                Plant: simulatedSapConfig.Plant
              }))
            });
            botResponse = `✅ Pedido #${sapResp.salesOrderNumber} enviado a SAP.`;
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, botResponse);
            await db.collection('orders').add({
              phoneNumber: from,
              sapOrderNumber: sapResp.salesOrderNumber,
              orderData: data.currentOrder,
              status: sapResp.status,
              orderDate: admin.firestore.FieldValue.serverTimestamp()
            });
          } else if (userMessage === 'no') {
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, 'Pedido cancelado. ¿Algo más?');
          } else {
            await sendWhatsAppMessage(from, 'Responde "Sí" o "No".');
          }
          break;

        case 'AWAITING_ORDER_STATUS_ID':
          botResponse = `Simulación: tu pedido ${userMessage} está en preparación.`;
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, botResponse);
          break;
      }

      // Guardar conversación
      await db.collection('conversations').add({
        phoneNumber: from,
        userMessage,
        botResponse,
        timestamp: ts,
        messageId: msgId
      });
      console.log('Guardado en conversaciones.');

    } catch (e) {
      console.error('Error flujo conversación:', e.message);
      await setUserState(from, 'IDLE', {});
      await sendWhatsAppMessage(from, 'Hubo un error. Intenta de nuevo.');
    }
  }
  res.sendStatus(200);
});

// --- INICIA SERVIDOR ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
