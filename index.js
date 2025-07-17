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
            if (product.searchTerms.includes(keyword)) score++;
        });
        if (score > maxScore) maxScore = score;
        return { ...product, score };
    });
    return scoredProducts.filter(p => p.score === maxScore);
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

app.get('/health', (req, res) => res.sendStatus(200));

// --- ¡NUEVA RUTA PRINCIPAL! ---
// Esta ruta le responde a Railway que el bot está vivo.
app.get('/', (req, res) => {
    res.status(200).send('El bot de WhatsApp está activo y escuchando. ¡Hola desde la raíz!');
});

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

// --- RUTA PRINCIPAL PARA RECIBIR MENSAJES (SIN CAMBIOS) ---
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
    
    const currentUserState = await getUserState(from);
    let { status, data = {} } = currentUserState;

    try {
        if (userMessage.toLowerCase().trim() === 'resetear') {
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, 'Estado reseteado. ✅');
            return res.sendStatus(200);
        }
        
        // ... (toda la lógica del switch case permanece igual)
        switch (status) {
            // ...
        }
    } catch (error) {
        console.error('❌ ERROR en la lógica del bot:', error);
    }
    
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
