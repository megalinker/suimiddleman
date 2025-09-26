import express from 'express';
import cors from 'cors';
import { config as dotenvConfig } from 'dotenv';
import { SuiBlockchainService } from './services/sui-blockchain';
import { IdolCreateRequest, Env, NETWORKS, SuiNetwork } from './types';

// Load environment variables from .env file
dotenvConfig();
const app = express();
app.use(express.json());
app.use(cors()); // Enable CORS for all origins for now

function parseNetwork(v: string | undefined): SuiNetwork {
    return (NETWORKS as readonly string[]).includes(v ?? '')
        ? (v as SuiNetwork)
        : 'testnet';
}

const env: Env = {
    SUI_SIGNER_SECRET_KEY: process.env.SUI_SIGNER_SECRET_KEY!,
    IAO_CONFIG_ID: process.env.IAO_CONFIG_ID!,
    IAO_REGISTRY_ID: process.env.IAO_REGISTRY_ID!,
    POOLS_CONFIG_ID: process.env.POOLS_CONFIG_ID!,
    POOLS_REGISTRY_ID: process.env.POOLS_REGISTRY_ID!,
    POOLS_PACKAGE_ID: process.env.POOLS_PACKAGE_ID,
    BONDING_CURVE_MODULE: process.env.BONDING_CURVE_MODULE,
    BONDING_CURVE_GLOBAL_CONFIG_ID: process.env.BONDING_CURVE_GLOBAL_CONFIG_ID,
    COINX_TYPE: process.env.COINX_TYPE,
    CLOCK_ID: process.env.CLOCK_ID!,
    FACTORY_PACKAGE_ID: process.env.FACTORY_PACKAGE_ID!,
    PORT: process.env.PORT ?? '3000',
    SUI_NETWORK: parseNetwork(process.env.SUI_NETWORK),
    ADMIN_CAP_ID: process.env.ADMIN_CAP_ID!,
};

// Corrected: Validate required environment variables
const requiredEnv = [
    'SUI_SIGNER_SECRET_KEY', 'IAO_CONFIG_ID', 'IAO_REGISTRY_ID',
    'POOLS_CONFIG_ID', 'POOLS_REGISTRY_ID', 'CLOCK_ID', 'FACTORY_PACKAGE_ID',
    'ADMIN_CAP_ID' // ADDED to the required list
];
for (const key of requiredEnv) {
    if (!env[key as keyof Env]) {
        console.error(`Error: Environment variable ${key} is not set. Please check your .env file.`);
        process.exit(1);
    }
}

const suiBlockchainService = new SuiBlockchainService(env);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'SUI Blockchain Service is running' });
});

