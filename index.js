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

// --- FUNCIONES DE UTILIDAD ---
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
        payload.text = { body: messageBody, preview_url: false };
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
    const productsRef = db.collection('products');
    const snapshot = await productsRef.where('searchTerms', 'array-contains-any', searchKeywords).get();
    if (snapshot.empty) return [];
    let maxScore = 0;
    const scoredProducts = snapshot.docs.map(doc => {
        const product = doc.data();
        let score = 0;
        searchKeywords.forEach(keyword => {
            if (product.searchTerms.includes(keyword) || product.productName.toLowerCase().includes(keyword) || product.shortName.toLowerCase().includes(keyword)) {
                score++;
            }
        });
        if (score > maxScore) maxScore = score;
        return { ...product, score };
    });
    const bestMatches = scoredProducts.filter(p => p.score === maxScore);
    console.log(`✨ Mejores coincidencias encontradas:`, bestMatches.map(p => p.productName));
    return bestMatches;
}

async function showCartSummary(from, data) {
    let summary = "*Este es tu pedido hasta ahora:*\n\n";
    data.orderItems.forEach(item => {
        summary += `• ${item.quantity} ${item.unit} de ${item.productName}\n`;
    });
    summary += "\n¿Qué deseas hacer?";
    const cartMenu = { type: 'button', body: { text: summary }, action: { buttons: [{ type: 'reply', reply: { id: 'add_more_products', title: '➕ Añadir más' } }, { type: 'reply', reply: { id: 'finish_order', title: '✅ Finalizar Pedido' } }] } };
    await sendWhatsAppMessage(from, '', 'interactive', cartMenu);
    await setUserState(from, 'AWAITING_ORDER_ACTION', data);
}

// --- VARIABLES DE ENTORNO Y RUTAS ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
app.get('/', (req, res) => res.status(200).send('Bot activo.'));
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
  } else { return res.sendStatus(200); }
  
  try {
      const currentUserState = await getUserState(from);
      let { status, data = {} } = currentUserState;

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
                  const mainMenu = { type: "button", body: { text: `¡Hola! Soy tu asistente virtual.` }, action: { buttons: [{ type: "reply", reply: { id: "start_order", title: "🛒 Realizar Pedido" } }, { type: "reply", reply: { id: "contact_agent", title: "🗣️ Hablar con asesor" } }] } };
                  await sendWhatsAppMessage(from, '', 'interactive', mainMenu);
                  await setUserState(from, 'AWAITING_MAIN_MENU_CHOICE', {});
              }
              break;

          case 'AWAITING_ORDER_TEXT':
              if (userMessage === 'back_to_cart') {
                  await showCartSummary(from, data);
                  break;
              }

              const candidateProducts = await findProductsInCatalog(originalText);
              if (candidateProducts.length === 0) {
                  await sendWhatsAppMessage(from, "Lo siento, no encontré productos que coincidan con tu búsqueda.");
                  break;
              }
              
              if (candidateProducts.length > 1) {
                  // Si la búsqueda sigue siendo ambigua, usamos el menú de desambiguación.
                  // (Esta parte no ha cambiado)
                  // ... código del menú de desambiguación ...
              } 
              // Si encontramos UN SOLO producto candidato, aplicamos TU LÓGICA DE REGLAS.
              else if (candidateProducts.length === 1) {
                  const product = candidateProducts[0];
                  const text = originalText.toLowerCase();

                  // 1. Buscamos la cantidad
                  const quantityMatch = text.match(/\d+/);
                  const quantity = quantityMatch ? parseInt(quantityMatch[0]) : null;

                  // 2. Buscamos la unidad de medida
                  let unit = null;
                  if (product.availableUnits) {
                      for (const u of product.availableUnits) {
                          if (text.includes(u.toLowerCase())) {
                              unit = u;
                              break;
                          }
                      }
                  }

                  // 3. Aplicamos la lógica de decisión
                  if (quantity && unit) {
                      // ¡Encontramos todo! Añadimos al carrito.
                      const newOrderItem = { ...product, quantity, unit };
                      if (!data.orderItems) data.orderItems = [];
                      data.orderItems.push(newOrderItem);
                      await showCartSummary(from, data);
                  } else if (quantity && !unit) {
                      // Encontramos producto y cantidad, falta la unidad.
                      data.pendingProduct = product;
                      data.pendingQuantity = quantity;
                      // Reutilizamos la lógica de AWAITING_QUANTITY para preguntar la unidad
                      const unitMenu = { type: 'button', body: { text: `Entendido, ${quantity} de "${product.shortName}". ¿En qué unidad?` }, action: { buttons: product.availableUnits.slice(0, 3).map(u => ({ type: 'reply', reply: { id: u.toLowerCase(), title: u } })) } };
                      await sendWhatsAppMessage(from, '', 'interactive', unitMenu);
                      await setUserState(from, 'AWAITING_UOM', data);
                  } else {
                      // No encontramos cantidad ni unidad, hacemos el flujo de preguntas completo.
                      data.pendingProduct = product;
                      await sendWhatsAppMessage(from, `Encontré "${product.productName}". ¿Qué cantidad necesitas?`);
                      await setUserState(from, 'AWAITING_QUANTITY', data);
                  }
              }
              break;
          
          case 'AWAITING_CLARIFICATION':
              const productDocClarification = await db.collection('products').doc(userMessage).get();
              if (productDocClarification.exists) {
                  // Una vez que el usuario elige, volvemos a la lógica de texto con el producto ya definido.
                  const clarifiedProduct = [productDocClarification.data()];
                  // Aquí podríamos re-analizar el texto original, pero por simplicidad vamos a preguntar cantidad.
                  data.pendingProduct = clarifiedProduct[0];
                  await sendWhatsAppMessage(from, `Seleccionaste "${data.pendingProduct.productName}". ¿Qué cantidad necesitas?`);
                  await setUserState(from, 'AWAITING_QUANTITY', data);
              }
              break;

          case 'AWAITING_QUANTITY':
              // ... sin cambios ...
              break;

          case 'AWAITING_UOM':
              // ... sin cambios ...
              break;

          case 'AWAITING_ORDER_ACTION':
              // ... sin cambios ...
              break;

          default:
              await sendWhatsAppMessage(from, 'Lo siento, hubo un error. Empieza de nuevo.');
              await setUserState(from, 'IDLE', {});
              break;
      }
  } catch (error) {
      console.error('❌ ERROR en la lógica del bot:', error);
      await sendWhatsAppMessage(from, "Lo siento, estoy teniendo problemas técnicos.");
  }
  
  res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
