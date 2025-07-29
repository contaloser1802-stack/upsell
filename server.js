import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // Node.js fetch API, já está ok

const app = express();

// --- CONFIGURAÇÕES ---
const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";

// CONFIG UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN || "SEU_TOKEN_REAL_AQUI"; // Certifique-se de que este é o token REAL no Render!

if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render.");
    process.exit(1);
}
if (UTMIFY_TOKEN === "SEU_TOKEN_REAL_AQUI" && !process.env.UTMIFY_TOKEN) {
    console.warn("Aviso: Variável de ambiente UTMIFY_TOKEN não configurada e token hardcoded ainda é o placeholder. Configure-o!");
}


// --- ARMAZENAMENTO TEMPORÁRIO EM MEMÓRIA ---
// Chave: externalId
// Valor: {
//   createdAt: Date,
//   buckpayId: string,
//   status: string (e.g., 'pending', 'paid', 'expired', 'refunded')
//   tracking: object, // Armazenará os parâmetros de tracking originais da BuckPay
//   customer: object,
//   product: object,
//   offer: object,
//   amountInCents: number, // Este é o valor TOTAL da transação (pode ser atualizado pelo webhook)
//   gatewayFee: number, // Armazenará a taxa de gateway
//   utmifyNotifiedStatus: Map<string, boolean> // NOVO: Para rastrear quais status já foram enviados para UTMify
// }
const pendingTransactions = new Map();
const TRANSACTION_LIFETIME_MINUTES = 35;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanupTransactionsInMemory() {
    const now = new Date();
    for (const [externalId, transactionInfo] of pendingTransactions.entries()) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        // Remove transações se não estiverem pendentes E se já tiverem passado do tempo de vida,
        // OU se estiverem pendentes e excederam o tempo de vida (para PIX não pago).
        if ((transactionInfo.status !== 'pending' && elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES) ||
            (transactionInfo.status === 'pending' && elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES)) {
            pendingTransactions.delete(externalId);
            console.log(`🧹 Transação ${externalId} (status: ${transactionInfo.status || 'sem status final'}) removida da memória após ${elapsedTimeMinutes.toFixed(0)} minutos.`);
        }
    }
}

setInterval(cleanupTransactionsInMemory, CLEANUP_INTERVAL_MS);
console.log(`Limpeza de transações agendada a cada ${CLEANUP_INTERVAL_MS / 1000 / 60} minutos.`);
// --- FIM DO ARMAZENAMENTO TEMPORÁRIO ---

// --- FUNÇÃO PARA ENVIAR PARA UTMify (Refatorada para reuso) ---
async function sendToUTMify(orderData, externalId, trackingDataFromMemory, status, customerData, productData, offerData, gatewayFee) {
    console.log(`[UTMify] Tentando enviar status '${status}' para orderId: ${externalId}`);

    const totalOrderAmount = orderData.amountInCents || 0; // Garante que é um número, mesmo que 0
    let userCommission = totalOrderAmount - (gatewayFee || 0);

    // Garante que a comissão seja pelo menos 1 centavo para 'paid' se o valor original for > 0 e a comissão cair para <= 0
    // Isso é uma medida de segurança para evitar 0 ou valores negativos em casos extremos.
    if (status === 'paid' && totalOrderAmount > 0 && userCommission <= 0) {
        userCommission = 1;
        console.warn(`[UTMify] Comissão para ${externalId} ajustada para 1 centavo, pois o cálculo resultou em ${totalOrderAmount - (gatewayFee || 0)}.`);
    }

    // === INÍCIO DA CORREÇÃO DE UTMIFY ===
    // Agora, garantimos que todos os campos utm_ estejam presentes, mesmo que como string vazia.
    const trackingParamsForUTMify = {
        utm_campaign: trackingDataFromMemory?.utm_campaign || "",
        utm_content: trackingDataFromMemory?.utm_content || "",
        utm_medium: trackingDataFromMemory?.utm_medium || "",
        utm_source: trackingDataFromMemory?.utm_source || "",
        utm_term: trackingDataFromMemory?.utm_term || "",
        // Prioriza cid, depois utm_id, e por último externalId
        cid: trackingDataFromMemory?.cid || trackingDataFromMemory?.utm_id || externalId
    };
    // === FIM DA CORREÇÃO DE UTMIFY ===


    const bodyForUTMify = {
        orderId: externalId,
        platform: "FreeFireCheckout",
        paymentMethod: "pix",
        status: status,
        createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        approvedDate: status === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
        customer: {
            name: customerData?.name || "Cliente",
            email: customerData?.email || "cliente@teste.com",
            phone: customerData?.phone || "",
            document: customerData?.document || "",
            country: "BR"
        },
        products: [
            {
                id: productData?.id || "recarga-ff",
                name: productData?.name || "Recarga Free Fire",
                quantity: offerData?.quantity || 1,
                priceInCents: totalOrderAmount, // Sempre usa o valor total da transação aqui
                planId: offerData?.id || "basic",
                planName: offerData?.name || "Plano Básico"
            }
        ],
        commission: {
            totalPriceInCents: totalOrderAmount, // Valor total do pedido
            gatewayFeeInCents: gatewayFee, // Taxa do gateway
            userCommissionInCents: userCommission // Comissão líquida para o afiliado/usuário
        },
        trackingParameters: trackingParamsForUTMify, // Usa o objeto corrigido
        isTest: false
    };

    console.log(`[UTMify] Payload FINAL para '${status}':`, JSON.stringify(bodyForUTMify, null, 2));

    try {
        const responseUTMify = await fetch(UTMIFY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-token": UTMIFY_TOKEN // Mantém o nome da variável de ambiente que você está usando
            },
            body: JSON.stringify(bodyForUTMify)
        });

        const resultUTMify = await responseUTMify.json();
        if (!responseUTMify.ok) {
            console.error(`[UTMify Error] Status: ${responseUTMify.status}, Resposta:`, resultUTMify);
            return false; // Indica falha no envio
        } else {
            console.log("[UTMify] Resposta:", resultUTMify);
            return true; // Indica sucesso no envio
        }
    } catch (utmifyError) {
        console.error("[UTMify Error] Erro ao enviar dados para UTMify:", utmifyError);
        return false; // Indica falha no envio
    }
}
// --- FIM DA FUNÇÃO UTMify ---


