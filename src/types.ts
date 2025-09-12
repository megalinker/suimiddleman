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