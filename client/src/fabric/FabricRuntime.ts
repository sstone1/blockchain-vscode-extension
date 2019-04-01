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

import * as path from 'path';
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import { FabricRuntimePorts } from './FabricRuntimePorts';
import { OutputAdapter } from '../logging/OutputAdapter';
import { ConsoleOutputAdapter } from '../logging/ConsoleOutputAdapter';
import { CommandUtil } from '../util/CommandUtil';
import { EventEmitter } from 'events';
import { Docker, ContainerPorts } from '../docker/Docker';
import { UserInputUtil } from '../commands/UserInputUtil';
import { LogType } from '../logging/OutputAdapter';
import * as request from 'request';

export enum FabricRuntimeState {
    STARTING = 'starting',
    STARTED = 'started',
    STOPPING = 'stopping',
    STOPPED = 'stopped',
    RESTARTING = 'restarting',
}

export class FabricGateway {
    public name: string;
    public path: string;
    public connectionProfile: object;
}

export class FabricIdentity {
    public name: string;
    public certificate: string;
    public private_key: string;
    public msp_id: string;
}

export enum FabricNodeType {
    PEER = 'fabric-peer',
    CA = 'fabric-ca',
    ORDERER = 'fabric-orderer'
}

export class FabricNode {
    public short_name: string;
    public name: string;
    public url: string;
    public type: FabricNodeType;
    public wallet: string;
    public identity: string;
}

export class FabricRuntime extends EventEmitter {

    public developmentMode: boolean;
    public ports?: FabricRuntimePorts;

    private docker: Docker;
    private name: string;
    private path: string;
    private busy: boolean = false;
    private state: FabricRuntimeState;

    private logsRequest: request.Request;

    constructor() {
        super();
        this.name = 'local_fabric';
        this.docker = new Docker(this.name);
        const extDir: string = vscode.workspace.getConfiguration().get('blockchain.ext.directory');
        const homeExtDir: string = UserInputUtil.getDirPath(extDir);
        this.path = path.resolve(homeExtDir, this.name);
    }

    public getName(): string {
        return this.name;
    }

    public getPath(): string {
        return this.path;
    }

    public isBusy(): boolean {
        return this.busy;
    }

    public getState(): FabricRuntimeState {
        return this.state;
    }

    public async start(outputAdapter?: OutputAdapter): Promise<void> {
        try {
            this.setBusy(true);
            this.setState(FabricRuntimeState.STARTING);
            await this.startInner(outputAdapter);
        } finally {
            this.setBusy(false);
            const running: boolean = await this.isRunning();
            if (running) {
                this.setState(FabricRuntimeState.STARTED);
            } else {
                this.setState(FabricRuntimeState.STOPPED);
            }
        }
    }

    public async stop(outputAdapter?: OutputAdapter): Promise<void> {
        try {
            this.setBusy(true);
            this.setState(FabricRuntimeState.STOPPING);
            await this.stopInner(outputAdapter);
        } finally {
            this.setBusy(false);
            const running: boolean = await this.isRunning();
            if (running) {
                this.setState(FabricRuntimeState.STARTED);
            } else {
                this.setState(FabricRuntimeState.STOPPED);
            }
        }
    }

    public async teardown(outputAdapter?: OutputAdapter): Promise<void> {
        try {
            this.setBusy(true);
            this.setState(FabricRuntimeState.STOPPING);
            await this.teardownInner(outputAdapter);
        } finally {
            this.setBusy(false);
            const running: boolean = await this.isRunning();
            if (running) {
                this.setState(FabricRuntimeState.STARTED);
            } else {
                this.setState(FabricRuntimeState.STOPPED);
            }
        }
    }

    public async restart(outputAdapter?: OutputAdapter): Promise<void> {
        try {
            this.setBusy(true);
            this.setState(FabricRuntimeState.RESTARTING);
            this.stopLogs();
            await this.stopInner(outputAdapter);
            await this.startInner(outputAdapter);
        } finally {
            this.setBusy(false);
            const running: boolean = await this.isRunning();
            if (running) {
                this.setState(FabricRuntimeState.STARTED);
            } else {
                this.setState(FabricRuntimeState.STOPPED);
            }
        }
    }

