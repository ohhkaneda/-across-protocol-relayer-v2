import { AcrossConfigStoreClient, HubPoolClient } from "../clients";
import * as interfaces from "../interfaces";
import {
  BigNumberForToken,
  PoolRebalanceLeaf,
  RelayData,
  RelayerRefundLeaf,
  RootBundle,
  UnfilledDeposit,
} from "../interfaces";
import {
  assign,
  BigNumber,
  compareAddresses,
  convertFromWei,
  shortenHexString,
  shortenHexStrings,
  toBN,
  MerkleTree,
  winston,
} from "../utils";
import { DataworkerClients } from "./DataworkerClientHelper";
import { getFillDataForSlowFillFromPreviousRootBundle } from "./FillUtils";

export function updateRunningBalance(
  runningBalances: interfaces.RunningBalances,
  l2ChainId: number,
  l1Token: string,
  updateAmount: BigNumber
) {
  // Initialize dictionary if empty.
  if (!runningBalances[l2ChainId]) runningBalances[l2ChainId] = {};
  const runningBalance = runningBalances[l2ChainId][l1Token];
  if (runningBalance) runningBalances[l2ChainId][l1Token] = runningBalance.add(updateAmount);
  else runningBalances[l2ChainId][l1Token] = updateAmount;
}

export function updateRunningBalanceForFill(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  fill: interfaces.FillWithBlock,
  updateAmount: BigNumber
) {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    fill.destinationChainId.toString(),
    fill.destinationToken,
    fill.blockNumber
  );
  updateRunningBalance(runningBalances, fill.destinationChainId, l1TokenCounterpart, updateAmount);
}

export function updateRunningBalanceForDeposit(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  deposit: interfaces.DepositWithBlock,
  updateAmount: BigNumber
) {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    deposit.originChainId.toString(),
    deposit.originToken,
    deposit.blockNumber
  );
  updateRunningBalance(runningBalances, deposit.originChainId, l1TokenCounterpart, updateAmount);
}

export function addLastRunningBalance(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient
) {
  Object.keys(runningBalances).forEach((repaymentChainId) => {
    Object.keys(runningBalances[repaymentChainId]).forEach((l1TokenAddress) => {
      const lastRunningBalance = hubPoolClient.getRunningBalanceBeforeBlockForChain(
        latestMainnetBlock,
        Number(repaymentChainId),
        l1TokenAddress
      );
      if (!lastRunningBalance.eq(toBN(0)))
        updateRunningBalance(runningBalances, Number(repaymentChainId), l1TokenAddress, lastRunningBalance);
    });
  });
}

export function initializeRunningBalancesFromRelayerRepayments(
  latestMainnetBlock: number,
  hubPoolClient: HubPoolClient,
  fillsToRefund: interfaces.FillsToRefund
) {
  const runningBalances = {};
  const realizedLpFees: interfaces.RunningBalances = {};

  if (Object.keys(fillsToRefund).length > 0) {
    Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
      Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
        const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
          repaymentChainId,
          l2TokenAddress,
          latestMainnetBlock
        );

        // Realized LP fees is only affected by relayer repayments so we'll return a brand new dictionary of those
        // mapped to each { repaymentChainId, repaymentToken } combination.
        assign(
          realizedLpFees,
          [repaymentChainId, l1TokenCounterpart],
          fillsToRefund[repaymentChainId][l2TokenAddress].realizedLpFees
        );

        // Add total repayment amount to running balances. Note: totalRefundAmount won't exist for chains that
        // only had slow fills, so we should explicitly check for it.
        if (fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount)
          assign(
            runningBalances,
            [repaymentChainId, l1TokenCounterpart],
            fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount
          );
      });
    });
  }
  return {
    runningBalances,
    realizedLpFees,
  };
}

export function addSlowFillsToRunningBalances(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  unfilledDeposits: UnfilledDeposit[]
) {
  unfilledDeposits.forEach((unfilledDeposit) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
      unfilledDeposit.deposit.originChainId.toString(),
      unfilledDeposit.deposit.originToken,
      latestMainnetBlock
    );
    updateRunningBalance(
      runningBalances,
      unfilledDeposit.deposit.destinationChainId,
      l1TokenCounterpart,
      unfilledDeposit.unfilledAmount
    );
  });
}

