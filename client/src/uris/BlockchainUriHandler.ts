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

import { UriHandler, Uri } from 'vscode';
import { connectUriHandler } from './ConnectUriHandler';
import { VSCodeBlockchainOutputAdapter } from '../logging/VSCodeBlockchainOutputAdapter';
import { LogType } from '../logging/OutputAdapter';

export class BlockchainUriHandler implements UriHandler {

    public static instance(): BlockchainUriHandler {
        return BlockchainUriHandler._instance;
    }

    private static _instance: BlockchainUriHandler = new BlockchainUriHandler();

    public async handleUri(uri: Uri): Promise<void> {
        try {
            if (uri.path === '/connect') {
                await connectUriHandler(uri);
            } else {
                VSCodeBlockchainOutputAdapter.instance().log(LogType.ERROR, `Unrecognized path ${uri.path} for URI`);
            }
        } catch (error) {
            VSCodeBlockchainOutputAdapter.instance().log(LogType.ERROR, `Error handling path ${uri.path} for URI: ${error.message}`);
        }
    }

}
