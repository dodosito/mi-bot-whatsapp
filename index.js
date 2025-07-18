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

// --- UTILIDAD PARA NORMALIZAR TEXTO ---
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

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
  const normalizedText = normalizeText(text);
  const searchKeywords = normalizedText.split(' ').filter(w => w.length > 2);
  if (searchKeywords.length === 0) return [];
  const productsRef = db.collection('products');
  const snapshot = await productsRef.get();
  if (snapshot.empty) return [];

  let maxScore = 0;
  const scoredProducts = snapshot.docs.map(doc => {
    const product = doc.data();
    let score = 0;
    const normalizedProductName = normalizeText(product.productName);

    for (const keyword of searchKeywords) {
      if (product.searchTerms?.includes(keyword)) score += 2;
      if (normalizedProductName.includes(keyword)) score += 1;
    }
    if (score > maxScore) maxScore = score;
    return { ...product, score };
  });

  const bestMatches = scoredProducts.filter(p => p.score === maxScore && maxScore > 0);
  console.log(`✨ Mejores coincidencias encontradas:`, bestMatches.map(p => p.productName));
  return bestMatches;
}

// --- ENDPOINTS BÁSICOS ---
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

// --- EXPORTAR APP PARA DEPLOY EN RAILWAY ---
module.exports = app;

// --- INICIAR SERVIDOR ---
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
  });
}