export function subtractExcessFromPreviousSlowFillsFromRunningBalances(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  allValidFills: interfaces.FillWithBlock[],
  chainIdListForBundleEvaluationBlockNumbers: number[]
) {
  allValidFills.forEach((fill: interfaces.FillWithBlock) => {
    const { lastFillBeforeSlowFillIncludedInRoot, rootBundleEndBlockContainingFirstFill } =
      getFillDataForSlowFillFromPreviousRootBundle(
        fill,
        allValidFills,
        hubPoolClient,
        chainIdListForBundleEvaluationBlockNumbers
      );

    // Now that we have the last fill sent in a previous root bundle that also sent a slow fill, we can compute
    // the excess that we need to decrease running balances by. This excess only exists in the case where the
    // current fill completed a deposit. There will be an excess if (1) the slow fill was never executed, and (2)
    // the slow fill was executed, but not before some partial fills were sent.

    // Note, if there is NO fill from a previous root bundle for the same deposit as this fill, then there has been
    // no slow fill payment sent to the spoke pool yet, so we can exit early.

    if (fill.totalFilledAmount.eq(fill.amount)) {
      // If first fill for this deposit is in this epoch, then no slow fill has been sent so we can ignore this fill.
      // We can check this by searching for a ProposeRootBundle event with a bundle block range that contains the
      // first fill for this deposit. If it is the same as the ProposeRootBundle event containing the
      // current fill, then the first fill is in the current bundle and we can exit early.
      const rootBundleEndBlockContainingFullFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
        fill.blockNumber,
        fill.destinationChainId,
        chainIdListForBundleEvaluationBlockNumbers
      );

      // Note: `rootBundleEndBlockContainingFirstFill` and `rootBundleEndBlockContainingFullFill` could both
      // be undefined in the case that both fills are in this current bundle, which is a normal case.
      if (rootBundleEndBlockContainingFirstFill === rootBundleEndBlockContainingFullFill) return;

      // If full fill and first fill are in different blocks, then we should always be able to find the last partial
      // fill included in the root bundle that also included the slow fill refund.
      if (!lastFillBeforeSlowFillIncludedInRoot)
        throw new Error("Can't find last fill submitted before slow fill was included in root bundle proposal");

      // Recompute how much the matched root bundle sent for this slow fill.
      const amountSentForSlowFill = lastFillBeforeSlowFillIncludedInRoot.amount.sub(
        lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount
      );

      // If this fill is a slow fill, then the excess remaining in the contract is equal to the amount sent originally
      // for this slow fill, and the amount filled. If this fill was not a slow fill, then that means the slow fill
      // was never sent, so we need to send the full slow fill back.
      const excess = fill.isSlowRelay ? amountSentForSlowFill.sub(fill.fillAmount) : amountSentForSlowFill;
      if (excess.eq(toBN(0))) return;
      updateRunningBalanceForFill(runningBalances, hubPoolClient, fill, excess.mul(toBN(-1)));
    }
  });
}

export function constructPoolRebalanceLeaves(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  realizedLpFees: interfaces.RunningBalances,
  configStoreClient: AcrossConfigStoreClient,
  maxL1TokenCount?: number,
  tokenTransferThreshold?: BigNumberForToken
) {
  // Create one leaf per L2 chain ID. First we'll create a leaf with all L1 tokens for each chain ID, and then
  // we'll split up any leaves with too many L1 tokens.
  const leaves: interfaces.PoolRebalanceLeaf[] = [];
  Object.keys(runningBalances)
    // Leaves should be sorted by ascending chain ID
    .sort((chainIdA, chainIdB) => Number(chainIdA) - Number(chainIdB))
    .map((chainId: string) => {
      // Sort addresses.
      const sortedL1Tokens = Object.keys(runningBalances[chainId]).sort((addressA, addressB) => {
        return compareAddresses(addressA, addressB);
      });

      // This begins at 0 and increments for each leaf for this { chainId, L1Token } combination.
      let groupIndexForChainId = 0;

      // Split addresses into multiple leaves if there are more L1 tokens than allowed per leaf.
      const maxL1TokensPerLeaf =
        maxL1TokenCount || configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(latestMainnetBlock);
      for (let i = 0; i < sortedL1Tokens.length; i += maxL1TokensPerLeaf) {
        const l1TokensToIncludeInThisLeaf = sortedL1Tokens.slice(i, i + maxL1TokensPerLeaf);

        const transferThresholds = l1TokensToIncludeInThisLeaf.map(
          (l1Token) =>
            tokenTransferThreshold[l1Token] ||
            configStoreClient.getTokenTransferThresholdForBlock(l1Token, latestMainnetBlock)
        );

        leaves.push({
          chainId: Number(chainId),
          bundleLpFees: realizedLpFees[chainId]
            ? l1TokensToIncludeInThisLeaf.map((l1Token) => realizedLpFees[chainId][l1Token])
            : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
          netSendAmounts: runningBalances[chainId]
            ? l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
                getNetSendAmountForL1Token(transferThresholds[index], runningBalances[chainId][l1Token])
              )
            : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
          runningBalances: runningBalances[chainId]
            ? l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
                getRunningBalanceForL1Token(transferThresholds[index], runningBalances[chainId][l1Token])
              )
            : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
          groupIndex: groupIndexForChainId++,
          leafId: leaves.length,
          l1Tokens: l1TokensToIncludeInThisLeaf,
        });
      }
    });
  return leaves;
}

