import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// --- CONFIGURAÇÕES ---
const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";

// CONFIG UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN;

if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render. O servidor não pode iniciar.");
    process.exit(1);
}
if (!UTMIFY_TOKEN) {
    console.warn("Aviso: Variável de ambiente UTMIFY_TOKEN não configurada. O envio para a UTMify pode falhar.");
}

// --- ARMAZENAMENTO TEMPORÁRIO EM MEMÓRIA ---
// pendingTransactions: Mapeia externalId -> transactionInfo
const pendingTransactions = new Map();
// buckpayIdToExternalId: Mapeia buckpayId -> externalId (para lookup reverso no webhook)
const buckpayIdToExternalId = new Map(); 

const TRANSACTION_LIFETIME_MINUTES = 35;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanupTransactionsInMemory() {
    const now = new Date();
    for (const [externalId, transactionInfo] of pendingTransactions.entries()) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        if ((transactionInfo.status !== 'pending' && elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES) ||
            (transactionInfo.status === 'pending' && elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES)) {
            pendingTransactions.delete(externalId);
            // Também remove do mapa de buckpayId se existir
            if (transactionInfo.buckpayId) {
                buckpayIdToExternalId.delete(transactionInfo.buckpayId);
            }
            console.log(`🧹 Transação ${externalId} (status: ${transactionInfo.status || 'sem status final'}) removida da memória após ${elapsedTimeMinutes.toFixed(0)} minutos.`);
        }
    }
}

setInterval(cleanupTransactionsInMemory, CLEANUP_INTERVAL_MS);
console.log(`Limpeza de transações agendada a cada ${CLEANUP_INTERVAL_MS / 1000 / 60} minutos.`);
// --- FIM DO ARMAZENAMENTO TEMPORÁRIO ---

// --- FUNÇÃO PARA ENVIAR PARA UTMify (Refatorada para reuso) ---
async function sendToUTMify(externalId, status, transactionDataForUTMify) {
    console.log(`[UTMify] Tentando enviar status '${status}' para orderId: ${externalId}`);

    const totalOrderAmount = typeof transactionDataForUTMify.amountInCents === 'number' && !isNaN(transactionDataForUTMify.amountInCents)
                               ? transactionDataForUTMify.amountInCents
                               : 0;
    const gatewayFee = typeof transactionDataForUTMify.gatewayFee === 'number' && !isNaN(transactionDataForUTMify.gatewayFee)
                       ? transactionDataForUTMify.gatewayFee
                       : 0;
    
    let userCommission = totalOrderAmount - gatewayFee;

    if (status === 'paid' && totalOrderAmount > 0 && userCommission <= 0) {
        userCommission = 1;
        console.warn(`[UTMify] Comissão para ${externalId} ajustada para 1 centavo, pois o cálculo resultou em um valor não positivo.`);
    }

    const trackingParamsForUTMify = {
        utm_campaign: transactionDataForUTMify.tracking?.utm_campaign || "",
        utm_content: transactionDataForUTMify.tracking?.utm_content || "",
        utm_medium: transactionDataForUTMify.tracking?.utm_medium || "",
        utm_source: transactionDataForUTMify.tracking?.utm_source || "",
        utm_term: transactionDataForUTMify.tracking?.utm_term || "",
        cid: transactionDataForUTMify.tracking?.cid || transactionDataForUTMify.tracking?.utm_id || externalId
    };

    const bodyForUTMify = {
        orderId: externalId,
        platform: "FreeFireCheckout",
        paymentMethod: "pix",
        status: status,
        createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        approvedDate: status === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
        customer: {
            name: transactionDataForUTMify.customer?.name || "Cliente",
            email: transactionDataForUTMify.customer?.email || "cliente@teste.com",
            phone: transactionDataForUTMify.customer?.phone || "",
            document: transactionDataForUTMify.customer?.document || "",
            country: "BR"
        },
        products: [
            {
                id: transactionDataForUTMify.product?.id || "recarga-ff",
                name: transactionDataForUTMify.product?.name || "Recarga Free Fire",
                quantity: transactionDataForUTMify.offer?.quantity || 1,
                priceInCents: totalOrderAmount,
                planId: transactionDataForUTMify.offer?.id || "basic",
                planName: transactionDataForUTMify.offer?.name || "Plano Básico"
            }
        ],
        commission: {
            totalPriceInCents: totalOrderAmount,
            gatewayFeeInCents: gatewayFee,
            userCommissionInCents: userCommission
        },
        trackingParameters: trackingParamsForUTMify,
        isTest: false
    };

    console.log(`[UTMify] Payload FINAL para '${status}':`, JSON.stringify(bodyForUTMify, null, 2));

    if (!UTMIFY_TOKEN) {
        console.warn("[UTMify Error] UTMIFY_TOKEN não está configurado. Não é possível enviar dados para UTMify.");
        return false;
    }

    try {
        const responseUTMify = await fetch(UTMIFY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-token": UTMIFY_TOKEN
            },
            body: JSON.stringify(bodyForUTMify)
        });

        const resultUTMify = await responseUTMify.json();
        if (!responseUTMify.ok) {
            console.error(`[UTMify Error] Status: ${responseUTMify.status}, Resposta:`, resultUTMify);
            return false;
        } else {
            console.log("[UTMify] Resposta:", resultUTMify);
            return true;
        }
    } catch (utmifyError) {
        console.error("[UTMify Error] Erro ao enviar dados para UTMify:", utmifyError);
        return false;
    }
}
// --- FIM DA FUNÇÃO UTMify ---