// --- MIDDLEWARES ---
app.use(cors({
    origin: 'https://freefirereward.site', // Permite requisições do seu frontend
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

    // --- Tratamento do CPF para garantir que seja válido para a BuckPay ---
    let buyerDocument = document; // Pega o que veio do frontend
    if (buyerDocument) {
        buyerDocument = buyerDocument.replace(/\D/g, ''); // Remove caracteres não numéricos
    }
    
    // Função para gerar um CPF matematicamente válido (usada como fallback)
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
            // Evita CPFs com todos os dígitos iguais (ex: 111.111.111-11), que são válidos matematicamente mas podem ser rejeitados por algumas APIs
            if (!/^(.)\1+$/.test(cpf)) break;
        }
        return cpf;
    }

    // Se o documento não foi fornecido pelo frontend, ou está vazio após limpeza, use um CPF de teste válido gerado.
    if (!buyerDocument || buyerDocument.length === 0) {
        buyerDocument = generateValidCpf(); // Gera um CPF válido para testes
        console.warn(`[CREATE PAYMENT] CPF não fornecido ou vazio pelo frontend. Gerando CPF de teste: ${buyerDocument}`);
    } else {
        // Se um CPF foi fornecido, mas é um dos padrões "fáceis" que podem ser rejeitados, substitua por um gerado.
        if (/^(.)\1+$/.test(buyerDocument) && buyerDocument.length === 11) {
            buyerDocument = generateValidCpf(); // Força um CPF de teste gerado
            console.warn(`[CREATE PAYMENT] CPF gerado pelo frontend é sequencial. Substituindo por CPF de teste: ${buyerDocument}`);
        }
    }
    // --- FIM DO TRATAMENTO DO CPF ---

    let cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    if (cleanPhone.length > 0 && !cleanPhone.startsWith('55')) {
        if (cleanPhone.length === 9) { // Ex: 912345678 (sem DDD) -> assume DDD 11
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 10 || cleanPhone.length === 11) { // Ex: 11912345678 (com DDD)
            cleanPhone = `55${cleanPhone}`;
        }
    }
    if (cleanPhone.length < 12) {
        cleanPhone = "5511987654321"; // Default phone for testing if not provided properly
    }
    cleanPhone = cleanPhone.substring(0, 13); // Garante que o número não exceda 13 dígitos

    let offerPayload = null;
    // Verifica se há qualquer informação relevante da oferta para criar o payload.
    // O critério é ter 'offer_id' ou 'offer_name' ou 'discount_price' explicitamente definido.
    if (offer_id || offer_name || (discount_price !== null && discount_price !== undefined)) {
        offerPayload = {
            id: offer_id || "default_offer_id",
            name: offer_name || "Oferta Padrão",
            discount_price: (discount_price !== null && discount_price !== undefined) ? Math.round(parseFloat(discount_price) * 100) : 0,
            quantity: quantity || 1
        };
    }

    let buckpayTracking = {};
    // Garantir que tracking seja um objeto antes de acessar suas propriedades
    const incomingTracking = tracking || {}; 

    buckpayTracking.utm_source = incomingTracking.utm_source || 'direct';
    buckpayTracking.utm_medium = incomingTracking.utm_medium || 'website';
    buckpayTracking.utm_campaign = incomingTracking.utm_campaign || 'no_campaign';
    buckpayTracking.src = incomingTracking.utm_source || 'direct';
    buckpayTracking.utm_id = incomingTracking.xcod || incomingTracking.cid || externalId; // prioriza xcod, depois cid
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
            document: buyerDocument, // <--- AGORA USA O CPF TRATADO!
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
                "User-Agent": "Buckpay API" // Boa prática para identificar sua aplicação
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

            pendingTransactions.set(externalId, {
                createdAt: new Date(),
                buckpayId: data.data.id,
                status: 'pending',
                tracking: incomingTracking, // Armazena o tracking original do frontend/request body
                customer: { name, email, document: buyerDocument, phone: cleanPhone },
                product: product_id && product_name ? { id: product_id, name: product_name } : null,
                offer: offerPayload,
                amountInCents: amountInCents, // Stores the initial total amount
                gatewayFee: 0, // Será atualizado pelo webhook se disponível
                utmifyNotifiedStatus: utmifyNotifiedStatus
            });
            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);

            const sent = await sendToUTMify(
                { amountInCents: amountInCents }, // Pass the initial total amount here
                externalId,
                incomingTracking, // Usa o tracking original do frontend
                "waiting_payment",
                { name, email, document: buyerDocument, phone: cleanPhone },
                product_id && product_name ? { id: product_id, name: product_name } : null,
                offerPayload,
                0 // Gateway fee é 0 nesta fase
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
            console.error("Resposta inesperada da BuckPay (sem PIX):", data);
            res.status(500).json({ success: false, error: "Resposta inesperada da BuckPay (PIX não gerado)." });
        }

    } catch (error) {
        console.error("Erro ao processar criação de pagamento (requisição BuckPay):", error);
        res.status(500).json({ success: false, error: "Erro interno ao criar pagamento." });
    }
});