// If the running balance is greater than the token transfer threshold, then set the net send amount
// equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
// 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
// pool when executing this leaf.
export function getNetSendAmountForL1Token(transferThreshold: BigNumber, runningBalance: BigNumber): BigNumber {
  return runningBalance.abs().gte(transferThreshold) ? runningBalance : toBN(0);
}

export function getRunningBalanceForL1Token(transferThreshold: BigNumber, runningBalance: BigNumber): BigNumber {
  return runningBalance.abs().lt(transferThreshold) ? runningBalance : toBN(0);
}

// This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
// when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
// (because we can't evaluate events in the future), and greater than the the expected start blocks, which are the
// greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
export async function getWidestPossibleExpectedBlockRange(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  clients: DataworkerClients,
  latestMainnetBlock: number
): Promise<number[][]> {
  const latestBlockNumbers = await Promise.all(
    chainIdListForBundleEvaluationBlockNumbers.map((chainId: number) =>
      clients.spokePoolSigners[chainId].provider.getBlockNumber()
    )
  );
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => [
    clients.hubPoolClient.getNextBundleStartBlockNumber(
      chainIdListForBundleEvaluationBlockNumbers,
      latestMainnetBlock,
      chainId
    ),
    latestBlockNumbers[index],
  ]);
}

