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

import { OutputAdapter, LogType } from '../logging/OutputAdapter';
import * as Client from 'fabric-client';
import * as FabricCAServices from 'fabric-ca-client';
import { ConsoleOutputAdapter } from '../logging/ConsoleOutputAdapter';
import { PackageRegistryEntry } from '../packages/PackageRegistryEntry';
import * as fs from 'fs-extra';
import { IFabricRuntimeConnection } from './IFabricRuntimeConnection';
import { FabricRuntime, FabricNode, FabricNodeType } from './FabricRuntime';
import { IFabricWalletGenerator } from './IFabricWalletGenerator';
import { FabricWalletGeneratorFactory } from './FabricWalletGeneratorFactory';
import { IFabricWallet } from './IFabricWallet';

export class FabricChannel {
    public name: string;
    public peers: Map<string, Client.Peer> = new Map<string, Client.Peer>();
    public eventHubs: Map<string, Client.ChannelEventHub> = new Map<string, Client.ChannelEventHub>();
    public ordererName: string;
    public orderer: Client.Orderer;
    public actualChannel: Client.Channel;
}

export class FabricRuntimeConnection implements IFabricRuntimeConnection {

    private client: Client;
    private nodes: Map<string, FabricNode> = new Map<string, FabricNode>();
    private peers: Map<string, Client.Peer> = new Map<string, Client.Peer>();
    private orderers: Map<string, Client.Orderer> = new Map<string, Client.Orderer>();
    private certificateAuthorities: Map<string, FabricCAServices> = new Map<string, FabricCAServices>();
    private channels: Map<string, FabricChannel> = new Map<string, FabricChannel>();
    private networkIdProperty: boolean;
    private outputAdapter: OutputAdapter;

    constructor(private runtime: FabricRuntime, outputAdapter?: OutputAdapter) {
        this.client = new Client();
        this.client.setCryptoSuite(Client.newCryptoSuite());
        if (!outputAdapter) {
            this.outputAdapter = ConsoleOutputAdapter.instance();
        } else {
            this.outputAdapter = outputAdapter;
        }
    }

    public isIBPConnection(): boolean {
        return this.networkIdProperty;
    }

    async connect(): Promise<void> {
        console.log('FabricRuntimeConnection: connect');
        const nodes: FabricNode[] = await this.runtime.getNodes();
        for (const node of nodes) {
            if (node.type === FabricNodeType.PEER) {
                const peer: Client.Peer = this.client.newPeer(node.url);
                this.peers.set(node.name, peer);
            } else if (node.type === FabricNodeType.ORDERER) {
                const orderer: Client.Orderer = this.client.newOrderer(node.url);
                this.orderers.set(node.name, orderer);
            } else if (node.type === FabricNodeType.CA) {
                const certificateAuthority = new FabricCAServices(node.url, null, node.name, this.client.getCryptoSuite());
                this.certificateAuthorities.set(node.name, certificateAuthority);
            }
            this.nodes.set(node.name, node);
        }
        await this.createChannelMap();
    }

    public getNode(nodeName: string): FabricNode {
        return this.nodes.get(nodeName);
    }

    public getAllPeerNames(): Array<string> {
        const peerNames: string[] = [];
        for (const peerName of this.peers.keys()) {
            peerNames.push(peerName);
        }
        return peerNames;
    }

    public getPeer(name: string): Client.Peer {
        return this.peers.get(name);
    }

    public async getOrganizations(channelName: string): Promise<any[]> {
        console.log('getOrganizations', channelName);
        // const network: Network = await this.gateway.getNetwork(channelName);
        // const channel: Client.Channel = network.getChannel();
        // const orgs: any[] = channel.getOrganizations();
        // return orgs;
        return [];
    }

    public getAllCertificateAuthorityNames(): Array<string> {
        const certificateAuthorityNames: string[] = [];
        for (const [certificateAuthorityName] of this.certificateAuthorities) {
            certificateAuthorityNames.push(certificateAuthorityName);
        }
        return certificateAuthorityNames;
        
    }

    public async getAllChannelsForPeer(peerName: string): Promise<Array<string>> {
        console.log('getAllChannelsForPeer', peerName);
        await this.setUserContext(peerName);
        const peer: Client.Peer = this.getPeer(peerName);
        const channelResponse: Client.ChannelQueryResponse = await this.client.queryChannels(peer);

        const channelNames: Array<string> = [];
        console.log(channelResponse);
        channelResponse.channels.forEach((channel: Client.ChannelInfo) => {
            channelNames.push(channel.channel_id);
        });

        return channelNames.sort();
    }

