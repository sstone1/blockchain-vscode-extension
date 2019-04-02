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
import { FabricRuntime } from './FabricRuntime';
import { OutputAdapter, LogType } from '../logging/OutputAdapter';
import { IFabricRuntimeConnection } from './IFabricRuntimeConnection';
import { FabricBaseConnection } from './FabricBaseConnection';
import { PackageRegistryEntry } from '../packages/PackageRegistryEntry';
import { FabricNode, FabricNodeType } from './FabricNode';
import { IFabricWalletGenerator } from './IFabricWalletGenerator';
import { FabricWalletGeneratorFactory } from './FabricWalletGeneratorFactory';
import { IFabricWallet } from './IFabricWallet';
import * as Client from 'fabric-client';
import * as FabricCAServices from 'fabric-ca-client';
import * as fs from 'fs-extra';
import { FabricChannel } from './FabricChannel';

export class FabricRuntimeConnection extends FabricBaseConnection implements IFabricRuntimeConnection {

    private runtime: FabricRuntime;
    private nodes: Map<string, FabricNode> = new Map<string, FabricNode>();
    private client: Client;
    private peers: Map<string, Client.Peer> = new Map<string, Client.Peer>();
    private orderers: Map<string, Client.Orderer> = new Map<string, Client.Orderer>();
    private certificateAuthorities: Map<string, FabricCAServices> = new Map<string, FabricCAServices>();

    constructor(runtime: FabricRuntime, outputAdapter?: OutputAdapter) {
        super(outputAdapter);
        this.runtime = runtime;
    }

    public async connect(): Promise<void> {
        console.log('FabricRuntimeConnection: connect');
        const nodes: FabricNode[] = await this.runtime.getNodes();
        this.client = new Client();
        this.client.setCryptoSuite(Client.newCryptoSuite());
        for (const node of nodes) {
            if (node.type === FabricNodeType.PEER) {
                const peer: Client.Peer = this.client.newPeer(node.url);
                this.peers.set(node.name, peer);
            } else if (node.type === FabricNodeType.ORDERER) {
                const orderer: Client.Orderer = this.client.newOrderer(node.url);
                this.orderers.set(node.name, orderer);
            } else if (node.type === FabricNodeType.CERTIFICATE_AUTHORITY) {
                const certificateAuthority: FabricCAServices = new FabricCAServices(node.url, null, node.name, this.client.getCryptoSuite());
                this.certificateAuthorities.set(node.name, certificateAuthority);
            }
            this.nodes.set(node.name, node);
        }
    }

    public disconnect(): void {
        this.nodes.clear();
        this.peers.clear();
        this.orderers.clear();
        this.certificateAuthorities.clear();
    }

    public getAllPeerNames(): string[] {
        return Array.from(this.nodes.values()).filter((node: FabricNode) => node.type === FabricNodeType.PEER).map((node: FabricNode) => node.name);
    }

    public async getAllChannelNames(peerName?: string): Promise<Array<string>> {
        console.log('getAllChannelsForPeer', peerName);
        await this.setNodeContext(peerName);
        const peer: Client.Peer = this.getPeer(peerName);
        const channelResponse: Client.ChannelQueryResponse = await this.client.queryChannels(peer);

        const channelNames: Array<string> = [];
        console.log(channelResponse);
        channelResponse.channels.forEach((channel: Client.ChannelInfo) => {
            channelNames.push(channel.channel_id);
        });

        return channelNames.sort();
    }

    public async getAllOrganizationNames(): Promise<string[]> {
        throw new Error('Method not implemented.');
    }

    public getAllCertificateAuthorityNames(): string[] {
        return Array.from(this.nodes.values()).filter((node: FabricNode) => node.type === FabricNodeType.CERTIFICATE_AUTHORITY).map((node: FabricNode) => node.name);
    }

