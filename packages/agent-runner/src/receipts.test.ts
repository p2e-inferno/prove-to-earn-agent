import { receivedFromLogs, type KnownToken } from "./receipts";

const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const AGENT = "0x00000000000000000000000000000000000000aa" as const;
const OTHER = "0x00000000000000000000000000000000000000bb" as const;
const UP = "0x0000000000000000000000000000000000000a01" as const;
const DG = "0x0000000000000000000000000000000000000a02" as const;

const tokens: KnownToken[] = [
  { asset: "UP", tokenAddress: UP, decimals: 18 },
  { asset: "DG", tokenAddress: DG, decimals: 18 },
];

const topic = (address: string) =>
  `0x${address.slice(2).padStart(64, "0")}` as const;
const transfer = (token: string, from: string, to: string, amount: bigint) => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}` as const,
});

describe("receivedFromLogs", () => {
  it("reads the token that landed in the agent wallet", () => {
    const received = receivedFromLogs(
      [
        transfer(UP, AGENT, OTHER, 10n * 10n ** 18n),
        transfer(DG, OTHER, AGENT, 48n * 10n ** 18n),
      ],
      AGENT,
      tokens,
      "UP",
    );

    expect(received).toMatchObject({
      asset: "DG",
      raw: String(48n * 10n ** 18n),
    });
  });

  it("sums split deliveries of the same token", () => {
    const received = receivedFromLogs(
      [transfer(DG, OTHER, AGENT, 3n), transfer(DG, OTHER, AGENT, 4n)],
      AGENT,
      tokens,
    );

    expect(received?.raw).toBe("7");
  });

  // A refund of the token being spent is change, not what the action bought.
  it("ignores transfers of the asset the action spent", () => {
    expect(
      receivedFromLogs([transfer(UP, OTHER, AGENT, 5n)], AGENT, tokens, "UP"),
    ).toBeNull();
  });

  it("ignores tokens it does not know and transfers to other wallets", () => {
    expect(
      receivedFromLogs(
        [
          transfer(
            "0x0000000000000000000000000000000000000c0c",
            OTHER,
            AGENT,
            5n,
          ),
          transfer(DG, AGENT, OTHER, 5n),
        ],
        AGENT,
        tokens,
      ),
    ).toBeNull();
  });
});
