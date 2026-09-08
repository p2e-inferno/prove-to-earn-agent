import { bindAction, type BoundAction } from "./types";
import { uniswapSwapAction } from "./uniswap";
import {
  vendorBuyAction,
  vendorLevelUpAction,
  vendorLightUpAction,
  vendorSellAction,
} from "./vendor";
import { erc20TransferAction, ethTransferAction } from "./transfers";
import { dailyCheckinAction, deployLockAction, gasDropAction } from "./quests";

/**
 * Every on-chain capability this agent has, and nothing else.
 *
 * Adding a protocol is an entry here plus its module; it is deliberately not a
 * branch in the run loop, so an unsupported task type stays an explicit,
 * reportable outcome rather than a silently missing case. Nothing generic is
 * registered — no raw transfer, no arbitrary contract call — because an action
 * the agent can point anywhere is the safety the typed layer exists to remove.
 */
export const AGENT_ACTIONS: readonly BoundAction[] = [
  bindAction(uniswapSwapAction),
  bindAction(vendorBuyAction),
  bindAction(vendorSellAction),
  bindAction(vendorLightUpAction),
  bindAction(vendorLevelUpAction),
  bindAction(ethTransferAction),
  bindAction(erc20TransferAction),
  bindAction(deployLockAction),
  bindAction(dailyCheckinAction),
  bindAction(gasDropAction),
];

const BY_NAME = new Map(AGENT_ACTIONS.map((action) => [action.name, action]));

const BY_TASK_TYPE = new Map<string, BoundAction>();
for (const action of AGENT_ACTIONS) {
  for (const taskType of action.taskTypes) {
    if (BY_TASK_TYPE.has(taskType)) {
      throw new Error(`Two actions claim task type '${taskType}'`);
    }
    BY_TASK_TYPE.set(taskType, action);
  }
}

export function actionForTaskType(taskType: string): BoundAction | undefined {
  return BY_TASK_TYPE.get(taskType);
}

export function executableTaskTypes(): string[] {
  return [...BY_TASK_TYPE.keys()].sort();
}

export function actionByName(name: string): BoundAction | undefined {
  return BY_NAME.get(name);
}
