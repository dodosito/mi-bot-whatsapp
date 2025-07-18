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
async function getUserState(phoneNumber) { /* ... */ }
async function setUserState(phoneNumber, status, data = {}) { /* ... */ }
async function sendWhatsAppMessage(to, messageBody, messageType = 'text', interactivePayload = null) { /* ... */ }
async function findProductsInCatalog(text) { /* ... */ }
async function showCartSummary(from, data) { /* ... */ }

// --- ¡FUNCIÓN DE IA ACTUALIZADA Y MÁS ROBUSTA! ---
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
      - "sku": El SKU del producto que mejor coincida.
      - "quantity": El número de la cantidad.
      - "unit": La unidad de medida mencionada.
      Si no puedes encontrar alguno de los valores, usa null.
      Responde únicamente con el objeto JSON, sin texto adicional.
    `;

    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'openai/gpt-4o',
                messages: [{ role: 'system', content: prompt }]
            },
            { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } }
        );

        let content = response.data.choices[0].message.content;
        console.log("🧠 Respuesta cruda de la IA:", content);

        // Limpiamos la respuesta para quedarnos solo con el JSON
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


// --- VARIABLES DE ENTORNO Y RUTAS ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
app.get('/', (req, res) => res.status(200).send('Bot activo.'));
app.get('/health', (req, res) => res.sendStatus(200));
app.get('/webhook', (req, res) => { /* ... */ });

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

          case 'AWAITING_ORDER_TEXT':
              // ... (La lógica aquí no cambia, pero ahora la función que llama es más robusta) ...
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
      await sendWhatsAppMessage(from, "Lo siento, estoy teniendo problemas técnicos. Por favor, intenta de nuevo en un momento.");
  }
  
  res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
