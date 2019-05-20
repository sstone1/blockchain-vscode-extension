// tslint:disable

import { IBMCloudAccount, IBMCloudURLs } from './vscode-ibmcloud-account';
import * as rp from 'request-promise-native';
import { URL } from 'url';
import * as vscode from 'vscode';
import { FabricGatewayRegistryEntry } from '../fabric/FabricGatewayRegistryEntry';
import { FabricGatewayHelper } from '../fabric/FabricGatewayHelper';
import { FabricGatewayRegistry } from '../fabric/FabricGatewayRegistry';
import { FabricWalletGeneratorFactory } from '../fabric/FabricWalletGeneratorFactory';
import { FabricWalletRegistry } from '../fabric/FabricWalletRegistry';
import { FabricWalletRegistryEntry } from '../fabric/FabricWalletRegistryEntry';
import { IFabricCertificateAuthority } from '../fabric/IFabricCertificateAuthority';
import { FabricCertificateAuthorityFactory } from '../fabric/FabricCertificateAuthorityFactory';
import { ExtensionCommands } from '../../ExtensionCommands';

export async function connectToCloud(): Promise<void> {

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'IBM Blockchain Platform Extension',
        cancellable: false
    }, async (progress: vscode.Progress<{ message: string }>) => {

        progress.report({ message: 'Connecting To Cloud' });

        const cloudAccount: IBMCloudAccount = vscode.extensions.getExtension<IBMCloudAccount>('ibm.ibm-cloud-account')!.exports;
        const urls: IBMCloudURLs = await cloudAccount.getURLs();
        const rp: rp.RequestPromiseAPI = await cloudAccount.getRequest();
        if (!rp) {
            return;
        }
        const response: any = await rp.get(`${urls.resourceController}/v2/resource_instances`, {
            json: true
        });
        const ibp_resources: any[] = response.resources.filter((resource: any) => resource.resource_plan_id === 'e2074ca7-76d8-4e77-a625-0df8a4caff47');
        interface IBMBlockchainPlatformQuickPickItem extends vscode.QuickPickItem {
            resource: any;
        }
        const items = ibp_resources.map((ibp_resource) => {
            return {
                label: ibp_resource.name,
                description: ibp_resource.guid,
                resource: ibp_resource
            };
        });
        const item = await vscode.window.showQuickPick<IBMBlockchainPlatformQuickPickItem>(items);

        if (!item) {
            return;
        }

        const dashboard_url = new URL(item.resource.dashboard_url);
        dashboard_url.pathname = '';
        const account = await cloudAccount.getAccount();
        const choose = await rp.post(`${dashboard_url.toString()}api/choose`, {
            json: {
                account,
                si_id: item.resource.guid
            }
        });

        const ops_tools_url = choose.endpoint;

        const components = await rp.get(`${ops_tools_url}/ak/api/v1/components`, {
            json: true,
            strictSSL: false
        });

        const peers = components.filter((component) => {
            return component.node_type === 'fabric-peer';
        });
        const items2: vscode.QuickPickItem[] = peers.map((peer) => { return { label: peer.name, value: peer }; });

        const peer: any = await vscode.window.showQuickPick<vscode.QuickPickItem>(items2, { canPickMany: false, placeHolder: 'Select the gateway peer to connect to' });
        if (!peer) {
            return;
        }

        const cas = components.filter((component) => {
            return component.node_type === 'fabric-ca';
        });
        const items3: vscode.QuickPickItem[] = cas.map((ca) => { return { label: ca.name, value: ca }; });

        const ca: any = await vscode.window.showQuickPick<vscode.QuickPickItem>(items3, { canPickMany: false, placeHolder: 'Select the certificate authority to connect to' });
        if (!ca) {
            return;
        }

        const peerName = new URL(peer.value.api_url).host;
        const caName = new URL(peer.value.api_url).host;

        const ccp = {
            name: peer.value.name,
            version: '1.0.0',
            client: {
                organization: peer.value.msp_id,
                connection: {
                    timeout: {
                        peer: {
                            endorser: 300
                        },
                        orderer: 300
                    }
                }
            },
            organizations: {
                [peer.value.msp_id]: {
                    mspid: peer.value.msp_id,
                    peers: [
                        peerName
                    ],
                    certificateAuthorities: [
                        caName
                    ]
                }
            },
            peers: {
                [peerName]: {
                    url: peer.value.api_url,
                    tlsCACerts: {
                        pem: Buffer.from(peer.value.pem, 'base64').toString()
                    }
                }
            },
            certificateAuthorities: {
                [caName]: {
                    url: ca.value.api_url,
                    tlsCACerts: {
                        pem: Buffer.from(ca.value.pem, 'base64').toString()
                    }
                }
            }
        }

        const walletName = `${peer.value.name} wallet`;

        const fabricGatewayEntry: FabricGatewayRegistryEntry = new FabricGatewayRegistryEntry();
        // Copy the user given connection profile to the gateway directory (in the blockchain extension directory)
        fabricGatewayEntry.name = peer.value.name;
        fabricGatewayEntry.connectionProfilePath = await FabricGatewayHelper.importConnectionProfile(peer.value.name, 'connection.json', ccp);
        fabricGatewayEntry.associatedWallet = walletName;
        const fabricGatewayRegistry: FabricGatewayRegistry = FabricGatewayRegistry.instance();
        await fabricGatewayRegistry.add(fabricGatewayEntry);

        const wallet = await FabricWalletGeneratorFactory.createFabricWalletGenerator().createLocalWallet(walletName);
        const walletPath = wallet.getWalletPath();

        const fabricWalletRegistry: FabricWalletRegistry = FabricWalletRegistry.instance();
        const fabricWalletRegistryEntry: FabricWalletRegistryEntry = new FabricWalletRegistryEntry();
        fabricWalletRegistryEntry.name = walletName;
        fabricWalletRegistryEntry.walletPath = walletPath;
        await fabricWalletRegistry.add(fabricWalletRegistryEntry);

        const certificateAuthority: IFabricCertificateAuthority = FabricCertificateAuthorityFactory.createCertificateAuthority();
        const enrollment: {certificate: string, privateKey: string} = await certificateAuthority.enroll(fabricGatewayEntry.connectionProfilePath, ca.value.enroll_id, ca.value.enroll_secret);
        await wallet.importIdentity(enrollment.certificate, enrollment.privateKey, ca.value.enroll_id, peer.value.msp_id);

        await vscode.commands.executeCommand(ExtensionCommands.REFRESH_GATEWAYS);
        await vscode.commands.executeCommand(ExtensionCommands.REFRESH_WALLETS);

    });
    
}