// --- MIDDLEWARES ---
app.use(cors({
    origin: 'https://freefirereward.site',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// --- ROTAS ---

app.get("/", (req, res) => {
    res.send("Servidor PagueEasy está online!");
});

app.get("/my-server-ip", async (req, res) => {
    try {
        const response = await fetch("https://api.ipify.org?format=json");
        const data = await response.json();
        res.json({ ip: data.ip });
    } catch (error) {
        console.error("Erro ao obter IP:", error);
        res.status(500).json({ error: "Erro ao obter IP do servidor" });
    }
});

// Rota para criar transação PIX via BuckPay
app.post("/create-payment", async (req, res) => {
    const { amount, email, name, document, phone, product_id, product_name, offer_id, offer_name, discount_price, quantity, tracking } = req.body;

    if (!amount || !email || !name) {
        return res.status(400).json({ error: "Dados obrigatórios (amount, email, name) estão faltando." });
    }

    const externalId = `order_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    console.log(`Gerando pagamento para ${email} com externalId: ${externalId}`);

    const amountInCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountInCents) || amountInCents < 500) {
        return res.status(400).json({ error: "Valor de pagamento inválido ou abaixo do mínimo de R$5,00." });
    }

    let buyerDocument = document;
    if (buyerDocument) {
        buyerDocument = buyerDocument.replace(/\D/g, '');
    }
    
    function generateValidCpf() {
        let cpf = "";
        while (true) {
            cpf = "";
            for (let i = 0; i < 9; i++) cpf += Math.floor(Math.random() * 10);
            let soma = 0;
            for (let i = 0; i < 9; i++) soma += parseInt(cpf[i]) * (10 - i);
            let resto = soma % 11;
            let digito1 = resto < 2 ? 0 : 11 - resto;
            cpf += digito1;
            soma = 0;
            for (let i = 0; i < 10; i++) soma += parseInt(cpf[i]) * (11 - i);
            resto = soma % 11;
            let digito2 = resto < 2 ? 0 : 11 - resto;
            cpf += digito2;
            if (!/^(.)\1+$/.test(cpf)) break;
        }
        return cpf;
    }

    if (!buyerDocument || buyerDocument.length === 0) {
        buyerDocument = generateValidCpf();
        console.warn(`[CREATE PAYMENT] CPF não fornecido ou vazio pelo frontend. Gerando CPF de teste: ${buyerDocument}`);
    } else {
        if (/^(.)\1+$/.test(buyerDocument) && buyerDocument.length === 11) {
            buyerDocument = generateValidCpf();
            console.warn(`[CREATE PAYMENT] CPF gerado pelo frontend é sequencial. Substituindo por CPF de teste: ${buyerDocument}`);
        }
    }

    let cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
    if (cleanPhone.length > 0 && !cleanPhone.startsWith('55')) {
        if (cleanPhone.length === 9) {
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 10 || cleanPhone.length === 11) {
            cleanPhone = `55${cleanPhone}`;
        }
    }
    if (cleanPhone.length < 12) {
        cleanPhone = "5511987654321";
    }
    cleanPhone = cleanPhone.substring(0, 13);

    let offerPayload = null;
    if (offer_id || offer_name || (discount_price !== null && discount_price !== undefined)) {
        offerPayload = {
            id: offer_id || "default_offer_id",
            name: offer_name || "Oferta Padrão",
            discount_price: (discount_price !== null && discount_price !== undefined) ? Math.round(parseFloat(discount_price) * 100) : 0,
            quantity: quantity || 1
        };
    }

    let buckpayTracking = {};
    const incomingTracking = tracking || {};

    buckpayTracking.utm_source = incomingTracking.utm_source || 'direct';
    buckpayTracking.utm_medium = incomingTracking.utm_medium || 'website';
    buckpayTracking.utm_campaign = incomingTracking.utm_campaign || 'no_campaign';
    buckpayTracking.src = incomingTracking.utm_source || 'direct';
    buckpayTracking.utm_id = incomingTracking.xcod || incomingTracking.cid || externalId;
    buckpayTracking.ref = incomingTracking.cid || externalId;
    buckpayTracking.sck = incomingTracking.sck || 'no_sck_value';
    buckpayTracking.utm_term = incomingTracking.utm_term || '';
    buckpayTracking.utm_content = incomingTracking.utm_content || '';

    const payload = {
        external_id: externalId,
        payment_method: "pix",
        amount: amountInCents,
        buyer: {
            name: name,
            email: email,
            document: buyerDocument,
            phone: cleanPhone
        },
        product: product_id && product_name ? { id: product_id, name: product_name } : null,
        offer: offerPayload,
        tracking: buckpayTracking
    };

    console.log("Payload FINAL enviado para BuckPay:", JSON.stringify(payload, null, 2));

    try {
        const response = await fetch(BUCK_PAY_CREATE_TRANSACTION_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BUCK_PAY_API_KEY}`,
                "User-Agent": "Buckpay API"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            console.error(`Erro ao criar pagamento na BuckPay (HTTP status ${response.status}):`, errorDetails);
            return res.status(response.status).json({
                success: false,
                error: "Erro ao criar pagamento na BuckPay.",
                details: errorDetails,
                http_status: response.status
            });
        }

        const data = await response.json();
        console.log("Resposta da BuckPay:", JSON.stringify(data, null, 2));

        if (data.data && data.data.pix && data.data.pix.qrcode_base64) {
            const utmifyNotifiedStatus = new Map();

            // Salva todas as informações relevantes da transação em memória
            pendingTransactions.set(externalId, {
                createdAt: new Date(),
                buckpayId: data.data.id, // Armazena o ID da BuckPay
                status: 'pending',
                tracking: incomingTracking,
                customer: { name, email, document: buyerDocument, phone: cleanPhone },
                product: product_id && product_name ? { id: product_id, name: product_name } : null,
                offer: offerPayload,
                amountInCents: amountInCents,
                gatewayFee: 0,
                utmifyNotifiedStatus: utmifyNotifiedStatus
            });
            // Adiciona o mapeamento do buckpayId para o externalId
            buckpayIdToExternalId.set(data.data.id, externalId); 

            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);

            const sent = await sendToUTMify(
                externalId,
                "waiting_payment",
                {
                    amountInCents: amountInCents,
                    gatewayFee: 0,
                    tracking: incomingTracking,
                    customer: { name, email, document: buyerDocument, phone: cleanPhone },
                    product: product_id && product_name ? { id: product_id, name: product_name } : null,
                    offer: offerPayload
                }
            );

            if (sent) {
                utmifyNotifiedStatus.set("waiting_payment", true);
            }

            res.status(200).json({
                pix: {
                    code: data.data.pix.code,
                    qrcode_base64: data.data.pix.qrcode_base64
                },
                transactionId: externalId
            });
        } else {
            console.error("Resposta inesperada da BuckPay (sem PIX ou dados incompletos):", data);
            res.status(500).json({ success: false, error: "Resposta inesperada da BuckPay (PIX não gerado ou dados incompletos)." });
        }

    } catch (error) {
        console.error("Erro ao processar criação de pagamento (requisição BuckPay):", error);
        res.status(500).json({ success: false, error: "Erro interno ao criar pagamento." });
    }
});