// Rota de Webhook da BuckPay (recebe notificações de status da BuckPay)
app.post("/webhook/buckpay", async (req, res) => {
    // --- START FULL BUCKPAY WEBHOOK BODY (para depuração) ---
    console.log("--- START FULL BUCKPAY WEBHOOK BODY ---");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("--- END FULL BUCKPAY WEBHOOK BODY ---");

    const event = req.body.event;
    const data = req.body.data;

    let externalIdFromWebhook = data.tracking?.ref || data.tracking?.utm_id || data.external_id;
    const currentBuckpayStatus = data.status;
    // A taxa de gateway vem em data.fees.gateway_fee, mas pode não estar presente para todos os eventos
    const gatewayFeeFromWebhook = data.fees?.gateway_fee !== undefined ? data.fees.gateway_fee : 0; 

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${currentBuckpayStatus}', ID BuckPay: '${data.id}', External ID: '${externalIdFromWebhook}'`);

    if (!externalIdFromWebhook) {
        console.warn("Webhook recebido sem externalId reconhecível. Ignorando.");
        return res.status(200).send("Webhook recebido (externalId não encontrado).");
    }

    let transactionInfo = pendingTransactions.get(externalIdFromWebhook);

    // --- Cenário 1: Transação NÃO está em memória ---
    if (!transactionInfo) {
        console.warn(`Webhook para externalId ${externalIdFromWebhook} recebido, mas transação NÃO ENCONTRADA EM MEMÓRIA. Isso pode significar que expirou, foi concluída e limpa, ou nunca existiu.`);

        if (currentBuckpayStatus === 'paid') {
            console.warn(`Tentando enviar status 'paid' para UTMify mesmo sem encontrar transação em memória: ${externalIdFromWebhook}`);
            // Usa os dados do webhook, priorizando o amount do webhook para o total da ordem
            // e os dados de cliente/produto/oferta do webhook.
            // Para o tracking, usa o tracking do webhook como fallback (menos ideal que o original).
            await sendToUTMify(
                { amountInCents: data.total_amount || data.amount || 0 }, // Use total_amount ou amount do webhook
                externalIdFromWebhook,
                data.tracking, // Usa o tracking do próprio webhook (menos ideal, mas necessário como fallback)
                "paid",
                data.buyer,
                data.product,
                data.offer,
                gatewayFeeFromWebhook
            );
        }
        return res.status(200).send("Webhook recebido com sucesso (transação não encontrada em memória).");
    }

    // --- Cenário 2: Transação ESTÁ em memória ---

    // Sempre atualiza o gatewayFee se o webhook o fornecer
    if (gatewayFeeFromWebhook > 0) {
        transactionInfo.gatewayFee = gatewayFeeFromWebhook;
        console.log(`Gateway Fee para ${externalIdFromWebhook} atualizado em memória para ${transactionInfo.gatewayFee}.`);
    }
    
    // Atualiza o amountInCents em memória com o valor mais recente do webhook.
    // O webhook de 'paid' geralmente tem o valor final mais preciso, incluindo descontos/upsells.
    if (data.total_amount !== undefined && data.total_amount !== null) {
        transactionInfo.amountInCents = data.total_amount;
        console.log(`Total amount para ${externalIdFromWebhook} atualizado em memória para ${transactionInfo.amountInCents}.`);
    } else if (data.amount !== undefined && data.amount !== null) {
        // Fallback para 'amount' se 'total_amount' não estiver presente
        transactionInfo.amountInCents = data.amount;
        console.log(`Amount para ${externalIdFromWebhook} atualizado em memória para ${transactionInfo.amountInCents}.`);
    }
        
    // Garante que os dados mais recentes do webhook BuckPay estejam na memória
    transactionInfo.buckpayId = data.id;
    // Atualiza customer/product/offer se os dados do webhook forem mais completos
    transactionInfo.customer = data.buyer || transactionInfo.customer;
    transactionInfo.product = data.product || transactionInfo.product;
    transactionInfo.offer = data.offer || transactionInfo.offer;
    
    // Para as UTMs, o tracking salvo na memória (`transactionInfo.tracking`) na criação do pedido é o mais relevante,
    // pois ele veio do seu frontend.
    // O `data.tracking` do webhook da BuckPay pode ser menos granular,
    // então continuamos usando `transactionInfo.tracking` como a fonte para a UTMify.

    // Lógica para enviar para UTMify apenas quando necessário (idempotência aprimorada)
    let shouldSendToUTMify = false;
    let utmifyStatusToSend = currentBuckpayStatus;

    if (transactionInfo.status !== currentBuckpayStatus) {
        console.log(`Status da transação ${externalIdFromWebhook} MUDOU de '${transactionInfo.status}' para '${currentBuckpayStatus}'.`);
        transactionInfo.status = currentBuckpayStatus;
        shouldSendToUTMify = true;
    } else {
        console.log(`❕ Webhook para ${externalIdFromWebhook} recebido, mas status '${currentBuckpayStatus}' já é o mesmo em memória.`);
        // Mesmo que o status seja o mesmo, se for 'paid' e ainda não notificamos, notifique.
        // Isso cobre casos onde o webhook de 'paid' é enviado múltiplas vezes.
        if (currentBuckpayStatus === 'paid') {
            if (transactionInfo.utmifyNotifiedStatus.get("paid")) {
                console.log(`  --> Status 'paid' já foi notificado para UTMify para ${externalIdFromWebhook}. Ignorando re-envio.`);
                shouldSendToUTMify = false;
            } else {
                console.warn(`  --> Status 'paid' em memória, mas não marcado como notificado. Tentando enviar para UTMify.`);
                shouldSendToUTMify = true;
            }
        } else {
            shouldSendToUTMify = false; // Para outros status, não re-envie se já foi processado
        }
    }

    if (shouldSendToUTMify) {
        const sent = await sendToUTMify(
            { amountInCents: transactionInfo.amountInCents }, // Use o amount TOTAL atualizado da memória
            externalIdFromWebhook,
            transactionInfo.tracking, // Use o tracking original salvo na memória
            utmifyStatusToSend,
            transactionInfo.customer,
            transactionInfo.product,
            transactionInfo.offer,
            transactionInfo.gatewayFee // Use a taxa de gateway atualizada
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

        // Se a transação ainda está 'pending' e excedeu o tempo de vida, marca como 'expired'.
        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES) {
            transactionInfo.status = 'expired';
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
            // Poderíamos enviar 'cancelled' para UTMify aqui se o frontend precisar saber.
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