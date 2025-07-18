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
    return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function levenshteinDistance(a, b) {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i += 1) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j += 1) matrix[j][0] = j;
    for (let j = 1; j <= b.length; j += 1) {
        for (let i = 1; i <= a.length; i += 1) {
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
            if (product.searchTerms.map(term => normalizeText(term)).includes(keyword)) score += 3;
            if (normalizedProductName.includes(keyword)) score += 1;
            product.searchTerms.forEach(term => {
                const distance = levenshteinDistance(keyword, normalizeText(term));
                if (distance > 0 && distance <= 2) score += 2;
            });
        });
        if (score > 0) {
            if (score > maxScore) maxScore = score;
            scoredProducts.push({ ...product, score });
        }
    });
    if (maxScore === 0) return [];
    const bestMatches = scoredProducts.filter(p => p.score >= maxScore);
    console.log(`✨ Mejores coincidencias encontradas (score >= ${maxScore}):`, bestMatches.map(p => p.productName));
    return bestMatches;
}

// --- NUEVA FUNCIÓN DE IA PARA DIVIDIR LISTAS ---
async function splitTextIntoItemsAI(userText) {
    console.log("🤖 Usando IA para dividir la lista de productos...");
    const prompt = `
      Tu única tarea es analizar el texto de un cliente y separarlo en una lista de productos individuales.
      Corrige errores de tipeo obvios.
      Texto del Cliente: "${userText}"
      Responde únicamente con un array de strings en formato JSON.
      Ejemplo:
      Texto del Cliente: "quiero 20 cajas de pilsen 630ml y 10 paquetes de coca-cola, tambien una servesa cristall"
      Tu Respuesta:
      ["20 cajas de pilsen 630ml", "10 paquetes de coca-cola", "una cerveza cristal"]
    `;
    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'nousresearch/nous-hermes-2-mixtral-8x7b-dpo:free',
            messages: [{ role: 'system', content: prompt }]
        }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } });
        let content = response.data.choices[0].message.content;
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];
        return JSON.parse(jsonMatch[0]);
    } catch (error) {
        console.error("❌ Error en la división con IA:", error.message);
        return [];
    }
}

// --- NUEVA FUNCIÓN PARA PROCESAR LA COLA DE PEDIDOS ---
async function processNextItemInQueue(from, data) {
    console.log("🔄 Procesando siguiente ítem en la cola...");
    if (!data.itemsQueue || data.itemsQueue.length === 0) {
        console.log("✅ Cola de ítems vacía. Mostrando resumen final.");
        await showCartSummary(from, data);
        return;
    }

    const nextItemText = data.itemsQueue.shift(); // Sacamos el primer ítem
    data.currentItemText = nextItemText; // Lo guardamos por si hay ambigüedad
    await setUserState(from, 'PROCESSING_ITEM', data);
    
    // Disparamos el procesamiento del ítem actual
    await handleIncomingMessage(from, { status: 'PROCESSING_ITEM', data }, nextItemText);
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

// --- FUNCIÓN CENTRAL REFACTORIZADA PARA MANEJAR LÓGICA ---
async function handleIncomingMessage(from, currentUserState, originalText) {
    let { status, data = {} } = currentUserState;
    let userMessage = originalText;
    let botResponseLog = '';

    switch (status) {
        // ... (el resto de los casos van aquí)
    }

    await db.collection('conversations').add({
        phoneNumber: from,
        userMessage: originalText || userMessage,
        botResponse: botResponseLog || 'Resumen/menú enviado.',
        status: status,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("💾 Conversación guardada en Firestore.");
}


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
      userMessage = originalText = message.interactive[message.interactive.type].id;
  } else { return res.sendStatus(200); }
  
  try {
      const currentUserState = await getUserState(from);
      let { status, data = {} } = currentUserState;

      if (userMessage.toLowerCase().trim() === 'resetear') {
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, 'Estado reseteado. ✅');
          return res.sendStatus(200);
      }
      
      // La lógica principal ahora está dentro de la función handleIncomingMessage
      // Esto nos permite llamarla de forma recursiva para procesar la cola
      await handleIncomingMessage(from, { status, data }, originalText);

  } catch (error) {
      console.error('❌ ERROR en la lógica del bot:', error);
      await sendWhatsAppMessage(from, "Lo siento, estoy teniendo problemas técnicos.");
  }
  
  res.sendStatus(200);
});

// Refactorización de la lógica principal a una función separada
async function mainLogic(from, status, data, originalText, userMessage) {
    let botResponseLog = '';
    switch (status) {
        case 'IDLE':
        case 'AWAITING_MAIN_MENU_CHOICE':
            if (userMessage === 'start_order') {
                botResponseLog = "Por favor, ingresa tu pedido. Puedes incluir varios productos.\n\n*(Por ej: 5 cajas de cerveza pilsen y 3 gaseosas)*";
                await sendWhatsAppMessage(from, botResponseLog);
                await setUserState(from, 'AWAITING_ORDER_TEXT', { orderItems: [] });
            } else {
                const mainMenu = { type: "button", body: { text: `¡Hola! Soy tu asistente virtual.` }, action: { buttons: [{ type: "reply", reply: { id: "start_order", title: "🛒 Realizar Pedido" } }, { type: "reply", reply: { id: "contact_agent", title: "🗣️ Hablar con asesor" } }] } };
                await sendWhatsAppMessage(from, '', 'interactive', mainMenu);
                botResponseLog = "Menú principal enviado.";
                await setUserState(from, 'AWAITING_MAIN_MENU_CHOICE', {});
            }
            break;

        case 'AWAITING_ORDER_TEXT':
            const items = await splitTextIntoItemsAI(originalText);
            if (items.length > 0) {
                data.itemsQueue = items;
                await processNextItemInQueue(from, data);
            } else {
                await sendWhatsAppMessage(from, "No pude identificar productos en tu pedido. Por favor, intenta de nuevo.");
            }
            break;
        
        case 'PROCESSING_ITEM':
            const candidateProducts = await findProductsInCatalog(originalText);
            if (candidateProducts.length === 0) {
                await sendWhatsAppMessage(from, `No encontré productos para "${originalText}". Saltando al siguiente ítem.`);
                await processNextItemInQueue(from, data);
            } else if (candidateProducts.length > 1) {
                // ... (lógica de desambiguación) ...
            } else if (candidateProducts.length === 1) {
                // ... (lógica de extracción y/o preguntas) ...
            }
            break;

        // ... otros casos como AWAITING_CLARIFICATION, AWAITING_QUANTITY, etc.
    }
}


app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