    public async getGateways(): Promise<FabricGateway[]> {
        const gatewaysPath: string = path.resolve(this.path, 'gateways');
        const gatewaysExist: boolean = await fs.pathExists(gatewaysPath);
        if (!gatewaysExist) {
            return [];
        }
        let gatewayPaths: string[] = await fs.readdir(gatewaysPath);
        gatewayPaths = gatewayPaths
            .filter((gatewayPath: string) => !gatewayPath.startsWith('.'))
            .map((gatewayPath: string) => path.resolve(this.path, 'gateways', gatewayPath));
        const gateways: FabricGateway[] = [];
        for (const gatewayPath of gatewayPaths) {
            const connectionProfile: any = await fs.readJson(gatewayPath);
            const gateway: FabricGateway = new FabricGateway();
            gateway.name = connectionProfile.name;
            gateway.path = gatewayPath;
            gateway.connectionProfile = connectionProfile;
            gateways.push(gateway);
        }
        return gateways;
    }

    public async getNodes(): Promise<FabricNode[]> {
        const nodesPath: string = path.resolve(this.path, 'nodes');
        const nodesExist: boolean = await fs.pathExists(nodesPath);
        if (!nodesExist) {
            return [];
        }
        let nodePaths: string[] = await fs.readdir(nodesPath);
        nodePaths = nodePaths
            .filter((nodePath: string) => !nodePath.startsWith('.'))
            .map((nodePath: string) => path.resolve(this.path, 'nodes', nodePath));
        const nodes: FabricNode[] = [];
        for (const nodePath of nodePaths) {
            const node: FabricNode = await fs.readJson(nodePath);
            nodes.push(node);
        }
        return nodes;
    }

    public async getWallets(): Promise<string[]> {
        const walletsPath: string = path.resolve(this.path, 'wallets');
        const walletsExist: boolean = await fs.pathExists(walletsPath);
        if (!walletsExist) {
            return [];
        }
        const walletPaths: string[] = await fs.readdir(walletsPath);
        return walletPaths
            .filter((walletPath: string) => !walletPath.startsWith('.'));
    }

    public async getIdentities(wallet: string): Promise<FabricIdentity[]> {
        const walletPath: string = path.resolve(this.path, 'wallets', wallet);
        const walletExists: boolean = await fs.pathExists(walletPath);
        if (!walletExists) {
            return [];
        }
        let identityPaths: string[] = await fs.readdir(walletPath);
        identityPaths = identityPaths
            .filter((identityPath: string) => !identityPath.startsWith('.'))
            .map((identityPath: string) => path.resolve(this.path, 'wallets', wallet, identityPath));
        const identities: FabricIdentity[] = [];
        for (const identityPath of identityPaths) {
            const identity: FabricIdentity = await fs.readJson(identityPath);
            identities.push(identity);
        }
        return identities;
    }

    public async getConnectionProfile(): Promise<object> {
        throw new Error('not supported');
    }

    public getConnectionProfilePath(): string {
        throw new Error('not supported');
    }

    public async getCertificate(): Promise<string> {
        throw new Error('not supported');
    }

    public getCertificatePath(): string {
        throw new Error('not supported');
    }

    public async getPrivateKey(): Promise<string> {
        throw new Error('not supported');
    }

    public async isCreated(outputAdapter?: OutputAdapter): Promise<boolean> {
        try {
            await this.execute('is_created', outputAdapter);
            return true;
        } catch (error) {
            return false;
        }
    }

    public async isRunning(outputAdapter?: OutputAdapter): Promise<boolean> {
        try {
            await this.execute('is_running', outputAdapter);
            return true;
        } catch (error) {
            return false;
        }
    }

    public isDevelopmentMode(): boolean {
        return this.developmentMode;
    }

    public async setDevelopmentMode(developmentMode: boolean): Promise<void> {
        this.developmentMode = developmentMode;
        await this.updateUserSettings();
    }

    public async getChaincodeAddress(): Promise<string> {
        const prefix: string = this.docker.getContainerPrefix();
        const peerPorts: ContainerPorts = await this.docker.getContainerPorts(`${prefix}_peer0.org1.example.com`);
        const peerRequestHost: string = Docker.fixHost(peerPorts['7052/tcp'][0].HostIp);
        const peerRequestPort: string = peerPorts['7052/tcp'][0].HostPort;
        return `${peerRequestHost}:${peerRequestPort}`;
    }

    public async getLogsAddress(): Promise<string> {
        const prefix: string = this.docker.getContainerPrefix();
        const logsPorts: ContainerPorts = await this.docker.getContainerPorts(`${prefix}_logspout`);
        const peerRequestHost: string = Docker.fixHost(logsPorts['80/tcp'][0].HostIp);
        const peerRequestPort: string = logsPorts['80/tcp'][0].HostPort;
        return `${peerRequestHost}:${peerRequestPort}`;
    }

