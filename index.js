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

async function getOrCreateUser(phoneNumber) {
    const userRef = db.collection('users').doc(phoneNumber);
    const doc = await userRef.get();
    if (!doc.exists) {
        console.log(`Creando nuevo perfil de usuario para ${phoneNumber}`);
        const newUser = {
            firstContactAt: admin.firestore.FieldValue.serverTimestamp(),
            lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
            name: `Cliente ${phoneNumber}`,
            sapCustomerId: "1000234", // Dato de ejemplo
            salesOrganization: "1710",
            distributionChannel: "10",
            division: "00"
        };
        await userRef.set(newUser);
        return newUser;
    } else {
        await userRef.update({ lastContactAt: admin.firestore.FieldValue.serverTimestamp() });
        return doc.data();
    }
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
    const cartMenu = { type: 'button', body: { text: summary }, action: { buttons: [{ type: 'reply', reply: { id: 'add_more_products', title: '➕ Añadir más' } }, { type: 'reply', reply: { id: 'finish_order_start', title: '✅ Finalizar Pedido' } }] } };
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
  let userMessage, originalText = '', botResponseLog = '';

  if (message.type === 'text') {
      userMessage = originalText = message.text.body;
  } else if (message.interactive) {
      userMessage = originalText = message.interactive[message.interactive.type].id;
  } else { return res.sendStatus(200); }
  
  try {
      const user = await getOrCreateUser(from); // Obtenemos/creamos al usuario al inicio
      const currentUserState = await getUserState(from);
      let { status, data = {} } = currentUserState;

      if (userMessage.toLowerCase().trim() === 'resetear') {
          await setUserState(from, 'IDLE', {});
          await sendWhatsAppMessage(from, 'Estado reseteado. ✅');
          botResponseLog = 'Estado reseteado.';
      } else {
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
                const candidateProducts = await findProductsInCatalog(originalText);
                if (candidateProducts.length === 0) {
                    await sendWhatsAppMessage(from, "Lo siento, no encontré productos que coincidan con tu búsqueda.");
                } else if (candidateProducts.length > 1) {
                    let clarificationMenu;
                    const validProducts = candidateProducts.filter(p => p.shortName && p.sku);
                    if (validProducts.length > 0 && validProducts.length <= 3) {
                        clarificationMenu = { type: 'button', body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { buttons: validProducts.map(p => ({ type: 'reply', reply: { id: p.sku, title: p.shortName } })) } };
                    } else if (validProducts.length > 3) {
                        clarificationMenu = { type: 'list', body: { text: `Para "${originalText}", ¿a cuál de estos te refieres?` }, action: { button: 'Ver opciones', sections: [{ title: 'Elige una presentación', rows: validProducts.slice(0, 10).map(p => ({ id: p.sku, title: p.shortName, description: p.productName })) }] } };
                    }
                    data.originalTextForClarification = originalText;
                    await sendWhatsAppMessage(from, '', 'interactive', clarificationMenu);
                    await setUserState(from, 'AWAITING_CLARIFICATION', data);
                } else if (candidateProducts.length === 1) {
                    const product = candidateProducts[0];
                    const text = originalText.toLowerCase();
                    const quantityMatch = text.match(/(\d+)(?!ml)/);
                    const quantity = quantityMatch ? parseInt(quantityMatch[0]) : null;
                    let unit = null;
                    if (product.availableUnits) {
                        for (const u of product.availableUnits) {
                            const unitRegex = new RegExp(`\\b${u.toLowerCase()}s?\\b`);
                            if (text.match(unitRegex)) {
                                unit = u;
                                break;
                            }
                        }
                    }
                    if (quantity && unit) {
                        const newOrderItem = { ...product, quantity, unit };
                        if (!data.orderItems) data.orderItems = [];
                        data.orderItems.push(newOrderItem);
                        await showCartSummary(from, data);
                    } else {
                        data.pendingProduct = product;
                        await sendWhatsAppMessage(from, `Encontré "${product.productName}". ¿Qué cantidad necesitas?`);
                        await setUserState(from, 'AWAITING_QUANTITY', data);
                    }
                }
                break;
            
            case 'AWAITING_CLARIFICATION':
                const productDoc = await db.collection('products').doc(userMessage).get();
                if (productDoc.exists) {
                    const product = productDoc.data();
                    const text = data.originalTextForClarification.toLowerCase();
                    const quantityMatch = text.match(/(\d+)(?!ml)/);
                    const quantity = quantityMatch ? parseInt(quantityMatch[0]) : null;
                    let unit = null;
                    if (product.availableUnits) {
                        for (const u of product.availableUnits) {
                            const unitRegex = new RegExp(`\\b${u.toLowerCase()}s?\\b`);
                            if (text.match(unitRegex)) {
                                unit = u;
                                break;
                            }
                        }
                    }
                    delete data.originalTextForClarification;
                    if (quantity && unit) {
                        const newOrderItem = { ...product, quantity, unit };
                        if (!data.orderItems) data.orderItems = [];
                        data.orderItems.push(newOrderItem);
                        await showCartSummary(from, data);
                    } else {
                        data.pendingProduct = product;
                        await sendWhatsAppMessage(from, `Seleccionaste "${product.productName}". ¿Qué cantidad necesitas?`);
                        await setUserState(from, 'AWAITING_QUANTITY', data);
                    }
                }
                break;

            case 'AWAITING_QUANTITY':
                const product = data.pendingProduct;
                const text = normalizeText(originalText);
                const quantityMatch = text.match(/(\d+)(?!ml)/);
                const quantity = quantityMatch ? parseInt(quantityMatch[0]) : null;
                if (!quantity) {
                    botResponseLog = "Por favor, ingresa una cantidad numérica válida.";
                    await sendWhatsAppMessage(from, botResponseLog);
                    break;
                }
                let unit = null;
                if (product.availableUnits) {
                    let bestUnitMatch = { unit: null, distance: 3 };
                    const wordsInText = text.split(' ');
                    wordsInText.forEach(word => {
                        product.availableUnits.forEach(availUnit => {
                            const distance = levenshteinDistance(word, normalizeText(availUnit));
                            if (distance < bestUnitMatch.distance && distance <= 2) {
                                bestUnitMatch = { unit: availUnit, distance: distance };
                            }
                        });
                    });
                    if (bestUnitMatch.distance <= 2) {
                        unit = bestUnitMatch.unit;
                    }
                }
                if (unit) {
                    const newOrderItem = { ...product, quantity, unit };
                    if (!data.orderItems) data.orderItems = [];
                    data.orderItems.push(newOrderItem);
                    delete data.pendingProduct;
                    await showCartSummary(from, data);
                } else if (product.availableUnits && product.availableUnits.length > 1) {
                    data.pendingQuantity = quantity;
                    const unitMenu = { type: 'button', body: { text: `Entendido, ${quantity}. ¿En qué unidad?` }, action: { buttons: product.availableUnits.slice(0, 3).map(u => ({ type: 'reply', reply: { id: u.toLowerCase(), title: u } })) } };
                    await sendWhatsAppMessage(from, '', 'interactive', unitMenu);
                    await setUserState(from, 'AWAITING_UOM', data);
                } else {
                    const singleUnit = (product.availableUnits && product.availableUnits.length === 1) ? product.availableUnits[0] : 'unidad';
                    const newOrderItem = { ...product, quantity, unit: singleUnit };
                    if (!data.orderItems) data.orderItems = [];
                    data.orderItems.push(newOrderItem);
                    delete data.pendingProduct;
                    await showCartSummary(from, data);
                }
                break;

            case 'AWAITING_UOM':
                const selectedUnit = userMessage;
                const newOrderItem = { ...data.pendingProduct, quantity: data.pendingQuantity, unit: selectedUnit };
                if (!data.orderItems) data.orderItems = [];
                data.orderItems.push(newOrderItem);
                delete data.pendingProduct;
                delete data.pendingQuantity;
                await showCartSummary(from, data);
                break;

            case 'AWAITING_ORDER_ACTION':
                if (userMessage === 'add_more_products') {
                    const askMoreMenu = { type: 'button', body: { text: "Claro, ¿qué más deseas añadir?" }, action: { buttons: [{ type: 'reply', reply: { id: 'back_to_cart', title: '↩️ Ver mi pedido' } }] } };
                    await sendWhatsAppMessage(from, '', 'interactive', askMoreMenu);
                    await setUserState(from, 'AWAITING_ORDER_TEXT', data);
                } else if (userMessage === 'finish_order_start') {
                    const confirmMenu = {
                        type: 'button',
                        body: { text: '¿Estás seguro de que deseas finalizar tu pedido?' },
                        action: { buttons: [ { type: 'reply', reply: { id: 'finish_order_confirm_yes', title: '✅ Sí, finalizar' } }, { type: 'reply', reply: { id: 'finish_order_confirm_no', title: '❌ No, volver' } } ] }
                    };
                    await sendWhatsAppMessage(from, '', 'interactive', confirmMenu);
                    await setUserState(from, 'AWAITING_FINAL_CONFIRMATION', data);
                }
                break;
            
            case 'AWAITING_FINAL_CONFIRMATION':
                if (userMessage === 'finish_order_confirm_yes') {
                    const orderNumber = `PEDIDO-${Date.now()}`;
                    botResponseLog = `¡Pedido confirmado! ✅\n\nTu número de orden es: *${orderNumber}*`;
                    
                    const sapPayload = {
                        header: {
                            SalesOrderType: "OR",
                            SalesOrganization: user.salesOrganization,
                            DistributionChannel: user.distributionChannel,
                            Division: user.division,
                            SoldToParty: user.sapCustomerId,
                        },
                        items: data.orderItems.map(item => ({
                            Material: item.sku,
                            RequestedQuantity: item.quantity,
                            RequestedQuantityUnit: item.sapUnitMapping ? (item.sapUnitMapping[item.unit.toLowerCase()] || 'EA') : 'EA',
                            Plant: item.defaultPlant || '1710'
                        }))
                    };
                    
                    const orderData = {
                        orderNumber: orderNumber,
                        status: 'CONFIRMED',
                        orderDate: admin.firestore.FieldValue.serverTimestamp(),
                        items: data.orderItems,
                        sapPayload: sapPayload
                    };

                    await db.collection('users').doc(from).collection('orders').doc(orderNumber).set(orderData);
                    
                    await sendWhatsAppMessage(from, botResponseLog);
                    await setUserState(from, 'IDLE', {});
                } else {
                    await sendWhatsAppMessage(from, "Ok, volvemos a tu pedido.");
                    await showCartSummary(from, data);
                }
                break;

            default:
                await sendWhatsAppMessage(from, 'Lo siento, hubo un error. Empieza de nuevo.');
                await setUserState(from, 'IDLE', {});
                break;
        }
      }

      await db.collection('conversations').add({
          phoneNumber: from,
          userMessage: originalText || userMessage,
          botResponse: botResponseLog || 'Resumen de carrito/menú enviado.',
          status: status,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log("💾 Conversación guardada en Firestore.");

  } catch (error) {
      console.error('❌ ERROR en la lógica del bot:', error);
      await sendWhatsAppMessage(from, "Lo siento, estoy teniendo problemas técnicos.");
  }
  
  res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
