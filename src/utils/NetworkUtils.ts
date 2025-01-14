import { PublicNetworks } from "@uma/common";

export function getNetworkName(networkId: number | string): string {
  try {
    const networkName = PublicNetworks[Number(networkId)].name;
    return networkName.charAt(0).toUpperCase() + networkName.slice(1);
  } catch (error) {
    if (Number(networkId) == 666) return "Hardhat1";
    if (Number(networkId) == 1337) return "Hardhat2";
    return "unknown";
  }
}
