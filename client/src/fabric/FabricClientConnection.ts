/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

'use strict';

import { FabricWallet } from './FabricWallet';
import { ExtensionUtil } from '../util/ExtensionUtil';
import { IFabricClientConnection } from './IFabricClientConnection';
import { FabricWalletRegistryEntry } from './FabricWalletRegistryEntry';
import { Gateway, Network, Contract, IdentityInfo, GatewayOptions, FileSystemWallet } from 'fabric-network';
import * as Client from 'fabric-client';
import { URL } from 'url';

export class FabricClientConnection implements IFabricClientConnection {
    
    public identityName: string;
    public wallet: FabricWalletRegistryEntry;
    
    private connectionProfilePath: string;
    private mspid: string;
    private gateway: Gateway = new Gateway();
    private networkIdProperty: boolean;
    private discoveryAsLocalhost: boolean;
    private discoveryEnabled: boolean;

    constructor(connectionData: { connectionProfilePath: string, walletPath: string }) {
        this.connectionProfilePath = connectionData.connectionProfilePath;
        this.gateway = new Gateway();
    }

    public isIBPConnection(): boolean {
        return this.networkIdProperty;
    }

    async connect(wallet: FabricWallet, identityName: string): Promise<void> {
        console.log('FabricClientConnection: connect');
        const connectionProfile: object = await ExtensionUtil.readConnectionProfile(this.connectionProfilePath);
        await this.connectInner(connectionProfile, wallet, identityName);
    }

    public getAllPeerNames(): Array<string> {
        console.log('getAllPeerNames');
        const allPeers: Array<Client.Peer> = this.getAllPeers();

        const peerNames: Array<string> = [];

        allPeers.forEach((peer: Client.Peer) => {
            peerNames.push(peer.getName());
        });

        return peerNames;
    }

    public async getAllChannelsForPeer(peerName: string): Promise<Array<string>> {
        console.log('getAllChannelsForPeer', peerName);
        // TODO: update this when not just using admin
        const peer: Client.Peer = this.getPeer(peerName);
        const channelResponse: Client.ChannelQueryResponse = await this.gateway.getClient().queryChannels(peer);

        const channelNames: Array<string> = [];
        console.log(channelResponse);
        channelResponse.channels.forEach((channel: Client.ChannelInfo) => {
            channelNames.push(channel.channel_id);
        });

        return channelNames.sort();
    }

    public async getInstantiatedChaincode(channelName: string): Promise<Array<{ name: string, version: string }>> {
        console.log('getInstantiatedChaincode');
        const instantiatedChaincodes: Array<any> = [];
        const channel: Client.Channel = await this.getChannel(channelName);
        const chainCodeResponse: Client.ChaincodeQueryResponse = await channel.queryInstantiatedChaincodes(null);
        chainCodeResponse.chaincodes.forEach((chainCode: Client.ChaincodeInfo) => {
            instantiatedChaincodes.push({ name: chainCode.name, version: chainCode.version });
        });

        return instantiatedChaincodes;
    }

    public disconnect(): void {
        this.gateway.disconnect();
    }

    public async getMetadata(instantiatedChaincodeName: string, channel: string): Promise<any> {
        const network: Network = await this.gateway.getNetwork(channel);
        const smartContract: Contract = network.getContract(instantiatedChaincodeName);

        let metadataBuffer: Buffer;
        try {
            metadataBuffer = await smartContract.evaluateTransaction('org.hyperledger.fabric:GetMetadata');
        } catch (error) {
            // This is the most likely case; smart contract does not support metadata.
            throw new Error(`Transaction function "org.hyperledger.fabric:GetMetadata" returned an error: ${error.message}`);
        }
        const metadataString: string = metadataBuffer.toString();
        if (!metadataString) {
            // This is the unusual case; the function name is ignored, or accepted, but an empty string is returned.
            throw new Error(`Transaction function "org.hyperledger.fabric:GetMetadata" did not return any metadata`);
        }
        try {
            const metadataObject: any = JSON.parse(metadataBuffer.toString());

            console.log('Metadata object is:', metadataObject);
            return metadataObject;
        } catch (error) {
            // This is another unusual case; the function name is ignored, or accepted, but non-JSON data is returned.
            throw new Error(`Transaction function "org.hyperledger.fabric:GetMetadata" did not return valid JSON metadata: ${error.message}`);
        }
    }

