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
    CLOCK_ID: process.env.CLOCK_ID!,
    FACTORY_PACKAGE_ID: process.env.FACTORY_PACKAGE_ID!,
    PORT: process.env.PORT ?? '3000',
    SUI_NETWORK: parseNetwork(process.env.SUI_NETWORK),
};

// Validate required environment variables
const requiredEnv = [
    'SUI_SIGNER_SECRET_KEY', 'IAO_CONFIG_ID', 'IAO_REGISTRY_ID',
    'POOLS_CONFIG_ID', 'POOLS_REGISTRY_ID', 'CLOCK_ID', 'FACTORY_PACKAGE_ID'
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

const port = Number(env.PORT ?? '3000');

app.listen(port, () => {
    console.log(`SUI Blockchain Service listening on port ${port}`);
});