    public async getInstalledChaincode(peerName: string): Promise<Map<string, string[]>> {
        console.log('getInstalledChaincode', peerName);
        await this.setNodeContext(peerName);
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

    public async getInstantiatedChaincode(channelName: string): Promise<{ name: string; version: string; }[]> {
        console.log('getInstantiatedChaincode');
        const instantiatedChaincodes: Array<{ name: string; version: string; }> = [];
        const channel: FabricChannel = await this.getChannel(channelName);
        const [peerName, peer]: [string, Client.Peer] = Array.from(channel.peers)[0];
        await this.setNodeContext(peerName);
        const chainCodeResponse: Client.ChaincodeQueryResponse = await channel.actualChannel.queryInstantiatedChaincodes(peer);
        chainCodeResponse.chaincodes.forEach((chainCode: Client.ChaincodeInfo) => {
            instantiatedChaincodes.push({ name: chainCode.name, version: chainCode.version });
        });

        return instantiatedChaincodes;
    }

    public getAllOrdererNames(): string[] {
        return Array.from(this.nodes.values()).filter((node: FabricNode) => node.type === FabricNodeType.ORDERER).map((node: FabricNode) => node.name);
    }

    public async installChaincode(packageRegistryEntry: PackageRegistryEntry, peerName: string): Promise<void> {
        const peer: Client.Peer = this.getPeer(peerName);
        const pkgBuffer: Buffer = await fs.readFile(packageRegistryEntry.path);
        const installRequest: Client.ChaincodePackageInstallRequest = {
            targets: [peer],
            chaincodePackage: pkgBuffer,
            txId: this.client.newTransactionID()
        };
        await this.setNodeContext(peerName);
        const response: Client.ProposalResponseObject = await this.client.installChaincode(installRequest);
        const proposalResponse: Client.ProposalResponse | Error = response[0][0];
        if (proposalResponse instanceof Error) {
            throw proposalResponse;
        } else if (proposalResponse.response.status !== 200) {
            throw new Error(proposalResponse.response.message);
        }
    }

    public async instantiateChaincode(chaincodeName: string, version: string, channelName: string, fcn: string, args: string[]): Promise<void> {
        const instantiatedChaincode: Array<{ name: string; version: string; }> = await this.getInstantiatedChaincode(channelName);
        const foundChaincode: { name: string; version: string; } = this.getChaincode(chaincodeName, instantiatedChaincode);
        if (foundChaincode) {
            throw new Error('The name of the contract you tried to instantiate is already instantiated');
        }
        const message: string = `Instantiating with function: '${fcn}' and arguments: '${args}'`;
        this.outputAdapter.log(LogType.INFO, undefined, message);
        return this.instantiateUpgradeChaincode(chaincodeName, version, channelName, fcn, args, false);
    }

    public async upgradeChaincode(chaincodeName: string, version: string, channelName: string, fcn: string, args: string[]): Promise<void> {
        const instantiatedChaincode: Array<{ name: string; version: string; }> = await this.getInstantiatedChaincode(channelName);
        const foundChaincode: { name: string; version: string; } = this.getChaincode(chaincodeName, instantiatedChaincode);
        if (!foundChaincode) {
            throw new Error('The contract you tried to upgrade with has no previous versions instantiated');
        }
        const message: string = `Upgrading with function: '${fcn}' and arguments: '${args}'`;
        this.outputAdapter.log(LogType.INFO, undefined, message);
        return this.instantiateUpgradeChaincode(chaincodeName, version, channelName, fcn, args, true);
    }

    public async enroll(certificateAuthorityName: string, enrollmentID: string, enrollmentSecret: string): Promise<{ certificate: string; privateKey: string; }> {
        const certificateAuthority: FabricCAServices = this.getCertificateAuthority(certificateAuthorityName);
        const enrollment: FabricCAServices.IEnrollResponse = await certificateAuthority.enroll({ enrollmentID, enrollmentSecret });
        return { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() };
    }

    public async register(certificateAuthorityName: string, enrollmentID: string, affiliation: string): Promise<string> {
        const certificateAuthority: FabricCAServices = this.getCertificateAuthority(certificateAuthorityName);
        const request: FabricCAServices.IRegisterRequest = {
            enrollmentID: enrollmentID,
            affiliation: affiliation,
            role: 'client'
        };
        await this.setNodeContext(certificateAuthorityName);
        const registrar: Client.User = await this.client.getUserContext('', false);
        const secret: string = await certificateAuthority.register(request, registrar);
        return secret;
    }

    public getNode(nodeName: string): FabricNode {
        if (!this.nodes.has(nodeName)) {
            throw new Error(`The Fabric node ${nodeName} does not exist`);
        }
        return this.nodes.get(nodeName);
    }

    public async getWallet(nodeName: string): Promise<IFabricWallet> {
        const node: FabricNode = this.getNode(nodeName);
        const walletName: string = node.wallet;
        const fabricWalletGenerator: IFabricWalletGenerator = FabricWalletGeneratorFactory.createFabricWalletGenerator();
        return await fabricWalletGenerator.createLocalWallet(walletName);
    }

    private async setNodeContext(nodeName: string): Promise<void> {
        const node: FabricNode = this.nodes.get(nodeName);
        if (!node) {
            throw new Error(`The Fabric node ${nodeName} does not exist`);
        }
        const walletName: string = node.wallet;
        const identityName: string = node.identity;
        const fabricWalletGenerator: IFabricWalletGenerator = FabricWalletGeneratorFactory.createFabricWalletGenerator();
        const fabricWallet: IFabricWallet = await fabricWalletGenerator.createLocalWallet(walletName);
        await fabricWallet['setUserContext'](this.client, identityName);
    }

    private getPeer(peerName: string): Client.Peer {
        if (!this.peers.has(peerName)) {
            throw new Error(`The Fabric peer ${peerName} does not exist`);
        }
        return this.peers.get(peerName);
    }

    private getCertificateAuthority(certificateAuthorityName: string): FabricCAServices {
        if (!this.certificateAuthorities.has(certificateAuthorityName)) {
            throw new Error(`The Fabric certificate authority ${certificateAuthorityName} does not exist`);
        }
        return this.certificateAuthorities.get(certificateAuthorityName);
    }

    private async getAllChannels(): Promise<Map<string, FabricChannel>> {
        console.log('getChannels');

        const channels: Map<string, FabricChannel> = new Map<string, FabricChannel>();

        for (const [peerName, peer] of this.peers) {
            const channelNames: string[] = await this.getAllChannelNames(peerName);
            for (const channelName of channelNames) {
                if (!channels.has(channelName)) {
                    const channel: FabricChannel = new FabricChannel();
                    channel.name = channelName;
                    channels.set(channelName, channel);
                    channel.peers.set(peerName, peer);
                } else {
                    const channel: FabricChannel = channels.get(channelName);
                    channel.peers.set(peerName, peer);
                }
            }
        }

        for (const [channelName, channel] of channels) {
            let actualChannel: Client.Channel = this.client.getChannel(channelName, false);
            if (!actualChannel) {
                actualChannel = this.client.newChannel(channelName);
            }
            for (const [peerName, peer] of channel.peers) {
                const eventHub: Client.ChannelEventHub = actualChannel.newChannelEventHub(peer);
                channel.eventHubs.set(peerName, eventHub);
            }
            // TODO: this is wrong and assumes we only have one orderer.
            const [ordererName, orderer]: [string, Client.Orderer] = Array.from(this.orderers)[0];
            channel.ordererName = ordererName;
            channel.orderer = orderer;
            channel.actualChannel = actualChannel;
        }

        return channels;
    }

    private async getChannel(channelName: string): Promise<FabricChannel> {
        const channels: Map<string, FabricChannel> = await this.getAllChannels();
        if (!channels.has(channelName)) {
            throw new Error(`The Fabric channel ${channelName} does not exist`);
        }
        return channels.get(channelName);
    }

    private async instantiateUpgradeChaincode(name: string, version: string, channelName: string, fcn: string, args: Array<string>, upgrade: boolean): Promise<any> {
        const channel: FabricChannel = await this.getChannel(channelName);
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
        await this.setNodeContext(peerName);
        if (!upgrade) {
            [proposalResponses, proposal] = await actualChannel.sendInstantiateProposal(instantiateRequest);
        } else {
            [proposalResponses, proposal] = await actualChannel.sendUpgradeProposal(instantiateRequest);
        }

        const goodProposalResponses: Client.ProposalResponse[] = [];
        for (const proposalResponse of proposalResponses) {
            if (proposalResponse instanceof Error) {
                throw proposalResponse;
            } else if (proposalResponse.response.status !== 200) {
                throw new Error(proposalResponse.response.message);
            } else {
                goodProposalResponses.push(proposalResponse);
            }
        }

        const eventHubPromise: Promise<void> = new Promise((resolve: any, reject: any): void => {
            eventHub.registerTxEvent(
                transactionId.getTransactionID(),
                (txId: string, code: string, blockNumber: number) => {
                    if (code !== 'VALID') {
                        return reject(new Error(`Transaction ${txId} failed validation: code = ${code}, block number = ${blockNumber}`));
                    }
                    resolve();
                },
                (err: any) => reject(err),
                { disconnect: true, unregister: true }
            );
            eventHub.connect();
        });
        await this.setNodeContext(peerName);
        const broadcastResponse: Client.BroadcastResponse = await actualChannel.sendTransaction({ proposalResponses: goodProposalResponses, proposal, orderer });
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

    private getChaincode(name: string, chaincodeArray: Array<{ name: string; version: string; }>): any {
        return chaincodeArray.find((chaincode: { name: string; version: string; }) => {
            return chaincode.name === name;
        });
    }

}
