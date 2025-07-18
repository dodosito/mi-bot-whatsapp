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

async function extractOrderDetailsWithAI(userText, candidateProducts) {
    console.log("🤖 Usando IA para extraer detalles del pedido...");
    const productListForPrompt = candidateProducts.map(p => `- SKU: ${p.sku}, Nombre: ${p.productName}, Unidades: [${p.availableUnits.join(", ")}]`).join('\n');

    const prompt = `
      Tu tarea es analizar el texto de un cliente y extraer los detalles de su pedido en formato JSON.
      Usa la siguiente lista de productos como referencia. Solo puedes usar productos de esta lista.
      
      Lista de Productos Válidos:
      ${productListForPrompt}

      Texto del Cliente: "${userText}"

      Analiza el texto y devuelve un único objeto JSON con las claves "sku", "quantity" y "unit".
      - "sku": El SKU del producto que mejor coincida de forma específica.
      - "quantity": El número de la cantidad.
      - "unit": La unidad de medida mencionada.
      Si no puedes encontrar alguno de los valores, usa null.
      Responde únicamente con el objeto JSON, sin texto adicional.
    `;

    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'mistralai/mistral-7b-instruct:free',
                messages: [{ role: 'system', content: prompt }]
            },
            { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } }
        );

        let content = response.data.choices[0].message.content;
        console.log("🧠 Respuesta cruda de la IA:", content);

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("❌ La IA no devolvió un JSON válido.");
            return null;
        }

        const result = JSON.parse(jsonMatch[0]);
        console.log("🧠 IA extrajo (limpio):", result);
        return result;
    } catch (error) {
        console.error("❌ Error en la extracción con IA:", error.message);
        return null;
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
              // ... sin cambios ...
              break;

          // --- ESTA LÓGICA FUE CORREGIDA PARA QUE LA IA Y LAS REGLAS CONVIVAN ---
          case 'AWAITING_ORDER_TEXT':
              if (userMessage === 'back_to_cart') {
                  await showCartSummary(from, data);
                  break;
              }

              // 1. Siempre buscamos candidatos primero para darle contexto a la IA
              const candidateProducts = await findProductsInCatalog(originalText);
              if (candidateProducts.length === 0) {
                  await sendWhatsAppMessage(from, "Lo siento, no encontré productos que coincidan con tu búsqueda.");
                  break;
              }

              // 2. Siempre intentamos que la IA extraiga los detalles
              const extractedDetails = await extractOrderDetailsWithAI(originalText, candidateProducts);

              // 3. Decidimos en base al resultado de la IA
              // Si la IA tuvo éxito y encontró todo, la usamos.
              if (extractedDetails && extractedDetails.sku && extractedDetails.quantity && extractedDetails.unit) {
                  console.log("IA tuvo éxito. Añadiendo al carrito.");
                  const productDoc = await db.collection('products').doc(extractedDetails.sku).get();
                  if (productDoc.exists) {
                      const newOrderItem = { ...productDoc.data(), quantity: extractedDetails.quantity, unit: extractedDetails.unit };
                      if (!data.orderItems) data.orderItems = [];
                      data.orderItems.push(newOrderItem);
                      await showCartSummary(from, data);
                  }
              } 
              // Si la IA falló, AHORA aplicamos nuestras reglas de desambiguación.
              else {
                  console.log("IA falló o le faltó información. Usando Plan B: Desambiguación manual.");
                  if (candidateProducts.length > 1) {
                      let clarificationMenu;
                      const validProducts = candidateProducts.filter(p => p.shortName && p.sku);
                      if (validProducts.length > 0 && validProducts.length <= 3) {
                          clarificationMenu = { type: 'button', body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { buttons: validProducts.map(p => ({ type: 'reply', reply: { id: p.sku, title: p.shortName } })) } };
                      } else if (validProducts.length > 3) {
                          clarificationMenu = { type: 'list', header: { type: 'text', text: 'Múltiples coincidencias' }, body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { button: 'Ver opciones', sections: [{ title: 'Elige una presentación', rows: validProducts.slice(0, 10).map(p => ({ id: p.sku, title: p.shortName, description: p.productName })) }] } };
                      }
                      await sendWhatsAppMessage(from, '', 'interactive', clarificationMenu);
                      await setUserState(from, 'AWAITING_CLARIFICATION', data);
                  } else {
                      // Si la IA falló y solo había 1 candidato, iniciamos el flujo manual.
                      data.pendingProduct = candidateProducts[0];
                      await sendWhatsAppMessage(from, `Encontré "${data.pendingProduct.productName}". ¿Qué cantidad necesitas?`);
                      await setUserState(from, 'AWAITING_QUANTITY', data);
                  }
              }
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
