const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// --- CONFIGURACIÓN DE FIREBASE/FIRESTORE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// --- FUNCIONES DE UTILIDAD (SIN CAMBIOS) ---
async function getUserState(phoneNumber) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    const doc = await userStateRef.get();
    return doc.exists ? doc.data() : { status: 'IDLE', data: {} };
}

async function setUserState(phoneNumber, status, data = {}) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    await userStateRef.set({ status, data, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
}

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
            { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        console.log(`✅ Mensaje tipo '${messageType}' enviado a ${to}.`);
    } catch (error) {
        console.error('❌ ERROR al enviar mensaje a WhatsApp:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    }
}

async function findProductsInCatalog(text) {
    const searchKeywords = text.toLowerCase().split(' ').filter(word => word.length > 2);
    if (searchKeywords.length === 0) return [];
    const snapshot = await db.collection('products').where('searchTerms', 'array-contains-any', searchKeywords).get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data());
}

// --- VARIABLES DE ENTORNO Y RUTAS (SIN CAMBIOS) ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
app.get('/health', (req, res) => res.sendStatus(200));
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- RUTA PRINCIPAL PARA RECIBIR MENSAJES ---
app.post('/webhook', async (req, res) => {
  if (!req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    return res.sendStatus(200);
  }
  
  const message = req.body.entry[0].changes[0].value.messages[0];
  const from = message.from;
  let userMessage, originalText = '';

  if (message.type === 'text') {
      userMessage = originalText = message.text.body;
  } else if (message.interactive) {
      userMessage = message.interactive[message.interactive.type].id;
  } else {
      return res.sendStatus(200);
  }
  
  console.log(`💬 Mensaje de ${from} (${message.type}): ${userMessage}`);
  const currentUserState = await getUserState(from);
  let { status, data = {} } = currentUserState;

  try {
      if (userMessage.toLowerCase().trim() === 'resetear') {
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, 'Estado reseteado. ✅');
          return res.sendStatus(200);
      }
      
      switch (status) {
          case 'IDLE':
          case 'AWAITING_MAIN_MENU_CHOICE':
              if (userMessage === 'start_order') {
                  const instructions = "Por favor, ingresa tu pedido. Puedes incluir varios productos.\n\n*(Por ej: 5 cajas de cerveza pilsen y 3 gaseosas)*";
                  await sendWhatsAppMessage(from, instructions);
                  await setUserState(from, 'AWAITING_ORDER_TEXT', { orderItems: [] });
              } else {
                  const mainMenu = { type: "button", body: { text: `¡Hola! Soy tu asistente virtual. ¿Cómo puedo ayudarte hoy?` }, action: { buttons: [{ type: "reply", reply: { id: "start_order", title: "🛒 Realizar Pedido" } }, { type: "reply", reply: { id: "contact_agent", title: "🗣️ Hablar con asesor" } }] } };
                  await sendWhatsAppMessage(from, '', 'interactive', mainMenu);
                  await setUserState(from, 'AWAITING_MAIN_MENU_CHOICE', {});
              }
              break;

          case 'AWAITING_ORDER_TEXT':
              const foundProducts = await findProductsInCatalog(originalText);
              if (foundProducts.length === 0) {
                  await sendWhatsAppMessage(from, "Lo siento, no encontré productos que coincidan con tu búsqueda.");
              } else if (foundProducts.length === 1) {
                  data.pendingProduct = foundProducts[0];
                  await sendWhatsAppMessage(from, `Encontré "${data.pendingProduct.productName}". ¿Qué cantidad necesitas?`);
                  await setUserState(from, 'AWAITING_QUANTITY', data);
              } else {
                  const clarificationMenu = { type: 'list', header: { type: 'text', text: 'Múltiples coincidencias' }, body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { button: 'Ver opciones', sections: [{ title: 'Elige una presentación', rows: foundProducts.filter(p => p.shortName).map(p => ({ id: p.sku, title: p.shortName, description: p.productName })) }] } };
                  if (clarificationMenu.action.sections[0].rows.length > 0) {
                    await sendWhatsAppMessage(from, '', 'interactive', clarificationMenu);
                    await setUserState(from, 'AWAITING_CLARIFICATION', data);
                  }
              }
              break;
          
          case 'AWAITING_CLARIFICATION':
              const productDoc = await db.collection('products').doc(userMessage).get();
              if (productDoc.exists) {
                  data.pendingProduct = productDoc.data();
                  await sendWhatsAppMessage(from, `Seleccionaste "${data.pendingProduct.productName}". ¿Qué cantidad necesitas?`);
                  await setUserState(from, 'AWAITING_QUANTITY', data);
              }
              break;

          case 'AWAITING_QUANTITY':
              const quantity = parseInt(userMessage);
              if (isNaN(quantity) || quantity <= 0) {
                  await sendWhatsAppMessage(from, "Por favor, ingresa una cantidad numérica válida.");
                  break;
              }
              data.pendingQuantity = quantity; // Guardamos la cantidad temporalmente

              // --- NUEVO PASO: PREGUNTAR POR LA UNIDAD DE MEDIDA ---
              const product = data.pendingProduct;
              if (product && product.availableUnits && product.availableUnits.length > 0) {
                  const unitMenu = {
                      type: 'button',
                      body: { text: `Entendido, ${quantity}. ¿En qué unidad?` },
                      action: {
                          buttons: product.availableUnits.map(unit => ({
                              type: 'reply',
                              reply: { id: unit.toLowerCase(), title: unit }
                          }))
                      }
                  };
                  await sendWhatsAppMessage(from, '', 'interactive', unitMenu);
                  await setUserState(from, 'AWAITING_UOM', data);
              } else {
                  // Si el producto no tiene unidades definidas, se asume 'unidad' y se va al carrito
                  const newOrderItem = { ...data.pendingProduct, quantity: data.pendingQuantity, unit: 'unidad' };
                  data.orderItems.push(newOrderItem);
                  delete data.pendingProduct;
                  delete data.pendingQuantity;
                  // (Lógica del carrito... que ahora irá en AWAITING_UOM)
                  await sendWhatsAppMessage(from, "Producto añadido (unidad por defecto)."); // Placeholder
                  await setUserState(from, 'AWAITING_ORDER_ACTION', data);
              }
              break;

          // --- NUEVO ESTADO PARA CAPTURAR LA UNIDAD DE MEDIDA ---
          case 'AWAITING_UOM':
              const selectedUnit = userMessage;

              // Añadir el producto completo (con unidad) al carrito
              const newOrderItem = {
                  ...data.pendingProduct,
                  quantity: data.pendingQuantity,
                  unit: selectedUnit
              };
              data.orderItems.push(newOrderItem);
              delete data.pendingProduct;
              delete data.pendingQuantity;

              // Crear el resumen del carrito (AHORA SÍ CON UNIDAD DE MEDIDA)
              let summary = "Este es tu pedido hasta ahora:\n\n";
              data.orderItems.forEach(item => {
                  summary += `• ${item.quantity} ${item.unit} de ${item.productName}\n`;
              });
              summary += "\n¿Qué deseas hacer?";

              const cartMenu = {
                  type: 'button',
                  body: { text: summary },
                  action: {
                      buttons: [
                          { type: 'reply', reply: { id: 'add_more_products', title: '➕ Añadir más' } },
                          { type: 'reply', reply: { id: 'finish_order', title: '✅ Finalizar Pedido' } }
                      ]
                  }
              };
              await sendWhatsAppMessage(from, '', 'interactive', cartMenu);
              await setUserState(from, 'AWAITING_ORDER_ACTION', data);
              break;

          case 'AWAITING_ORDER_ACTION':
              if (userMessage === 'add_more_products') {
                  await sendWhatsAppMessage(from, "Claro, ¿qué más deseas añadir?");
                  await setUserState(from, 'AWAITING_ORDER_TEXT', data);
              } else if (userMessage === 'finish_order') {
                  await sendWhatsAppMessage(from, "Perfecto. ¿Confirmas que este es tu pedido final? (sí/no)");
                  await setUserState(from, 'AWAITING_FINAL_CONFIRMATION', data);
              }
              break;
            
          case 'AWAITING_FINAL_CONFIRMATION':
              if (userMessage.toLowerCase().trim() === 'sí' || userMessage.toLowerCase().trim() === 'si') {
                  const orderNumber = `PEDIDO-${Date.now()}`;
                  const finalMessage = `¡Pedido confirmado! ✅\n\nTu número de orden es: *${orderNumber}*\n\nGracias por tu compra.`;
                  await db.collection('orders').add({ 
                      orderNumber,
                      phoneNumber: from, 
                      status: 'CONFIRMED',
                      orderDate: admin.firestore.FieldValue.serverTimestamp(),
                      items: data.orderItems
                  });
                  await sendWhatsAppMessage(from, finalMessage);
                  await setUserState(from, 'IDLE', {});
              } else {
                  await sendWhatsAppMessage(from, "Pedido cancelado. Puedes iniciar de nuevo cuando quieras.");
                  await setUserState(from, 'IDLE', {});
              }
              break;

          default:
              await sendWhatsAppMessage(from, 'Lo siento, hubo un error. Por favor, empieza de nuevo.');
              await setUserState(from, 'IDLE', {});
              break;
      }
  } catch (error) {
      console.error('❌ ERROR en la lógica del bot:', error);
  }
  
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