    public getPeerContainerName(): string {
        const prefix: string = this.docker.getContainerPrefix();
        return `${prefix}_peer0.org1.example.com`;
    }

    public async exportConnectionProfile(outputAdapter: OutputAdapter, dir?: string): Promise<void> {

        if (!outputAdapter) {
            outputAdapter = ConsoleOutputAdapter.instance();
        }

        const connectionProfileObj: any = await this.getConnectionProfile();
        const connectionProfile: string = JSON.stringify(connectionProfileObj, null, 4);

        const extDir: string = vscode.workspace.getConfiguration().get('blockchain.ext.directory');
        const homeExtDir: string = UserInputUtil.getDirPath(extDir);

        if (!dir) {
            dir = path.join(homeExtDir, this.name);
        } else {
            dir = path.join(dir, this.name);
        }

        const connectionProfilePath: string = path.join(dir, 'connection.json');

        try {
            await fs.ensureFileSync(connectionProfilePath);
            await fs.writeFileSync(connectionProfilePath, connectionProfile);
        } catch (error) {
            outputAdapter.log(LogType.ERROR, `Issue saving runtime connection profile in directory ${dir} with error: ${error.message}`);
            throw new Error(error);
        }
    }

    public async deleteConnectionDetails(outputAdapter: OutputAdapter): Promise<void> {

        const extDir: string = vscode.workspace.getConfiguration().get('blockchain.ext.directory');
        const homeExtDir: string = UserInputUtil.getDirPath(extDir);
        const runtimePath: string = path.join(homeExtDir, this.name);
        // TODO: hardcoded name
        const walletPath: string = path.join(homeExtDir, 'local_wallet');
        // Need to remove the secret wallet as well
        const secretRuntimePath: string = path.join(homeExtDir, 'local_wallet' + '-ops');

        try {
            await fs.remove(runtimePath);
            await fs.remove(walletPath);
            await fs.remove(secretRuntimePath);
        } catch (error) {
            if (!error.message.includes('ENOENT: no such file or directory')) {
                outputAdapter.log(LogType.ERROR, `Error removing runtime connection details: ${error.message}`, `Error removing runtime connection details: ${error.toString()}`);
                return;
            }
        }
    }

    public async startLogs(outputAdapter: OutputAdapter): Promise<void> {
        const logsAddress: string = await this.getLogsAddress();
        this.logsRequest = CommandUtil.sendRequestWithOutput(`http://${logsAddress}/logs`, outputAdapter);
    }

    public stopLogs(): void {
        if (this.logsRequest) {
            CommandUtil.abortRequest(this.logsRequest);
        }
    }

    public setState(state: FabricRuntimeState): void {
        this.state = state;

    }

    public async updateUserSettings(): Promise<void> {
        const runtimeObject: any = {
            ports: this.ports,
            developmentMode: this.isDevelopmentMode(),
        };
        await vscode.workspace.getConfiguration().update('fabric.runtime', runtimeObject, vscode.ConfigurationTarget.Global);
    }

    private setBusy(busy: boolean): void {
        this.busy = busy;
        this.emit('busy', busy);
    }

    private async startInner(outputAdapter?: OutputAdapter): Promise<void> {
        await this.execute('start', outputAdapter);
        await this.exportConnectionProfile(outputAdapter);
    }

    private async stopInner(outputAdapter?: OutputAdapter): Promise<void> {
        this.stopLogs();
        await this.execute('stop', outputAdapter);
    }

    private async teardownInner(outputAdapter?: OutputAdapter): Promise<void> {
        this.stopLogs();
        await this.execute('teardown', outputAdapter);
        await this.deleteConnectionDetails(outputAdapter);
    }

    private async execute(script: string, outputAdapter?: OutputAdapter): Promise<void> {
        if (!outputAdapter) {
            outputAdapter = ConsoleOutputAdapter.instance();
        }

        const env: any = Object.assign({}, process.env, {
            CORE_CHAINCODE_MODE: this.developmentMode ? 'dev' : 'net'
        });

        if (process.platform === 'win32') {
            await CommandUtil.sendCommandWithOutput('cmd', ['/c', `${script}.cmd`], this.path, env, outputAdapter);
        } else {
            await CommandUtil.sendCommandWithOutput('/bin/sh', [`${script}.sh`], this.path, env, outputAdapter);
        }
    }
}
