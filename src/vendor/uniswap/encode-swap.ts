/**
 * Universal Router command encoder for Uniswap V3 swaps with fee splitting.
 *
 * Command sequences by direction:
 * - ETH -> Token (buy): WRAP_ETH -> V3_SWAP_EXACT_IN -> PAY_PORTION -> SWEEP(token)
 * - Token -> ETH (sell): V3_SWAP_EXACT_IN -> PAY_PORTION(WETH) -> UNWRAP_WETH -> SWEEP(ETH)
 * - Token -> Token (UP <-> USDC via WETH): V3_SWAP_EXACT_IN(multi-hop) -> PAY_PORTION -> SWEEP(tokenOut)
 */

import { encodeAbiParameters, parseAbiParameters } from "viem";

/**
 * Command byte constants from the Universal Router's Commands.sol.
 * Verified against: https://github.com/Uniswap/universal-router/blob/main/contracts/libraries/Commands.sol
 */
export const COMMAND = {
  V3_SWAP_EXACT_IN: 0x00,
  SWEEP: 0x04,
  PAY_PORTION: 0x06,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
} as const;

/** Special Universal Router recipient addresses */
const ROUTER_AS_RECIPIENT =
  "0x0000000000000000000000000000000000000002" as `0x${string}`;

/** Native ETH sentinel used by SWEEP after UNWRAP_WETH */
const ETH_ADDRESS =
  "0x0000000000000000000000000000000000000000" as `0x${string}`;

/** keccak256("execute(bytes,bytes[],uint256)") first 4 bytes */
const EXECUTE_SELECTOR = "0x3593564c";

export interface EncodeSwapConfig {
  /**
   * The output token address used by PAY_PORTION and SWEEP.
   * When isNativeEthOut=true (sell direction), this MUST be the WETH address —
   * the V3 swap yields WETH which PAY_PORTION operates on before UNWRAP_WETH
   * converts the remainder to native ETH. Passing address(0) here would cause
   * PAY_PORTION to silently fail.
   */
  tokenOut: `0x${string}`;
  path: `0x${string}`;
  amountIn: bigint;
  amountOutMin: bigint;
  recipient: `0x${string}`;
  feeRecipient: `0x${string}`;
  feeBips: number;
  isNativeEthIn: boolean;
  isNativeEthOut: boolean;
  deadline: number;
}

export function encodeSwapWithFeeManual(config: EncodeSwapConfig): {
  calldata: `0x${string}`;
  value: bigint;
} {
  // Guard: when selling to native ETH, tokenOut must be WETH (not zero address)
  // so PAY_PORTION can operate on the swap's WETH output.
  if (
    config.isNativeEthOut &&
    config.tokenOut === ("0x0000000000000000000000000000000000000000" as `0x${string}`)
  ) {
    throw new Error(
      "tokenOut must be the WETH address when isNativeEthOut=true (PAY_PORTION operates on WETH before UNWRAP_WETH)",
    );
  }

  const commands: number[] = [];
  const inputs: `0x${string}`[] = [];

  // Calculate the minimum the user should receive after fees (for SWEEP defense-in-depth)
  const sweepAmountMin =
    config.amountOutMin -
    (config.amountOutMin * BigInt(config.feeBips)) / 10_000n;

  // --- Step 1: If paying with native ETH, wrap it first ---
  if (config.isNativeEthIn) {
    commands.push(COMMAND.WRAP_ETH);
    inputs.push(
      encodeAbiParameters(parseAbiParameters("address recipient, uint256 amountMin"), [
        ROUTER_AS_RECIPIENT,
        config.amountIn,
      ]) as `0x${string}`,
    );
  }

  // --- Step 2: V3_SWAP_EXACT_IN — output goes to Router (held temporarily) ---
  commands.push(COMMAND.V3_SWAP_EXACT_IN);
  inputs.push(
    encodeAbiParameters(
      parseAbiParameters(
        "address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser",
      ),
      [
        ROUTER_AS_RECIPIENT,
        config.amountIn,
        config.amountOutMin,
        config.path,
        !config.isNativeEthIn,
      ],
    ) as `0x${string}`,
  );

  // --- Step 3: PAY_PORTION — send fee% of output token to fee wallet ---
  // Note: When isNativeEthOut, fee is paid in WETH (fee wallet receives WETH, not ETH).
  commands.push(COMMAND.PAY_PORTION);
  inputs.push(
    encodeAbiParameters(
      parseAbiParameters("address token, address recipient, uint256 bips"),
      [config.tokenOut, config.feeRecipient, BigInt(config.feeBips)],
    ) as `0x${string}`,
  );

  // --- Step 4: Handle output delivery ---
  if (config.isNativeEthOut) {
    // Sell direction (Token -> ETH): unwrap WETH to native ETH, then sweep ETH to user
    commands.push(COMMAND.UNWRAP_WETH);
    inputs.push(
      encodeAbiParameters(
        parseAbiParameters("address recipient, uint256 amountMin"),
        [ROUTER_AS_RECIPIENT, sweepAmountMin],
      ) as `0x${string}`,
    );

    // SWEEP native ETH (address(0)) to the user
    commands.push(COMMAND.SWEEP);
    inputs.push(
      encodeAbiParameters(
        parseAbiParameters("address token, address recipient, uint256 amountMin"),
        [ETH_ADDRESS, config.recipient, sweepAmountMin],
      ) as `0x${string}`,
    );
  } else {
    // ERC20 output path (ETH->Token or Token->Token): sweep output token directly to user
    commands.push(COMMAND.SWEEP);
    inputs.push(
      encodeAbiParameters(
        parseAbiParameters("address token, address recipient, uint256 amountMin"),
        [config.tokenOut, config.recipient, sweepAmountMin],
      ) as `0x${string}`,
    );
  }

  // --- Encode the execute(bytes,bytes[],uint256) call ---
  const commandBytes = `0x${commands.map((c) => c.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
  const calldata = encodeAbiParameters(
    parseAbiParameters("bytes commands, bytes[] inputs, uint256 deadline"),
    [commandBytes, inputs, BigInt(config.deadline)],
  ) as `0x${string}`;

  // Prepend the function selector for execute(bytes,bytes[],uint256)
  const finalCalldata =
    `${EXECUTE_SELECTOR}${calldata.slice(2)}` as `0x${string}`;

  return {
    calldata: finalCalldata,
    value: config.isNativeEthIn ? config.amountIn : 0n,
  };
}
