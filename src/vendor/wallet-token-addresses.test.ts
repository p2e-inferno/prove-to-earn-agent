import {
  getBaseMainnetTokenAddresses,
  getWalletTransferTokenAddresses,
} from "@vendor/wallet-token-addresses";

describe("wallet token address resolution", () => {
  const originalDg = process.env.NEXT_PUBLIC_DG_TOKEN_ADDRESS_BASE_MAINNET;
  const originalUp = process.env.NEXT_PUBLIC_UP_TOKEN_ADDRESS_BASE_MAINNET;

  afterEach(() => {
    if (originalDg === undefined) {
      delete process.env.NEXT_PUBLIC_DG_TOKEN_ADDRESS_BASE_MAINNET;
    } else {
      process.env.NEXT_PUBLIC_DG_TOKEN_ADDRESS_BASE_MAINNET = originalDg;
    }

    if (originalUp === undefined) {
      delete process.env.NEXT_PUBLIC_UP_TOKEN_ADDRESS_BASE_MAINNET;
    } else {
      process.env.NEXT_PUBLIC_UP_TOKEN_ADDRESS_BASE_MAINNET = originalUp;
    }
  });

  it("sanitizes quoted env addresses", () => {
    process.env.NEXT_PUBLIC_DG_TOKEN_ADDRESS_BASE_MAINNET =
      '"0x4aA47eD29959c7053996d8f7918db01A62D02ee5"';
    process.env.NEXT_PUBLIC_UP_TOKEN_ADDRESS_BASE_MAINNET =
      " '0xaC27fa800955849d6D17cC8952Ba9dD6EAA66187' ";

    const addresses = getBaseMainnetTokenAddresses();

    expect(addresses.dg).toBe("0x4aA47eD29959c7053996d8f7918db01A62D02ee5");
    expect(addresses.up).toBe("0xaC27fa800955849d6D17cC8952Ba9dD6EAA66187");
  });

  it("falls back to canonical Base mainnet addresses when env is absent", () => {
    delete process.env.NEXT_PUBLIC_DG_TOKEN_ADDRESS_BASE_MAINNET;
    delete process.env.NEXT_PUBLIC_UP_TOKEN_ADDRESS_BASE_MAINNET;

    const addresses = getBaseMainnetTokenAddresses();

    expect(addresses.dg).toBe("0x4aA47eD29959c7053996d8f7918db01A62D02ee5");
    expect(addresses.up).toBe("0xaC27fa800955849d6D17cC8952Ba9dD6EAA66187");
  });

  it("uses the same DG and UP addresses for wallet transfers", () => {
    delete process.env.NEXT_PUBLIC_DG_TOKEN_ADDRESS_BASE_MAINNET;
    delete process.env.NEXT_PUBLIC_UP_TOKEN_ADDRESS_BASE_MAINNET;

    const transferAddresses = getWalletTransferTokenAddresses();

    expect(transferAddresses.dg).toBe("0x4aA47eD29959c7053996d8f7918db01A62D02ee5");
    expect(transferAddresses.up).toBe("0xaC27fa800955849d6D17cC8952Ba9dD6EAA66187");
  });
});