// Rota de Webhook da BuckPay (recebe notificações de status da BuckPay)
app.post("/webhook/buckpay", async (req, res) => {
    console.log("--- START FULL BUCKPAY WEBHOOK BODY ---");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("--- END FULL BUCKPAY WEBHOOK BODY ---");

    const event = req.body.event;
    const data = req.body.data;

    // Tenta obter o externalId pelo buckpayId primeiro, depois pelos campos do webhook
    let externalIdFromWebhook = data.external_id || data.tracking?.ref || data.tracking?.utm_id;
    const buckpayIdFromWebhook = data.id; // O ID da transação da BuckPay

    // *** Lógica Adicional: Tenta encontrar o externalId usando o buckpayId ***
    let transactionInfo;
    if (buckpayIdFromWebhook) {
        const storedExternalId = buckpayIdToExternalId.get(buckpayIdFromWebhook);
        if (storedExternalId) {
            transactionInfo = pendingTransactions.get(storedExternalId);
            if (transactionInfo) {
                console.log(`✅ Webhook: Transação encontrada em memória via buckpayId '${buckpayIdFromWebhook}' com externalId '${storedExternalId}'.`);
                // Se encontrou via buckpayId, sobrescreve o externalIdFromWebhook para garantir consistência
                externalIdFromWebhook = storedExternalId; 
            }
        }
    }
    // Se não encontrou via buckpayId, tenta buscar pelo externalId que veio no webhook (comportamento original)
    if (!transactionInfo && externalIdFromWebhook) {
        transactionInfo = pendingTransactions.get(externalIdFromWebhook);
        if (transactionInfo) {
            console.log(`✅ Webhook: Transação encontrada em memória via externalId '${externalIdFromWebhook}'.`);
        }
    }

    const currentBuckpayStatus = data.status;
    
    const gatewayFeeFromWebhook = data.fees?.gateway_fee !== undefined && data.fees?.gateway_fee !== null ? data.fees.gateway_fee : 0;
    const amountFromWebhook = typeof data.total_amount === 'number' ? data.total_amount : (typeof data.amount === 'number' ? data.amount : 0);


    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${currentBuckpayStatus}', ID BuckPay: '${buckpayIdFromWebhook}', External ID (deduzido): '${externalIdFromWebhook}'`);

    if (!externalIdFromWebhook && !buckpayIdFromWebhook) {
        console.warn("Webhook recebido sem externalId ou buckpayId reconhecível. Ignorando.");
        return res.status(200).send("Webhook recebido (IDs não encontrados).");
    }

    // --- Cenário 1: Transação NÃO está em memória ---
    if (!transactionInfo) {
        console.warn(`Webhook para externalId ${externalIdFromWebhook} (ou BuckPay ID ${buckpayIdFromWebhook}) recebido, mas transação NÃO ENCONTRADA EM MEMÓRIA. Isso pode significar que expirou, foi concluída e limpa, ou nunca existiu.`);

        if (currentBuckpayStatus === 'paid') {
            console.warn(`Tentando enviar status 'paid' para UTMify mesmo sem encontrar transação ${externalIdFromWebhook} em memória.`);
            // IMPORTANTE: Aqui, usamos os dados diretamente do webhook, pois não temos os dados originais em memória.
            await sendToUTMify(
                externalIdFromWebhook || buckpayIdFromWebhook, // Usa o externalId ou buckpayId como fallback para orderId na UTMify
                "paid",
                {
                    amountInCents: amountFromWebhook,
                    gatewayFee: gatewayFeeFromWebhook,
                    tracking: data.tracking,
                    customer: data.buyer,
                    product: data.product,
                    offer: data.offer
                }
            );
        }
        return res.status(200).send("Webhook recebido com sucesso (transação não encontrada em memória).");
    }

    // --- Cenário 2: Transação ESTÁ em memória ---
    
    transactionInfo.gatewayFee = gatewayFeeFromWebhook;
    transactionInfo.amountInCents = amountFromWebhook;

    console.log(`Gateway Fee para ${externalIdFromWebhook} atualizado em memória para ${transactionInfo.gatewayFee}.`);
    console.log(`Total amount para ${externalIdFromWebhook} atualizado em memória para ${transactionInfo.amountInCents}.`);
            
    transactionInfo.buckpayId = buckpayIdFromWebhook || transactionInfo.buckpayId; // Garante que o buckpayId esteja atualizado
    transactionInfo.customer = data.buyer || transactionInfo.customer;
    transactionInfo.product = data.product || transactionInfo.product;
    transactionInfo.offer = data.offer || transactionInfo.offer;
    
    let shouldSendToUTMify = false;
    let utmifyStatusToSend = currentBuckpayStatus;

    if (transactionInfo.status !== currentBuckpayStatus) {
        console.log(`Status da transação ${externalIdFromWebhook} MUDOU de '${transactionInfo.status}' para '${currentBuckpayStatus}'.`);
        transactionInfo.status = currentBuckpayStatus;
        shouldSendToUTMify = true;
    } else {
        console.log(`❕ Webhook para ${externalIdFromWebhook} recebido, mas status '${currentBuckpayStatus}' já é o mesmo em memória.`);
        if (currentBuckpayStatus === 'paid') {
            if (transactionInfo.utmifyNotifiedStatus.get("paid")) {
                console.log(`  --> Status 'paid' já foi notificado para UTMify para ${externalIdFromWebhook}. Ignorando re-envio.`);
                shouldSendToUTMify = false;
            } else {
                console.warn(`  --> Status 'paid' em memória, mas não marcado como notificado. Tentando enviar para UTMify.`);
                shouldSendToUTMify = true;
            }
        } else {
            shouldSendToUTMify = false;
        }
    }

    if (shouldSendToUTMify) {
        const sent = await sendToUTMify(
            externalIdFromWebhook,
            utmifyStatusToSend,
            {
                amountInCents: transactionInfo.amountInCents,
                gatewayFee: transactionInfo.gatewayFee,
                tracking: transactionInfo.tracking,
                customer: transactionInfo.customer,
                product: transactionInfo.product,
                offer: transactionInfo.offer
            }
        );

        if (sent) {
            transactionInfo.utmifyNotifiedStatus.set(utmifyStatusToSend, true);
        }
    }

    res.status(200).send("Webhook recebido com sucesso!");
});

// Rota de Consulta de Status para o Frontend (Lendo APENAS do Map em Memória)
app.get("/check-order-status", async (req, res) => {
    const externalId = req.query.id;

    if (!externalId) {
        return res.status(400).json({ error: "ID externo da transação não fornecido." });
    }

    const transactionInfo = pendingTransactions.get(externalId);
    const now = new Date();

    if (transactionInfo) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES) {
            transactionInfo.status = 'expired';
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
        }

        console.log(`Retornando status em memória para ${externalId}: ${transactionInfo.status}`);
        return res.status(200).json({ success: true, status: transactionInfo.status });

    } else {
        console.warn(`Consulta para externalId ${externalId}, mas transação NÃO ENCONTRADA EM MEMÓRIA. Isso pode significar que expirou, foi concluída e limpa, ou nunca existiu.`);
        return res.status(200).json({ success: true, status: 'not_found_or_expired' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));