    public async submitTransaction(chaincodeName: string, transactionName: string, channel: string, args: Array<string>, namespace: string, evaluate?: boolean): Promise<string | undefined> {
        const network: Network = await this.gateway.getNetwork(channel);
        const smartContract: Contract = network.getContract(chaincodeName, namespace);

        let response: Buffer;
        if (evaluate) {
            response = await smartContract.evaluateTransaction(transactionName, ...args);
        } else {
            response = await smartContract.submitTransaction(transactionName, ...args);
        }

        if (response.buffer.byteLength === 0) {
            // If the transaction returns no data
            return undefined;
        } else {
            // Turn the response into a string
            const result: any = response.toString('utf8');
            return result;
        }

    }

    protected async connectInner(connectionProfile: object, wallet: FileSystemWallet, identityName: string): Promise<void> {

        this.networkIdProperty = (connectionProfile['x-networkId'] ? true : false);

        this.discoveryAsLocalhost = this.hasLocalhostURLs(connectionProfile);
        this.discoveryEnabled = true;

        const options: GatewayOptions = {
            wallet: wallet,
            identity: identityName,
            discovery: {
                asLocalhost: this.discoveryAsLocalhost,
                enabled: this.discoveryEnabled
            }
        };

        await this.gateway.connect(connectionProfile, options);

        const identities: IdentityInfo[] = await wallet.list();
        const identity: IdentityInfo = identities.find((identityToSearch: IdentityInfo) => {
            return identityToSearch.label === identityName;
        });

        // TODO: remove this?
        this.mspid = identity.mspId;
    }

    private isLocalhostURL(url: string): boolean {
        const parsedURL: URL = new URL(url);
        const localhosts: string[] = [
            'localhost',
            '127.0.0.1'
        ];
        return localhosts.indexOf(parsedURL.hostname) !== -1;
    }

    private hasLocalhostURLs(connectionProfile: any): boolean {
        const urls: string[] = [];
        for (const nodeType of ['orderers', 'peers', 'certificateAuthorities']) {
            if (!connectionProfile[nodeType]) {
                continue;
            }
            const nodes: any = connectionProfile[nodeType];
            for (const nodeName in nodes) {
                if (!nodes[nodeName].url) {
                    continue;
                }
                urls.push(nodes[nodeName].url);
            }
        }
        return urls.some((url: string) => this.isLocalhostURL(url));
    }

    private async getChannel(channelName: string): Promise<Client.Channel> {
        console.log('getChannel', channelName);
        const client: Client = this.gateway.getClient();
        let channel: Client.Channel = client.getChannel(channelName, false);
        if (channel) {
            return channel;
        }
        channel = client.newChannel(channelName);
        const peers: Client.Peer[] = this.getAllPeers();
        let lastError: Error = new Error(`Could not discover information for channel ${channelName} from known peers`);
        for (const target of peers) {
            try {
                await channel.initialize({ asLocalhost: this.discoveryAsLocalhost, discover: this.discoveryEnabled, target });
                return channel;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }

    private getAllPeers(): Array<Client.Peer> {
        console.log('getAllPeers');

        return this.gateway.getClient().getPeersForOrg(this.mspid);
    }

    private getPeer(name: string): Client.Peer {
        console.log('getPeer', name);
        const allPeers: Array<Client.Peer> = this.getAllPeers();

        return allPeers.find((peer: Client.Peer) => {
            return peer.getName() === name;
        });
    }

}
