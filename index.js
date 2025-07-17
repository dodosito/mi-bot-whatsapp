const express = require('express');
const axios =require('axios');
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

// --- MEJORA 1: Lógica de búsqueda más precisa ---
async function findProductsInCatalog(text) {
    console.log(`🔎 Buscando productos para el texto: "${text}"`);
    const searchKeywords = text.toLowerCase().split(' ').filter(word => word.length > 2);
    if (searchKeywords.length === 0) return [];
    
    const productsRef = db.collection('products');
    const snapshot = await productsRef.where('searchTerms', 'array-contains-any', searchKeywords).get();

    if (snapshot.empty) {
        console.log('No se encontraron productos en la fase inicial.');
        return [];
    }

    // Calculamos una puntuación de relevancia para cada producto
    let maxScore = 0;
    const scoredProducts = snapshot.docs.map(doc => {
        const product = doc.data();
        let score = 0;
        searchKeywords.forEach(keyword => {
            if (product.searchTerms.includes(keyword)) {
                score++;
            }
        });
        if (score > maxScore) maxScore = score;
        return { ...product, score };
    });

    // Filtramos para quedarnos solo con los productos con la máxima puntuación
    const bestMatches = scoredProducts.filter(p => p.score === maxScore);

    console.log(`✨ Mejores coincidencias encontradas:`, bestMatches.map(p => p.productName));
    return bestMatches;
}

async function showCartSummary(from, data) {
    // --- MEJORA 2: Título del carrito en negritas ---
    let summary = "*Este es tu pedido hasta ahora:*\n\n";
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
}

// --- VARIABLES DE ENTORNO Y RUTAS ---
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
  } else { return res.sendStatus(200); }
  
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
              // ... sin cambios ...
              break;

          case 'AWAITING_ORDER_TEXT':
              // ... sin cambios ...
              break;
          
          case 'AWAITING_CLARIFICATION':
              // ... sin cambios ...
              break;

          case 'AWAITING_QUANTITY':
             // ... sin cambios ...
              break;

          case 'AWAITING_UOM':
              // ... sin cambios ...
              break;

          case 'AWAITING_ORDER_ACTION':
              if (userMessage === 'add_more_products') {
                  const askMoreMenu = { type: 'button', body: { text: "Claro, ¿qué más deseas añadir?" }, action: { buttons: [{ type: 'reply', reply: { id: 'back_to_cart', title: '↩️ Ver mi pedido' } }] } };
                  await sendWhatsAppMessage(from, '', 'interactive', askMoreMenu);
                  await setUserState(from, 'AWAITING_ORDER_TEXT', data);
              } else if (userMessage === 'finish_order') {
                  // --- MEJORA 3: Se elimina la doble confirmación ---
                  const orderNumber = `PEDIDO-${Date.now()}`;
                  const finalMessage = `¡Pedido confirmado! ✅\n\nTu número de orden es: *${orderNumber}*\n\nGracias por tu compra.`;
                  await db.collection('orders').add({ orderNumber, phoneNumber: from, status: 'CONFIRMED', orderDate: admin.firestore.FieldValue.serverTimestamp(), items: data.orderItems });
                  await sendWhatsAppMessage(from, finalMessage);
                  await setUserState(from, 'IDLE', {});
              }
              break;
            
          // Este caso ya no es necesario porque la lógica se movió a AWAITING_ORDER_ACTION
          // case 'AWAITING_FINAL_CONFIRMATION':
          //     break;

          default:
              await sendWhatsAppMessage(from, 'Lo siento, hubo un error. Empieza de nuevo.');
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
