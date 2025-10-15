//--- File: services/sui-blockchain.ts (Final Fixed) ---

import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromB64 } from '@mysten/sui/utils';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Env, IdolCreateRequest, CheckUpdateLevelResult, TradeEventData, IdolMarketCapResult } from '../types'; 
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SUI_BIN = process.env.SUI_BIN || 'sui';

function execAsync(
    command: string,
    options: { encoding?: BufferEncoding; maxBuffer?: number } = {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
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
    private poolsPackageId?: string;
    private bcModule?: string;
    private bcGlobalConfigId?: string;
    private quoteCoinType?: string;
    private cetusConfigId?: string;
    private cetusPoolsId?: string;
    private static readonly SUI_DECIMALS_FACTOR = 1_000_000_000;
    constructor(env: Env) {
        this.client = new SuiClient({ url: getFullnodeUrl(env.SUI_NETWORK) });

        if (!env.SUI_SIGNER_SECRET_KEY) {
            throw new Error('SUI_SIGNER_SECRET_KEY is not defined in environment variables.');
        }

        const raw = env.SUI_SIGNER_SECRET_KEY.trim();

        let secret32: Uint8Array;
        if (raw.startsWith('suiprivkey')) {
            const parsed = decodeSuiPrivateKey(raw);
            if (parsed.schema !== 'ED25519') {
                throw new Error(`Unsupported key scheme "${parsed.schema}". Only ED25519 is supported.`);
            }
            secret32 = parsed.secretKey;
        } else {
            const bytes = fromB64(raw);
            if (bytes.length === 32) secret32 = bytes;
            else if (bytes.length === 33) secret32 = bytes.slice(1);
            else throw new Error(`Invalid Ed25519 secret key length: expected 32 or 33, got ${bytes.length}`);
        }

        this.keypair = Ed25519Keypair.fromSecretKey(secret32);

        if (
            !env.IAO_CONFIG_ID ||
            !env.IAO_REGISTRY_ID ||
            !env.POOLS_CONFIG_ID ||
            !env.POOLS_REGISTRY_ID ||
            !env.CLOCK_ID ||
            !env.FACTORY_PACKAGE_ID ||
            !env.IAO_ADMIN_CAP_ID ||
            !env.CETUS_GLOBAL_CONFIG_ID ||
            !env.CETUS_POOLS_ID
        ) {
            throw new Error('Missing one or more IAO/Pools/Factory object IDs in environment variables.');
        }
        this.iaoConfigId = env.IAO_CONFIG_ID;
        this.iaoRegistryId = env.IAO_REGISTRY_ID;
        this.poolsConfigId = env.POOLS_CONFIG_ID;
        this.poolsRegistryId = env.POOLS_REGISTRY_ID;
        this.clockId = env.CLOCK_ID;
        this.factoryPackageId = env.FACTORY_PACKAGE_ID;
        this.adminCapId = env.IAO_ADMIN_CAP_ID;
        this.poolsPackageId = env.POOLS_PACKAGE_ID;
        this.bcModule = env.BONDING_CURVE_MODULE || 'bonding_curve';
        this.bcGlobalConfigId = env.BONDING_CURVE_GLOBAL_CONFIG_ID;
        this.quoteCoinType = env.COINX_TYPE || '0x2::sui::SUI';
        this.cetusConfigId = env.CETUS_GLOBAL_CONFIG_ID;
        this.cetusPoolsId = env.CETUS_POOLS_ID;
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

    private async waitForObject(
        id: string,
        label: string,
        { timeoutMs = 15_000, intervalMs = 500 } = {},
    ) {
        const start = Date.now();
        while (true) {
            try {
                const res = await this.client.getObject({ id, options: { showType: true } });
                if ('data' in res && res.data) return;
            } catch {
            }
            if (Date.now() - start >= timeoutMs) {
                throw new Error(`[${label}] object not found on chain within timeout: ${id}`);
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    }

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
        structName: string;
        coinType: string;
    }> {
        await this.ensureSuiAvailable();

        const sanitizedTicker = params.ticker.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
        const uniqueId = `${sanitizedTicker}_${Date.now()}`;
        const moduleName = `idol_${uniqueId}`;
        const MODULE_NAME_UPPER = moduleName.toUpperCase();

        const structName = MODULE_NAME_UPPER;

        const tokenMoveSource = this.getTokenMoveTemplate(moduleName, MODULE_NAME_UPPER, params);
        const moveTomlSource = this.getMoveTomlTemplate(moduleName);

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

        const packageId = result.objectChanges?.find((o) => o.type === 'published')?.packageId;

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
        await this.assertObjectExists(idolToken.treasuryCapId, 'TreasuryCap');
        await this.assertObjectExists(this.iaoConfigId, 'IAO_CONFIG_ID');
        await this.assertObjectExists(this.iaoRegistryId, 'IAO_REGISTRY_ID');
        await this.assertObjectExists(this.poolsConfigId, 'POOLS_CONFIG_ID');
        await this.assertObjectExists(this.poolsRegistryId, 'POOLS_REGISTRY_ID');
        await this.assertObjectExists(this.clockId, 'CLOCK_ID');

        const tx = new Transaction();
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
                tx.object(this.cetusConfigId),
                tx.object(this.cetusPoolsId),
                initial_liquidity,
                tx.object(this.clockId),
            ],
        });

        tx.setGasBudget(100_000_000n);

        const sender = this.keypair.getPublicKey().toSuiAddress();
        const di = await this.client.devInspectTransactionBlock({
            sender,
            transactionBlock: tx,
        });

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

        const decimalsFactor = SuiBlockchainService.SUI_DECIMALS_FACTOR;

        events.forEach(event => {
            const data = event.parsedJson as TradeEventData;
            console.log(`[Volume Calculation] Processing event: is_buy=${data.is_buy}, x_amount=${data.x_amount}, y_amount=${data.y_amount}`);
            
            const rawAmountBigInt = BigInt(data.x_amount);
            
            const humanVolume = Number(rawAmountBigInt) / decimalsFactor;

            if (data.is_buy) {
                buyVolume += humanVolume;
                totalVolume += humanVolume;
            } else {
                sellVolume += humanVolume;
                totalVolume += humanVolume;
            }
        });

        return {
            totalVolume: Math.round(totalVolume * 1_000_000) / 1_000_000,
            buyVolume: Math.round(buyVolume * 1_000_000) / 1_000_000,
            sellVolume: Math.round(sellVolume * 1_000_000) / 1_000_000,
            transactionCount
        };
    }

    /**
     * Read-only query for the bonding curve's liquidity reserve amount (in CoinX/QuoteCoin, usually SUI).
     * The result is a raw u64 from the devInspect.
     * The Move function is: public fun get_curve_liquidity_reserve<CoinX, CoinY>(config: &GlobalConfig): u64
     * - CoinX defaults to SUI unless overridden via env COINX_TYPE
     * - CoinY is the provided idolCoinType (e.g., `${pkg}::${mod}::${STRUCT}`)
     * - config object prefers BONDING_CURVE_GLOBAL_CONFIG_ID, falls back to POOLS_CONFIG_ID
     */
    async getCurveLiquidityReserveForIdol(idolCoinType: string): Promise<{ rawReturn?: any }> {
        const pkg = this.poolsPackageId;
        if (!pkg) throw new Error('No package ID configured for get_curve_liquidity_reserve');

        const configId = this.bcGlobalConfigId ?? this.poolsConfigId;
        if (!configId) {
            throw new Error('A global config ID (BONDING_CURVE_GLOBAL_CONFIG_ID or POOLS_CONFIG_ID) is not configured.');
        }

        const tx = new Transaction();
        tx.moveCall({
            target: `${pkg}::${this.bcModule}::get_curve_liquidity_reserve`,
            typeArguments: [this.quoteCoinType!, idolCoinType],
            arguments: [tx.object(configId)],
        });

        const sender = this.keypair.getPublicKey().toSuiAddress();
        const di = await this.client.devInspectTransactionBlock({ sender, transactionBlock: tx });

        const rawReturn = (di as any)?.results?.[0]?.returnValues;
        if (!rawReturn || !rawReturn.length) {
            const err = (di as any)?.effects?.status?.error ?? (di as any)?.error;
            throw new Error(`No return value from get_curve_liquidity_reserve. ${err ? 'DevInspect error: ' + err : ''}`);
        }

        return { rawReturn };
    }

    /**
     * Computes the market capitalization for a batch of idol coin types.
     * Price and Market Cap are denominated in SUI.
     */
    async computeMarketCaps(coinTypes: string[]): Promise<IdolMarketCapResult[]> {
        const SUI_DECIMALS_FACTOR = 1_000_000_000; // 10^9
    
        const tasks = coinTypes.map(async (coinType) => {
          try {
            // 1. Get the marginal price in SUI
            const { price: priceString } = await this.getMarginalPriceForIdol(coinType);
            const priceInSui = parseFloat(priceString) / SUI_DECIMALS_FACTOR;
    
            // 2. Get the circulating supply
            const { supply: supplyString } = await this.getCurrentSupplyForIdol(coinType);
            const circulatingSupplyRaw = parseFloat(supplyString);
            
            // The circulating supply of the IDOL token also has decimals.
            const circulatingSupply = circulatingSupplyRaw / SUI_DECIMALS_FACTOR;
    
            // 3. Calculate market cap in SUI
            const marketCapInSui = priceInSui * circulatingSupply;
    
            return { 
              coinType, 
              price: priceInSui.toFixed(9), 
              circulatingSupply: circulatingSupply.toFixed(9), 
              marketCap: marketCapInSui.toFixed(9)
            };
          } catch (err: any) {
            const message = err?.message || 'Failed to compute market cap';
            return { coinType, error: message };
          }
        });
    
        return Promise.all(tasks);
    }

    /**
     * Read-only price query using bonding_curve::get_marginal_price<CoinX, CoinY>(config: &GlobalConfig): u64
     * - CoinX defaults to SUI unless overridden via env COINX_TYPE
     * - CoinY is the provided idolCoinType (e.g., `${pkg}::${mod}::${STRUCT}`)
     * - config object is BONDING_CURVE_GLOBAL_CONFIG_ID
     */
    async getMarginalPriceForIdol(idolCoinType: string): Promise<{ price: string }> {
        const pkg = this.poolsPackageId;
        if (!pkg) throw new Error('No package ID configured for get_marginal_price');

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
        
        // The raw return for a u64 is a little-endian byte array.
        const bytes = rawReturn[0][0];
        const view = new DataView(new Uint8Array(bytes).buffer);
        const price = view.getBigUint64(0, true); // true for little-endian

        return { price: price.toString() };
    }

    /**
     * Read-only supply query using bonding_curve::get_current_supply<CoinX, CoinY>(config: &GlobalConfig): vector<u64> | u64
     * - CoinX defaults to SUI unless overridden via env COINX_TYPE
     * - CoinY is the provided idolCoinType (e.g., `${pkg}::${mod}::${STRUCT}`)
     * - config object prefers BONDING_CURVE_GLOBAL_CONFIG_ID, falls back to POOLS_CONFIG_ID
     * Returns the raw dev-inspect returnValues array so the caller can decode as needed.
     */
    async getCurrentSupplyForIdol(idolCoinType: string): Promise<{ supply: string }> {
        const pkg = this.poolsPackageId;
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
        
        // The raw return for a u64 is a little-endian byte array.
        const bytes = rawReturn[0][0];
        const view = new DataView(new Uint8Array(bytes).buffer);
        const supply = view.getBigUint64(0, true); // true for little-endian

        return { supply: supply.toString() };
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
        if (!this.poolsPackageId) {
            throw new Error('POOLS_PACKAGE_ID is not configured.');
        }
        if (!this.poolsRegistryId) {
            throw new Error('POOLS_REGISTRY_ID is not configured.');
        }
        if (!this.clockId) {
            throw new Error('CLOCK_ID is not configured.');
        }

        const tx = new Transaction();
        tx.moveCall({
            target: `${this.poolsPackageId}::registry::graduate_admin`,
            typeArguments: [quoteCoinType, idolCoinType],
            arguments: [
                tx.object(this.adminCapId),
                tx.object(this.poolsRegistryId),
                tx.pure.id(bondingCurveId),
                tx.pure.id(poolId),
                tx.object(this.clockId)
            ],
        });

        tx.setGasBudget(100_000_000n);

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
    ): Promise<CheckUpdateLevelResult> {
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

        const result = await this.client.signAndExecuteTransaction({
            signer: this.keypair,
            transaction: tx,
            requestType: 'WaitForLocalExecution',
            options: { showEffects: true },
        });

        const finalResult = await this.client.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true, showEvents: true },
        });
        
        const events = (finalResult as any).events ?? [];

        return {
            digest: finalResult.digest,
            events: events,
        };
    }

    private getMoveTomlTemplate(moduleName: string): string {
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
        return `
module ${moduleName}::${moduleName} {
    use std::option;
    use sui::coin;
    use sui::transfer;
    use sui::url;
    use sui::tx_context::{Self, TxContext};
    struct ${MODULE_NAME_UPPER} has drop {}
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
        transfer::public_transfer(treasury_cap, tx_context::sender(ctx));
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

        const reversedEvents = [...events].reverse();

        reversedEvents.forEach(event => {
            const data = event.parsedJson as TradeEventData;
            const trader = data.trader;
            
            if (!balances[trader]) {
                balances[trader] = 0;
            }

            if (data.is_buy) {
                balances[trader] += parseInt(data.y_amount);
            } else {
                balances[trader] -= parseInt(data.y_amount);
            }
        });

        const holders: { [trader: string]: number } = {};
        for (const trader in balances) {
            if (balances[trader] > 0) {
                holders[trader] = balances[trader];
            }
        }

        return holders;
    }

    /**
     * Read-only query for the bonding curve's state.
     * The Move function is: public fun get_curve_state<CoinX, CoinY>(config: &GlobalConfig): BondingCurveState
     * - CoinX defaults to SUI unless overridden via env COINX_TYPE
     * - CoinY is the provided idolCoinType (e.g., `${pkg}::${mod}::${STRUCT}`)
     * - config object prefers BONDING_CURVE_GLOBAL_CONFIG_ID, falls back to POOLS_CONFIG_ID
     */
    async getCurveStateForIdol(idolCoinType: string): Promise<{ state: string }> {
        const pkg = this.poolsPackageId;
        if (!pkg) throw new Error('No package ID configured for get_curve_state');

        const configId = this.bcGlobalConfigId ?? this.poolsConfigId;
        if (!configId) {
            throw new Error('A global config ID (BONDING_CURVE_GLOBAL_CONFIG_ID or POOLS_CONFIG_ID) is not configured.');
        }

        const tx = new Transaction();
        tx.moveCall({
            target: `${pkg}::${this.bcModule}::get_curve_state`,
            typeArguments: [this.quoteCoinType!, idolCoinType],
            arguments: [tx.object(configId)],
        });

        const sender = this.keypair.getPublicKey().toSuiAddress();
        const di = await this.client.devInspectTransactionBlock({ sender, transactionBlock: tx });

        const rawReturn = (di as any)?.results?.[0]?.returnValues;
        if (!rawReturn || !rawReturn.length) {
            const err = (di as any)?.effects?.status?.error ?? (di as any)?.error;
            throw new Error(`No return value from get_curve_state. ${err ? 'DevInspect error: ' + err : ''}`);
        }

        const state = this.parseBondingCurveState(rawReturn);

        return { state };
    }

    private parseBondingCurveState(rawReturnValue: any[]): string {
        if (!rawReturnValue || !rawReturnValue.length) {
            return 'Unknown';
        }
        // The return value is [[bytes, type]]
        const valueBytes = rawReturnValue[0][0];
        if (!valueBytes || valueBytes.length === 0) {
            return 'Unknown';
        }
    
        const stateIndex = valueBytes[0];
        switch (stateIndex) {
            case 0: return 'Active';
            case 1: return 'Paused';
            case 2: return 'Completed';
            case 3: return 'Graduated';
            default: return 'Unknown';
        }
    }

}
