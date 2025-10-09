//--- File: services/sui-blockchain.ts (Final Fixed) ---

import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromB64 } from '@mysten/sui/utils';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
// IMPORT FIXED: CheckUpdateLevelResult is imported from the shared types file.
import { Env, IdolCreateRequest, CheckUpdateLevelResult, TradeEventData } from '../types'; 
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Resolve Sui CLI binary once (env override supported)
const SUI_BIN = process.env.SUI_BIN || 'sui';

// A helper to run shell commands with Promises
function execAsync(
    command: string,
    options: { encoding?: BufferEncoding; maxBuffer?: number } = {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024, // 50 MB
    },
): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Command failed: ${error.message}\nStderr: ${stderr}`));
                return;
            }
            resolve(stdout);
        });
    });
}

export class SuiBlockchainService {
    private client: SuiClient;
    private keypair: Ed25519Keypair;
    private iaoConfigId: string;
    private iaoRegistryId: string;
    private poolsConfigId: string;
    private poolsRegistryId: string;
    private clockId: string;
    private factoryPackageId: string;
    private adminCapId: string;
    // Optional bonding-curve query wiring
    private poolsPackageId?: string;
    private bcModule?: string;
    private bcGlobalConfigId?: string;
    private quoteCoinType?: string;
    private static readonly SUI_DECIMALS_FACTOR = 1_000_000_000;
    constructor(env: Env) {
        this.client = new SuiClient({ url: getFullnodeUrl(env.SUI_NETWORK) });

        if (!env.SUI_SIGNER_SECRET_KEY) {
            throw new Error('SUI_SIGNER_SECRET_KEY is not defined in environment variables.');
        }

        // ---- Robust key parsing (supports suiprivkey... and base64 32/33 bytes) ----
        const raw = env.SUI_SIGNER_SECRET_KEY.trim();

        let secret32: Uint8Array;
        if (raw.startsWith('suiprivkey')) {
            const parsed = decodeSuiPrivateKey(raw); // { schema, secretKey }
            if (parsed.schema !== 'ED25519') {
                throw new Error(`Unsupported key scheme "${parsed.schema}". Only ED25519 is supported.`);
            }
            secret32 = parsed.secretKey; // 32-byte raw secret
        } else {
            const bytes = fromB64(raw);
            if (bytes.length === 32) secret32 = bytes;
            else if (bytes.length === 33) secret32 = bytes.slice(1);
            else throw new Error(`Invalid Ed25519 secret key length: expected 32 or 33, got ${bytes.length}`);
        }

        this.keypair = Ed25519Keypair.fromSecretKey(secret32);

        // Uses required `env.ADMIN_CAP_ID` from the imported Env type
        if (
            !env.IAO_CONFIG_ID ||
            !env.IAO_REGISTRY_ID ||
            !env.POOLS_CONFIG_ID ||
            !env.POOLS_REGISTRY_ID ||
            !env.CLOCK_ID ||
            !env.FACTORY_PACKAGE_ID ||
            !env.IAO_ADMIN_CAP_ID
        ) {
            throw new Error('Missing one or more IAO/Pools/Factory object IDs in environment variables.');
        }
        this.iaoConfigId = env.IAO_CONFIG_ID;
        this.iaoRegistryId = env.IAO_REGISTRY_ID;
        this.poolsConfigId = env.POOLS_CONFIG_ID;
        this.poolsRegistryId = env.POOLS_REGISTRY_ID;
        this.clockId = env.CLOCK_ID;
        this.factoryPackageId = env.FACTORY_PACKAGE_ID;
        this.adminCapId = env.IAO_ADMIN_CAP_ID; // ADDED
        // Optional bonding-curve config
        this.poolsPackageId = env.POOLS_PACKAGE_ID;
        this.bcModule = env.BONDING_CURVE_MODULE || 'bonding_curve';
        this.bcGlobalConfigId = env.BONDING_CURVE_GLOBAL_CONFIG_ID;
        this.quoteCoinType = env.COINX_TYPE || '0x2::sui::SUI';
    }

    private async ensureSuiAvailable() {
        try {
            await execAsync(`${SUI_BIN} --version`);
        } catch {
            throw new Error(
                `Sui CLI not found or not executable. Set SUI_BIN or fix PATH so "${SUI_BIN}" is available.`,
            );
        }
    }

    // --- small helper: wait for an object to be indexable on the RPC node ---
    private async waitForObject(
        id: string,
        label: string,
        { timeoutMs = 15_000, intervalMs = 500 } = {},
    ) {
        const start = Date.now();
        while (true) {
            try {
                const res = await this.client.getObject({ id, options: { showType: true } });
                if ('data' in res && res.data) return; // found
            } catch {
                // ignore and retry
            }
            if (Date.now() - start >= timeoutMs) {
                throw new Error(`[${label}] object not found on chain within timeout: ${id}`);
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    }

    // --- optional strict check (single probe) if you still want it ---
    private async assertObjectExists(id: string, label: string) {
        const res = await this.client.getObject({
            id,
            options: { showType: true, showOwner: true, showContent: false },
        });
        if (!('data' in res) || !res.data) {
            throw new Error(`[${label}] object not found on chain: ${id}`);
        }
    }

    async publishIdolTokenPackage(params: {
        ticker: string;
        name: string;
        description: string;
        decimals: number;
        imageUrl: string;
    }): Promise<{
        packageId: string;
        treasuryCapId: string;
        coinMetadataId: string;
        moduleName: string;
        structName: string; // the OTW type name (UPPERCASE module name)
        coinType: string;
    }> {
        await this.ensureSuiAvailable();

        const sanitizedTicker = params.ticker.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
        const uniqueId = `${sanitizedTicker}_${Date.now()}`;
        const moduleName = `idol_${uniqueId}`;
        const MODULE_NAME_UPPER = moduleName.toUpperCase();

        // The OTW type name equals the uppercase module name
        const structName = MODULE_NAME_UPPER;

        const tokenMoveSource = this.getTokenMoveTemplate(moduleName, MODULE_NAME_UPPER, params);
        const moveTomlSource = this.getMoveTomlTemplate(moduleName); // no explicit Sui dep

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sui-build-${uniqueId}-`));
        const sourcesDir = path.join(tmpDir, 'sources');
        fs.mkdirSync(sourcesDir, { recursive: true });
        fs.writeFileSync(path.join(sourcesDir, `${moduleName}.move`), tokenMoveSource);
        fs.writeFileSync(path.join(tmpDir, 'Move.toml'), moveTomlSource);

        let modules: string[];
        let dependencies: string[];

        try {
            console.log(`[SUI Service] Compiling Move package in ${tmpDir}...`);
            const buildOutput = await execAsync(
                `${SUI_BIN} move build --dump-bytecode-as-base64 --skip-fetch-latest-git-deps --path ${tmpDir}`,
                { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
            );
            const parsed = JSON.parse(buildOutput);
            modules = parsed.modules;
            dependencies = parsed.dependencies || [];
            console.log(`[SUI Service] Compilation successful.`);
        } catch (error: any) {
            console.error('[SUI Service] Move compilation failed:', error.message || error);
            fs.rmSync(tmpDir, { recursive: true, force: true });
            throw new Error(`Failed to compile dynamic Move package: ${error.message}`);
        } finally {
            if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        }

        const tx = new Transaction();
        const [upgradeCap] = tx.publish({ modules, dependencies });
        const recipient = this.keypair.getPublicKey().toSuiAddress();
        tx.transferObjects([upgradeCap], tx.pure.address(recipient));

        // Ask the node to execute AND be ready for follow-up queries on the same node.
        const result = await this.client.signAndExecuteTransaction({
            signer: this.keypair,
            transaction: tx,
            requestType: 'WaitForLocalExecution', // triggers SDK's internal wait on many setups
            options: { showObjectChanges: true, showEffects: true },
        });

        // Extra safety: explicitly wait until the transaction is indexed so getObject & resolvers see it.
        await this.client.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showObjectChanges: true },
        });

        const packageId = result.objectChanges?.find((o) => o.type === 'published')?.packageId;

        // Be tolerant: TreasuryCap/Metadata may be "created" or "transferred"
        const tcapChange = result.objectChanges?.find(
            (o: any) =>
                (o.type === 'created' || o.type === 'transferred') &&
                typeof o.objectType === 'string' &&
                o.objectType.includes('::coin::TreasuryCap'),
        ) as any;

        const metaChange = result.objectChanges?.find(
            (o: any) =>
                (o.type === 'created' || o.type === 'transferred') &&
                typeof o.objectType === 'string' &&
                o.objectType.includes('::coin::CoinMetadata'),
        ) as any;

        if (!packageId || !tcapChange?.objectId || !metaChange?.objectId) {
            console.error('[SUI Service] Failed to extract object IDs from publish transaction:', result);
            throw new Error('Failed to extract object IDs from publish transaction.');
        }

        const coinType = `${packageId}::${moduleName}::${MODULE_NAME_UPPER}`;

        console.log(`[SUI Service] coinType = ${coinType}`);
        console.log(`[SUI Service] treasuryCapId = ${tcapChange.objectId}`);
        console.log(`[SUI Service] coinMetadataId = ${metaChange.objectId}`);

        // Wait until both objects are visible on the node (avoids 'notExists' in step 2)
        await this.waitForObject(tcapChange.objectId, 'TreasuryCap');
        await this.waitForObject(metaChange.objectId, 'CoinMetadata');

        return {
            packageId,
            treasuryCapId: tcapChange.objectId,
            coinMetadataId: metaChange.objectId,
            moduleName,
            structName,
            coinType,
        };
    }

    async registerAsset(
        idolToken: {
            packageId: string;
            treasuryCapId: string;
            moduleName: string;
            structName: string;
            coinType: string;
        },
        createParams: IdolCreateRequest,
    ): Promise<{ digest: string; poolId: string; lpCapId?: string; creatorTokensId?: string; bondingCurveId: string }> {
        // Preflight: objects must exist on this network
        await this.assertObjectExists(idolToken.treasuryCapId, 'TreasuryCap');
        await this.assertObjectExists(this.iaoConfigId, 'IAO_CONFIG_ID');
        await this.assertObjectExists(this.iaoRegistryId, 'IAO_REGISTRY_ID');
        await this.assertObjectExists(this.poolsConfigId, 'POOLS_CONFIG_ID');
        await this.assertObjectExists(this.poolsRegistryId, 'POOLS_REGISTRY_ID');
        await this.assertObjectExists(this.clockId, 'CLOCK_ID');

        const tx = new Transaction();
        // Build the PTB
        const [initial_liquidity] = tx.splitCoins(tx.gas, [tx.pure.u64(1_000_000_000)]);
        const fullCoinType = idolToken.coinType;

        tx.moveCall({
            target: `${this.factoryPackageId}::factory::launch_idol`,
            typeArguments: [fullCoinType],
            arguments: [
                tx.pure.string(createParams.name),
                tx.pure.string(createParams.imageUrl || 'https://idol.fun/default-icon.png'),
                tx.pure.u64(createParams.totalSupply),
                tx.pure.u16(createParams.feeRateBps),
                tx.object(idolToken.treasuryCapId),
                tx.object(this.iaoConfigId),
                tx.object(this.iaoRegistryId),
                tx.object(this.poolsConfigId),
                tx.object(this.poolsRegistryId),
                initial_liquidity,
                tx.object(this.clockId),
            ],
        });

        // Explicit gas budget so the SDK doesn't stop early on auto-budget dry run
        tx.setGasBudget(100_000_000n); // adjust as needed; big enough to avoid auto budget dry-run path

        // ----- DEV INSPECT (preflight) to surface real aborts -----
        const sender = this.keypair.getPublicKey().toSuiAddress();
        const di = await this.client.devInspectTransactionBlock({
            sender,
            transactionBlock: tx,
        });

        // If the dry run indicates failure, bubble up a helpful error
        const status = (di as any)?.effects?.status?.status ?? (di as any)?.effects?.status;
        const error = (di as any)?.effects?.status?.error ?? (di as any)?.error;
        if (status === 'failure') {
            if (error && String(error).includes('::config::is_allowed')) {
                throw new Error(
                    `Permission check failed in factory config (config::is_allowed). ` +
                    `The signer ${sender} is not authorized to launch. ` +
                    `Have the admin add your address to the allowlist or use an open factory.`,
                );
            }
            throw new Error(`Move abort in preflight: ${error ?? 'unknown error'}`);
        }

        // ----- Execute for real -----
        const result = await this.client.signAndExecuteTransaction({
            signer: this.keypair,
            transaction: tx,
            requestType: 'WaitForLocalExecution',
            options: { showObjectChanges: true, showEffects: true },
        });

        await this.client.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showObjectChanges: true },
        });

        const createdObjects = result.objectChanges?.filter((o) => o.type === 'created');
        const lpCap = createdObjects?.find((o) => o.objectType.includes('::iao::LPCap'));
        const creatorTokens = createdObjects?.find((o) => o.objectType.includes('::coin::Coin'));
        const poolObject = createdObjects?.find((o) => o.objectType.includes('::iao::IAO'));
        const bondingCurveObject = createdObjects?.find((o) => o.objectType.includes('::bonding_curve::BondingCurve'));


        if (!poolObject || !('objectId' in poolObject)) {
            console.error('[SUI Service] Failed to find Pool object in transaction results:', result);
            throw new Error('Failed to find Pool object after asset registration.');
        }

        if (!bondingCurveObject || !('objectId' in bondingCurveObject)) {
             console.error('[SUI Service] Failed to find Bonding Curve object in transaction results:', result);
             throw new Error('Failed to find Bonding Curve object after asset registration.');
        }


        return {
            digest: result.digest,
            poolId: (poolObject as any).objectId,
            bondingCurveId: (bondingCurveObject as any).objectId,
            lpCapId: lpCap && 'objectId' in (lpCap as any) ? (lpCap as any).objectId : undefined,
            creatorTokensId:
                creatorTokens && 'objectId' in (creatorTokens as any) ? (creatorTokens as any).objectId : undefined,
        };
    }

    /**
     * Fetches trade events from the blockchain.
     * @param bondingCurveId - Optional ID to filter events for a specific bonding curve.
     * @param limit - The maximum number of events to fetch.
     * @returns A promise that resolves to an array of trade events.
     */
    async getTradeEvents(bondingCurveId?: string, limit: number = 100) {
        if (!this.poolsPackageId) {
            throw new Error('POOLS_PACKAGE_ID is not configured for fetching trade events.');
        }
        const EVENT_TYPE = `${this.poolsPackageId}::${this.bcModule}::TradeEvent`;

        try {
            const events = await this.client.queryEvents({
                query: {
                    MoveEventType: EVENT_TYPE
                },
                limit: limit,
                order: 'descending'
            });

            // Filter by specific bonding curve if provided
            const filteredEvents = bondingCurveId 
                ? events.data.filter(event => {
                    const data = event.parsedJson as TradeEventData;
                    return data.bonding_curve_id === bondingCurveId;
                  })
                : events.data;

            return filteredEvents;
        } catch (error) {
            console.error('Error fetching events:', error);
            return [];
        }
    }

