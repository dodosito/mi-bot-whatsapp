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
async function getUserState(phoneNumber) { /* ... */ }
async function setUserState(phoneNumber, status, data = {}) { /* ... */ }
async function sendWhatsAppMessage(to, messageBody, messageType = 'text', interactivePayload = null) { /* ... */ }
async function findProductsInCatalog(text) { /* ... */ }
async function showCartSummary(from, data) { /* ... */ }

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
          // ... (sin cambios)
      }
      
      switch (status) {
          case 'IDLE':
          case 'AWAITING_MAIN_MENU_CHOICE':
              // ... (sin cambios)
              break;

          // --- ESTE CASO TIENE LOS NUEVOS LOGS ---
          case 'AWAITING_ORDER_TEXT':
              console.log("DEBUG: Entrando al caso AWAITING_ORDER_TEXT.");
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
                  console.log("DEBUG: Condición > 1 producto cumplida. Iniciando desambiguación.");
                  let clarificationMenu;
                  const validProducts = candidateProducts.filter(p => p.shortName && p.sku);
                  console.log(`DEBUG: ${validProducts.length} productos válidos para mostrar.`);

                  if (validProducts.length > 0 && validProducts.length <= 3) {
                      console.log("DEBUG: Construyendo menú de BOTONES.");
                      clarificationMenu = { type: 'button', body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { buttons: validProducts.map(p => ({ type: 'reply', reply: { id: p.sku, title: p.shortName } })) } };
                  } else if (validProducts.length > 3) {
                      console.log("DEBUG: Construyendo menú de LISTA.");
                      clarificationMenu = { type: 'list', header: { type: 'text', text: 'Múltiples coincidencias' }, body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { button: 'Ver opciones', sections: [{ title: 'Elige una presentación', rows: validProducts.slice(0, 10).map(p => ({ id: p.sku, title: p.shortName, description: p.productName })) }] } };
                  } else {
                      console.log("DEBUG: No hay productos válidos para mostrar. Saliendo.");
                      await sendWhatsAppMessage(from, "Lo siento, encontré coincidencias pero no pude generar las opciones.");
                      break;
                  }
                  
                  console.log("DEBUG: A punto de enviar menú interactivo.");
                  await sendWhatsAppMessage(from, '', 'interactive', clarificationMenu);
                  console.log("DEBUG: Menú enviado. Actualizando estado.");
                  await setUserState(from, 'AWAITING_CLARIFICATION', data);
                  console.log("DEBUG: Estado actualizado a AWAITING_CLARIFICATION.");

              } else if (candidateProducts.length === 1) {
                  console.log("DEBUG: Condición == 1 producto cumplida. Iniciando flujo de preguntas.");
                  const product = candidateProducts[0];
                  // ... (resto de la lógica que ya funcionaba)
              }
              break;
          
          case 'AWAITING_CLARIFICATION':
              // ... (sin cambios)
              break;

          case 'AWAITING_QUANTITY':
             // ... (sin cambios)
              break;

          case 'AWAITING_UOM':
              // ... (sin cambios)
              break;

          case 'AWAITING_ORDER_ACTION':
              // ... (sin cambios)
              break;

          default:
              // ... (sin cambios)
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
