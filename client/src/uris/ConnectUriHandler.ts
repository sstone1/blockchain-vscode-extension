import { Uri, commands } from 'vscode';
import * as fs from 'fs-extra';
import * as querystring from 'querystring';
import * as tmp from 'tmp';
import { FabricGatewayRegistryEntry } from '../fabric/FabricGatewayRegistryEntry';
import { IFabricWalletGenerator } from '../fabric/IFabricWalletGenerator';
import { FabricWalletGeneratorFactory } from '../fabric/FabricWalletGeneratorFactory';
import { IFabricWallet } from '../fabric/IFabricWallet';
import { FabricGatewayRegistry } from '../fabric/FabricGatewayRegistry';
import { ExtensionCommands } from '../../ExtensionCommands';

export async function connectUriHandler(uri: Uri): Promise<void> {
    const query: querystring.ParsedUrlQuery = querystring.parse(uri.query);
    const name: string = query.name as string;
    if (!name) {
        throw new Error(`No name specified in request (missing name parameter)`);
    }
    const ccpData: string = Buffer.from(query.ccp as string, 'base64').toString();
    if (!ccpData) {
        throw new Error(`No connection profile specified in request (missing ccp parameter)`);
    }
    const ccp: any = JSON.parse(ccpData);
    const mspID: string = query.mspID as string;
    if (!mspID) {
        throw new Error(`No user MSP ID specified in request (missing mspID parameter)`);
    }
    const identityName: string = query.identityName as string;
    if (!identityName) {
        throw new Error(`No user identity name specified in request (missing identityName parameter)`);
    }
    const certificate: string = Buffer.from(query.certificate as string, 'base64').toString();
    if (!certificate) {
        throw new Error(`No user certificate specified in request (missing certificate parameter)`);
    }
    const privateKey: string = Buffer.from(query.privateKey as string, 'base64').toString();
    if (!privateKey) {
        throw new Error(`No user private key specified in request (missing privateKey parameter)`);
    }
    const ccpFile: string = await new Promise((resolve: any, reject: any): void => {
        tmp.file({ postfix: '.json' }, (err: Error, path: string): void => {
            if (err) {
                return reject(err);
            }
            resolve(path);
        });
    });
    await fs.writeFile(ccpFile, ccpData);
    const fabricWalletGenerator: IFabricWalletGenerator = FabricWalletGeneratorFactory.createFabricWalletGenerator();
    const fabricWallet: IFabricWallet = await fabricWalletGenerator.createLocalWallet(name);
    await fabricWallet.importIdentity(ccp, certificate, privateKey, identityName, mspID);
    const fabricGatewayEntry: FabricGatewayRegistryEntry = new FabricGatewayRegistryEntry({
        connectionProfilePath: ccpFile,
        managedRuntime: false,
        name: name,
        walletPath: fabricWallet.getWalletPath()
    });
    if (FabricGatewayRegistry.instance().exists(name)) {
        await FabricGatewayRegistry.instance().delete(name);
    }
    await FabricGatewayRegistry.instance().add(fabricGatewayEntry);
    await commands.executeCommand(ExtensionCommands.CONNECT, fabricGatewayEntry, identityName);
}