/**
     * Calculates trading volume from a list of events.
     * @param events - An array of trade events.
     * @returns An object containing total, buy, and sell volumes (in SUI), and the transaction count.
     */
    calculateVolume(events: any[]): {
        totalVolume: number;
        buyVolume: number;
        sellVolume: number;
        transactionCount: number;
    } {
        let totalVolume = 0;
        let buyVolume = 0;
        let sellVolume = 0;
        let transactionCount = events.length;

        // Use the SUI decimal factor to convert MIST (raw amount) to SUI.
        const decimalsFactor = SuiBlockchainService.SUI_DECIMALS_FACTOR;

        events.forEach(event => {
            const data = event.parsedJson as TradeEventData;
            console.log(`[Volume Calculation] Processing event: is_buy=${data.is_buy}, x_amount=${data.x_amount}, y_amount=${data.y_amount}`);
            
            // 1. Get the raw volume as a number (it might exceed JS's safe integer limit, 
            // but for typical trading volume sums, this is often acceptable if the number of trades isn't huge).
            // For maximum safety, convert to BigInt first, then to a safe float.
            const rawAmountBigInt = BigInt(data.x_amount);
            
            // 2. Calculate the human-readable volume (in SUI)
            // Note: Volume is consistently measured by CoinX/Quote Coin (x_amount)
            const humanVolume = Number(rawAmountBigInt) / decimalsFactor;

            if (data.is_buy) {
                // Buy transaction: user spent x_amount (SUI/base token)
                buyVolume += humanVolume;
                totalVolume += humanVolume;
            } else {
                // Sell transaction: user received x_amount (SUI/base token)
                sellVolume += humanVolume;
                totalVolume += humanVolume;
            }
        });

        // Round results to a reasonable precision (e.g., 6 decimal places)
        return {
            totalVolume: Math.round(totalVolume * 1_000_000) / 1_000_000,
            buyVolume: Math.round(buyVolume * 1_000_000) / 1_000_000,
            sellVolume: Math.round(sellVolume * 1_000_000) / 1_000_000,
            transactionCount
        };
    }

    /**
     * Read-only price query using bonding_curve::get_marginal_price<CoinX, CoinY>(config: &GlobalConfig): u64
     * - CoinX defaults to SUI unless overridden via env COINX_TYPE
     * - CoinY is the provided idolCoinType (e.g., `${pkg}::${mod}::${STRUCT}`)
     * - config object is BONDING_CURVE_GLOBAL_CONFIG_ID
     */
    async getMarginalPriceForIdol(idolCoinType: string): Promise<{ rawReturn?: any }> {
        const pkg = this.poolsPackageId; // fallback to factory pkg if not specified
        if (!pkg) throw new Error('No package ID configured for get_marginal_price');

        // Prefer explicit bonding-curve global config if provided; fallback to pools config
        const configId = this.bcGlobalConfigId ?? this.poolsConfigId;

        const tx = new Transaction();
        tx.moveCall({
            target: `${pkg}::${this.bcModule}::get_marginal_price`,
            typeArguments: [this.quoteCoinType!, idolCoinType],
            arguments: [tx.object(configId)],
        });

        const sender = this.keypair.getPublicKey().toSuiAddress();
        const di = await this.client.devInspectTransactionBlock({ sender, transactionBlock: tx });

        const rawReturn = (di as any)?.results?.[0]?.returnValues;
        if (!rawReturn || !rawReturn.length) {
            const err = (di as any)?.effects?.status?.error ?? (di as any)?.error;
            throw new Error(`No return value from get_marginal_price. ${err ? 'DevInspect error: ' + err : ''}`);
        }
        return { rawReturn };
    }

    /**
     * Read-only supply query using bonding_curve::get_current_supply<CoinX, CoinY>(config: &GlobalConfig): vector<u64> | u64
     * - CoinX defaults to SUI unless overridden via env COINX_TYPE
     * - CoinY is the provided idolCoinType (e.g., `${pkg}::${mod}::${STRUCT}`)
     * - config object prefers BONDING_CURVE_GLOBAL_CONFIG_ID, falls back to POOLS_CONFIG_ID
     * Returns the raw dev-inspect returnValues array so the caller can decode as needed.
     */
    async getCurrentSupplyForIdol(idolCoinType: string): Promise<{ rawReturn?: any }> {
        const pkg = this.poolsPackageId; // fallback to factory pkg if not specified
        if (!pkg) throw new Error('No package ID configured for get_current_supply');

        const configId = this.bcGlobalConfigId ?? this.poolsConfigId;

        const tx = new Transaction();
        tx.moveCall({
            target: `${pkg}::${this.bcModule}::get_current_supply`,
            typeArguments: [this.quoteCoinType!, idolCoinType],
            arguments: [tx.object(configId)],
        });

        const sender = this.keypair.getPublicKey().toSuiAddress();
        const di = await this.client.devInspectTransactionBlock({ sender, transactionBlock: tx });

        const rawReturn = (di as any)?.results?.[0]?.returnValues;
        if (!rawReturn || !rawReturn.length) {
            const err = (di as any)?.effects?.status?.error ?? (di as any)?.error;
            throw new Error(`No return value from get_current_supply. ${err ? 'DevInspect error: ' + err : ''}`);
        }
        return { rawReturn };
    }

    /**
     * A method to call the `graduate` function on-chain.
     * This will transition an IAO pool to a regular bonding curve pool.
     */
    async graduateIdolPool(
        idolCoinType: string,
        bondingCurveId: string,
        poolId: string,
        quoteCoinType: string = this.quoteCoinType!,
    ): Promise<{ digest: string }> {
        // Preflight checks
        if (!this.poolsPackageId) {
            throw new Error('POOLS_PACKAGE_ID is not configured.');
        }
        if (!this.poolsRegistryId) {
            throw new Error('POOLS_REGISTRY_ID is not configured.');
        }
        if (!this.clockId) {
            throw new Error('CLOCK_ID is not configured.');
        }

        // Build the transaction with direct object IDs provided by the client
        const tx = new Transaction();
        tx.moveCall({
            // MODIFIED: Calling graduate_admin, which requires an AdminCap
            target: `${this.poolsPackageId}::registry::graduate_admin`,
            typeArguments: [quoteCoinType, idolCoinType],
            arguments: [
                // MODIFIED: Adding the AdminCap object as the first argument
                tx.object(this.adminCapId),
                tx.object(this.poolsRegistryId),
                tx.pure.id(bondingCurveId),
                tx.pure.id(poolId),
                tx.object(this.clockId)
            ],
        });

        // The gas budget might need to be higher for this operation.
        tx.setGasBudget(100_000_000n);

        // Execute for real
        const result = await this.client.signAndExecuteTransaction({
            signer: this.keypair,
            transaction: tx,
            requestType: 'WaitForLocalExecution',
            options: { showEffects: true, showObjectChanges: true },
        });

        await this.client.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showObjectChanges: true },
        });

        return {
            digest: result.digest,
        };
    }

    /**
     * Calls the `check_and_update_level` function on-chain.
     * This transaction verifies that the global and coin-specific configurations are not paused
     * and may update the bonding curve's level based on the current time.
     * It uses the service's configured `quoteCoinType` as CoinX.
     * @param idolCoinType - The type of the idol coin to check (CoinY).
     * @returns A promise that resolves with the transaction digest AND the emitted events.
     */
    async checkAndUpdateLevel(
        idolCoinType: string,
    ): Promise<CheckUpdateLevelResult> { // <-- Uses imported CheckUpdateLevelResult
        const pkg = this.poolsPackageId;
        if (!pkg) {
            throw new Error('POOLS_PACKAGE_ID is not configured for this operation.');
        }

        const configId = this.bcGlobalConfigId ?? this.poolsConfigId;
        if (!configId) {
            throw new Error('A global config ID (BONDING_CURVE_GLOBAL_CONFIG_ID or POOLS_CONFIG_ID) is not configured.');
        }

        if (!this.clockId) {
            throw new Error('CLOCK_ID is not configured.');
        }

        const tx = new Transaction();
        tx.moveCall({
            target: `${pkg}::${this.bcModule}::check_and_update_level`,
            typeArguments: [this.quoteCoinType!, idolCoinType],
            arguments: [
                tx.object(configId),
                tx.object(this.clockId)
            ],
        });

        tx.setGasBudget(100_000_000n);

        // 1. Sign and execute (requests effects)
        const result = await this.client.signAndExecuteTransaction({
            signer: this.keypair,
            transaction: tx,
            requestType: 'WaitForLocalExecution',
            options: { showEffects: true }, // Crucial for effects/events
        });

        // 2. Wait for confirmation and fetch the full result
        const finalResult = await this.client.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showEvents: true }, // Ensure events are explicitly included
        });
        
        // 3. Extract and return events
    // Events are returned at the top level when showEvents: true, not under effects
    const events = (finalResult as any).events ?? [];

        return {
            digest: finalResult.digest,
            events: events, // <-- RETURN THE EVENTS
        };
    }

    // --------- Templates ---------

    private getMoveTomlTemplate(moduleName: string): string {
        // No explicit [dependencies]; framework deps are auto-added by the CLI for the active env
        return `
[package]
name = "${moduleName}"
version = "0.0.1"
[addresses]
${moduleName} = "0x0"
`.trim();
    }

    private getTokenMoveTemplate(
        moduleName: string,
        MODULE_NAME_UPPER: string,
        params: {
            ticker: string;
            name: string;
            description: string;
            decimals: number;
            imageUrl: string;
        },
    ): string {
        // OTW must be UPPERCASE(moduleName); init runs on publish and receives the OTW
        return `
module ${moduleName}::${moduleName} {
    use std::option;
    use sui::coin;
    use sui::transfer;
    use sui::url;
    use sui::tx_context::{Self, TxContext};
    // One-Time Witness type (UPPERCASE module name)
    struct ${MODULE_NAME_UPPER} has drop {}
    // Called once at publish-time; Sui provides the OTW automatically
    fun init(witness: ${MODULE_NAME_UPPER}, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency<${MODULE_NAME_UPPER}>(
            witness,
            ${params.decimals},
            b"${params.ticker}",
            b"${params.name}",
            b"${params.description}",
            option::some(url::new_unsafe_from_bytes(b"${params.imageUrl}")),
            ctx
        );
        // Give deployer the TreasuryCap so they control mint/burn
        transfer::public_transfer(treasury_cap, tx_context::sender(ctx));
        // Freeze metadata so it's immutable/readable globally (must use the public variant)
        transfer::public_freeze_object(metadata);
    }
}
`.trim();
    }

    /**
     * Calculates holder balances from a list of trade events.
     * @param events - An array of trade events.
     * @returns A map of trader addresses to their net token balances.
     */
    calculateHolders(events: any[]): { [trader: string]: number } {
        const balances: { [trader: string]: number } = {};

        // Process events in chronological order (oldest first) to correctly calculate balances
        const reversedEvents = [...events].reverse();

        reversedEvents.forEach(event => {
            const data = event.parsedJson as TradeEventData;
            const trader = data.trader;
            
            if (!balances[trader]) {
                balances[trader] = 0;
            }

            if (data.is_buy) {
                // User buys the token, balance increases by y_amount
                balances[trader] += parseInt(data.y_amount);
            } else {
                // User sells the token, balance decreases by y_amount
                balances[trader] -= parseInt(data.y_amount);
            }
        });

        // Filter out traders with a zero or negative balance
        const holders: { [trader: string]: number } = {};
        for (const trader in balances) {
            if (balances[trader] > 0) {
                holders[trader] = balances[trader];
            }
        }

        return holders;
    }
}