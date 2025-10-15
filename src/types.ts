export const NETWORKS = ['mainnet', 'testnet', 'devnet', 'localnet'] as const;
export type SuiNetwork = typeof NETWORKS[number];

export interface Env {
    SUI_SIGNER_SECRET_KEY: string;
    IAO_CONFIG_ID: string;
    IAO_REGISTRY_ID: string;
    POOLS_CONFIG_ID: string;
    POOLS_REGISTRY_ID: string;
    CLOCK_ID: string;
    FACTORY_PACKAGE_ID: string; // The ID of your deployed idol_factory package
    PORT: string;
    SUI_NETWORK: SuiNetwork;
    // --- REQUIRED ADMIN CAP ---
    IAO_ADMIN_CAP_ID: string;
    POOLS_ADMIN_CAP_ID: string; 
    // --- Optional: bonding curve query wiring ---
    POOLS_PACKAGE_ID?: string; // package that contains bonding_curve::get_marginal_price
    BONDING_CURVE_MODULE?: string; // defaults to "bonding_curve"
    BONDING_CURVE_GLOBAL_CONFIG_ID?: string; // GlobalConfig object passed to get_marginal_price
    COINX_TYPE?: string; // Quote coin type for price, defaults to 0x2::sui::SUI
    CETUS_GLOBAL_CONFIG_ID?: string;
    CETUS_POOLS_ID?: string;
}

export interface IdolCreateRequest {
    xHandle: string;
    name: string;
    character: string;
    setting: string;
    idolType: 'rogue' | 'allied';
    imageUrl?: string;
    ticker: string;
    description: string;
    decimals: number;
    totalSupply: number;
    targetGoalSui: string;
    feeRateBps: number;
    launchDate: string;
    launchTime: string;
    countdownMinutes: number;
}

// New type reflecting the updated return value from checkAndUpdateLevel in SuiBlockchainService
export type CheckUpdateLevelResult = {
    digest: string;
    events: any[];
};

export interface TradeEventData {
    is_buy: boolean;
    coin_x_type: string;
    coin_y_type: string;
    x_amount: string;
    y_amount: string;
    fee_amount: string;
    liquidity_reserve: string;
    curve_tokens: string;
    supply: string;
    trader: string;
    bonding_curve_id: string;
    price: string;
}

export interface IdolMarketCapResult {
    coinType: string;
    price?: string;
    circulatingSupply?: string;
    marketCap?: string;
    error?: string;

}
