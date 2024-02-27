import { strictEqual } from "assert";
import axios from "axios";
import { Wallet, getDefaultProvider } from "ethers";
import { HttpFunction } from '@google-cloud/functions-framework';
import { PublicKey, Connection } from "@solana/web3.js";
import { getStakePoolAccount } from "@solana/spl-stake-pool";
import {
    PerChainQueryRequest,
    QueryProxyQueryResponse,
    QueryRequest,
    SolanaAccountQueryRequest,
    signaturesToEvmStruct,
} from "@wormhole-foundation/wormhole-query-sdk";

import { StakePoolRate__factory } from "../../types/ethers-contracts";
import { DATA_SLICE_LENGTH, DATA_SLICE_OFFSET } from "./consts";
import { logQueryResponseInfo } from "./utils";

export const updater: HttpFunction = async (_, res) => {
    // Get environment variables
    const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com"

    const QUERY_URL = "https://api.wormholelabs.xyz/v1/query";
    const API_KEY = process.env.API_KEY;
    if (!API_KEY) {
      throw new Error("API_KEY is required");
    }

    const ETH_NETWORK = process.env.ETH_NETWORK || "http://localhost:8545";

    const ANVIL_DEFAULT_KEYPAIR = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    let KEYPAIR = process.env.KEYPAIR || ANVIL_DEFAULT_KEYPAIR;
    if (ETH_NETWORK == "http://localhost:8545") {
        KEYPAIR = ANVIL_DEFAULT_KEYPAIR;
    }

    const JITO_SOL_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";
    const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

    const STAKE_POOL_RATE_CONTRACT = process.env.STAKE_POOL_RATE_CONTRACT || "0xf00F1cEA728A055801eEc83Bb23b2510405Bc00A";

    const connection = new Connection(SOLANA_RPC);

    const RESUBMIT_UPDATE_SECONDS = 60 * 60 * 24;

    const provider = getDefaultProvider(ETH_NETWORK);
    const signer = new Wallet(KEYPAIR, provider);

    const stakePoolRate = StakePoolRate__factory.connect(STAKE_POOL_RATE_CONTRACT, signer)

    console.log(`Contract address ${await stakePoolRate.getAddress()}`);

    const stakePoolAccount = await getStakePoolAccount(connection, new PublicKey(JITO_SOL_POOL));
    const mainnetRate = BigInt(stakePoolAccount.account.data.totalLamports.div(stakePoolAccount.account.data.poolTokenSupply).toString());

    const lastUpdatedTimeSeconds = (await stakePoolRate.lastUpdateSolanaBlockTime()) / BigInt(1_000_000);
    const totalStake =  (await stakePoolRate.totalActiveStake());
    let totalSupply = (await stakePoolRate.poolTokenSupply());
    if (totalSupply == BigInt(0)) {
        totalSupply = BigInt(1);
    }
    const lastUpdatedRate = totalStake / totalSupply;

    // Update if existing time is < RESUBMIT_UPDATE_SECONDS or the solana rate is different than bridged rate
    const updateTimeStale = BigInt(Math.floor(Date.now() / 1000)) - lastUpdatedTimeSeconds > BigInt(RESUBMIT_UPDATE_SECONDS)
    const shouldUpdate = updateTimeStale || mainnetRate != lastUpdatedRate;

    console.log(totalStake, totalSupply, lastUpdatedTimeSeconds);

    // Proceed with submitting query and updating pool
    if (shouldUpdate) {
        console.log(`Submitting query using ${SOLANA_RPC}\n`);

        const currSlot = await connection.getSlot("finalized");
        const minContextSlot = BigInt(currSlot) + BigInt(2);

        const accounts = [JITO_SOL_POOL, SYSVAR_CLOCK];

        const query = new QueryRequest(42, [
            new PerChainQueryRequest(
                1,
                new SolanaAccountQueryRequest(
                    "finalized",
                    accounts,
                    minContextSlot,
                    BigInt(DATA_SLICE_OFFSET),
                    BigInt(DATA_SLICE_LENGTH)
                )
            ),
        ]);

        const resp: QueryProxyQueryResponse = await submitQueryRequest(query, minContextSlot, API_KEY, QUERY_URL);

        const { slotNumber, blockTime, totalActiveStake, poolTokenSupply } = logQueryResponseInfo(resp.bytes);

        console.log(`\nPosting query\n`);
        const tx = await stakePoolRate.updatePool(
            `0x${resp.bytes}`,
            signaturesToEvmStruct(resp.signatures)
        );
        const receipt = await tx.wait();
        console.log("Updated            ", receipt?.hash);

        const solanaSlotNumberEth = await stakePoolRate.lastUpdateSolanaSlotNumber();
        const solanaBlockTimeEth = await stakePoolRate.lastUpdateSolanaBlockTime();
        const totalActiveStakeEth = await stakePoolRate.totalActiveStake();
        const poolTokenSupplyEth = await stakePoolRate.poolTokenSupply();
        const poolTokenValueEth = await stakePoolRate.getRate();
        const poolTokenValueAdj = Number(poolTokenValueEth) / 10 ** 18;
        console.log("solana slot number ", solanaSlotNumberEth.toString());
        console.log(
            "solana block time  ",
            new Date(Number(solanaBlockTimeEth / BigInt(1000))).toISOString()
        );
        console.log("totalActiveStakeEth", totalActiveStakeEth.toString());
        console.log("poolTokenSupplyEth ", poolTokenSupplyEth.toString());
        console.log("poolTokenValueEth  ", poolTokenValueEth.toString());
        console.log("Value adjusted     ", poolTokenValueAdj);

        strictEqual(solanaSlotNumberEth, slotNumber);
        strictEqual(solanaBlockTimeEth, blockTime);
        strictEqual(totalActiveStakeEth, totalActiveStake);
        strictEqual(poolTokenSupplyEth, poolTokenSupply);
        strictEqual(
            poolTokenValueEth,
            (totalActiveStake * BigInt(10) ** BigInt(18)) / poolTokenSupply
        );

        provider.destroy();
    }
  
    res.send("Success");
};

async function submitQueryRequest(query: QueryRequest, minContextSlot: BigInt, api_key: string, query_url: string): Promise<QueryProxyQueryResponse> {
    const serialized = Buffer.from(query.serialize()).toString("hex");
    const before = performance.now();
    const resp = (
        await axios.post<QueryProxyQueryResponse>(
            query_url,
            { bytes: serialized },
            { headers: { "X-API-Key": api_key } }
        )
    ).data;
    const after = performance.now();
    const logResp = logQueryResponseInfo(resp.bytes);
    if (minContextSlot == logResp.slotNumber) {
        console.log("\nReturned slot matches requested slot.");
    } else {
        console.error(
            "\nSlot mismatch: slotNumber: ",
            logResp.slotNumber,
            ", minContextSlot: ",
            minContextSlot
        );
    }
    console.log(`\nQuery completed in ${(after - before).toFixed(2)}ms.`)
    return resp;
}
