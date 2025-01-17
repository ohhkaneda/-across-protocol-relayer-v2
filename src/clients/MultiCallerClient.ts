import { winston, getNetworkName, assign, Contract, runTransaction, rejectAfterDelay, getTarget } from "../utils";
import { willSucceed, etherscanLink } from "../utils";
export interface AugmentedTransaction {
  contract: Contract;
  chainId: number;
  method: string;
  args: any;
  message: string;
  mrkdwn: string;
}

export class MultiCallerClient {
  private transactions: AugmentedTransaction[] = [];
  constructor(readonly logger: winston.Logger, readonly gasEstimator: any, readonly maxTxWait: number = 180) {}

  // Adds all information associated with a transaction to the transaction queue. This is the intention of the
  // caller to send a transaction. The transaction might not be executable, which should be filtered later.
  enqueueTransaction(transaction: AugmentedTransaction) {
    this.transactions.push(transaction);
  }

  transactionCount() {
    return this.transactions.length;
  }

  clearTransactionQueue() {
    this.transactions = [];
  }

  async executeTransactionQueue(simulationModeOn = false) {
    try {
      if (this.transactions.length === 0) return;
      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing tx bundle",
        number: this.transactions.length,
        simulationModeOn,
      });

      // Simulate the transaction execution for the whole queue.
      const transactionsSucceed = await Promise.all(
        this.transactions.map((transaction: AugmentedTransaction) => willSucceed(transaction))
      );

      // If any transactions will revert then log the reason and remove them from the transaction queue.
      if (transactionsSucceed.some((succeed) => !succeed.succeed))
        this.logger.error({
          at: "MultiCallerClient",
          message: "Some transaction in the queue will revert!",
          revertingTransactions: transactionsSucceed
            .filter((transaction) => !transaction.succeed)
            .map((transaction) => {
              return {
                target: getTarget(transaction.transaction.contract.address),
                args: transaction.transaction.args,
                reason: transaction.reason,
                message: transaction.transaction.message,
                mrkdwn: transaction.transaction.mrkdwn,
              };
            }),
          notificationPath: "across-error",
        });
      const validTransactions: AugmentedTransaction[] = transactionsSucceed
        .filter((transaction) => transaction.succeed)
        .map((transaction) => transaction.transaction);

      if (validTransactions.length === 0) {
        this.logger.debug({ at: "MultiCallerClient", message: "No valid transactions in the queue" });
        return;
      }

      // Group by target chain. Note that there is NO grouping by target contract. The relayer will only ever use this
      // MultiCallerClient to send multiple transactions to one target contract on a given target chain and so we dont
      // need to group by target contract. This can be further refactored with another group by if this is needed.
      const groupedTransactions: { [networkId: number]: AugmentedTransaction[] } = {};
      for (const transaction of validTransactions) {
        assign(groupedTransactions, [transaction.chainId], [transaction]);
      }

      if (simulationModeOn) {
        this.logger.debug({
          at: "MultiCallerClient",
          message: "All transactions will succeed! Logging markdown messages.",
        });
        let mrkdwn = "";
        Object.keys(groupedTransactions).forEach((chainId) => {
          mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
          groupedTransactions[chainId].forEach((transaction, groupTxIndex) => {
            mrkdwn +=
              `  ${groupTxIndex + 1}. ${transaction.message || "0 message"}: ` +
              `${transaction.mrkdwn || "0 mrkdwn"}\n`;
          });
        });
        this.logger.info({ at: "MultiCallerClient", message: "Exiting simulation mode 🎮", mrkdwn });
        this.clearTransactionQueue();
        return;
      }

      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing transactions grouped by target chain",
        txs: Object.keys(groupedTransactions).map((chainId) => ({ chainId, num: groupedTransactions[chainId].length })),
      });

      // Construct multiCall transaction for each target chain.
      const multiCallTransactionsResult = await Promise.allSettled(
        Object.keys(groupedTransactions).map((chainId) => this.buildMultiCallBundle(groupedTransactions[chainId]))
      );
      this.logger.debug({ at: "MultiCallerClient", message: "Waiting for bundle transaction inclusion" });
      const transactionReceipts = await Promise.allSettled(
        multiCallTransactionsResult.map((transaction) =>
          Promise.race([
            rejectAfterDelay(this.maxTxWait), // limit the maximum time to wait for a transaction receipt to mine.
            transaction ? (transaction as any)?.value?.wait() : null,
          ])
        )
      );

      // Each element in the bundle of receipts relates back to each set within the groupedTransactions. Produce log.
      let mrkdwn = "";
      const transactionHashes = [];
      Object.keys(groupedTransactions).forEach((chainId, chainIndex) => {
        mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
        if (transactionReceipts[chainIndex].status === "rejected") {
          mrkdwn += ` ⚠️ Transactions sent on ${getNetworkName(chainId)} failed to execute due to exceeding timeout.\n`;
        } else {
          groupedTransactions[chainId].forEach((transaction, groupTxIndex) => {
            mrkdwn += `  ${groupTxIndex + 1}. ${transaction.message || ""}: ` + `${transaction.mrkdwn || ""}\n`;
          });
          const transactionHash = (transactionReceipts[chainIndex] as any).value.transactionHash;
          mrkdwn += "tx: " + etherscanLink(transactionHash, chainId) + "\n";
          transactionHashes.push(transactionHash);
        }
      });
      this.logger.info({ at: "MultiCallerClient", message: "Multicall batch sent! 🧙‍♂️", mrkdwn });
      this.clearTransactionQueue();
      return transactionHashes;
    } catch (error) {
      this.logger.error({
        at: "MultiCallerClient",
        message: "Error executing bundle. There might be an RPC error",
        error,
        notificationPath: "across-error",
      });
    }
  }

  buildMultiCallBundle(transactions: AugmentedTransaction[]) {
    // Validate all transactions in the batch have the same target contract.
    const target = transactions[0].contract;
    if (transactions.every((tx) => tx.contract.address !== target.address)) {
      this.logger.error({
        at: "MultiCallerClient",
        message: "some transactions in the bundle contain different targets",
        transactions: transactions.map(({ contract, chainId }) => {
          return { target: getTarget(contract.address), chainId };
        }),
        notificationPath: "across-error",
      });
      return null; // If there is a problem in the targets in the bundle return null. This will be a noop.
    }
    let callData = transactions.map((tx) => tx.contract.interface.encodeFunctionData(tx.method, tx.args));
    // There should not be any duplicate call data blobs within this array. If there are there is likely an error.
    callData = [...new Set(callData)];
    this.logger.debug({ at: "MultiCallerClient", message: "Made bundle", target: getTarget(target.address), callData });
    return runTransaction(this.logger, target, "multicall", [callData]);
  }
}