export function generateMarkdownForDisputeInvalidBundleBlocks(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  pendingRootBundle: RootBundle,
  widestExpectedBlockRange: number[][],
  buffers: number[]
) {
  const getBlockRangePretty = (blockRange: number[][] | number[]) => {
    let bundleBlockRangePretty = "";
    chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
      bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(blockRange[index])}`;
    });
    return bundleBlockRangePretty;
  };
  return (
    `Disputed pending root bundle because of invalid bundle blocks:` +
    `\n\t*Widest possible expected block range*:${getBlockRangePretty(widestExpectedBlockRange)}` +
    `\n\t*Buffers to end blocks*:${getBlockRangePretty(buffers)}` +
    `\n\t*Pending end blocks*:${getBlockRangePretty(pendingRootBundle.bundleEvaluationBlockNumbers)}`
  );
}

export function generateMarkdownForDispute(pendingRootBundle: RootBundle) {
  return (
    `Disputed pending root bundle:` +
    `\n\tPoolRebalance leaf count: ${pendingRootBundle.unclaimedPoolRebalanceLeafCount}` +
    `\n\tPoolRebalance root: ${shortenHexString(pendingRootBundle.poolRebalanceRoot)}` +
    `\n\tRelayerRefund root: ${shortenHexString(pendingRootBundle.relayerRefundRoot)}` +
    `\n\tSlowRelay root: ${shortenHexString(pendingRootBundle.slowRelayRoot)}` +
    `\n\tProposer: ${shortenHexString(pendingRootBundle.proposer)}`
  );
}

export function generateMarkdownForRootBundle(
  hubPoolClient: HubPoolClient,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  hubPoolChainId: number,
  bundleBlockRange: number[][],
  poolRebalanceLeaves: any[],
  poolRebalanceRoot: string,
  relayerRefundLeaves: any[],
  relayerRefundRoot: string,
  slowRelayLeaves: any[],
  slowRelayRoot: string
): string {
  // Create helpful logs to send to slack transport
  let bundleBlockRangePretty = "";
  chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
    bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(bundleBlockRange[index])}`;
  });

  const convertTokenListFromWei = (chainId: number, tokenAddresses: string[], weiVals: string[]) => {
    return tokenAddresses.map((token, index) => {
      const { decimals } = hubPoolClient.getTokenInfo(chainId, token);
      return convertFromWei(weiVals[index], decimals);
    });
  };
  const convertTokenAddressToSymbol = (chainId: number, tokenAddress: string) => {
    return hubPoolClient.getTokenInfo(chainId, tokenAddress).symbol;
  };
  const convertL1TokenAddressesToSymbols = (l1Tokens: string[]) => {
    return l1Tokens.map((l1Token) => {
      return convertTokenAddressToSymbol(hubPoolChainId, l1Token);
    });
  };
  let poolRebalanceLeavesPretty = "";
  poolRebalanceLeaves.forEach((leaf, index) => {
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.groupId = leaf.groupIndex;
    delete leaf.groupIndex;
    leaf.bundleLpFees = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.bundleLpFees);
    leaf.runningBalances = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.runningBalances);
    leaf.netSendAmounts = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.netSendAmounts);
    leaf.l1Tokens = convertL1TokenAddressesToSymbols(leaf.l1Tokens);
    poolRebalanceLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });

  let relayerRefundLeavesPretty = "";
  relayerRefundLeaves.forEach((leaf, index) => {
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.amountToReturn = convertFromWei(
      leaf.amountToReturn,
      hubPoolClient.getTokenInfo(leaf.chainId, leaf.l2TokenAddress).decimals
    );
    leaf.refundAmounts = convertTokenListFromWei(
      leaf.chainId,
      Array(leaf.refundAmounts.length).fill(leaf.l2TokenAddress),
      leaf.refundAmounts
    );
    leaf.l2Token = convertTokenAddressToSymbol(leaf.chainId, leaf.l2TokenAddress);
    delete leaf.l2TokenAddress;
    leaf.refundAddresses = shortenHexStrings(leaf.refundAddresses);
    relayerRefundLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });

  let slowRelayLeavesPretty = "";
  slowRelayLeaves.forEach((leaf, index) => {
    const decimalsForDestToken = hubPoolClient.getTokenInfo(leaf.destinationChainId, leaf.destinationToken).decimals;
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.originChain = leaf.originChainId;
    leaf.destinationChain = leaf.destinationChainId;
    leaf.depositor = shortenHexString(leaf.depositor);
    leaf.recipient = shortenHexString(leaf.recipient);
    leaf.destToken = convertTokenAddressToSymbol(leaf.destinationChainId, leaf.destinationToken);
    leaf.amount = convertFromWei(leaf.amount, decimalsForDestToken);
    leaf.realizedLpFee = `${convertFromWei(leaf.realizedLpFeePct, decimalsForDestToken)}%`;
    leaf.relayerFee = `${convertFromWei(leaf.relayerFeePct, decimalsForDestToken)}%`;
    delete leaf.destinationToken;
    delete leaf.realizedLpFeePct;
    delete leaf.relayerFeePct;
    delete leaf.originChainId;
    delete leaf.destinationChainId;
    slowRelayLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });
  return (
    `\n\t*Bundle blocks*:${bundleBlockRangePretty}` +
    `\n\t*PoolRebalance*:\n\t\troot:${shortenHexString(
      poolRebalanceRoot
    )}...\n\t\tleaves:${poolRebalanceLeavesPretty}` +
    `\n\t*RelayerRefund*\n\t\troot:${shortenHexString(relayerRefundRoot)}...\n\t\tleaves:${relayerRefundLeavesPretty}` +
    `\n\t*SlowRelay*\n\troot:${shortenHexString(slowRelayRoot)}...\n\t\tleaves:${slowRelayLeavesPretty}`
  );
}

export function prettyPrintLeaves(
  logger: winston.Logger,
  tree: MerkleTree<PoolRebalanceLeaf> | MerkleTree<RelayerRefundLeaf> | MerkleTree<RelayData>,
  leaves: PoolRebalanceLeaf[] | RelayerRefundLeaf[] | RelayData[],
  logType = "Pool rebalance"
) {
  leaves.forEach((leaf, index) => {
    const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
      // Check if leaf value is list of BN's or single BN.
      if (Array.isArray(leaf[key]) && BigNumber.isBigNumber(leaf[key][0]))
        result[key] = leaf[key].map((val) => val.toString());
      else if (BigNumber.isBigNumber(leaf[key])) result[key] = leaf[key].toString();
      else result[key] = leaf[key];
      return result;
    }, {});
    logger.debug({
      at: "Dataworker#propose",
      message: `${logType} leaf #${index}`,
      leaf: prettyLeaf,
      proof: tree.getHexProof(leaf),
    });
  });
}