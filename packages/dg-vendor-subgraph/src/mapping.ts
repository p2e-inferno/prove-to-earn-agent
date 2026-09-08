import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  Lit,
  StageUpgraded,
  TokensPurchased,
  TokensSold,
} from "../generated/DGTokenVendor/DGTokenVendor";
import {
  LightUp,
  Purchase,
  Sale,
  StageUpgrade,
  VendorAccount,
} from "../generated/schema";

function loadAccount(address: Address, event: ethereum.Event): VendorAccount {
  let id = address.toHexString();
  let account = VendorAccount.load(id);

  if (account == null) {
    account = new VendorAccount(id);
    account.stage = 0;
    account.fuel = BigInt.zero();
    account.totalBought = BigInt.zero();
    account.totalSold = BigInt.zero();
    account.totalBurned = BigInt.zero();
    account.lightUpCount = 0;
    account.firstSeenAt = event.block.timestamp;
  }

  account.lastActivityAt = event.block.timestamp;
  return account as VendorAccount;
}

/** Log index is part of the id: one transaction can emit the same event twice. */
function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function handleTokensPurchased(event: TokensPurchased): void {
  let account = loadAccount(event.params.buyer, event);
  account.totalBought = account.totalBought.plus(event.params.baseTokenAmount);
  account.save();

  let purchase = new Purchase(eventId(event));
  purchase.account = account.id;
  purchase.baseTokenAmount = event.params.baseTokenAmount;
  purchase.swapTokenAmount = event.params.swapTokenAmount;
  purchase.fee = event.params.fee;
  purchase.txHash = event.transaction.hash as Bytes;
  purchase.blockNumber = event.block.number;
  purchase.timestamp = event.block.timestamp;
  purchase.save();
}

export function handleTokensSold(event: TokensSold): void {
  let account = loadAccount(event.params.seller, event);
  account.totalSold = account.totalSold.plus(event.params.swapTokenAmount);
  // The contract zeroes fuel on every sale, so the indexed view has to as well
  // or it will overstate what the wallet can still do.
  account.fuel = BigInt.zero();
  account.save();

  let sale = new Sale(eventId(event));
  sale.account = account.id;
  sale.swapTokenAmount = event.params.swapTokenAmount;
  sale.baseTokenAmount = event.params.baseTokenAmount;
  sale.fee = event.params.fee;
  sale.txHash = event.transaction.hash as Bytes;
  sale.blockNumber = event.block.number;
  sale.timestamp = event.block.timestamp;
  sale.save();
}

export function handleLit(event: Lit): void {
  let account = loadAccount(event.params.user, event);
  account.totalBurned = account.totalBurned.plus(event.params.burnAmount);
  account.fuel = event.params.newFuel;
  account.lightUpCount = account.lightUpCount + 1;
  account.save();

  let lightUp = new LightUp(eventId(event));
  lightUp.account = account.id;
  lightUp.burnAmount = event.params.burnAmount;
  lightUp.newFuel = event.params.newFuel;
  lightUp.txHash = event.transaction.hash as Bytes;
  lightUp.blockNumber = event.block.number;
  lightUp.timestamp = event.block.timestamp;
  lightUp.save();
}

export function handleStageUpgraded(event: StageUpgraded): void {
  let account = loadAccount(event.params.user, event);
  account.stage = event.params.newStage;
  // An upgrade consumes the fuel, so it does not carry into the next stage.
  // Points are deliberately not indexed: no event carries them, so any value
  // here would be a guess the planner could not tell from a fact.
  account.fuel = BigInt.zero();
  account.save();

  let upgrade = new StageUpgrade(eventId(event));
  upgrade.account = account.id;
  upgrade.newStage = event.params.newStage;
  upgrade.txHash = event.transaction.hash as Bytes;
  upgrade.blockNumber = event.block.number;
  upgrade.timestamp = event.block.timestamp;
  upgrade.save();
}
