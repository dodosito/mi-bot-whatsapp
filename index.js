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

// --- FUNCIONES DE UTILIDAD (SIN CAMBIOS) ---
async function getUserState(phoneNumber) { /*...*/ }
async function setUserState(phoneNumber, status, data = {}) { /*...*/ }
async function sendWhatsAppMessage(to, messageBody, messageType = 'text', interactivePayload = null) { /*...*/ }

// --- NUEVA FUNCIÓN: EXTRACCIÓN CON IA ---
async function extractOrderDetailsWithAI(userText, candidateProducts) {
    console.log("🤖 Usando IA para extraer detalles del pedido...");
    const productListForPrompt = candidateProducts.map(p => `{sku: '${p.sku}', name: '${p.productName}', units: ['${p.availableUnits.join("', '")}']}`).join(', ');

    const prompt = `
      You are an expert order processing system. Your only task is to extract entities from the user's text based on a list of valid products.
      User's order text: "${userText}"
      List of valid products: [${productListForPrompt}]
      
      Analyze the user's text and determine the exact product SKU, the quantity, and the unit of measure.
      Respond ONLY with a single JSON object. The object must have three keys: "sku", "quantity", and "unit".
      - For "sku", find the best matching product SKU from the provided list.
      - For "quantity", extract the numerical quantity.
      - For "unit", extract the unit of measure.
      If you cannot determine a value for any key, use the value null.

      Example 1:
      User Text: "20 cajas de pilsen 630ml"
      Your Response: {"sku": "CER-PIL-630", "quantity": 20, "unit": "caja"}

      Example 2:
      User Text: "una unidad de cristal en lata"
      Your Response: {"sku": "CER-CRIS-LATA-355", "quantity": 1, "unit": "unidad"}
    `;

    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'openai/gpt-4o', // Usamos un modelo más potente para esta tarea
                messages: [{ role: 'system', content: prompt }],
                response_format: { type: "json_object" } // Forzamos la respuesta a ser JSON
            },
            { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } }
        );

        const result = JSON.parse(response.data.choices[0].message.content);
        console.log("🧠 IA extrajo:", result);
        return result;
    } catch (error) {
        console.error("❌ Error en la extracción con IA:", error);
        return null;
    }
}


async function findProductsInCatalog(text) { /*...*/ }
async function showCartSummary(from, data) { /*...*/ }

// --- VARIABLES DE ENTORNO Y RUTAS ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
app.get('/', (req, res) => res.status(200).send('Bot activo.'));
app.get('/health', (req, res) => res.sendStatus(200));
app.get('/webhook', (req, res) => { /*...*/ });

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

          // --- ESTE ESTADO AHORA ES MUCHO MÁS INTELIGENTE ---
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

              // Intentamos extraer todo con la IA
              const extractedDetails = await extractOrderDetailsWithAI(originalText, candidateProducts);

              if (extractedDetails && extractedDetails.sku && extractedDetails.quantity && extractedDetails.unit) {
                  // ¡La IA encontró todo! Añadimos al carrito directamente.
                  const productDoc = await db.collection('products').doc(extractedDetails.sku).get();
                  if (productDoc.exists) {
                      const newOrderItem = { ...productDoc.data(), quantity: extractedDetails.quantity, unit: extractedDetails.unit };
                      if (!data.orderItems) data.orderItems = [];
                      data.orderItems.push(newOrderItem);
                      await showCartSummary(from, data);
                  }
              } else if (candidateProducts.length === 1) {
                  // Si la IA no pudo pero solo hay un producto posible, volvemos al flujo manual
                  data.pendingProduct = candidateProducts[0];
                  await sendWhatsAppMessage(from, `Encontré "${data.pendingProduct.productName}". ¿Qué cantidad necesitas?`);
                  await setUserState(from, 'AWAITING_QUANTITY', data);
              } else {
                  // Si la IA no pudo y hay varios productos, usamos el menú de desambiguación
                  let clarificationMenu;
                  const validProducts = candidateProducts.filter(p => p.shortName && p.sku);
                  if (validProducts.length > 0 && validProducts.length <= 3) {
                      clarificationMenu = { type: 'button', body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { buttons: validProducts.map(p => ({ type: 'reply', reply: { id: p.sku, title: p.shortName } })) } };
                  } else if (validProducts.length > 3) {
                      clarificationMenu = { type: 'list', header: { type: 'text', text: 'Múltiples coincidencias' }, body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { button: 'Ver opciones', sections: [{ title: 'Elige una presentación', rows: validProducts.slice(0, 10).map(p => ({ id: p.sku, title: p.shortName, description: p.productName })) }] } };
                  }
                  await sendWhatsAppMessage(from, '', 'interactive', clarificationMenu);
                  await setUserState(from, 'AWAITING_CLARIFICATION', data);
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
  }
  
  res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
