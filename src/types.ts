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
    // Optional: bonding curve query wiring
    POOLS_PACKAGE_ID?: string; // package that contains bonding_curve::get_marginal_price
    BONDING_CURVE_MODULE?: string; // defaults to "bonding_curve"
    BONDING_CURVE_GLOBAL_CONFIG_ID?: string; // GlobalConfig object passed to get_marginal_price
    COINX_TYPE?: string; // Quote coin type for price, defaults to 0x2::sui::SUI
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