    public async getInstalledChaincode(peerName: string): Promise<Map<string, Array<string>>> {
        console.log('getInstalledChaincode', peerName);
        await this.setUserContext(peerName);
        const installedChainCodes: Map<string, Array<string>> = new Map<string, Array<string>>();
        const peer: Client.Peer = this.getPeer(peerName);
        let chaincodeResponse: Client.ChaincodeQueryResponse;
        try {
            chaincodeResponse = await this.client.queryInstalledChaincodes(peer);
        } catch (error) {
            if (error.message && error.message.match(/access denied/)) {
                // Not allowed to do this as we're probably not an administrator.
                // This is probably not the end of the world, so return the empty map.
                return installedChainCodes;
            }
            throw error;
        }
        chaincodeResponse.chaincodes.forEach((chaincode: Client.ChaincodeInfo) => {
            if (installedChainCodes.has(chaincode.name)) {
                installedChainCodes.get(chaincode.name).push(chaincode.version);
            } else {
                installedChainCodes.set(chaincode.name, [chaincode.version]);
            }
        });

        return installedChainCodes;
    }

    public async getInstantiatedChaincode(channelName: string): Promise<Array<{ name: string, version: string }>> {
        console.log('getInstantiatedChaincode');
        const instantiatedChaincodes: Array<any> = [];
        const channel: FabricChannel = this.channels.get(channelName);
        const [peerName, peer] = Array.from(channel.peers)[0];
        await this.setUserContext(peerName);
        const chainCodeResponse: Client.ChaincodeQueryResponse = await channel.actualChannel.queryInstantiatedChaincodes(peer);
        chainCodeResponse.chaincodes.forEach((chainCode: Client.ChaincodeInfo) => {
            instantiatedChaincodes.push({ name: chainCode.name, version: chainCode.version });
        });

        return instantiatedChaincodes;
    }

    public async installChaincode(packageRegistryEntry: PackageRegistryEntry, peerName: string): Promise<void> {
        const peer: Client.Peer = this.getPeer(peerName);
        const pkgBuffer: Buffer = await fs.readFile(packageRegistryEntry.path);
        const installRequest: Client.ChaincodePackageInstallRequest = {
            targets: [peer],
            chaincodePackage: pkgBuffer,
            txId: this.client.newTransactionID()
        };
        await this.setUserContext(peerName);
        const response: Client.ProposalResponseObject = await this.client.installChaincode(installRequest);
        const proposalResponse: Client.ProposalResponse | Error = response[0][0];
        if (proposalResponse instanceof Error) {
            throw proposalResponse;
        } else if (proposalResponse.response.status !== 200) {
            throw new Error(proposalResponse.response.message);
        }
    }

    public async instantiateChaincode(name: string, version: string, channelName: string, fcn: string, args: Array<string>): Promise<any> {
        const instantiatedChaincode: Array<any> = await this.getInstantiatedChaincode(channelName);
        const foundChaincode: any = this.getChaincode(name, instantiatedChaincode);
        if (foundChaincode) {
            throw new Error('The name of the contract you tried to instantiate is already instantiated');
        }
        const message: string = `Instantiating with function: '${fcn}' and arguments: '${args}'`;
        this.outputAdapter.log(LogType.INFO, undefined, message);
        return this.instantiateUpgradeChaincode(name, version, channelName, fcn, args, false);
    }

    private async instantiateUpgradeChaincode(name: string, version: string, channelName: string, fcn: string, args: Array<string>, upgrade: boolean): Promise<any> {
        const channel: FabricChannel = this.channels.get(channelName);
        const [peerName, peer]: [string, Client.Peer] = Array.from(channel.peers)[0];
        const [, eventHub]: [string, Client.ChannelEventHub] = Array.from(channel.eventHubs)[0];
        const orderer: Client.Orderer = channel.orderer;
        const actualChannel: Client.Channel = channel.actualChannel;

        const transactionId: Client.TransactionId = this.client.newTransactionID();
        const instantiateRequest: Client.ChaincodeInstantiateUpgradeRequest = {
            chaincodeId: name,
            chaincodeVersion: version,
            txId: transactionId,
            fcn: fcn,
            args: args,
            targets: [peer]
        };

        let proposal: Client.Proposal;
        let proposalResponses: (Client.ProposalResponse | Error)[];
        await this.setUserContext(peerName);
        if (!upgrade) {
            [proposalResponses, proposal] = await actualChannel.sendInstantiateProposal(instantiateRequest);
        } else {
            [proposalResponses, proposal] = await actualChannel.sendUpgradeProposal(instantiateRequest);
        }

        const goodProposalResponses: Client.ProposalResponse[] = [];
        for (const proposalResponse of proposalResponses) {
            if (proposalResponse instanceof Error) {
                throw proposalResponse;
            } else if (proposalResponse.response.status !== 200){
                throw new Error(proposalResponse.response.message);
            } else {
                goodProposalResponses.push(proposalResponse);
            }
        }

        const eventHubPromise = new Promise((resolve, reject) => {
            eventHub.registerTxEvent(
                transactionId.getTransactionID(),
                (txId: string, code: string, blockNumber: number) => {
                    if (code !== 'VALID') {
                        return reject(new Error(`transaction validation failed: ${code}`));
                    }
                    resolve();
                },
                (err: any) => reject(err),
                { disconnect: true, unregister: true }
            );
            eventHub.connect();
        });
        await this.setUserContext(peerName);
        const broadcastResponse = await actualChannel.sendTransaction({ proposalResponses: goodProposalResponses, proposal, orderer });
        if (broadcastResponse.status !== 'SUCCESS') {
            const msg: string = `Failed to send peer responses for transaction ${transactionId.getTransactionID()} to orderer. Response status: ${broadcastResponse.status}`;
            throw new Error(msg);
        }
        await eventHubPromise;

        // return the payload from the invoked chaincode
        let result: any = null;
        if (goodProposalResponses[0].response.payload.length > 0) {
            result = goodProposalResponses[0].response.payload;
        }
        return result;
    }

