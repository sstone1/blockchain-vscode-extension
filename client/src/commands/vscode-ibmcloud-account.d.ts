/**
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as rp from 'request-promise-native';

/**
 * The URLs to various IBM Cloud APIs.
 */
export interface IBMCloudURLs {

    /**
     * The URL to the account management APIs.
     */
    accountManagement: string;

    /**
     * The URL to the core IBM Cloud APIs.
     */
    api: string;
    
    /**
     * The URL to the IAM APIs.
     */
    iam: string;
    
    /**
     * The URL to the resource controller APIs.
     */
    resourceController: string;

}

/**
 * The external interface exposed by the IBM Cloud Account extension
 * for use by other modules to interact with IBM Cloud APIs.
 */
export interface IBMCloudAccount {

    /**
     * Get an access token for use in requests to the IBM Cloud APIs.
     * @param requireAccount True if the access token must be linked
     * to an IBM Cloud account, false if not.
     * @returns The access token, otherwise null if the user has not
     * logged in or not selected an IBM Cloud account.
     */
    getAccessToken(requireAccount?: boolean): Promise<string | null>;

    /**
     * Get the UUID of the IBM Cloud account.
     * @returns The UUID of the IBM Cloud account, otherwise null if
     * the user has not logged in or not selected an IBM Cloud
     * account.
     */
    getAccount(): Promise<string | null>;

    /**
     * Get the email of the IBM Cloud account.
     * @returns The email of the IBM Cloud account, otherwise null if
     * the user has not logged in or not selected an IBM Cloud
     * account.
     */
    getEmail(): Promise<string | null>;

    /**
     * Get a wrapper around the request-promise API that can be used
     * to make requests to the IBM Cloud APIs.
     * @param requireAccount True if the access token must be linked
     * to an IBM Cloud account, false if not.
     * @returns The wrapper, otherwise null if the user has not
     * logged in or not selected an IBM Cloud account. The wrapper
     * can be used to make requests to the IBM Cloud APIs without
     * needing to specify the access token yourself.
     */
    getRequest(requireAccount?: boolean): Promise<rp.RequestPromiseAPI | null>;

    /**
     * Get the URLs to various core IBM Cloud APIs.
     * @returns The URLs.
     */
    getURLs(): Promise<IBMCloudURLs>;

    /**
     * Find out if the user has logged into the IBM Cloud.
     * @returns True if the user has logged into the IBM Cloud,
     * otherwise false.
     */
    isLoggedIn(): Promise<boolean>;

    /**
     * Find out if the user has logged into the IBM Cloud
     * and selected an IBM Cloud account.
     * @returns True if the user has logged into the IBM Cloud and
     * selected an IBM Cloud account, otherwise false.
     */
    hasSelectedAccount(): Promise<boolean>;

}