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

function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator,
      );
    }
  }
  return matrix[b.length][a.length];
}

function splitOrderText(input) {
  const delimitadores = [' y ', ',', ';', '|'];
  let texto = input;
  for (const delim of delimitadores) {
    texto = texto.split(delim).join('|');
  }
  return texto.split('|').map(i => i.trim()).filter(i => i.length > 0);
}

async function findProductsInCatalog(text) {
  const normalizedUserText = normalizeText(text);
  const searchKeywords = normalizedUserText.split(' ').filter(word => word.length > 2);
  if (searchKeywords.length === 0) return [];

  const productsRef = db.collection('products');
  const snapshot = await productsRef.get();
  if (snapshot.empty) return [];

  let maxScore = 0;
  const scoredProducts = [];

  snapshot.forEach(doc => {
    const product = doc.data();
    let score = 0;
    const normalizedProductName = normalizeText(product.productName);

    searchKeywords.forEach(keyword => {
      if (product.searchTerms.map(term => normalizeText(term)).includes(keyword)) {
        score += 3;
      }
      if (normalizedProductName.includes(keyword)) {
        score += 1;
      }
      product.searchTerms.forEach(term => {
        const distance = levenshteinDistance(keyword, normalizeText(term));
        if (distance > 0 && distance <= 2) {
          score += 2;
        }
      });
    });

    if (score > 0) {
      if (score > maxScore) maxScore = score;
      scoredProducts.push({ ...product, score });
    }
  });

  if (maxScore === 0) return [];
  return scoredProducts.filter(p => p.score >= maxScore);
}

async function showCartSummary(from, data) {
  let summary = "*Este es tu pedido hasta ahora:*\n\n";
  if (data.orderItems && data.orderItems.length > 0) {
    data.orderItems.forEach(item => {
      summary += `• ${item.quantity} ${item.unit} de ${item.productName}\n`;
    });
  } else {
    summary = "Tu carrito está vacío.\n\n";
  }
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

async function processNextPendingItem(from, data) {
  if (!data.pendingItemsList || data.pendingItemsList.length === 0) {
    await showCartSummary(from, data);
    return;
  }
  const nextText = data.pendingItemsList.shift();
  await setUserState(from, 'AWAITING_ORDER_TEXT', data);
  await handleItemParsing(from, nextText, data);
}

async function handleItemParsing(from, text, data) {
  const matchedProducts = await findProductsInCatalog(text);
  if (matchedProducts.length === 0) {
    await sendWhatsAppMessage(from, `❌ No encontré ningún producto que coincida con: "${text}". Intenta describirlo de otra forma.`);
    await processNextPendingItem(from, data);
    return;
  }

  const product = matchedProducts[0];
  data.currentItem = { productId: product.id, productName: product.productName };
  await setUserState(from, 'AWAITING_QUANTITY', data);
  await sendWhatsAppMessage(from, `📦 ¿Cuántas unidades de *${product.productName}* deseas pedir?`);
}

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const from = message?.from;
  const text = message?.text?.body;
  if (!from || !text) return res.sendStatus(200);

  const state = await getUserState(from);
  const data = state.data || {};

  switch (state.status) {
    case 'AWAITING_ORDER_TEXT': {
      if (!data.pendingItemsList) {
        data.pendingItemsList = splitOrderText(text);
      }
      await processNextPendingItem(from, data);
      break;
    }
    case 'AWAITING_QUANTITY': {
      const quantity = parseFloat(text);
      if (isNaN(quantity) || quantity <= 0) {
        await sendWhatsAppMessage(from, '❌ Por favor ingresa una cantidad válida.');
        return res.sendStatus(200);
      }
      data.currentItem.quantity = quantity;
      await setUserState(from, 'AWAITING_UOM', data);
      await sendWhatsAppMessage(from, `📏 ¿Qué unidad deseas usar para *${data.currentItem.productName}*? Por ejemplo: cajas, botellas, litros...`);
      break;
    }
    case 'AWAITING_UOM': {
      const unit = normalizeText(text);
      data.currentItem.unit = unit;
      data.orderItems = data.orderItems || [];
      data.orderItems.push(data.currentItem);
      delete data.currentItem;
      await setUserState(from, 'ORDER_IN_PROGRESS', data);
      await processNextPendingItem(from, data);
      break;
    }
    case 'AWAITING_ORDER_ACTION': {
      const input = normalizeText(text);
      if (input.includes('añadir')) {
        await setUserState(from, 'AWAITING_ORDER_TEXT', data);
        await sendWhatsAppMessage(from, '🛒 Ingresa el siguiente producto que deseas añadir.');
      } else if (input.includes('finalizar')) {
        await sendWhatsAppMessage(from, '✅ ¡Gracias por tu pedido! Pronto lo procesaremos.');
        await setUserState(from, 'IDLE');
      } else {
        await sendWhatsAppMessage(from, '❌ Opción no reconocida. Elige una opción del menú.');
      }
      break;
    }
    default: {
      data.pendingItemsList = splitOrderText(text);
      await setUserState(from, 'AWAITING_ORDER_TEXT', data);
      await processNextPendingItem(from, data);
      break;
    }
  }

  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  res.send('Bot activo');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