    public disconnect(): void {
        for (const [, peer] of this.peers) {
            peer.close();
        }
        for (const [, orderer] of this.orderers) {
            orderer.close();
        }
    }

    public async upgradeChaincode(name: string, version: string, channelName: string, fcn: string, args: Array<string>): Promise<any> {
        const instantiatedChaincode: Array<any> = await this.getInstantiatedChaincode(channelName);
        const foundChaincode: any = this.getChaincode(name, instantiatedChaincode);
        if (!foundChaincode) {
            throw new Error('The contract you tried to upgrade with has no previous versions instantiated');
        }
        const message: string = `Upgrading with function: '${fcn}' and arguments: '${args}'`;
        this.outputAdapter.log(LogType.INFO, undefined, message);
        return this.instantiateUpgradeChaincode(name, version, channelName, fcn, args, true);
    }

    public async enroll(certificateAuthorityName: string, enrollmentID: string, enrollmentSecret: string): Promise<{certificate: string, privateKey: string}> {
        const certificateAuthority: FabricCAServices = this.certificateAuthorities.get(certificateAuthorityName);
        const enrollment: FabricCAServices.IEnrollResponse = await certificateAuthority.enroll({ enrollmentID, enrollmentSecret });
        return { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() };
    }

    public getAllOrdererNames(): Array<string> {
        const ordererNames: string[] = [];
        for (const [ordererName] of this.orderers) {
            ordererNames.push(ordererName);
        }
        return ordererNames;
    }

    public async register(certificateAuthorityName: string, enrollmentID: string, affiliation: string): Promise<string> {
        const certificateAuthority: FabricCAServices = this.certificateAuthorities.get(certificateAuthorityName);
        const request: FabricCAServices.IRegisterRequest = {
            enrollmentID: enrollmentID,
            affiliation: affiliation,
            role: 'client'
        };
        await this.setUserContext(certificateAuthorityName);
        const registrar: Client.User = await this.client.getUserContext('', false);
        const secret: string = await certificateAuthority.register(request, registrar);
        return secret;
    }

    /**
     * Get a chaincode from a list of list of chaincode
     * @param name {String} The name of the chaincode to find
     * @param chaincodeArray {Array<any>} An array of chaincode to search
     * @returns {any} Returns a chaincode from the given array where the name matches the users input
     */
    private getChaincode(name: string, chaincodeArray: Array<any>): any {
        return chaincodeArray.find((chaincode: any) => {
            return chaincode.name === name;
        });
    }

    private async setUserContext(nodeName: string): Promise<void> {
        const node: FabricNode = this.nodes.get(nodeName);
        if (!node) {
            throw new Error('no such node');
        }
        const walletName: string = node.wallet;
        const identityName: string = node.identity;
        const fabricWalletGenerator: IFabricWalletGenerator = FabricWalletGeneratorFactory.createFabricWalletGenerator();
        const fabricWallet: IFabricWallet = await fabricWalletGenerator.createLocalWallet(walletName);
        await fabricWallet['setUserContext'](this.client, identityName);
    }

    private async createChannelMap(): Promise<void> {
        console.log('createChannelMap');

        const allPeerNames: string[] = this.getAllPeerNames();

        for (const peerName of allPeerNames) {
            const channelNames: string[] = await this.getAllChannelsForPeer(peerName);
            for (const channelName of channelNames) {
                if (!this.channels.has(channelName)) {
                    const channel: FabricChannel = new FabricChannel();
                    channel.name = channelName;
                    this.channels.set(channelName, channel);
                }
                const channel: FabricChannel = this.channels.get(channelName);
                channel.peers.set(peerName, this.peers.get(peerName));
            }
        }

        for (const [channelName, channel] of this.channels) {
            let actualChannel: Client.Channel = this.client.getChannel(channelName, false);
            if (!actualChannel) {
                actualChannel = this.client.newChannel(channelName);
            }
            for (const [peerName, peer] of channel.peers) {
                const eventHub: Client.ChannelEventHub = actualChannel.newChannelEventHub(peer);
                channel.eventHubs.set(peerName, eventHub);
            }
            // TODO: this is wrong and assumes we only have one orderer.
            for (const [ordererName, orderer] of this.orderers) {
                channel.ordererName = ordererName;
                channel.orderer = orderer;
            }
            channel.actualChannel = actualChannel;
        }
    }

}
