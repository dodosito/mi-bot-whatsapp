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
    console.log(`🔎 Buscando productos para el texto: "${text}"`);
    const searchKeywords = text.toLowerCase().split(' ').filter(word => word.length > 2);
    if (searchKeywords.length === 0) return [];
    const productsRef = db.collection('products');
    const snapshot = await productsRef.where('searchTerms', 'array-contains-any', searchKeywords).get();
    if (snapshot.empty) return [];
    const foundProducts = snapshot.docs.map(doc => doc.data());
    console.log(`✨ Productos encontrados:`, foundProducts.map(p => p.productName));
    return foundProducts;
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
  const messageType = message.type;
  
  let userMessage;
  let originalText = '';

  if (messageType === 'text') {
      userMessage = message.text.body.toLowerCase().trim();
      originalText = message.text.body;
  } else if (message.interactive?.type === 'button_reply') {
      userMessage = message.interactive.button_reply.id;
  } else if (message.interactive?.type === 'list_reply') {
      userMessage = message.interactive.list_reply.id;
  } else {
      return res.sendStatus(200);
  }
  
  console.log(`💬 Mensaje de ${from} (${messageType}): ${userMessage}`);
  const currentUserState = await getUserState(from);
  let currentStatus = currentUserState.status;
  let currentData = currentUserState.data || {};

  try {
      if (userMessage === 'resetear') {
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, 'Estado reseteado. ✅');
          return res.sendStatus(200);
      }
      
      switch (currentStatus) {
          case 'IDLE':
          case 'AWAITING_MAIN_MENU_CHOICE':
              // ... (sin cambios)
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
              // ... (sin cambios)
              const foundProducts = await findProductsInCatalog(originalText);
              if (foundProducts.length === 0) {
                  await sendWhatsAppMessage(from, "Lo siento, no encontré productos que coincidan con tu búsqueda. Intenta de nuevo.");
              } else if (foundProducts.length === 1) {
                  const product = foundProducts[0];
                  await sendWhatsAppMessage(from, `Encontré "${product.productName}". ¿Qué cantidad necesitas?`);
                  currentData.pendingProduct = product;
                  await setUserState(from, 'AWAITING_QUANTITY', currentData);
              } else {
                  const clarificationMenu = { type: 'list', header: { type: 'text', text: 'Múltiples coincidencias' }, body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, footer: { text: 'Selecciona uno' }, action: { button: 'Ver opciones', sections: [{ title: 'Elige una presentación', rows: foundProducts.filter(p => p.shortName).map(p => ({ id: p.sku, title: p.shortName, description: p.productName })) }] } };
                  if (clarificationMenu.action.sections[0].rows.length > 0) {
                    await sendWhatsAppMessage(from, '', 'interactive', clarificationMenu);
                    await setUserState(from, 'AWAITING_CLARIFICATION', currentData);
                  }
              }
              break;
          
          case 'AWAITING_CLARIFICATION':
              // ... (sin cambios)
              const selectedSku = userMessage;
              const productDoc = await db.collection('products').doc(selectedSku).get();
              if (productDoc.exists) {
                  const selectedProduct = productDoc.data();
                  await sendWhatsAppMessage(from, `Seleccionaste "${selectedProduct.productName}". ¿Qué cantidad necesitas?`);
                  currentData.pendingProduct = selectedProduct;
                  await setUserState(from, 'AWAITING_QUANTITY', currentData);
              }
              break;

          // --- AQUÍ EMPIEZA LA LÓGICA AÑADIDA ---
          case 'AWAITING_QUANTITY':
              const quantity = parseInt(userMessage);
              if (isNaN(quantity) || quantity <= 0) {
                  await sendWhatsAppMessage(from, "Por favor, ingresa una cantidad numérica válida.");
                  break; // Se mantiene en el mismo estado esperando una cantidad correcta
              }

              // Añadir el producto completo al carrito
              const newOrderItem = {
                  ...currentData.pendingProduct,
                  quantity: quantity
              };
              currentData.orderItems.push(newOrderItem);
              delete currentData.pendingProduct; // Limpiamos el producto pendiente

              // Crear el resumen del carrito
              let summary = "Este es tu pedido hasta ahora:\n\n";
              currentData.orderItems.forEach(item => {
                  summary += `• ${item.quantity} de ${item.productName}\n`;
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
              await setUserState(from, 'AWAITING_ORDER_ACTION', currentData);
              break;

          case 'AWAITING_ORDER_ACTION':
              if (userMessage === 'add_more_products') {
                  await sendWhatsAppMessage(from, "Claro, ¿qué más deseas añadir?");
                  await setUserState(from, 'AWAITING_ORDER_TEXT', currentData);
              } else if (userMessage === 'finish_order') {
                  await sendWhatsAppMessage(from, "Perfecto. ¿Confirmas que este es tu pedido final? (sí/no)");
                  await setUserState(from, 'AWAITING_FINAL_CONFIRMATION', currentData);
              } else {
                  await sendWhatsAppMessage(from, "Por favor, elige una opción de los botones.");
              }
              break;
            
          case 'AWAITING_FINAL_CONFIRMATION':
              if (userMessage === 'sí' || userMessage === 'si') {
                  const orderNumber = `PEDIDO-${Date.now()}`;
                  const finalMessage = `¡Pedido confirmado! ✅\n\nTu número de orden es: *${orderNumber}*\n\nGracias por tu compra.`;
                  
                  // Guardar el pedido final
                  await db.collection('orders').add({ 
                      orderNumber: orderNumber,
                      phoneNumber: from, 
                      status: 'CONFIRMED',
                      orderDate: admin.firestore.FieldValue.serverTimestamp(),
                      items: currentData.orderItems
                  });

                  await sendWhatsAppMessage(from, finalMessage);
                  await setUserState(from, 'IDLE', {});
              } else {
                  await sendWhatsAppMessage(from, "Pedido cancelado. Puedes iniciar de nuevo cuando quieras enviando 'hola'.");
                  await setUserState(from, 'IDLE', {});
              }
              break;

          default:
              await sendWhatsAppMessage(from, 'Lo siento, hubo un error. Por favor, empieza de nuevo enviando "hola".');
              await setUserState(from, 'IDLE', {});
              break;
      }
  } catch (error) {
      console.error('❌ ERROR en la lógica del bot:', error);
      await sendWhatsAppMessage(from, 'Lo siento, ocurrió un error inesperado. Intenta de nuevo.');
      await setUserState(from, 'IDLE', {});
  }
  
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