// Read-only: get marginal price from bonding curve for a given idol coin type
// Usage: GET /marginal-price?coinType=<PACKAGE::module::STRUCT>
app.get('/marginal-price', async (req, res) => {
    try {
        const coinType = (req.query.coinType as string) || '';
        if (!coinType) return res.status(400).json({ error: 'Missing coinType query param' });
        const { rawReturn } = await suiBlockchainService.getMarginalPriceForIdol(coinType);
        res.status(200).json({ coinType, rawReturn });
    } catch (e: any) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

// Read-only: get current supply from bonding curve for a given idol coin type
// Usage: GET /current-supply?coinType=<PACKAGE::module::STRUCT>
app.get('/current-supply', async (req, res) => {
    try {
        const coinType = (req.query.coinType as string) || '';
        if (!coinType) return res.status(400).json({ error: 'Missing coinType query param' });
        const { rawReturn } = await suiBlockchainService.getCurrentSupplyForIdol(coinType);
        res.status(200).json({ coinType, rawReturn });
    } catch (e: any) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

// Endpoint to launch an IDOL on-chain
app.post('/launch-idol', async (req, res) => {
    const { idolId, createParams } = req.body as { idolId: number; createParams: IdolCreateRequest };

    if (!idolId || !createParams) {
        return res.status(400).json({ error: 'Missing idolId or createParams in request body.' });
    }

    // --- ENHANCED LOGGING ---
    console.log("======================================================");
    console.log(`[DO Droplet] Received request to launch idol ID: ${idolId}`);
    console.log(`[DO Droplet] Ticker: ${createParams.ticker}, Name: ${createParams.name}`);
    console.log("------------------------------------------------------");

    try {
        // Step 1: Publish Token Package
        console.log(`[DO Droplet] STEP 1: Publishing token package for idol ID: ${idolId}...`);
        const tokenPackageResult = await suiBlockchainService.publishIdolTokenPackage({
            ticker: createParams.ticker,
            name: createParams.name,
            description: createParams.description,
            decimals: createParams.decimals,
            imageUrl: createParams.imageUrl || "https://idol.fun/default-icon.png",
        });
        console.log(`[DO Droplet] SUCCESS: Token package published for idol ID: ${idolId}. Package ID: ${tokenPackageResult.packageId}`);

        // Step 2: Register Asset with IAO Protocol via Factory
        console.log(`[DO Droplet] STEP 2: Registering asset with IAO protocol for idol ID: ${idolId}...`);
        const registerAssetResult = await suiBlockchainService.registerAsset(
            {
                packageId: tokenPackageResult.packageId,
                treasuryCapId: tokenPackageResult.treasuryCapId,
                moduleName: tokenPackageResult.moduleName,
                structName: tokenPackageResult.structName,
                coinType: tokenPackageResult.coinType,
            },
            createParams
        );
        console.log(`[DO Droplet] SUCCESS: Asset registered for idol ID: ${idolId}. Pool ID: ${registerAssetResult.poolId}`);
        console.log("======================================================");

        res.status(200).json({
            packageId: tokenPackageResult.packageId,
            treasuryCapId: tokenPackageResult.treasuryCapId,
            coinMetadataId: tokenPackageResult.coinMetadataId,
            moduleName: tokenPackageResult.moduleName,
            structName: tokenPackageResult.structName,
            coinType: tokenPackageResult.coinType,
            poolId: registerAssetResult.poolId,
            bondingCurveId: registerAssetResult.bondingCurveId, // Added bondingCurveId to the response
            digest: registerAssetResult.digest,
            lpCapId: registerAssetResult.lpCapId,
            creatorTokensId: registerAssetResult.creatorTokensId,
        });

    } catch (error: any) {
        console.error(`[DO Droplet] FATAL ERROR launching idol ID: ${idolId}:`, error);
        console.log("======================================================");
        res.status(500).json({
            error: 'Failed to launch idol on SUI blockchain',
            details: error.message,
        });
    }
});

// API endpoint to graduate an idol pool
app.post('/graduate-idol', async (req, res) => {
    // These IDs must be provided by the client
    const { idolCoinType, bondingCurveId, poolId, quoteCoinType } = req.body;

    if (!idolCoinType || !bondingCurveId || !poolId) {
        return res.status(400).json({ error: 'Missing idolCoinType, bondingCurveId, or poolId in request body.' });
    }

    console.log("======================================================");
    console.log(`[DO Droplet] Received request to graduate idol pool with coin type: ${idolCoinType}`);
    console.log(`[DO Droplet] Bonding Curve ID: ${bondingCurveId}, Pool ID: ${poolId}`);
    console.log("------------------------------------------------------");

    try {
        const result = await suiBlockchainService.graduateIdolPool(idolCoinType, bondingCurveId, poolId, quoteCoinType);
        
        console.log(`[DO Droplet] SUCCESS: Idol pool graduated. Transaction digest: ${result.digest}`);
        console.log("======================================================");
        
        res.status(200).json({
            message: 'Idol pool successfully graduated.',
            digest: result.digest,
        });
    } catch (error: any) {
        console.error(`[DO Droplet] FATAL ERROR graduating idol pool:`, error);
        console.log("======================================================");
        res.status(500).json({
            error: 'Failed to graduate idol pool on SUI blockchain',
            details: error.message,
        });
    }
});

// API endpoint to call check_and_update_level
app.post('/check-update-level', async (req, res) => {
    const { idolCoinType } = req.body;

    if (!idolCoinType) {
        return res.status(400).json({ error: 'Missing idolCoinType in request body.' });
    }

    console.log("======================================================");
    console.log(`[DO Droplet] Received request to check and update level for idol: ${idolCoinType}`);
    console.log("------------------------------------------------------");

    try {
        const result = await suiBlockchainService.checkAndUpdateLevel(idolCoinType);
        
        console.log(`[DO Droplet] SUCCESS: check_and_update_level executed. Transaction digest: ${result.digest}`);
        console.log("======================================================");
        
        // 🔥 MODIFICATION: Return the digest AND the events array
        res.status(200).json({
            message: 'Successfully executed check_and_update_level.',
            digest: result.digest,
            events: result.events, // <--- ADDED EVENTS HERE
        });
    } catch (error: any) {
        console.error(`[DO Droplet] FATAL ERROR during check_and_update_level:`, error);
        console.log("======================================================");
        res.status(500).json({
            error: 'Failed to execute check_and_update_level on SUI blockchain',
            details: error.message,
        });
    }
});

// API endpoint to get trade volume for a specific bonding curve or all curves
app.get('/volume', async (req, res) => {
    const { bondingCurveId, limit } = req.query;

    console.log("======================================================");
    console.log(`[DO Droplet] Received request for trade volume.`);
    if (bondingCurveId) {
        console.log(`[DO Droplet] Filtering for Bonding Curve ID: ${bondingCurveId}`);
    }
    console.log("------------------------------------------------------");

    try {
        // Fetch events using the service method
        const events = await suiBlockchainService.getTradeEvents(
            bondingCurveId as string | undefined,
            limit ? parseInt(limit as string, 10) : 100
        );
        
        // Calculate volume from the fetched events
        const volumeData = suiBlockchainService.calculateVolume(events);
        
        console.log(`[DO Droplet] SUCCESS: Volume calculation complete. Transactions found: ${volumeData.transactionCount}`);
        console.log("======================================================");

        res.status(200).json({
            bondingCurveId: bondingCurveId || 'all',
            ...volumeData
        });

    } catch (error: any) {
        console.error(`[DO Droplet] FATAL ERROR fetching volume:`, error);
        console.log("======================================================");
        res.status(500).json({
            error: 'Failed to fetch and calculate volume',
            details: error.message,
        });
    }
});

// API endpoint to get token holders for a specific bonding curve or all curves
app.get('/holders', async (req, res) => {
    const { bondingCurveId, limit } = req.query;

    console.log("======================================================");
    console.log(`[DO Droplet] Received request for token holders.`);
    if (bondingCurveId) {
        console.log(`[DO Droplet] Filtering for Bonding Curve ID: ${bondingCurveId}`);
    }
    console.log("------------------------------------------------------");

    try {
        // Fetch events using the service method
        const events = await suiBlockchainService.getTradeEvents(
            bondingCurveId as string | undefined,
            limit ? parseInt(limit as string, 10) : 1000 // A higher limit might be needed for holders
        );
        
        // Calculate holders from the fetched events
        const holdersData = suiBlockchainService.calculateHolders(events);
        
        console.log(`[DO Droplet] SUCCESS: Holder calculation complete. Holders found: ${Object.keys(holdersData).length}`);
        console.log("======================================================");

        res.status(200).json({
            bondingCurveId: bondingCurveId || 'all',
            holderCount: Object.keys(holdersData).length,
            holders: holdersData
        });

    } catch (error: any) {
        console.error(`[DO Droplet] FATAL ERROR fetching holders:`, error);
        console.log("======================================================");
        res.status(500).json({
            error: 'Failed to fetch and calculate holders',
            details: error.message,
        });
    }
});

// API endpoint to get combined volume and holder stats for a specific bonding curve
app.get('/holders-volume', async (req, res) => {
    const { bondingCurveId, limit } = req.query;

    if (!bondingCurveId) {
        return res.status(400).json({ error: 'Missing bondingCurveId query parameter.' });
    }

    console.log("======================================================");
    console.log(`[DO Droplet] Received request for stats for Bonding Curve ID: ${bondingCurveId}`);
    console.log("------------------------------------------------------");

    try {
        // 1. Fetch events once
        const events = await suiBlockchainService.getTradeEvents(
            bondingCurveId as string,
            limit ? parseInt(limit as string, 10) : 1000 // Use a higher limit for accuracy
        );
        
        // 2. Calculate volume
        const volumeData = suiBlockchainService.calculateVolume(events);
        
        // 3. Calculate holders
        const holdersData = suiBlockchainService.calculateHolders(events);
        
        console.log(`[DO Droplet] SUCCESS: Stats calculation complete. Transactions: ${volumeData.transactionCount}, Holders: ${Object.keys(holdersData).length}`);
        console.log("======================================================");

        // 4. Combine and send the response
        res.status(200).json({
            bondingCurveId,
            volume: volumeData,
            holders: {
                count: Object.keys(holdersData).length,
                wallets: holdersData,
            }
        });

    } catch (error: any) {
        console.error(`[DO Droplet] FATAL ERROR fetching stats for bonding curve ${bondingCurveId}:`, error);
        console.log("======================================================");
        res.status(500).json({
            error: 'Failed to fetch and calculate stats for the bonding curve',
            details: error.message,
        });
    }
});


const port = Number(env.PORT ?? '3000');

app.listen(port, () => {
    console.log(`SUI Blockchain Service listening on port ${port}`);
});