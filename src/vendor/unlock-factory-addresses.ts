/**
 * Official Unlock Protocol factory addresses by chain ID.
 * Source: Unlock Protocol docs.
 */
export const UNLOCK_FACTORY_ADDRESSES: Readonly<Record<number, `0x${string}`>> =
  {
    1: "0xe79B93f8E22676774F2A8dAd469175ebd00029FA", // Ethereum Mainnet
    10: "0x99b1348a9129ac49c6de7F11245773dE2f51fB0c", // Optimism
    56: "0xeC83410DbC48C7797D2f2AFe624881674c65c856", // BNB Chain
    100: "0x1bc53f4303c711cc693F6Ec3477B83703DcB317f", // Gnosis
    137: "0xE8E5cd156f89F7bdB267EabD5C43Af3d5AF2A78f", // Polygon
    324: "0x32CF553582159F12fBb1Ae1649b3670395610F24", // zkSync Era
    1101: "0x259813B665C8f6074391028ef782e27B65840d89", // Polygon zkEVM
    8453: "0xd0b14797b9D08493392865647384974470202A78", // Base
    84532: "0x259813B665C8f6074391028ef782e27B65840d89", // Base Sepolia
    42161: "0x1FF7e338d5E582138C46044dc238543Ce555C963", // Arbitrum One
    42220: "0x1FF7e338d5E582138C46044dc238543Ce555C963", // Celo
    43114: "0x70cBE5F72dD85aA634d07d2227a421144Af734b3", // Avalanche C-Chain
    59144: "0x70B3c9Dd9788570FAAb24B92c3a57d99f8186Cc7", // Linea
    534352: "0x259813B665C8f6074391028ef782e27B65840d89", // Scroll
    11155111: "0x36b34e10295cCE69B652eEB5a8046041074515Da", // Sepolia
  } as const;

export const getUnlockFactoryAddress = (
  chainId: number,
): `0x${string}` | null => {
  return UNLOCK_FACTORY_ADDRESSES[chainId] ?? null;
};
